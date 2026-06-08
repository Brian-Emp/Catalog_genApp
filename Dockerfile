# syntax=docker/dockerfile:1.7
#
# Image catalog-gen-app — build multi-stage.
#
#   docker compose up --build            → image LEAN (WITH_AI=0, defaut)
#   WITH_AI=1 docker compose build       → image COMPLETE (Claude + Gemini + poppler)
#
# Lean : node runtime + deps de PROD + binaire C++ catgen-pdf + libpdfium + dist
# TS + assets front. Le pipeline deterministe (/api/generate) tourne sans aucun
# credential. Les enrichissements IA (descriptions, audits visuels, smart-mapping)
# se reactivent avec WITH_AI=1 + credentials montes (cf docker-compose.override).

ARG NODE_IMAGE=node:22-bookworm-slim

# ─── Stage 1 : dependances de PRODUCTION (sans devDeps) ─────────────────────
# npm ci (lockfile-exact, reproductible) en omettant les devDependencies :
# l'image finale n'embarque PAS typescript/vitest/ts-node-dev/coverage.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
# Playwright n'est utile qu'au mode experimental /api/layout : on n'embarque pas
# le navigateur Chromium (~150 Mo) dans l'image. Le module npm reste installe ;
# /api/layout echoue alors proprement (ok:false) faute de Chromium.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ─── Stage 2 : build TypeScript ─────────────────────────────────────────────
# Necessite les devDeps (typescript). Produit dist/ (JS pur).
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Stage 3 : build du binaire C++ catgen-pdf ──────────────────────────────
# Telecharge PDFium prebuilt (BSD, bblanchon) puis compile catgen-pdf qui linke
# contre libpdfium.so. SOURCE_DATE_EPOCH=0 + ffile-prefix-map (CMakeLists)
# garantissent un binaire reproductible bit-exact.
#
# PAS de --platform=$BUILDPLATFORM ici : on laisse BuildKit executer ce stage
# sur la plateforme CIBLE (native en build mono-arch ; sous QEMU en buildx
# multi-arch). Sinon le compilateur natif produirait un binaire de l'arch HOTE
# linke contre un PDFium de l'arch cible → incoherence en cross-compilation.
FROM debian:bookworm-slim AS pdf-engine
ARG TARGETARCH
WORKDIR /build
ENV PDFIUM_VERSION=7825
ENV SOURCE_DATE_EPOCH=0
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      curl \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Mapping TARGETARCH (BuildKit) -> nom d'archive bblanchon : amd64 -> x64,
# arm64 -> arm64. Le tag GitHub est "chromium/<version>" (%2F = / encode).
# Supply-chain : le tarball est verifie par sha256 (en plus de TLS + version
# pin). Pour bumper PDFIUM_VERSION, recalculer les 2 sommes :
#   curl -fsSL <url> | sha256sum
RUN case "${TARGETARCH}" in \
      amd64) PDFIUM_ARCH=x64;   PDFIUM_SHA256=ae0e276bcdf276dca2746adb4780f79949620e5c655973ca252a3994bc516a13 ;; \
      arm64) PDFIUM_ARCH=arm64; PDFIUM_SHA256=b063f5244586f5e0c025cd4d74dd10f75bbb41e28bcdc1032349ca27814a06cf ;; \
      *) echo "Architecture non supportee: ${TARGETARCH}"; exit 1 ;; \
    esac \
 && mkdir -p /opt/pdfium \
 && curl -fsSL -o /tmp/pdfium.tgz "https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F${PDFIUM_VERSION}/pdfium-linux-${PDFIUM_ARCH}.tgz" \
 && echo "${PDFIUM_SHA256}  /tmp/pdfium.tgz" | sha256sum -c - \
 && tar xz -C /opt/pdfium -f /tmp/pdfium.tgz \
 && rm -f /tmp/pdfium.tgz

COPY pdf-engine/ ./

RUN cmake -B build -S . -DPDFIUM_DIR=/opt/pdfium \
 && cmake --build build --parallel \
 && strip build/catgen-pdf

# ─── Stage DEV : hot-reload (cible de docker-compose.dev.yml) ───────────────
# Deps COMPLETES (ts-node-dev) + binaire C++. Lance le serveur en watch mode ;
# src/ est monte en volume au runtime → modifs live SANS rebuild. Ce stage est
# SKIPPE par le build par defaut (la cible par defaut reste `runner`, plus bas).
FROM ${NODE_IMAGE} AS dev
WORKDIR /app
ENV NODE_ENV=development
ENV PORT=8080
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
# Binaire C++ + PDFium deja compiles (stage pdf-engine).
COPY --from=pdf-engine /build/build/catgen-pdf /usr/local/bin/catgen-pdf
COPY --from=pdf-engine /opt/pdfium/lib/libpdfium.so /usr/local/lib/libpdfium.so
RUN ldconfig
# Fallback si lance sans volume ; en dev compose src/ est monte par-dessus.
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY .claude/skills ./.claude/skills
RUN mkdir -p uploads generated runs templates
EXPOSE 8080
CMD ["npm", "run", "dev"]

# ─── Stage 4 : runner final (image distribuee) ──────────────────────────────
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Deps de prod (sans devDeps) + build TS + assets + Skill bundle.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json ./
COPY .claude/skills ./.claude/skills

# Binaire C++ + lib PDFium (BSD). ldconfig pour que le loader trouve libpdfium.
COPY --from=pdf-engine /build/build/catgen-pdf /usr/local/bin/catgen-pdf
COPY --from=pdf-engine /opt/pdfium/lib/libpdfium.so /usr/local/lib/libpdfium.so
RUN ldconfig

# ─── Option IA (WITH_AI=1) : Claude CLI + Gemini CLI + poppler ──────────────
# Desactive par defaut → image lean, build sans dependance reseau fragile.
# Active, on ajoute :
#   - poppler-utils : pdftoppm pour rasteriser les pages (audits visuels)
#   - Claude Code CLI (officiel Anthropic), version PINNEE (reproductibilite)
#   - Gemini CLI (officiel Google), version PINNEE
# Securite : install.sh recupere en TLS strict (--proto =https --tlsv1.2) ; la
# chaine de cert garantit l'origine claude.ai. Bump les ARG apres test local.
# Residu supply-chain ASSUME (opt-in WITH_AI=1 uniquement, l'image lean
# distribuee n'est PAS concernee) : l'installeur officiel claude.ai et le
# paquet npm gemini-cli ne sont pas verifies par checksum (installeur mouvant
# a chaque release). Confiance = TLS + origine + version pinnee.
ARG WITH_AI=0
ARG CLAUDE_VERSION=2.1.128
ARG GEMINI_CLI_VERSION=0.44.1
RUN if [ "$WITH_AI" = "1" ]; then \
      set -eux; \
      apt-get update; \
      apt-get install -y --no-install-recommends curl ca-certificates poppler-utils; \
      rm -rf /var/lib/apt/lists/*; \
      mkdir -p /opt/claude-install; \
      curl --proto '=https' --tlsv1.2 -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh; \
      HOME=/opt/claude-install bash /tmp/claude-install.sh ${CLAUDE_VERSION}; \
      rm -f /tmp/claude-install.sh; \
      ln -sf /opt/claude-install/.local/bin/claude /usr/local/bin/claude; \
      /opt/claude-install/.local/bin/claude --version; \
      npm install -g @google/gemini-cli@${GEMINI_CLI_VERSION}; \
      gemini --version; \
    else \
      echo "WITH_AI=0 : image lean (features IA desactivees, pipeline deterministe complet)"; \
    fi

# Utilisateur non-root + dossiers runtime (proprietaire app → compatibles avec
# les volumes nommes qui heritent de ce uid/gid a la creation).
RUN groupadd -r app && useradd -r -g app -m app \
 && mkdir -p uploads generated runs \
 && chown -R app:app /app /home/app

# Entrypoint : smoke du binaire C++ + statut IA avant de lancer le serveur.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER app
EXPOSE 8080

# Healthcheck integre a l'image (fonctionne aussi en `docker run` nu ; le
# docker-compose s'appuie dessus). Node 22 expose fetch() globalement.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/server.js"]

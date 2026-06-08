# catalog-gen-app

[![CI](https://github.com/Brian-Emp/Catalog_genApp/actions/workflows/ci.yml/badge.svg)](https://github.com/Brian-Emp/Catalog_genApp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Takes a **reference catalog PDF** + **product data** (CSV/XLSX) + **product images**, and regenerates a new PDF with the products substituted in — keeping the original layout, sections, table of contents and page numbering intact.

The core pipeline is **fully deterministic** (no AI required). AI enrichments are **optional** and degrade gracefully when no credentials are present.

## Stack

- **Server** — Node 22 + Express + TypeScript
- **PDF engine** — `catgen-pdf`, a C++ binary built on PDFium (BSD) for extraction and rendering
- **AI (optional)** — Gemini REST API (quality-first model cascade) with a Claude CLI fallback
- **Frontend** — vanilla HTML/CSS/JS
- **Runtime** — Docker, served on `localhost:8080`

## Pipeline

```
upload (template PDF + data + images)
  → extract            C++ : PDF → per-page JSON descriptors
  → classify           page kinds (cover / identity / TOC / product / glossary …)
  → allocate           map products to template product slots
  → substitute         build the render plan (text/image operations)
  → [AI enrichments]    optional — see below
  → renumber + TOC     deterministic page numbering + table of contents rebuild
  → render             C++ : plan → final PDF
  → download           signed HMAC URL
```

### Optional AI enrichments

Enabled only when credentials are available; each one is skipped cleanly otherwise:

- **Marketing descriptions** — one factual chapeau sentence per section
- **Coherence & visual audit** — cross-page review (typos, alignment, overflow, pagination)
- **Smart column mapping** — resolves messy data headers the heuristic misses
- **Spec normalization** — aligns product spec keys to the template's labels
- **Image matching** — pairs unmatched products with the right asset

AI calls go through a unified router: a **quality-first Gemini model cascade**
(`3.5-flash → 2.5-flash → 3.1-flash-lite → 2.5-flash-lite → gemma`) backed by a
per-model rate limiter, a circuit breaker and a short fail-fast budget, with the
**Claude CLI** as a last-resort fallback. Each model has an independent free-tier
quota pool, so the cascade relays on quota/overload errors instead of failing.

## Quick start

The image is **built from source** on every `--build`: work in progress is picked
up on the next build, nothing is frozen.

### 1. Lean — deterministic, zero credentials

```bash
docker compose up --build
open http://localhost:8080
```

Full deterministic pipeline (substitution, renumbering, TOC, technical sheets).
AI enrichments are disabled — no key required.

### 2. With AI — optional

```bash
WITH_AI=1 docker compose build              # bundles Claude CLI + Gemini + poppler
claude login                                # host OAuth (writes ~/.claude)
cp docker-compose.override.yml.example docker-compose.override.yml
docker compose up -d
npm run smoke                               # live E2E against /api/generate
```

The override file (gitignored) mounts your host credentials into the container:
`~/.claude` (Claude OAuth, RW for token refresh), `~/.gemini` (Gemini CLI OAuth)
and/or `~/.gemini.key` (Gemini API key). Any missing credential simply disables
the matching feature.

### 3. Development — hot reload, no rebuild

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

`src/`, `public/`, `.claude/skills/` and `templates/` are mounted as volumes:
any TypeScript change restarts the server in ~1s **without a rebuild**. A C++
change (`pdf-engine/`) requires re-running with `--build` to recompile the binary.

## HTTP API

| Method & path | Purpose |
|---|---|
| `POST /api/generate` | Generate a catalog — multipart `template` (PDF) + `data` (CSV/XLSX) + `assets` (zip). Returns stats, warnings and a signed download URL. |
| `GET /api/health` | Liveness probe. |
| `GET /api/estimate` | ETA for a generation given product count. |
| `GET /api/gemini[/health\|/stats\|/circuit\|/smoke]` | Gemini key/quota status, usage stats, circuit state, module smoke test. |
| `POST /api/layout` | Experimental: compose a catalog from scratch (no template) via Gemini → HTML/CSS → PDF. |
| `GET /generated/<file>?token=…` | Download a generated PDF (signed HMAC URL). |

Useful query flags on `POST /api/generate`: `?audit=0`, `?descriptions=0`,
`?enrich=0`, `?coherence=1` toggle individual AI steps.

## Security

The app targets a **trusted single-user network** and is open by default for
local use. For an exposed deployment, harden it via environment (see
`.env.example`):

- **Auth** — set `ADMIN_TOKEN` to require a shared token on the mutating /
  costly endpoints (`DELETE /api/history`, `GET /api/gemini/smoke`, `?reset=1`).
  Clients send `X-Auth-Token: <token>` or `Authorization: Bearer <token>`.
- **Rate limiting** — per-IP limits on `/api` (`RATE_MAX_API`), the costly
  `POST /api/generate` (`RATE_MAX_GENERATE`) and `GET /api/gemini/smoke`
  (`RATE_MAX_SMOKE`). The health probe and progress polling are exempt.
- **Production mode** — `NODE_ENV=production` collapses error responses to
  generic messages (no internal paths / stack traces leak).
- **Headers** — `helmet` sets a strict CSP, anti-clickjacking
  (`X-Frame-Options`/`frame-ancestors`), `nosniff`, etc.
- **Signed downloads** — generated PDFs are served behind a constant-time HMAC
  token; set `DOWNLOAD_SECRET` (fixed) and optionally `DOWNLOAD_TTL_MS` (expiry).
- **Uploads** — size/entry caps, zip-bomb guards, path-traversal defenses, and a
  pixel cap on decoded images in the native renderer.

## Tests

```bash
npm test          # Vitest — 1200+ unit/integration tests, no network
npm run smoke     # live E2E against /api/generate (requires a running container)
```

### Synthetic fixtures — runs with zero client data

A fully **synthetic, fictional** fixture set is committed under
`tests/fixtures/synthetic/` (`template.pdf` + `data.xlsx` + `assets.zip`). It
contains no brand, no real product and no client reference, and it exercises the
whole deterministic pipeline (extract → classify → substitute → renumber → render).

```bash
docker compose up --build       # start the container
npm run smoke                   # runs end-to-end against the synthetic fixtures
```

`npm run smoke` automatically falls back to these fixtures (with AI disabled, so
no credentials are needed) when no real ones are present — so it works out of the
box. Regenerate them with `npm run fixtures:synth`.

To smoke-test your own catalog instead, drop the real (gitignored) `template.pdf`,
`data.xlsx` and `assets.zip` into `tests/fixtures/`; the smoke uses them when present.

## Project structure

| Path | Role |
|---|---|
| `src/` | TypeScript server code |
| `src/v2/` | Pipeline: schemas, validators, orchestrator, AI modules |
| `src/v2/gemini/` | Gemini client, model cascade, rate limiter, circuit breaker |
| `pdf-engine/` | C++ `catgen-pdf` binary (PDF extract + render) |
| `.claude/skills/catalog-generator/` | Versioned Claude skill bundle |
| `templates/` | Hand-editable JSON template descriptors |
| `public/` | Static UI |
| `tests/` | Vitest suite + smoke E2E |

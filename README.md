# catalog-gen-app

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

## Tests

```bash
npm test          # Vitest — 1200+ unit/integration tests, no network
npm run smoke     # live E2E against /api/generate (requires a running container + AI)
```

The smoke test needs three fixtures in `tests/fixtures/` (gitignored — large and
potentially proprietary): `template.pdf`, `data.xlsx`, `assets.zip`. Drop them in
and run `npm run smoke`.

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

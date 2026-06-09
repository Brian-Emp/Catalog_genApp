/**
 * Global coherence audit via Gemini Pro Vision (1M-token context).
 *
 * Different from visualAudit (case A) which detects bugs page by page:
 * coherenceAudit takes A SET of substituted pages and detects CROSS-PAGE
 * inconsistencies:
 *  - Heterogeneous typography (different sizes/fonts for the same elements)
 *  - Inconsistent colors (palette varying for no reason)
 *  - Broken hierarchy (level-1 header smaller than level 2)
 *  - Vertical alignments shifted between similar pages
 *  - Inconsistent pagination (skip, duplicate, format)
 *  - TOC vs pages: sections mentioned but absent or vice versa
 *
 * A single batched Gemini Pro Vision call — saves requests.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { renderPagePng } from '../engine/visualAudit';
import { analyzeMultiImage, GEMINI_MODELS, isGeminiAvailable } from './client';
import { parseGeminiJson } from './jsonParse';
import type { Plan } from '../types';

export interface CoherenceIssue {
  /** Type of inconsistency detected. */
  category:
    | 'typography'
    | 'color'
    | 'hierarchy'
    | 'alignment'
    | 'pagination'
    | 'toc_mismatch'
    | 'other';
  /** Pages concerned (1-based, in the final PDF). */
  pages: number[];
  /** Severity: critical blocks delivery, minor = fix later. */
  severity: 'critical' | 'minor';
  /** Precise description of the problem. */
  description: string;
}

export interface CoherenceAuditOptions {
  outPdfPath: string;
  plan: Plan;
  workDir: string;
  /** Max number of sampled pages. Default 12 (token savings). */
  maxPages?: number;
  /** Enabled. Default true if key available. */
  enabled?: boolean;
  /** Gemini model. Default flash (free tier OK; pro is paid-only on free
   *  tier — billing required for pro). */
  model?: string;
}

export interface CoherenceAuditResult {
  ran: boolean;
  issues: CoherenceIssue[];
  sampledPages: number[];
  durationMs: number;
  notes: string[];
}

const DEFAULT_MAX_PAGES = 12;

export async function coherenceAudit(
  opts: CoherenceAuditOptions,
): Promise<CoherenceAuditResult> {
  const t0 = Date.now();
  const notes: string[] = [];

  if (opts.enabled === false) {
    return { ran: false, issues: [], sampledPages: [], durationMs: 0, notes: ['disabled'] };
  }
  if (!(await isGeminiAvailable())) {
    return { ran: false, issues: [], sampledPages: [], durationMs: Date.now() - t0, notes: ['GEMINI_KEY absente'] };
  }

  // 1. Selection of the pages to analyze: we take all SUBSTITUTED pages
  // (operations mode) + the TOC if distinct. Sample uniformly if too many.
  const candidates: { finalNum: number; sourcePage: number; type: 'product' | 'toc' | 'other' }[] = [];
  for (let i = 0; i < opts.plan.pages.length; i++) {
    const p = opts.plan.pages[i];
    if (p.render.mode === 'operations') {
      const finalNum = i + 1;
      // Simple heuristic: many ops (>= 30) = substantial product/TOC page
      const opsCount = p.render.operations.length;
      const type = opsCount >= 30 ? 'product' : 'other';
      candidates.push({ finalNum, sourcePage: p.source_page, type });
    }
  }
  if (candidates.length === 0) {
    return { ran: false, issues: [], sampledPages: [], durationMs: Date.now() - t0, notes: ['aucune page substituee'] };
  }
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const sampled = candidates.length <= maxPages
    ? candidates
    : pickEvenly(candidates, maxPages);

  // 2. Rasterize each sampled page
  const auditDir = path.join(opts.workDir, 'coherence-audit');
  await fs.mkdir(auditDir, { recursive: true });
  const rendered: { finalNum: number; pngBytes: Buffer; pngPath: string }[] = [];
  for (const s of sampled) {
    const png = await renderPagePng(opts.outPdfPath, s.finalNum, auditDir);
    if (!png) {
      notes.push(`p.${s.finalNum} : rasterisation echec`);
      continue;
    }
    try {
      const bytes = await fs.readFile(png);
      rendered.push({ finalNum: s.finalNum, pngBytes: bytes, pngPath: png });
    } catch (e) {
      notes.push(`p.${s.finalNum} : lecture png echec : ${(e as Error).message}`);
    }
  }
  if (rendered.length === 0) {
    return {
      ran: false,
      issues: [],
      sampledPages: [],
      durationMs: Date.now() - t0,
      notes: [...notes, 'pdftoppm indisponible — coherence audit skip'],
    };
  }

  // 3. Multi-image Vision analysis via the API (cascade of multimodal models,
  //    cf. client.ts). The Gemini CLI is ABANDONED (slow + no image gen):
  //    cross-page coherence goes through the cascade's flash/3.x models.
  const prompt = buildCoherencePrompt(rendered.map((r) => r.finalNum));
  const res = await analyzeMultiImage({
    prompt,
    images: rendered.map((r) => ({
      bytes: r.pngBytes,
      mimeType: 'image/png',
      label: `Page ${r.finalNum} :`,
    })),
    model: opts.model ?? GEMINI_MODELS.flash,
    fallbackModel: GEMINI_MODELS.flashLite,
    temperature: 0.2,
    module: 'coherenceAudit',
    // Auxiliary audit: fail-fast on quota rather than sleeping (cf. visualAudit).
    maxRetryDelayMs: 8000,
  });
  const provider = res.usedFallback ? 'api-cascade-fallback' : 'api';
  notes.push(`coherence via ${provider}`);
  if (!res.ok || !res.text) {
    notes.push(`gemini error : ${res.error}`);
    return { ran: false, issues: [], sampledPages: rendered.map((r) => r.finalNum), durationMs: Date.now() - t0, notes };
  }

  // 4. Parse JSON
  const issues = parseCoherenceJson(res.text);
  if (!issues) {
    notes.push('reponse Gemini non-JSON parseable');
    return { ran: true, issues: [], sampledPages: rendered.map((r) => r.finalNum), durationMs: Date.now() - t0, notes };
  }

  return {
    ran: true,
    issues,
    sampledPages: rendered.map((r) => r.finalNum),
    durationMs: Date.now() - t0,
    notes,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function pickEvenly<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const out: T[] = [];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * step);
    out.push(arr[idx]);
  }
  return out;
}

function buildCoherencePrompt(pageNumbers: number[]): string {
  return `Tu es l'auditeur de COHERENCE GLOBALE d'un catalogue PDF generee par substitution.

Tu recois ${pageNumbers.length} pages substituees (numerotation finale : ${pageNumbers.join(', ')}).
Pour chaque page une image PNG.

OBJECTIF : detecter les INCOHERENCES CROSS-PAGE uniquement (PAS les bugs locaux qui sont audites ailleurs).

CATEGORIES A DETECTER :
- typography : memes types d'elements (nom produit, ref, spec key) avec tailles/fonts DIFFERENTES d'une page a l'autre
- color : palette couleur incoherente (ex section banner orange p.5 puis rouge p.6 alors que meme famille)
- hierarchy : niveaux visuels casses (sous-titre plus gros qu'un titre, etc.)
- alignment : zones produit alignees a X different selon pages similaires (ex grille 2-cols : col 1 a X=200 sur p.5, X=215 sur p.6)
- pagination : numerotation incoherente (saut de page, doublon, format different)
- toc_mismatch : UNIQUEMENT pour les vraies SECTIONS PRODUIT. Soit le sommaire
  liste une section produit dont AUCUNE page produit n'existe, soit une PAGE
  PRODUIT (avec des fiches : nom + ref + specs) appartient a une section produit
  totalement absente du sommaire.

REGLES ANTI-FAUX-POSITIFS (IMPORTANT) :
- Une "section produit" = une ou plusieurs pages contenant des FICHES PRODUIT
  (nom commercial + reference + tableau de specs/prix). Le sommaire ne liste QUE
  ces sections-la.
- Ne JAMAIS reporter en toc_mismatch :
  * les PAGES DE CONTEXTE / pedagogiques (edito, "comment choisir...", schemas
    explicatifs, pages marque, mentions legales) — elles n'ont PAS de fiches
    produit et n'ont PAS vocation a etre au sommaire ;
  * les RUBANS / BANDEAUX verticaux ou lateraux (label famille decoratif sur le
    bord d'une page, ex "ARROSAGE", "SANITAIRE") — c'est de la decoration
    template, PAS une entree de sommaire ;
  * un titre de page contexte (ex "SURPRESSION : bien choisir") confondu avec
    une section produit.
  En cas de doute (la page n'a pas de fiches produit visibles) → NE PAS reporter.
- Ne reporte PAS un bug local (texte coupe, glyphe casse) — c'est l'audit page-par-page qui s'en charge
- Ne reporte PAS des choix esthetiques deliberes (ex 1 page produit en pleine couleur si voulu)
- Ne reporte que les INCOHERENCES OBSERVABLES (au moins 2 pages diffèrent SUR LE MEME element)

SEVERITES :
- critical : incoherence majeure qui choque le lecteur (typo cassee, hierarchie inversee)
- minor : detail (espacement de 2pt different, nuance couleur subtile)

REPONDS UNIQUEMENT en JSON pur (pas de markdown, pas de prose) :
{
  "issues": [
    {
      "category": "typography" | "color" | "hierarchy" | "alignment" | "pagination" | "toc_mismatch" | "other",
      "pages": [N, N, ...],
      "severity": "critical" | "minor",
      "description": "<phrase precise indiquant l'element + pages concernees>"
    }
  ]
}

Si tout est coherent : { "issues": [] }`;
}

interface ParsedCoherence {
  issues?: unknown[];
}

function parseCoherenceJson(text: string): CoherenceIssue[] | null {
  const parsed = parseGeminiJson<ParsedCoherence>(text);
  if (!parsed || !Array.isArray(parsed.issues)) return null;
  const validCategories = ['typography', 'color', 'hierarchy', 'alignment', 'pagination', 'toc_mismatch', 'other'] as const;
  const issues: CoherenceIssue[] = [];
  for (const raw of parsed.issues) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const severity = o.severity === 'critical' || o.severity === 'minor' ? o.severity : null;
    if (!severity) continue;
    const description = typeof o.description === 'string' ? o.description : '';
    if (!description) continue;
    const category = validCategories.includes(o.category as typeof validCategories[number])
      ? (o.category as CoherenceIssue['category'])
      : 'other';
    const pages = Array.isArray(o.pages)
      ? o.pages.filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
      : [];
    issues.push({ category, pages, severity, description });
  }
  return issues;
}

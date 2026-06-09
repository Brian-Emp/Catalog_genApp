/**
 * Visual audit via Gemini Vision (alternative to the Claude CLI).
 *
 * Advantage vs Claude:
 *  - Auth via a fixed key (no expiration every 6h)
 *  - Faster (no CLI spawn; direct HTTP call)
 *  - Free tier for text/vision (vs Claude paid)
 *
 * Same output contract as visualAudit(claude): VisualAuditResult with
 * issues[]. The orchestrator can switch provider via an option.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { renderPagePng } from '../engine/visualAudit';
import { analyzeMultiImage, GEMINI_MODELS, isGeminiAvailable } from './client';
import { initCache, computeCacheKey, cacheGet, cacheSet } from './cache';
import { parseGeminiJson } from './jsonParse';
import { recordCall } from './stats';
import { isQuotaCold } from './circuitBreaker';
import type { PageAllocation } from '../engine/allocator';
import type { Plan } from '../types';
import type { VisualAuditIssue, VisualAuditResult } from '../engine/visualAudit';

export interface VisualAuditGeminiOptions {
  outPdfPath: string;
  plan: Plan;
  allocations: PageAllocation[];
  workDir: string;
  /** Number of pages to sample. 'all' = all. Default 6. */
  sampleSize?: number | 'all';
  /** Enables the audit. Default true. */
  enabled?: boolean;
  /** Gemini model. Default flash (fast + free). */
  model?: string;
  /** Project directory where the `.gemini-cache/` cache is stored. If provided:
   *  pages already audited with the same prompt+image are returned from the
   *  cache (avoids consuming the daily Gemini quota on re-runs). */
  projectDir?: string;
}

const DEFAULT_SAMPLE_SIZE = 6;

export async function visualAuditGemini(
  opts: VisualAuditGeminiOptions,
): Promise<VisualAuditResult> {
  const t0 = Date.now();
  if (opts.enabled === false) {
    return { ran: false, issues: [], sampledPages: [], durationMs: 0, notes: ['gemini audit disabled by caller'] };
  }
  if (!(await isGeminiAvailable())) {
    return { ran: false, issues: [], sampledPages: [], durationMs: Date.now() - t0, notes: ['GEMINI_KEY absente — audit skip'] };
  }
  // Dead-quota short-circuit: if a Gemini cascade failed entirely very
  // recently, the audit would fail too → we skip BEFORE rasterizing the pages
  // (expensive operation). Generation stays fast (quasi-deterministic).
  if (isQuotaCold()) {
    return { ran: false, issues: [], sampledPages: [], durationMs: Date.now() - t0, notes: ['quota Gemini froid — audit visuel court-circuite (retest auto)'] };
  }

  const finalPages: { finalNum: number; sourcePage: number }[] = [];
  for (let i = 0; i < opts.plan.pages.length; i++) {
    const p = opts.plan.pages[i];
    if (p.render.mode === 'operations') {
      finalPages.push({ finalNum: i + 1, sourcePage: p.source_page });
    }
  }
  if (finalPages.length === 0) {
    return { ran: false, issues: [], sampledPages: [], durationMs: Date.now() - t0, notes: ['aucune page substituee'] };
  }

  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const sampled = sampleSize === 'all' ? finalPages : pickSample(finalPages, sampleSize);

  // Rasterize the sampled pages (reuses renderPagePng from visualAudit)
  const auditDir = path.join(opts.workDir, 'audit-images-gemini');
  await fs.mkdir(auditDir, { recursive: true });
  const rendered: { finalNum: number; sourcePage: number; pngPath: string }[] = [];
  for (const p of sampled) {
    const png = await renderPagePng(opts.outPdfPath, p.finalNum, auditDir);
    if (png) rendered.push({ ...p, pngPath: png });
  }
  if (rendered.length === 0) {
    return {
      ran: false,
      issues: [],
      sampledPages: [],
      durationMs: Date.now() - t0,
      notes: ['pdftoppm indisponible ou rasterisation echouee — audit skip'],
    };
  }

  const allocByPage = new Map(opts.allocations.map((a) => [a.sourcePage, a]));
  const notes: string[] = [];

  // Read the rasterized PNGs.
  const images: { finalNum: number; sourcePage: number; bytes: Buffer }[] = [];
  for (const r of rendered) {
    try {
      images.push({ finalNum: r.finalNum, sourcePage: r.sourcePage, bytes: await fs.readFile(r.pngPath) });
    } catch (e) {
      notes.push(`p.${r.finalNum} : lecture png echec : ${(e as Error).message}`);
    }
  }
  if (images.length === 0) {
    return { ran: false, issues: [], sampledPages: [], durationMs: Date.now() - t0, notes: [...notes, 'aucune image lisible'] };
  }

  // A SINGLE multi-image Gemini Vision call (vs 1 call/page): ~Npages× less
  // quota consumed + faster. The prompt carries the context (expected products)
  // PER PAGE; the response attributes each issue to its page number.
  const descriptors = images.map((im) => ({
    finalNum: im.finalNum,
    sourcePage: im.sourcePage,
    expectedProducts: (allocByPage.get(im.sourcePage)?.products ?? []).map((p) => ({
      name: p.name,
      ref: p.ref,
      specCount: p.specs.length,
      hasImage: Boolean(p.image_path),
    })),
  }));
  const prompt = buildBatchPrompt(descriptors);

  // Batch-level cache (sha of the prompt + all images). Identical re-run → hit
  // → 0 Gemini calls (saves the daily quota).
  if (opts.projectDir) await initCache(opts.projectDir);
  const cacheKey = opts.projectDir ? computeCacheKey(prompt, images.map((i) => i.bytes)) : null;
  if (cacheKey) {
    const cached = cacheGet<VisualAuditIssue[]>(cacheKey);
    if (cached) {
      recordCall({ module: 'visualAudit', model: opts.model ?? GEMINI_MODELS.flash, status: 'cache_hit', durationMs: 0 });
      return { ran: true, issues: cached, sampledPages: images.map((i) => i.finalNum), durationMs: Date.now() - t0, notes: [...notes, 'cache hit (batch)'] };
    }
  }

  const res = await analyzeMultiImage({
    prompt,
    images: images.map((im) => ({ bytes: im.bytes, mimeType: 'image/png', label: `Page ${im.finalNum} :` })),
    // Vision cascade (flash → 2.0-flash → flash-lite → 2.0-flash-lite) handled
    // in analyzeMultiImage: we switch model on exhausted quota.
    model: opts.model ?? GEMINI_MODELS.flash,
    fallbackModel: GEMINI_MODELS.flashLite,
    module: 'visualAudit',
  });
  if (!res.ok || !res.text) {
    return { ran: false, issues: [], sampledPages: images.map((i) => i.finalNum), durationMs: Date.now() - t0, notes: [...notes, `gemini error : ${res.error}`] };
  }
  if (res.usedFallback) notes.push('cascade : modele de secours utilise (quota)');

  const parsed = parseJsonResponse(res.text);
  if (!parsed) {
    return { ran: true, issues: [], sampledPages: images.map((i) => i.finalNum), durationMs: Date.now() - t0, notes: [...notes, 'reponse non-JSON parseable'] };
  }
  const sourceByFinal = new Map(images.map((im) => [im.finalNum, im.sourcePage]));
  const issues: VisualAuditIssue[] = [];
  if (Array.isArray(parsed.issues)) {
    for (const raw of parsed.issues) {
      const issue = normalizeIssue(raw, sourceByFinal);
      if (issue) issues.push(issue);
    }
  }
  if (cacheKey) void cacheSet(cacheKey, issues);

  return {
    ran: true,
    issues,
    sampledPages: images.map((i) => i.finalNum),
    durationMs: Date.now() - t0,
    notes,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ExpectedProduct {
  name: string;
  ref: string | null;
  specCount: number;
  hasImage: boolean;
}

function buildBatchPrompt(
  pages: { finalNum: number; sourcePage: number; expectedProducts: ExpectedProduct[] }[],
): string {
  // A single prompt for ALL pages. Each page declares its type
  // (context vs product) + the expected products. The response attributes each
  // issue to its page number via the "page" field.
  const pageBlocks = pages
    .map((p) => {
      if (p.expectedProducts.length === 0) {
        return `- Page ${p.finalNum} : CONTEXTE (cover / intro marque / sommaire / intercalaire / 4e de couv). Contenu template conserve intentionnellement. Ne reporter QUE : glyphes melanges/illisibles, numero de page absent ou duplique, cartouche colore vide, image manquante au centre d'une zone designee. Sinon rien.`;
      }
      const list = p.expectedProducts
        .map((e) => `${e.name}${e.ref ? ` (ref ${e.ref})` : ''}`)
        .join(' | ');
      return `- Page ${p.finalNum} : PRODUIT (fiche substituee). Produits attendus : ${list}.`;
    })
    .join('\n');

  return `Tu es auditeur visuel d'un catalogue PDF genere par substitution.
Tu recois ${pages.length} page(s), chaque image est precedee de son label "Page X :".

CONTEXTE PAR PAGE :
${pageBlocks}

Pour chaque page PRODUIT, compare l'image aux produits attendus. Reporte
UNIQUEMENT (severite critical) :
- texte corrompu / glyphes melanges / chevauchement rendant illisible
- mauvais nom produit affiche (ex AQUASTAR remplace par ECOP)
- numero de page absent OU duplique
- cartouche section vide ou label different attendu
- texte coupe sur les bords de page

NE PAS reporter :
- image template conservee (meme sans nouvelle image fournie, le template reste OK)
- specs absentes ou ordre different (le template controle cette presentation)
- logo / marque tiers du template (DAB, Bosch, etc.)
- alignement legerement off, variations typographiques, preferences esthetiques

REPONDS UNIQUEMENT en JSON pur (pas de markdown, pas de prose) :
{
  "issues": [
    {
      "page": <numero final de la page concernee>,
      "severity": "critical",
      "category": "overflow" | "mismatch" | "cropped" | "missing_image" | "overlap" | "other",
      "description": "<phrase precise>",
      "productName": "<nom si applicable>"
    }
  ]
}
Si tout est sain (cas frequent) : { "issues": [] }`;
}

interface ParsedAudit {
  issues?: unknown[];
}

function parseJsonResponse(text: string): ParsedAudit | null {
  return parseGeminiJson<ParsedAudit>(text);
}

function normalizeIssue(
  raw: unknown,
  sourceByFinal: Map<number, number>,
): VisualAuditIssue | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const severity = o.severity === 'critical' || o.severity === 'minor' ? o.severity : null;
  if (!severity) return null;
  const description = typeof o.description === 'string' ? o.description : '';
  if (!description) return null;
  const validCategories = ['overflow', 'mismatch', 'cropped', 'missing_image', 'overlap', 'other'] as const;
  const category = validCategories.includes(o.category as typeof validCategories[number])
    ? (o.category as VisualAuditIssue['category'])
    : 'other';
  // Page attribution: the batch response indicates the final number in "page".
  // If the model returns an unknown/absent number (hallucination, missing field),
  // we attach it to the first sampled page rather than showing "Page 0".
  const rawPage = typeof o.page === 'number' && Number.isFinite(o.page) ? o.page : NaN;
  const validPages = [...sourceByFinal.keys()];
  const finalPageNumber = sourceByFinal.has(rawPage) ? rawPage : (validPages[0] ?? 0);
  const sourcePage = sourceByFinal.get(finalPageNumber) ?? 0;
  return {
    finalPageNumber,
    sourcePage,
    severity,
    category,
    description,
    productName: typeof o.productName === 'string' ? o.productName : undefined,
  };
}

function pickSample<T extends { finalNum: number }>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const result: T[] = [];
  const step = (arr.length - 1) / (n - 1);
  const taken = new Set<number>();
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * step);
    if (!taken.has(idx)) {
      taken.add(idx);
      result.push(arr[idx]);
    }
  }
  return result;
}

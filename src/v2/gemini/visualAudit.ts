/**
 * Audit visuel via Gemini Vision (alternative à Claude CLI).
 *
 * Avantage vs Claude :
 *  - Auth par cle fixe (pas d'expiration toutes les 6h)
 *  - Plus rapide (pas de spawn CLI ; appel HTTP direct)
 *  - Gratuit tier free pour text/vision (vs Claude paid)
 *
 * Meme contract de sortie que visualAudit(claude) : VisualAuditResult avec
 * issues[]. L'orchestrator peut switcher provider via une option.
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
  /** Nombre de pages a echantillonner. 'all' = toutes. Default 6. */
  sampleSize?: number | 'all';
  /** Active l'audit. Default true. */
  enabled?: boolean;
  /** Modele Gemini. Default flash (rapide + gratuit). */
  model?: string;
  /** Repertoire projet ou` stocker le cache `.gemini-cache/`. Si fourni :
   *  les pages deja auditees avec le meme prompt+image sont retournees du
   *  cache (evite de consommer le quota daily Gemini sur les re-runs). */
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
  // Court-circuit quota-mort : si une cascade Gemini a tout echoue tres
  // recemment, l'audit echouerait aussi → on skip AVANT de rasteriser les pages
  // (operation couteuse). La generation reste rapide (quasi-deterministe).
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

  // Rasterise les pages echantillonnees (reutilise renderPagePng de visualAudit)
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

  // Lecture des PNG rasterises.
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

  // UN SEUL appel Gemini Vision multi-image (vs 1 appel/page) : ~Npages× moins
  // de quota consomme + plus rapide. Le prompt porte le contexte (produits
  // attendus) PAR PAGE ; la reponse attribue chaque issue a son numero de page.
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

  // Cache batch-level (sha du prompt + toutes les images). Re-run identique → hit
  // → 0 appel Gemini (economise le quota daily).
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
    // Cascade vision (flash → 2.0-flash → flash-lite → 2.0-flash-lite) geree
    // dans analyzeMultiImage : on bascule de modele sur quota epuise.
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
  // Un seul prompt pour TOUTES les pages. Chaque page declare son type
  // (contexte vs produit) + les produits attendus. La reponse attribue chaque
  // issue a son numero de page via le champ "page".
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
  // Attribution a la page : la reponse batch indique le numero final dans "page".
  // Si le modele renvoie un numero inconnu/absent (hallucination, oubli du champ),
  // on rattache a la 1re page echantillonnee plutot que d'afficher "Page 0".
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

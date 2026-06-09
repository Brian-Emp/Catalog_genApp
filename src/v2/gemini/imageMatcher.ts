/**
 * Smart image matcher via Gemini: matches product names ↔ assets when the
 * slug/ref heuristic is not enough (case of exotic asset names).
 *
 * Contract identical to claudeMatchAssets for a drop-in swap. Gemini Flash =
 * free + fast (vs Claude paid + expirable).
 */

import { isGeminiAvailable } from './client';
import { routedGenerateText } from './providerRouter';
import { parseGeminiJson } from './jsonParse';

export interface UnmatchedProduct {
  idx: number;
  name: string;
  ref: string | null;
}

export interface AssetEntry {
  baseName: string;
  absPath: string;
}

export interface ImageMatch {
  /** Index into the original products array. */
  idx: number;
  absPath: string;
}

export interface GeminiImageMatcherOptions {
  unmatchedProducts: UnmatchedProduct[];
  assets: AssetEntry[];
  enabled?: boolean;
}

export interface GeminiImageMatcherResult {
  matched: ImageMatch[];
  ran: boolean;
  durationMs: number;
  /** Estimated cost. Gemini free tier = 0. */
  costUsd?: number;
  notes: string[];
}

const MAX_PRODUCTS = 100;
const MAX_ASSETS = 200;

export async function geminiMatchAssets(
  opts: GeminiImageMatcherOptions,
): Promise<GeminiImageMatcherResult> {
  const t0 = Date.now();
  const notes: string[] = [];

  if (opts.enabled === false) {
    return { matched: [], ran: false, durationMs: 0, notes: ['disabled'] };
  }
  if (opts.unmatchedProducts.length === 0) {
    return { matched: [], ran: false, durationMs: 0, notes: ['aucun produit a matcher'] };
  }
  if (opts.assets.length === 0) {
    return { matched: [], ran: false, durationMs: 0, notes: ['aucun asset'] };
  }
  if (!(await isGeminiAvailable())) {
    return { matched: [], ran: false, durationMs: Date.now() - t0, notes: ['GEMINI_KEY absente'] };
  }

  // Cap to avoid giant prompts
  const products = opts.unmatchedProducts.slice(0, MAX_PRODUCTS);
  const assets = opts.assets.slice(0, MAX_ASSETS);

  const prompt = buildPrompt(products, assets);
  const res = await routedGenerateText({
    prompt,
    // pref 'speed': deterministic matching, flash-lite API ideal.
    // Fallback to the Gemini Pro CLI if API quota is hit.
    pref: 'speed',
    temperature: 0.1,
    maxOutputTokens: 2048,
    module: 'imageMatcher',
  });
  if (!res.ok || !res.text) {
    notes.push(`gemini error : ${res.error}`);
    return { matched: [], ran: false, durationMs: Date.now() - t0, notes };
  }

  const parsed = parseMatchJson(res.text);
  if (!parsed) {
    notes.push('reponse Gemini non-JSON parseable');
    return { matched: [], ran: true, durationMs: Date.now() - t0, notes };
  }

  // Validation: each returned baseName must exist in assets
  const assetByBase = new Map(assets.map((a) => [a.baseName, a.absPath]));
  const productByIdx = new Map(products.map((p) => [p.idx, p]));
  const matched: ImageMatch[] = [];
  for (const m of parsed) {
    if (!productByIdx.has(m.idx)) continue;
    const absPath = assetByBase.get(m.assetBaseName);
    if (!absPath) continue;
    matched.push({ idx: m.idx, absPath });
  }

  return {
    matched,
    ran: true,
    durationMs: Date.now() - t0,
    notes,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildPrompt(products: UnmatchedProduct[], assets: AssetEntry[]): string {
  const productList = products
    .map((p) => `- idx ${p.idx} : "${p.name}"${p.ref ? ` (ref ${p.ref})` : ''}`)
    .join('\n');
  const assetList = assets.map((a) => `- "${a.baseName}"`).join('\n');

  return `Tu es un matcher de fichiers d'images aux produits d'un catalogue.

PRODUITS SANS IMAGE (a matcher) :
${productList}

ASSETS DISPONIBLES (noms de fichiers, sans extension) :
${assetList}

OBJECTIF : pour CHAQUE produit ci-dessus, trouve le fichier d'asset qui correspond le mieux.

REGLES :
- Match prioritaire par REF (ex produit ref "002236" → asset "002236" ou "img_002236").
- Sinon match par NOM (ex "AQUASTAR 900" → asset "aquastar_900" ou "aquastar-900-photo").
- Plusieurs produits peuvent matcher le MEME asset (rare mais possible).
- Si AUCUN asset ne correspond raisonnablement, OMETS le produit (pas de match force).
- Ne JAMAIS inventer un nom d'asset : utilise EXACTEMENT un des baseName ci-dessus.

REPONDS UNIQUEMENT en JSON pur (pas de markdown) :
{
  "matches": [
    { "idx": <idx produit>, "assetBaseName": "<basename exact>" }
  ]
}

Si aucun match : { "matches": [] }`;
}

interface ParsedMatch {
  idx: number;
  assetBaseName: string;
}

function parseMatchJson(text: string): ParsedMatch[] | null {
  const parsed = parseGeminiJson<{ matches?: unknown }>(text);
  if (!parsed || !Array.isArray(parsed.matches)) return null;
  const result: ParsedMatch[] = [];
  for (const raw of parsed.matches) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.idx !== 'number' || typeof o.assetBaseName !== 'string') continue;
    result.push({ idx: o.idx, assetBaseName: o.assetBaseName });
  }
  return result;
}

/**
 * Smart product ↔ image asset matching via Claude.
 *
 * Use case: when the heuristic (by ref/sku/name slug) fails to find an asset
 * for a product, we ask Claude to inspect the available asset names and the
 * product name to propose a match.
 *
 * Strategy: optional call on products without an image_path, triggered only
 * if > 30% of products are orphaned AND at least 1 asset exists. Otherwise
 * silent skip. Claude proposes the baseName (without extension) of the most
 * likely asset, or null if nothing is obvious.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { callClaudeCli } from '../v2/claudeCli';
import { CLAUDE_CLI_TIMEOUT_MS } from '../v2/timeouts';

const MAX_PRODUCTS_PER_CALL = 50;
const MAX_ASSETS_PER_CALL = 200;

export interface AssetCandidate {
  baseName: string;
  absPath: string;
}

export interface UnmatchedProduct {
  idx: number;
  name: string;
  ref: string | null;
}

export interface ClaudeAssetMatchOptions {
  unmatchedProducts: UnmatchedProduct[];
  assets: AssetCandidate[];
  workDir: string;
  projectDir: string;
  claudeBin?: string;
  enabled?: boolean;
}

export interface ClaudeAssetMatchResult {
  ran: boolean;
  durationMs: number;
  costUsd?: number;
  notes: string[];
  matched: { idx: number; absPath: string }[];
}

export async function claudeMatchAssets(
  opts: ClaudeAssetMatchOptions,
): Promise<ClaudeAssetMatchResult> {
  const t0 = Date.now();
  if (opts.enabled === false) {
    return { ran: false, durationMs: 0, notes: ['disabled'], matched: [] };
  }
  if (opts.unmatchedProducts.length === 0) {
    return { ran: false, durationMs: 0, notes: ['no unmatched products'], matched: [] };
  }
  if (opts.assets.length === 0) {
    return { ran: false, durationMs: 0, notes: ['no assets disponibles'], matched: [] };
  }
  const products = opts.unmatchedProducts.slice(0, MAX_PRODUCTS_PER_CALL);
  const assets = opts.assets.slice(0, MAX_ASSETS_PER_CALL);
  const assetByBase = new Map(assets.map((a) => [a.baseName, a.absPath]));

  const auditPath = path.join(opts.workDir, 'asset-matching.json');
  await fs.writeFile(auditPath, JSON.stringify({ matches: [], notes: [] }, null, 2), 'utf8');
  const prompt = buildPrompt(products, assets, auditPath);
  const res = await callClaudeCli({
    prompt,
    workDir: opts.workDir,
    projectDir: opts.projectDir,
    claudeBin: opts.claudeBin,
    timeoutMs: CLAUDE_CLI_TIMEOUT_MS,
    allowedTools: 'Edit',
  });
  const notes: string[] = [];
  if (!res.ok) {
    notes.push('claude asset matcher failed: ' + (res.result?.slice(0, 200) ?? 'unknown'));
    return { ran: false, durationMs: Date.now() - t0, notes, matched: [] };
  }
  const matched: { idx: number; absPath: string }[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(auditPath, 'utf8')) as {
      matches?: unknown;
      notes?: unknown;
    };
    if (Array.isArray(parsed.matches)) {
      const validIdxs = new Set(products.map((p) => p.idx));
      for (const m of parsed.matches) {
        if (!m || typeof m !== 'object') continue;
        const o = m as Record<string, unknown>;
        const idx = typeof o.idx === 'number' ? o.idx : null;
        const baseName = typeof o.asset === 'string' ? o.asset : null;
        if (idx === null || baseName === null) continue;
        if (!validIdxs.has(idx)) continue;
        const abs = assetByBase.get(baseName);
        if (!abs) continue;
        matched.push({ idx, absPath: abs });
      }
    }
    if (Array.isArray(parsed.notes)) {
      for (const n of parsed.notes) if (typeof n === 'string') notes.push(n);
    }
  } catch (e) {
    notes.push('parse asset-matching failed: ' + (e as Error).message);
    return { ran: false, durationMs: Date.now() - t0, notes, matched: [] };
  }
  return {
    ran: true,
    durationMs: Date.now() - t0,
    costUsd: res.costUsd,
    notes,
    matched,
  };
}

function buildPrompt(
  products: UnmatchedProduct[],
  assets: AssetCandidate[],
  auditPath: string,
): string {
  const prodLines = products
    .map((p) => `  - idx ${p.idx} : "${p.name}"${p.ref ? ` (ref ${p.ref})` : ''}`)
    .join('\n');
  const assetLines = assets.map((a) => `  - ${a.baseName}`).join('\n');
  return `Tu es l'auditeur du matching produit ↔ asset image. L'heuristique automatique (matching par ref / slug du nom) a echoue pour les produits ci-dessous. Inspecte la liste d'assets et propose une correspondance UNIQUEMENT quand le lien est evident.

PRODUITS ORPHELINS (sans image) :
${prodLines}

ASSETS DISPONIBLES (basename sans extension) :
${assetLines}

REGLES :
- Match QUAND le baseName de l'asset contient explicitement le nom du produit (ou une variante claire : abreviations, codes ref, formes courtes du modele).
- Match QUAND la ref produit est presente dans le baseName.
- NE match PAS si le lien n'est qu'une supposition vague (ex meme famille mais aucun token commun).
- Un asset ne peut etre match qu'a UN seul produit (le plus pertinent).
- Si aucune correspondance evidente : ne mets PAS d'entree pour ce produit.

REPONDS UNIQUEMENT en editant ${auditPath} avec ce schema EXACT :
{
  "matches": [
    { "idx": <N>, "asset": "<baseName exact>" }
  ],
  "notes": [
    "<explication si choix subtil>"
  ]
}

Ne reponds RIEN d'autre que cet edit. Si aucun match evident, matches=[] et au moins 1 note descriptive.`;
}

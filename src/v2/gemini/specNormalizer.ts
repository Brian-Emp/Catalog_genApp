/**
 * Spec key normalizer via Gemini: remaps product keys (often ERP-style
 * "Largo_cm" / "Material_principal") to the template STYLE (e.g. "LONGUEUR :",
 * "MATIERE :").
 *
 * Contract identical to normalizeSpecs (Claude) for a drop-in swap in the
 * orchestrator. Gemini Flash = free, fast, reliable on this specific case.
 */

import { isGeminiAvailable } from './client';
import { routedGenerateText } from './providerRouter';
import { parseGeminiJson } from './jsonParse';

export interface GeminiSpecNormalizerOptions {
  /** Product keys to normalize. */
  productKeys: string[];
  /** Keys seen in the template (target of the normalization). */
  templateKeys: string[];
  enabled?: boolean;
}

export interface GeminiSpecNormalizerResult {
  ran: boolean;
  durationMs: number;
  /** Map productKey → templateKey (only the remapped keys). */
  mapping: Record<string, string>;
  notes: string[];
}

const MAX_TEMPLATE_KEYS = 30;

export async function geminiNormalizeSpecs(
  opts: GeminiSpecNormalizerOptions,
): Promise<GeminiSpecNormalizerResult> {
  const t0 = Date.now();
  const notes: string[] = [];

  if (opts.enabled === false) {
    return { ran: false, durationMs: 0, mapping: {}, notes: ['disabled'] };
  }
  if (opts.productKeys.length === 0 || opts.templateKeys.length === 0) {
    return { ran: false, durationMs: 0, mapping: {}, notes: ['donnees insuffisantes'] };
  }
  if (!(await isGeminiAvailable())) {
    return { ran: false, durationMs: Date.now() - t0, mapping: {}, notes: ['GEMINI_KEY absente'] };
  }

  const templateKeys = opts.templateKeys.slice(0, MAX_TEMPLATE_KEYS);
  const prompt = buildPrompt(templateKeys, opts.productKeys);
  const res = await routedGenerateText({
    prompt,
    // pref 'speed': key remapping = short JSON, flash-lite API ideal.
    // Fallback to the Gemini Pro CLI if API quota is hit.
    pref: 'speed',
    temperature: 0.1,
    maxOutputTokens: 1536,
    module: 'specNormalizer',
  });
  if (!res.ok || !res.text) {
    notes.push(`gemini error : ${res.error}`);
    return { ran: false, durationMs: Date.now() - t0, mapping: {}, notes };
  }

  const parsed = parseMappingJson(res.text);
  if (!parsed) {
    notes.push('reponse Gemini non-JSON parseable');
    return { ran: true, durationMs: Date.now() - t0, mapping: {}, notes };
  }

  // Validation: we keep only the mappings toward REAL template keys
  // (Gemini sometimes hallucinates). And we filter out the no-ops (k → k).
  const templateSet = new Set(templateKeys);
  const productSet = new Set(opts.productKeys);
  const mapping: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') continue;
    if (!productSet.has(k)) continue;
    if (!templateSet.has(v)) continue;
    if (v === k) continue;
    mapping[k] = v;
  }

  return {
    ran: true,
    durationMs: Date.now() - t0,
    mapping,
    notes,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildPrompt(templateKeys: string[], productKeys: string[]): string {
  const tplList = templateKeys.map((k) => `- "${k}"`).join('\n');
  const prodList = productKeys.map((k) => `- "${k}"`).join('\n');

  return `Tu es un normalizer de cles de specifications produit pour un catalogue.

KEYS TEMPLATE (style cible, IDENTIQUE attendu dans le PDF final) :
${tplList}

KEYS PRODUIT (depuis XLSX client, souvent style ERP brut) :
${prodList}

TACHE : pour CHAQUE key produit, trouve le label template equivalent (semantique
identique meme si formulation differente).

EXEMPLES :
- "Largo_bras" → "LONGUEUR :" (semantique = longueur du bras de douche)
- "Material_principal" → "MATIERE :"
- "Garantia_anos" → "DURÉE DE GARANTIE (EN ANNÉES) :"
- "puis" → "Puissance" (abreviation)
- "deb_max" → "Débit maximum"

REGLES :
- Match par SENS, pas par forme litterale.
- Si AUCUN template ne correspond raisonnablement (ex spec specifique sans equivalent), OMETS la key.
- N'INVENTE jamais un label : utilise EXACTEMENT un des labels template ci-dessus.
- Ne remap PAS une key qui est deja dans le style template (no-op).

REPONDS UNIQUEMENT en JSON pur (pas de markdown) :
{
  "<productKey>": "<templateKey>",
  ...
}

Si aucun mapping necessaire : {}`;
}

function parseMappingJson(text: string): Record<string, unknown> | null {
  return parseGeminiJson<Record<string, unknown>>(text);
}

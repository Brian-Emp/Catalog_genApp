/**
 * Intent Parser : transforme les suggestions textuelles libres (Phase 1
 * intent loop) en intents STRUCTURÉS interpretables programmatiquement.
 *
 * Exemple :
 *   Input : "Décaler le nom produit de 4pt vers la droite pour eviter le
 *            chevauchement avec l'image."
 *   Output : { kind: 'move', target: 'nom produit', deltaXpt: 4 }
 *
 * Architecture : un second appel Gemini Flash-lite avec schema JSON strict.
 * On envoie les phrases libres + la cible (page, contexte), Gemini retourne
 * un mapping structure → on filtre les intents bien formes.
 *
 * Phase 3 (TODO orchestrator) : prendre StructuredIntent[] et generer des
 * ops pdf-engine (subs.json patch) ou des mutations du Plan.
 */

import { isGeminiAvailable } from './client';
import { routedGenerateText } from './providerRouter';
import { parseGeminiJson } from './jsonParse';
import type { IntentSuggestion } from './intentLoop';

export type StructuredIntent =
  | { kind: 'move'; target: string; deltaXpt?: number; deltaYpt?: number; confidence: number }
  | { kind: 'resize'; target: string; fontSizePt?: number; widthPct?: number; confidence: number }
  | { kind: 'recolor'; target: string; fill?: string; stroke?: string; confidence: number }
  | { kind: 'erase_pad'; target: string; padPt: number; confidence: number }
  | { kind: 'replace_text'; target: string; from?: string; to: string; confidence: number }
  | { kind: 'unknown'; description: string; confidence: number };

export interface IntentParserOptions {
  suggestions: IntentSuggestion[];
  enabled?: boolean;
}

export interface IntentParserResult {
  ran: boolean;
  durationMs: number;
  /** Map (finalPageNumber, suggestionIdx) → StructuredIntent. */
  structured: Array<{
    finalPageNumber: number;
    sourceIntent: string;
    structured: StructuredIntent;
  }>;
  notes: string[];
}

export async function parseStructuredIntents(
  opts: IntentParserOptions,
): Promise<IntentParserResult> {
  const t0 = Date.now();
  const notes: string[] = [];

  if (opts.enabled === false) {
    return { ran: false, durationMs: 0, structured: [], notes: ['disabled'] };
  }
  if (opts.suggestions.length === 0) {
    return { ran: false, durationMs: 0, structured: [], notes: ['aucune suggestion'] };
  }
  if (!(await isGeminiAvailable())) {
    return { ran: false, durationMs: Date.now() - t0, structured: [], notes: ['GEMINI_KEY absente'] };
  }

  const prompt = buildPrompt(opts.suggestions);
  // pref 'speed' : parsing intent → JSON structure, API flash-lite ideale.
  // Fallback CLI Gemini Pro si quota API.
  const res = await routedGenerateText({
    prompt,
    pref: 'speed',
    temperature: 0.1,
    maxOutputTokens: 2048,
    module: 'intentParser',
  });
  if (!res.ok || !res.text) {
    notes.push(`gemini error : ${res.error}`);
    return { ran: false, durationMs: Date.now() - t0, structured: [], notes };
  }

  const parsed = parseStructuredJson(res.text);
  if (!parsed) {
    notes.push('reponse Gemini non-JSON parseable');
    return { ran: true, durationMs: Date.now() - t0, structured: [], notes };
  }

  // Map back par idx
  const structured: IntentParserResult['structured'] = [];
  for (const entry of parsed) {
    if (typeof entry.idx !== 'number' || !entry.intent) continue;
    const src = opts.suggestions[entry.idx];
    if (!src) continue;
    const normalized = normalizeIntent(entry.intent, src.confidence);
    if (!normalized) continue;
    structured.push({
      finalPageNumber: src.finalPageNumber,
      sourceIntent: src.intent,
      structured: normalized,
    });
  }

  return {
    ran: true,
    durationMs: Date.now() - t0,
    structured,
    notes,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildPrompt(suggestions: IntentSuggestion[]): string {
  const list = suggestions
    .map((s, idx) => `${idx}. (p.${s.finalPageNumber}) "${s.intent}"`)
    .join('\n');

  return `Tu parses des suggestions de correction PDF en intents STRUCTURÉS.

SUGGESTIONS LIBRES :
${list}

TACHE : pour CHAQUE suggestion (par idx), produis UN intent structure du
schema ci-dessous. Si une suggestion n'est pas parseable (trop vague, action
non supportee), produis kind:"unknown" avec la description originale.

KIND SUPPORTÉS :
- move : decaler un element. Champs : target (nom element), deltaXpt, deltaYpt (signe : + = droite/bas).
- resize : changer taille. Champs : target, fontSizePt OU widthPct.
- recolor : changer couleur. Champs : target, fill (hex #RRGGBB) ou stroke (hex).
- erase_pad : augmenter la zone d'effacement autour d'un element. Champs : target, padPt.
- replace_text : remplacer un texte. Champs : target, from (optionnel), to.
- unknown : si non parseable. Champs : description.

EXEMPLES :
- "Décaler le nom produit de 4pt vers la droite" → {"kind":"move","target":"nom produit","deltaXpt":4}
- "Augmenter le erase_rect autour de la ref a 8pt" → {"kind":"erase_pad","target":"ref","padPt":8}
- "Remplacer la couleur blanche du nom par noir" → {"kind":"recolor","target":"nom","fill":"#000000"}

REPONDS UNIQUEMENT en JSON pur (pas de markdown) :
{
  "intents": [
    { "idx": <idx suggestion>, "intent": { "kind": "...", ... } }
  ]
}`;
}

interface ParsedEntry {
  idx?: number;
  intent?: Record<string, unknown>;
}

function parseStructuredJson(text: string): ParsedEntry[] | null {
  const parsed = parseGeminiJson<{ intents?: unknown }>(text);
  if (!parsed || !Array.isArray(parsed.intents)) return null;
  const out: ParsedEntry[] = [];
  for (const raw of parsed.intents) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.idx !== 'number') continue;
    if (!o.intent || typeof o.intent !== 'object') continue;
    out.push({
      idx: o.idx,
      intent: o.intent as Record<string, unknown>,
    });
  }
  return out;
}

/**
 * Normalise une entree intent Gemini brute en StructuredIntent type-safe.
 * Filtre les payloads malformes. Exporte pour test unitaire.
 */
export function normalizeIntent(
  raw: Record<string, unknown>,
  fallbackConfidence: number,
): StructuredIntent | null {
  const kind = typeof raw.kind === 'string' ? raw.kind : null;
  if (!kind) return null;
  const target = typeof raw.target === 'string' ? raw.target : null;
  const confidence = typeof raw.confidence === 'number'
    ? Math.max(0, Math.min(1, raw.confidence))
    : fallbackConfidence;

  switch (kind) {
    case 'move':
      if (!target) return null;
      return {
        kind: 'move',
        target,
        deltaXpt: typeof raw.deltaXpt === 'number' ? raw.deltaXpt : undefined,
        deltaYpt: typeof raw.deltaYpt === 'number' ? raw.deltaYpt : undefined,
        confidence,
      };
    case 'resize':
      if (!target) return null;
      return {
        kind: 'resize',
        target,
        fontSizePt: typeof raw.fontSizePt === 'number' ? raw.fontSizePt : undefined,
        widthPct: typeof raw.widthPct === 'number' ? raw.widthPct : undefined,
        confidence,
      };
    case 'recolor':
      if (!target) return null;
      return {
        kind: 'recolor',
        target,
        fill: typeof raw.fill === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.fill) ? raw.fill : undefined,
        stroke: typeof raw.stroke === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.stroke) ? raw.stroke : undefined,
        confidence,
      };
    case 'erase_pad':
      if (!target || typeof raw.padPt !== 'number') return null;
      return { kind: 'erase_pad', target, padPt: raw.padPt, confidence };
    case 'replace_text':
      if (!target || typeof raw.to !== 'string') return null;
      return {
        kind: 'replace_text',
        target,
        from: typeof raw.from === 'string' ? raw.from : undefined,
        to: raw.to,
        confidence,
      };
    case 'unknown':
      return {
        kind: 'unknown',
        description: typeof raw.description === 'string' ? raw.description : '(vide)',
        confidence,
      };
    default:
      return null;
  }
}

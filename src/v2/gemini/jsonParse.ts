/**
 * Parser JSON tolerant pour reponses Gemini.
 *
 * Gemini retourne souvent :
 *  - ```json {...} ``` (markdown fence)
 *  - prose avant + {...} + prose apres
 *  - juste {...} (cas ideal)
 *
 * Ce parser :
 *  1. Strip les fences markdown
 *  2. Tente JSON.parse direct
 *  3. Si fail : extract le 1er {...} balance et reessaie
 *  4. Retourne null si tout fail
 *
 * Centralise pour eviter la duplication de 5+ parsers dans les modules.
 */

/**
 * Parse une reponse texte Gemini en objet JSON. Retourne null si non parseable.
 */
export function parseGeminiJson<T = unknown>(text: string): T | null {
  if (!text || typeof text !== 'string') return null;
  const stripped = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {
    // Fallback : extract le 1er {...} ou [...] balance
    const objMatch = stripped.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]) as T; } catch { /* fall */ }
    }
    const arrMatch = stripped.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0]) as T; } catch { /* fall */ }
    }
    return null;
  }
}

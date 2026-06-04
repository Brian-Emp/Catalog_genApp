/**
 * Helpers de normalisation textuelle partages par le pipeline.
 *
 * Centralise les implementations qui etaient dupliquees dans :
 *   - productsAdapter.ts (stripAccents, TRANSLIT_MAP)
 *   - inputs.ts (SECTION_TRANSLIT, sub-set partiel)
 *   - classify.ts (stripAccents)
 *   - colorPalette.ts (ß → ss inline dans normalizeColorText)
 *
 * Avant cette consolidation : 4 copies de stripAccents avec des regex
 * Unicode légèrement divergentes, et 2 tables de translit incoherentes
 * sur ẞ ('ss' vs 'SS'). Maintenant : 1 source de verite.
 */

/** Strip les diacritiques NFD (caracteres combinables type accent aigu,
 *  grave, tréma...). Plage U+0300..U+036F = "Combining Diacritical Marks".
 *
 *  "Café" → "Cafe", "Mégère" → "Megere", "naïve" → "naive". */
export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Translitterations de caracteres NON-decomposables NFD : chars qui n'ont
 * pas de forme NFD avec diacritique separable. Doivent etre appliques
 * EXPLICITEMENT avant stripAccents pour preserver le contenu semantique.
 *
 * Sans cette table : "Straße" → "Stra e" (perd le ss du ß), "Łazienka" →
 * "azienka" (perd le L), "Þórður" → "órur" (perd Þ et ð), etc.
 *
 * Toutes les valeurs sont en LOWERCASE pour coherence — les callers qui
 * ont besoin d'une casse particuliere (ex preserver MAJUSCULE) doivent
 * faire le toUpperCase eux-memes apres.
 */
export const TRANSLIT_MAP: Readonly<Record<string, string>> = {
  // Allemand : sharp s (eszett)
  'ß': 'ss', 'ẞ': 'ss',
  // Ligatures latines
  'œ': 'oe', 'Œ': 'oe', 'æ': 'ae', 'Æ': 'ae',
  'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl',
  'ﬅ': 'st', 'ﬆ': 'st',
  // Scandinave / nordique (ø, å sont aussi NFD-decomposables mais explicite ici)
  'ø': 'o', 'Ø': 'o',
  'å': 'a', 'Å': 'a',
  // Islandais
  'ð': 'd', 'Ð': 'd',
  'þ': 'th', 'Þ': 'th',
  // Polonais
  'ł': 'l', 'Ł': 'l',
  // Turc / centre-europe
  'ı': 'i', 'İ': 'i',
};

/** Applique TRANSLIT_MAP sur chaque char. Idempotent (les valeurs cibles
 *  sont elles-memes ASCII). */
export function transliterate(s: string): string {
  let out = '';
  for (const ch of s) {
    out += TRANSLIT_MAP[ch] ?? ch;
  }
  return out;
}

/** Helper combine : transliterate puis stripAccents. La sequence est
 *  importante (transliterate gere les NON-decomposables que stripAccents
 *  laisserait inchanges). */
export function asciiize(s: string): string {
  return stripAccents(transliterate(s));
}

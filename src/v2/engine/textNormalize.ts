/**
 * Text normalization helpers shared across the pipeline.
 *
 * Centralizes implementations that used to be duplicated in:
 *   - productsAdapter.ts (stripAccents, TRANSLIT_MAP)
 *   - inputs.ts (SECTION_TRANSLIT, partial sub-set)
 *   - classify.ts (stripAccents)
 *   - colorPalette.ts (ß → ss inline in normalizeColorText)
 *
 * Before this consolidation: 4 copies of stripAccents with slightly
 * divergent Unicode regexes, and 2 translit tables inconsistent on ẞ
 * ('ss' vs 'SS'). Now: a single source of truth.
 */

/** Strip NFD diacritics (combining characters such as acute accent,
 *  grave, diaeresis...). Range U+0300..U+036F = "Combining Diacritical Marks".
 *
 *  "Café" → "Cafe", "Mégère" → "Megere", "naïve" → "naive". */
export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Transliterations of NON-NFD-decomposable characters: chars that have no
 * NFD form with a separable diacritic. Must be applied EXPLICITLY before
 * stripAccents to preserve semantic content.
 *
 * Without this table: "Straße" → "Stra e" (loses the ss of ß), "Łazienka" →
 * "azienka" (loses the L), "Þórður" → "órur" (loses Þ and ð), etc.
 *
 * All values are LOWERCASE for consistency — callers that need a specific
 * case (e.g. preserving UPPERCASE) must do the toUpperCase themselves
 * afterwards.
 */
export const TRANSLIT_MAP: Readonly<Record<string, string>> = {
  // German: sharp s (eszett)
  'ß': 'ss', 'ẞ': 'ss',
  // Latin ligatures
  'œ': 'oe', 'Œ': 'oe', 'æ': 'ae', 'Æ': 'ae',
  'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl',
  'ﬅ': 'st', 'ﬆ': 'st',
  // Scandinavian / Nordic (ø, å are also NFD-decomposable but explicit here)
  'ø': 'o', 'Ø': 'o',
  'å': 'a', 'Å': 'a',
  // Icelandic
  'ð': 'd', 'Ð': 'd',
  'þ': 'th', 'Þ': 'th',
  // Polish
  'ł': 'l', 'Ł': 'l',
  // Turkish / Central Europe
  'ı': 'i', 'İ': 'i',
};

/** Applies TRANSLIT_MAP to each char. Idempotent (the target values are
 *  themselves ASCII). */
export function transliterate(s: string): string {
  let out = '';
  for (const ch of s) {
    out += TRANSLIT_MAP[ch] ?? ch;
  }
  return out;
}

/** Combined helper: transliterate then stripAccents. The order matters
 *  (transliterate handles the NON-decomposable chars that stripAccents would
 *  leave unchanged). */
export function asciiize(s: string): string {
  return stripAccents(transliterate(s));
}

/**
 * Generic detection of key/value separators in product specs.
 *
 * Different templates use different separators:
 *   - ":"   (Catalogue A, the majority of catalogs)
 *   - "="   (technical catalogs of the data-sheet kind)
 *   - "|"   (compact column-based catalogs)
 *   - "→"   (design catalogs)
 *   - "·"   (middle dot, elegant catalogs)
 *   - " — " (em-dash surrounded by spaces, editorial catalogs)
 *   - " – " (en-dash surrounded by spaces, typographic variant)
 *
 * Note: dashes are only treated as separators if they are surrounded by
 * spaces on both sides. Without this rule, "Bistro—Casa" (a compound name)
 * would be wrongly detected as key/value.
 *
 * Centralized helper to avoid hardcoding ":" everywhere in the pipeline.
 */

/** "Single char" characters that can separate key and value in a spec span.
 *  These characters are detected wherever they appear (no space rule). */
export const KEY_VALUE_SEPARATORS = [':', '=', '|', '→', '·'] as const;

/** "Compound" characters that are separators ONLY when surrounded by spaces.
 *  Includes em-dash (—, U+2014) and en-dash (–, U+2013). */
export const COMPOUND_SEPARATORS = ['—', '–'] as const;

/** Compiled regex of the single-char separators (escaped for use in a
 *  [..] set). */
export const KEY_VALUE_SEPARATORS_RE = /[:=|→·]/;

/** Compiled regex of the compound separators (dash surrounded by spaces). */
export const COMPOUND_SEPARATORS_RE = /\s[—–]\s/;

/** Regex matching a separator at the end of a string (with optional
 *  whitespace before/after). Matches the patterns "MATIÈRE :", "MATIÈRE=",
 *  "MATIÈRE |", "MATIÈRE —" (with a space before the dash). */
export const TRAILING_KV_SEPARATOR_RE = /[\s\xa0]*(?:[:=|→·]|[—–])[\s\xa0]*$/;

/** True if the text contains at least one key/value separator. Used to
 *  identify spans that are spec keys (vs free text).
 *
 *  Detects:
 *  - Single-char: ":", "=", "|", "→", "·" (anywhere)
 *  - Compound: "—" or "–" ONLY when surrounded by spaces (guards against
 *    false positives on compound names like "Bistro—Casa"). */
export function hasKeyValueSeparator(text: string): boolean {
  if (KEY_VALUE_SEPARATORS_RE.test(text)) return true;
  if (COMPOUND_SEPARATORS_RE.test(text)) return true;
  return false;
}

/** Splits a "key : value" string into { key, value }. If no separator is
 *  detected → { key: text, value: '' }. The separator found is consumed.
 *
 *  Priority: single-char first (more discriminating), then dash spaces. */
export function splitOnKeyValueSeparator(text: string): { key: string; value: string; separator: string | null } {
  // 1. Single-char (priority: explicit characters take precedence over the
  //    dash, which can also be legitimate punctuation).
  const singleMatch = text.match(/^(.*?)([\s\xa0]*[:=|→·][\s\xa0]*)(.*)$/);
  if (singleMatch) {
    return {
      key: singleMatch[1].trim(),
      value: singleMatch[3].trim(),
      separator: singleMatch[2].trim() || null,
    };
  }
  // 2. Dash with mandatory spaces (guards against compound-name false positives).
  const dashMatch = text.match(/^(.*?)\s([—–])\s(.*)$/);
  if (dashMatch) {
    return {
      key: dashMatch[1].trim(),
      value: dashMatch[3].trim(),
      separator: dashMatch[2],
    };
  }
  return { key: text, value: '', separator: null };
}

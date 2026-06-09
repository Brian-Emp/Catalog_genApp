/**
 * styleKeyFromTemplate — applies the typographic style of a template key
 *  (case + trailing separator) to a new key. Used when rendering product
 *  specs to preserve the template conventions.
 *
 *  Consolidated from reflowSpecs.ts and reflowSpecsV2.ts (audit #5), which
 *  had two identical copy-pasted implementations. Now: a single source of
 *  truth.
 */

/** Regex for the key-value suffix: whitespace + separator (": = | → ·") or
 *  whitespace alone at the end of the string. Aligned with keyValueSeparator
 *  for single-char seps (excluding em-dash/en-dash which are compose-seps). */
const SEP_TAIL_RE = /[\s\xa0]*[:=|→·][\s\xa0]*$|[\s\xa0]+$/;

/**
 * Preserves the case and trailing separator of a template key, applies it to
 * a new key.
 *
 *  - "MATIÈRE :" + "longueur" → "LONGUEUR :"  (preserve all-caps + " :")
 *  - "matière =" + "Longueur" → "longueur ="  (preserve all-lower + " =")
 *  - "Matière |" + "longueur" → "longueur |"  (mixed → no case transform)
 *  - "DEBIT"   + "longueur" → "LONGUEUR :"   (fallback sep " :" if absent)
 */
export function styleKeyFromTemplate(newKey: string, tplKeyText: string): string {
  const stripped = tplKeyText.replace(SEP_TAIL_RE, '').trim();
  const sepMatch = tplKeyText.match(SEP_TAIL_RE);
  const sep = sepMatch ? sepMatch[0] : ' :';
  const cleanNew = newKey.trim().replace(SEP_TAIL_RE, '');
  if (stripped.length === 0) return cleanNew + sep;
  const hasUpper = /[A-ZÀ-ſ]/.test(stripped);
  const hasLower = /[a-zà-ſ]/.test(stripped);
  let styled: string;
  if (hasUpper && !hasLower) styled = cleanNew.toUpperCase();
  else if (!hasUpper && hasLower) styled = cleanNew.toLowerCase();
  else styled = cleanNew;
  return styled + sep;
}

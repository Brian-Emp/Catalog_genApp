/**
 * styleKeyFromTemplate — applique le style typographique d'une key template
 *  (casse + séparateur final) à une nouvelle key. Sert au rendu des specs
 *  produit pour préserver les conventions du template.
 *
 *  Consolidé depuis reflowSpecs.ts et reflowSpecsV2.ts (audit #5) qui
 *  avaient deux implémentations identiques copiées-collées. Maintenant :
 *  une seule source de verité.
 */

/** Regex du suffixe key-value : whitespace + separateur (": = | → ·") ou
 *  whitespace seul en fin de string. Aligne avec keyValueSeparator pour
 *  les single-char seps (sans em-dash/en-dash qui sont des compose-seps). */
const SEP_TAIL_RE = /[\s\xa0]*[:=|→·][\s\xa0]*$|[\s\xa0]+$/;

/**
 * Préserve la casse et le séparateur final d'une key template, applique à
 * une nouvelle key.
 *
 *  - "MATIÈRE :" + "longueur" → "LONGUEUR :"  (preserve all-caps + " :")
 *  - "matière =" + "Longueur" → "longueur ="  (preserve all-lower + " =")
 *  - "Matière |" + "longueur" → "longueur |"  (mixte → pas de transform casse)
 *  - "DEBIT"   + "longueur" → "LONGUEUR :"   (fallback sep " :" si absent)
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

/**
 * Détection générique des séparateurs key/value dans les specs produit.
 *
 * Différents templates utilisent différents séparateurs :
 *   - ":"   (Catalogue A, la majorité des catalogues)
 *   - "="   (catalogues techniques type fiches data sheet)
 *   - "|"   (catalogues compacts en colonnes)
 *   - "→"   (catalogues design)
 *   - "·"   (point médian, catalogues élégants)
 *   - " — " (em-dash entoure d'espaces, catalogues editoriaux)
 *   - " – " (en-dash entoure d'espaces, variante typo)
 *
 * Note : les dashes ne sont consideres comme separateurs que s'ils sont
 * entoures d'espaces des deux cotes. Sans cette regle, "Bistro—Casa" (nom
 * compose) serait faussement detecte comme key/value.
 *
 * Helper centralisé pour ne pas hardcoder ":" partout dans le pipeline.
 */

/** Caractères "single char" qui peuvent séparer key et value dans un span de
 *  spec. Ces caracteres sont detectes ou qu'ils soient (pas de regle d'espace). */
export const KEY_VALUE_SEPARATORS = [':', '=', '|', '→', '·'] as const;

/** Caractères "compose" qui ne sont separateurs QUE s'ils sont entoures
 *  d'espaces. Inclut em-dash (—, U+2014) et en-dash (–, U+2013). */
export const COMPOUND_SEPARATORS = ['—', '–'] as const;

/** Regex compilée des séparateurs single-char (échappés pour usage dans un
 *  set [..]). */
export const KEY_VALUE_SEPARATORS_RE = /[:=|→·]/;

/** Regex compilée des séparateurs compose (dash entoure d'espaces). */
export const COMPOUND_SEPARATORS_RE = /\s[—–]\s/;

/** Regex pour matcher un séparateur en fin de string (avec whitespace optional
 *  avant/après). Match les patterns "MATIÈRE :", "MATIÈRE=", "MATIÈRE |",
 *  "MATIÈRE —" (avec espace avant le dash). */
export const TRAILING_KV_SEPARATOR_RE = /[\s\xa0]*(?:[:=|→·]|[—–])[\s\xa0]*$/;

/** True si le texte contient au moins un séparateur key/value. Utilisé pour
 *  identifier les spans qui sont des keys de specs (vs texte libre).
 *
 *  Detecte :
 *  - Single-char : ":", "=", "|", "→", "·" (n'importe ou)
 *  - Compose : "—" ou "–" UNIQUEMENT s'ils sont entoures d'espaces (anti
 *    faux positif sur les noms composes "Bistro—Casa"). */
export function hasKeyValueSeparator(text: string): boolean {
  if (KEY_VALUE_SEPARATORS_RE.test(text)) return true;
  if (COMPOUND_SEPARATORS_RE.test(text)) return true;
  return false;
}

/** Sépare une chaîne "key : value" en { key, value }. Si pas de séparateur
 *  détecté → { key: text, value: '' }. Le séparateur trouvé est consommé.
 *
 *  Priorite : single-char d'abord (plus discriminants), puis dash spaces. */
export function splitOnKeyValueSeparator(text: string): { key: string; value: string; separator: string | null } {
  // 1. Single-char (priorite : les caracteres explicites priment sur le
  //    dash qui peut aussi etre une ponctuation legitime).
  const singleMatch = text.match(/^(.*?)([\s\xa0]*[:=|→·][\s\xa0]*)(.*)$/);
  if (singleMatch) {
    return {
      key: singleMatch[1].trim(),
      value: singleMatch[3].trim(),
      separator: singleMatch[2].trim() || null,
    };
  }
  // 2. Dash avec espaces obligatoires (anti faux positif nom compose).
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

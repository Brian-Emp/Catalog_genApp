/**
 * Palette of common color / finish names in product catalogs.
 *
 * Used by blockDetector as a fallback heuristic to identify the product
 * header "color" span (under the name, next to the ref) when font-pattern
 * detection fails. Multi-language FR/EN/DE/ES/IT/PT.
 *
 * The palette is deliberately broad (covers primary colors + metallics +
 * finishes + neutrals). The match is strict: the entire span text (after
 * trim + normalize) must be in the set; substrings are not accepted
 * (otherwise "Bistro Inox Vintage" would match).
 */

/** Set of normalized color/finish names (lowercase, accent-free). */
export const COMMON_COLORS: ReadonlySet<string> = new Set([
  // ── Neutrals / metallics ─────────────────────────────────────────────
  // FR
  'inox', 'chrome', 'chrome poli', 'chrome brosse', 'chrome mat',
  'noir', 'blanc', 'gris', 'beige', 'creme', 'sable', 'taupe', 'naturel',
  'dore', 'argente', 'cuivre', 'bronze', 'laiton', 'nickel',
  // EN
  'chrome', 'black', 'white', 'grey', 'gray', 'beige', 'cream', 'sand',
  'taupe', 'natural', 'gold', 'silver', 'copper', 'brass', 'nickel',
  // DE (ASCII forms after strip diacritics; ß → ss applied on the
  //      normalize side. The palette stores ONLY the normalized form.)
  'chrom', 'schwarz', 'weiss', 'grau', 'beige', 'creme',
  'gold', 'silber', 'kupfer', 'messing',
  // ES
  'cromo', 'cromado', 'negro', 'blanco', 'gris', 'beige', 'crema',
  'dorado', 'plateado', 'cobre', 'laton', 'niquel',
  // IT
  'cromo', 'cromato', 'nero', 'bianco', 'grigio', 'beige', 'crema',
  'dorato', 'argentato', 'rame', 'ottone', 'nichel',
  // PT
  'cromado', 'preto', 'branco', 'cinza', 'cinzento', 'bege', 'creme',
  'dourado', 'prateado', 'cobre', 'latao',

  // ── Primary + secondary colors ───────────────────────────────────────
  // FR
  'rouge', 'bleu', 'vert', 'jaune', 'rose', 'violet', 'orange', 'marron',
  'bordeaux', 'turquoise', 'fuschia', 'indigo', 'lavande',
  // FR: common compound colors (design / decoration shades)
  'bleu marine', 'bleu nuit', 'bleu ciel', 'bleu canard', 'bleu petrole',
  'rouge bordeaux', 'rouge brique', 'rouge rubis',
  'vert sapin', 'vert olive', 'vert amande', 'vert menthe', 'vert pomme',
  'gris anthracite', 'gris perle', 'gris souris', 'gris ardoise',
  'rose poudre', 'rose pale', 'jaune moutarde', 'jaune paille',
  'beige sable', 'noir mat', 'noir profond',
  // EN: common compound colors
  'navy blue', 'sky blue', 'royal blue', 'midnight blue',
  'forest green', 'olive green', 'mint green', 'apple green',
  'pearl grey', 'charcoal grey', 'slate grey',
  'powder pink', 'mustard yellow', 'matte black',
  // EN
  'red', 'blue', 'green', 'yellow', 'pink', 'purple', 'brown',
  'burgundy', 'turquoise', 'fuchsia', 'lavender',
  // DE (ASCII forms: "gruen" and "grun" both accepted to tolerate
  //      translit ü → ue vs strip diacritic ü → u)
  'rot', 'blau', 'gruen', 'grun', 'gelb', 'rosa', 'lila', 'braun',
  // ES
  'rojo', 'azul', 'verde', 'amarillo', 'rosa', 'morado', 'marron',
  // IT
  'rosso', 'blu', 'verde', 'giallo', 'rosa', 'viola', 'marrone',
  // PT
  'vermelho', 'azul', 'verde', 'amarelo', 'rosa', 'roxo', 'castanho',

  // ── Finishes ─────────────────────────────────────────────────────────
  // FR
  'mat', 'mate', 'brillant', 'satine', 'poli', 'brosse', 'martele', 'patine',
  'vieilli', 'antique', 'laque', 'vernis', 'anodise', 'galvanise',
  'sable', 'depoli', 'translucide', 'transparent', 'metallise',
  // EN
  'matt', 'matte', 'glossy', 'satin', 'polished', 'brushed', 'hammered',
  'antique', 'vintage', 'lacquered', 'varnished', 'anodized', 'galvanized',
  'sandblasted', 'frosted', 'translucent', 'transparent', 'plated',
  'powder coat', 'distressed',
  // DE
  'matt', 'glanz', 'glanzend', 'satiniert', 'poliert', 'gebuerstet',
  'lackiert', 'eloxiert', 'verzinkt', 'mattiert',
  // ES
  'mate', 'brillante', 'satinado', 'pulido', 'cepillado',
  'lacado', 'anodizado', 'galvanizado', 'esmerilado',
  // IT
  'opaco', 'lucido', 'satinato', 'pulito', 'spazzolato',
  'laccato', 'anodizzato', 'zincato', 'smerigliato',
]);

import { asciiize } from './textNormalize';

/** Normalizes a string for comparison against COMMON_COLORS:
 *  trim + lowercase + transliterate (ß → ss, ø → o, etc.) + strip accents.
 *  Uses the shared asciiize for consistency with inputs.normalizeSection. */
function normalizeColorText(text: string): string {
  return asciiize(text.trim().toLowerCase());
}

/** Technical color codes used in professional catalogs:
 *   - RAL: "RAL 9005", "RAL9005", "RAL-9005" (4 digits + optional letter suffix)
 *   - Pantone: "Pantone 405", "Pantone 405 C", "PMS 405"
 *   - NCS: "NCS S 1000-N", "NCS 1000-N"
 *   - HEX: "#FFF", "#FFFFFF", "#FFFFFF80" (with alpha)
 *   - RGB: "rgb(255, 0, 0)" / "rgba(...)"
 *   - HSL: "hsl(...)"
 *
 *  Used by isCommonColor as a complement to the nominal palette. */
const COLOR_CODE_PATTERNS: RegExp[] = [
  /^ral\s*[-_]?\s*\d{4}[a-z]?$/i,
  /^pantone\s+\d+[a-z]?(?:\s+[cu])?$/i,
  /^pms\s+\d+[a-z]?$/i,
  /^ncs\s+s?\s*\d{4}[-\s]?[a-z]\d*$/i,
  /^#[0-9a-f]{3}$/i,
  /^#[0-9a-f]{6}$/i,
  /^#[0-9a-f]{8}$/i,
  /^rgba?\s*\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[\d.]+)?\s*\)$/i,
  /^hsla?\s*\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*[\d.]+)?\s*\)$/i,
];

/** True if the text matches a technical color code (RAL / Pantone / NCS /
 *  HEX / RGB / HSL). Strict: matches the whole string after trim. */
export function isColorCode(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  return COLOR_CODE_PATTERNS.some((re) => re.test(t));
}

/** True if the text is a palette color name OR a technical color code. Used
 *  by blockDetector as a robust fallback to identify the product header
 *  color span. */
export function isCommonColor(text: string): boolean {
  if (!text) return false;
  if (COMMON_COLORS.has(normalizeColorText(text))) return true;
  if (isColorCode(text)) return true;
  return false;
}

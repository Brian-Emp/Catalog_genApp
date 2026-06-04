/**
 * Palette de noms de couleurs / finitions courantes en catalogue produit.
 *
 * Sert au blockDetector comme heuristique de fallback pour identifier le
 * span "color" du header produit (sous le nom, a cote de la ref) quand
 * la detection par font pattern echoue. Multi-langue FR/EN/DE/ES/IT/PT.
 *
 * La palette est volontairement large (couvre couleurs primaires +
 * metalliques + finitions + neutres). Le match est strict : le texte
 * du span entier (apres trim + normalize) doit etre dans le set ; on
 * accepte pas les sous-chaines (sinon "Bistro Inox Vintage" matcherait).
 */

/** Set des noms de couleurs/finitions normalises (lowercase, sans accents). */
export const COMMON_COLORS: ReadonlySet<string> = new Set([
  // ── Neutres / metalliques ────────────────────────────────────────────
  // FR
  'inox', 'chrome', 'chrome poli', 'chrome brosse', 'chrome mat',
  'noir', 'blanc', 'gris', 'beige', 'creme', 'sable', 'taupe', 'naturel',
  'dore', 'argente', 'cuivre', 'bronze', 'laiton', 'nickel',
  // EN
  'chrome', 'black', 'white', 'grey', 'gray', 'beige', 'cream', 'sand',
  'taupe', 'natural', 'gold', 'silver', 'copper', 'brass', 'nickel',
  // DE (formes ASCII apres strip diacritics ; ß → ss applique cote
  //      normalize. La palette ne stocke QUE la forme normalisee.)
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

  // ── Couleurs primaires + secondaires ─────────────────────────────────
  // FR
  'rouge', 'bleu', 'vert', 'jaune', 'rose', 'violet', 'orange', 'marron',
  'bordeaux', 'turquoise', 'fuschia', 'indigo', 'lavande',
  // FR : couleurs composees courantes (nuances design / decoration)
  'bleu marine', 'bleu nuit', 'bleu ciel', 'bleu canard', 'bleu petrole',
  'rouge bordeaux', 'rouge brique', 'rouge rubis',
  'vert sapin', 'vert olive', 'vert amande', 'vert menthe', 'vert pomme',
  'gris anthracite', 'gris perle', 'gris souris', 'gris ardoise',
  'rose poudre', 'rose pale', 'jaune moutarde', 'jaune paille',
  'beige sable', 'noir mat', 'noir profond',
  // EN : couleurs composees courantes
  'navy blue', 'sky blue', 'royal blue', 'midnight blue',
  'forest green', 'olive green', 'mint green', 'apple green',
  'pearl grey', 'charcoal grey', 'slate grey',
  'powder pink', 'mustard yellow', 'matte black',
  // EN
  'red', 'blue', 'green', 'yellow', 'pink', 'purple', 'brown',
  'burgundy', 'turquoise', 'fuchsia', 'lavender',
  // DE (formes ASCII : "gruen" et "grun" tous deux acceptes pour
  //      tolerer translit ü → ue vs strip diacritic ü → u)
  'rot', 'blau', 'gruen', 'grun', 'gelb', 'rosa', 'lila', 'braun',
  // ES
  'rojo', 'azul', 'verde', 'amarillo', 'rosa', 'morado', 'marron',
  // IT
  'rosso', 'blu', 'verde', 'giallo', 'rosa', 'viola', 'marrone',
  // PT
  'vermelho', 'azul', 'verde', 'amarelo', 'rosa', 'roxo', 'castanho',

  // ── Finitions ────────────────────────────────────────────────────────
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

/** Normalise une chaine pour comparaison avec COMMON_COLORS :
 *  trim + lowercase + transliterate (ß → ss, ø → o, etc.) + strip accents.
 *  Utilise asciiize partage pour coherence avec inputs.normalizeSection. */
function normalizeColorText(text: string): string {
  return asciiize(text.trim().toLowerCase());
}

/** Codes couleurs techniques utilises en catalogue pro :
 *   - RAL : "RAL 9005", "RAL9005", "RAL-9005" (4 chiffres + suffix lettre optional)
 *   - Pantone : "Pantone 405", "Pantone 405 C", "PMS 405"
 *   - NCS : "NCS S 1000-N", "NCS 1000-N"
 *   - HEX : "#FFF", "#FFFFFF", "#FFFFFF80" (avec alpha)
 *   - RGB : "rgb(255, 0, 0)" / "rgba(...)"
 *   - HSL : "hsl(...)"
 *
 *  Sert au isCommonColor en complement de la palette nominale. */
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

/** True si le texte correspond a un code couleur technique (RAL / Pantone /
 *  NCS / HEX / RGB / HSL). Strict : match la chaine entiere apres trim. */
export function isColorCode(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  return COLOR_CODE_PATTERNS.some((re) => re.test(t));
}

/** True si le texte est un nom de couleur de la palette OU un code couleur
 *  technique. Sert au blockDetector comme fallback robuste pour identifier
 *  le span color du header produit. */
export function isCommonColor(text: string): boolean {
  if (!text) return false;
  if (COMMON_COLORS.has(normalizeColorText(text))) return true;
  if (isColorCode(text)) return true;
  return false;
}

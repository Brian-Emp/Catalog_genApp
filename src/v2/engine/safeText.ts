/**
 * Translation de glyphes unicode "exotiques" -> ASCII proche, pour eviter
 * les `.notdef` sur les fonts a couverture limitee (Helvetica WinAnsi, fonts
 * embeddees subsets sans Cyrillic, etc.).
 *
 * Porte de `python/substitute.py:_GLYPH_FALLBACKS` (V1).
 */

const GLYPH_FALLBACKS: Record<string, string> = {
  // Apostrophes / quotes courbes
  '’': "'", '‘': "'", '‚': ',', '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '«': '"', '»': '"', '‹': "'", '›': "'",
  // Modifier letter apostrophes (parfois utilisees en transliteration)
  'ʼ': "'", 'ʹ': "'", 'ʻ': "'", 'ˈ': "'",
  // Primes (notation imperiale : pieds/pouces, minutes/secondes d'arc)
  '′': "'", '″': '"', '‴': "'''",
  // Tirets cadratin / demi-cadratin
  '–': '-', '—': '-', '‒': '-', '―': '-', '−': '-',
  // Hyphens speciaux (souvent absents des subsets, casse les mots composes)
  '‐': '-', '‑': '-', '­': '-',
  // Espaces speciaux (NBSP, narrow NBSP, em-space, etc.)
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  '​': '', ' ': ' ', '﻿': '',
  // Ellipses & puces
  '…': '...', '‧': '.', '·': '.',
  '•': '-', '◦': '-', '▪': '-', '▫': '-',
  '∙': '.', '⋅': '.', '∗': '*',
  '※': '*', '⁂': '*', '⁕': '*',
  // Fleches
  '→': '->', '←': '<-', '↑': '^', '↓': 'v',
  '↔': '<->', '↕': '^v',
  '⇒': '=>', '⇐': '<=', '⇑': '^^', '⇓': 'vv',
  '⇔': '<=>', '⇕': '^^vv',
  // Exposants/indices courants
  '²': '2', '³': '3', '¹': '1', '⁰': '0',
  '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  // Fractions
  '¼': '1/4', '½': '1/2', '¾': '3/4',
  '⅓': '1/3', '⅔': '2/3',
  '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5',
  '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
  // Math
  '×': 'x', '÷': '/', '±': '+/-',
  '≤': '<=', '≥': '>=', '≠': '!=',
  '≈': '~', '≃': '~', '≅': '~',
  '∞': 'inf', '√': 'sqrt', '∑': 'sum', '∆': 'delta', 'π': 'pi',
  '∂': 'd', '∇': 'nabla',
  // Diametre (plomberie / sanitaire : "⌀ 32mm")
  '⌀': 'diam ', '∅': 'diam ',
  // Monnaies
  '€': 'EUR', '£': 'GBP', '¥': 'YEN', '¢': 'c',
  '₩': 'KRW', '₹': 'INR', '₪': 'ILS', '฿': 'THB',
  '₣': 'CHF', '₤': 'GBP', '₿': 'BTC',
  // Symboles legaux
  '©': '(c)', '®': '(r)', '™': 'TM', '℠': 'SM',
  // Typographie
  '§': 'S', '¶': 'P', '†': '+', '‡': '++',
  '№': 'No', '℮': 'e',
  '‱': 'pm10k', '‰': 'pm',
  // Ligatures latines
  'œ': 'oe', 'Œ': 'OE', 'æ': 'ae', 'Æ': 'AE',
  // Ligatures fi / fl / ff (souvent absentes des subsets)
  'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff',
  'ﬃ': 'ffi', 'ﬄ': 'ffl',
  'ﬅ': 'st', 'ﬆ': 'st',
};

/**
 * Remplace les glyphes exotiques par leur equivalent ASCII proche. Garde
 * les caracteres accentues francais (é, à, ô...) tels quels — ils sont
 * couverts par la majorite des fonts WinAnsi/MacRoman.
 *
 * Si une font n'a pas un caractere demande, le rendu PDF affiche un
 * rectangle vide ou le glyph .notdef. safeText elimine les cas les plus
 * frequents (typographie InDesign, smart quotes, ligatures).
 */
export function safeText(text: string): string {
  if (!text) return text;
  let out = '';
  for (const ch of text) {
    out += GLYPH_FALLBACKS[ch] ?? ch;
  }
  return out;
}

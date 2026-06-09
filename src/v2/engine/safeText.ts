/**
 * Translation of "exotic" unicode glyphs -> nearest ASCII, to avoid
 * `.notdef` on fonts with limited coverage (Helvetica WinAnsi, embedded
 * subsets without Cyrillic, etc.).
 *
 * Ported from `python/substitute.py:_GLYPH_FALLBACKS` (V1).
 */

const GLYPH_FALLBACKS: Record<string, string> = {
  // Curly apostrophes / quotes
  '’': "'", '‘': "'", '‚': ',', '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '«': '"', '»': '"', '‹': "'", '›': "'",
  // Modifier letter apostrophes (sometimes used in transliteration)
  'ʼ': "'", 'ʹ': "'", 'ʻ': "'", 'ˈ': "'",
  // Primes (imperial notation: feet/inches, arcminutes/arcseconds)
  '′': "'", '″': '"', '‴': "'''",
  // Em / en dashes
  '–': '-', '—': '-', '‒': '-', '―': '-', '−': '-',
  // Special hyphens (often missing from subsets, breaks compound words)
  '‐': '-', '‑': '-', '­': '-',
  // Special spaces (NBSP, narrow NBSP, em-space, etc.)
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  '​': '', ' ': ' ', '﻿': '',
  // Ellipses & bullets
  '…': '...', '‧': '.', '·': '.',
  '•': '-', '◦': '-', '▪': '-', '▫': '-',
  '∙': '.', '⋅': '.', '∗': '*',
  '※': '*', '⁂': '*', '⁕': '*',
  // Arrows
  '→': '->', '←': '<-', '↑': '^', '↓': 'v',
  '↔': '<->', '↕': '^v',
  '⇒': '=>', '⇐': '<=', '⇑': '^^', '⇓': 'vv',
  '⇔': '<=>', '⇕': '^^vv',
  // Common superscripts/subscripts
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
  // Diameter (plumbing / sanitary: "⌀ 32mm")
  '⌀': 'diam ', '∅': 'diam ',
  // Currencies
  '€': 'EUR', '£': 'GBP', '¥': 'YEN', '¢': 'c',
  '₩': 'KRW', '₹': 'INR', '₪': 'ILS', '฿': 'THB',
  '₣': 'CHF', '₤': 'GBP', '₿': 'BTC',
  // Legal symbols
  '©': '(c)', '®': '(r)', '™': 'TM', '℠': 'SM',
  // Typography
  '§': 'S', '¶': 'P', '†': '+', '‡': '++',
  '№': 'No', '℮': 'e',
  '‱': 'pm10k', '‰': 'pm',
  // Latin ligatures
  'œ': 'oe', 'Œ': 'OE', 'æ': 'ae', 'Æ': 'AE',
  // fi / fl / ff ligatures (often missing from subsets)
  'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff',
  'ﬃ': 'ffi', 'ﬄ': 'ffl',
  'ﬅ': 'st', 'ﬆ': 'st',
};

/**
 * Replaces exotic glyphs with their nearest ASCII equivalent. Keeps French
 * accented characters (é, à, ô...) as-is — they are covered by most
 * WinAnsi/MacRoman fonts.
 *
 * If a font lacks a requested character, the PDF render shows an empty
 * rectangle or the .notdef glyph. safeText eliminates the most frequent
 * cases (InDesign typography, smart quotes, ligatures).
 */
export function safeText(text: string): string {
  if (!text) return text;
  let out = '';
  for (const ch of text) {
    out += GLYPH_FALLBACKS[ch] ?? ch;
  }
  return out;
}

/**
 * normalizeValue — cleans up/standardizes a spec value before rendering.
 *
 * Design rule: we ONLY apply safe and reversible transformations (missing
 * space between digit and unit, standardized case for symbols). No semantic
 * interpretation. When in doubt → identity.
 *
 * Examples:
 *   "70cm"      → "70 cm"
 *   "Ø22mm"     → "Ø 22 mm"
 *   "1 a 5bar"  → "1 à 5 bar"  (a → à between digits)
 *   "10ANS"     → "10 ans"     (unit ANNEES → ans in lowercase)
 *   "  Inox  "  → "Inox"       (trim)
 *
 * Cases NOT transformed (deliberately):
 *   "Coulissant et inclinable" (free text, we leave it alone)
 *   "Inox + ABS"               (spacing OK)
 *   "Ø 22 mm"                  (already clean)
 */

type StringReplace = (...args: string[]) => string;

/** Common units + their normalized form. Strict match to avoid false
 *  positives ("cm" mid-word as in "incremental"). Covers:
 *   - SI: mm, cm, m, km, l, ml, kg, g, t, °C, bar, V, A, W, h, min, s
 *   - Imperial: in, ft, yd, lb, oz, °F, gal, psi
 *   - Time: ans, annees, mois, jours
 *   - Symbols: Ø, " (inch), ' (foot) */
const UNIT_RULES: { pattern: RegExp; replace: string | StringReplace }[] = [
  // SQUARED/CUBED units (area, volume): must come BEFORE the generic rule
  // to match m²/m³ before m\b. Otherwise "5m²" → "5 m²" but the ² would
  // stay glued to the m → match "m\b" fails, yet the space is already there.
  // e.g.: "5m²" → "5 m²", "12cm³" → "12 cm³", "100km²" → "100 km²",
  //      "100ft²" → "100 ft²", "5in³" → "5 in³"
  //
  // Flag `u`: enables strict Unicode mode. Ensures ²/³ are handled as code
  // points (not code units) and that the regex is valid in an ECMAScript
  // 2018+ context. Consistent with valueFormatter.UNIT_RE.
  { pattern: /(\d)(mm|cm|dm|km|m|in|ft|yd)([²³])/gu, replace: '$1 $2$3' },

  // Insert missing space between digit and unit (the most frequent case)
  // e.g.: "70cm" → "70 cm", "Ø22mm" → "Ø 22 mm", "5lb" → "5 lb", "85°F" → "85 °F"
  // Flag `u`: for Unicode chars (Ø, °, "/').
  { pattern: /(\d)(cm|mm|km|m\b|ml|l\b|L\b|cl|dl|kg|mg|g\b|t\b|bar|psi|°C|°F|°|h\b|min\b|s\b|w\b|W\b|kW|MW|V\b|A\b|kA|mA|Hz|kHz|MHz|GHz|dB|dBA?|Nm|N\b|lm|lux|ans?|annee?s?|année?s?|mois|jours?|inch|in\b|ft\b|yd\b|lb\b|oz\b|gal\b|"|')/giu,
    replace: '$1 $2' },

  // Case normalization: uppercase → lowercase when preceded by a digit
  // (unit context confirmed). Covers SI + imperial.
  // Note: MHZ/GHZ/HZ/KHZ and DB/DBA keep their mixed case (uppercase M)
  // via explicit re-mapping below. Here we only lowercase the "pure caps".
  // Flag `u`: for ANNÉES (E with acute accent).
  { pattern: /(\d\s+)(CM|MM|KM|ML|L|CL|DL|KG|MG|G|T|BAR|PSI|H|MIN|S|W|KW|V|A|KA|MA|ANS?|ANNEES?|ANNÉES?|MOIS|JOURS?|INCH|IN|FT|YD|LB|OZ|GAL)\b/gu,
    replace: ((_: string, num: string, unit: string) => num + unit.toLowerCase()) as StringReplace },

  // "Preferred mixed" case: Hz, kHz, MHz, GHz, dB, dBA, kW, mW, Nm, MPa
  // If we have a pure uppercase form (HZ, KHZ, MHZ, GHZ, DB, DBA, KW, MW, NM),
  // we remap it to the canonical case expected by the rendering.
  { pattern: /(\d\s+)(HZ|KHZ|MHZ|GHZ|DBA?|MW)\b/g,
    replace: ((_: string, num: string, unit: string) => {
      const map: Record<string, string> = {
        HZ: 'Hz', KHZ: 'kHz', MHZ: 'MHz', GHZ: 'GHz',
        DB: 'dB', DBA: 'dBA',
        MW: 'mW',
      };
      return num + (map[unit] ?? unit);
    }) as StringReplace },

  // "à" variant without accent between two numbers: "1 a 5 bar" → "1 à 5 bar"
  { pattern: /(\d)\s+a\s+(\d)/g, replace: '$1 à $2' },

  // Diameter symbol: "Ø22" → "Ø 22" (space after Ø when followed by a digit).
  // Flag `u`: Ø is a Unicode char (Ø).
  { pattern: /Ø(\d)/gu, replace: 'Ø $1' },

  // Composite dimensions: "60x80" → "60 x 80", "60X80" → "60 X 80",
  // "60×80" → "60 × 80", "60x40x30" → "60 x 40 x 30" (LxWxH). Applied to
  // triplets via the global flag; idempotence is guaranteed because adding
  // spaces means the digits are no longer glued together.
  { pattern: /(\d)\s*([xX×])\s*(\d)/g, replace: '$1 $2 $3' },

  // Range with dash + metric unit: "10-20cm" → "10-20 cm",
  // "5-10kg" → "5-10 kg". Covers the SI units missing from the initial
  // pattern (which requires a digit glued to the unit without a dash).
  // Flag `u`: for °C / °F / ° (Unicode chars).
  { pattern: /(\d-\d+)(cm|mm|m\b|km|kg|mg|g\b|t\b|ml|cl|dl|l\b|L\b|bar|psi|°C|°F|°|Hz|kHz|MHz|GHz|W\b|kW|V\b|A\b|dB|Nm|lm|lux|ans?|mois|jours?)\b/giu,
    replace: '$1 $2' },

  // Imperial range with dash: "3-5lb" → "3-5 lb" (space before unit, dash kept)
  { pattern: /(\d-\d+)(in|ft|yd|lb|oz|gal|psi)\b/gi,
    replace: '$1 $2' },
];

/** Strict pattern for scientific notation: number + e/E + exponent.
 *  Matches THE ENTIRE STRING to avoid touching alphanumeric refs
 *  ("AB1E2" is NOT a scientific number). */
const SCIENTIFIC_NOTATION_RE = /^-?\d+(?:\.\d+)?[eE][+-]?\d+$/;

/** Converts scientific notation into a readable decimal number.
 *  "1.23E+05" → "123000", "5E-3" → "0.005", "2.5e10" → "25000000000".
 *  For values outside the Number.isFinite range (overflow), returns as-is. */
function expandScientificNotation(s: string): string {
  if (!SCIENTIFIC_NOTATION_RE.test(s)) return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  // For integer values: return the raw string (no ".0")
  if (Number.isInteger(n)) return String(n);
  // For decimal values: cap precision at 12 chars max to avoid floating-
  // point artifacts (1.1e-5 → "0.000011" not "0.0000110000000...")
  return parseFloat(n.toPrecision(12)).toString();
}

/** Normalizes a value (string only). Idempotent (applying twice = same result). */
export function normalizeValue(raw: string): string {
  if (!raw) return raw;
  let v = raw.trim();
  // Scientific notation: convert BEFORE the unit rules so "1.5E+02 cm"
  // becomes "150 cm" and passes the normal unit matching.
  // We split on whitespace, expand each sci-notation token, then rejoin.
  v = v
    .split(/(\s+)/)
    .map((tok) => (SCIENTIFIC_NOTATION_RE.test(tok) ? expandScientificNotation(tok) : tok))
    .join('');
  for (const rule of UNIT_RULES) {
    if (typeof rule.replace === 'string') {
      v = v.replace(rule.pattern, rule.replace);
    } else {
      v = v.replace(rule.pattern, rule.replace);
    }
  }
  // Collapse multiple spaces → 1 space
  v = v.replace(/\s{2,}/g, ' ');
  return v;
}

/** Applies normalizeValue to each value of a spec. */
export function normalizeSpecValues(values: string[]): string[] {
  return values.map((v) => normalizeValue(v));
}

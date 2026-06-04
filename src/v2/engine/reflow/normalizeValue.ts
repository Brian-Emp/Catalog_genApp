/**
 * normalizeValue — nettoie/standardise une value de spec avant rendering.
 *
 * Regle de conception : on n'applique QUE des transformations sures et
 * reversibles (espace manquant entre chiffre et unite, casse standardisee
 * pour symboles). Aucune interpretation semantique. Si un doute → identity.
 *
 * Exemples :
 *   "70cm"      → "70 cm"
 *   "Ø22mm"     → "Ø 22 mm"
 *   "1 a 5bar"  → "1 à 5 bar"  (a → à entre chiffres)
 *   "10ANS"     → "10 ans"     (unite ANNEES → ans en minuscule)
 *   "  Inox  "  → "Inox"       (trim)
 *
 * Cas NON transformes (volontairement) :
 *   "Coulissant et inclinable" (texte libre, on ne touche pas)
 *   "Inox + ABS"               (espacement OK)
 *   "Ø 22 mm"                  (deja propre)
 */

type StringReplace = (...args: string[]) => string;

/** Unites usuelles + leur forme normalisee. Match strict pour eviter les
 *  faux positifs ("cm" en milieu de mot type "incremental"). Couvre :
 *   - SI : mm, cm, m, km, l, ml, kg, g, t, °C, bar, V, A, W, h, min, s
 *   - Imperial : in, ft, yd, lb, oz, °F, gal, psi
 *   - Temps : ans, annees, mois, jours
 *   - Symboles : Ø, " (inch), ' (foot) */
const UNIT_RULES: { pattern: RegExp; replace: string | StringReplace }[] = [
  // Unites au CARRE/CUBE (surface, volume) : doivent venir AVANT la regle
  // generique pour matcher m²/m³ avant m\b. Sinon "5m²" → "5 m²" puis le
  // ² resterait colle au m → match "m\b" echoue mais on a deja l'espace.
  // ex : "5m²" → "5 m²", "12cm³" → "12 cm³", "100km²" → "100 km²",
  //      "100ft²" → "100 ft²", "5in³" → "5 in³"
  //
  // Flag `u` : active le mode Unicode strict. Garantit que ²/³ sont traites
  // comme code points (pas code units) et que le regex est valide en
  // contexte ECMAScript 2018+. Coherent avec valueFormatter.UNIT_RE.
  { pattern: /(\d)(mm|cm|dm|km|m|in|ft|yd)([²³])/gu, replace: '$1 $2$3' },

  // Insertion d'espace manquant entre chiffre et unite (cas le plus frequent)
  // ex: "70cm" → "70 cm", "Ø22mm" → "Ø 22 mm", "5lb" → "5 lb", "85°F" → "85 °F"
  // Flag `u` : pour chars Unicode (Ø, °, "/').
  { pattern: /(\d)(cm|mm|km|m\b|ml|l\b|L\b|cl|dl|kg|mg|g\b|t\b|bar|psi|°C|°F|°|h\b|min\b|s\b|w\b|W\b|kW|MW|V\b|A\b|kA|mA|Hz|kHz|MHz|GHz|dB|dBA?|Nm|N\b|lm|lux|ans?|annee?s?|année?s?|mois|jours?|inch|in\b|ft\b|yd\b|lb\b|oz\b|gal\b|"|')/giu,
    replace: '$1 $2' },

  // Normalisation casse : majuscules → minuscules quand precedees d'un chiffre
  // (contexte unite confirme). Couvre SI + imperial.
  // Note : MHZ/GHZ/HZ/KHZ et DB/DBA gardent leur casse mixte (M majuscule)
  // via re-mappage explicite plus bas. Ici on lowercase juste les "purs maj".
  // Flag `u` : pour ANNÉES (E avec accent aigu).
  { pattern: /(\d\s+)(CM|MM|KM|ML|L|CL|DL|KG|MG|G|T|BAR|PSI|H|MIN|S|W|KW|V|A|KA|MA|ANS?|ANNEES?|ANNÉES?|MOIS|JOURS?|INCH|IN|FT|YD|LB|OZ|GAL)\b/gu,
    replace: ((_: string, num: string, unit: string) => num + unit.toLowerCase()) as StringReplace },

  // Casse "mixte preferee" : Hz, kHz, MHz, GHz, dB, dBA, kW, mW, Nm, MPa
  // Si on a une majuscule pure (HZ, KHZ, MHZ, GHZ, DB, DBA, KW, MW, NM),
  // on remappe a la casse canonique attendue par le rendu.
  { pattern: /(\d\s+)(HZ|KHZ|MHZ|GHZ|DBA?|MW)\b/g,
    replace: ((_: string, num: string, unit: string) => {
      const map: Record<string, string> = {
        HZ: 'Hz', KHZ: 'kHz', MHZ: 'MHz', GHZ: 'GHz',
        DB: 'dB', DBA: 'dBA',
        MW: 'mW',
      };
      return num + (map[unit] ?? unit);
    }) as StringReplace },

  // Variante "à" sans accent entre deux nombres : "1 a 5 bar" → "1 à 5 bar"
  { pattern: /(\d)\s+a\s+(\d)/g, replace: '$1 à $2' },

  // Symbole diametre : "Ø22" → "Ø 22" (espace apres Ø si suivi de chiffre).
  // Flag `u` : Ø est un char Unicode (Ø).
  { pattern: /Ø(\d)/gu, replace: 'Ø $1' },

  // Dimensions composites : "60x80" → "60 x 80", "60X80" → "60 X 80",
  // "60×80" → "60 × 80", "60x40x30" → "60 x 40 x 30" (LxlxH). Applique sur
  // les triplets via global flag ; l'idempotence est assuree car l'ajout
  // d'espaces fait que les chiffres ne sont plus colles.
  { pattern: /(\d)\s*([xX×])\s*(\d)/g, replace: '$1 $2 $3' },

  // Plage avec dash + unite metrique : "10-20cm" → "10-20 cm",
  // "5-10kg" → "5-10 kg". Couvre les unites SI manquantes au pattern
  // initial (qui exige chiffre colle a l'unite sans dash).
  // Flag `u` : pour °C / °F / ° (chars Unicode).
  { pattern: /(\d-\d+)(cm|mm|m\b|km|kg|mg|g\b|t\b|ml|cl|dl|l\b|L\b|bar|psi|°C|°F|°|Hz|kHz|MHz|GHz|W\b|kW|V\b|A\b|dB|Nm|lm|lux|ans?|mois|jours?)\b/giu,
    replace: '$1 $2' },

  // Plage imperial avec dash : "3-5lb" → "3-5 lb" (espace avant unite, dash gardé)
  { pattern: /(\d-\d+)(in|ft|yd|lb|oz|gal|psi)\b/gi,
    replace: '$1 $2' },
];

/** Pattern strict pour la notation scientifique : nombre + e/E + exposant.
 *  Match LA CHAINE ENTIERE pour eviter de toucher les refs alphanumeriques
 *  ("AB1E2" n'est PAS un nombre scientifique). */
const SCIENTIFIC_NOTATION_RE = /^-?\d+(?:\.\d+)?[eE][+-]?\d+$/;

/** Convertit une notation scientifique en nombre decimal lisible.
 *  "1.23E+05" → "123000", "5E-3" → "0.005", "2.5e10" → "25000000000".
 *  Pour valeurs hors plage Number.isFinite (overflow), retourne tel quel. */
function expandScientificNotation(s: string): string {
  if (!SCIENTIFIC_NOTATION_RE.test(s)) return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  // Pour valeurs entieres : retourne string brute (pas de ".0")
  if (Number.isInteger(n)) return String(n);
  // Pour valeurs decimales : limit precision a 12 chars max pour eviter
  // les artefacts flottants (1.1e-5 → "0.000011" pas "0.0000110000000...")
  return parseFloat(n.toPrecision(12)).toString();
}

/** Normalise une value (string seule). Idempotent (appliquer 2x = pareil). */
export function normalizeValue(raw: string): string {
  if (!raw) return raw;
  let v = raw.trim();
  // Notation scientifique : convertir AVANT les regles unite pour que
  // "1.5E+02 cm" devienne "150 cm" et passe le matching unit normal.
  // On split sur whitespace, expand chaque token sci-notation, puis rejoin.
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
  // Reduit espaces multiples → 1 espace
  v = v.replace(/\s{2,}/g, ' ');
  return v;
}

/** Applique normalizeValue a chaque value d'un spec. */
export function normalizeSpecValues(values: string[]): string[] {
  return values.map((v) => normalizeValue(v));
}

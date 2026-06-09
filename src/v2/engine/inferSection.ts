/**
 * inferProductSection — infers a product's section from its NAME by
 * comparing it against the candidate sections detected in the template
 * (section banners).
 *
 * Use case: a simple XLSX with no family/section column. The pipeline needs
 * a section to group products and feed the allocator. We infer from:
 *   1. Product name tokens (material, type, function)
 *   2. Tokens of the template's candidate sections
 *
 * Match: token Jaccard >= MIN_OVERLAP_RATIO. Returns the candidate with the
 * best score, or '' if nothing matches.
 */

import { normalizeSection } from './inputs';

/** Multi-language stop-words to ignore in matching (overly generic words). */
const STOPWORDS = new Set([
  // FR
  'de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et', 'ou',
  'pour', 'avec', 'sans', 'a', 'à', 'en', 'sur', 'sous', 'par', 'au', 'aux',
  // EN
  'the', 'of', 'and', 'or', 'for', 'with', 'in', 'on', 'at', 'by', 'to', 'from',
  // DE
  'der', 'die', 'das', 'den', 'dem', 'des', 'und', 'oder', 'mit', 'ohne',
  'für', 'fur', 'aus', 'bei', 'auf', 'von', 'zu',
  // IT
  'di', 'del', 'della', 'dei', 'delle', 'il', 'lo', 'gli', 'una', 'uno',
  'con', 'senza', 'per', 'su', 'tra', 'fra',
  // ES
  'el', 'los', 'las', 'unos', 'unas', 'y', 'o',
  'con', 'sin', 'para', 'por', 'al',
  // PT
  'do', 'da', 'dos', 'das', 'um', 'uma', 'os', 'as',
  'pelo', 'pela', 'sem', 'para', 'por', 'sobre',
  // NL (Dutch)
  'het', 'een', 'en', 'of', 'met', 'zonder', 'voor', 'naar',
  'van', 'tot', 'aan', 'bij', 'over', 'onder',
  // SE (Swedish)
  'den', 'det', 'ett', 'och', 'eller', 'med', 'utan', 'för', 'fran',
  // NO/DK
  'ei', 'og', 'eller', 'uten', 'pa', 'av',
  // PL (Polish)
  'oraz', 'lub', 'bez', 'dla', 'na', 'do', 'od', 'przez',
]);
/** Minimum Jaccard score (intersection / min(set sizes)) to validate. */
const MIN_OVERLAP_RATIO = 0.25;
/** Minimum token length (avoids "Le", "à", "x"). */
const MIN_TOKEN_LEN = 3;

/** Splits + cleans a text into normalized tokens without stop-words. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return normalizeSection(text)
    .split(' ')
    .filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t));
}

/** Match score between 2 token sets: ratio intersection/min(set sizes).
 *  Accepts prefix matches (singular/plural: "lavabo" ~ "lavabos"). */
function jaccardOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = Array.from(new Set(a));
  const setB = Array.from(new Set(b));
  let inter = 0;
  for (const ta of setA) {
    for (const tb of setB) {
      // Exact OR prefix match (handles plural/singular without a full stemmer)
      if (ta === tb || ta.startsWith(tb) || tb.startsWith(ta)) {
        inter++;
        break;
      }
    }
  }
  return inter / Math.min(setA.length, setB.length);
}

/**
 * Infers the most probable section of a product from its name.
 * Returns the original label of the winning candidate, or '' if no
 * candidate exceeds the match threshold.
 */
export function inferProductSection(productName: string, candidateSections: string[]): string {
  if (!productName || candidateSections.length === 0) return '';
  const nameTokens = tokenize(productName);
  if (nameTokens.length === 0) return '';

  let bestLabel = '';
  let bestScore = 0;
  for (const candidate of candidateSections) {
    const candTokens = tokenize(candidate);
    if (candTokens.length === 0) continue;
    const score = jaccardOverlap(nameTokens, candTokens);
    if (score > bestScore) {
      bestScore = score;
      bestLabel = candidate;
    }
  }
  return bestScore >= MIN_OVERLAP_RATIO ? bestLabel : '';
}

/**
 * Decides whether inference is RELEVANT for a batch of products:
 *   - More than 50% of products have an empty section
 *   - AND at least 2 candidate sections in the template
 *
 * If true, the caller should call inferProductSection() on each product and
 * mutate its section. Otherwise, leave as-is.
 */
export function shouldInferSections(
  productsWithEmptySection: number,
  totalProducts: number,
  candidateSectionsCount: number,
): boolean {
  if (totalProducts === 0) return false;
  if (candidateSectionsCount < 2) return false;
  return productsWithEmptySection / totalProducts > 0.5;
}

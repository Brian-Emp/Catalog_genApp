/**
 * inferProductSection — déduit la section d'un produit depuis son NOM
 * en comparant avec les sections candidates détectées dans le template
 * (banners section).
 *
 * Cas d'usage : XLSX simple sans colonne famille/section. Le pipeline a
 * besoin d'une section pour grouper les produits et alimenter l'allocator.
 * On infère depuis :
 *   1. Tokens du nom produit (matière, type, fonction)
 *   2. Tokens des sections candidates du template
 *
 * Match : Jaccard tokens >= MIN_OVERLAP_RATIO. Retourne le candidat avec
 * le meilleur score, ou '' si rien ne matche.
 */

import { normalizeSection } from './inputs';

/** Stop-words multi-langue à ignorer dans le matching (mots trop génériques). */
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
  // NL (néerlandais)
  'het', 'een', 'en', 'of', 'met', 'zonder', 'voor', 'naar',
  'van', 'tot', 'aan', 'bij', 'over', 'onder',
  // SE (suédois)
  'den', 'det', 'ett', 'och', 'eller', 'med', 'utan', 'för', 'fran',
  // NO/DK
  'ei', 'og', 'eller', 'uten', 'pa', 'av',
  // PL (polonais)
  'oraz', 'lub', 'bez', 'dla', 'na', 'do', 'od', 'przez',
]);
/** Score Jaccard minimum (intersection / min(set sizes)) pour valider. */
const MIN_OVERLAP_RATIO = 0.25;
/** Longueur min des tokens (évite "Le", "à", "x"). */
const MIN_TOKEN_LEN = 3;

/** Découpe + nettoie un texte en tokens normalisés sans stop-words. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return normalizeSection(text)
    .split(' ')
    .filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t));
}

/** Match score entre 2 sets de tokens : ratio intersection/min(set sizes).
 *  Accepte les matches préfixe (singulier/pluriel : "lavabo" ~ "lavabos"). */
function jaccardOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = Array.from(new Set(a));
  const setB = Array.from(new Set(b));
  let inter = 0;
  for (const ta of setA) {
    for (const tb of setB) {
      // Match exact OU préfixe (handle pluriel/singulier sans stemmer complet)
      if (ta === tb || ta.startsWith(tb) || tb.startsWith(ta)) {
        inter++;
        break;
      }
    }
  }
  return inter / Math.min(setA.length, setB.length);
}

/**
 * Infère la section la plus probable d'un produit depuis son nom.
 * Retourne le label original de la candidate gagnante, ou '' si aucune
 * candidate ne dépasse le seuil de match.
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
 * Décide si l'inference est PERTINENTE pour un lot de produits :
 *   - Plus de 50 % des produits ont section vide
 *   - ET au moins 2 sections candidates dans le template
 *
 * Si vrai, le caller doit appeler inferProductSection() sur chaque produit
 * et muter sa section. Sinon, laisser tel quel.
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

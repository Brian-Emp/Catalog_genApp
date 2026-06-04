/**
 * Orientation page — helper pour discriminer portrait / paysage.
 *
 * Le pipeline V2 historique (Catalogue A, Catalogue E) part du présupposé "paysage" pour
 * tous les seuils géométriques (nameXMax, specsXMin, ribbonMargin, etc.).
 * Sur catalogues A4 portrait (Catalogue C / Catalogue B, brochures jardin/piscine
 * standard), ces seuils sont décalés.
 *
 * Ce module fournit les utilitaires de détection. La propagation aux
 * heuristiques (swap W/H des seuils, profil portrait, etc.) viendra dans
 * un lot ultérieur.
 */

import type { ExtractedPage } from '../types';

/** Tolérance pour distinguer portrait/paysage. Sous ce ratio (proche de 1),
 *  on considère la page "carrée" et on défaut à paysage (legacy). */
const SQUARE_THRESHOLD = 1.05;

export type PageOrientation = 'portrait' | 'landscape' | 'square';

/** Retourne l'orientation d'une page. Une page A4 portrait (595 x 842)
 *  retourne 'portrait', A4 paysage (842 x 595) retourne 'landscape'.
 *
 *  Implémentation :
 *   - height / width > 1.05 → portrait
 *   - width / height > 1.05 → landscape
 *   - sinon → square (rare ; livre photo, etc.)
 */
export function getPageOrientation(page: ExtractedPage): PageOrientation {
  const w = page.page_size.width;
  const h = page.page_size.height;
  if (w <= 0 || h <= 0) return 'landscape';
  if (h / w > SQUARE_THRESHOLD) return 'portrait';
  if (w / h > SQUARE_THRESHOLD) return 'landscape';
  return 'square';
}

/** True si la page est portrait (height > width). */
export function isPagePortrait(page: ExtractedPage): boolean {
  return getPageOrientation(page) === 'portrait';
}

/** True si la page est paysage (width > height). Couvre aussi 'square'
 *  par défaut legacy. */
export function isPageLandscape(page: ExtractedPage): boolean {
  return getPageOrientation(page) !== 'portrait';
}

/** Orientation majoritaire d'un set de pages. Utilisé pour déterminer
 *  l'orientation "globale" d'un template (typiquement une seule
 *  orientation par catalogue). En cas d'égalité parfaite, retourne
 *  'landscape' (legacy). */
export function dominantOrientation(pages: ExtractedPage[]): PageOrientation {
  if (pages.length === 0) return 'landscape';
  let portrait = 0;
  let landscape = 0;
  let square = 0;
  for (const p of pages) {
    const o = getPageOrientation(p);
    if (o === 'portrait') portrait++;
    else if (o === 'landscape') landscape++;
    else square++;
  }
  if (portrait > landscape && portrait > square) return 'portrait';
  if (square > landscape && square > portrait) return 'square';
  return 'landscape';
}

/**
 * Page orientation — helper to discriminate portrait / landscape.
 *
 * The legacy V2 pipeline (Catalogue A, Catalogue E) assumes "landscape" for
 * all geometric thresholds (nameXMax, specsXMin, ribbonMargin, etc.). On A4
 * portrait catalogs (Catalogue C / Catalogue B, standard garden/pool
 * brochures), those thresholds are offset.
 *
 * This module provides the detection utilities. Propagation to the
 * heuristics (W/H swap of thresholds, portrait profile, etc.) will come in a
 * later batch.
 */

import type { ExtractedPage } from '../types';

/** Tolerance to distinguish portrait/landscape. Below this ratio (close to
 *  1), the page is considered "square" and defaults to landscape (legacy). */
const SQUARE_THRESHOLD = 1.05;

export type PageOrientation = 'portrait' | 'landscape' | 'square';

/** Returns the orientation of a page. An A4 portrait page (595 x 842)
 *  returns 'portrait', A4 landscape (842 x 595) returns 'landscape'.
 *
 *  Implementation:
 *   - height / width > 1.05 → portrait
 *   - width / height > 1.05 → landscape
 *   - otherwise → square (rare; photo book, etc.)
 */
export function getPageOrientation(page: ExtractedPage): PageOrientation {
  const w = page.page_size.width;
  const h = page.page_size.height;
  if (w <= 0 || h <= 0) return 'landscape';
  if (h / w > SQUARE_THRESHOLD) return 'portrait';
  if (w / h > SQUARE_THRESHOLD) return 'landscape';
  return 'square';
}

/** True if the page is portrait (height > width). */
export function isPagePortrait(page: ExtractedPage): boolean {
  return getPageOrientation(page) === 'portrait';
}

/** True if the page is landscape (width > height). Also covers 'square'
 *  by legacy default. */
export function isPageLandscape(page: ExtractedPage): boolean {
  return getPageOrientation(page) !== 'portrait';
}

/** Majority orientation of a set of pages. Used to determine the "global"
 *  orientation of a template (typically a single orientation per catalog).
 *  On a perfect tie, returns 'landscape' (legacy). */
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

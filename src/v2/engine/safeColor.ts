/**
 * safeColor: normalizes a text color for substituted rendering.
 *
 * Root problem: on some catalogs (Catalogue C in particular), the template
 * product names are WHITE because they display on a COLORED CARTOUCHE (blue/
 * green/etc. background path). When the block is substituted, the pipeline
 * erases the block background (large white block background erase) BUT keeps
 * the template span color => white text on white background = invisible.
 *
 * The fix detects colors that are "too light" (close to white) and switches
 * them to black so they stay readable after the background is erased.
 *
 * Convention: '#rrggbb' (alpha not handled). If the format is invalid, the
 * original value is returned (safe no-op).
 */

import type { ColorHex } from '../types';

/** Luminosity threshold above which a color is considered "too light" to be
 *  readable on a white background. R+G+B sum = 765 max; we use 700 (~91% of
 *  white) = whiteish. */
const LIGHT_THRESHOLD_SUM = 700;

/**
 * Returns a SAFE color for rendering text on a white background:
 *  - If the original color is very light (close to white) → '#000000' (black).
 *  - Otherwise → original color unchanged.
 *
 * Use case: apply to EVERY insert_text that reuses a span.color from a
 * template where the cartouche background is erased.
 */
export function safeTextColor(color: ColorHex | null | undefined): ColorHex {
  if (!color) return '#000000';
  const norm = color.trim().toLowerCase();
  // Expected format: #rrggbb (7 chars). If another format, stay safe.
  if (!/^#[0-9a-f]{6}$/.test(norm)) return color;
  const r = parseInt(norm.slice(1, 3), 16);
  const g = parseInt(norm.slice(3, 5), 16);
  const b = parseInt(norm.slice(5, 7), 16);
  if (r + g + b >= LIGHT_THRESHOLD_SUM) {
    return '#000000';
  }
  return color;
}

/** Variant: returns true if the color is too light (close to white). */
export function isLightColor(color: ColorHex | null | undefined): boolean {
  if (!color) return false;
  const norm = color.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(norm)) return false;
  const r = parseInt(norm.slice(1, 3), 16);
  const g = parseInt(norm.slice(3, 5), 16);
  const b = parseInt(norm.slice(5, 7), 16);
  return r + g + b >= LIGHT_THRESHOLD_SUM;
}

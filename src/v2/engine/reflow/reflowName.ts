/**
 * reflowName — substitutes a product name while respecting the geometric
 * constraints of the template slot (available width + vertical budget).
 *
 * "Wrap first then shrink" strategy (cf. fit.fitWrapThenShrink):
 *   1. Try 1 line at the original size.
 *   2. Wrap to 2 lines (if the vertical budget allows) at the original size.
 *   3. Shrink the font down to 70%, retrying 1 then 2 lines.
 *   4. Truncate with "…" if nothing fits.
 *
 * Output: Operation[] (erase_rect + insert_text per line) + metadata so the
 * caller (substitutor) can tell whether the name zone overflowed and
 * possibly shift the neighboring zones (color/ref).
 */

import type { Bbox, Operation, TextSpan } from '../../types';
import { fitWrapThenShrink, type FitResult } from './fit';
import { safeTextColor } from '../safeColor';

/** Standard sans-serif line-height ratio (line-height / fontSize). */
const LINE_HEIGHT_RATIO = 1.15;
/** Minimum font ratio (relative to the original) before truncating. */
const MIN_FONT_RATIO = 0.70;
/** Safety margin added to the erase padding (pt). */
const ERASE_PAD = 2;
/** Additional top vertical margin to cover any tight fragments crammed
 *  under decorations / section banners. Conservatively calibrated:
 *  proportional to origSize to adapt to the various typefaces. On Catalogue A (16pt)
 *  → ~3pt of margin, on Catalogue C / Catalogue B (15pt) → ~2.8pt. */
const ERASE_TOP_RATIO = 0.25;

export interface ReflowNameInput {
  /** Text of the new name to insert. */
  text: string;
  /** Template span of the name (carries font, size, color, reference bbox). */
  span: TextSpan;
  /** Absolute right bound (pt). Usually pageWidth - ribbonMargin. */
  rightBound: number;
  /** Acceptable bottom bound (pt). Usually the top of the color/ref or of
   *  the specs zone. If provided, multi-line wrapping is only allowed when
   *  the additional lines fit above this bound. */
  bottomBound?: number;
  /** Max number of lines (independent of the vertical budget). Default 2. */
  maxLines?: number;
}

export interface ReflowNameResult {
  /** Operations to apply (global erase + 1 insert_text per line). */
  ops: Operation[];
  /** Final rendered lines. */
  lines: string[];
  /** Effective font size (may be < original). */
  fontSize: number;
  /** Total height occupied (from the top to the end of the last line). */
  totalHeight: number;
  /** Y shift to apply to the elements below (color/ref) so they don't
   *  overlap if the name takes up more height than the template. */
  yShift: number;
  /** True if we had to truncate (information loss). */
  truncated: boolean;
  /** Applied strategy (debug). */
  strategy: FitResult['strategy'];
}

export function reflowName(input: ReflowNameInput): ReflowNameResult {
  const text = (input.text ?? '').trim();
  const span = input.span;
  const origSize = span.size;
  const minSize = origSize * MIN_FONT_RATIO;
  const lineHRatio = LINE_HEIGHT_RATIO;
  const origHeight = span.bbox[3] - span.bbox[1];

  // Available width: from the name's x0 to the right bound.
  const maxWidth = Math.max(0, input.rightBound - span.bbox[0]);

  // Vertical budget to decide maxLines: if bottomBound is provided, compute
  // how many lines fit. Otherwise let the full maxLines through.
  let effectiveMaxLines = Math.max(1, input.maxLines ?? 2);
  if (input.bottomBound !== undefined) {
    const verticalBudget = input.bottomBound - span.bbox[1];
    const lineH = origSize * lineHRatio;
    const fits = Math.max(1, Math.floor(verticalBudget / lineH));
    effectiveMaxLines = Math.min(effectiveMaxLines, fits);
  }

  // Fit
  const fit = fitWrapThenShrink(text, {
    maxWidth,
    originalSize: origSize,
    minSize,
    maxLines: effectiveMaxLines,
  });

  const lineH = fit.fontSize * lineHRatio;
  const lines = fit.lines.length > 0 ? fit.lines : [''];
  const totalHeight = (lines.length - 1) * lineH + origHeight;
  const yShift = Math.max(0, totalHeight - origHeight);

  // Global erase: covers the whole name zone (width up to rightBound,
  // height up to the effective line count), with adaptive padding.
  // Top padding widened (ERASE_TOP_RATIO * origSize) to cover tight
  // fragments such as a barcode / subtitle glued to the name in dense
  // templates.
  // Bottom padding proportional (Catalogue C P5 bug: template "Exemple" stays
  // visible behind the new name). At large sizes (nameSize 24-28pt),
  // ERASE_PAD=2 doesn't cover the descenders + the line spacing. With a ratio
  // of 0.25 on 28pt = 7pt, we capture glyphs whose render bbox > baseline bbox.
  const eraseTopPad = Math.max(ERASE_PAD, origSize * ERASE_TOP_RATIO);
  const eraseBottomPad = Math.max(ERASE_PAD, origSize * 0.25);
  const eraseBbox: Bbox = [
    span.bbox[0] - ERASE_PAD,
    span.bbox[1] - eraseTopPad,
    Math.max(span.bbox[2], input.rightBound) + ERASE_PAD,
    span.bbox[1] + totalHeight + eraseBottomPad,
  ];

  const ops: Operation[] = [
    { op: 'erase_rect', bbox: eraseBbox },
  ];

  // 1 insert_text per line. The 1st line keeps the original span's y, the
  // following ones are offset by lineH. no_erase=true because we did a
  // global erase wider than the auto-erase of each insert_text.
  for (let i = 0; i < lines.length; i++) {
    const yOffset = i * lineH;
    ops.push({
      op: 'insert_text',
      bbox: [
        span.bbox[0],
        span.bbox[1] + yOffset,
        Math.min(input.rightBound, span.bbox[2] + 200),  // bbox-right indicative
        span.bbox[3] + yOffset,
      ],
      text: lines[i],
      font: span.font,
      size: fit.fontSize,
      // safeTextColor: switches to black if template = white/light (colored
      // cartouche erased by block background erase => otherwise name invisible).
      color: safeTextColor(span.color),
      no_erase: true,
    });
  }

  return {
    ops,
    lines,
    fontSize: fit.fontSize,
    totalHeight,
    yShift,
    truncated: fit.truncated,
    strategy: fit.strategy,
  };
}

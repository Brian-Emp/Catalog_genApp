/**
 * reflowVariants — draws a product's color swatches, handling the OVERFLOW
 * case (more variants than template positions).
 *
 * Strategies:
 *   - n_new <= positions      → current behavior: 1 circle per position
 *   - n_new > positions       → MULTI-LINE: extrapolate additional positions
 *                               by shifting vertically into rows of the same
 *                               width. The rowHeight is the swatch size +
 *                               label gap.
 *                               If we exceed bottomY → truncate + "+N" signal.
 *   - 0 variants              → erase only (empty zone).
 *
 * The label under each circle is kept.
 */

import type { Bbox, Operation, PlanProduct } from '../../types';
import type { ProductBlock } from '../blockDetector';
import type { TemplateProfile } from '../profile';
import { safeText } from '../safeText';
import { padBbox } from '../../utils/bbox';

/** Padding (pt) around the swatches for the initial erase. */
const ERASE_PAD_VIGNETTE = 2;
const ERASE_PAD_LABEL = 3;
/** Gap between variant rows for the label + breathing room. */
const ROW_GAP_RATIO = 0.55;
/** Max overflow height below bottomY (pt). Beyond it, truncate. */
const OVERFLOW_BOTTOM_TOLERANCE = 6;

export function reflowVariants(
  block: ProductBlock,
  product: PlanProduct,
  profile: TemplateProfile
): Operation[] {
  const ops: Operation[] = [];
  const variants = product.variants ?? [];

  // 1. Erase the template's existing swatches + labels
  for (const v of block.variantImages) {
    ops.push({ op: 'erase_rect', bbox: padBbox(v, ERASE_PAD_VIGNETTE) });
  }
  for (const span of block.variantSpans) {
    ops.push({ op: 'erase_rect', bbox: padBbox(span.bbox, ERASE_PAD_LABEL) });
  }

  if (variants.length === 0) return ops;
  const positions = block.variantImages;
  if (positions.length === 0) return ops;

  const n_new = variants.length;
  const n_per_row = positions.length;

  // 2. Compute multi-line layout
  // rowHeight = height of a swatch + gap for the label below it
  const refVignette = positions[0];
  const vignetteH = refVignette[3] - refVignette[1];
  const rowHeight = vignetteH * (1 + ROW_GAP_RATIO);

  const labelSize = profile.colorRefSizeRange[0];
  const labelFont = profile.headerColorFontPattern;
  const labelColor = '#231f20';

  // 3. For each variant: compute position (with y offset per row)
  const bottomLimit = block.yBottom + OVERFLOW_BOTTOM_TOLERANCE;
  let drawnCount = 0;
  let overflowSurplus = 0;
  let lastBbox: Bbox | null = null;

  for (let i = 0; i < n_new; i++) {
    const row = Math.floor(i / n_per_row);
    const col = i % n_per_row;
    const basePos = positions[col];
    const yShift = row * rowHeight;
    const shiftedBbox: Bbox = [
      basePos[0],
      basePos[1] + yShift,
      basePos[2],
      basePos[3] + yShift,
    ];

    // Check that we don't go too far down
    if (shiftedBbox[3] > bottomLimit) {
      // Vertical overflow: stop, the rest becomes surplus
      overflowSurplus = n_new - i;
      break;
    }

    // Erase for positions beyond the 1st row (the 1st row was already
    // erased above via the block.variantImages template)
    if (row > 0) {
      ops.push({ op: 'erase_rect', bbox: padBbox(shiftedBbox, ERASE_PAD_VIGNETTE) });
      const labelBboxClear: Bbox = [
        shiftedBbox[0] - 2,
        shiftedBbox[3] + 1,
        shiftedBbox[2] + 30,
        shiftedBbox[3] + labelSize + 4,
      ];
      ops.push({ op: 'erase_rect', bbox: labelBboxClear });
    }

    const v = variants[i];
    const cx = (shiftedBbox[0] + shiftedBbox[2]) / 2;
    const cy = (shiftedBbox[1] + shiftedBbox[3]) / 2;
    const radius = Math.min(shiftedBbox[2] - shiftedBbox[0], shiftedBbox[3] - shiftedBbox[1]) / 2;
    ops.push({
      op: 'draw_circle',
      center: [cx, cy],
      radius,
      color: v.color,
    });
    if (v.label) {
      ops.push({
        op: 'insert_text',
        bbox: [shiftedBbox[0], shiftedBbox[3] + 2, shiftedBbox[2] + 20, shiftedBbox[3] + 2 + labelSize],
        text: safeText(v.label),
        font: labelFont,
        size: labelSize,
        color: labelColor,
      });
    }
    drawnCount++;
    lastBbox = shiftedBbox;
  }

  // 4. Overflow signal if we had to truncate
  if (overflowSurplus > 0 && lastBbox) {
    const noteY = lastBbox[3] + 2 + labelSize + 4;
    if (noteY + labelSize <= bottomLimit + 12) {
      ops.push({
        op: 'insert_text',
        bbox: [positions[0][0], noteY, positions[positions.length - 1][2] + 30, noteY + labelSize],
        text: `+ ${overflowSurplus} autre${overflowSurplus > 1 ? 's' : ''} coloris`,
        font: labelFont,
        size: labelSize * 0.92,
        color: labelColor,
      });
    }
  }

  return ops;
}

// padBbox: see utils/bbox.ts (factored out, audit #12).

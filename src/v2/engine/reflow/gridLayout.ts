/**
 * gridLayout — producer overflow: when a PageAllocation has more products
 * than blocks detected on the template page, we synthesize additional
 * blocks by cloning the bottom template block (vertical translation only,
 * MVP). Eventually: 2D NxM grid with scaling.
 *
 * MVP strategy (1 col, multi-rows):
 *  1. Measure the height of the reference template block (the lowest on the page)
 *  2. Compute how many additional rows fit below it in the available zone
 *     (pageHeight - footer margin)
 *  3. Emit synthetic ProductBlocks (translated copies)
 *  4. Cap: we only synthesize up to `nProducts` (no further even if there
 *     is more room)
 *
 * The substitutor treats these synthetic blocks as normal blocks: no
 * change to the downstream pipeline.
 */

import type { Bbox, TextSpan } from '../../types';
import type { ProductBlock, ProductSpecBlock } from '../blockDetector';

/** Minimum margin reserved at the bottom of the page (footer / page number). */
const PAGE_FOOTER_MARGIN_PT = 40;
/** Vertical gap between 2 synthesized rows (pt). */
const ROW_GAP_PT = 8;

export interface GridLayoutInput {
  /** Blocks detected on the template page. */
  originalBlocks: ProductBlock[];
  /** Total number of products to place on this page. */
  nProducts: number;
  /** Total page height (pt). */
  pageHeight: number;
}

export interface GridLayoutResult {
  /** Final blocks to substitute (originals + synthesized on overflow). */
  blocks: ProductBlock[];
  /** True if at least 1 block was synthesized (= grid mode triggered). */
  gridApplied: boolean;
  /** Number of rows added (0 if no overflow or no room). */
  rowsAdded: number;
}

/** Translates a Bbox by (dx, dy). */
function translateBbox(b: Bbox, dx: number, dy: number): Bbox {
  return [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
}

/** Translates a TextSpan: only the bbox moves, everything else is unchanged. */
function translateSpan(s: TextSpan, dx: number, dy: number): TextSpan {
  return { ...s, bbox: translateBbox(s.bbox, dx, dy) };
}

function translateSpec(s: ProductSpecBlock, dx: number, dy: number): ProductSpecBlock {
  return {
    key: translateSpan(s.key, dx, dy),
    values: s.values.map((v) => translateSpan(v, dx, dy)),
  };
}

/** Clones a ProductBlock, translating all positions by (dx, dy). */
function translateBlock(b: ProductBlock, dx: number, dy: number): ProductBlock {
  return {
    pageNumber: b.pageNumber,
    nameSpan: translateSpan(b.nameSpan, dx, dy),
    nameWrappedCount: b.nameWrappedCount,
    refSpan: b.refSpan ? translateSpan(b.refSpan, dx, dy) : null,
    colorSpan: b.colorSpan ? translateSpan(b.colorSpan, dx, dy) : null,
    specs: b.specs.map((s) => translateSpec(s, dx, dy)),
    variantImages: b.variantImages.map((bb) => translateBbox(bb, dx, dy)),
    variantSpans: b.variantSpans.map((s) => translateSpan(s, dx, dy)),
    mainImageBbox: b.mainImageBbox ? translateBbox(b.mainImageBbox, dx, dy) : null,
    yTop: b.yTop + dy,
    yBottom: b.yBottom + dy,
    specsYTop: b.specsYTop + dy,
    specsYBottom: b.specsYBottom + dy,
    specsXLeft: b.specsXLeft + dx,
  };
}

/** Determines whether grid overflow applies + generates the synthetic blocks. */
export function synthesizeOverflowBlocks(input: GridLayoutInput): GridLayoutResult {
  const { originalBlocks, nProducts, pageHeight } = input;
  if (originalBlocks.length === 0 || nProducts <= originalBlocks.length) {
    return { blocks: originalBlocks, gridApplied: false, rowsAdded: 0 };
  }

  // Lowest block (reference for the clones translated below it)
  const lastBlock = originalBlocks.reduce((acc, b) => (b.yBottom > acc.yBottom ? b : acc));
  const refH = lastBlock.yBottom - lastBlock.yTop;
  if (refH <= 0) return { blocks: originalBlocks, gridApplied: false, rowsAdded: 0 };

  const stepH = refH + ROW_GAP_PT;
  const availableBelow = pageHeight - PAGE_FOOTER_MARGIN_PT - lastBlock.yBottom;
  const maxExtraRows = Math.floor(availableBelow / stepH);
  if (maxExtraRows <= 0) {
    return { blocks: originalBlocks, gridApplied: false, rowsAdded: 0 };
  }

  const wantedExtra = nProducts - originalBlocks.length;
  const rowsAdded = Math.min(maxExtraRows, wantedExtra);
  const synthesized: ProductBlock[] = [...originalBlocks];
  for (let i = 1; i <= rowsAdded; i++) {
    synthesized.push(translateBlock(lastBlock, 0, i * stepH));
  }
  return { blocks: synthesized, gridApplied: rowsAdded > 0, rowsAdded };
}

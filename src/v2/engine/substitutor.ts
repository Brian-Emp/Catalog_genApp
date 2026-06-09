/**
 * Phase 3: in-place substitution of a template product page.
 *
 * For each template block, we use the EXACT positions+styles (font, size,
 * color, bbox) of the source spans as a fingerprint. We erase each zone and
 * rewrite the new text in the same place. NO layout recomputation — we
 * respect the template to the letter.
 *
 * If products < blocks: the remaining blocks are erased (white zone).
 * If products > blocks: we truncate (the allocator has already picked a page
 * of the right size).
 */

import type {
  Bbox,
  ColorHex,
  Operation,
  OpDrawCircle,
  OpDrawImage,
  OpEraseRect,
  OpInsertText,
  PlanProduct,
  TextSpan,
} from '../types';
import type { ProductBlock } from './blockDetector';
import type { TemplateProfile } from './profile';
import { reflowName } from './reflow/reflowName';
import { reflowSpecs as reflowSpecsModule } from './reflow/reflowSpecs';
import { reflowSpecsV2 } from './reflow/reflowSpecsV2';
import { reflowVariants as reflowVariantsModule } from './reflow/reflowVariants';
import { estimateTextWidth } from './reflow/fit';
import { safeText } from './safeText';
import { safeTextColor } from './safeColor';
import { padBbox } from '../utils/bbox';

export interface SubstituteContext {
  pageWidth: number;
  pageHeight: number;
  profile: TemplateProfile;
  /** All template spans on this page. Used by the residue polish: any textual
   *  trace of the original product (promo banners, "thermostatique a corps
   *  froid" mentions, etc.) that was not replaced by an insert_text op is
   *  erased automatically. */
  rawSpans?: TextSpan[];
  /** All bitmap bboxes on the page (to erase NF pictos, "FABRIQUE EN FRANCE"
   *  stamps, etc. left over in the blocks). */
  rawImages?: Bbox[];
  /** Bboxes of all vector decorations (pictos drawn as paths). We erase those
   *  in the blocks that do not touch the edges (= not structural ribbons). */
  decorationVectors?: Bbox[];
  /** Colored paths (bbox + fill_color) of the template. Lets us recover the
   *  tint of a section_banner cartouche to substitute the label. */
  rawPaths?: { bbox: Bbox; fill_color: ColorHex }[];
  /** section_banner spans detected by the classifier (label text + bbox). */
  sectionBannerSpans?: TextSpan[];
  /** New section label to write into the cartouches (e.g.
   *  "BARRES DE DOUCHES"). If empty: we do not substitute the banner. */
  newSectionLabel?: string;
  /** Vertical spans (rotation=90/270) detected on the right edge of the page
   *  = template "section_ribbon" (e.g. "salle de bains"). */
  ribbonSpans?: TextSpan[];
  /** New family label to write on the vertical ribbon (e.g. "SANITAIRE" from
   *  the XLSX Libellé Famille). If empty: we do not substitute. */
  newFamilyLabel?: string;
  /** Horizontal multi-cols mode (S6.5) propagated from substitutePage to
   *  substituteBlock then reflowSpecsV2. See ReflowSpecsV2Context. */
  horizontalMode?: 'vertical' | 'horizontal-primary' | 'horizontal-secondary';
  /** Right X of the current block's column in horizontal mode. */
  horizontalColRight?: number;
}

/** Computes, for each block of a horizontal page, its mode (primary if first
 *  in the Y row, secondary otherwise) and its horizontalColRight (X of the
 *  neighboring block on the right OR page edge).
 *
 *  Review flaw: colRight must NEVER be Infinity (problematic propagation to
 *  PDFium). For the last block of a row, we return `pageWidth - ribbonMargin`
 *  (explicit clamp).
 *  Y tolerance adapted to the mean nameSize (vs a fixed 8pt). */
export function computeHorizontalRowMeta(
  blocks: ProductBlock[],
  pageWidth?: number,
  ribbonMargin?: number,
): Map<ProductBlock, { mode: 'horizontal-primary' | 'horizontal-secondary'; colRight: number }> {
  const meta = new Map<
    ProductBlock,
    { mode: 'horizontal-primary' | 'horizontal-secondary'; colRight: number }
  >();
  if (blocks.length === 0) return meta;
  // Y tolerance adapted to the median nameSize (vs a fixed 8pt)
  const sizes = blocks.map((b) => b.nameSpan.size).sort((a, b) => a - b);
  const medianSize = sizes[Math.floor(sizes.length / 2)];
  const Y_TOL = Math.max(4, medianSize * 0.30);
  const rows = new Map<number, ProductBlock[]>();
  for (const b of blocks) {
    let rowKey: number | null = null;
    for (const key of rows.keys()) {
      if (Math.abs(b.yTop - key) <= Y_TOL) {
        rowKey = key;
        break;
      }
    }
    if (rowKey === null) {
      rowKey = b.yTop;
      rows.set(rowKey, []);
    }
    rows.get(rowKey)!.push(b);
  }
  // Finite bound for the last block of each row: pageWidth - ribbonMargin or
  // a reasonable fallback if pageWidth is unavailable.
  const lastBlockColRight =
    pageWidth !== undefined && ribbonMargin !== undefined
      ? pageWidth - ribbonMargin
      : pageWidth ?? 600;
  for (const rowBlocks of rows.values()) {
    rowBlocks.sort((a, b) => a.nameSpan.bbox[0] - b.nameSpan.bbox[0]);
    for (let i = 0; i < rowBlocks.length; i++) {
      const block = rowBlocks[i];
      const next = rowBlocks[i + 1];
      const colRight = next ? next.nameSpan.bbox[0] - 4 : lastBlockColRight;
      meta.set(block, {
        mode: i === 0 ? 'horizontal-primary' : 'horizontal-secondary',
        colRight,
      });
    }
  }
  return meta;
}

/**
 * Substitutes the blocks of a template page with a list of products.
 * - blocks.length === products.length → 1:1 substitution
 * - blocks.length > products.length → remaining blocks erased (clean blanks)
 * - blocks.length < products.length → the surplus products ignored (the
 *   allocator has already handled this size)
 */
export function substitutePage(
  blocks: ProductBlock[],
  products: PlanProduct[],
  ctx: SubstituteContext,
): Operation[] {
  const ops: Operation[] = [];
  // Horizontal mode (S6.5): if the page has a horizontal layout, we group the
  // blocks by Y row and mark the first as primary, the others as secondary.
  // substituteBlock relays these flags to reflowSpecsV2. Conservative
  // activation: ONLY if ALL blocks have isHorizontalLayout=true (avoids
  // affecting the Catalogue A vertical behavior).
  const allHorizontal =
    blocks.length > 0 && blocks.every((b) => b.isHorizontalLayout === true);
  const horizontalRowMeta = allHorizontal
    ? computeHorizontalRowMeta(blocks, ctx.pageWidth, ctx.profile.ribbonMargin)
    : null;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const product = products[i];
    const meta = horizontalRowMeta?.get(block) ?? null;
    const blockCtx: SubstituteContext = meta
      ? { ...ctx, horizontalMode: meta.mode, horizontalColRight: meta.colRight }
      : ctx;
    if (product) {
      ops.push(...substituteBlock(block, product, blockCtx));
    } else {
      ops.push(...eraseBlock(block, blockCtx));
    }
  }
  // Textual residue polish: erase the non-substituted template spans in the
  // block zones (banners "Existe en bain-douche", mentions "THERMOSTATIQUE A
  // CORPS FROID", "NOUVEAUTE", etc.).
  if (ctx.rawSpans) {
    ops.push(...polishResidualSpans(ctx.rawSpans, blocks, ops, ctx));
  }
  // Visual residue polish: erase bitmap pictos (NF badges, "FABRIQUE EN
  // FRANCE", etc.) and vector pictos (red "NOUVEAUTE" circle, thermostatic
  // half-circle, etc.) in the block zones, except the main product image and
  // the structural ribbons/headers that touch the page edges.
  if (ctx.rawImages) {
    ops.push(...polishResidualBitmaps(ctx.rawImages, blocks, ops, ctx));
  }
  if (ctx.decorationVectors) {
    ops.push(...polishResidualVectors(ctx.decorationVectors, blocks, ctx));
  }
  // section_banner substitution (cartouches "ÉVIERS BAS - MITIGEURS" ->
  // "BARRES DE DOUCHES"). We emit the insert_text BEFORE the colored erase,
  // so that the render's PASS 1 does:
  //   1) insert_text PASS 1 = white auto-erase (cancels the path tint)
  //   2) colored erase_rect = repaints the template tint on top
  // On PASS 2 the text arrives on top → tinted cartouche + new label.
  if (ctx.sectionBannerSpans && ctx.newSectionLabel && ctx.rawPaths) {
    ops.push(...substituteSectionBanners(ctx));
  }
  // Vertical ribbon (family). Substitutes the template's "cuisine"/"salle de
  // bains" with the product's family ("SANITAIRE", "CHAUFFAGE", etc.).
  if (ctx.ribbonSpans && ctx.newFamilyLabel) {
    ops.push(...substituteFamilyRibbon(ctx));
  }
  return ops;
}

/** Vertical ribbon constants. */
const RIBBON_MARGIN_PT = 4;
/** Fallback size if span.size < 8pt (PDFium extraction artifact on rotated
 *  text). */
const RIBBON_FALLBACK_SIZE_PT = 14;
/** Extraction artifact detection. */
const RIBBON_ARTIFACT_THRESHOLD_PT = 8;
/** Shrink floor: we will not go below it, we truncate instead. */
const RIBBON_MIN_SHRINK_SIZE_PT = 10;
/** Anti-overflow: the text must not fill more than X% of the colored
 *  background's height. Above that → we shrink BEFORE tolerating the visual
 *  enlargement ("huge ribbon" on long texts). */
const RIBBON_MAX_FILL_RATIO = 0.85;
/** Shrink decrement step (pt). */
const RIBBON_SHRINK_STEP = 0.5;

/** Substitutes the vertical ribbon (family label, rotation 90/270 on the
 *  right edge). Erase + insert with the new label. If the template ribbon has
 *  a COLORED background (orange/green bar), we look for the matching path and
 *  emit a colored erase_rect to repaint the tint over the white auto-erase.
 *  Otherwise: simple white erase (fallback). */
function substituteFamilyRibbon(ctx: SubstituteContext): Operation[] {
  const ops: Operation[] = [];
  const newLabel = (ctx.newFamilyLabel ?? '').trim();
  if (newLabel.length === 0) return ops;
  const paths = ctx.rawPaths ?? [];
  // Anti-double-substitution: if a span is ALREADY a section_banner (replaced
  // by the section label, e.g. "BARRES DE DOUCHES"), it must NOT also receive
  // the family ribbon ("SANITAIRE") on top. Observed bug (catalog Catalogue A
  // p6): the top banner [303,12,560,27] was classified as both section_banner
  // AND ribbon → 2 overlapping insert_text "BARRES DE DOUCHES" + "SANITAIRE".
  const bannerBboxes = ctx.newSectionLabel
    ? (ctx.sectionBannerSpans ?? []).map((b) => b.bbox)
    : [];
  for (const span of ctx.ribbonSpans ?? []) {
    if (bannerBboxes.length > 0 && isCovered(span.bbox, bannerBboxes, 0.5)) continue;
    // Template case: if span all lower → lower, all upper → upper, otherwise
    // capitalize. Respects the original typography ("salle de bains" vs "CUISINE").
    const tplText = span.text.trim();
    let styled = newLabel;
    if (tplText.length > 0) {
      const hasUpper = /[A-ZÀ-ſ]/.test(tplText);
      const hasLower = /[a-zà-ſ]/.test(tplText);
      if (hasLower && !hasUpper) styled = newLabel.toLowerCase();
      else if (hasUpper && !hasLower) styled = newLabel.toUpperCase();
      else styled = newLabel.charAt(0).toUpperCase() + newLabel.slice(1).toLowerCase();
    }
    // Orientation detection: if the bbox is wider than tall → horizontal
    // ribbon (top/bottom page banner). Otherwise → vertical (left/right edge).
    const spanW = span.bbox[2] - span.bbox[0];
    const spanH = span.bbox[3] - span.bbox[1];
    const isHorizontalRibbon = spanW > spanH;

    // Look for the COLORED PATH that serves as the ribbon background.
    // Different criteria by orientation: vertical = narrow tall band,
    // horizontal = wide short band.
    const bg = paths.find((p) => {
      const pw = p.bbox[2] - p.bbox[0];
      const ph = p.bbox[3] - p.bbox[1];
      if (isHorizontalRibbon) {
        // Horizontal banner: wide + short + contains the span
        if (pw < ctx.pageWidth * 0.20) return false;
        if (ph >= 60) return false;
        if (!(p.bbox[0] - 4 <= span.bbox[0] && p.bbox[2] + 4 >= span.bbox[2])) return false;
        if (!(p.bbox[1] - 4 <= span.bbox[1] && p.bbox[3] + 4 >= span.bbox[3])) return false;
        return true;
      }
      // Vertical: narrow + tall band
      if (pw >= 50) return false;
      if (ph < ctx.pageHeight * 0.25) return false;
      if (!(p.bbox[1] - 4 <= span.bbox[1] && p.bbox[3] + 4 >= span.bbox[3])) return false;
      if (!(p.bbox[0] - 4 <= span.bbox[0] && p.bbox[2] + 4 >= span.bbox[2])) return false;
      return true;
    });

    // Initial size: we PRESERVE the template span's size (do not force an
    // artificial MIN_PT that needlessly enlarges short texts). If the span is
    // detected too small (PDFium extraction artifact on rotated text), fall
    // back to RIBBON_FALLBACK_SIZE_PT for readability.
    let effectiveSize = span.size < RIBBON_ARTIFACT_THRESHOLD_PT
      ? RIBBON_FALLBACK_SIZE_PT
      : span.size;

    // IMPORTANT: for rotation=90 in render.cpp (FPDFPageObj_Transform
    // 0,-1,1,0), the text is drawn from the y1 anchor and progresses TOWARD
    // THE BOTTOM of the screen (increasing y in top-left coords). So the text
    // occupies [y1, y1 + neededH] and NOT [y1 - neededH, y1].
    const tplY1 = span.bbox[3];
    const topLimit = bg ? bg.bbox[1] + RIBBON_MARGIN_PT : 0;
    const bottomLimit = bg ? bg.bbox[3] - RIBBON_MARGIN_PT : ctx.pageHeight;
    const fullAvail = bottomLimit - topLimit;
    // "Anti-huge" cap: the text must not occupy more than MAX_FILL_RATIO of
    // the background's height, to preserve visual margins.
    const targetMaxH = fullAvail * RIBBON_MAX_FILL_RATIO;

    let neededH = estimateTextWidth(styled, effectiveSize) + RIBBON_MARGIN_PT;

    // Step 1: shrink if > targetMaxH (aesthetic anti-overflow).
    if (neededH > targetMaxH) {
      let s = effectiveSize;
      while (s > RIBBON_MIN_SHRINK_SIZE_PT
          && estimateTextWidth(styled, s) + RIBBON_MARGIN_PT > targetMaxH) {
        s -= RIBBON_SHRINK_STEP;
      }
      effectiveSize = s;
      neededH = estimateTextWidth(styled, effectiveSize) + RIBBON_MARGIN_PT;
    }

    // Step 2: if even at the min shrink we overflow the total available space,
    // we truncate with an ellipsis (last resort for really long texts).
    if (neededH > fullAvail) {
      const ellW = estimateTextWidth('…', effectiveSize);
      while (styled.length > 4
          && estimateTextWidth(styled, effectiveSize) + RIBBON_MARGIN_PT + ellW > fullAvail) {
        styled = styled.slice(0, -1);
      }
      styled = styled.replace(/[\s,;:.\-]+$/, '') + '…';
      neededH = estimateTextWidth(styled, effectiveSize) + RIBBON_MARGIN_PT;
    }

    // Final position: preserve the template anchor if the text fits,
    // otherwise center it in the available zone for a clean visual render.
    let finalY1 = tplY1;
    const fitsAtTpl = finalY1 + neededH <= bottomLimit && finalY1 >= topLimit;
    if (!fitsAtTpl) {
      finalY1 = topLimit + (fullAvail - neededH) / 2;
    }
    // CAREFUL with bbox semantics for rotation 90:
    // - render.cpp takes bbox[3] (y1) as the PDFium ANCHOR (= pageH - y1).
    // - The text is drawn from this anchor and PROGRESSES TOWARD THE BOTTOM
    //   of the screen (increasing y in top-left convention).
    // - So the zone occupied by the text = [y1, y1 + neededH] in top-left.
    // For the insert_text, we pass bbox[3] = finalY1 (= anchor).
    // For the erase, it must cover the rendered text zone = [finalY1, finalY1+neededH].
    const insertBbox: Bbox = [span.bbox[0], finalY1, span.bbox[2], finalY1];
    // Widened pad (4pt) for the vertical ribbon: accented characters
    // (É, Ç, À) have accents that stick out in X after a 90° rotation.
    // Catalogue C P7 flaw "ÉVACUATION" → "VACUATION" (É erased incompletely).
    const RIBBON_TEXT_PAD = 4;
    // The erase must ALSO cover the original template span (otherwise the old
    // ribbon text stays visible next to the new one). Catalogue C P14 case:
    // ÉVACUATION (Y=12-83) + POMPE (Y=83-127) → 2 stacked ribbons if the erase
    // only covers the new text's zone. We union the tpl span + the new zone.
    const tplY0 = span.bbox[1];
    const tplY1Bottom = span.bbox[3];
    const newY0 = finalY1;
    const newY1Bottom = Math.min(bottomLimit, finalY1 + neededH);
    const textCoverBbox: Bbox = [
      span.bbox[0] - RIBBON_TEXT_PAD,
      Math.min(tplY0, newY0) - RIBBON_TEXT_PAD,
      span.bbox[2] + RIBBON_TEXT_PAD,
      Math.max(tplY1Bottom, newY1Bottom) + RIBBON_TEXT_PAD,
    ];

    // Rotation: 0 if horizontal (page banner), 90 if vertical (rotated edge)
    const ribbonRotation = isHorizontalRibbon ? 0 : 90;
    // For a horizontal ribbon, we keep the tpl span's X-Y anchor without
    // recomputation (the text is written horizontally, no need for neededH).
    const finalInsertBbox: Bbox = isHorizontalRibbon
      ? [span.bbox[0], span.bbox[1], span.bbox[2], span.bbox[3]]
      : insertBbox;
    const finalCoverBbox: Bbox = isHorizontalRibbon
      ? [span.bbox[0] - RIBBON_TEXT_PAD, span.bbox[1] - RIBBON_TEXT_PAD,
         span.bbox[2] + RIBBON_TEXT_PAD, span.bbox[3] + RIBBON_TEXT_PAD]
      : textCoverBbox;

    if (bg) {
      // Preserved-tint pattern: insert_text FIRST (PASS 1 = white auto-erase),
      // then colored erase_rect (PASS 1 = repaint tint on top). PASS 2
      // redraws the text on top of the tinted rect.
      //
      // The first white erase targets the template span's zone (which may be
      // wider than bg.bbox on catalogs where the bg path is shorter than the
      // text). Without it, the original text stays visible if bg < span.
      ops.push({ op: 'erase_rect', bbox: finalCoverBbox });
      ops.push({
        op: 'insert_text',
        bbox: finalInsertBbox,
        text: styled,
        font: span.font,
        size: effectiveSize,
        color: span.color,
        rotation: ribbonRotation,
      });
      ops.push({ op: 'erase_rect', bbox: bg.bbox, color: bg.fill_color });
    } else {
      // Fallback: no colored path found. White erase + insert.
      ops.push({ op: 'erase_rect', bbox: finalCoverBbox });
      ops.push({
        op: 'insert_text',
        bbox: finalInsertBbox,
        text: styled,
        font: span.font,
        size: effectiveSize,
        color: span.color,
        rotation: ribbonRotation,
      });
    }
  }
  return ops;
}

/**
 * For each detected section_banner, finds the colored path that serves as the
 * background (orange/green cartouche). Emits:
 *  - an insert_text with the new label
 *  - a colored erase_rect covering the entire path (tint preserved)
 * The order matters: insert BEFORE erase so that the render's PASS 1 first
 * applies the white auto-erase then the colored rect on top.
 */
function substituteSectionBanners(ctx: SubstituteContext): Operation[] {
  const ops: Operation[] = [];
  const label = (ctx.newSectionLabel ?? '').toUpperCase().trim();
  if (label.length === 0) return ops;
  const banners = ctx.sectionBannerSpans ?? [];
  const paths = ctx.rawPaths ?? [];
  const pageW = ctx.pageWidth;
  for (const span of banners) {
    // Candidate path: wide (> 50% page) + bbox contains the span.
    const bg = paths.find((p) => {
      const pw = p.bbox[2] - p.bbox[0];
      if (pw < pageW * 0.5) return false;
      if (!(p.bbox[1] - 2 <= span.bbox[1] && p.bbox[3] + 2 >= span.bbox[3])) return false;
      if (!(p.bbox[0] - 2 <= span.bbox[0] && p.bbox[2] + 2 >= span.bbox[2])) return false;
      return true;
    });
    if (!bg) {
      // Fallback without a colored path: erase the original text + insert the
      // new label. No colored background preserved, but at least the label is
      // correct (avoids "EVIER" when the section is "BARRES DE DOUCHES").
      // Widened erase proportional to the new label's width (Catalogue C P6
      // case "EVIER" → "EAUX CLAIRES": the new label is 2.4x longer than the
      // template → the erase must extend far enough to the right to clear the
      // whole zone that could display the old text).
      const newLabelWidth = estimateTextWidth(label, span.size);
      const tplWidth = span.bbox[2] - span.bbox[0];
      const eraseWidth = Math.max(newLabelWidth + 8, tplWidth + 10);
      const spanPad: Bbox = [
        span.bbox[0] - 5,
        span.bbox[1] - 3,
        span.bbox[0] + eraseWidth,
        span.bbox[3] + 3,
      ];
      ops.push({ op: 'erase_rect', bbox: spanPad });
      ops.push({
        op: 'insert_text',
        bbox: [span.bbox[0], span.bbox[1], span.bbox[0] + newLabelWidth + 10, span.bbox[3]],
        text: label,
        font: span.font,
        size: span.size,
        color: span.color,
      });
      continue;
    }
    // Preliminary white erase covering the template span's zone (Catalogue C
    // P6 flaw "EAUX CLAIRES": the template span "EVIER" sticks out of the
    // orange bg on the left → residual template "E" visible after the colored
    // erase).
    const preEraseBbox: Bbox = [
      Math.min(span.bbox[0], bg.bbox[0]) - 4,
      span.bbox[1] - 3,
      Math.max(span.bbox[2], bg.bbox[2]) + 4,
      span.bbox[3] + 3,
    ];
    ops.push({ op: 'erase_rect', bbox: preEraseBbox });
    // Insert text (the PASS 1 white auto-erase will then be covered by the
    // colored erase that comes right after).
    ops.push({
      op: 'insert_text',
      bbox: [span.bbox[0], span.bbox[1], bg.bbox[2], span.bbox[3]],
      text: label,
      font: span.font,
      size: span.size,
      color: span.color,
    });
    ops.push({ op: 'erase_rect', bbox: bg.bbox, color: bg.fill_color });
  }
  return ops;
}

/**
 * Polish: for each template span located in a block's zone and NOT covered by
 * an existing op (erase_rect or insert_text), emits a targeted erase_rect.
 * Cleans up the remnants of the original product that would linger in the
 * background after substitution.
 */
function polishResidualSpans(
  spans: TextSpan[],
  blocks: ProductBlock[],
  existingOps: Operation[],
  ctx: SubstituteContext,
): Operation[] {
  // Bboxes already covered by the emitted ops (erase_rect or insert_text)
  const coveredBboxes: Bbox[] = [];
  for (const op of existingOps) {
    if (op.op === 'erase_rect') coveredBboxes.push(op.bbox);
    else if (op.op === 'insert_text') coveredBboxes.push(op.bbox);
  }
  // Each block's zone (header + image + specs + variants), the last block
  // extended toward the footer to absorb residues at the bottom of the page.
  const blockZones = computeBlockZones(blocks, ctx);
  // Global product zone (blocker #3): UNION of blocks + padding to absorb
  // out-of-block decorations (ACS flags, inter-block labels on Catalogue E).
  // Enabled ONLY if all blocks are in horizontal layout (preserves Catalogue
  // A vertical: legacy behavior maintained).
  const allHorizontal =
    blocks.length > 0 && blocks.every((b) => b.isHorizontalLayout === true);
  const globalZone = allHorizontal
    ? computeProductZoneGlobal(blocks, ctx)
    : null;
  const residuals: Bbox[] = [];
  for (const span of spans) {
    if (span.text.trim().length === 0) continue;
    // The span must be IN at least one block zone OR in the global zone
    // (horizontal mode only)
    const inBlock = blockZones.some((z) => intersects(span.bbox, z));
    const inGlobal = globalZone !== null && intersects(span.bbox, globalZone);
    if (!inBlock && !inGlobal) continue;
    // Not covered above 40% by the existing ops (formerly 50%). More
    // permissive to absorb residual template sub-titles like "Exemple" on
    // Catalogue C P5 that partially overlap the new ops.
    if (isCovered(span.bbox, coveredBboxes, 0.4)) continue;
    // 4pt padding: the extracted bboxes do not exactly cover the actual
    // rendered height (ascenders/descenders). 1pt was insufficient, residual
    // pixels visible on Catalogue A variants p-5. 4pt absorbs large Catalogue
    // C glyphs (nameSize 24-28pt).
    residuals.push(padBbox(span.bbox, 4));
  }
  return residuals.map((b) => ({ op: 'erase_rect' as const, bbox: b }));
}

/** Residual bitmap polish: badges, NF/Made in France pictos. Keeps only the
 *  block's mainImageBbox and the variantImages. */
function polishResidualBitmaps(
  images: Bbox[],
  blocks: ProductBlock[],
  existingOps: Operation[],
  ctx: SubstituteContext,
): Operation[] {
  const keepBboxes: Bbox[] = [];
  for (const block of blocks) {
    if (block.mainImageBbox) keepBboxes.push(block.mainImageBbox);
    keepBboxes.push(...block.variantImages);
  }
  // Do not re-erase what has already been erased
  const erased: Bbox[] = existingOps
    .filter((o): o is OpEraseRect => o.op === 'erase_rect')
    .map((o) => o.bbox);
  const blockZones = computeBlockZones(blocks, ctx);
  const ops: Operation[] = [];
  for (const img of images) {
    if (!blockZones.some((z) => intersects(img, z))) continue;
    if (isCovered(img, keepBboxes, 0.5)) continue;
    if (isCovered(img, erased, 0.8)) continue;
    ops.push({ op: 'erase_rect', bbox: padBbox(img, 1) });
  }
  return ops;
}

/** Vector polish: vector badges/pictos in the blocks. Keeps the structural
 *  decorations (ribbons, headers that touch the edges). */
function polishResidualVectors(
  vectors: Bbox[],
  blocks: ProductBlock[],
  ctx: SubstituteContext,
): Operation[] {
  const margin = 30;
  const blockZones = computeBlockZones(blocks, ctx);
  const ops: Operation[] = [];
  for (const v of vectors) {
    if (!blockZones.some((z) => intersects(v, z))) continue;
    const w = v[2] - v[0];
    const h = v[3] - v[1];

    // Structural: covers TWO opposite edges (= full-width banner, vertical
    // ribbon, header band). Stricter than "touches ONE edge" which missed the
    // long bands starting from one side.
    const touchesLeft = v[0] < margin;
    const touchesRight = v[2] > ctx.pageWidth - margin;
    const touchesTop = v[1] < margin;
    const touchesBottom = v[3] > ctx.pageHeight - margin;
    if ((touchesLeft && touchesRight) || (touchesTop && touchesBottom)) {
      continue;
    }

    // P1.5: long structural ribbon touching ONE edge. A narrow vertical
    // cartouche (w<30, h>30%) that touches the top OR the bottom is probably a
    // section ribbon that only goes to mid-page (seen on secondary Catalogue A
    // product pages). Do not erase.
    const isVerticalRibbon = w < 30 && h > ctx.pageHeight * 0.3;
    const isHorizontalRibbon = h < 30 && w > ctx.pageWidth * 0.3;
    if (isVerticalRibbon && (touchesTop || touchesBottom)) continue;
    if (isHorizontalRibbon && (touchesLeft || touchesRight)) continue;

    // Background / header band too massive
    if (w > ctx.pageWidth * 0.7 || h > ctx.pageHeight * 0.5) continue;
    // Small pictos < 6pt: useful separator line, we keep it
    if (w < 6 && h < 6) continue;

    // ABNORMALLY long thin horizontal or vertical line: decorative line (w/h
    // > 30 and thin = < 3pt) → we erase it even if it touches an edge (the
    // "line under the name" that overruns).
    const aspectRatio = Math.max(w, h) / Math.max(1, Math.min(w, h));
    if (aspectRatio > 30 && Math.min(w, h) < 3) {
      ops.push({ op: 'erase_rect', bbox: padBbox(v, 1) });
      continue;
    }

    ops.push({ op: 'erase_rect', bbox: padBbox(v, 1) });
  }
  return ops;
}

export function computeBlockZones(
  blocks: ProductBlock[],
  ctx: SubstituteContext,
): Bbox[] {
  // Sort by yTop to identify the last block of the page (= the one with the
  // lowest yBottom). We extend ITS zone downward to the footer to absorb the
  // color variants / lifestyle image / badges that linger between the last
  // product and the page foot.
  const sorted = [...blocks].sort((a, b) => a.yTop - b.yTop);
  const lastBlock = sorted[sorted.length - 1];
  // Upward padding: 4pt by default, but we extend up to 12pt on blocks that
  // have a sufficiently spaced neighbor ABOVE, to absorb badges like
  // "NOUVEAUTE" / "PROMO" / seasonal pictos that float between 2 blocks and
  // escape the polish (review flaw #8).
  // Capped by the previous block's yBottom (no overlap).
  const BLOCK_TOP_PADDING_DEFAULT = 4;
  const BLOCK_TOP_PADDING_MAX = 12;
  return blocks.map((block) => {
    const isLast = block === lastBlock;
    // Find the block immediately above (yBottom < block.yTop)
    const prevBlock = sorted
      .filter((b) => b.yBottom < block.yTop)
      .sort((a, b) => b.yBottom - a.yBottom)[0];
    const gapAbove = prevBlock
      ? block.yTop - prevBlock.yBottom
      : block.yTop; // no block above → the whole zone up to the page top
    const topPadding = Math.min(
      BLOCK_TOP_PADDING_MAX,
      Math.max(BLOCK_TOP_PADDING_DEFAULT, gapAbove / 2 - 1),
    );
    const yBottom = isLast
      ? Math.max(block.yBottom + 4, ctx.pageHeight - 30)
      : block.yBottom + 4;
    return [
      Math.min(block.nameSpan.bbox[0], block.specsXLeft) - 4,
      block.yTop - topPadding,
      ctx.pageWidth - ctx.profile.ribbonMargin,
      yBottom,
    ] as Bbox;
  });
}

/** Computes a single UNION bbox covering all product blocks of the page +
 *  moderate padding. Used by the "global product zone" polish: we absorb the
 *  decorations (ACS/CSTBat flags, "Diametre 12/16/20" labels on Catalogue E)
 *  that float BETWEEN the blocks and escaped the individual block-zone polish.
 *
 *  Bounds:
 *   - x: min/max across all blocks + padding margin
 *   - y: top of the first block - paddingTop, bottom of the last - paddingBottom
 *
 *  Exclusion: does NOT cover the header/footer margins (top 30pt, bottom
 *  30pt) to preserve section titles + pagination.
 *
 *  Returns null if there are no blocks (nothing to polish globally). */
export function computeProductZoneGlobal(
  blocks: ProductBlock[],
  ctx: SubstituteContext,
  options: { paddingX?: number; paddingY?: number; headerMargin?: number; footerMargin?: number } = {},
): Bbox | null {
  if (blocks.length === 0) return null;
  const paddingX = options.paddingX ?? 8;
  const paddingY = options.paddingY ?? 6;
  const headerMargin = options.headerMargin ?? 30;
  const footerMargin = options.footerMargin ?? 30;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const b of blocks) {
    xMin = Math.min(xMin, b.nameSpan.bbox[0], b.specsXLeft);
    xMax = Math.max(xMax, b.nameSpan.bbox[2], b.specsXLeft + 200);
    yMin = Math.min(yMin, b.yTop);
    yMax = Math.max(yMax, b.yBottom);
  }
  return [
    Math.max(0, xMin - paddingX),
    Math.max(headerMargin, yMin - paddingY),
    Math.min(ctx.pageWidth, xMax + paddingX),
    Math.min(ctx.pageHeight - footerMargin, yMax + paddingY),
  ];
}

function intersects(a: Bbox, b: Bbox): boolean {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

function isCovered(span: Bbox, covered: Bbox[], threshold: number): boolean {
  const spanArea = Math.max(0, (span[2] - span[0]) * (span[3] - span[1]));
  if (spanArea <= 0) return true;
  for (const c of covered) {
    const ix0 = Math.max(span[0], c[0]);
    const iy0 = Math.max(span[1], c[1]);
    const ix1 = Math.min(span[2], c[2]);
    const iy1 = Math.min(span[3], c[3]);
    if (ix1 <= ix0 || iy1 <= iy0) continue;
    const interArea = (ix1 - ix0) * (iy1 - iy0);
    if (interArea / spanArea >= threshold) return true;
  }
  return false;
}

// padBbox: see utils/bbox.ts (factored out, audit #12).

/** Substitutes a template block with a new product (borrowed style). */
export function substituteBlock(
  block: ProductBlock,
  product: PlanProduct,
  ctx: SubstituteContext,
): Operation[] {
  const ops: Operation[] = [];

  // 0. Erase the whole block's background BEFORE any insertion. Covers the
  // permanent template spans that are not explicitly substituted by steps 1-5
  // below (barcodes, sub-titles "LES + PRODUITS", decorative labels, etc.).
  // Without this cleanup, the original content overlaps the new product.
  //
  // Zone: from the left X (min nameSpan / specsXLeft) to the right X (before
  // the ribbon), Y from the top of the name to the bottom of the block.
  // Moderate PAD so as not to spill onto adjacent decorative elements
  // (section banners, vertical ribbon).
  //
  // Top extension: covers an extra zone of ~2 lines above the nameSpan to
  // capture internal titles / tight sub-headers (e.g. Catalogue C "LES +
  // PRODUITS" at Y_title = yTop - 11pt). Calibrated on 2 * nameSize → ~30pt at
  // 15pt. On Catalogue A (3 blocks/page), this extension does not reach the
  // previous block (typical gap ~150pt between 2 blocks).
  //
  // Guard: applies ONLY if the block has a well-defined zone (yBottom > yTop +
  // 20pt). Avoids erasing the whole page in case of a degenerate block.
  const BLOCK_ERASE_PAD = 2;
  const BLOCK_ERASE_TOP_EXTRA_LINES = 2;
  // Clamp yBottom (Catalogue C P6 empty flaw): if yBottom > 85% pageH, we are
  // on the last block with yBottom estimated down to the footer. Without a
  // clamp, the background erase wipes 50%+ of the page without being able to
  // fill it → blank page. Reasonable limit: max(yTop + 300, 85% pageH). 300pt
  // covers a standard product sheet (header + image + 5-7 specs).
  // Conservative Catalogue A cap: on Catalogue A the blocks are ~250pt → 300pt is enough.
  const blockHeight = block.yBottom - block.yTop;
  if (blockHeight > 20) {
    const xLeft = Math.min(block.nameSpan.bbox[0], block.specsXLeft) - BLOCK_ERASE_PAD;
    // In horizontal mode: clamp xRight to the block's column (otherwise the
    // background erase covers the entire page and destroys the neighboring
    // blocks). Catalogue C P14 case: 3 blocks ECOP/ECL/ECL side by side → each
    // full-width erase wiped the others.
    const xRight =
      ctx.horizontalMode !== undefined && ctx.horizontalColRight !== undefined
        ? ctx.horizontalColRight
        : ctx.pageWidth - ctx.profile.ribbonMargin;
    const topExtra = block.nameSpan.size * BLOCK_ERASE_TOP_EXTRA_LINES;
    const yBottomCap = ctx.pageHeight * 0.85;
    const safeYBottom =
      block.yBottom > yBottomCap
        ? Math.max(block.yTop + 300, yBottomCap)
        : block.yBottom;
    ops.push({
      op: 'erase_rect',
      bbox: [
        Math.max(0, xLeft),
        Math.max(0, block.yTop - BLOCK_ERASE_PAD - topExtra),
        xRight,
        safeYBottom + BLOCK_ERASE_PAD,
      ],
    });
  }

  // 1. Product name: adaptive reflow. Tries 1 line at the original size, wraps
  // to 2 lines if needed, shrinks down to 70%, ellipsis as a last resort.
  // Bottom-bound = top of the color/ref so as not to overlap. Horizontal mode
  // (S6.5): rightBound = neighboring block's column (prevents the name from
  // wrapping onto the product on the right). Otherwise legacy = full page.
  const colorTopY = block.colorSpan
    ? block.colorSpan.bbox[1] - 2
    : block.nameSpan.bbox[3] + 12;
  const nameRightBound =
    ctx.horizontalColRight !== undefined && ctx.horizontalMode !== undefined
      ? ctx.horizontalColRight - 4
      : ctx.pageWidth - ctx.profile.ribbonMargin - 6;
  const nameReflow = reflowName({
    text: product.name ?? '',
    span: block.nameSpan,
    rightBound: nameRightBound,
    bottomBound: colorTopY,
    maxLines: 2,
  });
  ops.push(...nameReflow.ops);

  // 2. Color + Ref under the name
  ops.push(...substituteColorAndRef(block, product, ctx.profile));

  // 3. Specs: rewrite at the same positions. V2 = categorized table with dot
  // leader + category headers + responsive layout. V1 = legacy layout
  // (selectable via env REFLOW_SPECS=v1 for comparison/rollback). V1
  // deprecated (Phase 2 refactor): a warning is emitted if enabled.
  const useSpecsV1 = process.env.REFLOW_SPECS === 'v1';
  if (useSpecsV1) {
    warnDeprecatedReflowV1();
    ops.push(...reflowSpecsModule(block, product, ctx));
  } else {
    // Horizontal mode propagation (S6.5) from SubstituteContext to
    // ReflowSpecsV2Context.
    ops.push(
      ...reflowSpecsV2(block, product, {
        ...ctx,
        horizontalMode: ctx.horizontalMode,
        horizontalColRight: ctx.horizontalColRight,
      }),
    );
  }

  // 4. Variants (drop if none, otherwise draw with a MULTI-LINE layout if
  // there are more variants than template positions)
  ops.push(...reflowVariantsModule(block, product, ctx.profile));

  // 5. Main image: we compute a GENEROUS bbox that takes the whole available
  // zone of the block (between header and bottom, up to the specs column).
  // This way a square product image (500x500) is no longer shrunk to 86x86 in
  // the cramped bbox of the template faucet, but inscribed in a typical
  // 200x200. Template image: we ALWAYS erase it (whether we have a source
  // image or not). Otherwise the old Athena/Ravea mixer persists next to the
  // new product (visually inconsistent). If block.mainImageBbox is detected =
  // explicit erase of that bbox + 2pt padding. Otherwise erase the zone
  // computed by computeImageBbox.
  const imageBbox = computeImageBbox(block, ctx);
  if (block.mainImageBbox) {
    const m = block.mainImageBbox;
    ops.push({
      op: 'erase_rect',
      bbox: [m[0] - 2, m[1] - 2, m[2] + 2, m[3] + 2],
    });
  } else {
    ops.push({ op: 'erase_rect', bbox: imageBbox });
  }
  if (product.image_path) {
    const drawImg: OpDrawImage = {
      op: 'draw_image',
      bbox: imageBbox,
      image_path: product.image_path,
      fit: 'contain',
    };
    ops.push(drawImg);
  } else {
    // Tracking: no source image for this product. The block appears erased
    // but without a new image → white zone. Useful to audit an incomplete
    // assets.zip (pipeline audit flaw).
    recordMissingProductImage(block.pageNumber, product.name ?? '(sans nom)');
  }

  return ops;
}

// ─── reflowSpecs V1 deprecation (Phase 2 refactor) ─────────────────────────
let v1DeprecationWarned = false;
function warnDeprecatedReflowV1() {
  if (v1DeprecationWarned) return;
  v1DeprecationWarned = true;
  console.warn(
    '[substitutor] REFLOW_SPECS=v1 est DEPRECATED. Sera supprime dans une '
      + 'version future. Utilisez REFLOW_SPECS=v2 (default) ou unset.',
  );
}

// ─── Stats for products without an image (assets.zip audit) ─────────────────
export interface MissingImageInfo {
  pageNumber: number;
  productName: string;
}
const missingImages: MissingImageInfo[] = [];
function recordMissingProductImage(pageNumber: number, productName: string) {
  missingImages.push({ pageNumber, productName });
  if (process.env.DEBUG_SUBSTITUTOR) {
    console.warn(
      `[substitutor] page=${pageNumber} produit="${productName}" sans image (assets.zip incomplet ?)`,
    );
  }
}
export function getMissingProductImages(): readonly MissingImageInfo[] {
  return missingImages;
}
export function resetMissingProductImages(): void {
  missingImages.length = 0;
}

/**
 * Computes the TARGET bbox of the new product's main image within the block.
 * The render applies fit:'contain', so the source image keeps its ratio and
 * is centered in this bbox.
 *
 * Strategy: large bbox = the whole available zone between the header and the
 * bottom of the block, from the name to the specs column. fit:contain gives:
 *   - square image (mixer) → fits to the zone size
 *   - vertical image (shower bar 1:5) → fills the height, proportional width,
 *     centered horizontally
 *   - landscape image → fills the width, proportional height, centered
 *     vertically
 *
 * We do NOT take the template's bbox (often narrow = mixer ~80x80) because it
 * would crush a vertical image to a few pt wide.
 */
/** Minimum image width threshold (pt) below which the image is considered
 *  visually degenerate (poorly legible). Typical case: dense Catalogue E or a
 *  compact template where specsXLeft is close to the nameSpan. */
const IMAGE_MIN_VISIBLE_WIDTH = 60;
/** Minimum image height threshold (pt) below which the image is considered
 *  visually degenerate (block too short). */
const IMAGE_MIN_VISIBLE_HEIGHT = 60;

export interface DegenerateImageInfo {
  pageNumber: number;
  productName: string;
  bbox: Bbox;
  width: number;
  height: number;
  reason: 'narrow' | 'short' | 'narrow+short';
}
const degenerateImages: DegenerateImageInfo[] = [];
function recordDegenerateImage(info: DegenerateImageInfo) {
  degenerateImages.push(info);
  if (process.env.DEBUG_SUBSTITUTOR) {
    console.warn(
      `[substitutor] page=${info.pageNumber} produit="${info.productName}" image bbox degeneree (${info.width.toFixed(1)}x${info.height.toFixed(1)}pt, raison=${info.reason})`,
    );
  }
}
export function getDegenerateImages(): readonly DegenerateImageInfo[] {
  return degenerateImages;
}
export function resetDegenerateImages(): void {
  degenerateImages.length = 0;
}

function computeImageBbox(block: ProductBlock, _ctx: SubstituteContext): Bbox {
  const xLeftZone = block.nameSpan.bbox[0];
  // Guard: on compact templates, specsXLeft may be <= nameSpan.bbox[0] →
  // degenerate bbox x1 < x0 → PDFium receives a negative matrix.
  const xRightZone = Math.max(xLeftZone + 20, block.specsXLeft - 10);
  const headerBottom =
    (block.colorSpan ? block.colorSpan.bbox[3] : block.nameSpan.bbox[3]) + 12;
  const yTopZone = Math.max(block.yTop + 8, headerBottom);
  // Bottom: the whole block's zone, CAPPED at 320pt to homogenize image sizes
  // across blocks. Otherwise the last block of the page takes all the space
  // down to the footer (~440pt), while a block in the middle is limited by the
  // next block (~330pt) → visible asymmetry.
  const yBotZoneMax = block.yBottom - 6;
  // Adaptive cap: 50% of the page height (vs 40% too conservative which made
  // the images too small on 1-product or 2-product pages with a lot of
  // available space). On A4 portrait (842pt) → 421pt.
  const maxH = _ctx.pageHeight * 0.5;
  const targetH = Math.min(yBotZoneMax - yTopZone, maxH);
  // Clamp: if the block is < 30pt tall, yTopZone+30 would overflow past
  // yBotZoneMax → the image overlaps the next block.
  const yBotZone = Math.min(yTopZone + Math.max(targetH, 30), yBotZoneMax);
  const bbox: Bbox = [xLeftZone, yTopZone, xRightZone, yBotZone];

  // Audit: if the final bbox is visually degenerate, we record it.
  const w = xRightZone - xLeftZone;
  const h = yBotZone - yTopZone;
  const isNarrow = w < IMAGE_MIN_VISIBLE_WIDTH;
  const isShort = h < IMAGE_MIN_VISIBLE_HEIGHT;
  if (isNarrow || isShort) {
    const reason: DegenerateImageInfo['reason'] = isNarrow && isShort
      ? 'narrow+short'
      : isNarrow
        ? 'narrow'
        : 'short';
    recordDegenerateImage({
      pageNumber: block.pageNumber,
      productName: block.nameSpan.text,
      bbox,
      width: w,
      height: h,
      reason,
    });
  }
  return bbox;
}

/** Erases a block's content ("missing product" case). Result: white zone. */
function eraseBlock(block: ProductBlock, ctx: SubstituteContext): Operation[] {
  const ops: Operation[] = [];
  const eraseRight = ctx.pageWidth - ctx.profile.ribbonMargin;
  const eraseLeft = Math.min(block.nameSpan.bbox[0], block.specsXLeft) - 4;
  const yTop = block.yTop - 4;
  const yBot = block.yBottom + 4;
  const blockZone: Bbox = [eraseLeft, yTop, eraseRight, yBot];
  ops.push({ op: 'erase_rect', bbox: blockZone });
  // Main image too
  if (block.mainImageBbox) {
    ops.push({ op: 'erase_rect', bbox: block.mainImageBbox });
  }
  // Variant images too
  for (const v of block.variantImages) {
    ops.push({ op: 'erase_rect', bbox: v });
  }
  // Vector pictos that spill out of the block (promo circles, badges): the
  // global erase_rect covers the inside of the block but a picto may stick out
  // (e.g. "NOUVEAUTE" circle anchored top-left). We individually erase those
  // that intersect the block zone.
  if (ctx.decorationVectors) {
    for (const v of ctx.decorationVectors) {
      if (!intersects(v, blockZone)) continue;
      // Skip structural ones (full-width ribbons)
      const w = v[2] - v[0];
      if (w > ctx.pageWidth * 0.7) continue;
      ops.push({ op: 'erase_rect', bbox: padBbox(v, 1) });
    }
  }
  // Residual bitmaps in the block (NF badges, pictos) except the main image
  if (ctx.rawImages) {
    const keepBboxes: Bbox[] = [];
    if (block.mainImageBbox) keepBboxes.push(block.mainImageBbox);
    keepBboxes.push(...block.variantImages);
    for (const img of ctx.rawImages) {
      if (!intersects(img, blockZone)) continue;
      if (isCovered(img, keepBboxes, 0.5)) continue;
      ops.push({ op: 'erase_rect', bbox: padBbox(img, 1) });
    }
  }
  return ops;
}

// ─── Atomic substitutions ─────────────────────────────────────────────────────

interface InsertAtSpanOptions {
  /** Forces the right edge of the erase bbox to this X. Useful for the product
   *  name (erases the template's horizontal decorative line). */
  eraseToRight?: number;
}

/**
 * Insert_text at the same place as an existing span. Extends the bbox to the
 * right if the new text is longer, or if eraseToRight is provided (forces the
 * erase further to absorb decorative elements).
 */
function insertAtSpan(
  span: TextSpan,
  newText: string,
  options: InsertAtSpanOptions = {},
): OpInsertText {
  // P0.4: translate the exotic glyphs (smart quotes, ligatures, …) into
  // nearest ASCII. Without it, the Helvetica fallback (font name not found)
  // shows `.notdef` (empty rectangle) on '–', 'œ', '…', etc.
  const safe = safeText(newText);
  const oldLen = span.text.trim().length;
  const newLen = safe.length;
  const naturalExtension =
    newLen > oldLen ? (newLen - oldLen) * span.size * TEXT_WIDTH_COEFS.mixed : 0;
  const xRight = options.eraseToRight
    ? Math.max(span.bbox[2] + naturalExtension, options.eraseToRight)
    : span.bbox[2] + naturalExtension;
  const bbox: Bbox = [span.bbox[0], span.bbox[1], xRight, span.bbox[3]];
  return {
    op: 'insert_text',
    bbox,
    text: safe,
    font: span.font,
    size: span.size,
    // safeTextColor: switches to black if span.color is very light (Catalogue
    // C case where the product names are white on a colored cartouche that is
    // erased by the block background erase → invisible white text).
    color: safeTextColor(span.color),
  };
}

/**
 * Substitutes color + ref. 3 cases:
 *  1. 2 distinct spans (separate color + ref) → 2 independent inserts
 *  2. a single detected span (case "Chromé 304740 4050955" in 1 span) → 1 combined insert
 *  3. no span → fallback under the name
 */
function substituteColorAndRef(
  block: ProductBlock,
  product: PlanProduct,
  profile: TemplateProfile,
): Operation[] {
  const ops: Operation[] = [];
  const newColor = (product.color ?? '').trim();
  const newRef = (product.ref ?? '').trim();
  if (!newColor && !newRef) return ops;

  // Case 1: 2 distinct spans
  if (block.colorSpan && block.refSpan && block.colorSpan !== block.refSpan) {
    // EXPLICIT erase covering the whole color+ref zone BEFORE the inserts.
    // Otherwise each insert_text's white auto-erase leaves a gap between the
    // end of the color insert (white auto-erase x0..x_color_end) and the start
    // of the ref insert (white auto-erase refX..refX_end), in which the old
    // start of the template ref ("304740") stays visible (seen as "₃₀"
    // between "Chromé" and the new ref).
    const colorWidth = newColor
      ? newColor.length * block.colorSpan.size * TEXT_WIDTH_COEFS.upper
      : 0;
    const renderedColorEnd = block.colorSpan.bbox[0] + colorWidth;
    const minRefX = renderedColorEnd + profile.colorRefSpacing;
    const refX = Math.max(block.refSpan.bbox[0], minRefX);
    const shift = refX - block.refSpan.bbox[0];
    const eraseY0 = Math.min(block.colorSpan.bbox[1], block.refSpan.bbox[1]) - 2;
    const eraseY1 = Math.max(block.colorSpan.bbox[3], block.refSpan.bbox[3]) + 2;
    const eraseX1 = block.refSpan.bbox[2] + shift + 2;
    ops.push({
      op: 'erase_rect',
      bbox: [block.colorSpan.bbox[0] - 2, eraseY0, eraseX1, eraseY1],
    });
    if (newColor) ops.push(insertAtSpan(block.colorSpan, newColor));
    if (newRef) {
      ops.push({
        op: 'insert_text',
        bbox: [refX, block.refSpan.bbox[1], block.refSpan.bbox[2] + shift, block.refSpan.bbox[3]],
        text: safeText(newRef),
        font: block.refSpan.font,
        size: block.refSpan.size,
        color: block.refSpan.color,
      });
    }
    return ops;
  }

  // Case 2: a single combined span
  const singleSpan = block.colorSpan ?? block.refSpan;
  if (singleSpan) {
    const combined = [newColor, newRef].filter(Boolean).join('  ');
    ops.push(insertAtSpan(singleSpan, combined));
    return ops;
  }

  // Case 3: fallback under the name
  // High gap (= size + 6) to avoid an overlap if the C++ render interprets
  // bbox[1] as the TOP of the text vs the baseline (case observed on Catalogue
  // C: the ref rose up into the name → "AG2236TAR 900" instead of "AQUASTAR
  // 900"). On top of that we emit an explicit erase of the zone under the name
  // BEFORE the insert to ensure no template residue appears behind the ref.
  const fallbackText = [newColor, newRef].filter(Boolean).join('  ');
  if (!fallbackText.trim()) return ops;
  const nameBbox = block.nameSpan.bbox;
  const fbSize = profile.colorRefSizeRange[0];
  const fbY0 = nameBbox[3] + fbSize + 6.0;
  const fbY1 = fbY0 + fbSize + 4.0;
  const fbX0 = nameBbox[0];
  const fbX1 = nameBbox[2] + 150;
  // Explicit erase UNDER the name (visually separates the name from the ref
  // and erases any residual template span in this zone).
  ops.push({
    op: 'erase_rect',
    bbox: [fbX0 - 2, nameBbox[3] + 2, fbX1, fbY1 + 2],
  });
  ops.push({
    op: 'insert_text',
    bbox: [fbX0, fbY0, fbX1, fbY1],
    text: safeText(fallbackText),
    font: profile.headerColorFontPattern,
    size: fbSize,
    color: '#231f20',
  });
  return ops;
}

// ─── Text width helper ────────────────────────────────────────────────────────

/**
 * Width coefficients for estimateTextWidth.
 * UPPER = tabular uppercase (titles, refs). DIGITS = digits. MIXED =
 * lowercase/mixed fallback. These values are calibrated on Almanach-* but hold
 * for most regular-weight sans-serif fonts.
 *
 * If you change these coefs, check the render on:
 *   - long product names (estimateTextWidth in reflowSpecs)
 *   - the natural extension in insertAtSpan around line ~360
 */
export const TEXT_WIDTH_COEFS = {
  upper: 0.65,
  digits: 0.6,
  mixed: 0.55,
} as const;


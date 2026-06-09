/**
 * @deprecated reflowSpecs V1 — DEPRECATED since the Phase 2 refactor.
 * Kept only for rollback via REFLOW_SPECS=v1. The default path is
 * reflowSpecsV2.ts. Will be removed in a future version.
 *
 * reflowSpecs — substitutes a product's specs (key/value) while respecting
 * the template geometry, with OVERFLOW handling (more specs than the
 * planned lines).
 *
 * Strategies:
 *
 *  Case 1 — n_new <= n_tpl (normal): emit n_new specs at the template
 *  positions, adjusting the value size uniformly (shrink down to 78%) so
 *  they fit on 1 line. If a value overflows even at the min size: wrap to
 *  2 lines + ellipsis as a last resort.
 *
 *  Case 2 — n_new > n_tpl (OVERFLOW): compute an adaptive yStep to fit ALL
 *  the new specs into the available zone. If the adaptive yStep is too tight
 *  for legibility (< refSize * 1.10), capture the max that fits and signal
 *  "+N autres" on the last line.
 *
 *  Case 3 — n_new < n_tpl (underflow): emit n_new specs at the template
 *  positions; the remaining lines are erased but not filled (bunched at the
 *  top). Deliberate choice: avoid the "ballooned" effect of stretching
 *  yStep, and the zone stays visually consistent with the rest of the block.
 */

import type { Bbox, Operation, PlanProduct } from '../../types';
import type { ProductBlock } from '../blockDetector';
import type { TemplateProfile } from '../profile';
import { safeText } from '../safeText';
import { estimateTextWidth, splitForWrap, cleanupLineEnd } from './fit';
import { styleKeyFromTemplate } from './keyStyle';

const VALUE_FONT_SHRINK_MIN_RATIO = 0.78;
const VALUE_FONT_SHRINK_STEP = 0.25;
const SPEC_MIN_YSTEP_RATIO = 1.10;
/** Default yStep ratio (template line spacing) when we can't measure a
 *  median over the existing specs (= a single spec, or aberrant gaps).
 *  Calibrated on Catalogue A: refSize 11pt → yStep 14.5pt. Trade-off between
 *  legibility (>= 1.32x) and compaction (<= 1.4x). Minor audit. */
const DEFAULT_YSTEP_RATIO = 1.32;
/** On overflow when we capture the max, keep at least this many before
 *  writing "+N autres". Avoids "+8 autres" on a near-empty page. */
const SPEC_OVERFLOW_RESERVE = 1;

export interface ReflowSpecsContext {
  pageWidth: number;
  profile: TemplateProfile;
}

export function reflowSpecs(
  block: ProductBlock,
  product: PlanProduct,
  ctx: ReflowSpecsContext
): Operation[] {
  const ops: Operation[] = [];
  const newSpecs = product.specs ?? [];
  const tplSpecs = block.specs;

  // Erase global zone specs
  const eraseRight = ctx.pageWidth - ctx.profile.ribbonMargin;
  const eraseBbox: Bbox = [
    block.specsXLeft - 2.0,
    block.specsYTop - 4.0,
    eraseRight,
    block.specsYBottom + 6.0,
  ];
  ops.push({ op: 'erase_rect', bbox: eraseBbox });

  if (newSpecs.length === 0 || tplSpecs.length === 0) return ops;

  // ── Base geometry from the template ─────────────────────────────────────
  const firstY = tplSpecs[0].key.bbox[1];
  const refSize = tplSpecs[0].key.size;

  // Median template yStep (fallback: DEFAULT_YSTEP_RATIO if a single spec)
  let yStepTpl = refSize * DEFAULT_YSTEP_RATIO;
  if (tplSpecs.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < tplSpecs.length; i++) {
      const gap = tplSpecs[i].key.bbox[1] - tplSpecs[i - 1].key.bbox[1];
      if (gap > 0 && gap < refSize * 2.0) gaps.push(gap);
    }
    if (gaps.length > 0) {
      gaps.sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)];
      yStepTpl = Math.max(refSize * DEFAULT_YSTEP_RATIO, median);
    }
  }

  // ── Overflow / normal / underflow decision ──────────────────────────────
  const n_new = newSpecs.length;
  const n_tpl = tplSpecs.length;

  // For overflow: compute the adaptive yStep and effective max count
  const availableH = block.specsYBottom - firstY;
  const minStep = refSize * SPEC_MIN_YSTEP_RATIO;
  let n_effective = n_new;
  let yStep = yStepTpl;
  let overflowSurplus = 0;

  if (n_new > n_tpl) {
    // How many fit at the template yStep?
    const fitsAtTpl = Math.floor(availableH / yStepTpl) + 1;
    if (fitsAtTpl >= n_new) {
      // Fits at the template yStep (rare but possible if availableH is large)
      n_effective = n_new;
      yStep = yStepTpl;
    } else {
      // Compaction: yStep adapted to fit everything
      const compactedStep = availableH / Math.max(1, n_new - 1);
      if (compactedStep >= minStep) {
        // Acceptable compaction → everything fits
        yStep = compactedStep;
        n_effective = n_new;
      } else {
        // Too tight: capture the max that fits at minStep + reserve 1
        // line for the "+N autres" signal
        const maxAtMinStep = Math.floor(availableH / minStep) + 1;
        n_effective = Math.max(SPEC_OVERFLOW_RESERVE, maxAtMinStep - 1);
        if (n_effective >= n_new) {
          n_effective = n_new;
        } else {
          overflowSurplus = n_new - n_effective;
        }
        yStep = minStep;
      }
    }
  }

  // ── Pre-pass: compute widths and uniform value size ─────────────────────
  interface RowComputed {
    tplKeyIdx: number; // index into tplSpecs (capped at n_tpl-1 when extrapolating)
    keyText: string;
    keyX: number;
    keyEndX: number;
    valueX: number;
    availableW: number;
    safeVal: string;
    originalValSize: number;
    keyFont: string;
    keyColor: string;
    keySize: number;
    valFont: string;
    valColor: string;
  }
  const rows: RowComputed[] = [];
  for (let i = 0; i < n_effective; i++) {
    // For i >= n_tpl, extrapolate from the last tplSpec
    const tplIdx = Math.min(i, n_tpl - 1);
    const tplKey = tplSpecs[tplIdx].key;
    const tplVal = tplSpecs[tplIdx].values[0];
    const newSpec = newSpecs[i];
    const keyText = styleKeyFromTemplate(newSpec.key, tplKey.text);
    const estKeyW = estimateTextWidth(keyText, tplKey.size) * 1.08;
    const tplKeyW = tplKey.bbox[2] - tplKey.bbox[0];
    const keyEndX = tplKey.bbox[0] + Math.max(tplKeyW, estKeyW);
    const minGap = tplKey.size * 0.3;
    const tplGap = tplVal ? Math.max(minGap, tplVal.bbox[0] - tplKey.bbox[2]) : minGap;
    const valueX = keyEndX + tplGap; // will be overwritten by the uniform colValueX below
    const valueText = (newSpec.values ?? []).join(', ').trim();
    const safeVal = safeText(valueText);
    const originalValSize = tplVal?.size ?? tplKey.size;
    rows.push({
      tplKeyIdx: tplIdx,
      keyText, keyX: tplKey.bbox[0], keyEndX, valueX, availableW: 0, safeVal,
      originalValSize,
      keyFont: tplKey.font, keyColor: tplKey.color, keySize: tplKey.size,
      valFont: tplVal?.font ?? tplKey.font, valColor: tplVal?.color ?? tplKey.color,
    });
  }

  // ─── Uniform VALUE COLUMN alignment ──────────────────────────────────────
  // Instead of placing each value right after its own key (per-row valueX,
  // visually scattered), align all values to a single column = max(valueX)
  // across all rows. Gives a cleaner read.
  const colValueX = rows.length > 0
    ? Math.max(...rows.map((r) => r.valueX))
    : block.specsXLeft;
  const colAvailableW = Math.max(20, eraseRight - colValueX);
  for (const r of rows) {
    r.valueX = colValueX;
    r.availableW = colAvailableW;
  }

  // Uniform value size (shrink down to 78% to fit everything on 1 line)
  const refValSize = rows[0]?.originalValSize ?? refSize;
  const floorSize = refValSize * VALUE_FONT_SHRINK_MIN_RATIO;
  let uniformValSize = refValSize;
  for (const r of rows) {
    if (!r.safeVal) continue;
    let s = uniformValSize;
    while (estimateTextWidth(r.safeVal, s) > r.availableW && s > floorSize) {
      s -= VALUE_FONT_SHRINK_STEP;
    }
    if (s < uniformValSize) uniformValSize = s;
  }

  // ── Emit ops per row ─────────────────────────────────────────────────────
  // Cumulative yOffset: shifts the following rows when a previous row wrapped
  // to 2 lines (otherwise line 2 overlaps the key of the next row).
  let yOffset = 0;
  let emittedCount = 0;
  let runtimeTruncated = 0;
  for (let i = 0; i < n_effective; i++) {
    const r = rows[i];
    const tplKey = tplSpecs[r.tplKeyIdx].key;
    const lineH = tplKey.bbox[3] - tplKey.bbox[1];
    const keyY0 = firstY + i * yStep + yOffset;
    const keyY1 = keyY0 + lineH;

    // Runtime stop ONLY if we already compacted yStep (upstream overflow)
    // and we leave the zone. If yStep = template yStep, we accept a slight
    // overflow (legacy behavior: the next block has its own erases that will
    // cover it, and more importantly: we don't lose the spec).
    const hasCompacted = yStep < yStepTpl;
    if (hasCompacted && keyY1 > block.specsYBottom + 4) {
      runtimeTruncated = n_effective - i;
      break;
    }

    ops.push({
      op: 'insert_text',
      bbox: [r.keyX, keyY0, r.keyEndX, keyY1],
      text: safeText(r.keyText),
      font: r.keyFont,
      size: r.keySize,
      color: r.keyColor,
    });
    emittedCount = i + 1;

    if (!r.safeVal) continue;
    const fullVal = r.safeVal;
    const fullW = estimateTextWidth(fullVal, uniformValSize);
    if (fullW <= r.availableW) {
      ops.push({
        op: 'insert_text',
        bbox: [r.valueX, keyY0, Math.min(eraseRight, r.valueX + fullW), keyY1],
        text: fullVal,
        font: r.valFont,
        size: uniformValSize,
        color: r.valColor,
      });
    } else {
      // Wrap to 2 lines via semantic breakpoints (', et, ou, /, -, ;...).
      const split = splitForWrap(fullVal, r.availableW, uniformValSize);
      const line1 = split.line1;
      const line1W = estimateTextWidth(line1, uniformValSize);
      ops.push({
        op: 'insert_text',
        bbox: [r.valueX, keyY0, Math.min(eraseRight, r.valueX + line1W), keyY1],
        text: line1,
        font: r.valFont,
        size: uniformValSize,
        color: r.valColor,
      });
      if (split.line2) {
        let line2 = split.line2;
        let l2W = estimateTextWidth(line2, uniformValSize);
        if (l2W > r.availableW) {
          // Line 2 overflows → truncate with ellipsis (cleanup particles).
          const ellW = estimateTextWidth('…', uniformValSize);
          while (line2.length > 4 && estimateTextWidth(line2, uniformValSize) + ellW > r.availableW) {
            line2 = line2.slice(0, -1);
          }
          line2 = cleanupLineEnd(line2) + '…';
          l2W = estimateTextWidth(line2, uniformValSize);
        }
        const y2 = keyY0 + yStep * 0.5;
        ops.push({
          op: 'insert_text',
          bbox: [r.valueX, y2, Math.min(eraseRight, r.valueX + l2W), y2 + lineH],
          text: line2,
          font: r.valFont,
          size: uniformValSize,
          color: r.valColor,
        });
        // Shift the following rows to keep the 2nd wrap line from
        // overlapping the key of row n+1.
        const wrapGap = 2;
        const extra = Math.max(0, lineH + wrapGap - yStep * 0.5);
        yOffset += extra;
      }
    }
  }

  // Accumulate surpluses: upstream overflow + runtime truncated (wraps
  // consume more room than planned)
  overflowSurplus += runtimeTruncated;

  // ── Overflow surplus signal ──────────────────────────────────────────────
  if (overflowSurplus > 0 && rows.length > 0) {
    const last = rows[Math.max(0, emittedCount - 1)];
    const tplKeyLast = tplSpecs[last.tplKeyIdx].key;
    // Position based on emittedCount + cumulative yOffset (accounts for the
    // wraps that consumed vertical budget)
    const noteY0 = firstY + emittedCount * yStep + yOffset;
    if (noteY0 + tplKeyLast.bbox[3] - tplKeyLast.bbox[1] <= block.specsYBottom + 4) {
      ops.push({
        op: 'insert_text',
        bbox: [last.keyX, noteY0, eraseRight, noteY0 + (tplKeyLast.bbox[3] - tplKeyLast.bbox[1])],
        text: `+ ${overflowSurplus} autre${overflowSurplus > 1 ? 's' : ''} caractéristique${overflowSurplus > 1 ? 's' : ''}`,
        font: last.valFont,
        size: uniformValSize * 0.92,
        color: last.valColor,
      });
    }
  }

  return ops;
}

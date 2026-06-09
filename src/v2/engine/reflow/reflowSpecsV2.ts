/**
 * reflowSpecsV2 — overhaul of the product specs rendering.
 *
 * Design: 2-column table (key + dot leader + value) with grouping by
 * category (TECHNIQUE / DIMENSIONS / FINITION / GARANTIE /
 * CONDITIONNEMENT / AUTRES). Category headers in small bold, thin
 * separators between groups.
 *
 * Responsive:
 *  - few (≤ 3 specs)     → no categories, airy view + wide line spacing
 *  - medium (4-8 specs)  → standard categorized table
 *  - many (> 8 specs)    → compact table (value font shrink + tight line
 *                          spacing to fit everything)
 *
 * Column layout:
 *  - keyX  = block.specsXLeft (inherited from template)
 *  - valX  = max(keyEndX) + uniform gap across all rows
 *  - valW  = pageWidth - ribbonMargin - valX
 *  - dot leader between keyEnd and valX in a very light gray
 *
 * Categorization: regex on the keys (case-insensitive), AUTRES fallback.
 *
 * Anti-overflow: if the zone still overflows even after font shrink, we
 * signal "+N autres" on the last visible row (like reflowSpecs V1).
 */

import type { Bbox, Operation, PlanProduct, PlanProductSpec } from '../../types';
import type { ProductBlock } from '../blockDetector';
import type { TemplateProfile } from '../profile';
import { safeText } from '../safeText';
import { estimateTextWidth, splitForWrap, cleanupLineEnd } from './fit';
import { normalizeValue } from './normalizeValue';
import { styleKeyFromTemplate } from './keyStyle';

// ── Categorization ──────────────────────────────────────────────────────────

export type CategoryKey =
  | 'TECHNIQUE'
  | 'DIMENSIONS'
  | 'FINITION'
  | 'GARANTIE'
  | 'CONDITIONNEMENT'
  | 'AUTRES';

interface CategoryDef {
  key: CategoryKey;
  /** Label shown in the header. */
  label: string;
  /** Regex matching the keys (case-insensitive). */
  re: RegExp;
}

/** Display order of categories when several are present: we favor technique
 *  first, then dimensions, finition, garantie, conditionnement, and finally
 *  the others. */
const CATEGORIES: CategoryDef[] = [
  // TECHNIQUE: material / mechanism / flow / pressure / temperature / standard
  // Multi-language: FR + EN (material/mechanism/flow/pressure/temperature/standard)
  //               + DE (material/druck) + IT/ES (materia/presion) + PT (materia)
  { key: 'TECHNIQUE', label: 'Technique',
    re: /mati(?:è|e)re|material|materia|m(?:é|e)canisme|mechanism|meccanismo|m(?:é|e)ca\b|d(?:é|e)bit|flow|pression|pressure|druck|presion|temp(?:é|e)rature|temperature|norme|standard|certif|(?:é|e)nerg(?:é|e)tique|energy|(?:é|e)nergi|raccord|fitting|alim|power|cartouche|cartridge/i },
  // DIMENSIONS: length / width / height / depth / thickness / size / format
  // Multi-language: FR + EN (length/width/height/depth/thickness/size/format)
  //               + DE (länge/breite/höhe/tiefe — translit) + IT (lunghezza/larghezza/altezza)
  //               + ES (longitud/anchura/altura/profundidad)
  { key: 'DIMENSIONS', label: 'Dimensions',
    re: /longueur|length|longitud|lunghezza|comprimento|laenge|l(?:ä|a)nge|diam(?:è|e)tre|diameter|diametro|durchmesser|hauteur|height|altura|altezza|h(?:ö|o)he|largeur|width|anchura|larghezza|breite|profondeur|depth|profundidad|profondit|tiefe|(?:é|e)paisseur|thickness|espesor|spessore|dicke|taille|size|tama|format|capacit|capacity|capacidad|capacita|encombrement|entr(?:é|e)es?\s+axes/i },
  // FINITION: color / finish / aspect / texture
  // Multi-language: FR + EN (color/finish/aspect/texture) + DE (farbe/oberflache)
  //               + IT (colore/finitura) + ES (color/acabado) + PT (cor/acabamento)
  { key: 'FINITION', label: 'Finition',
    re: /coloris|finition|finish|couleur|color|colour|farbe|cor\b|colore|aspect|aspecto|texture|textur|oberfl(?:ä|a)che|acabado|acabamento|finitura/i },
  // GARANTIE: duration / durability / after-sales service
  // Multi-language: FR + EN (warranty/durability/service) + DE (garantie/dauer)
  //               + IT (garanzia/durata) + ES (garantia/duracion) + PT (garantia/duracao)
  { key: 'GARANTIE', label: 'Garantie',
    re: /garantie|warranty|garant[ií]a|garanzia|dur(?:é|e)e|duration|durata|duracao|duraci(?:ó|o)n|dauer|durabilit|durability|sav\b|service/i },
  // CONDITIONNEMENT: packaging / box / carton / blister
  // Multi-language: FR + EN (packaging/box) + DE (verpackung/karton)
  //               + IT (imballaggio/scatola) + ES (embalaje/caja) + PT (embalagem/caixa)
  { key: 'CONDITIONNEMENT', label: 'Conditionnement',
    re: /conditionnement|emballage|packaging|embalaje|embalagem|imballaggio|verpackung|condit\.?|nature.*conditionnement|carton|karton|cartone|caja|caixa|bo[iî]te|box|scatola|coque|blister/i },
];

/** Categorizes a key into a CategoryKey. No-match case → AUTRES. */
export function categorize(key: string): CategoryKey {
  const k = key.trim();
  for (const cat of CATEGORIES) {
    if (cat.re.test(k)) return cat.key;
  }
  return 'AUTRES';
}

interface SpecWithCat {
  spec: PlanProductSpec;
  category: CategoryKey;
}

interface CategoryGroup {
  key: CategoryKey;
  label: string;
  specs: PlanProductSpec[];
}

/** Distributes the specs by category, preserving the original order of
 *  appearance within each category. Empty categories are dropped. */
export function groupByCategory(specs: PlanProductSpec[]): CategoryGroup[] {
  const withCat: SpecWithCat[] = specs.map((s) => ({ spec: s, category: categorize(s.key) }));
  const groups: CategoryGroup[] = [];
  const known: CategoryKey[] = ['TECHNIQUE', 'DIMENSIONS', 'FINITION', 'GARANTIE', 'CONDITIONNEMENT', 'AUTRES'];
  for (const cat of known) {
    const matching = withCat.filter((w) => w.category === cat).map((w) => w.spec);
    if (matching.length === 0) continue;
    const def = CATEGORIES.find((c) => c.key === cat);
    groups.push({ key: cat, label: def ? def.label : 'Autres', specs: matching });
  }
  return groups;
}

// ── Layout constants ────────────────────────────────────────────────────────

/** Shrink floor relative to the STARTING size. 0.88 = we tolerate at most a
 *  12% reduction, otherwise we wrap. Higher than V1 (0.72) to keep the
 *  values nicely legible. */
const VALUE_FONT_SHRINK_MIN_RATIO = 0.88;
const VALUE_FONT_SHRINK_STEP = 0.25;
/** MIN width reserved for the value column (pt). Forces truncation or
 *  shrinking of long keys when necessary, rather than letting the keys
 *  colonize the whole width and shrink the value column to almost nothing. */
const MIN_VALUE_COL_W = 110;
/** Shrink floor applied to the KEYS when they exceed the imposed colValueX
 *  cap. */
const KEY_FONT_SHRINK_MIN_RATIO = 0.80;
const KEY_VAL_GAP = 8;
const DOT_LEADER_CHAR = '·';
const DOT_LEADER_COLOR = '#bdbdbd';
const SEPARATOR_COLOR = '#e5e5e5';
const SEPARATOR_THICKNESS = 0.4;
const SEPARATOR_GAP_PT = 4;
const CATEGORY_HEADER_SIZE_RATIO = 0.85;
const CATEGORY_HEADER_COLOR = '#666666';
const CATEGORY_HEADER_GAP_PT = 2;
/** Threshold for switching to airy mode (no category headers). */
const FEW_SPECS_THRESHOLD = 3;
/** Threshold for switching to compact mode (font shrink + tight line spacing). */
const MANY_SPECS_THRESHOLD = 9;
/** Max line spacing for the airy view: we don't want to spread out excessively. */
const AERATED_LINE_SPACING_RATIO = 1.60;
const STANDARD_LINE_SPACING_RATIO = 1.35;
const COMPACT_LINE_SPACING_RATIO = 1.10;

// Key style (inherited from template): see reflow/keyStyle.ts — consolidated
// implementation (audit #5) shared with reflowSpecs.ts.

// ── Entry point ─────────────────────────────────────────────────────────────

export interface ReflowSpecsV2Context {
  pageWidth: number;
  profile: TemplateProfile;
  /** Horizontal multi-column mode (S6.5).
   *  - 'vertical' (default): standard layout, 1 product per block.
   *  - 'horizontal-primary': 1st block of a horizontal row (emits keys in
   *    the shared left column + values in its own column).
   *  - 'horizontal-secondary': following block of a horizontal row (emits
   *    ONLY its values in its column, not the keys).
   *
   *  When unspecified: 'vertical'. Backward-compatible behavior. */
  horizontalMode?: 'vertical' | 'horizontal-primary' | 'horizontal-secondary';
  /** Right X of the current block's column (horizontal mode).
   *  Beyond it: the neighboring block's zone → avoid erasing/inserting there. */
  horizontalColRight?: number;
}

export function reflowSpecsV2(
  block: ProductBlock,
  product: PlanProduct,
  ctx: ReflowSpecsV2Context
): Operation[] {
  const ops: Operation[] = [];
  const newSpecs = product.specs ?? [];
  const tplSpecs = block.specs;
  if (tplSpecs.length === 0) return ops;

  // Erase zone = full specs width up to the ribbon margin.
  // Clamp protection: if specsYTop < nameSpan.bbox[3] (e.g. dense Catalogue E),
  // the erase would bite into the nameSpan already inserted by reflowName.
  // We force eraseTop >= nameSpan.bbox[3] + 1 (1pt gap) to preserve the name.
  //
  // Horizontal mode (S6.5): in both horizontal-primary AND horizontal-secondary,
  // we limit the erase to the block's column (horizontalColRight) so we don't
  // erase the content of neighboring blocks in the same row. Before the fix,
  // only the secondary was clamped → primary erased the full page BEFORE
  // secondary → erase/insert ordering conflict.
  const isHorizontal =
    ctx.horizontalMode === 'horizontal-secondary'
    || ctx.horizontalMode === 'horizontal-primary';
  const isHorizontalSecondary = ctx.horizontalMode === 'horizontal-secondary';
  const eraseRight = isHorizontal && ctx.horizontalColRight !== undefined
    ? ctx.horizontalColRight
    : ctx.pageWidth - ctx.profile.ribbonMargin;
  const nameBottom = block.nameSpan?.bbox?.[3];
  const rawEraseTop = block.specsYTop - 4;
  const safeEraseTop =
    typeof nameBottom === 'number'
      ? Math.max(rawEraseTop, nameBottom + 1)
      : rawEraseTop;
  // Left pad widened (-12 vs -2) to absorb long template keys that may start
  // 2-6pt to the left of specsXLeft (PDFium baseline jitter + glyph metrics).
  // Catalogue C P6 "DIAMÈTREÈTRE" bug: old template "Diamètre :" not erased
  // by the background erase, new "DIAMÈTRE MAXIMUM..." written over it →
  // visual overlap.
  const eraseBbox: Bbox = [
    block.specsXLeft - 12,
    safeEraseTop,
    eraseRight,
    block.specsYBottom + 6,
  ];
  ops.push({ op: 'erase_rect', bbox: eraseBbox });

  if (newSpecs.length === 0) return ops;

  // Template style: inherited from the 1st template spec (font/size/color key + value)
  const refKey = tplSpecs[0].key;
  const refVal = tplSpecs[0].values[0] ?? refKey;
  const refKeyFont = refKey.font;
  const refKeySize = refKey.size;
  const refKeyColor = refKey.color;
  const refValFont = refVal.font;
  const refValSize = refVal.size;
  const refValColor = refVal.color;

  // ── Responsive mode decision ────────────────────────────────────────────
  const n = newSpecs.length;
  const aerated = n <= FEW_SPECS_THRESHOLD;
  const compact = n >= MANY_SPECS_THRESHOLD;
  const useCategories = !aerated;

  // Grouping (if categorized table mode)
  const groups = useCategories
    ? groupByCategory(newSpecs)
    : [{ key: 'AUTRES' as CategoryKey, label: '', specs: newSpecs }];

  // ── Width computation: uniform value column = max(keyEndX) ──────────────
  // We precompute each styled key + its estimated width to decide valX.
  // keySize may be shrunk if the keys overflow the colValueX cap.
  let keyFontSize = refKeySize;
  const keyFloorSize = refKeySize * KEY_FONT_SHRINK_MIN_RATIO;
  interface RowInfo {
    keyText: string;
    keyEndX: number;
    safeVal: string;
  }
  // colValueX cap: we keep at least MIN_VALUE_COL_W for the value column.
  // Prevents a very long key ("DUREE DE GARANTIE (EN ANNEES) :") from pushing
  // colValueX too far right and shrinking the value zone to almost nothing.
  const colValueXCap = eraseRight - MIN_VALUE_COL_W;

  function computeKeyEnd(keyText: string, size: number): number {
    const estKeyW = estimateTextWidth(keyText, size) * 1.08;
    const tplKeyW = refKey.bbox[2] - refKey.bbox[0];
    return block.specsXLeft + Math.max(tplKeyW, estKeyW);
  }

  // 1st pass: keys at full size
  const rowInfos: RowInfo[] = [];
  for (const g of groups) {
    for (const s of g.specs) {
      const keyText = styleKeyFromTemplate(s.key, refKey.text);
      const keyEndX = computeKeyEnd(keyText, keyFontSize);
      // Per-value normalization (unit spaces, case) BEFORE the join, so the
      // rules apply to each individual value.
      const valueText = (s.values ?? []).map(normalizeValue).join(', ').trim();
      rowInfos.push({ keyText, keyEndX, safeVal: safeText(valueText) });
    }
  }
  // If a key exceeds the cap: shrink the block's keys uniformly
  let maxKeyEndX = rowInfos.length > 0
    ? Math.max(...rowInfos.map((r) => r.keyEndX))
    : block.specsXLeft;
  if (maxKeyEndX + KEY_VAL_GAP > colValueXCap && rowInfos.length > 0) {
    while (keyFontSize > keyFloorSize
        && maxKeyEndX + KEY_VAL_GAP > colValueXCap) {
      keyFontSize -= 0.25;
      // recalc maxKeyEndX
      maxKeyEndX = Math.max(
        ...rowInfos.map((r) => computeKeyEnd(r.keyText, keyFontSize))
      );
    }
    // Update the recomputed keyEndX with the new keyFontSize
    for (const r of rowInfos) {
      r.keyEndX = computeKeyEnd(r.keyText, keyFontSize);
    }
  }
  // Horizontal multi-column mode (S6.5): each block's value must be in the
  // BLOCK'S COLUMN (X=nameSpan.bbox[0]), not in the shared left column.
  // Otherwise the 3 values of the 3 blocks stack at the same X (Catalogue C P14
  // case: "Puissance $800w" = 900W+1200W+1500W overlapping, unreadable).
  const colValueX = isHorizontal
    ? Math.min(block.nameSpan.bbox[0], colValueXCap)
    : Math.min(maxKeyEndX + KEY_VAL_GAP, colValueXCap);
  const colAvailableW = Math.max(MIN_VALUE_COL_W, eraseRight - colValueX);

  // ── Shrink value font to fit on 1 line (uniform across block) ───────────
  // STARTING size = refKeySize (= same size as the key). For templates where
  // the template value has a reduced size by convention: we ignore it to aim
  // for the same legibility as the keys. The possible key shrink
  // (keyFontSize < refKeySize) does NOT affect the value (values stay
  // legible even if the keys are a touch tighter).
  const startSize = refKeySize;
  const floorSize = startSize * VALUE_FONT_SHRINK_MIN_RATIO;
  let uniformValSize = startSize;
  for (const r of rowInfos) {
    if (!r.safeVal) continue;
    let s = uniformValSize;
    while (estimateTextWidth(r.safeVal, s) > colAvailableW && s > floorSize) {
      s -= VALUE_FONT_SHRINK_STEP;
    }
    if (s < uniformValSize) uniformValSize = s;
  }

  // ── Vertical layout: compute the adaptive yStep per mode ────────────────
  const lineH = refKey.bbox[3] - refKey.bbox[1];
  const lineSpacingRatio = aerated ? AERATED_LINE_SPACING_RATIO
    : compact ? COMPACT_LINE_SPACING_RATIO
    : STANDARD_LINE_SPACING_RATIO;
  let yStep = refKeySize * lineSpacingRatio;
  // Category header height + gap
  const catHeaderSize = refKeySize * CATEGORY_HEADER_SIZE_RATIO;
  const catHeaderH = catHeaderSize * 1.15 + CATEGORY_HEADER_GAP_PT;
  // Total number of vertical elements
  const nCatHeaders = useCategories ? groups.length : 0;
  const nSeparators = useCategories ? Math.max(0, groups.length - 1) : 0;
  const totalNeededH = nCatHeaders * catHeaderH
    + n * yStep
    + nSeparators * SEPARATOR_GAP_PT;
  const availableH = block.specsYBottom - block.specsYTop;
  // If we overflow, tighten the yStep
  if (totalNeededH > availableH && n > 0) {
    const surplus = totalNeededH - availableH;
    const reduction = surplus / n;
    yStep = Math.max(refKeySize * COMPACT_LINE_SPACING_RATIO, yStep - reduction);
  }

  // ── Emit ops ─────────────────────────────────────────────────────────────
  let y = block.specsYTop;
  let emittedCount = 0;
  let overflowSurplus = 0;
  let rowIdx = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    // Separator between categories (not before the 1st)
    if (useCategories && gi > 0) {
      const sepY = y + SEPARATOR_GAP_PT * 0.4;
      ops.push({
        op: 'erase_rect',
        bbox: [block.specsXLeft, sepY, eraseRight, sepY + SEPARATOR_THICKNESS],
        color: SEPARATOR_COLOR,
      });
      y += SEPARATOR_GAP_PT;
    }
    // Category header. We hide it in 3 cases:
    //  - airy mode (no visual grouping)
    //  - AUTRES category (= unclassified specs, we don't want to show an
    //    unsightly "AUTRES" label; the specs are shown without a header)
    //  - g.specs empty (defense in depth: groupByCategory should already
    //    have dropped the categories without specs)
    const showHeader = useCategories
      && g.label
      && g.key !== 'AUTRES'
      && g.specs.length > 0;
    if (showHeader) {
      const headerY0 = y;
      const headerY1 = y + catHeaderSize * 1.15;
      // Check we have room for [header + at least 1 spec line]
      const minNeeded = headerY1 + CATEGORY_HEADER_GAP_PT + lineH;
      if (minNeeded > block.specsYBottom + 4) {
        // No room for header + 1 spec: skip this whole category, signal it
        // as overflow.
        overflowSurplus += g.specs.length;
        rowIdx += g.specs.length;
        continue;
      }
      ops.push({
        op: 'insert_text',
        bbox: [block.specsXLeft, headerY0, eraseRight, headerY1],
        text: g.label.toUpperCase(),
        font: refKeyFont,
        size: catHeaderSize,
        color: CATEGORY_HEADER_COLOR,
      });
      y = headerY1 + CATEGORY_HEADER_GAP_PT;
    }
    // Specs of the category
    for (let si = 0; si < g.specs.length; si++) {
      const spec = g.specs[si];
      const info = rowInfos[rowIdx];
      rowIdx++;
      const keyY0 = y;
      const keyY1 = y + lineH;
      // Check zone overflow
      if (keyY1 > block.specsYBottom + 4) {
        overflowSurplus = newSpecs.length - emittedCount;
        break;
      }
      // horizontal-secondary mode: skip emitting the keys (left column
      // already emitted by the row's primary block). Insert ONLY the values
      // in the current block's column (S6.5 step 3).
      const skipKeys = ctx.horizontalMode === 'horizontal-secondary';
      // Insert key (with keyFontSize possibly shrunk if keys are long)
      if (!skipKeys) {
        ops.push({
          op: 'insert_text',
          bbox: [block.specsXLeft, keyY0, info.keyEndX, keyY1],
          text: safeText(info.keyText),
          font: refKeyFont,
          size: keyFontSize,
          color: refKeyColor,
        });
      }
      // Dot leader between keyEnd and colValueX (width computed dynamically)
      const leaderStartX = info.keyEndX + 2;
      const leaderEndX = colValueX - 2;
      const leaderW = leaderEndX - leaderStartX;
      if (leaderW > 6 && !skipKeys) {
        const dotW = estimateTextWidth(DOT_LEADER_CHAR + ' ', uniformValSize) || 2;
        const nDots = Math.max(0, Math.floor(leaderW / dotW));
        if (nDots > 0) {
          const leaderText = (DOT_LEADER_CHAR + ' ').repeat(nDots).trimEnd();
          ops.push({
            op: 'insert_text',
            bbox: [leaderStartX, keyY0, leaderEndX, keyY1],
            text: leaderText,
            font: refValFont,
            size: uniformValSize,
            color: DOT_LEADER_COLOR,
          });
        }
      }
      // Insert value (wrap if necessary)
      if (info.safeVal) {
        const fullW = estimateTextWidth(info.safeVal, uniformValSize);
        if (fullW <= colAvailableW) {
          ops.push({
            op: 'insert_text',
            bbox: [colValueX, keyY0, Math.min(eraseRight, colValueX + fullW), keyY1],
            text: info.safeVal,
            font: refValFont,
            size: uniformValSize,
            color: refValColor,
          });
        } else {
          // Wrap to 2 lines via splitForWrap (semantic breakpoints)
          const split = splitForWrap(info.safeVal, colAvailableW, uniformValSize);
          ops.push({
            op: 'insert_text',
            bbox: [colValueX, keyY0, eraseRight, keyY1],
            text: split.line1,
            font: refValFont,
            size: uniformValSize,
            color: refValColor,
          });
          if (split.line2) {
            // Y position of the 2nd line of a wrapped value.
            // V2 uses yStep * 0.55 (V1 = 0.5) because the V2 layout has airier
            // line spacing (AERATED/STANDARD_LINE_SPACING_RATIO), so we can
            // afford a slightly larger offset without overlapping the next
            // row. Documented in audit #10.
            const y2 = keyY0 + yStep * 0.55;
            let line2 = split.line2;
            const l2W = estimateTextWidth(line2, uniformValSize);
            if (l2W > colAvailableW) {
              const ellW = estimateTextWidth('…', uniformValSize);
              while (line2.length > 4
                  && estimateTextWidth(line2, uniformValSize) + ellW > colAvailableW) {
                line2 = line2.slice(0, -1);
              }
              line2 = cleanupLineEnd(line2) + '…';
            }
            ops.push({
              op: 'insert_text',
              bbox: [colValueX, y2, eraseRight, y2 + lineH],
              text: line2,
              font: refValFont,
              size: uniformValSize,
              color: refValColor,
            });
            // Shift the next row. In compact mode (yStep close to lineH), the
            // old max(0, lineH + 1 - yStep*0.45) gave a ~1pt margin between
            // line2 bottom and the next row top → visual overlap
            // (descenders/ascenders). We force a min 2pt extra (review #10 bug).
            const wrapExtra = Math.max(2, lineH + 2 - yStep * 0.40);
            y += wrapExtra;
          }
        }
      }
      y += yStep;
      emittedCount++;
    }
    if (emittedCount < rowInfos.filter((_, idx) => idx < rowIdx).length) break;
  }

  // ── Overflow signal ─────────────────────────────────────────────────────
  if (overflowSurplus > 0 && emittedCount > 0) {
    const noteY0 = y - yStep + lineH + 2;
    if (noteY0 + lineH <= block.specsYBottom + 4) {
      ops.push({
        op: 'insert_text',
        bbox: [block.specsXLeft, noteY0, eraseRight, noteY0 + lineH],
        text: `+ ${overflowSurplus} autre${overflowSurplus > 1 ? 's' : ''} caractéristique${overflowSurplus > 1 ? 's' : ''}`,
        font: refValFont,
        size: uniformValSize * 0.92,
        color: refValColor,
      });
    }
  }

  return ops;
}

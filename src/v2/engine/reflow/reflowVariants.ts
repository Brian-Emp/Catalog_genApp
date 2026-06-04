/**
 * reflowVariants — dessine les vignettes couleur d'un produit en gerant
 * le cas OVERFLOW (plus de variants que de positions template).
 *
 * Strategies :
 *   - n_new <= positions      → comportement actuel : 1 cercle par position
 *   - n_new > positions       → MULTI-LIGNES : on extrapole des positions
 *                               supplementaires en decalant verticalement
 *                               par lignes de meme largeur. La rowHeight est
 *                               la taille de vignette + gap label.
 *                               Si on depasse bottomY → tronque + signal "+N".
 *   - 0 variants              → erase only (zone vide).
 *
 * Le label sous chaque cercle est conserve.
 */

import type { Bbox, Operation, PlanProduct } from '../../types';
import type { ProductBlock } from '../blockDetector';
import type { TemplateProfile } from '../profile';
import { safeText } from '../safeText';
import { padBbox } from '../../utils/bbox';

/** Padding (pt) autour des vignettes pour l'erase initial. */
const ERASE_PAD_VIGNETTE = 2;
const ERASE_PAD_LABEL = 3;
/** Gap entre lignes de variantes pour le label + air respiration. */
const ROW_GAP_RATIO = 0.55;
/** Hauteur max de debordement sous bottomY (pt). Si on depasse, tronquer. */
const OVERFLOW_BOTTOM_TOLERANCE = 6;

export function reflowVariants(
  block: ProductBlock,
  product: PlanProduct,
  profile: TemplateProfile
): Operation[] {
  const ops: Operation[] = [];
  const variants = product.variants ?? [];

  // 1. Erase vignettes + labels existants du template
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

  // 2. Calcul layout multi-lignes
  // rowHeight = hauteur d'une vignette + gap pour le label en dessous
  const refVignette = positions[0];
  const vignetteH = refVignette[3] - refVignette[1];
  const rowHeight = vignetteH * (1 + ROW_GAP_RATIO);

  const labelSize = profile.colorRefSizeRange[0];
  const labelFont = profile.headerColorFontPattern;
  const labelColor = '#231f20';

  // 3. Pour chaque variant : calcule position (avec offset y selon row)
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

    // Verifie qu'on ne sort pas trop bas
    if (shiftedBbox[3] > bottomLimit) {
      // Overflow vertical : on s'arrete, le reste devient surplus
      overflowSurplus = n_new - i;
      break;
    }

    // Erase pour les positions au-dela de la 1ere ligne (la 1ere ligne a deja
    // ete effacee plus haut via block.variantImages template)
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

  // 4. Signal overflow si on a du tronquer
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

// padBbox : voir utils/bbox.ts (factorisation audit #12).

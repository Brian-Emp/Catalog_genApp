/**
 * gridLayout — overflow producteur : quand une PageAllocation a + de
 * produits que de blocs détectés sur la page template, on synthétise des
 * blocs supplémentaires en clonant le bloc template du bas (translation
 * verticale uniquement, MVP). À termes : grille 2D NxM avec scaling.
 *
 * Stratégie MVP (1 col, multi-rows) :
 *  1. Mesurer la hauteur du bloc template ref (le plus bas de la page)
 *  2. Calculer combien de rangs supplémentaires tiennent sous lui dans la
 *     zone disponible (pageHeight - footer margin)
 *  3. Émettre des ProductBlock synthétiques (copies translatées)
 *  4. Cap : on ne synthétise que jusqu'à `nProducts` (pas au-delà même si
 *     plus de place)
 *
 * Le substitutor traite ces synthetic blocks comme des blocs normaux :
 * pas de modification du pipeline downstream.
 */

import type { Bbox, TextSpan } from '../../types';
import type { ProductBlock, ProductSpecBlock } from '../blockDetector';

/** Marge minimum réservée en bas de page (footer / page number). */
const PAGE_FOOTER_MARGIN_PT = 40;
/** Gap vertical entre 2 rangs synthétisés (pt). */
const ROW_GAP_PT = 8;

export interface GridLayoutInput {
  /** Blocs détectés sur la page template. */
  originalBlocks: ProductBlock[];
  /** Nombre total de produits à placer sur cette page. */
  nProducts: number;
  /** Hauteur totale de la page (pt). */
  pageHeight: number;
}

export interface GridLayoutResult {
  /** Blocs finaux à substituer (originaux + synthétisés si overflow). */
  blocks: ProductBlock[];
  /** True si on a synthétisé au moins 1 bloc (= mode grille déclenché). */
  gridApplied: boolean;
  /** Nombre de rangs ajoutés (0 si pas d'overflow ou pas de place). */
  rowsAdded: number;
}

/** Translate un Bbox de (dx, dy). */
function translateBbox(b: Bbox, dx: number, dy: number): Bbox {
  return [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
}

/** Translate un TextSpan : seule la bbox bouge, le reste est inchangé. */
function translateSpan(s: TextSpan, dx: number, dy: number): TextSpan {
  return { ...s, bbox: translateBbox(s.bbox, dx, dy) };
}

function translateSpec(s: ProductSpecBlock, dx: number, dy: number): ProductSpecBlock {
  return {
    key: translateSpan(s.key, dx, dy),
    values: s.values.map((v) => translateSpan(v, dx, dy)),
  };
}

/** Clone un ProductBlock en translatant toutes les positions de (dx, dy). */
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

/** Détermine si grille overflow est applicable + génère les blocs synthétiques. */
export function synthesizeOverflowBlocks(input: GridLayoutInput): GridLayoutResult {
  const { originalBlocks, nProducts, pageHeight } = input;
  if (originalBlocks.length === 0 || nProducts <= originalBlocks.length) {
    return { blocks: originalBlocks, gridApplied: false, rowsAdded: 0 };
  }

  // Bloc le plus bas (ref pour les clones translatés en dessous)
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

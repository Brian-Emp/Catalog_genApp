/**
 * Tests clamp yBottom du erase fond bloc (faille Catalogue C P6 page vide).
 *
 * Si block.yBottom > 85% pageH (dernier bloc), on clamp pour eviter
 * d'effacer toute la page si peu de remplissage downstream.
 */
import { describe, it, expect } from 'vitest';
import { substituteBlock } from '../../../src/v2/engine/substitutor';
import { DEFAULT_PROFILE } from '../../../src/v2/engine/profile';
import type { ProductBlock } from '../../../src/v2/engine/blockDetector';
import type { PlanProduct, TextSpan } from '../../../src/v2/types';

function makeBlock(yTop: number, yBottom: number): ProductBlock {
  const span: TextSpan = {
    text: 'PROD',
    bbox: [50, yTop, 200, yTop + 16],
    font: 'Helvetica-SemiBold',
    size: 16,
    color: '#000000',
  };
  return {
    pageNumber: 1,
    nameSpan: span,
    nameWrappedCount: 1,
    refSpan: null,
    colorSpan: null,
    specs: [],
    variantImages: [],
    variantSpans: [],
    mainImageBbox: null,
    yTop,
    yBottom,
    specsYTop: yTop + 30,
    specsYBottom: yBottom - 10,
    specsXLeft: 200,
  };
}

const PRODUCT: PlanProduct = {
  nom: 'TEST',
  ref: '123',
  specs: [],
} as PlanProduct;

const CTX = {
  pageWidth: 595,
  pageHeight: 842,
  profile: DEFAULT_PROFILE,
};

describe('substituteBlock — clamp yBottom erase fond bloc', () => {
  it('bloc normal (yBottom < 85% pageH) : erase non clampe', () => {
    // yBottom = 400 < 0.85 * 842 = 716
    const block = makeBlock(100, 400);
    const ops = substituteBlock(block, PRODUCT, CTX);
    const erases = ops.filter((o) => o.op === 'erase_rect');
    // Premier erase = fond bloc (le plus haut)
    const fondErase = erases[0];
    expect((fondErase as any).bbox[3]).toBeCloseTo(402, 0); // 400 + 2
  });

  it('bloc avec yBottom > 85% pageH : erase clampe a max(yTop+300, 85% pageH)', () => {
    // yBottom = 820 > 716 → clamp
    const block = makeBlock(100, 820);
    const ops = substituteBlock(block, PRODUCT, CTX);
    const erases = ops.filter((o) => o.op === 'erase_rect');
    const fondErase = erases[0];
    // safeYBottom = max(100+300=400, 0.85*842=715.7) = 715.7
    expect((fondErase as any).bbox[3]).toBeCloseTo(715.7 + 2, 0);
  });

  it('bloc tres haut yTop+300 > 85% pageH : safeYBottom = yTop+300', () => {
    // yTop=500 → yTop+300=800. 85% pageH = 716. max(800, 716) = 800.
    const block = makeBlock(500, 830);
    const ops = substituteBlock(block, PRODUCT, CTX);
    const erases = ops.filter((o) => o.op === 'erase_rect');
    const fondErase = erases[0];
    expect((fondErase as any).bbox[3]).toBe(800 + 2);
  });

  it('bloc dégénéré height < 20 : pas d erase fond (existing guard)', () => {
    const block = makeBlock(100, 110); // height = 10
    const ops = substituteBlock(block, PRODUCT, CTX);
    // Pas de erase fond bloc emis
    const erases = ops.filter((o) => o.op === 'erase_rect');
    // Il y a d autres erases (specs, image) mais pas le fond bloc
    // On verifie qu il n y en a pas un avec yTop ~ 100 et height >= 100
    const fondLike = erases.find((e: any) => {
      const h = e.bbox[3] - e.bbox[1];
      return Math.abs(e.bbox[1] - (100 - 2 - 16 * 2)) < 5 && h > 50;
    });
    expect(fondLike).toBeUndefined();
  });
});

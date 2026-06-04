/**
 * Test : substituteBlock passe le bon rightBound a reflowName selon le
 * mode horizontal. En horizontal-secondary/primary avec horizontalColRight,
 * le nom du produit ne doit pas wrapper sur le bloc voisin.
 *
 * Verifie via inspection des ops emises.
 */
import { describe, it, expect } from 'vitest';
import { substituteBlock } from '../../../src/v2/engine/substitutor';
import { DEFAULT_PROFILE } from '../../../src/v2/engine/profile';
import type { ProductBlock } from '../../../src/v2/engine/blockDetector';
import type { PlanProduct, TextSpan, Bbox } from '../../../src/v2/types';

function makeBlock(xLeft = 50, yTop = 100): ProductBlock {
  const span: TextSpan = {
    text: 'PROD',
    bbox: [xLeft, yTop, xLeft + 100, yTop + 16],
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
    yBottom: yTop + 200,
    specsYTop: yTop + 30,
    specsYBottom: yTop + 180,
    specsXLeft: xLeft + 100,
  };
}

const PRODUCT: PlanProduct = {
  nom: 'NOUVEAU NOM PRODUIT TRES TRES TRES LONG QUI POURRAIT WRAPPER',
  ref: '9999999',
  specs: [],
} as PlanProduct;

describe('substituteBlock — rightBound nom selon mode horizontal', () => {
  it('mode vertical : insert_text nom va jusqu a pageWidth - ribbon', () => {
    const block = makeBlock();
    const ops = substituteBlock(block, PRODUCT, {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    // L op insert_text du nom doit avoir une bbox qui peut atteindre
    // pageWidth - ribbonMargin
    const nameInsert = ops.find(
      (o) =>
        o.op === 'insert_text' &&
        (o as any).text.includes('NOUVEAU') &&
        (o as any).size >= 14,
    );
    if (nameInsert) {
      // bbox right peut atteindre pres de pageWidth (595 - ribbon=30 - 6 = ~559)
      // Au moins > 200 (col elargie)
      expect((nameInsert as any).bbox[2]).toBeGreaterThan(200);
    }
  });

  it('mode horizontal-primary avec colRight : nom limite a la col', () => {
    const block = makeBlock();
    const ops = substituteBlock(block, PRODUCT, {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
      horizontalMode: 'horizontal-primary',
      horizontalColRight: 250,
    });
    const nameInserts = ops.filter(
      (o) =>
        o.op === 'insert_text' &&
        (o as any).text.includes('NOUVEAU'),
    );
    // En horizontal avec colRight=250, le nom ne doit pas depasser 250
    for (const op of nameInserts) {
      const bbox: Bbox = (op as any).bbox;
      expect(bbox[2]).toBeLessThanOrEqual(250);
    }
  });

  it('mode horizontal-secondary : nom limite aussi', () => {
    const block = makeBlock(300, 100);
    const ops = substituteBlock(block, PRODUCT, {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
      horizontalMode: 'horizontal-secondary',
      horizontalColRight: 450,
    });
    const nameInserts = ops.filter(
      (o) =>
        o.op === 'insert_text' &&
        (o as any).text.includes('NOUVEAU'),
    );
    for (const op of nameInserts) {
      const bbox: Bbox = (op as any).bbox;
      expect(bbox[2]).toBeLessThanOrEqual(450);
    }
  });

  it('horizontalColRight sans horizontalMode : ignore (backward compat)', () => {
    const block = makeBlock();
    const ops = substituteBlock(block, PRODUCT, {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
      horizontalColRight: 200,
      // pas de horizontalMode
    });
    // Comme vertical : pas de limit
    const nameInsert = ops.find(
      (o) =>
        o.op === 'insert_text' &&
        (o as any).text.includes('NOUVEAU'),
    );
    if (nameInsert) {
      // pas de clamp a 200, peut depasser
      expect((nameInsert as any).bbox[2]).toBeGreaterThan(200);
    }
  });
});

/**
 * Tests du clamp protection erase specs vs nameSpan.
 *
 * Faille identifiee : si block.specsYTop < block.nameSpan.bbox[3], l'erase
 * specs (raw = specsYTop - 4) mord sur le nom DEJA insere par reflowName,
 * le blanchissant silencieusement.
 *
 * Fix : safeEraseTop = max(specsYTop - 4, nameSpan.bbox[3] + 1).
 */
import { describe, it, expect } from 'vitest';
import { reflowSpecsV2 } from '../../../../src/v2/engine/reflow/reflowSpecsV2';
import { DEFAULT_PROFILE } from '../../../../src/v2/engine/profile';
import type { ProductBlock } from '../../../../src/v2/engine/blockDetector';
import type { PlanProduct } from '../../../../src/v2/types';

function makeBlock(overrides: Partial<ProductBlock> = {}): ProductBlock {
  return {
    pageNumber: 1,
    nameSpan: {
      text: 'PRODUIT TEST',
      bbox: [50, 80, 200, 110], // nameBottom = 110
      font: 'Helvetica-SemiBold',
      size: 16,
      color: '#000000',
    },
    nameWrappedCount: 1,
    refSpan: null,
    colorSpan: null,
    specs: [
      {
        key: {
          text: 'MATIERE',
          bbox: [50, 130, 100, 142],
          font: 'Helvetica-Bold',
          size: 11,
          color: '#000000',
        },
        values: [
          {
            text: 'Inox',
            bbox: [200, 130, 230, 142],
            font: 'Helvetica',
            size: 11,
            color: '#000000',
          },
        ],
      },
    ],
    variantImages: [],
    variantSpans: [],
    mainImageBbox: null,
    yTop: 80,
    yBottom: 200,
    specsYTop: 130, // > nameBottom OK
    specsYBottom: 180,
    specsXLeft: 50,
    ...overrides,
  };
}

function makeProduct(): PlanProduct {
  return {
    nom: 'NOUVEAU PRODUIT',
    ref: '9999999',
    specs: [{ key: 'MATIERE', values: ['Bronze'] }],
  } as PlanProduct;
}

describe('reflowSpecsV2 — clamp erase top vs nameSpan', () => {
  it('cas normal : specsYTop bien au-dessous du nom → erase non clampe', () => {
    const block = makeBlock({ specsYTop: 130 }); // nameBottom=110, gap=20
    const ops = reflowSpecsV2(block, makeProduct(), {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    const eraseOp = ops.find((o) => o.op === 'erase_rect');
    expect(eraseOp).toBeDefined();
    // raw top = 130 - 4 = 126, > nameBottom+1=111 → pas de clamp
    expect((eraseOp as any).bbox[1]).toBe(126);
  });

  it('cas Catalogue E dense : specsYTop sous nameBottom → erase clampe a nameBottom+1', () => {
    // block.nameSpan.bbox = [50, 80, 200, 110]. specsYTop = 108 (dans le nom !)
    const block = makeBlock({ specsYTop: 108 });
    const ops = reflowSpecsV2(block, makeProduct(), {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    const eraseOp = ops.find((o) => o.op === 'erase_rect');
    expect(eraseOp).toBeDefined();
    // raw top = 108 - 4 = 104 (< nameBottom+1=111 → clamp a 111)
    expect((eraseOp as any).bbox[1]).toBe(111);
  });

  it('cas extreme : specsYTop = nameBottom exact → clamp', () => {
    const block = makeBlock({ specsYTop: 110 });
    const ops = reflowSpecsV2(block, makeProduct(), {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    const eraseOp = ops.find((o) => o.op === 'erase_rect');
    expect(eraseOp).toBeDefined();
    // raw top = 110 - 4 = 106 (< 111 → clamp)
    expect((eraseOp as any).bbox[1]).toBe(111);
  });

  it('cas sans nameSpan valide (defensif) : pas de clamp', () => {
    const block = makeBlock();
    // Force nameSpan bbox absent (cas pathologique)
    (block as any).nameSpan = { ...block.nameSpan, bbox: undefined };
    const ops = reflowSpecsV2(block, makeProduct(), {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    const eraseOp = ops.find((o) => o.op === 'erase_rect');
    expect(eraseOp).toBeDefined();
    // Pas de clamp → raw top = 130 - 4 = 126
    expect((eraseOp as any).bbox[1]).toBe(126);
  });
});

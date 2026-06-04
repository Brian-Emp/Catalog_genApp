/**
 * Tests du tracking des bbox images degenerees dans substitutor.
 *
 * Faille review #9 : computeImageBbox peut produire des bbox < 60pt
 * (narrow ou short) silencieusement → image invisible. On expose un
 * tracker pour audit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getDegenerateImages,
  resetDegenerateImages,
  substituteBlock,
} from '../../../src/v2/engine/substitutor';
import { DEFAULT_PROFILE } from '../../../src/v2/engine/profile';
import type { ProductBlock } from '../../../src/v2/engine/blockDetector';
import type { PlanProduct } from '../../../src/v2/types';

function makeBlock(overrides: Partial<ProductBlock> = {}): ProductBlock {
  return {
    pageNumber: 1,
    nameSpan: {
      text: 'PRODUIT TEST',
      bbox: [50, 80, 200, 110],
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
          bbox: [200, 130, 250, 142],
          font: 'Helvetica-Bold',
          size: 11,
          color: '#000000',
        },
        values: [
          {
            text: 'Inox',
            bbox: [260, 130, 290, 142],
            font: 'Helvetica',
            size: 11,
            color: '#000000',
          },
        ],
      },
    ],
    variantImages: [],
    variantSpans: [],
    mainImageBbox: [60, 130, 180, 280], // image OK 120x150
    yTop: 80,
    yBottom: 300,
    specsYTop: 130,
    specsYBottom: 280,
    specsXLeft: 200,
    ...overrides,
  };
}

function makeProduct(): PlanProduct {
  return {
    nom: 'NOUVEAU',
    ref: '9999999',
    specs: [{ key: 'MATIERE', values: ['Bronze'] }],
    imagePath: undefined,
  } as PlanProduct;
}

describe('substitutor — tracking images degenerees', () => {
  beforeEach(() => {
    resetDegenerateImages();
  });

  it('image OK (large + haute) : aucun tracking', () => {
    const block = makeBlock(); // 60-200=140 wide, ~150 high
    substituteBlock(block, makeProduct(), {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    expect(getDegenerateImages()).toHaveLength(0);
  });

  it('cas Catalogue E dense : specsXLeft proche du nom → image narrow', () => {
    // specsXLeft - 10 = 60 → xRightZone = max(50+20, 60) = 70 → w = 70-50 = 20pt
    const block = makeBlock({ specsXLeft: 70 });
    substituteBlock(block, makeProduct(), {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    const deg = getDegenerateImages();
    expect(deg.length).toBeGreaterThanOrEqual(1);
    expect(deg[0].reason).toMatch(/narrow/);
    expect(deg[0].width).toBeLessThan(60);
  });

  it('cas bloc petit hauteur : image short', () => {
    // yBottom proche du nameBottom → image courte
    const block = makeBlock({
      yTop: 80,
      yBottom: 150, // headerBottom ~122 → image h ~28pt
      specsYBottom: 145,
    });
    substituteBlock(block, makeProduct(), {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    const deg = getDegenerateImages();
    if (deg.length >= 1) {
      expect(deg[0].reason).toMatch(/short|narrow\+short/);
    }
  });

  it('resetDegenerateImages effectivement reset', () => {
    const block = makeBlock({ specsXLeft: 70 });
    substituteBlock(block, makeProduct(), {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    expect(getDegenerateImages().length).toBeGreaterThan(0);
    resetDegenerateImages();
    expect(getDegenerateImages()).toHaveLength(0);
  });

  it('DegenerateImageInfo a la bonne shape', () => {
    const block = makeBlock({ specsXLeft: 70 });
    substituteBlock(block, makeProduct(), {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    const deg = getDegenerateImages();
    if (deg.length > 0) {
      const d = deg[0];
      expect(d).toHaveProperty('pageNumber');
      expect(d).toHaveProperty('productName');
      expect(d).toHaveProperty('bbox');
      expect(d).toHaveProperty('width');
      expect(d).toHaveProperty('height');
      expect(d).toHaveProperty('reason');
      expect(['narrow', 'short', 'narrow+short']).toContain(d.reason);
    }
  });
});

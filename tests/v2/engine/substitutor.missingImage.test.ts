/**
 * Tests tracking produits sans image source (assets.zip incomplet).
 *
 * Quick win audit : substituteBlock erase silencieusement l'image template
 * meme si product.image_path est null. Sans tracking, l'utilisateur ne sait
 * pas qu'il faut corriger son assets.zip.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  substituteBlock,
  getMissingProductImages,
  resetMissingProductImages,
} from '../../../src/v2/engine/substitutor';
import { DEFAULT_PROFILE } from '../../../src/v2/engine/profile';
import type { ProductBlock } from '../../../src/v2/engine/blockDetector';
import type { PlanProduct, TextSpan } from '../../../src/v2/types';

function makeBlock(): ProductBlock {
  const span: TextSpan = {
    text: 'PROD',
    bbox: [50, 100, 150, 116],
    font: 'Helvetica-SemiBold',
    size: 16,
    color: '#000000',
  };
  return {
    pageNumber: 7,
    nameSpan: span,
    nameWrappedCount: 1,
    refSpan: null,
    colorSpan: null,
    specs: [],
    variantImages: [],
    variantSpans: [],
    mainImageBbox: null,
    yTop: 80,
    yBottom: 280,
    specsYTop: 130,
    specsYBottom: 260,
    specsXLeft: 200,
  };
}

const CTX = {
  pageWidth: 595,
  pageHeight: 842,
  profile: DEFAULT_PROFILE,
};

describe('substitutor — tracking produits sans image source', () => {
  beforeEach(() => {
    resetMissingProductImages();
  });

  it('produit avec image_path : pas de tracking', () => {
    const product = {
      name: 'AVEC IMAGE',
      ref: '123',
      specs: [],
      image_path: '/tmp/img.png',
    } as unknown as PlanProduct;
    substituteBlock(makeBlock(), product, CTX);
    expect(getMissingProductImages()).toHaveLength(0);
  });

  it('produit sans image_path : enregistre comme missing', () => {
    const product = {
      name: 'SANS IMAGE',
      ref: '999',
      specs: [],
    } as unknown as PlanProduct;
    substituteBlock(makeBlock(), product, CTX);
    const missing = getMissingProductImages();
    expect(missing).toHaveLength(1);
    expect(missing[0].productName).toBe('SANS IMAGE');
    expect(missing[0].pageNumber).toBe(7);
  });

  it('produit avec name vide : tracking avec "(sans nom)"', () => {
    const product = { ref: '0' } as unknown as PlanProduct;
    substituteBlock(makeBlock(), product, CTX);
    const missing = getMissingProductImages();
    expect(missing[0].productName).toBe('(sans nom)');
  });

  it('resetMissingProductImages efficace', () => {
    const product = { name: 'A' } as unknown as PlanProduct;
    substituteBlock(makeBlock(), product, CTX);
    expect(getMissingProductImages().length).toBeGreaterThan(0);
    resetMissingProductImages();
    expect(getMissingProductImages()).toHaveLength(0);
  });

  it('plusieurs produits sans image : tous trackes', () => {
    const products = [
      { name: 'A' } as unknown as PlanProduct,
      { name: 'B' } as unknown as PlanProduct,
      { name: 'C' } as unknown as PlanProduct,
    ];
    for (const p of products) substituteBlock(makeBlock(), p, CTX);
    expect(getMissingProductImages()).toHaveLength(3);
    expect(getMissingProductImages().map((m) => m.productName)).toEqual([
      'A', 'B', 'C',
    ]);
  });
});

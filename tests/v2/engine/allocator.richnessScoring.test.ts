/**
 * Test feature flag useRichnessScoring dans allocator.
 *
 * Phase 3 T2 : branchement scoring optionnel. Sans flag = legacy smallest-fit.
 * Avec flag = sort par scoreProductPage desc (pages riches prioritaires).
 *
 * Anti-regression : meme entree sans flag retourne le meme resultat qu'avant.
 */
import { describe, it, expect } from 'vitest';
import { allocatePages } from '../../../src/v2/engine/allocator';
import { analyzeProducts } from '../../../src/v2/engine/inputs';
import type { PageClassification } from '../../../src/v2/engine/classify';
import type { ProductBlock } from '../../../src/v2/engine/blockDetector';
import type { ExtractedPage, PlanProduct, TextSpan, Bbox } from '../../../src/v2/types';

function makeProduct(name: string, section: string): PlanProduct {
  return {
    name,
    ref: 'REF',
    color: 'Chrome',
    image_path: null,
    specs: [],
    variants: [],
    section,
  };
}

function makeBlock(opts: { ref?: boolean; specs?: number; image?: boolean } = {}): ProductBlock {
  const span: TextSpan = {
    text: 'PROD',
    bbox: [50, 100, 150, 116],
    font: 'Almanach-SemiBold',
    size: 16,
    color: '#000000',
  };
  return {
    pageNumber: 0,
    nameSpan: span,
    nameWrappedCount: 1,
    refSpan: opts.ref
      ? { text: '1234567', bbox: [110, 120, 160, 132], font: 'Light', size: 11, color: '#000' }
      : null,
    colorSpan: null,
    specs: Array.from({ length: opts.specs ?? 0 }, (_, i) => ({
      key: { text: `K${i}`, bbox: [200, 130 + i * 14, 240, 142 + i * 14], font: 'Bold', size: 11, color: '#000' },
      values: [{ text: `v${i}`, bbox: [250, 130 + i * 14, 290, 142 + i * 14], font: 'Light', size: 11, color: '#000' }],
    })),
    variantImages: [],
    variantSpans: [],
    mainImageBbox: opts.image ? ([50, 130, 200, 280] as Bbox) : null,
    yTop: 80,
    yBottom: 280,
    specsYTop: 130,
    specsYBottom: 260,
    specsXLeft: 200,
  };
}

function makePage(
  pageNumber: number,
  blocks: ProductBlock[],
  section = 'BARRES DE DOUCHES',
): PageClassification {
  const extracted: ExtractedPage = {
    page_number: pageNumber,
    page_size: { width: 595, height: 842 },
    slots: [],
  };
  return {
    pageNumber,
    extracted,
    blocks,
    kind: 'product',
    sectionLabel: null,
    activeSection: section,
    confidence: 0.95,
  };
}

describe('allocator — useRichnessScoring feature flag', () => {
  it('default (no flag) : comportement smallest-fit conserve', () => {
    // 1 produit, 2 pages : page 1 = 1 bloc, page 2 = 3 blocs.
    // Smallest-fit choisit page 1 (juste assez).
    const pages = [
      makePage(1, [makeBlock()]),
      makePage(2, [makeBlock(), makeBlock(), makeBlock()]),
    ];
    const products = [makeProduct('A', 'BARRES DE DOUCHES')];
    const r = allocatePages(pages, analyzeProducts(products));
    expect(r.allocations).toHaveLength(1);
    // Sans flag : prend page 1 (1 bloc, smallest fit)
    expect(r.allocations[0].sourcePage).toBe(1);
  });

  it('avec flag useRichnessScoring : page riche prioritaire', () => {
    // Meme setup. Page 1 = 1 bloc vide. Page 2 = 3 blocs riches (ref + specs + image).
    const pages = [
      makePage(1, [makeBlock()]),
      makePage(2, [
        makeBlock({ ref: true, specs: 5, image: true }),
        makeBlock({ ref: true, specs: 5, image: true }),
        makeBlock({ ref: true, specs: 5, image: true }),
      ]),
    ];
    const products = [makeProduct('A', 'BARRES DE DOUCHES')];
    const r = allocatePages(pages, analyzeProducts(products), {
      useRichnessScoring: true,
    });
    expect(r.allocations).toHaveLength(1);
    // Avec scoring : page 2 (score > page 1 vide)
    expect(r.allocations[0].sourcePage).toBe(2);
  });

  it('Catalogue A E2E non-regression : 3 produits, 3 pages 3-blocs identiques → 1 page allouee', () => {
    const pages = [
      makePage(10, [makeBlock({ ref: true, specs: 4 }), makeBlock({ ref: true, specs: 4 }), makeBlock({ ref: true, specs: 4 })]),
      makePage(11, [makeBlock({ ref: true, specs: 4 }), makeBlock({ ref: true, specs: 4 }), makeBlock({ ref: true, specs: 4 })]),
      makePage(12, [makeBlock({ ref: true, specs: 4 }), makeBlock({ ref: true, specs: 4 }), makeBlock({ ref: true, specs: 4 })]),
    ];
    const products = [
      makeProduct('A', 'BARRES DE DOUCHES'),
      makeProduct('B', 'BARRES DE DOUCHES'),
      makeProduct('C', 'BARRES DE DOUCHES'),
    ];
    const r1 = allocatePages(pages, analyzeProducts(products));
    const r2 = allocatePages(pages, analyzeProducts(products), { useRichnessScoring: true });
    // Pages equivalentes → meme 1 page allouee, meme 2 pages drop
    expect(r1.allocations).toHaveLength(1);
    expect(r2.allocations).toHaveLength(1);
    expect(r1.droppedProductPages.length).toBe(r2.droppedProductPages.length);
  });

  it('flag=false explicite : meme comportement que default', () => {
    const pages = [
      makePage(1, [makeBlock()]),
      makePage(2, [makeBlock(), makeBlock()]),
    ];
    const products = [makeProduct('A', 'BARRES DE DOUCHES')];
    const r1 = allocatePages(pages, analyzeProducts(products), { useRichnessScoring: false });
    const r2 = allocatePages(pages, analyzeProducts(products), {});
    expect(r1.allocations[0].sourcePage).toBe(r2.allocations[0].sourcePage);
  });
});

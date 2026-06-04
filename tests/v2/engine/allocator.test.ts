/**
 * Tests allocator : verifie le split equilibre des produits, les guards
 * sur entrees degenerees, et le matching section.
 */

import { describe, expect, it } from 'vitest';
import { allocatePages } from '../../../src/v2/engine/allocator';
import type { PageClassification } from '../../../src/v2/engine/classify';
import { analyzeProducts } from '../../../src/v2/engine/inputs';
import type { ProductBlock } from '../../../src/v2/engine/blockDetector';
import type { ExtractedPage, PlanProduct, TextSpan } from '../../../src/v2/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeProduct(name: string, section?: string): PlanProduct {
  return {
    name,
    ref: 'REF',
    color: 'Chrome',
    image_path: null,
    specs: [],
    variants: [],
    section: section ?? null,
  };
}

function makeBlock(yTop: number): ProductBlock {
  const fakeSpan: TextSpan = {
    text: 'name',
    bbox: [50, yTop, 250, yTop + 16],
    font: 'Almanach-SemiBold',
    size: 16,
    color: '#000000',
  };
  return {
    pageNumber: 0,
    nameSpan: fakeSpan,
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
    specsXLeft: 280,
  };
}

function makePage(
  pageNumber: number,
  blockCount: number,
  section = 'BARRES DE DOUCHES',
): PageClassification {
  const blocks: ProductBlock[] = [];
  for (let i = 0; i < blockCount; i++) blocks.push(makeBlock(50 + i * 250));
  const extracted: ExtractedPage = {
    page_number: pageNumber,
    page_size: { width: 595, height: 842 },
    slots: [],
  };
  return {
    pageNumber,
    extracted,
    blocks,
    kind: blockCount > 0 ? 'product' : 'identity',
    sectionLabel: null,
    activeSection: section,
    confidence: 0.95,
  };
}

// ─── Guards (P5 review) ────────────────────────────────────────────────────

describe('allocator guards', () => {
  it('N=0 produits → 0 allocation, 0 unmatched, 0 drop', () => {
    const r = allocatePages([], analyzeProducts([]));
    expect(r.allocations).toEqual([]);
    expect(r.unmatched).toEqual([]);
    expect(r.droppedProductPages).toEqual([]);
  });

  it('aucune page produit → tous les produits en unmatched', () => {
    const products = [makeProduct('A'), makeProduct('B')];
    const r = allocatePages([], analyzeProducts(products));
    expect(r.allocations).toEqual([]);
    expect(r.unmatched).toEqual(products);
  });

  it('pages produit avec 0 blocs → tous unmatched', () => {
    const cls = [makePage(10, 0)];
    cls[0].kind = 'product';
    const products = [makeProduct('A')];
    const r = allocatePages(cls, analyzeProducts(products));
    expect(r.allocations).toEqual([]);
    expect(r.unmatched).toHaveLength(1);
  });
});

// ─── Split equilibre ──────────────────────────────────────────────────────

describe('allocator split equilibre', () => {
  it('6 produits sur 2 pages 3-blocs : 3+3', () => {
    const cls = [makePage(10, 3), makePage(11, 3)];
    const products = Array.from({ length: 6 }, (_, i) => makeProduct('P' + i));
    const r = allocatePages(cls, analyzeProducts(products));
    expect(r.allocations).toHaveLength(2);
    expect(r.allocations[0].products).toHaveLength(3);
    expect(r.allocations[1].products).toHaveLength(3);
  });

  it('6 produits avec pages [4 blocs, 2 blocs] : equilibre 3+2 puis second pass case le 6e', () => {
    // Pool : 1 page 4 blocs + 1 page 2 blocs. max=4 → NP=ceil(6/4)=2.
    // parts=[3,3]. 1er pass : 3+2 = 5 produits places, 1 unmatched.
    // P2.6 second pass : 1 unmatched + page 4 blocs a 1 slot libre → place.
    // Final : 4+2 = 6 places, 0 unmatched (meme section donc pas de warning).
    const cls = [makePage(10, 4), makePage(11, 2)];
    const products = Array.from({ length: 6 }, (_, i) => makeProduct('P' + i));
    const r = allocatePages(cls, analyzeProducts(products));
    expect(r.allocations).toHaveLength(2);
    expect(r.allocations[0].products.length + r.allocations[1].products.length).toBe(6);
    expect(r.unmatched).toHaveLength(0);
  });

  it('7 produits sur 3 pages 3-blocs : 3+2+2 (equilibre)', () => {
    const cls = [makePage(10, 3), makePage(11, 3), makePage(12, 3)];
    const products = Array.from({ length: 7 }, (_, i) => makeProduct('P' + i));
    const r = allocatePages(cls, analyzeProducts(products));
    expect(r.allocations).toHaveLength(3);
    const counts = r.allocations.map((a) => a.products.length).sort();
    expect(counts).toEqual([2, 2, 3]);
  });

  it('1 produit sur 1 page 3-blocs : 1 alloc (2 blocs vides geres en aval)', () => {
    const cls = [makePage(10, 3)];
    const products = [makeProduct('P1')];
    const r = allocatePages(cls, analyzeProducts(products));
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0].products).toHaveLength(1);
    expect(r.allocations[0].blockCount).toBe(3);
  });
});

// ─── Sections multiples ────────────────────────────────────────────────────

describe('allocator sections multiples', () => {
  it('2 sections distinctes → pages separees (pas de melange)', () => {
    const cls = [makePage(10, 3, 'A'), makePage(11, 3, 'B')];
    const products = [
      makeProduct('A1', 'A'),
      makeProduct('A2', 'A'),
      makeProduct('B1', 'B'),
      makeProduct('B2', 'B'),
    ];
    const r = allocatePages(cls, analyzeProducts(products));
    expect(r.allocations).toHaveLength(2);
    // chaque page n'a qu'une seule section
    for (const alloc of r.allocations) {
      const sections = new Set(
        alloc.products.map((p) => p.section).filter(Boolean),
      );
      expect(sections.size).toBe(1);
    }
  });

  // P2.6 : second pass mix toleré pour récupérer les unmatched.
  it('section minoritaire 1 produit + pages saturees → cohabitation avec warning', () => {
    // 2 pages 3-blocs allouees a A (6 produits). Plus 1 produit B en surplus.
    const cls = [makePage(10, 3, 'A'), makePage(11, 3, 'A')];
    const products = [
      makeProduct('A1', 'A'),
      makeProduct('A2', 'A'),
      makeProduct('A3', 'A'),
      makeProduct('A4', 'A'),
      makeProduct('B1', 'B'),
    ];
    const r = allocatePages(cls, analyzeProducts(products));
    // Avant P2.6 : B1 etait unmatched. Maintenant il est case dans page A.
    const placed = r.allocations.reduce((s, a) => s + a.products.length, 0);
    expect(placed).toBe(5);
    expect(r.unmatched).toHaveLength(0);
    expect(r.warnings?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
});

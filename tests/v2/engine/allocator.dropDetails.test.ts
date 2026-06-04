/**
 * Tests allocator drop annotation : observabilite des pages drops avec
 * raison (no_section_match / section_overprovided).
 *
 * Faille audit : sur Catalogue A 188 pages, 104 pages drop sans visibilite sur la
 * raison. Permet de prioriser le fix (scoring multi-criteres).
 */
import { describe, it, expect } from 'vitest';
import { allocatePages } from '../../../src/v2/engine/allocator';
import { analyzeProducts } from '../../../src/v2/engine/inputs';
import type { PageClassification } from '../../../src/v2/engine/classify';
import type { ProductBlock } from '../../../src/v2/engine/blockDetector';
import type { ExtractedPage, PlanProduct, TextSpan } from '../../../src/v2/types';

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

function makeBlock(yTop: number): ProductBlock {
  const span: TextSpan = {
    text: 'name',
    bbox: [50, yTop, 250, yTop + 16],
    font: 'Almanach-SemiBold',
    size: 16,
    color: '#000000',
  };
  return {
    pageNumber: 0,
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
    specsXLeft: 280,
  };
}

function makePage(
  pageNumber: number,
  blockCount: number,
  section: string,
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
    kind: 'product',
    sectionLabel: null,
    activeSection: section,
    confidence: 0.95,
  };
}

describe('allocator — drop details (observabilite)', () => {
  it('page section sans aucun produit → no_section_match', () => {
    const pages: PageClassification[] = [
      makePage(1, 2, 'BARRES DE DOUCHES'),
      makePage(2, 2, 'POMPES IMMERGEES'), // pas de produit pour cette section
    ];
    const products = [
      makeProduct('Barre A', 'BARRES DE DOUCHES'),
      makeProduct('Barre B', 'BARRES DE DOUCHES'),
    ];
    const r = allocatePages(pages, analyzeProducts(products));
    expect(r.droppedPageDetails).toBeDefined();
    const drop = r.droppedPageDetails!.find((d) => d.pageNumber === 2);
    expect(drop).toBeDefined();
    expect(drop!.reason).toBe('no_section_match');
  });

  it('section avec trop de pages template → section_overprovided', () => {
    // 1 section avec 2 produits, mais 3 pages disponibles → 1 page drop
    const pages: PageClassification[] = [
      makePage(1, 1, 'BARRES DE DOUCHES'),
      makePage(2, 1, 'BARRES DE DOUCHES'),
      makePage(3, 1, 'BARRES DE DOUCHES'),
    ];
    const products = [
      makeProduct('A', 'BARRES DE DOUCHES'),
      makeProduct('B', 'BARRES DE DOUCHES'),
    ];
    const r = allocatePages(pages, analyzeProducts(products));
    // 1 page drop attendue
    expect(r.droppedProductPages.length).toBeGreaterThanOrEqual(1);
    const drop = r.droppedPageDetails!.find((d) =>
      r.droppedProductPages.includes(d.pageNumber),
    );
    expect(drop).toBeDefined();
    expect(drop!.reason).toBe('section_overprovided');
  });

  it('toutes pages allouees → droppedPageDetails vide', () => {
    const pages = [makePage(1, 2, 'BARRES DE DOUCHES')];
    const products = [
      makeProduct('A', 'BARRES DE DOUCHES'),
      makeProduct('B', 'BARRES DE DOUCHES'),
    ];
    const r = allocatePages(pages, analyzeProducts(products));
    expect(r.droppedPageDetails).toEqual([]);
  });

  it('DroppedPageDetail contient activeSection et blockCount', () => {
    const pages = [makePage(99, 3, 'INCONNUE')];
    const products = [makeProduct('X', 'AUTRE SECTION')];
    const r = allocatePages(pages, analyzeProducts(products));
    if (r.droppedPageDetails && r.droppedPageDetails.length > 0) {
      const d = r.droppedPageDetails[0];
      expect(d.activeSection).toBe('INCONNUE');
      expect(d.blockCount).toBe(3);
    }
  });
});

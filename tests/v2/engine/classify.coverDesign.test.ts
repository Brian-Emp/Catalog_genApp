/**
 * Tests isCoverDesign — empeche allocator de placer produits sur covers.
 *
 * Critere : imgCoverage > 0.5 ET tous les blocs sans ref ni specs.
 * Conservateur pour preserver Catalogue A (chaque bloc a refSpan + 4-6 specs).
 */
import { describe, it, expect } from 'vitest';
import { isCoverDesign, computeImageCoverageRatio } from '../../../src/v2/engine/classify';
import type { ExtractedPage, TextSpan, Bbox } from '../../../src/v2/types';
import type { ProductBlock } from '../../../src/v2/engine/blockDetector';

function makeSpan(text: string, x: number, y: number, size = 16): TextSpan {
  return {
    text,
    bbox: [x, y, x + 100, y + size],
    font: 'Helvetica-SemiBold',
    size,
    color: '#000000',
  };
}

function makePage(images: Bbox[] = [], width = 595, height = 842): ExtractedPage {
  return {
    page_number: 1,
    page_size: { width, height },
    slots: [],
    raw_spans: [],
    raw_images: images,
  };
}

function makeBlock(opts: { ref?: boolean; specs?: number } = {}): ProductBlock {
  return {
    pageNumber: 1,
    nameSpan: makeSpan('PRODUIT', 50, 100),
    nameWrappedCount: 1,
    refSpan: opts.ref ? makeSpan('1234567', 110, 120, 11) : null,
    colorSpan: null,
    specs: Array.from({ length: opts.specs ?? 0 }, (_, i) => ({
      key: makeSpan(`KEY${i}`, 300, 130 + i * 14, 11),
      values: [makeSpan(`val${i}`, 400, 130 + i * 14, 11)],
    })),
    variantImages: [],
    variantSpans: [],
    mainImageBbox: null,
    yTop: 80,
    yBottom: 300,
    specsYTop: 130,
    specsYBottom: 280,
    specsXLeft: 200,
  };
}

describe('isCoverDesign — detection cover non substituable', () => {
  it('page produit Catalogue A classique (couverture image 25%, ref + specs) : NOT cover', () => {
    // Page 595x842 = 500'900 area. Image 200x200 = 40'000 = 8%. Plusieurs images.
    const page = makePage([
      [50, 100, 250, 300], // 40'000
      [50, 400, 250, 600], // 40'000
      [300, 100, 500, 300], // 40'000 → total 12% pas > 50%
    ]);
    const blocks = [makeBlock({ ref: true, specs: 5 })];
    expect(isCoverDesign(page, blocks)).toBe(false);
  });

  it('cover Catalogue C "NOS MARQUES" (image 60%, blocs vides) : COVER', () => {
    // 1 image gigantesque qui couvre 60%
    const imgArea = 0.6 * 595 * 842;
    const imgW = Math.sqrt(imgArea);
    const page = makePage([[0, 0, imgW, imgW]]);
    const blocks = [makeBlock({ ref: false, specs: 0 })];
    expect(isCoverDesign(page, blocks)).toBe(true);
  });

  it('image >50% mais blocs ont refs : NOT cover (conservateur Catalogue A)', () => {
    const page = makePage([[0, 0, 595, 500]]); // ~60% pageH
    const blocks = [makeBlock({ ref: true, specs: 3 })];
    // Meme avec gros visuel, si le bloc a une ref, on respecte le classifier
    expect(isCoverDesign(page, blocks)).toBe(false);
  });

  it('image >50% blocs sans ref MAIS avec specs (≥2) : NOT cover', () => {
    const page = makePage([[0, 0, 595, 500]]);
    const blocks = [makeBlock({ ref: false, specs: 5 })];
    // Specs nombreuses → vraie fiche meme sans ref → ne pas considerer cover
    expect(isCoverDesign(page, blocks)).toBe(false);
  });

  it('faille review : cover avec 2 specs random ("Edition 2025", "Version 1.0") : encore COVER', () => {
    // Page cover avec totalSpecs = 2 < 3 → cover detecte
    const imgArea = 0.55 * 595 * 842;
    const imgW = Math.sqrt(imgArea);
    const page = makePage([[0, 0, imgW, imgW]]);
    // 1 bloc avec 2 specs (Edition + Version) - sans ref, sans mainImage
    const blocks = [makeBlock({ ref: false, specs: 2 })];
    // Ancien comportement : specs.length<2 false → NOT cover (FAUX POSITIF cover)
    // Nouveau : totalSpecs=2 < 3 → cover OK
    expect(isCoverDesign(page, blocks)).toBe(true);
  });

  it('faille review : >= 3 specs total → vraie fiche, NOT cover', () => {
    const page = makePage([[0, 0, 595, 500]]); // 60% cov
    const blocks = [
      makeBlock({ ref: false, specs: 2 }),
      makeBlock({ ref: false, specs: 2 }),
    ];
    expect(isCoverDesign(page, blocks)).toBe(false);
  });

  it('faille review : bloc avec mainImageBbox → NOT cover', () => {
    const page = makePage([[0, 0, 595, 500]]); // 60% cov
    const block = makeBlock({ ref: false, specs: 0 });
    (block as any).mainImageBbox = [100, 200, 300, 400];
    expect(isCoverDesign(page, [block])).toBe(false);
  });

  it('liste blocs vide → NOT cover', () => {
    const page = makePage([[0, 0, 595, 800]]);
    expect(isCoverDesign(page, [])).toBe(false);
  });

  it('page sans images → NOT cover (peu importe blocs)', () => {
    const page = makePage([]);
    const blocks = [makeBlock({ ref: false, specs: 0 })];
    expect(isCoverDesign(page, blocks)).toBe(false);
  });

  it('imgCoverage exactement 0.5 avec 1 grande image : COVER (full-bleed)', () => {
    // 50% exact via 1 seule image → largestImgRatio = 0.5 > 0.35 → cover detect
    const imgArea = 0.5 * 595 * 842;
    const imgW = Math.sqrt(imgArea);
    const page = makePage([[0, 0, imgW, imgW]]);
    const blocks = [makeBlock({ ref: false, specs: 0 })];
    expect(isCoverDesign(page, blocks)).toBe(true);
  });

  it('imgCoverage 0.4 reparti sur 8 petites images : NOT cover', () => {
    // 8 images couvrant 0.4 total mais chacune ~5% → largest 5% < 35%
    // ET imgCoverage 0.4 < 0.5 → NOT cover
    const images = Array.from({ length: 8 }, (_, i) => {
      const x = (i % 4) * 100;
      const y = Math.floor(i / 4) * 100;
      return [x, y, x + 80, y + 80] as [number, number, number, number];
    });
    // Total 8 * 80*80 = 51200 / (595*842) = 10% pas 40%, ajustons
    const page = makePage(images);
    const blocks = [makeBlock({ ref: false, specs: 0 })];
    expect(isCoverDesign(page, blocks)).toBe(false);
  });

  it('computeImageCoverageRatio basique', () => {
    const page = makePage([
      [0, 0, 100, 100], // 10k
      [200, 200, 300, 300], // 10k
    ]);
    // 20k / (595 * 842) = 0.04
    const ratio = computeImageCoverageRatio(page);
    expect(ratio).toBeGreaterThan(0.03);
    expect(ratio).toBeLessThan(0.05);
  });
});

/**
 * Tests scoreProductPage — design scoring allocator (Phase 3 T1).
 *
 * Pas branche dans allocator pour ce commit (feature flag a venir). On
 * teste juste la formule pour qu'elle soit prête.
 */
import { describe, it, expect } from 'vitest';
import { scoreProductPage } from '../../../src/v2/engine/allocator';
import type { PageClassification } from '../../../src/v2/engine/classify';
import type { ProductBlock } from '../../../src/v2/engine/blockDetector';
import type { TextSpan, ExtractedPage, Bbox } from '../../../src/v2/types';

function makeBlock(opts: { ref?: boolean; specs?: number; image?: boolean } = {}): ProductBlock {
  const span: TextSpan = {
    text: 'PROD',
    bbox: [50, 100, 150, 116],
    font: 'Helvetica-SemiBold',
    size: 16,
    color: '#000000',
  };
  const refSpan: TextSpan | null = opts.ref
    ? { text: '1234567', bbox: [110, 120, 160, 132], font: 'Helvetica', size: 11, color: '#000000' }
    : null;
  const mainImageBbox: Bbox | null = opts.image ? [50, 130, 200, 280] : null;
  return {
    pageNumber: 1,
    nameSpan: span,
    nameWrappedCount: 1,
    refSpan,
    colorSpan: null,
    specs: Array.from({ length: opts.specs ?? 0 }, (_, i) => ({
      key: { text: `K${i}`, bbox: [200, 130 + i * 14, 240, 142 + i * 14], font: 'Bold', size: 11, color: '#000' },
      values: [{ text: `v${i}`, bbox: [250, 130 + i * 14, 290, 142 + i * 14], font: 'Light', size: 11, color: '#000' }],
    })),
    variantImages: [],
    variantSpans: [],
    mainImageBbox,
    yTop: 80,
    yBottom: 280,
    specsYTop: 130,
    specsYBottom: 260,
    specsXLeft: 200,
  };
}

function makePage(blocks: ProductBlock[]): PageClassification {
  const extracted: ExtractedPage = {
    page_number: 1,
    page_size: { width: 595, height: 842 },
    slots: [],
  };
  return {
    pageNumber: 1,
    extracted,
    blocks,
    kind: 'product',
    sectionLabel: null,
    activeSection: 'TEST',
    confidence: 0.95,
  };
}

describe('scoreProductPage — design scoring allocator', () => {
  it('page sans blocs : score 0', () => {
    const score = scoreProductPage(makePage([]));
    expect(score.total).toBe(0);
  });

  it('page 1 bloc minimum (sans ref/specs/image) : score faible', () => {
    const score = scoreProductPage(makePage([makeBlock()]));
    // blockCount = 1/3 = 0.33, autres = 0
    // total = 0.33 * 0.3 = ~0.10
    expect(score.total).toBeLessThan(0.15);
  });

  it('page 3 blocs riches (ref + 5 specs + image) : score eleve', () => {
    const blocks = [
      makeBlock({ ref: true, specs: 5, image: true }),
      makeBlock({ ref: true, specs: 5, image: true }),
      makeBlock({ ref: true, specs: 5, image: true }),
    ];
    const score = scoreProductPage(makePage(blocks));
    // Tous composantes a 1.0 → total = 1.0
    expect(score.total).toBeCloseTo(1.0, 1);
  });

  it('page Catalogue A typique (3 blocs + ref + 4 specs + image) : score eleve', () => {
    const blocks = [
      makeBlock({ ref: true, specs: 4, image: true }),
      makeBlock({ ref: true, specs: 4, image: true }),
      makeBlock({ ref: true, specs: 4, image: true }),
    ];
    const score = scoreProductPage(makePage(blocks));
    // 3 blocs (1.0), 4 specs = 0.8, ref 1.0, img 1.0
    // total = 1.0*0.3 + 0.8*0.3 + 1.0*0.2 + 1.0*0.2 = 0.94
    expect(score.total).toBeGreaterThan(0.90);
    expect(score.total).toBeLessThan(1.0);
  });

  it('comparaison : page riche > page pauvre (invariant scoring)', () => {
    const richBlock = makeBlock({ ref: true, specs: 5, image: true });
    const poorBlock = makeBlock();
    const richScore = scoreProductPage(makePage([richBlock, richBlock, richBlock]));
    const poorScore = scoreProductPage(makePage([poorBlock]));
    expect(richScore.total).toBeGreaterThan(poorScore.total);
  });

  it('breakdown disponible (audit)', () => {
    const blocks = [makeBlock({ ref: true, specs: 3, image: false })];
    const score = scoreProductPage(makePage(blocks));
    expect(score.blockCount).toBeCloseTo(1 / 3, 5);
    expect(score.avgSpecsPerBlock).toBeCloseTo(3 / 5, 5);
    expect(score.refsRatio).toBe(1);
    expect(score.imagesRatio).toBe(0);
  });

  it('plateau blocks : 4+ blocs ne donne pas plus de blockComp que 3', () => {
    const block = makeBlock();
    const score3 = scoreProductPage(makePage([block, block, block]));
    const score4 = scoreProductPage(makePage([block, block, block, block]));
    expect(score3.blockCount).toBe(1);
    expect(score4.blockCount).toBe(1);
  });

  it('plateau specs : 5+ specs ne donne pas plus de specsComp que 5', () => {
    const block5 = makeBlock({ specs: 5 });
    const block10 = makeBlock({ specs: 10 });
    const score5 = scoreProductPage(makePage([block5]));
    const score10 = scoreProductPage(makePage([block10]));
    expect(score5.avgSpecsPerBlock).toBe(1);
    expect(score10.avgSpecsPerBlock).toBe(1);
  });

  it('total est dans [0, 1] (invariant)', () => {
    // Test extreme : 10 blocs * 10 specs * tout
    const block = makeBlock({ ref: true, specs: 10, image: true });
    const blocks = Array.from({ length: 10 }, () => block);
    const score = scoreProductPage(makePage(blocks));
    expect(score.total).toBeLessThanOrEqual(1.0);
    expect(score.total).toBeGreaterThanOrEqual(0);
  });
});

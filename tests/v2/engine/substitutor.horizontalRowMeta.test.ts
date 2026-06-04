/**
 * Tests computeHorizontalRowMeta (S6.5 etape 2).
 *
 * Regroupe les blocs d'une page horizontale par row Y, choisit le primary
 * (1er de gauche) et calcule colRight pour les secondaries.
 */
import { describe, it, expect } from 'vitest';
import { computeHorizontalRowMeta } from '../../../src/v2/engine/substitutor';
import type { ProductBlock } from '../../../src/v2/engine/blockDetector';
import type { TextSpan } from '../../../src/v2/types';

function makeBlock(x: number, y: number, name = 'PROD'): ProductBlock {
  const span: TextSpan = {
    text: name,
    bbox: [x, y, x + 100, y + 16],
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
    yTop: y,
    yBottom: y + 200,
    specsYTop: y + 30,
    specsYBottom: y + 180,
    specsXLeft: x + 100,
    isHorizontalLayout: true,
  };
}

describe('computeHorizontalRowMeta', () => {
  it('1 row de 3 blocs (Catalogue C-like) : block 0 primary, 1+2 secondary', () => {
    const blocks = [
      makeBlock(50, 100, 'ECOP'),
      makeBlock(250, 100, 'ECL250'),
      makeBlock(450, 100, 'ECL400'),
    ];
    const meta = computeHorizontalRowMeta(blocks);
    expect(meta.get(blocks[0])?.mode).toBe('horizontal-primary');
    expect(meta.get(blocks[1])?.mode).toBe('horizontal-secondary');
    expect(meta.get(blocks[2])?.mode).toBe('horizontal-secondary');
  });

  it('colRight : bloc 0 = X bloc 1 - 4, dernier = pageW - ribbonMargin', () => {
    const blocks = [
      makeBlock(50, 100),
      makeBlock(250, 100),
      makeBlock(450, 100),
    ];
    const meta = computeHorizontalRowMeta(blocks, 595, 30);
    expect(meta.get(blocks[0])?.colRight).toBe(250 - 4);
    expect(meta.get(blocks[1])?.colRight).toBe(450 - 4);
    // Dernier bloc : pageW - ribbonMargin (vs ancien Infinity)
    expect(meta.get(blocks[2])?.colRight).toBe(595 - 30);
  });

  it('2 rows distinctes (Y differents) : chacune a son primary', () => {
    const blocks = [
      makeBlock(50, 100), // row 1
      makeBlock(250, 100), // row 1
      makeBlock(50, 400), // row 2
      makeBlock(250, 400), // row 2
    ];
    const meta = computeHorizontalRowMeta(blocks);
    const primaryCount = Array.from(meta.values()).filter(
      (m) => m.mode === 'horizontal-primary',
    ).length;
    expect(primaryCount).toBe(2);
  });

  it('blocs jitter Y faible (diff < tolerance adaptee a size=16) : meme row', () => {
    // size=16 (makeBlock default) → tol = max(4, 16*0.30) = 4.8
    // Donc jitter 3pt OK
    const blocks = [
      makeBlock(50, 100),
      makeBlock(250, 103),
      makeBlock(450, 102),
    ];
    const meta = computeHorizontalRowMeta(blocks);
    const primaryCount = Array.from(meta.values()).filter(
      (m) => m.mode === 'horizontal-primary',
    ).length;
    expect(primaryCount).toBe(1);
  });

  it('blocs ordres X non tries : primary = leftmost', () => {
    // Input dans desordre : 3e, 1er, 2e
    const blocks = [makeBlock(450, 100), makeBlock(50, 100), makeBlock(250, 100)];
    const meta = computeHorizontalRowMeta(blocks);
    // Le bloc avec x=50 doit etre primary
    const primary = blocks.find((b) => meta.get(b)?.mode === 'horizontal-primary');
    expect(primary?.nameSpan.bbox[0]).toBe(50);
  });

  it('liste vide → meta vide', () => {
    expect(computeHorizontalRowMeta([]).size).toBe(0);
  });

  it('1 seul bloc : il est primary, colRight = pageW - ribbonMargin (clamp fini)', () => {
    const blocks = [makeBlock(50, 100)];
    const meta = computeHorizontalRowMeta(blocks, 595, 30);
    expect(meta.get(blocks[0])?.mode).toBe('horizontal-primary');
    expect(meta.get(blocks[0])?.colRight).toBe(595 - 30);
  });

  it('1 seul bloc sans pageW : fallback 600', () => {
    const blocks = [makeBlock(50, 100)];
    const meta = computeHorizontalRowMeta(blocks);
    expect(meta.get(blocks[0])?.colRight).toBe(600);
  });
});

/**
 * Tests du calcul des blockZones pour polish des residus.
 *
 * Faille review #8 : un span "NOUVEAUTE" / "PROMO" entre 2 blocs (gap >= 8pt)
 * n'etait pas couvert par la zone block (padding fixe 4pt) → restait visible.
 *
 * Fix : padding adaptatif 4-12pt selon gap au-dessus.
 */
import { describe, it, expect } from 'vitest';
import { computeBlockZones } from '../../../src/v2/engine/substitutor';
import { DEFAULT_PROFILE } from '../../../src/v2/engine/profile';
import type { ProductBlock } from '../../../src/v2/engine/blockDetector';

function makeBlock(yTop: number, yBottom: number, pageNum = 1): ProductBlock {
  return {
    pageNumber: pageNum,
    nameSpan: {
      text: 'PRODUIT',
      bbox: [50, yTop, 200, yTop + 16],
      font: 'Helvetica-SemiBold',
      size: 16,
      color: '#000000',
    },
    nameWrappedCount: 1,
    refSpan: null,
    colorSpan: null,
    specs: [],
    variantImages: [],
    variantSpans: [],
    mainImageBbox: null,
    yTop,
    yBottom,
    specsYTop: yTop + 30,
    specsYBottom: yBottom - 10,
    specsXLeft: 200,
  };
}

describe('computeBlockZones — padding top adaptatif', () => {
  it('1 seul bloc (lastBlock) : zone etendue jusqu au footer', () => {
    const zones = computeBlockZones([makeBlock(100, 200)], {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    expect(zones).toHaveLength(1);
    const [, yTopZone, , yBotZone] = zones[0];
    // yTop reduit (padding par gap = 100/2 - 1 = 49 → clamp a 12)
    expect(yTopZone).toBe(100 - 12);
    // Bottom etendu jusqu au footer (pageHeight - 30 = 812)
    expect(yBotZone).toBe(842 - 30);
  });

  it('2 blocs serres (gap 8pt) : padding top = 4pt (default)', () => {
    // Bloc A: 100-200, Bloc B: 208-300. Gap entre = 8pt.
    const zones = computeBlockZones(
      [makeBlock(100, 200), makeBlock(208, 300)],
      { pageWidth: 595, pageHeight: 842, profile: DEFAULT_PROFILE },
    );
    // Bloc B (sorted[1]) : gap = 208-200 = 8 → topPadding = max(4, 8/2-1=3) = 4
    const zoneB = zones[1];
    expect(zoneB[1]).toBe(208 - 4); // padding = 4
  });

  it('2 blocs espaces (gap 30pt) : padding top = 12pt (max)', () => {
    // Bloc A: 100-200, Bloc B: 230-330. Gap entre = 30pt.
    const zones = computeBlockZones(
      [makeBlock(100, 200), makeBlock(230, 330)],
      { pageWidth: 595, pageHeight: 842, profile: DEFAULT_PROFILE },
    );
    // Bloc B : gap = 30 → topPadding = max(4, 30/2-1=14) = clamp a 12
    const zoneB = zones[1];
    expect(zoneB[1]).toBe(230 - 12);
  });

  it('2 blocs : zones ne mordent jamais l une sur l autre', () => {
    // Bloc A: 100-200, Bloc B: 210-310. Gap = 10pt.
    const zones = computeBlockZones(
      [makeBlock(100, 200), makeBlock(210, 310)],
      { pageWidth: 595, pageHeight: 842, profile: DEFAULT_PROFILE },
    );
    const [, , , yBotA] = zones[0];
    const [, yTopB] = zones[1];
    expect(yBotA).toBeLessThanOrEqual(yTopB);
  });

  it('cas bloc colle au header (premier bloc, yTop=20)', () => {
    const zones = computeBlockZones([makeBlock(20, 200)], {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    // gap = block.yTop (20) → topPadding = max(4, 20/2-1=9) = 9
    expect(zones[0][1]).toBe(20 - 9);
  });

  it('cas large gap mais clamp a 12 : conservatif', () => {
    // Bloc A: 50-100, Bloc B: 500-600 (gap enorme 400pt)
    const zones = computeBlockZones(
      [makeBlock(50, 100), makeBlock(500, 600)],
      { pageWidth: 595, pageHeight: 842, profile: DEFAULT_PROFILE },
    );
    const [, yTopB] = zones[1];
    // Padding clampe a 12 (pas 200)
    expect(yTopB).toBe(500 - 12);
  });
});

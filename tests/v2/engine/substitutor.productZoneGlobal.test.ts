/**
 * Tests computeProductZoneGlobal — UNION bbox blocks + padding pour polish
 * decoratifs hors-blocks (drapeaux ACS, etiquettes inter-blocs).
 *
 * Non branche dans le pipeline pour ce commit (helper exporte pour tour
 * suivant). Pas de regression Catalogue A possible.
 */
import { describe, it, expect } from 'vitest';
import { computeProductZoneGlobal } from '../../../src/v2/engine/substitutor';
import { DEFAULT_PROFILE } from '../../../src/v2/engine/profile';
import type { ProductBlock } from '../../../src/v2/engine/blockDetector';
import type { TextSpan } from '../../../src/v2/types';

function makeBlock(yTop: number, xLeft = 50): ProductBlock {
  const span: TextSpan = {
    text: 'PROD',
    bbox: [xLeft, yTop, xLeft + 100, yTop + 16],
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
    yTop,
    yBottom: yTop + 150,
    specsYTop: yTop + 30,
    specsYBottom: yTop + 130,
    specsXLeft: xLeft + 100,
  };
}

const CTX = {
  pageWidth: 595,
  pageHeight: 842,
  profile: DEFAULT_PROFILE,
};

describe('computeProductZoneGlobal', () => {
  it('liste vide → null (rien a polish au global)', () => {
    expect(computeProductZoneGlobal([], CTX)).toBeNull();
  });

  it('1 bloc : zone englobe + padding', () => {
    const blocks = [makeBlock(100)];
    const zone = computeProductZoneGlobal(blocks, CTX);
    expect(zone).not.toBeNull();
    // x : min(50, 150) - 8 = 42
    expect(zone![0]).toBe(42);
    // y : 100 - 6 = 94, mais headerMargin 30 → max(30, 94) = 94
    expect(zone![1]).toBe(94);
    // y bot : 250 + 6 = 256
    expect(zone![3]).toBe(256);
  });

  it('3 blocs verticaux Catalogue A-like : zone couvre toute la hauteur du 1er au dernier', () => {
    const blocks = [makeBlock(100), makeBlock(300), makeBlock(500)];
    const zone = computeProductZoneGlobal(blocks, CTX);
    expect(zone).not.toBeNull();
    // y top = 100 - 6 = 94
    expect(zone![1]).toBe(94);
    // y bot = 650 + 6 = 656
    expect(zone![3]).toBe(656);
  });

  it('cas Catalogue E : 3 blocs avec drapeaux entre eux → zone absorbe l espace inter-blocs', () => {
    // Blocs a y=100, 300, 500. Drapeaux ACS hypothetiques a y=250 (gap entre b0 et b1)
    const blocks = [makeBlock(100), makeBlock(300), makeBlock(500)];
    const zone = computeProductZoneGlobal(blocks, CTX);
    expect(zone).not.toBeNull();
    // y=250 doit etre DANS la zone (entre 94 et 656)
    expect(250).toBeGreaterThanOrEqual(zone![1]);
    expect(250).toBeLessThanOrEqual(zone![3]);
  });

  it('header/footer exclus : y top >= 30, y bot <= pageHeight - 30', () => {
    const blocks = [makeBlock(5)]; // yTop tres haut
    const zone = computeProductZoneGlobal(blocks, CTX);
    expect(zone![1]).toBeGreaterThanOrEqual(30);
  });

  it('paddingX/Y configurable', () => {
    const blocks = [makeBlock(100)];
    const zoneSmall = computeProductZoneGlobal(blocks, CTX, { paddingX: 0, paddingY: 0 });
    const zoneLarge = computeProductZoneGlobal(blocks, CTX, { paddingX: 20, paddingY: 20 });
    expect(zoneSmall![0]).toBeGreaterThan(zoneLarge![0] - 1);
    expect(zoneLarge![0]).toBeLessThan(zoneSmall![0]);
  });

  it('headerMargin/footerMargin custom', () => {
    const blocks = [makeBlock(100, 50), makeBlock(700, 50)];
    const zoneStrict = computeProductZoneGlobal(blocks, CTX, {
      headerMargin: 100,
      footerMargin: 100,
    });
    expect(zoneStrict![1]).toBeGreaterThanOrEqual(100);
    expect(zoneStrict![3]).toBeLessThanOrEqual(842 - 100);
  });

  it('regression : bbox toujours valide (x1>x0, y1>y0)', () => {
    const blocks = [makeBlock(100, 100), makeBlock(300, 100)];
    const zone = computeProductZoneGlobal(blocks, CTX);
    expect(zone![2]).toBeGreaterThan(zone![0]);
    expect(zone![3]).toBeGreaterThan(zone![1]);
  });
});

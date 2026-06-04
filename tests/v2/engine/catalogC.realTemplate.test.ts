/**
 * Tests fixtures Catalogue C REAL template (124 pages).
 *
 * Donnees :
 *   - catalogC_p14_real.json : fiche produit horizontale 3-cols
 *     (ECOP 100 / ECL 250 / ECL 400)
 *   - catalogC_p4_nosmarques.json : page cover marketing "NOS MARQUES"
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { detectProfileHeuristic } from '../../../src/v2/engine/profile';
import { findProductBlocks } from '../../../src/v2/engine/blockDetector';
import { isCoverDesign } from '../../../src/v2/engine/classify';
import type { ExtractedPage } from '../../../src/v2/types';

const FIX = path.join(__dirname, '../fixtures/extracted/catalogC_p14_real.json');
const page: ExtractedPage = JSON.parse(readFileSync(FIX, 'utf-8'));
const FIX_COVER = path.join(__dirname, '../fixtures/extracted/catalogC_p4_nosmarques.json');
const pageCover: ExtractedPage = JSON.parse(readFileSync(FIX_COVER, 'utf-8'));

describe('Catalogue C template P14 — fiche horizontale 3 cols', () => {
  it('page A4 portrait 595x842', () => {
    expect(Math.round(page.page_size.width)).toBe(595);
    expect(Math.round(page.page_size.height)).toBe(842);
  });

  it('contient les noms ECOP/ECL/ECL en HelveticaNeueLTStd-Cn 15pt', () => {
    const spans = page.raw_spans ?? [];
    const namesAtRow = spans.filter(
      (s) =>
        Math.abs(s.bbox[1] - 242.5) <= 3 &&
        s.size >= 14 &&
        s.font.includes('Cn'),
    );
    // ECOP, 100, ECL 250, ECL 400 = au moins 3 spans (ECOP+100 séparés)
    expect(namesAtRow.length).toBeGreaterThanOrEqual(3);
  });

  it('contient ribbon vertical "ÉVACUATION" sur bord gauche', () => {
    const spans = page.raw_spans ?? [];
    const ribbon = spans.find((s) => s.text.trim() === 'ÉVACUATION');
    expect(ribbon).toBeDefined();
    expect(ribbon!.bbox[0]).toBeLessThan(30); // bord gauche
  });

  it('detectProfileHeuristic detecte le profile Catalogue C (non-fallback ideal)', () => {
    const profile = detectProfileHeuristic([page]);
    expect(profile).toBeDefined();
    // Sur Catalogue C reel : nameFontPattern devrait inclure "Cn" ou similaire
    // Si fallback, le pipeline ne va pas detecter les blocs correctement
    console.log('Profile Catalogue C detected:', {
      source: profile.source,
      nameFontPattern: profile.nameFontPattern,
      nameSizeRange: profile.nameSizeRange,
      keyFontPattern: profile.keyFontPattern,
      valueFontPattern: profile.valueFontPattern,
    });
  });

  it('findProductBlocks detecte exactement 3 blocs ECOP 100 / ECL 250 / ECL 400', () => {
    const profile = detectProfileHeuristic([page]);
    const blocks = findProductBlocks(page, profile);
    expect(blocks.length).toBe(3);
    const names = blocks.map((b) => b.nameSpan.text.trim());
    expect(names).toContain('ECOP 100');
    expect(names).toContain('ECL 250');
    expect(names).toContain('ECL 400');
    // Tous en horizontal
    for (const b of blocks) {
      expect(b.isHorizontalLayout).toBe(true);
    }
  });
});

describe('Catalogue C template P4 — cover NOS MARQUES', () => {
  it('isCoverDesign=true (headlines geants + imgCoverage > 70%)', () => {
    const blocks: never[] = [];
    expect(isCoverDesign(pageCover, blocks)).toBe(true);
  });

  it('contient headlines marketing > 30pt', () => {
    const spans = pageCover.raw_spans ?? [];
    const giants = spans.filter((s) => s.size > 30);
    expect(giants.length).toBeGreaterThanOrEqual(2);
  });
});

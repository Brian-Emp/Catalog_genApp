/**
 * Tests dedupRibbonsByRow — anti-UNION-geant.
 *
 * Faille review #6 : la dedup mergeait par UNION sans verifier la taille
 * du rectangle final. Cas dangereux : 2 ribbons horizontaux distincts
 * a gauche + droite alignes en Y → UNION = rectangle plein-page → erase
 * efface tout le contenu produit central.
 *
 * Fix : si union > 70% pageW (horiz) ou pageH (vert), pas de merge.
 */
import { describe, it, expect } from 'vitest';
import { dedupRibbonsByRow } from '../../src/v2/engineOrchestrator';

type Ribbon = { text: string; bbox: [number, number, number, number] };

const PAGE_W = 595;
const PAGE_H = 842;

describe('dedupRibbonsByRow — anti UNION geant', () => {
  it('cas Catalogue C : 2 spans contigus meme row → merge OK (gap petit)', () => {
    const ribbons: Ribbon[] = [
      { text: 'POMPES D EVACUATION', bbox: [50, 30, 250, 50] },
      { text: 'EAUX CLAIRES', bbox: [260, 30, 380, 50] },
    ];
    const out = dedupRibbonsByRow(ribbons, PAGE_W, PAGE_H);
    expect(out).toHaveLength(1);
    expect(out[0].bbox).toEqual([50, 30, 380, 50]);
  });

  it('cas dangereux : ribbon gauche + ribbon droite meme Y → PAS merge', () => {
    // 2 ribbons opposes, union ferait 595pt = 100% pageW > 70%
    const ribbons: Ribbon[] = [
      { text: 'GAUCHE', bbox: [10, 30, 100, 50] },
      { text: 'DROITE', bbox: [495, 30, 585, 50] },
    ];
    const out = dedupRibbonsByRow(ribbons, PAGE_W, PAGE_H);
    expect(out).toHaveLength(2);
  });

  it('cas borderline : union exactement 70% pageW → merge accepte', () => {
    // union de [0, 416] = 416.5 = 70% * 595
    const ribbons: Ribbon[] = [
      { text: 'A', bbox: [0, 30, 100, 50] },
      { text: 'B', bbox: [300, 30, 416, 50] },
    ];
    const out = dedupRibbonsByRow(ribbons, PAGE_W, PAGE_H);
    // 416 - 0 = 416 <= 595 * 0.7 = 416.5 → merge OK
    expect(out).toHaveLength(1);
  });

  it('cas Y eloignes (> RIBBON_Y_TOL = 4) → PAS merge meme si proches X', () => {
    const ribbons: Ribbon[] = [
      { text: 'HAUT', bbox: [50, 30, 150, 50] },
      { text: 'MILIEU', bbox: [50, 100, 150, 120] }, // Y=100 vs Y=30 → > 4pt
    ];
    const out = dedupRibbonsByRow(ribbons, PAGE_W, PAGE_H);
    expect(out).toHaveLength(2);
  });

  it('vertical : 2 ribbons cote a cote meme X → merge', () => {
    // Ribbons verticaux (h > w) sur meme bord X
    const ribbons: Ribbon[] = [
      { text: 'SECT A', bbox: [10, 100, 30, 250] }, // h=150 > w=20
      { text: 'SECT B', bbox: [10, 260, 30, 410] },
    ];
    const out = dedupRibbonsByRow(ribbons, PAGE_W, PAGE_H);
    // union H = 410 - 100 = 310 < 0.7 * 842 = 589.4 → merge OK
    expect(out).toHaveLength(1);
  });

  it('vertical : 2 ribbons haut + bas tres eloignes → PAS merge', () => {
    // union H = 800 - 50 = 750 > 0.7 * 842 = 589 → pas merge
    const ribbons: Ribbon[] = [
      { text: 'HAUT', bbox: [10, 50, 30, 200] },
      { text: 'BAS', bbox: [10, 650, 30, 800] },
    ];
    const out = dedupRibbonsByRow(ribbons, PAGE_W, PAGE_H);
    expect(out).toHaveLength(2);
  });

  it('mix horizontal + vertical : jamais merges entre eux', () => {
    const ribbons: Ribbon[] = [
      { text: 'H', bbox: [50, 30, 200, 50] }, // horizontal
      { text: 'V', bbox: [50, 30, 70, 200] }, // vertical
    ];
    const out = dedupRibbonsByRow(ribbons, PAGE_W, PAGE_H);
    expect(out).toHaveLength(2);
  });

  it('liste vide → []', () => {
    expect(dedupRibbonsByRow([], PAGE_W, PAGE_H)).toEqual([]);
  });

  it('1 seul ribbon → inchange', () => {
    const ribbons: Ribbon[] = [{ text: 'A', bbox: [50, 30, 200, 50] }];
    expect(dedupRibbonsByRow(ribbons, PAGE_W, PAGE_H)).toEqual(ribbons);
  });

  it('3 spans consecutifs meme row → tous merges si union < 70%', () => {
    const ribbons: Ribbon[] = [
      { text: 'A', bbox: [50, 30, 150, 50] },
      { text: 'B', bbox: [160, 30, 260, 50] },
      { text: 'C', bbox: [270, 30, 370, 50] },
    ];
    const out = dedupRibbonsByRow(ribbons, PAGE_W, PAGE_H);
    expect(out).toHaveLength(1);
    expect(out[0].bbox).toEqual([50, 30, 370, 50]);
  });

  it('regression : 2 ribbons opposes NE creent pas un rect plein-page', () => {
    const ribbons: Ribbon[] = [
      { text: 'GAUCHE', bbox: [10, 30, 50, 50] },
      { text: 'DROITE', bbox: [545, 30, 585, 50] },
    ];
    const out = dedupRibbonsByRow(ribbons, PAGE_W, PAGE_H);
    // Sans le garde-fou : 1 ribbon de bbox [10, 30, 585, 50] (95% pageW) → DANGER
    // Avec le garde-fou : 2 ribbons distincts preserves
    expect(out).toHaveLength(2);
    for (const r of out) {
      const w = r.bbox[2] - r.bbox[0];
      expect(w).toBeLessThan(PAGE_W * 0.7);
    }
  });
});

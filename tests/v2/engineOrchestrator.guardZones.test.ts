/**
 * Tests computeIntercalaireGuardZones — zones adaptatives selon taille catalogue.
 *
 * Faille review : seuil INTRO_ZONE/OUTRO_ZONE = 5 fixe causait :
 *   - mini-cata 8 pages : 100% protégé → aucune page intercalaire exploitable
 *   - mega-cata 200 pages : 2.5% protégé → trop de pages debut/fin vulnerables
 */
import { describe, it, expect } from 'vitest';
import { computeIntercalaireGuardZones } from '../../src/v2/engineOrchestrator';

describe('computeIntercalaireGuardZones', () => {
  describe('mini-catalogue (< 12 pages)', () => {
    it('8 pages → intro=1 outro=1', () => {
      expect(computeIntercalaireGuardZones(8)).toEqual({ intro: 1, outro: 1 });
    });

    it('5 pages → intro=1 outro=1 (toujours min)', () => {
      expect(computeIntercalaireGuardZones(5)).toEqual({ intro: 1, outro: 1 });
    });

    it('1 page → intro=0 outro=0 (cata degenere, aucune zone)', () => {
      expect(computeIntercalaireGuardZones(1)).toEqual({ intro: 0, outro: 0 });
    });

    it('2 pages → intro=0 outro=0 (toujours degenere)', () => {
      expect(computeIntercalaireGuardZones(2)).toEqual({ intro: 0, outro: 0 });
    });

    it('3 pages → intro=1 outro=1 (premier vrai mini-catalogue)', () => {
      expect(computeIntercalaireGuardZones(3)).toEqual({ intro: 1, outro: 1 });
    });

    it('11 pages : juste sous la limite', () => {
      expect(computeIntercalaireGuardZones(11)).toEqual({ intro: 1, outro: 1 });
    });
  });

  describe('catalogue standard (12-50 pages)', () => {
    it('12 pages → intro=5 outro=5 (legacy)', () => {
      expect(computeIntercalaireGuardZones(12)).toEqual({ intro: 5, outro: 5 });
    });

    it('30 pages (catalogue Catalogue A) → intro=5 outro=5', () => {
      expect(computeIntercalaireGuardZones(30)).toEqual({ intro: 5, outro: 5 });
    });

    it('50 pages : juste a la limite', () => {
      expect(computeIntercalaireGuardZones(50)).toEqual({ intro: 5, outro: 5 });
    });
  });

  describe('mega-catalogue (> 50 pages)', () => {
    it('100 pages → intro=5 outro=5 (5% = 5, sous le cap)', () => {
      expect(computeIntercalaireGuardZones(100)).toEqual({ intro: 5, outro: 5 });
    });

    it('200 pages → intro=10 outro=10 (5% = 10, cap atteint)', () => {
      expect(computeIntercalaireGuardZones(200)).toEqual({ intro: 10, outro: 10 });
    });

    it('500 pages → intro=10 outro=10 (cappe a 10, pas 25)', () => {
      expect(computeIntercalaireGuardZones(500)).toEqual({ intro: 10, outro: 10 });
    });

    it('51 pages : juste au-dessus du seuil → 5% = 3 (ceil)', () => {
      expect(computeIntercalaireGuardZones(51)).toEqual({ intro: 3, outro: 3 });
    });
  });

  describe('invariants', () => {
    it('intro et outro sont toujours egaux (symetrie)', () => {
      const sizes = [1, 5, 9, 10, 30, 50, 51, 100, 200, 500, 1000];
      for (const n of sizes) {
        const { intro, outro } = computeIntercalaireGuardZones(n);
        expect(intro).toBe(outro);
      }
    });

    it('zones sont toujours >= 1 pour totalPages >= 3', () => {
      const sizes = [3, 5, 10, 30, 100, 200];
      for (const n of sizes) {
        const { intro, outro } = computeIntercalaireGuardZones(n);
        expect(intro).toBeGreaterThanOrEqual(1);
        expect(outro).toBeGreaterThanOrEqual(1);
      }
    });

    it('catalogue degenere totalPages <= 2 : zones = 0', () => {
      expect(computeIntercalaireGuardZones(0)).toEqual({ intro: 0, outro: 0 });
      expect(computeIntercalaireGuardZones(1)).toEqual({ intro: 0, outro: 0 });
      expect(computeIntercalaireGuardZones(2)).toEqual({ intro: 0, outro: 0 });
    });

    it('zones n absorbent jamais tout le catalogue (intro+outro < totalPages)', () => {
      const sizes = [12, 30, 50, 51, 100, 200, 500];
      for (const n of sizes) {
        const { intro, outro } = computeIntercalaireGuardZones(n);
        expect(intro + outro).toBeLessThan(n);
      }
    });
  });
});

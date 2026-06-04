/**
 * Tests orientation page — portrait/paysage/carré.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  getPageOrientation,
  isPagePortrait,
  isPageLandscape,
  dominantOrientation,
} from '../../../src/v2/engine/orientation';
import type { ExtractedPage } from '../../../src/v2/types';

function makePage(w: number, h: number): ExtractedPage {
  return {
    page_number: 1,
    page_size: { width: w, height: h },
    slots: [],
    raw_spans: [],
  };
}

describe('orientation', () => {
  describe('getPageOrientation', () => {
    it('A4 portrait (595 x 842)', () => {
      expect(getPageOrientation(makePage(595, 842))).toBe('portrait');
    });
    it('A4 paysage (842 x 595)', () => {
      expect(getPageOrientation(makePage(842, 595))).toBe('landscape');
    });
    it('A3 portrait (842 x 1191)', () => {
      expect(getPageOrientation(makePage(842, 1191))).toBe('portrait');
    });
    it('Lettre US paysage (792 x 612)', () => {
      expect(getPageOrientation(makePage(792, 612))).toBe('landscape');
    });
    it('page carrée → square', () => {
      expect(getPageOrientation(makePage(600, 600))).toBe('square');
      // Quasi carrée sous le seuil
      expect(getPageOrientation(makePage(600, 620))).toBe('square');
    });
    it('dimensions invalides → fallback landscape', () => {
      expect(getPageOrientation(makePage(0, 0))).toBe('landscape');
      expect(getPageOrientation(makePage(-1, 100))).toBe('landscape');
    });
  });

  describe('isPagePortrait / isPageLandscape', () => {
    it('A4 portrait', () => {
      const p = makePage(595, 842);
      expect(isPagePortrait(p)).toBe(true);
      expect(isPageLandscape(p)).toBe(false);
    });
    it('A4 paysage', () => {
      const p = makePage(842, 595);
      expect(isPagePortrait(p)).toBe(false);
      expect(isPageLandscape(p)).toBe(true);
    });
    it('square classée landscape (legacy)', () => {
      const p = makePage(600, 600);
      expect(isPagePortrait(p)).toBe(false);
      expect(isPageLandscape(p)).toBe(true);
    });
  });

  describe('dominantOrientation', () => {
    it('majoritairement portrait', () => {
      const pages = [
        makePage(595, 842),
        makePage(595, 842),
        makePage(842, 595),
      ];
      expect(dominantOrientation(pages)).toBe('portrait');
    });
    it('majoritairement landscape', () => {
      const pages = [
        makePage(842, 595),
        makePage(842, 595),
        makePage(595, 842),
      ];
      expect(dominantOrientation(pages)).toBe('landscape');
    });
    it('liste vide → landscape (legacy)', () => {
      expect(dominantOrientation([])).toBe('landscape');
    });
    it('égalité → landscape par défaut', () => {
      const pages = [makePage(595, 842), makePage(842, 595)];
      expect(dominantOrientation(pages)).toBe('landscape');
    });
  });

  describe('fixtures réelles', () => {
    it('Catalogue C p13 (catalogue Jardin Piscine) → portrait', () => {
      const fix = path.join(
        __dirname,
        '../fixtures/extracted/catalogC_p13.json',
      );
      const page: ExtractedPage = JSON.parse(readFileSync(fix, 'utf-8'));
      expect(isPagePortrait(page)).toBe(true);
      expect(getPageOrientation(page)).toBe('portrait');
    });

    it('Catalogue E p07 (Plomberie Sanitaire) → paysage', () => {
      const fix = path.join(
        __dirname,
        '../fixtures/extracted/catalogE_p07.json',
      );
      const page: ExtractedPage = JSON.parse(readFileSync(fix, 'utf-8'));
      expect(isPageLandscape(page)).toBe(true);
      expect(getPageOrientation(page)).toBe('landscape');
    });
  });
});

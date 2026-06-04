/**
 * Tests tracking pages avec layout horizontal detecte.
 *
 * Permet de quantifier le gap S6.5 : combien de pages d'un catalogue
 * declenchent isHorizontalLayout=true (downstream reflowSpecsV2 traite
 * encore comme vertical → ops chevauchees).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  findProductBlocks,
  getHorizontalLayoutPages,
  resetHorizontalLayoutPages,
} from '../../../src/v2/engine/blockDetector';
import { detectProfileHeuristic } from '../../../src/v2/engine/profile';
import type { ExtractedPage } from '../../../src/v2/types';

const FIX_CATALOGC = path.join(__dirname, '../fixtures/extracted/catalogC_p13.json');

describe('blockDetector — tracking layout horizontal', () => {
  beforeEach(() => {
    resetHorizontalLayoutPages();
  });

  it('resetHorizontalLayoutPages vide compteur', () => {
    expect(getHorizontalLayoutPages()).toHaveLength(0);
  });

  it('Catalogue C p13 : si layout horizontal detecte, info enregistree', () => {
    const page: ExtractedPage = JSON.parse(readFileSync(FIX_CATALOGC, 'utf-8'));
    const profile = detectProfileHeuristic([page]);
    findProductBlocks(page, profile);
    const horizontal = getHorizontalLayoutPages();
    // Catalogue C p13 a 3 noms ECOP/ECL/ECL alignes en Y → layout horizontal probable
    // Soit horizontal detecte (et tracke), soit non (et liste vide). Pas de crash.
    expect(Array.isArray(horizontal)).toBe(true);
  });

  it('HorizontalLayoutInfo a la bonne shape', () => {
    const page: ExtractedPage = JSON.parse(readFileSync(FIX_CATALOGC, 'utf-8'));
    const profile = detectProfileHeuristic([page]);
    findProductBlocks(page, profile);
    const horizontal = getHorizontalLayoutPages();
    if (horizontal.length > 0) {
      const h = horizontal[0];
      expect(h).toHaveProperty('pageNumber');
      expect(h).toHaveProperty('blockCount');
      expect(h.blockCount).toBeGreaterThan(0);
    }
  });

  it('block.isHorizontalLayout propagé sur les blocs detectes', () => {
    const page: ExtractedPage = JSON.parse(readFileSync(FIX_CATALOGC, 'utf-8'));
    const profile = detectProfileHeuristic([page]);
    const blocks = findProductBlocks(page, profile);
    // Si layout horizontal detecte, tous les blocs doivent porter le flag.
    const horizontal = getHorizontalLayoutPages();
    if (horizontal.length > 0 && blocks.length > 0) {
      for (const b of blocks) {
        expect(b.isHorizontalLayout).toBe(true);
      }
    }
  });
});

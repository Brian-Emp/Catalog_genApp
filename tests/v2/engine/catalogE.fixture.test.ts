/**
 * Test fixture Catalogue E — page 7 catalogue raccordement reseau eau.
 *
 * Page paysage A4 (841 x 595), intro avec gros titres en AvantGarde-Medium/Bold
 * 35pt. Pas une fiche produit standard → on verifie que le pipeline ne crash
 * pas et retourne des resultats coherents.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { detectProfileHeuristic } from '../../../src/v2/engine/profile';
import { computeIntercalaireGuardZones } from '../../../src/v2/engineOrchestrator';
import {
  findProductBlocks,
  resetDroppedPages,
  getDroppedPages,
} from '../../../src/v2/engine/blockDetector';
import type { ExtractedPage } from '../../../src/v2/types';

const FIX = path.join(__dirname, '../fixtures/extracted/catalogE_p07.json');
const page: ExtractedPage = JSON.parse(readFileSync(FIX, 'utf-8'));

describe('Catalogue E page 7 — fixture intro paysage A4', () => {
  it('page est paysage (width > height)', () => {
    expect(page.page_size.width).toBeGreaterThan(page.page_size.height);
  });

  it('contient des spans (au moins 1)', () => {
    expect((page.raw_spans ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('detectProfileHeuristic ne crash pas et retourne profile', () => {
    const profile = detectProfileHeuristic([page]);
    expect(profile).toBeDefined();
    expect(profile.nameXMax).toBeGreaterThan(0);
  });

  it('findProductBlocks ne crash pas (peut retourner [] sur cette page)', () => {
    resetDroppedPages();
    const profile = detectProfileHeuristic([page]);
    const blocks = findProductBlocks(page, profile);
    // Soit on trouve des blocs (peu probable sur intro), soit [].
    expect(Array.isArray(blocks)).toBe(true);
  });

  it('page paysage 841x595 : pageSize correctement detecte', () => {
    expect(Math.round(page.page_size.width)).toBe(842);
    expect(Math.round(page.page_size.height)).toBe(595);
  });
});

// Bonus : valide nouveau computeIntercalaireGuardZones avec un catalogue
// imaginaire de la taille de Catalogue E (188 pages reelles probables)
describe('Catalogue E scale — guard zones adaptatives', () => {
  it('cat 188 pages : 5% guard zone = 10 (max cap)', () => {
    const { intro, outro } = computeIntercalaireGuardZones(188);
    expect(intro).toBeLessThanOrEqual(10);
    expect(outro).toBeLessThanOrEqual(10);
    expect(intro).toBeGreaterThanOrEqual(5);
  });
});

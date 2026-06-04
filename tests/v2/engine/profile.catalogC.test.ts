/**
 * Test fixture Catalogue C — page 13 (fiche produit ECOP 100 / ECL 250 / ECL 400).
 * Catalogue Pompes Jardin Piscine, A4 portrait, layout horizontal :
 * keys à gauche, 3 colonnes de valeurs.
 *
 * Symptômes actuels :
 *   - Les keys (Référence, Puissance, etc.) n'ont pas de ":" → non détectées
 *   - detectProfileHeuristic retombe sur DEFAULT_PROFILE
 *   - blockDetector ne trouve aucun produit
 *
 * Ce test fige le comportement courant et servira de témoin de progression.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { detectProfileHeuristic } from '../../../src/v2/engine/profile';
import { hasKeyValueSeparator } from '../../../src/v2/engine/keyValueSeparator';
import type { ExtractedPage } from '../../../src/v2/types';

const FIX = path.join(__dirname, '../fixtures/extracted/catalogC_p13.json');
const page: ExtractedPage = JSON.parse(readFileSync(FIX, 'utf-8'));

describe('Catalogue C page 13 — fixture catalogue Pompes Jardin/Piscine', () => {
  it('contient bien raw_spans non vide', () => {
    expect(page.raw_spans).toBeDefined();
    expect((page.raw_spans ?? []).length).toBeGreaterThan(50);
  });

  it('page A4 portrait', () => {
    expect(page.page_size.width).toBeLessThan(page.page_size.height);
  });

  it('contient des noms produit reconnaissables (ECOP/ECL)', () => {
    const texts = (page.raw_spans ?? []).map((s) => s.text);
    const found = texts.filter((t) => /ECOP|ECL\s*\d/.test(t));
    expect(found.length).toBeGreaterThan(0);
  });

  it('contient des keys typiques sans separateur ":"', () => {
    const texts = (page.raw_spans ?? []).map((s) => s.text.trim());
    // "Référence", "Puissance", "Marche / Arrêt" présentes mais SANS ":"
    expect(texts).toContain('Référence');
    expect(texts).toContain('Puissance');
    // Aucune des keys n'a de séparateur intra-span
    expect(hasKeyValueSeparator('Référence')).toBe(false);
    expect(hasKeyValueSeparator('Puissance')).toBe(false);
  });

  it('contient les codes 6 chiffres (002236, 002281, 002282)', () => {
    const texts = (page.raw_spans ?? []).map((s) => s.text.trim());
    expect(texts.some((t) => t.includes('002236'))).toBe(true);
    expect(texts.some((t) => t.includes('002281'))).toBe(true);
    expect(texts.some((t) => t.includes('002282'))).toBe(true);
  });

  it('B1 : REF_RE match codes 6 chiffres (Catalogue C 002236) sans matcher annee', () => {
    // Le pattern de ref doit reconnaitre les codes 6 chiffres tout en
    // excluant les annees 1900-2099 via filtre additionnel YEAR_RE.
    const REF_RE = /\b(?:\d{4,7}\s+)?\d{6,8}\b/;
    const YEAR_RE = /^(?:19|20)\d{2}$/;
    // Catalogue C codes
    expect(REF_RE.test('002236')).toBe(true);
    expect(REF_RE.test('002281')).toBe(true);
    expect(REF_RE.test('002282')).toBe(true);
    // Catalogue A format avec prefix
    expect(REF_RE.test('304740 4061296')).toBe(true);
    expect(REF_RE.test('1234567')).toBe(true);
    expect(REF_RE.test('12345678')).toBe(true);
    // Annee : match REF_RE mais filtre YEAR_RE
    expect(REF_RE.test('2022')).toBe(false); // 4 digits, sous le seuil 6
    expect(REF_RE.test('199999')).toBe(true); // 6 digits → ref valide
    expect(YEAR_RE.test('2022')).toBe(true);
    expect(YEAR_RE.test('199999')).toBe(false);
  });

  it('detectProfileHeuristic détecte profile via fallback tabulaire', () => {
    // Après P0.2 : le fallback layout tabulaire identifie keys "Référence",
    // "Puissance", etc. alignées Y avec valeurs colonnes → source heuristic.
    const profile = detectProfileHeuristic([page]);
    expect(profile).toBeDefined();
    expect(profile.source).toBe('heuristic');
    // keySize ≈ 8pt (texte specs Catalogue C)
    expect(profile.keySize).toBeGreaterThanOrEqual(7);
    expect(profile.keySize).toBeLessThanOrEqual(10);
    // nameSize ≈ 15pt (ECOP 100 / ECL 250 / ECL 400)
    expect(profile.nameSizeRange[0]).toBeGreaterThanOrEqual(13);
    expect(profile.nameSizeRange[1]).toBeLessThanOrEqual(20);
  });
});

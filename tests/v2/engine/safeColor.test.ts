/**
 * Tests safeColor : bascule blanc/clair → noir pour textes substitues.
 * Cas racine : Catalogue C noms produit color=#ffffff sur cartouche bleu efface.
 */
import { describe, it, expect } from 'vitest';
import { safeTextColor, isLightColor } from '../../../src/v2/engine/safeColor';

describe('safeTextColor', () => {
  it('blanc pur #ffffff → #000000', () => {
    expect(safeTextColor('#ffffff')).toBe('#000000');
  });
  it('blanc casse #fefefe → #000000', () => {
    expect(safeTextColor('#fefefe')).toBe('#000000');
  });
  it('gris tres clair #f5f5f5 → #000000', () => {
    expect(safeTextColor('#f5f5f5')).toBe('#000000');
  });
  it('noir #000000 → #000000 inchange', () => {
    expect(safeTextColor('#000000')).toBe('#000000');
  });
  it('couleur vive #ff0000 → inchangee', () => {
    expect(safeTextColor('#ff0000')).toBe('#ff0000');
  });
  it('gris fonce #333333 → inchange', () => {
    expect(safeTextColor('#333333')).toBe('#333333');
  });
  it('cas Catalogue C reel : color span ECOP = #ffffff → #000000', () => {
    expect(safeTextColor('#ffffff')).toBe('#000000');
  });
  it('null / undefined / vide → #000000 par defaut', () => {
    expect(safeTextColor(null)).toBe('#000000');
    expect(safeTextColor(undefined)).toBe('#000000');
  });
  it('format invalide → retourne tel quel (safe no-op)', () => {
    expect(safeTextColor('rgb(255,255,255)')).toBe('rgb(255,255,255)');
    expect(safeTextColor('#abc')).toBe('#abc');
  });
});

describe('isLightColor', () => {
  it('blanc → true', () => {
    expect(isLightColor('#ffffff')).toBe(true);
  });
  it('noir → false', () => {
    expect(isLightColor('#000000')).toBe(false);
  });
  it('gris moyen #888888 (sum=2040 wait... ah 0x88*3 = 408) → false', () => {
    expect(isLightColor('#888888')).toBe(false);
  });
  it('gris tres clair #efefef → true', () => {
    expect(isLightColor('#efefef')).toBe(true);
  });
});

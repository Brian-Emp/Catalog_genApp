/**
 * Tests calibration TEXT_WIDTH_COEFS. Verifie que les coefficients
 * d'estimation de largeur (0.65 upper, 0.6 digits, 0.55 mixed) restent
 * dans une fourchette raisonnable. Sert de tripwire si quelqu'un les
 * deplace par megarde et casse l'alignement specs/refs.
 */

import { describe, expect, it } from 'vitest';
import { TEXT_WIDTH_COEFS } from '../../../src/v2/engine/substitutor';

describe('TEXT_WIDTH_COEFS calibration', () => {
  it('upper > digits > mixed (ordre attendu pour sans-serif)', () => {
    expect(TEXT_WIDTH_COEFS.upper).toBeGreaterThan(TEXT_WIDTH_COEFS.digits);
    expect(TEXT_WIDTH_COEFS.digits).toBeGreaterThan(TEXT_WIDTH_COEFS.mixed);
  });

  it('valeurs dans la fourchette typographique [0.5, 0.7]', () => {
    expect(TEXT_WIDTH_COEFS.upper).toBeGreaterThanOrEqual(0.5);
    expect(TEXT_WIDTH_COEFS.upper).toBeLessThanOrEqual(0.7);
    expect(TEXT_WIDTH_COEFS.digits).toBeGreaterThanOrEqual(0.5);
    expect(TEXT_WIDTH_COEFS.digits).toBeLessThanOrEqual(0.7);
    expect(TEXT_WIDTH_COEFS.mixed).toBeGreaterThanOrEqual(0.5);
    expect(TEXT_WIDTH_COEFS.mixed).toBeLessThanOrEqual(0.7);
  });

  it('estimation "Chromé" 12pt ~40-50pt (sanity check)', () => {
    // 6 chars mixte * 12pt * 0.55 = 39.6pt. Helvetica rendu ~42pt.
    const w = 6 * 12 * TEXT_WIDTH_COEFS.mixed;
    expect(w).toBeGreaterThan(35);
    expect(w).toBeLessThan(50);
  });

  it('estimation "4204891" 12pt en mode digits ~50-60pt', () => {
    const w = 7 * 12 * TEXT_WIDTH_COEFS.digits;
    expect(w).toBeGreaterThan(45);
    expect(w).toBeLessThan(60);
  });
});

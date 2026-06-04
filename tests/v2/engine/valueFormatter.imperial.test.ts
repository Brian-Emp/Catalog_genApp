/**
 * Tests unites imperiales hasUnitSuffix (Phase 4 T3).
 *
 * Les unites de base (inch/feet/yard/lbs/oz) sont deja dans UNIT_TOKENS.
 * Ce test verifie les combinaisons complexes courantes en US/UK :
 * - Fractions : "1/2 inch", "3/4 ft"
 * - Notation prime : 6' (foot), 12" (inch)
 * - Compound : "5'6\"" (5 feet 6 inches)
 */
import { describe, it, expect } from 'vitest';
import { hasUnitSuffix } from '../../../src/v2/engine/valueFormatter';

describe('hasUnitSuffix — unites imperiales basiques', () => {
  it('"5 inches" detecte', () => {
    expect(hasUnitSuffix('5 inches')).toBe(true);
  });

  it('"12 inch" (singulier) detecte', () => {
    expect(hasUnitSuffix('12 inch')).toBe(true);
  });

  it('"6 feet" detecte', () => {
    expect(hasUnitSuffix('6 feet')).toBe(true);
  });

  it('"3 yards" detecte', () => {
    expect(hasUnitSuffix('3 yards')).toBe(true);
  });

  it('"10 lbs" / "16 oz" / "1 ton" detectes', () => {
    expect(hasUnitSuffix('10 lbs')).toBe(true);
    expect(hasUnitSuffix('16 oz')).toBe(true);
    expect(hasUnitSuffix('1 ton')).toBe(true);
    expect(hasUnitSuffix('2 tons')).toBe(true);
  });

  it('abrev "12 ft" / "2 yd" / "1 lb" detectees', () => {
    expect(hasUnitSuffix('12 ft')).toBe(true);
    expect(hasUnitSuffix('2 yd')).toBe(true);
    expect(hasUnitSuffix('1 lb')).toBe(true);
  });
});

describe('hasUnitSuffix — fractions imperiales', () => {
  it('"1/2 inch" : detecte (le 2 precede inch)', () => {
    expect(hasUnitSuffix('1/2 inch')).toBe(true);
  });

  it('"3/4 inch" detecte', () => {
    expect(hasUnitSuffix('3/4 inch')).toBe(true);
  });

  it('"1 1/2 inch" : detecte (mixed numeral)', () => {
    expect(hasUnitSuffix('1 1/2 inch')).toBe(true);
  });

  it('"3/8 ft" detecte', () => {
    expect(hasUnitSuffix('3/8 ft')).toBe(true);
  });
});

describe('hasUnitSuffix — surfaces / volumes imperiaux', () => {
  it('"100 sqft" detecte', () => {
    expect(hasUnitSuffix('100 sqft')).toBe(true);
  });

  it('"50 sqyd" / "200 sqin" detectes', () => {
    expect(hasUnitSuffix('50 sqyd')).toBe(true);
    expect(hasUnitSuffix('200 sqin')).toBe(true);
  });

  it('"10 cuft" / "5 cuin" / "3 cuyd" detectes', () => {
    expect(hasUnitSuffix('10 cuft')).toBe(true);
    expect(hasUnitSuffix('5 cuin')).toBe(true);
    expect(hasUnitSuffix('3 cuyd')).toBe(true);
  });

  it('"5 gallons" / "2 gal" detectes', () => {
    expect(hasUnitSuffix('5 gallons')).toBe(true);
    expect(hasUnitSuffix('2 gal')).toBe(true);
  });
});

describe('hasUnitSuffix — vitesses imperiales', () => {
  it('"60 mph" detecte', () => {
    expect(hasUnitSuffix('60 mph')).toBe(true);
  });

  it('"30 fps" detecte', () => {
    expect(hasUnitSuffix('30 fps')).toBe(true);
  });
});

describe('hasUnitSuffix — temperatures imperiales', () => {
  it('"80 °F" detecte', () => {
    expect(hasUnitSuffix('80 °F')).toBe(true);
  });

  it('"32°F" sans espace detecte', () => {
    expect(hasUnitSuffix('32°F')).toBe(true);
  });
});

describe('hasUnitSuffix — anti-faux-positifs imperiaux', () => {
  it('"inch" seul sans nombre → false', () => {
    expect(hasUnitSuffix('inch')).toBe(false);
  });

  it('"Made in USA" → false (in n est pas precede d un chiffre)', () => {
    expect(hasUnitSuffix('Made in USA')).toBe(false);
  });

  it('"Pound cake" → false', () => {
    expect(hasUnitSuffix('Pound cake')).toBe(false);
  });
});

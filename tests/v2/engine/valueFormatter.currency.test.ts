/**
 * Tests detection devises non-EUR dans valueFormatter (Phase 4 T1).
 *
 * hasUnitSuffix doit detecter :
 * - Suffixes : "5€", "10$", "25CHF" (existant pour €, etendu)
 * - Prefixes : "$5", "£10", "CHF 25" (nouveau via CURRENCY_PREFIX_RE)
 */
import { describe, it, expect } from 'vitest';
import { hasUnitSuffix, hasCurrencyPrefix } from '../../../src/v2/engine/valueFormatter';

describe('hasUnitSuffix — devises suffixes (Phase 4 T1)', () => {
  it('€ suffixe : "25€" detecte', () => {
    expect(hasUnitSuffix('25€')).toBe(true);
  });

  it('$ suffixe : "10$" detecte', () => {
    expect(hasUnitSuffix('10$')).toBe(true);
  });

  it('£ suffixe : "100£" detecte', () => {
    expect(hasUnitSuffix('100£')).toBe(true);
  });

  it('¥ suffixe : "1000¥" detecte', () => {
    expect(hasUnitSuffix('1000¥')).toBe(true);
  });

  it('CHF suffixe : "25 CHF" detecte', () => {
    expect(hasUnitSuffix('25 CHF')).toBe(true);
  });

  it('USD code ISO suffixe : "100 USD" detecte', () => {
    expect(hasUnitSuffix('100 USD')).toBe(true);
  });

  it('CAD/AUD/CNY/KRW codes detectes', () => {
    expect(hasUnitSuffix('50 CAD')).toBe(true);
    expect(hasUnitSuffix('200 AUD')).toBe(true);
    expect(hasUnitSuffix('1000 CNY')).toBe(true);
    expect(hasUnitSuffix('5000 KRW')).toBe(true);
  });
});

describe('hasUnitSuffix — devises prefixes (Phase 4 T1)', () => {
  it('$5 detecte (prefix)', () => {
    expect(hasUnitSuffix('$5')).toBe(true);
  });

  it('£10 detecte', () => {
    expect(hasUnitSuffix('£10')).toBe(true);
  });

  it('€25 detecte (prefix)', () => {
    expect(hasUnitSuffix('€25')).toBe(true);
  });

  it('CHF 25 detecte (prefix avec espace)', () => {
    expect(hasUnitSuffix('CHF 25')).toBe(true);
  });

  it('USD 100 detecte (prefix code ISO)', () => {
    expect(hasUnitSuffix('USD 100')).toBe(true);
  });

  it('hasCurrencyPrefix dedicated check', () => {
    expect(hasCurrencyPrefix('$5')).toBe(true);
    expect(hasCurrencyPrefix('£10')).toBe(true);
    expect(hasCurrencyPrefix('Price: $5')).toBe(true);
    expect(hasCurrencyPrefix('Inox 5')).toBe(false); // pas de devise
  });
});

describe('hasUnitSuffix — non-regression unites existantes', () => {
  it('mm/cm/m existants OK', () => {
    expect(hasUnitSuffix('25mm')).toBe(true);
    expect(hasUnitSuffix('5cm')).toBe(true);
    expect(hasUnitSuffix('2 m')).toBe(true);
  });

  it('kg/g OK', () => {
    expect(hasUnitSuffix('5kg')).toBe(true);
    expect(hasUnitSuffix('100g')).toBe(true);
  });

  it('°C/°F OK', () => {
    expect(hasUnitSuffix('25°C')).toBe(true);
    expect(hasUnitSuffix('80°F')).toBe(true);
  });

  it('texte sans unite NI devise → false', () => {
    expect(hasUnitSuffix('Inox')).toBe(false);
    expect(hasUnitSuffix('Chromé')).toBe(false);
    expect(hasUnitSuffix('Bronze poli')).toBe(false);
  });
});

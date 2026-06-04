/**
 * Tests de la detection d'unites (UNIT_RE / hasUnitSuffix) utilisee par
 * valueFormatter.hasFormatMismatch pour decider si une key spec necessite
 * un reformatting.
 *
 * Couvre :
 *  - metrique linéaire / poids / volume / temp
 *  - impérial (inch, ft, lb, oz, °F, gal)
 *  - technique (W, V, Hz, GB, dB, bar, psi, Nm, lux)
 *  - durée multi-langue (FR/EN/DE/ES)
 *  - fix du bug `\b` (° et % ne matchent plus avec le pattern legacy)
 *  - non-match (faux positifs ecartes)
 */
import { describe, it, expect } from 'vitest';
import { UNIT_RE, UNIT_TOKENS, hasUnitSuffix } from '../../../src/v2/engine/valueFormatter';

describe('hasUnitSuffix — métriques', () => {
  it('linéaire', () => {
    expect(hasUnitSuffix('60 cm')).toBe(true);
    expect(hasUnitSuffix('120mm')).toBe(true);
    expect(hasUnitSuffix('1.5 m')).toBe(true);
    expect(hasUnitSuffix('2 km')).toBe(true);
  });
  it('poids', () => {
    expect(hasUnitSuffix('5 kg')).toBe(true);
    expect(hasUnitSuffix('500g')).toBe(true);
    expect(hasUnitSuffix('250 mg')).toBe(true);
  });
  it('volume', () => {
    expect(hasUnitSuffix('5 L')).toBe(true);
    expect(hasUnitSuffix('500 ml')).toBe(true);
  });
});

describe('hasUnitSuffix — impérial', () => {
  it('linéaire', () => {
    expect(hasUnitSuffix('12 inch')).toBe(true);
    expect(hasUnitSuffix('12 inches')).toBe(true);
    expect(hasUnitSuffix('6 ft')).toBe(true);
    expect(hasUnitSuffix('6 feet')).toBe(true);
    expect(hasUnitSuffix('3 yd')).toBe(true);
    expect(hasUnitSuffix('12in')).toBe(true);
  });
  it('poids', () => {
    expect(hasUnitSuffix('10 lb')).toBe(true);
    expect(hasUnitSuffix('10 lbs')).toBe(true);
    expect(hasUnitSuffix('5 pounds')).toBe(true);
    expect(hasUnitSuffix('16 oz')).toBe(true);
  });
  it('volume', () => {
    expect(hasUnitSuffix('5 gal')).toBe(true);
    expect(hasUnitSuffix('5 gallons')).toBe(true);
  });
  it('température', () => {
    expect(hasUnitSuffix('72 °F')).toBe(true);
    expect(hasUnitSuffix('72°F')).toBe(true);
  });
});

describe('hasUnitSuffix — symboles (fix bug \\b)', () => {
  it('pourcentage', () => {
    expect(hasUnitSuffix('50 %')).toBe(true);
    expect(hasUnitSuffix('50%')).toBe(true);
    expect(hasUnitSuffix('100% étanche')).toBe(true);
  });
  it('degrés sans suffixe', () => {
    expect(hasUnitSuffix('45 °')).toBe(true);
    expect(hasUnitSuffix('45°')).toBe(true);
  });
  it('°C', () => {
    expect(hasUnitSuffix('20°C')).toBe(true);
    expect(hasUnitSuffix('20 °C')).toBe(true);
  });
  it('permille ‰', () => {
    expect(hasUnitSuffix('5‰')).toBe(true);
  });
});

describe('hasUnitSuffix — électrique', () => {
  it('puissance', () => {
    expect(hasUnitSuffix('100 W')).toBe(true);
    expect(hasUnitSuffix('100W')).toBe(true);
    expect(hasUnitSuffix('1.5 kW')).toBe(true);
    expect(hasUnitSuffix('60 Watts')).toBe(true);
  });
  it('tension', () => {
    expect(hasUnitSuffix('220 V')).toBe(true);
    expect(hasUnitSuffix('220V')).toBe(true);
    expect(hasUnitSuffix('110 Volts')).toBe(true);
  });
  it('énergie', () => {
    expect(hasUnitSuffix('1.2 kWh')).toBe(true);
    expect(hasUnitSuffix('3000 mAh')).toBe(true);
  });
});

describe('hasUnitSuffix — fréquence / pression', () => {
  it('fréquence', () => {
    expect(hasUnitSuffix('50 Hz')).toBe(true);
    expect(hasUnitSuffix('2.4 GHz')).toBe(true);
    expect(hasUnitSuffix('1200 rpm')).toBe(true);
  });
  it('pression', () => {
    expect(hasUnitSuffix('3 bar')).toBe(true);
    expect(hasUnitSuffix('30 psi')).toBe(true);
    expect(hasUnitSuffix('200 kPa')).toBe(true);
  });
});

describe('hasUnitSuffix — info', () => {
  it('capacité', () => {
    expect(hasUnitSuffix('16 GB')).toBe(true);
    expect(hasUnitSuffix('512 MB')).toBe(true);
    expect(hasUnitSuffix('128 Go')).toBe(true);
    expect(hasUnitSuffix('1 To')).toBe(true);
  });
  it('résolution', () => {
    expect(hasUnitSuffix('12 Mpx')).toBe(true);
    expect(hasUnitSuffix('300 dpi')).toBe(true);
  });
});

describe('hasUnitSuffix — surface/volume imperial + vitesse', () => {
  it('surface imperial', () => {
    expect(hasUnitSuffix('100 sqft')).toBe(true);
    expect(hasUnitSuffix('25 sqin')).toBe(true);
    expect(hasUnitSuffix('10sqyd')).toBe(true);
  });
  it('volume imperial', () => {
    expect(hasUnitSuffix('50 cuft')).toBe(true);
    expect(hasUnitSuffix('5 cuin')).toBe(true);
  });
  it('vitesse', () => {
    expect(hasUnitSuffix('60 mph')).toBe(true);
    expect(hasUnitSuffix('120 kph')).toBe(true);
    expect(hasUnitSuffix('30 fps')).toBe(true);
  });
});

describe('hasUnitSuffix — mécanique / acoustique / lumière', () => {
  it('mécanique', () => {
    expect(hasUnitSuffix('25 Nm')).toBe(true);
    expect(hasUnitSuffix('100 N')).toBe(true);
  });
  it('acoustique', () => {
    expect(hasUnitSuffix('45 dB')).toBe(true);
    expect(hasUnitSuffix('45 dBA')).toBe(true);
  });
  it('lumière', () => {
    expect(hasUnitSuffix('800 lm')).toBe(true);
    expect(hasUnitSuffix('500 lux')).toBe(true);
  });
});

describe('hasUnitSuffix — durée multi-langue', () => {
  it('FR', () => {
    expect(hasUnitSuffix('5 ans')).toBe(true);
    expect(hasUnitSuffix('2 années')).toBe(true);
    expect(hasUnitSuffix('3 mois')).toBe(true);
    expect(hasUnitSuffix('1 semaine')).toBe(true);
    expect(hasUnitSuffix('7 jours')).toBe(true);
  });
  it('EN', () => {
    expect(hasUnitSuffix('5 years')).toBe(true);
    expect(hasUnitSuffix('3 months')).toBe(true);
    expect(hasUnitSuffix('2 weeks')).toBe(true);
    expect(hasUnitSuffix('48 hours')).toBe(true);
    expect(hasUnitSuffix('48h')).toBe(true);
  });
  it('DE', () => {
    expect(hasUnitSuffix('5 Jahre')).toBe(true);
    expect(hasUnitSuffix('3 Monate')).toBe(true);
    expect(hasUnitSuffix('2 Wochen')).toBe(true);
  });
  it('ES', () => {
    expect(hasUnitSuffix('5 años')).toBe(true);
    expect(hasUnitSuffix('3 meses')).toBe(true);
    expect(hasUnitSuffix('7 días')).toBe(true);
  });
});

describe('hasUnitSuffix — non-match (anti faux positifs)', () => {
  it('texte libre sans chiffre', () => {
    expect(hasUnitSuffix('Inox brossé')).toBe(false);
    expect(hasUnitSuffix('Bois massif')).toBe(false);
  });
  it('chiffre seul', () => {
    expect(hasUnitSuffix('60')).toBe(false);
    expect(hasUnitSuffix('1.5')).toBe(false);
  });
  it('chiffre + texte non-unite', () => {
    // "5inchworm" : pas une vraie unité car suivi de lettres → on rejette
    expect(hasUnitSuffix('5inchworm')).toBe(false);
    // "5manuel" : pas d'unité valide en prefixe
    expect(hasUnitSuffix('5manuel')).toBe(false);
  });
  it('vide', () => {
    expect(hasUnitSuffix('')).toBe(false);
  });
});

describe('UNIT_TOKENS', () => {
  it('inclut métriques de base', () => {
    expect(UNIT_TOKENS).toContain('cm');
    expect(UNIT_TOKENS).toContain('kg');
    expect(UNIT_TOKENS).toContain('L');
  });
  it('inclut impérial', () => {
    expect(UNIT_TOKENS).toContain('inch');
    expect(UNIT_TOKENS).toContain('lb');
    expect(UNIT_TOKENS).toContain('°F');
  });
  it('inclut tech', () => {
    expect(UNIT_TOKENS).toContain('W');
    expect(UNIT_TOKENS).toContain('Hz');
    expect(UNIT_TOKENS).toContain('dB');
    expect(UNIT_TOKENS).toContain('GB');
  });
  it('inclut durée multi-langue', () => {
    expect(UNIT_TOKENS).toContain('ans');
    expect(UNIT_TOKENS).toContain('years');
    expect(UNIT_TOKENS).toContain('Jahre');
    expect(UNIT_TOKENS).toContain('años');
  });
});

describe('UNIT_RE — usage direct', () => {
  it('extrait via match', () => {
    const m = '60 cm de longueur'.match(UNIT_RE);
    expect(m).not.toBeNull();
    expect(m![0].trim()).toBe('cm');
  });
});

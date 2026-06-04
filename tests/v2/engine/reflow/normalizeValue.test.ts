/**
 * Tests normalizeValue : règles strictes uniquement.
 */
import { describe, it, expect } from 'vitest';
import { normalizeValue, normalizeSpecValues } from '../../../../src/v2/engine/reflow/normalizeValue';

describe('normalizeValue — unites collees au chiffre', () => {
  it('"70cm" → "70 cm"', () => expect(normalizeValue('70cm')).toBe('70 cm'));
  it('"Ø22mm" → "Ø 22 mm"', () => expect(normalizeValue('Ø22mm')).toBe('Ø 22 mm'));
  it('"5kg" → "5 kg"', () => expect(normalizeValue('5kg')).toBe('5 kg'));
  it('"2bar" → "2 bar"', () => expect(normalizeValue('2bar')).toBe('2 bar'));
  it('"10ans" → "10 ans"', () => expect(normalizeValue('10ans')).toBe('10 ans'));
  it('"85°C" → "85 °C"', () => expect(normalizeValue('85°C')).toBe('85 °C'));
});

describe('normalizeValue — casse unites', () => {
  it('"5 ANS" → "5 ans"', () => expect(normalizeValue('5 ANS')).toBe('5 ans'));
  it('"22 MM" → "22 mm"', () => expect(normalizeValue('22 MM')).toBe('22 mm'));
  it('"10 KG" → "10 kg"', () => expect(normalizeValue('10 KG')).toBe('10 kg'));
});

describe('normalizeValue — symbole Ø', () => {
  it('"Ø25" → "Ø 25"', () => expect(normalizeValue('Ø25')).toBe('Ø 25'));
  it('"Ø 25" reste "Ø 25" (idempotent)', () => expect(normalizeValue('Ø 25')).toBe('Ø 25'));
});

describe('normalizeValue — "a" entre chiffres → "à"', () => {
  it('"1 a 5 bar" → "1 à 5 bar"', () => expect(normalizeValue('1 a 5 bar')).toBe('1 à 5 bar'));
  it('"3 a 8" → "3 à 8"', () => expect(normalizeValue('3 a 8')).toBe('3 à 8'));
});

describe('normalizeValue — trim + multi-espaces', () => {
  it('"  Inox  " → "Inox"', () => expect(normalizeValue('  Inox  ')).toBe('Inox'));
  it('"Inox    chrome" → "Inox chrome"', () => expect(normalizeValue('Inox    chrome')).toBe('Inox chrome'));
});

describe('normalizeValue — pas de transformation', () => {
  it('texte libre garde tel quel', () => {
    expect(normalizeValue('Coulissant et inclinable')).toBe('Coulissant et inclinable');
  });
  it('value deja propre est inchangee', () => {
    expect(normalizeValue('Ø 22 mm')).toBe('Ø 22 mm');
    expect(normalizeValue('70 cm')).toBe('70 cm');
  });
  it('"incrémental" ne match pas "cm" en milieu de mot', () => {
    // \b boundary garantit qu'on ne touche que les unites avec frontiere mot
    expect(normalizeValue('incrémental')).toBe('incrémental');
  });
});

describe('normalizeValue — idempotence', () => {
  it('appliquer 2x = pareil que 1x', () => {
    const input = '70cm Ø22mm 1 a 5 bar 10ANS';
    expect(normalizeValue(normalizeValue(input))).toBe(normalizeValue(input));
  });
});

describe('normalizeValue — edge cases', () => {
  it('chaine vide → vide', () => expect(normalizeValue('')).toBe(''));
  it('null/undefined-like (defensive)', () => expect(normalizeValue('  ')).toBe(''));
});

describe('normalizeSpecValues', () => {
  it('applique a chaque value du tableau', () => {
    expect(normalizeSpecValues(['70cm', 'Ø22mm', 'Inox'])).toEqual(['70 cm', 'Ø 22 mm', 'Inox']);
  });
  it('tableau vide → tableau vide', () => {
    expect(normalizeSpecValues([])).toEqual([]);
  });
});

describe('normalizeValue — unités impériales (US/UK)', () => {
  it('"5lb" → "5 lb"', () => expect(normalizeValue('5lb')).toBe('5 lb'));
  it('"10oz" → "10 oz"', () => expect(normalizeValue('10oz')).toBe('10 oz'));
  it('"24in" → "24 in"', () => expect(normalizeValue('24in')).toBe('24 in'));
  it('"6ft" → "6 ft"', () => expect(normalizeValue('6ft')).toBe('6 ft'));
  it('"85°F" → "85 °F"', () => expect(normalizeValue('85°F')).toBe('85 °F'));
  it('"5gal" → "5 gal"', () => expect(normalizeValue('5gal')).toBe('5 gal'));
  it('"75psi" → "75 psi"', () => expect(normalizeValue('75psi')).toBe('75 psi'));
});

describe('normalizeValue — casse imperial', () => {
  it('"10 LB" → "10 lb"', () => expect(normalizeValue('10 LB')).toBe('10 lb'));
  it('"24 IN" → "24 in"', () => expect(normalizeValue('24 IN')).toBe('24 in'));
  it('"5 GAL" → "5 gal"', () => expect(normalizeValue('5 GAL')).toBe('5 gal'));
});

describe('normalizeValue — unités SI étendues', () => {
  it('"500ml" → "500 ml"', () => expect(normalizeValue('500ml')).toBe('500 ml'));
  it('"2t" → "2 t"', () => expect(normalizeValue('2t')).toBe('2 t'));
  it('"1.5kW" → "1.5 kW"', () => expect(normalizeValue('1.5kW')).toBe('1.5 kW'));
  it('"50Hz" → "50 Hz"', () => expect(normalizeValue('50Hz')).toBe('50 Hz'));
  it('"6 mois" reste tel quel (avec espace)', () => expect(normalizeValue('6 mois')).toBe('6 mois'));
});

describe('normalizeValue — plages impériales avec dash', () => {
  it('"3-5lb" → "3-5 lb"', () => expect(normalizeValue('3-5lb')).toBe('3-5 lb'));
  it('"10-20psi" → "10-20 psi"', () => expect(normalizeValue('10-20psi')).toBe('10-20 psi'));
});

describe('normalizeValue — idempotence sur unités impériales', () => {
  it('"5 lb 10 oz 24 in" stable', () => {
    const input = '5 lb 10 oz 24 in';
    expect(normalizeValue(normalizeValue(input))).toBe(normalizeValue(input));
  });
});

describe('normalizeValue — dimensions composites', () => {
  it('"60x80" → "60 x 80"', () => expect(normalizeValue('60x80')).toBe('60 x 80'));
  it('"60X80" → "60 X 80"', () => expect(normalizeValue('60X80')).toBe('60 X 80'));
  it('"60×80" (multiplication sign) → "60 × 80"', () =>
    expect(normalizeValue('60×80')).toBe('60 × 80'));
  it('"60x40x30" (LxlxH) → "60 x 40 x 30"', () =>
    expect(normalizeValue('60x40x30')).toBe('60 x 40 x 30'));
  it('idempotent : "60 x 80" reste tel quel', () =>
    expect(normalizeValue('60 x 80')).toBe('60 x 80'));
  it('"60x80 cm" → "60 x 80 cm"', () =>
    expect(normalizeValue('60x80 cm')).toBe('60 x 80 cm'));
});

describe('normalizeValue — plages metriques avec dash', () => {
  it('"10-20cm" → "10-20 cm"', () =>
    expect(normalizeValue('10-20cm')).toBe('10-20 cm'));
  it('"5-10kg" → "5-10 kg"', () =>
    expect(normalizeValue('5-10kg')).toBe('5-10 kg'));
  it('"20-40°C" → "20-40 °C"', () =>
    expect(normalizeValue('20-40°C')).toBe('20-40 °C'));
  it('"1-5bar" → "1-5 bar"', () =>
    expect(normalizeValue('1-5bar')).toBe('1-5 bar'));
});

describe('normalizeValue — frequence MHz / GHz', () => {
  it('"50MHz" → "50 MHz"', () => expect(normalizeValue('50MHz')).toBe('50 MHz'));
  it('"2.4GHz" → "2.4 GHz"', () =>
    expect(normalizeValue('2.4GHz')).toBe('2.4 GHz'));
  it('"50 MHZ" → "50 MHz" (casse mixte canonique)', () =>
    expect(normalizeValue('50 MHZ')).toBe('50 MHz'));
  it('"2 GHZ" → "2 GHz"', () =>
    expect(normalizeValue('2 GHZ')).toBe('2 GHz'));
});

describe('normalizeValue — unites carré/cube (surface/volume)', () => {
  it('"5m²" → "5 m²"', () => expect(normalizeValue('5m²')).toBe('5 m²'));
  it('"12cm³" → "12 cm³"', () => expect(normalizeValue('12cm³')).toBe('12 cm³'));
  it('"100km²" → "100 km²"', () => expect(normalizeValue('100km²')).toBe('100 km²'));
  it('"1.5dm³" → "1.5 dm³"', () => expect(normalizeValue('1.5dm³')).toBe('1.5 dm³'));
  it('idempotent : "5 m²" reste tel quel', () => expect(normalizeValue('5 m²')).toBe('5 m²'));
  it('imperial "100ft²" → "100 ft²"', () => expect(normalizeValue('100ft²')).toBe('100 ft²'));
  it('imperial "5in³" → "5 in³"', () => expect(normalizeValue('5in³')).toBe('5 in³'));
  it('imperial "10yd²" → "10 yd²"', () => expect(normalizeValue('10yd²')).toBe('10 yd²'));
});

describe('normalizeValue — notation scientifique', () => {
  it('"1.23E+05" → "123000"', () => {
    expect(normalizeValue('1.23E+05')).toBe('123000');
  });
  it('"5E-3" → "0.005"', () => {
    expect(normalizeValue('5E-3')).toBe('0.005');
  });
  it('"2.5e10" → "25000000000"', () => {
    expect(normalizeValue('2.5e10')).toBe('25000000000');
  });
  it('"1.5E+02 cm" → "150 cm" (expand puis unit rule)', () => {
    expect(normalizeValue('1.5E+02 cm')).toBe('150 cm');
  });
  it('preserve refs alphanumeriques (anti faux positif)', () => {
    // "AB1E2" n'est pas un nombre scientifique (lettre devant)
    expect(normalizeValue('AB1E2')).toBe('AB1E2');
  });
  it('preserve texte libre', () => {
    expect(normalizeValue('classe E2')).toBe('classe E2');
    expect(normalizeValue('grade A1')).toBe('grade A1');
  });
});

describe('normalizeValue — acoustique / mecanique / lumiere', () => {
  it('"45dB" → "45 dB"', () => expect(normalizeValue('45dB')).toBe('45 dB'));
  it('"45dBA" → "45 dBA"', () => expect(normalizeValue('45dBA')).toBe('45 dBA'));
  it('"25Nm" → "25 Nm"', () => expect(normalizeValue('25Nm')).toBe('25 Nm'));
  it('"800lm" → "800 lm"', () => expect(normalizeValue('800lm')).toBe('800 lm'));
  it('"500lux" → "500 lux"', () =>
    expect(normalizeValue('500lux')).toBe('500 lux'));
  it('"45 DB" → "45 dB" (casse canonique)', () =>
    expect(normalizeValue('45 DB')).toBe('45 dB'));
});

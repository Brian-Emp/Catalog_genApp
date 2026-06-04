/**
 * Tests safeText : translation glyphes exotiques -> ASCII proche pour
 * eviter les `.notdef` en rendu PDF.
 */

import { describe, expect, it } from 'vitest';
import { safeText } from '../../../src/v2/engine/safeText';

describe('safeText', () => {
  it('passe-through ASCII et accents latins', () => {
    expect(safeText('Robinet Mitigeur Évier')).toBe('Robinet Mitigeur Évier');
    expect(safeText('coût à régler')).toBe('coût à régler');
  });

  it('smart quotes -> droites', () => {
    expect(safeText('l’eau')).toBe("l'eau");
    expect(safeText('"hello"')).toBe('"hello"');
    expect(safeText('«guillemet»')).toBe('"guillemet"');
  });

  it('tirets cadratin -> simple', () => {
    expect(safeText('A – B — C')).toBe('A - B - C');
  });

  it('ellipse -> trois points', () => {
    expect(safeText('Suite…')).toBe('Suite...');
  });

  it('ligatures -> letters', () => {
    expect(safeText('œuf Œuf')).toBe('oeuf OEuf');
    expect(safeText('ﬁnale')).toBe('finale');
  });

  it('symboles math/monnaie', () => {
    expect(safeText('Ø ≤ 10mm')).toBe('Ø <= 10mm');
    expect(safeText('100€')).toBe('100EUR');
    expect(safeText('½ tour')).toBe('1/2 tour');
  });

  it('chaîne vide', () => {
    expect(safeText('')).toBe('');
  });

  it('caractères non-mappés conservés', () => {
    expect(safeText('日本語')).toBe('日本語');
  });

  it('hyphens unicode -> tiret ASCII', () => {
    expect(safeText('A‐B')).toBe('A-B'); // U+2010 hyphen
    expect(safeText('A‑B')).toBe('A-B'); // U+2011 NB hyphen
    expect(safeText('A­B')).toBe('A-B'); // U+00AD soft hyphen
  });

  it('zero-width spaces / BOM supprimes', () => {
    expect(safeText('hello​world')).toBe('helloworld'); // ZWSP
    expect(safeText('﻿hello')).toBe('hello'); // BOM
  });

  it('primes -> apostrophe / guillemet (notation imperiale)', () => {
    expect(safeText("5′ 10″")).toBe(`5' 10"`);
  });

  it('exposants/indices etendus', () => {
    expect(safeText('m⁴')).toBe('m4');
    expect(safeText('H₂O')).toBe('H2O');
  });

  it('fractions etendues', () => {
    expect(safeText('⅛ tour')).toBe('1/8 tour');
    expect(safeText('⅝')).toBe('5/8');
  });

  it('diametre -> "diam"', () => {
    expect(safeText('⌀ 32mm')).toBe('diam  32mm');
    expect(safeText('∅10')).toBe('diam 10');
  });

  it('monnaies internationales', () => {
    expect(safeText('₹ 1000')).toBe('INR 1000');
    expect(safeText('₩ 5000')).toBe('KRW 5000');
  });

  it('modifier apostrophes', () => {
    expect(safeText("dʼun trait")).toBe("d'un trait");
  });

  it('bullet operators / asterisques speciaux', () => {
    expect(safeText('A∙B')).toBe('A.B');
    expect(safeText('A⋅B')).toBe('A.B');
    expect(safeText('1∗2')).toBe('1*2');
  });

  it('approximation et equivalence', () => {
    expect(safeText('5 ≈ 5.1')).toBe('5 ~ 5.1');
  });

  it('ligature st', () => {
    expect(safeText('beﬆ')).toBe('best');
  });

  it('fleches bidirectionnelles', () => {
    expect(safeText('A ↔ B')).toBe('A <-> B');
    expect(safeText('A ⇔ B')).toBe('A <=> B');
  });
});

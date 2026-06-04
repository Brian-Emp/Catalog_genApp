/**
 * Tests palette de couleurs/finitions multilingue. Sert au blockDetector
 * pour identifier le span color du header produit en fallback du font
 * pattern.
 */
import { describe, it, expect } from 'vitest';
import { COMMON_COLORS, isCommonColor, isColorCode } from '../../../src/v2/engine/colorPalette';

describe('isCommonColor', () => {
  it('FR : neutres / metalliques', () => {
    expect(isCommonColor('Inox')).toBe(true);
    expect(isCommonColor('Chromé')).toBe(true);
    expect(isCommonColor('Chrome')).toBe(true);
    expect(isCommonColor('Noir')).toBe(true);
    expect(isCommonColor('Doré')).toBe(true);
    expect(isCommonColor('Argenté')).toBe(true);
  });
  it('FR : finitions', () => {
    expect(isCommonColor('Mat')).toBe(true);
    expect(isCommonColor('Brillant')).toBe(true);
    expect(isCommonColor('Satiné')).toBe(true);
    expect(isCommonColor('Brossé')).toBe(true);
  });
  it('FR : finitions techniques etendues', () => {
    expect(isCommonColor('Laqué')).toBe(true);
    expect(isCommonColor('Anodisé')).toBe(true);
    expect(isCommonColor('Galvanisé')).toBe(true);
    expect(isCommonColor('Dépoli')).toBe(true);
    expect(isCommonColor('Sablé')).toBe(true);
    expect(isCommonColor('Translucide')).toBe(true);
  });
  it('EN : finitions techniques', () => {
    expect(isCommonColor('Anodized')).toBe(true);
    expect(isCommonColor('Galvanized')).toBe(true);
    expect(isCommonColor('Sandblasted')).toBe(true);
    expect(isCommonColor('Frosted')).toBe(true);
    expect(isCommonColor('Lacquered')).toBe(true);
    expect(isCommonColor('Plated')).toBe(true);
  });
  it('DE / ES / IT : finitions techniques', () => {
    expect(isCommonColor('Eloxiert')).toBe(true); // DE
    expect(isCommonColor('Lackiert')).toBe(true); // DE
    expect(isCommonColor('Anodizado')).toBe(true); // ES
    expect(isCommonColor('Anodizzato')).toBe(true); // IT
  });
  it('EN', () => {
    expect(isCommonColor('Black')).toBe(true);
    expect(isCommonColor('White')).toBe(true);
    expect(isCommonColor('Gold')).toBe(true);
    expect(isCommonColor('Silver')).toBe(true);
    expect(isCommonColor('Brushed')).toBe(true);
    expect(isCommonColor('Matte')).toBe(true);
  });
  it('DE', () => {
    expect(isCommonColor('Schwarz')).toBe(true);
    expect(isCommonColor('Weiß')).toBe(true);
    expect(isCommonColor('Chrom')).toBe(true);
  });
  it('ES', () => {
    expect(isCommonColor('Negro')).toBe(true);
    expect(isCommonColor('Blanco')).toBe(true);
    expect(isCommonColor('Cromado')).toBe(true);
  });
  it('IT', () => {
    expect(isCommonColor('Nero')).toBe(true);
    expect(isCommonColor('Bianco')).toBe(true);
    expect(isCommonColor('Cromato')).toBe(true);
  });
  it('PT', () => {
    expect(isCommonColor('Preto')).toBe(true);
    expect(isCommonColor('Branco')).toBe(true);
    expect(isCommonColor('Dourado')).toBe(true);
  });
  it('couleurs primaires', () => {
    expect(isCommonColor('Rouge')).toBe(true);
    expect(isCommonColor('Bleu')).toBe(true);
    expect(isCommonColor('Vert')).toBe(true);
    expect(isCommonColor('Red')).toBe(true);
    expect(isCommonColor('Blau')).toBe(true);
  });
  it('FR : couleurs composees design', () => {
    expect(isCommonColor('Bleu marine')).toBe(true);
    expect(isCommonColor('Bleu canard')).toBe(true);
    expect(isCommonColor('Rouge bordeaux')).toBe(true);
    expect(isCommonColor('Vert sapin')).toBe(true);
    expect(isCommonColor('Gris anthracite')).toBe(true);
    expect(isCommonColor('Rose poudre')).toBe(true);
    expect(isCommonColor('Jaune moutarde')).toBe(true);
    expect(isCommonColor('Noir mat')).toBe(true);
  });
  it('EN : couleurs composees design', () => {
    expect(isCommonColor('Navy blue')).toBe(true);
    expect(isCommonColor('Forest green')).toBe(true);
    expect(isCommonColor('Pearl grey')).toBe(true);
    expect(isCommonColor('Matte black')).toBe(true);
  });
  it('insensible casse', () => {
    expect(isCommonColor('INOX')).toBe(true);
    expect(isCommonColor('inox')).toBe(true);
    expect(isCommonColor('Inox')).toBe(true);
  });
  it('insensible accents', () => {
    expect(isCommonColor('chrome')).toBe(true);
    expect(isCommonColor('Chromé')).toBe(true);
    expect(isCommonColor('chrome ')).toBe(true);
  });
  it('REJETTE sous-chaines (match strict)', () => {
    // "Bistro Inox" n'est pas QUE "inox", c'est un nom commercial.
    expect(isCommonColor('Bistro Inox')).toBe(false);
    expect(isCommonColor('Mitigeur Noir')).toBe(false);
  });
  it('REJETTE noms produit / refs', () => {
    expect(isCommonColor('AB1234')).toBe(false);
    expect(isCommonColor('Mitigeur Évier')).toBe(false);
    expect(isCommonColor('')).toBe(false);
  });
  it('trim whitespace', () => {
    expect(isCommonColor('  Inox  ')).toBe(true);
    expect(isCommonColor('\tNoir\n')).toBe(true);
  });
});

describe('isColorCode — codes techniques', () => {
  it('RAL', () => {
    expect(isColorCode('RAL 9005')).toBe(true);
    expect(isColorCode('RAL9005')).toBe(true);
    expect(isColorCode('RAL-9005')).toBe(true);
    expect(isColorCode('ral 1234')).toBe(true);
    expect(isColorCode('RAL 9005A')).toBe(true);
  });
  it('Pantone', () => {
    expect(isColorCode('Pantone 405')).toBe(true);
    expect(isColorCode('Pantone 405 C')).toBe(true);
    expect(isColorCode('Pantone 405 U')).toBe(true);
    expect(isColorCode('PMS 405')).toBe(true);
  });
  it('NCS', () => {
    expect(isColorCode('NCS S 1000-N')).toBe(true);
    expect(isColorCode('NCS 1000-N')).toBe(true);
  });
  it('HEX', () => {
    expect(isColorCode('#FFF')).toBe(true);
    expect(isColorCode('#000000')).toBe(true);
    expect(isColorCode('#FF00FF80')).toBe(true);
    expect(isColorCode('#abc')).toBe(true);
  });
  it('RGB / RGBA', () => {
    expect(isColorCode('rgb(255, 0, 0)')).toBe(true);
    expect(isColorCode('rgba(255, 0, 0, 0.5)')).toBe(true);
    expect(isColorCode('RGB(0,0,0)')).toBe(true);
  });
  it('HSL / HSLA', () => {
    expect(isColorCode('hsl(0, 100%, 50%)')).toBe(true);
    expect(isColorCode('hsla(0, 100%, 50%, 0.5)')).toBe(true);
  });
  it('rejette texte non technique', () => {
    expect(isColorCode('Inox')).toBe(false);
    expect(isColorCode('AB1234')).toBe(false);
    expect(isColorCode('#GGG')).toBe(false);
    expect(isColorCode('')).toBe(false);
  });
});

describe('isCommonColor — codes techniques inclus', () => {
  it('codes RAL/Pantone reconnus comme couleur', () => {
    expect(isCommonColor('RAL 9005')).toBe(true);
    expect(isCommonColor('Pantone 405 C')).toBe(true);
  });
  it('hex reconnu', () => {
    expect(isCommonColor('#000000')).toBe(true);
    expect(isCommonColor('#FFF')).toBe(true);
  });
  it('rgb reconnu', () => {
    expect(isCommonColor('rgb(0, 0, 0)')).toBe(true);
  });
});

describe('COMMON_COLORS', () => {
  it('contient les couleurs neutres principales', () => {
    expect(COMMON_COLORS.has('inox')).toBe(true);
    expect(COMMON_COLORS.has('chrome')).toBe(true);
    expect(COMMON_COLORS.has('noir')).toBe(true);
    expect(COMMON_COLORS.has('blanc')).toBe(true);
  });
  it('toutes les entries en lowercase sans accents', () => {
    for (const c of COMMON_COLORS) {
      expect(c).toBe(c.toLowerCase());
      // Pas d'accents (ils sont stripped a la normalisation)
      expect(/[éèàâêëîïôöùûüç]/.test(c)).toBe(false);
    }
  });
});

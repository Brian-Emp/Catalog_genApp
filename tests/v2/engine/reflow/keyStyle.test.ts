/**
 * Tests styleKeyFromTemplate : preserve casse + separateur du template.
 * Module consolide depuis reflowSpecs + reflowSpecsV2 (audit #5).
 */
import { describe, it, expect } from 'vitest';
import { styleKeyFromTemplate } from '../../../../src/v2/engine/reflow/keyStyle';

describe('styleKeyFromTemplate', () => {
  it('preserve all-caps + separateur " :"', () => {
    expect(styleKeyFromTemplate('longueur', 'MATIÈRE :')).toBe('LONGUEUR :');
  });
  it('preserve all-lower + separateur " ="', () => {
    expect(styleKeyFromTemplate('Longueur', 'matiere =')).toBe('longueur =');
  });
  it('mixte casse → pas de transform (Title Case preserved)', () => {
    expect(styleKeyFromTemplate('longueur', 'Matière |')).toBe('longueur |');
  });
  it('preserve separateur exotique →', () => {
    expect(styleKeyFromTemplate('longueur', 'MATIÈRE →')).toBe('LONGUEUR →');
  });
  it('preserve separateur · (point median)', () => {
    expect(styleKeyFromTemplate('longueur', 'MATIÈRE ·')).toBe('LONGUEUR ·');
  });
  it('fallback " :" si template sans separateur', () => {
    expect(styleKeyFromTemplate('LONGUEUR', 'DEBIT')).toBe('LONGUEUR :');
  });
  it('preserve whitespace seul comme separateur', () => {
    expect(styleKeyFromTemplate('Largeur', 'Longueur ')).toBe('Largeur ');
  });
  it('strip separateur existant sur newKey', () => {
    // Si newKey vient deja avec un sep, on l'enleve pour eviter "LONGUEUR : :"
    expect(styleKeyFromTemplate('LONGUEUR :', 'MATIERE :')).toBe('LONGUEUR :');
  });
  it('template avec uniquement separateur → fallback', () => {
    expect(styleKeyFromTemplate('LONGUEUR', ':')).toBe('LONGUEUR:');
  });
  it('chaine vide → garde new key', () => {
    expect(styleKeyFromTemplate('LONGUEUR', '')).toBe('LONGUEUR :');
  });
});

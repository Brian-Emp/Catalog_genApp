import { describe, it, expect } from 'vitest';
import { applyRule } from '../../../src/v2/engine/valueFormatter';

describe('applyRule — application de base', () => {
  it('ajoute l unite a une valeur nue', () => {
    expect(applyRule('60', '{value} cm')).toBe('60 cm');
    expect(applyRule('5', '{value} ans')).toBe('5 ans');
  });

  it('trim la valeur', () => {
    expect(applyRule('  7  ', '{value} m3/h')).toBe('7 m3/h');
  });

  it('valeur vide reste vide', () => {
    expect(applyRule('', '{value} cm')).toBe('');
  });

  it('placeholder {n} supporte', () => {
    expect(applyRule('3', '{n} pièces')).toBe('3 pièces');
  });
});

describe('applyRule — garde anti-double-unite (bug catalogC m³/h)', () => {
  it('ne re-ajoute pas une unite deja presente (variante ³ vs 3)', () => {
    // Bug observe E2E : source "7 m³/h", regle "{value} m3/h" → ne doit PAS
    // produire "7 m³/h m3/h".
    expect(applyRule('7 m³/h', '{value} m3/h')).toBe('7 m³/h');
    expect(applyRule('12 m³/h', '{value} m3/h')).toBe('12 m³/h');
  });

  it('ne re-ajoute pas cm deja present', () => {
    expect(applyRule('60 cm', '{value} cm')).toBe('60 cm');
  });

  it('tolere les variations casse/espaces', () => {
    expect(applyRule('220 V', '{value} v')).toBe('220 V');
    expect(applyRule('5ANS', '{value} ans')).toBe('5ANS');
  });

  it('applique quand l unite est absente', () => {
    expect(applyRule('7', '{value} m3/h')).toBe('7 m3/h');
    expect(applyRule('60', '{value} cm')).toBe('60 cm');
  });
});

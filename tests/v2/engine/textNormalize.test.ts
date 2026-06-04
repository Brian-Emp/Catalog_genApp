/**
 * Tests textNormalize : helpers partages stripAccents / transliterate /
 * asciiize. Consolides depuis 4 implementations divergentes (audit #1, #6).
 */
import { describe, it, expect } from 'vitest';
import {
  stripAccents,
  transliterate,
  asciiize,
  TRANSLIT_MAP,
} from '../../../src/v2/engine/textNormalize';

describe('stripAccents', () => {
  it('strip accents francais', () => {
    expect(stripAccents('Café')).toBe('Cafe');
    expect(stripAccents('Mégère')).toBe('Megere');
    expect(stripAccents('naïve')).toBe('naive');
    expect(stripAccents('À côté')).toBe('A cote');
  });
  it('strip umlauts allemands', () => {
    expect(stripAccents('Müller')).toBe('Muller');
    expect(stripAccents('Würzburg')).toBe('Wurzburg');
  });
  it('strip accents espagnols', () => {
    expect(stripAccents('Año')).toBe('Ano');
    expect(stripAccents('Niño')).toBe('Nino');
  });
  it('preserve ASCII et chars non-diacritiques', () => {
    expect(stripAccents('Hello123')).toBe('Hello123');
    expect(stripAccents('日本語')).toBe('日本語');
  });
  it('chaine vide', () => {
    expect(stripAccents('')).toBe('');
  });
});

describe('transliterate', () => {
  it('allemand ß → ss', () => {
    expect(transliterate('Straße')).toBe('Strasse');
    expect(transliterate('Weiß')).toBe('Weiss');
  });
  it('capital sharp s ẞ → ss (lowercase coherent)', () => {
    expect(transliterate('STRAẞE')).toBe('STRAssE');
  });
  it('ligatures œ/æ', () => {
    expect(transliterate('Sœur')).toBe('Soeur');
    expect(transliterate('Encyclopædia')).toBe('Encyclopaedia');
    expect(transliterate('Œuf')).toBe('oeuf');
  });
  it('scandinave ø/å', () => {
    expect(transliterate('Skåne')).toBe('Skane');
    expect(transliterate('Mølle')).toBe('Molle');
  });
  it('islandais ð/þ', () => {
    expect(transliterate('Þórður')).toBe('thórdur');
  });
  it('polonais ł', () => {
    expect(transliterate('Łódź')).toBe('lódź');
  });
  it('turc ı/İ', () => {
    expect(transliterate('İstanbul')).toBe('istanbul');
  });
  it('preserve chars non mappes', () => {
    expect(transliterate('Hello world')).toBe('Hello world');
    expect(transliterate('日本語')).toBe('日本語');
  });
});

describe('asciiize (transliterate + stripAccents)', () => {
  it('combine les 2 transformations', () => {
    expect(asciiize('Straße')).toBe('Strasse'); // ß → ss
    expect(asciiize('Müller')).toBe('Muller'); // umlaut
    expect(asciiize('Łódź')).toBe('lodz'); // ł + accents
    expect(asciiize('Þórður')).toBe('thordur'); // þ + ð + ó
  });
  it('catalogue use case : matching produit / asset (apres lowercase)', () => {
    // asciiize ne lowercase pas — c'est aux callers de gerer la casse.
    expect(asciiize('Mégère'.toLowerCase())).toBe(asciiize('MEGERE'.toLowerCase()));
    expect(asciiize('Weißbier')).toBe('Weissbier');
  });
});

describe('TRANSLIT_MAP', () => {
  it('contient les chars non-NFD principaux', () => {
    expect(TRANSLIT_MAP['ß']).toBe('ss');
    expect(TRANSLIT_MAP['ẞ']).toBe('ss');
    expect(TRANSLIT_MAP['œ']).toBe('oe');
    expect(TRANSLIT_MAP['ø']).toBe('o');
    expect(TRANSLIT_MAP['ł']).toBe('l');
    expect(TRANSLIT_MAP['þ']).toBe('th');
  });
  it('coherent casse : ẞ et ß donnent meme valeur (audit #1 fix)', () => {
    expect(TRANSLIT_MAP['ß']).toBe(TRANSLIT_MAP['ẞ']);
  });
});

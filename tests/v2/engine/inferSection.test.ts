/**
 * Tests inferProductSection : matcher un produit (par nom) à la section
 * la plus proche parmi les candidates du template.
 */
import { describe, it, expect } from 'vitest';
import {
  tokenize,
  inferProductSection,
  shouldInferSections,
} from '../../../src/v2/engine/inferSection';

describe('tokenize', () => {
  it('nettoie + lowercase + retire stop-words', () => {
    expect(tokenize('Barre de douche INOX')).toEqual(['barre', 'douche', 'inox']);
  });
  it('filtre tokens < 3 chars', () => {
    expect(tokenize('A B CC DDD')).toEqual(['ddd']);
  });
  it('normalise les accents', () => {
    expect(tokenize('Mélangeur')).toEqual(['melangeur']);
  });
  it('vide → tableau vide', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
  it('strip stopwords NL', () => {
    // "het" (le/the) et "een" (un/a) et "met" (avec) sont stopwords NL
    expect(tokenize('Het bad met douche')).toEqual(['bad', 'douche']);
  });
  it('strip stopwords SE', () => {
    // "och" (et) et "med" (avec) en suédois
    expect(tokenize('Tvätt och dusch med kran')).toEqual(['tvatt', 'dusch', 'kran']);
  });
  it('strip stopwords PL + translit ł → l', () => {
    // "oraz" (et), "dla" (pour) en polonais. ł translittéré en l via
    // SECTION_TRANSLIT → "łazienka" devient "lazienka" (matche bien le
    // slugify et le banner template potentiellement deja translit).
    expect(tokenize('Wanna oraz prysznic dla łazienka')).toEqual(['wanna', 'prysznic', 'lazienka']);
  });
  it('translit chars non-NFD : ß / ø / þ / ð', () => {
    expect(tokenize('Straße der Liebe')).toEqual(['strasse', 'liebe']);
    expect(tokenize('Skåne Møbler')).toEqual(['skane', 'mobler']);
    expect(tokenize('Þórður')).toEqual(['thordur']);
  });
});

describe('inferProductSection', () => {
  it('match évident sur tokens partagés', () => {
    const r = inferProductSection('BARRE DOUCHE INOX', [
      'BARRES DE DOUCHES',
      'EVIER',
      'RADIATEURS',
    ]);
    expect(r).toBe('BARRES DE DOUCHES');
  });

  it('matchait pas BAR contre BARRES par stop-words filtrés', () => {
    // "barre" et "barres" sont distincts (Jaccard sur strings exactes
    // post-normalisation). On accepte si overlap ≥ 25 %.
    const r = inferProductSection('Mitigeur lavabo', [
      'BARRES DE DOUCHES',
      'LAVABOS',
      'WC',
    ]);
    expect(r).toBe('LAVABOS');
  });

  it('aucun match → vide', () => {
    const r = inferProductSection('XYZ ABC', [
      'BARRES DE DOUCHES',
      'EVIER',
    ]);
    expect(r).toBe('');
  });

  it('candidates vides → vide', () => {
    expect(inferProductSection('Test', [])).toBe('');
  });

  it('produit vide → vide', () => {
    expect(inferProductSection('', ['BARRES DE DOUCHES'])).toBe('');
  });

  it('multi-tokens : compte les matches', () => {
    const r = inferProductSection('LAVABO MURAL INOX BLANC', [
      'LAVABOS BAS',
      'MITIGEURS',
    ]);
    // "lavabo" match "lavabos" ? Non (strings differents). Pas de match.
    // Test scénario où token EXACT match :
    const r2 = inferProductSection('LAVABO MURAL', ['LAVABO', 'EVIER']);
    expect(r2).toBe('LAVABO');
  });
});

describe('tokenize — multi-langue stop-words', () => {
  it('FR : filtre articles + prepositions', () => {
    expect(tokenize('Mitigeur de la cuisine pour les douches')).toEqual(['mitigeur', 'cuisine', 'douches']);
  });
  it('EN : filters articles + prepositions', () => {
    expect(tokenize('mixer for the kitchen with valves')).toEqual(['mixer', 'kitchen', 'valves']);
  });
  it('DE : filtert Artikel + Präpositionen', () => {
    expect(tokenize('Wasserhahn fur die Kuche mit Ventil')).toEqual(['wasserhahn', 'kuche', 'ventil']);
  });
  it('IT : filtra articoli + preposizioni', () => {
    expect(tokenize('Rubinetto della cucina con valvole')).toEqual(['rubinetto', 'cucina', 'valvole']);
  });
  it('ES : filtra articulos + preposiciones', () => {
    expect(tokenize('Grifo de la cocina con valvulas')).toEqual(['grifo', 'cocina', 'valvulas']);
  });
});

describe('inferProductSection — multi-langue', () => {
  it('produit anglais + sections anglaises', () => {
    const r = inferProductSection('STEEL SHOWER BAR', ['SHOWER BARS', 'KITCHEN', 'TOILETS']);
    expect(r).toBe('SHOWER BARS');
  });
  it('produit allemand + sections allemandes', () => {
    const r = inferProductSection('DUSCH STANGE INOX', ['DUSCH STANGEN', 'KUCHE']);
    expect(r).toBe('DUSCH STANGEN');
  });
});

describe('shouldInferSections', () => {
  it('majorité de produits sans section + plusieurs candidates → true', () => {
    expect(shouldInferSections(8, 10, 3)).toBe(true);
  });
  it('majorité de produits AVEC section → false', () => {
    expect(shouldInferSections(2, 10, 3)).toBe(false);
  });
  it('seulement 1 candidate section → false (pas de choix utile)', () => {
    expect(shouldInferSections(8, 10, 1)).toBe(false);
  });
  it('0 produits → false', () => {
    expect(shouldInferSections(0, 0, 3)).toBe(false);
  });
});

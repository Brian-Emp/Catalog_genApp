/**
 * Tests du helper keyValueSeparator : détection générique des séparateurs
 * key/value (":", "=", "|", "→", "·") pour adapter le pipeline à d'autres
 * conventions typo que celle d'Catalogue A.
 */
import { describe, it, expect } from 'vitest';
import {
  KEY_VALUE_SEPARATORS,
  COMPOUND_SEPARATORS,
  hasKeyValueSeparator,
  splitOnKeyValueSeparator,
} from '../../../src/v2/engine/keyValueSeparator';

describe('hasKeyValueSeparator', () => {
  it('détecte ":" classique', () => {
    expect(hasKeyValueSeparator('MATIÈRE :')).toBe(true);
    expect(hasKeyValueSeparator('MATIÈRE: Inox')).toBe(true);
  });
  it('détecte "=" (catalogues techniques)', () => {
    expect(hasKeyValueSeparator('DEBIT=5L/min')).toBe(true);
    expect(hasKeyValueSeparator('LONGUEUR = 70 cm')).toBe(true);
  });
  it('détecte "|" (catalogues compacts)', () => {
    expect(hasKeyValueSeparator('Matière|Inox')).toBe(true);
  });
  it('détecte "→" (catalogues design)', () => {
    expect(hasKeyValueSeparator('Longueur → 70 cm')).toBe(true);
  });
  it('détecte "·" (point médian)', () => {
    expect(hasKeyValueSeparator('Matière · Inox')).toBe(true);
  });
  it('détecte " — " (em-dash entoure d\'espaces, catalogues editoriaux)', () => {
    expect(hasKeyValueSeparator('MATIÈRE — Bois')).toBe(true);
    expect(hasKeyValueSeparator('Couleur — Noir mat')).toBe(true);
  });
  it('détecte " – " (en-dash entoure d\'espaces)', () => {
    expect(hasKeyValueSeparator('LONGUEUR – 70 cm')).toBe(true);
  });
  it('REJETTE em-dash sans espaces (= nom compose)', () => {
    expect(hasKeyValueSeparator('Bistro—Casa')).toBe(false);
    expect(hasKeyValueSeparator('Eco–stop')).toBe(false);
  });
  it('false pour texte sans séparateur', () => {
    expect(hasKeyValueSeparator('Coulissant et inclinable')).toBe(false);
    expect(hasKeyValueSeparator('Inox')).toBe(false);
    expect(hasKeyValueSeparator('')).toBe(false);
  });
});

describe('splitOnKeyValueSeparator', () => {
  it('split sur ":"', () => {
    const r = splitOnKeyValueSeparator('MATIÈRE : Inox');
    expect(r.key).toBe('MATIÈRE');
    expect(r.value).toBe('Inox');
    expect(r.separator).toBe(':');
  });
  it('split sur "="', () => {
    const r = splitOnKeyValueSeparator('DEBIT = 5 L/min');
    expect(r.key).toBe('DEBIT');
    expect(r.value).toBe('5 L/min');
    expect(r.separator).toBe('=');
  });
  it('split sur "|" sans espaces', () => {
    const r = splitOnKeyValueSeparator('Matière|Inox');
    expect(r.key).toBe('Matière');
    expect(r.value).toBe('Inox');
  });
  it('pas de séparateur → key=full text', () => {
    const r = splitOnKeyValueSeparator('TexteLibre');
    expect(r.key).toBe('TexteLibre');
    expect(r.value).toBe('');
    expect(r.separator).toBeNull();
  });
  it('séparateur seulement (key vide)', () => {
    const r = splitOnKeyValueSeparator(': Inox');
    expect(r.key).toBe('');
    expect(r.value).toBe('Inox');
    expect(r.separator).toBe(':');
  });
  it('split sur em-dash entoure d\'espaces', () => {
    const r = splitOnKeyValueSeparator('MATIÈRE — Bois');
    expect(r.key).toBe('MATIÈRE');
    expect(r.value).toBe('Bois');
    expect(r.separator).toBe('—');
  });
  it('split sur en-dash entoure d\'espaces', () => {
    const r = splitOnKeyValueSeparator('LONGUEUR – 70 cm');
    expect(r.key).toBe('LONGUEUR');
    expect(r.value).toBe('70 cm');
    expect(r.separator).toBe('–');
  });
  it('NE SPLIT PAS sur em-dash sans espaces (nom compose preserve)', () => {
    const r = splitOnKeyValueSeparator('Bistro—Casa');
    expect(r.key).toBe('Bistro—Casa');
    expect(r.value).toBe('');
    expect(r.separator).toBeNull();
  });
});

describe('KEY_VALUE_SEPARATORS', () => {
  it('contient les 5 séparateurs single-char principaux', () => {
    expect(KEY_VALUE_SEPARATORS).toEqual([':', '=', '|', '→', '·']);
  });
});

describe('COMPOUND_SEPARATORS', () => {
  it('contient em-dash et en-dash', () => {
    expect(COMPOUND_SEPARATORS).toEqual(['—', '–']);
  });
});

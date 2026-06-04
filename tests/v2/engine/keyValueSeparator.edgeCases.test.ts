/**
 * Tests edge cases hasKeyValueSeparator (Phase 4 T2).
 *
 * Verifie qu'on couvre les cas suivants sans faux positifs :
 * - "/" NE doit PAS etre key/value (fraction "1/2", ratio "L/min", "10/20/30")
 * - Em-dash compose "Bistro—Casa" NE doit PAS etre key/value (anti FP nom)
 * - Em-dash avec espaces " — " EST key/value (catalogues editoriaux)
 * - Multi-separateurs ":" "→" "·" en mix
 */
import { describe, it, expect } from 'vitest';
import { hasKeyValueSeparator } from '../../../src/v2/engine/keyValueSeparator';

describe('hasKeyValueSeparator — anti-faux-positifs', () => {
  it('"/" dans fraction "1/2" → NOT key/value', () => {
    expect(hasKeyValueSeparator('1/2')).toBe(false);
  });

  it('"/" dans ratio "L/min" → NOT key/value', () => {
    expect(hasKeyValueSeparator('L/min')).toBe(false);
  });

  it('"/" dans multi-tailles "25/30/40" → NOT key/value', () => {
    expect(hasKeyValueSeparator('25/30/40')).toBe(false);
  });

  it('em-dash nom compose "Bistro—Casa" → NOT key/value', () => {
    expect(hasKeyValueSeparator('Bistro—Casa')).toBe(false);
  });

  it('em-dash nom compose "Made—in—France" → NOT key/value', () => {
    expect(hasKeyValueSeparator('Made—in—France')).toBe(false);
  });

  it('en-dash nom compose "Paris–Lyon" → NOT key/value', () => {
    expect(hasKeyValueSeparator('Paris–Lyon')).toBe(false);
  });
});

describe('hasKeyValueSeparator — separateurs reconnus', () => {
  it('": " classique → key/value', () => {
    expect(hasKeyValueSeparator('Matiere : Inox')).toBe(true);
  });

  it('"=" technical → key/value', () => {
    expect(hasKeyValueSeparator('Pressure = 5bar')).toBe(true);
  });

  it('"|" compact col → key/value', () => {
    expect(hasKeyValueSeparator('Matiere|Inox')).toBe(true);
  });

  it('"→" design → key/value', () => {
    expect(hasKeyValueSeparator('Matiere→Inox')).toBe(true);
  });

  it('"·" elegant → key/value', () => {
    expect(hasKeyValueSeparator('Matiere·Inox')).toBe(true);
  });

  it('em-dash ENTOURE d espaces " — " → key/value', () => {
    expect(hasKeyValueSeparator('Matiere — Inox')).toBe(true);
  });

  it('en-dash ENTOURE d espaces " – " → key/value', () => {
    expect(hasKeyValueSeparator('Matiere – Inox')).toBe(true);
  });
});

describe('hasKeyValueSeparator — edge cases', () => {
  it('chaine vide → false', () => {
    expect(hasKeyValueSeparator('')).toBe(false);
  });

  it('whitespace only → false', () => {
    expect(hasKeyValueSeparator('   ')).toBe(false);
  });

  it('separateur seul (degenere) → true (regex match)', () => {
    // Comportement actuel : juste ":" matche. Pas critique mais documente.
    expect(hasKeyValueSeparator(':')).toBe(true);
  });

  it('multi-key dans 1 string : "k1:v1 k2:v2"', () => {
    expect(hasKeyValueSeparator('Matiere: Inox Poids: 2kg')).toBe(true);
  });
});

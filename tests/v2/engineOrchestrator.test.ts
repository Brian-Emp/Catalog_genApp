/**
 * Tests des helpers orchestrator. Couvre pageContentHash (deterministe).
 */

import { describe, expect, it } from 'vitest';
import { pageContentHash } from '../../src/v2/engineOrchestrator';
import type { ExtractedPage, TextSpan } from '../../src/v2/types';

function span(text: string, x: number, y: number): TextSpan {
  return {
    text,
    bbox: [x, y, x + 20, y + 10],
    font: 'Almanach',
    size: 10,
    color: '#000000',
  };
}

function makePage(spans: TextSpan[]): ExtractedPage {
  return {
    page_number: 0,
    page_size: { width: 595, height: 842 },
    slots: [],
    raw_spans: spans,
  };
}

describe('pageContentHash', () => {
  it('même contenu, ordre différent → même hash', () => {
    const a = makePage([span('A', 10, 100), span('B', 10, 200)]);
    const b = makePage([span('B', 10, 200), span('A', 10, 100)]);
    expect(pageContentHash(a)).toBe(pageContentHash(b));
  });

  it('contenu différent → hash différent', () => {
    const a = makePage([span('A', 10, 100)]);
    const b = makePage([span('B', 10, 100)]);
    expect(pageContentHash(a)).not.toBe(pageContentHash(b));
  });

  it('spans vides ignorés', () => {
    const a = makePage([span('  ', 10, 100), span('X', 10, 200)]);
    const b = makePage([span('X', 10, 200)]);
    expect(pageContentHash(a)).toBe(pageContentHash(b));
  });

  it('plus de 20 spans → seuls les 20 premiers (par ordre top-down) comptent', () => {
    const many = Array.from({ length: 25 }, (_, i) => span(`s${i}`, 10, i * 10));
    const reordered = [...many].reverse();
    expect(pageContentHash(makePage(many))).toBe(pageContentHash(makePage(reordered)));
  });

  it('ordre x quand y égal', () => {
    const a = makePage([span('A', 10, 100), span('B', 200, 100)]);
    const b = makePage([span('B', 200, 100), span('A', 10, 100)]);
    expect(pageContentHash(a)).toBe(pageContentHash(b));
    expect(pageContentHash(a)).toBe('A|B');
  });

  it('tolérance 0.5pt sur y (baseline)', () => {
    const a = makePage([span('A', 10, 100.0), span('B', 50, 100.3)]);
    const b = makePage([span('B', 50, 100.3), span('A', 10, 100.0)]);
    expect(pageContentHash(a)).toBe(pageContentHash(b));
    // A vient en premier car x plus petit
    expect(pageContentHash(a)).toBe('A|B');
  });
});

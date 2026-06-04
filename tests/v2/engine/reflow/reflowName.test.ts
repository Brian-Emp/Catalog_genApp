import { describe, it, expect } from 'vitest';
import { reflowName } from '../../../../src/v2/engine/reflow/reflowName';
import type { TextSpan } from '../../../../src/v2/types';

function mkSpan(text: string, x0 = 50, y0 = 100, x1 = 250, y1 = 120, size = 18): TextSpan {
  return { text, bbox: [x0, y0, x1, y1], font: 'Almanach-SemiBold', size, color: '#000000' };
}

describe('reflowName', () => {
  it('nom court → 1 ligne, taille originale', () => {
    const r = reflowName({ text: 'Robinet', span: mkSpan('ANCIEN'), rightBound: 500 });
    expect(r.lines).toEqual(['Robinet']);
    expect(r.fontSize).toBe(18);
    expect(r.yShift).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.ops[0].op).toBe('erase_rect');
    expect(r.ops[1].op).toBe('insert_text');
  });

  it('nom moyen → 1 ligne, taille originale (large bound)', () => {
    const r = reflowName({
      text: 'Mitigeur lavabo TAMARI chrome',
      span: mkSpan('ANCIEN'), rightBound: 500,
    });
    expect(r.lines.length).toBe(1);
    expect(r.fontSize).toBe(18);
  });

  it('nom long → wrap 2 lignes ou shrink', () => {
    const r = reflowName({
      text: 'Mitigeur thermostatique douche QUATRO premium chrome inox',
      span: mkSpan('ANCIEN'), rightBound: 400,
    });
    // soit wrapped 2 lignes a 18pt soit shrink mono-ligne, pas de truncate
    expect(r.truncated).toBe(false);
    if (r.lines.length === 2) {
      expect(r.fontSize).toBe(18);
      expect(r.yShift).toBeGreaterThan(0);
    }
  });

  it('nom tres long avec budget vertical limite → shrink mono-ligne', () => {
    const r = reflowName({
      text: 'Mitigeur thermostatique encastre ALMA 360 rotation premium acier',
      span: mkSpan('ANCIEN'), rightBound: 400,
      bottomBound: 125,  // 5pt sous bbox[1] = 120 → 1 ligne max
    });
    expect(r.lines.length).toBe(1);
    // Pour tenir sur 1 ligne avec ce texte long, doit shrink
    expect(r.fontSize).toBeLessThanOrEqual(18);
  });

  it('emits 1 erase + N insert_text', () => {
    const r = reflowName({
      text: 'A B C D E F G H I J K L',
      span: mkSpan('ANCIEN'), rightBound: 200,
    });
    expect(r.ops[0].op).toBe('erase_rect');
    const inserts = r.ops.filter((o) => o.op === 'insert_text');
    expect(inserts.length).toBe(r.lines.length);
    for (const op of inserts) {
      if (op.op !== 'insert_text') continue;
      expect(op.no_erase).toBe(true);
    }
  });

  it('yShift correct quand wrap', () => {
    const r = reflowName({
      text: 'Mot tres long qui devrait certainement wrapper sur plusieurs lignes',
      span: mkSpan('ANCIEN', 50, 100, 250, 120, 18),
      rightBound: 250,
    });
    if (r.lines.length >= 2) {
      // yShift = (lines-1) * lineHeight
      expect(r.yShift).toBeGreaterThan(0);
    }
  });

  it('respecte maxLines', () => {
    const r = reflowName({
      text: 'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z',
      span: mkSpan('ANCIEN'), rightBound: 100,
      maxLines: 2,
    });
    expect(r.lines.length).toBeLessThanOrEqual(2);
  });
});

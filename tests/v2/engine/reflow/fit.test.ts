/**
 * Tests unitaires des helpers fit (wrap, shrink, fitWrapThenShrink).
 */
import { describe, it, expect } from 'vitest';
import {
  estimateTextWidth,
  wrapByWords,
  truncateWithEllipsis,
  fitWrapThenShrink,
  splitForWrap,
  cleanupLineEnd,
} from '../../../../src/v2/engine/reflow/fit';

describe('estimateTextWidth', () => {
  it('proportionnel au fontSize', () => {
    const a = estimateTextWidth('Hello', 10);
    const b = estimateTextWidth('Hello', 20);
    expect(b).toBeCloseTo(a * 2, 1);
  });
  it('majuscules > minuscules', () => {
    expect(estimateTextWidth('AAAA', 10)).toBeGreaterThan(estimateTextWidth('aaaa', 10));
  });
});

describe('wrapByWords', () => {
  it('texte court tient sur 1 ligne', () => {
    const r = wrapByWords('Hello world', 200, 12);
    expect(r).toEqual(['Hello world']);
  });
  it('coupe au dernier mot qui tient', () => {
    // "Hello world this is" mais maxWidth force 1 mot par ligne (a 10pt)
    const r = wrapByWords('Hello world test cas', 20, 12);
    expect(r.length).toBeGreaterThan(1);
  });
  it('vide → liste vide', () => {
    expect(wrapByWords('   ', 200, 12)).toEqual([]);
  });
});

describe('truncateWithEllipsis', () => {
  it('text qui tient → return identique', () => {
    expect(truncateWithEllipsis('Hi', 200, 12)).toBe('Hi');
  });
  it('text long → ajoute …', () => {
    const r = truncateWithEllipsis('Lorem ipsum dolor sit amet consectetur', 50, 12);
    expect(r.endsWith('…')).toBe(true);
    expect(estimateTextWidth(r, 12)).toBeLessThanOrEqual(50);
  });
});

describe('fitWrapThenShrink', () => {
  const baseOpts = { maxWidth: 200, originalSize: 14, minSize: 10, maxLines: 2 };

  it('texte court → fits-as-is, taille originale', () => {
    const r = fitWrapThenShrink('Hi', baseOpts);
    expect(r.strategy).toBe('fits-as-is');
    expect(r.fontSize).toBe(14);
    expect(r.lines).toEqual(['Hi']);
    expect(r.truncated).toBe(false);
  });

  it('texte moyen → wrapped 2 lignes a taille originale', () => {
    const r = fitWrapThenShrink('Mitigeur cuisine encastre ALMA', baseOpts);
    expect(['wrapped', 'fits-as-is']).toContain(r.strategy);
    expect(r.fontSize).toBe(14);
  });

  it('texte long → shrunk', () => {
    // Avec maxWidth 200, maxLines 2, on devrait pouvoir reduire la font pour faire tenir
    const r = fitWrapThenShrink('Mitigeur cuisine encastre ALMA 360 rotation thermostatique premium', baseOpts);
    expect(['wrapped-shrunk', 'wrapped', 'truncated']).toContain(r.strategy);
    if (r.strategy === 'wrapped-shrunk') {
      expect(r.fontSize).toBeLessThan(14);
      expect(r.fontSize).toBeGreaterThanOrEqual(10);
    }
  });

  it('texte tres long → truncated', () => {
    const veryLong = 'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z'.repeat(5);
    const r = fitWrapThenShrink(veryLong, baseOpts);
    expect(r.truncated).toBe(true);
    expect(r.strategy).toBe('truncated');
    // Derniere ligne doit terminer par ellipse
    expect(r.lines[r.lines.length - 1].endsWith('…')).toBe(true);
  });

  it('chaque ligne tient dans maxWidth', () => {
    const r = fitWrapThenShrink('Mitigeur cuisine encastre ALMA 360 rotation', baseOpts);
    for (const line of r.lines) {
      expect(estimateTextWidth(line, r.fontSize)).toBeLessThanOrEqual(baseOpts.maxWidth + 0.5);
    }
  });

  it('maxLines respecte', () => {
    const r = fitWrapThenShrink('A B C D E F G H I J K L M', { ...baseOpts, maxLines: 2 });
    expect(r.lines.length).toBeLessThanOrEqual(2);
  });
});

describe('cleanupLineEnd', () => {
  it('retire ponctuation tombante', () => {
    expect(cleanupLineEnd('texte ,')).toBe('texte');
    expect(cleanupLineEnd('texte;')).toBe('texte');
    expect(cleanupLineEnd('texte-')).toBe('texte');
  });
  it('retire particules orphelines', () => {
    expect(cleanupLineEnd('mitigeur et')).toBe('mitigeur');
    expect(cleanupLineEnd('longueurs à')).toBe('longueurs');
    expect(cleanupLineEnd('finition de')).toBe('finition');
  });
  it('preserve les mots normaux', () => {
    expect(cleanupLineEnd('Mitigeur thermostatique')).toBe('Mitigeur thermostatique');
  });
});

describe('splitForWrap', () => {
  it('texte qui tient → pas de coupe', () => {
    const r = splitForWrap('Court', 200, 12);
    expect(r.line1).toBe('Court');
    expect(r.line2).toBe('');
    expect(r.cleanBreak).toBe(true);
  });

  it('coupe sur virgule en priorite', () => {
    const r = splitForWrap('Inox brossé, finition mate', 80, 12);
    expect(r.line2).toBeTruthy();
    // line1 doit finir par "brosse" (virgule retiree) sans la suite
    expect(r.line1.toLowerCase()).toContain('brossé');
    expect(r.line2.toLowerCase()).toContain('finition');
    expect(r.cleanBreak).toBe(true);
  });

  it('coupe AVANT " et " (orphelin evite)', () => {
    const r = splitForWrap('coulissant et inclinable', 60, 12);
    // line1 ne doit pas finir par "et"
    expect(r.line1).not.toMatch(/\bet\s*$/i);
    // line2 doit commencer par "et"
    expect(r.line2.toLowerCase().startsWith('et')).toBe(true);
  });

  it('coupe AVANT " ou "', () => {
    const r = splitForWrap('rouge ou bleu marine', 50, 12);
    expect(r.line1).not.toMatch(/\bou\s*$/i);
    expect(r.line2.toLowerCase().startsWith('ou')).toBe(true);
  });

  it('coupe sur ; en haute priorite', () => {
    const r = splitForWrap('option1; option2 et option3', 60, 12);
    expect(r.line1.endsWith('option1')).toBe(true);
  });

  it('fallback espace si pas de breakpoint semantique', () => {
    const r = splitForWrap('aaa bbb ccc ddd eee', 30, 12);
    expect(r.line1).toBeTruthy();
    expect(r.line2).toBeTruthy();
    expect(estimateTextWidth(r.line1, 12)).toBeLessThanOrEqual(30 + 0.5);
  });

  it('nettoie les particules orphelines de line1', () => {
    // Si la coupe naturelle laisse "de" en fin, cleanupLineEnd le retire
    const r = splitForWrap('produit de qualité supérieure inox brossé', 60, 12);
    expect(r.line1).not.toMatch(/\b(de|du|à|et|ou)\s*$/i);
  });

  it('vide → vide', () => {
    expect(splitForWrap('', 100, 12)).toEqual({ line1: '', line2: '', cleanBreak: true });
  });

  it('line1 tient toujours dans maxWidth', () => {
    const r = splitForWrap('Mitigeur thermostatique coulissant et inclinable haute pression', 80, 12);
    expect(estimateTextWidth(r.line1, 12)).toBeLessThanOrEqual(80 + 0.5);
  });
});

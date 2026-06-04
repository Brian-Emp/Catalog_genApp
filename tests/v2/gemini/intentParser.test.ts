import { describe, it, expect } from 'vitest';
import { normalizeIntent } from '../../../src/v2/gemini/intentParser';

describe('normalizeIntent', () => {
  it('parse move avec deltaXpt + deltaYpt', () => {
    const r = normalizeIntent({ kind: 'move', target: 'titre', deltaXpt: 4, deltaYpt: -2 }, 0.5);
    expect(r).toEqual({ kind: 'move', target: 'titre', deltaXpt: 4, deltaYpt: -2, confidence: 0.5 });
  });

  it('parse move sans deltaY (omit)', () => {
    const r = normalizeIntent({ kind: 'move', target: 'nom', deltaXpt: 3 }, 0.7);
    expect(r).toEqual({ kind: 'move', target: 'nom', deltaXpt: 3, deltaYpt: undefined, confidence: 0.7 });
  });

  it('rejete move sans target', () => {
    expect(normalizeIntent({ kind: 'move', deltaXpt: 4 }, 0.5)).toBeNull();
  });

  it('parse resize avec fontSizePt', () => {
    const r = normalizeIntent({ kind: 'resize', target: 'nom', fontSizePt: 13 }, 0.6);
    expect(r).toMatchObject({ kind: 'resize', target: 'nom', fontSizePt: 13, confidence: 0.6 });
  });

  it('parse recolor avec fill hex valide', () => {
    const r = normalizeIntent({ kind: 'recolor', target: 'titre', fill: '#000000' }, 0.5);
    expect(r).toMatchObject({ kind: 'recolor', target: 'titre', fill: '#000000' });
  });

  it('rejete recolor avec fill invalide (sans #)', () => {
    const r = normalizeIntent({ kind: 'recolor', target: 'titre', fill: '000000' }, 0.5);
    expect(r).toMatchObject({ kind: 'recolor', fill: undefined });
  });

  it('parse erase_pad', () => {
    const r = normalizeIntent({ kind: 'erase_pad', target: 'ref', padPt: 8 }, 0.5);
    expect(r).toEqual({ kind: 'erase_pad', target: 'ref', padPt: 8, confidence: 0.5 });
  });

  it('rejete erase_pad sans padPt', () => {
    expect(normalizeIntent({ kind: 'erase_pad', target: 'ref' }, 0.5)).toBeNull();
  });

  it('parse replace_text avec from + to', () => {
    const r = normalizeIntent(
      { kind: 'replace_text', target: 'titre', from: 'AQUASTAR', to: 'ECOSTAR' },
      0.5,
    );
    expect(r).toEqual({
      kind: 'replace_text', target: 'titre', from: 'AQUASTAR', to: 'ECOSTAR', confidence: 0.5,
    });
  });

  it('rejete replace_text sans to', () => {
    expect(normalizeIntent({ kind: 'replace_text', target: 'titre' }, 0.5)).toBeNull();
  });

  it('parse unknown avec description', () => {
    const r = normalizeIntent({ kind: 'unknown', description: 'cas exotique' }, 0.3);
    expect(r).toEqual({ kind: 'unknown', description: 'cas exotique', confidence: 0.3 });
  });

  it('rejete kind inconnu', () => {
    expect(normalizeIntent({ kind: 'teleport', target: 'foo' }, 0.5)).toBeNull();
  });

  it('confidence est clamp 0-1', () => {
    const r = normalizeIntent({ kind: 'move', target: 'a', deltaXpt: 1, confidence: 1.5 }, 0.5);
    expect(r?.confidence).toBe(1);
    const r2 = normalizeIntent({ kind: 'move', target: 'a', deltaXpt: 1, confidence: -0.5 }, 0.5);
    expect(r2?.confidence).toBe(0);
  });

  it('utilise fallbackConfidence si pas fourni', () => {
    const r = normalizeIntent({ kind: 'move', target: 'a', deltaXpt: 1 }, 0.8);
    expect(r?.confidence).toBe(0.8);
  });
});

/**
 * Tests imageMatcher Gemini : match produits orphelins ↔ assets.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { geminiMatchAssets } from '../../../src/v2/gemini/imageMatcher';
import { clearGeminiKeyCache } from '../../../src/v2/gemini/client';

describe('geminiMatchAssets', () => {
  beforeEach(() => {
    clearGeminiKeyCache();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_KEY_FILE;
  });

  it('enabled=false → no-op', async () => {
    const res = await geminiMatchAssets({
      unmatchedProducts: [{ idx: 0, name: 'X', ref: '1' }],
      assets: [{ baseName: 'x_1', absPath: '/p' }],
      enabled: false,
    });
    expect(res.ran).toBe(false);
    expect(res.matched).toEqual([]);
    expect(res.notes).toContain('disabled');
  });

  it('produits vide → no-op', async () => {
    const res = await geminiMatchAssets({
      unmatchedProducts: [],
      assets: [{ baseName: 'x', absPath: '/p' }],
    });
    expect(res.ran).toBe(false);
    expect(res.notes.some((n) => n.includes('aucun produit'))).toBe(true);
  });

  it('assets vide → no-op', async () => {
    const res = await geminiMatchAssets({
      unmatchedProducts: [{ idx: 0, name: 'X', ref: null }],
      assets: [],
    });
    expect(res.ran).toBe(false);
    expect(res.notes.some((n) => n.includes('aucun asset'))).toBe(true);
  });

  it('signature retourne structure attendue', async () => {
    const res = await geminiMatchAssets({
      unmatchedProducts: [{ idx: 0, name: 'X', ref: null }],
      assets: [{ baseName: 'x', absPath: '/p' }],
      enabled: false,
    });
    expect(typeof res.durationMs).toBe('number');
    expect(Array.isArray(res.matched)).toBe(true);
    expect(Array.isArray(res.notes)).toBe(true);
  });
});

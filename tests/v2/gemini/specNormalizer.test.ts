/**
 * Tests spec normalizer Gemini.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { geminiNormalizeSpecs } from '../../../src/v2/gemini/specNormalizer';
import { clearGeminiKeyCache } from '../../../src/v2/gemini/client';

describe('geminiNormalizeSpecs', () => {
  beforeEach(() => {
    clearGeminiKeyCache();
  });

  it('enabled=false → no-op', async () => {
    const res = await geminiNormalizeSpecs({
      productKeys: ['k1'],
      templateKeys: ['K1'],
      enabled: false,
    });
    expect(res.ran).toBe(false);
    expect(res.mapping).toEqual({});
  });

  it('keys vides → no-op', async () => {
    const res = await geminiNormalizeSpecs({
      productKeys: [],
      templateKeys: ['K1'],
    });
    expect(res.ran).toBe(false);
    expect(res.notes.some((n) => n.includes('donnees insuffisantes'))).toBe(true);
  });

  it('templateKeys vides → no-op', async () => {
    const res = await geminiNormalizeSpecs({
      productKeys: ['k1'],
      templateKeys: [],
    });
    expect(res.ran).toBe(false);
  });

  it('signature retourne structure attendue', async () => {
    const res = await geminiNormalizeSpecs({
      productKeys: ['k1'],
      templateKeys: ['K1'],
      enabled: false,
    });
    expect(typeof res.durationMs).toBe('number');
    expect(typeof res.mapping).toBe('object');
    expect(Array.isArray(res.notes)).toBe(true);
  });
});

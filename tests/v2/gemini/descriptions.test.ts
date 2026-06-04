/**
 * Tests descriptions Gemini : génération phrases marketing par section.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { generateDescriptionsGemini } from '../../../src/v2/gemini/descriptions';
import { clearGeminiKeyCache } from '../../../src/v2/gemini/client';

describe('generateDescriptionsGemini', () => {
  beforeEach(() => {
    clearGeminiKeyCache();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_KEY_FILE;
  });

  it('enabled=false → skip', async () => {
    const res = await generateDescriptionsGemini({
      sections: [{ label: 'X', products: [] }],
      enabled: false,
    });
    expect(res.ran).toBe(false);
    expect(res.descriptions).toEqual({});
  });

  it('sections vide → skip', async () => {
    const res = await generateDescriptionsGemini({
      sections: [],
    });
    expect(res.ran).toBe(false);
    expect(res.descriptions).toEqual({});
  });

  it('signature retourne structure attendue', async () => {
    const res = await generateDescriptionsGemini({
      sections: [{ label: 'X', products: [] }],
      enabled: false,
    });
    expect(typeof res.durationMs).toBe('number');
    expect(Array.isArray(res.notes)).toBe(true);
    expect(typeof res.descriptions).toBe('object');
  });
});

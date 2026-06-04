/**
 * Tests coherenceAudit : audit cohérence cross-page via Gemini Pro Vision.
 *
 * Tests unitaires : guards, parsing JSON, helpers.
 * Test d'integration Gemini reel = smoke E2E (couteux en quota).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { coherenceAudit } from '../../../src/v2/gemini/coherenceAudit';
import { clearGeminiKeyCache } from '../../../src/v2/gemini/client';
import type { Plan } from '../../../src/v2/types';

describe('coherenceAudit', () => {
  beforeEach(() => {
    clearGeminiKeyCache();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_KEY_FILE;
  });

  const emptyPlan: Plan = {
    version: '1',
    pages: [],
    stats: { products_used: 0, products_remaining: 0, pages_kept: 0, pages_deleted: 0 },
  };

  it('enabled=false → no-op', async () => {
    const res = await coherenceAudit({
      outPdfPath: '/tmp/none.pdf',
      plan: emptyPlan,
      workDir: '/tmp',
      enabled: false,
    });
    expect(res.ran).toBe(false);
    expect(res.issues).toEqual([]);
    expect(res.notes).toContain('disabled');
  });

  it('plan vide → no-op', async () => {
    // Forcer GEMINI_KEY pour passer le guard de cle
    process.env.GEMINI_API_KEY = 'AIza_test_dummy_key';
    clearGeminiKeyCache();
    const res = await coherenceAudit({
      outPdfPath: '/tmp/none.pdf',
      plan: emptyPlan,
      workDir: '/tmp',
    });
    // Pas de pages substituees → no-op meme avec cle
    expect(res.ran).toBe(false);
    expect(res.notes.some((n) => n.includes('aucune page'))).toBe(true);
  });

  it('signature retourne structure attendue', async () => {
    const res = await coherenceAudit({
      outPdfPath: '/tmp/none.pdf',
      plan: emptyPlan,
      workDir: '/tmp',
      enabled: false,
    });
    expect(typeof res.durationMs).toBe('number');
    expect(Array.isArray(res.issues)).toBe(true);
    expect(Array.isArray(res.sampledPages)).toBe(true);
    expect(Array.isArray(res.notes)).toBe(true);
  });
});

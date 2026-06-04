/**
 * Tests intent loop Gemini : analyse + propose corrections.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { geminiIntentLoop } from '../../../src/v2/gemini/intentLoop';
import { clearGeminiKeyCache } from '../../../src/v2/gemini/client';
import type { Plan } from '../../../src/v2/types';

const emptyPlan: Plan = {
  version: '1',
  pages: [],
  stats: { products_used: 0, products_remaining: 0, pages_kept: 0, pages_deleted: 0 },
};

describe('geminiIntentLoop', () => {
  beforeEach(() => clearGeminiKeyCache());

  it('enabled=false → no-op', async () => {
    const res = await geminiIntentLoop({
      outPdfPath: '/tmp/x.pdf',
      plan: emptyPlan,
      issues: [],
      workDir: '/tmp',
      enabled: false,
    });
    expect(res.ran).toBe(false);
    expect(res.suggestions).toEqual([]);
  });

  it('aucun bug critique → skip', async () => {
    const res = await geminiIntentLoop({
      outPdfPath: '/tmp/x.pdf',
      plan: emptyPlan,
      issues: [
        { finalPageNumber: 1, sourcePage: 1, severity: 'minor', category: 'other', description: 'minor only' },
      ],
      workDir: '/tmp',
    });
    expect(res.suggestions).toEqual([]);
  });

  it('signature retourne structure attendue', async () => {
    const res = await geminiIntentLoop({
      outPdfPath: '/tmp/x.pdf',
      plan: emptyPlan,
      issues: [],
      workDir: '/tmp',
      enabled: false,
    });
    expect(typeof res.durationMs).toBe('number');
    expect(Array.isArray(res.suggestions)).toBe(true);
    expect(Array.isArray(res.notes)).toBe(true);
  });
});

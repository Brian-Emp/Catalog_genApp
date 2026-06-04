import { describe, it, expect } from 'vitest';
import { defaultOrder, routedGenerateText } from '../../../src/v2/gemini/providerRouter';

describe('defaultOrder', () => {
  it('quality = API (cascade) puis Claude — CLI Gemini abandonne', () => {
    expect(defaultOrder('quality')).toEqual(['api', 'claude']);
  });
  it('speed = API (cascade) puis Claude', () => {
    expect(defaultOrder('speed')).toEqual(['api', 'claude']);
  });
});

describe('routedGenerateText cascade (sans reseau)', () => {
  it('order vide → provider none', async () => {
    const r = await routedGenerateText({ prompt: 'x', order: [] });
    expect(r.ok).toBe(false);
    expect(r.provider).toBe('none');
    expect(r.attempts).toHaveLength(0);
  });

  it('claude desactive explicitement (enableClaudeFallback:false) → skipped → none', async () => {
    const r = await routedGenerateText({ prompt: 'x', order: ['claude'], enableClaudeFallback: false });
    expect(r.ok).toBe(false);
    expect(r.provider).toBe('none');
    expect(r.attempts[0].provider).toBe('claude');
    expect(r.attempts[0].skipped).toBe(true);
  });

  it('claude fallback active mais sans workDir → erreur propre', async () => {
    const r = await routedGenerateText({
      prompt: 'x',
      order: ['claude'],
      enableClaudeFallback: true,
    });
    expect(r.ok).toBe(false);
    expect(r.provider).toBe('none');
    expect(r.attempts[0].skipped).toBeFalsy();
    expect(r.attempts[0].error).toContain('workDir');
  });
});

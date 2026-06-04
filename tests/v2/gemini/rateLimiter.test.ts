import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  canUse,
  record,
  getLimit,
  snapshot,
  resetRateLimiter,
} from '../../../src/v2/gemini/rateLimiter';

describe('rateLimiter — RPM/TPM par modele (fenetre 60s)', () => {
  beforeEach(() => resetRateLimiter());

  it('getLimit : valeurs connues + fallback DEFAULT pour modele inconnu', () => {
    expect(getLimit('gemini-3.1-flash-lite').rpm).toBe(15);
    expect(getLimit('gemini-2.5-flash').rpm).toBe(5);
    expect(getLimit('gemini-2.5-flash-lite').rpm).toBe(10);
    expect(getLimit('modele-inconnu-xyz').rpm).toBe(5); // DEFAULT conservateur
  });

  it('RPM : canUse bascule a false une fois le quota minute atteint', () => {
    const m = 'gemini-2.5-flash'; // rpm 5
    for (let i = 0; i < 5; i++) {
      expect(canUse(m)).toBe(true);
      record(m, 100);
    }
    expect(canUse(m)).toBe(false); // 5 appels dans la minute → skip
  });

  it('TPM : canUse false si l\'estimation depasserait le TPM', () => {
    const m = 'gemini-2.5-flash'; // tpm 250k
    record(m, 200_000);
    expect(canUse(m, 60_000)).toBe(false); // 200k + 60k > 250k
    expect(canUse(m, 40_000)).toBe(true); // 200k + 40k = 240k < 250k
  });

  it('TPM infini (Gemma) : jamais borde par les tokens (seulement RPM)', () => {
    const m = 'gemma-4-31b-it'; // tpm Infinity, rpm 15
    record(m, 10_000_000);
    expect(canUse(m, 10_000_000)).toBe(true);
  });

  it('fenetre glissante : le modele se libere apres 60s', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const m = 'gemini-2.5-flash'; // rpm 5
      for (let i = 0; i < 5; i++) record(m, 100);
      expect(canUse(m)).toBe(false);
      vi.setSystemTime(61_000); // +61s → la fenetre se vide
      expect(canUse(m)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('snapshot : remonte l\'usage courant par modele', () => {
    record('gemini-3.1-flash-lite', 500);
    record('gemini-3.1-flash-lite', 500);
    const s = snapshot();
    expect(s['gemini-3.1-flash-lite'].rpmUsed).toBe(2);
    expect(s['gemini-3.1-flash-lite'].rpmMax).toBe(15);
    expect(s['gemini-3.1-flash-lite'].tpmUsed).toBe(1000);
  });
});

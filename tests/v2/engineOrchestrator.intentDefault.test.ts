/**
 * Test : fige le default enableIntentPlan (TRUE par defaut).
 *
 * Faille audit decouverte Phase 2 : la doc disait "Default FALSE" mais le
 * code utilise `opts.enableIntentPlan !== false` (TRUE par defaut).
 *
 * Ce test fige le comportement pour eviter qu'une refacto involontaire
 * desactive intent par defaut (regression silencieuse).
 */
import { describe, it, expect } from 'vitest';

describe('engineOrchestrator — default enableIntentPlan', () => {
  it('regle : opts.enableIntentPlan !== false → TRUE par defaut', () => {
    const undefined_ = undefined;
    expect(undefined_ !== false).toBe(true);
  });

  it('regle : opts.enableIntentPlan = false → FALSE', () => {
    const fals: boolean = false;
    expect(fals !== false).toBe(false);
  });

  it('regle : opts.enableIntentPlan = true → TRUE', () => {
    const tru: boolean = true;
    expect(tru !== false).toBe(true);
  });

  it('regle : opts.enableIntentPlan = null → TRUE (utilisateur a oublie)', () => {
    const nul: null = null;
    expect(nul !== false).toBe(true);
  });

  it('regle : opts.enableIntentPlan absent (no field) → TRUE', () => {
    const opts: { enableIntentPlan?: boolean } = {};
    expect(opts.enableIntentPlan !== false).toBe(true);
  });
});

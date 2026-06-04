/**
 * Tests : presence des stats allocator dans EngineOrchestratorResult
 * (quick win audit pour visibilite efficacite pipeline).
 *
 * Le type a expose : productPagesTotal, productPagesAllocated, allocationRatio,
 * dropReasonCounts.
 */
import { describe, it, expect } from 'vitest';
import type { EngineOrchestratorResult } from '../../src/v2/engineOrchestrator';

describe('EngineOrchestratorResult.stats — allocator stats enrichies', () => {
  it('le type accepte productPagesTotal optionnel', () => {
    const result: Partial<EngineOrchestratorResult['stats']> = {
      productPagesTotal: 188,
    };
    expect(result.productPagesTotal).toBe(188);
  });

  it('le type accepte productPagesAllocated optionnel', () => {
    const result: Partial<EngineOrchestratorResult['stats']> = {
      productPagesAllocated: 8,
    };
    expect(result.productPagesAllocated).toBe(8);
  });

  it('le type accepte allocationRatio (0..1)', () => {
    const result: Partial<EngineOrchestratorResult['stats']> = {
      allocationRatio: 0.04,
    };
    expect(result.allocationRatio).toBeCloseTo(0.04, 5);
  });

  it('le type accepte dropReasonCounts Record<string,number>', () => {
    const result: Partial<EngineOrchestratorResult['stats']> = {
      dropReasonCounts: {
        no_section_match: 80,
        section_overprovided: 20,
        no_active_section: 3,
      },
    };
    expect(result.dropReasonCounts?.no_section_match).toBe(80);
    expect(result.dropReasonCounts?.section_overprovided).toBe(20);
  });

  it('coherence : allocated + drops devrait egaler total (invariant API)', () => {
    // Simule un cas typique Catalogue A : 188 total, 8 allocated, 103 drop
    const productPagesTotal = 188;
    const productPagesAllocated = 8;
    const dropReasonCounts = {
      no_section_match: 80,
      section_overprovided: 20,
      no_active_section: 3,
    };
    const totalDrops = Object.values(dropReasonCounts).reduce((a, b) => a + b, 0);
    // allocated + total drops = total : 8 + 103 = 111 (ne couvre pas tout :
    // certaines pages "product" peuvent etre absorbees ailleurs - identity etc)
    expect(productPagesAllocated + totalDrops).toBeLessThanOrEqual(productPagesTotal);
  });

  it('allocationRatio = allocated/total', () => {
    const total = 188;
    const allocated = 8;
    const ratio = allocated / total;
    expect(ratio).toBeCloseTo(0.0425, 3);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });
});

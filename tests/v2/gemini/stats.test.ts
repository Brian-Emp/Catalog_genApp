/**
 * Tests stats Gemini.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordCall,
  getStats,
  getRecentRecords,
  resetStats,
  formatStats,
} from '../../../src/v2/gemini/stats';

describe('Gemini stats', () => {
  beforeEach(() => {
    resetStats();
  });

  it('initial state : 0 calls', () => {
    const s = getStats();
    expect(s.totalCalls).toBe(0);
    expect(s.okCalls).toBe(0);
  });

  it('record + agrege correctement', () => {
    recordCall({ module: 'visualAudit', model: 'gemini-2.5-flash', status: 'ok', durationMs: 2000 });
    recordCall({ module: 'visualAudit', model: 'gemini-2.5-flash', status: 'cache_hit', durationMs: 0 });
    recordCall({ module: 'descriptions', model: 'gemini-2.5-flash', status: 'error', durationMs: 500, errorCode: 429 });
    const s = getStats();
    expect(s.totalCalls).toBe(3);
    expect(s.okCalls).toBe(1);
    expect(s.cacheHits).toBe(1);
    expect(s.errorCalls).toBe(1);
    expect(s.byModule.visualAudit).toBe(2);
    expect(s.byModule.descriptions).toBe(1);
    expect(s.errorBreakdown[429]).toBe(1);
  });

  it('retry_exhausted compte separement', () => {
    recordCall({ module: 'x', model: 'm', status: 'retry_exhausted', durationMs: 6000 });
    const s = getStats();
    expect(s.retryExhausted).toBe(1);
    expect(s.errorCalls).toBe(0);
    expect(s.okCalls).toBe(0);
  });

  it('fallbacksUsed compte les degradations', () => {
    recordCall({ module: 'a', model: 'flash', status: 'ok', durationMs: 1000 });
    recordCall({ module: 'a', model: 'flash-lite', status: 'ok', durationMs: 1000, usedFallback: true });
    recordCall({ module: 'a', model: 'flash-lite', status: 'ok', durationMs: 1000, usedFallback: true });
    const s = getStats();
    expect(s.totalCalls).toBe(3);
    expect(s.okCalls).toBe(3);
    expect(s.fallbacksUsed).toBe(2);
  });

  it('formatStats string lisible', () => {
    recordCall({ module: 'audit', model: 'flash', status: 'ok', durationMs: 1000 });
    const txt = formatStats();
    expect(txt).toContain('Gemini stats');
    expect(txt).toContain('1 calls');
  });

  it('formatStats 0 calls', () => {
    expect(formatStats()).toContain('0 calls');
  });

  it('getRecentRecords limite a N', () => {
    for (let i = 0; i < 15; i++) {
      recordCall({ module: 'm', model: 'flash', status: 'ok', durationMs: 100 });
    }
    expect(getRecentRecords(5)).toHaveLength(5);
    expect(getRecentRecords(20)).toHaveLength(15);
  });

  it('reset vide', () => {
    recordCall({ module: 'x', model: 'm', status: 'ok', durationMs: 1 });
    expect(getStats().totalCalls).toBe(1);
    resetStats();
    expect(getStats().totalCalls).toBe(0);
  });
});

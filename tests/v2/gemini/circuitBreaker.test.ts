import { describe, it, expect, beforeEach } from 'vitest';
import {
  isCircuitOpen,
  recordFailure,
  recordSuccess,
  resetCircuit,
  getCircuitState,
} from '../../../src/v2/gemini/circuitBreaker';

describe('circuitBreaker', () => {
  beforeEach(() => {
    resetCircuit();
  });

  it('circuit ferme par defaut', () => {
    expect(isCircuitOpen('foo', 'gemini-2.5-flash')).toBe(false);
  });

  it('reste ferme apres 1-2 failures 429', () => {
    recordFailure('foo', 'flash', 429);
    recordFailure('foo', 'flash', 429);
    expect(isCircuitOpen('foo', 'flash')).toBe(false);
  });

  it('s ouvre apres 3 failures 429 consecutifs', () => {
    recordFailure('foo', 'flash', 429);
    recordFailure('foo', 'flash', 429);
    recordFailure('foo', 'flash', 429);
    expect(isCircuitOpen('foo', 'flash')).toBe(true);
  });

  it('ignore les failures non-429 (ex 500)', () => {
    recordFailure('foo', 'flash', 500);
    recordFailure('foo', 'flash', 500);
    recordFailure('foo', 'flash', 500);
    expect(isCircuitOpen('foo', 'flash')).toBe(false);
  });

  it('un succes reset le compteur', () => {
    recordFailure('foo', 'flash', 429);
    recordFailure('foo', 'flash', 429);
    recordSuccess('foo', 'flash');
    recordFailure('foo', 'flash', 429);
    recordFailure('foo', 'flash', 429);
    // 2 failures depuis le succes : pas encore au seuil de 3
    expect(isCircuitOpen('foo', 'flash')).toBe(false);
  });

  it('isole par (module, model)', () => {
    recordFailure('foo', 'flash', 429);
    recordFailure('foo', 'flash', 429);
    recordFailure('foo', 'flash', 429);
    expect(isCircuitOpen('foo', 'flash')).toBe(true);
    expect(isCircuitOpen('bar', 'flash')).toBe(false);
    expect(isCircuitOpen('foo', 'pro')).toBe(false);
  });

  it('getCircuitState retourne snapshot avec failures + open', () => {
    recordFailure('foo', 'flash', 429);
    recordFailure('foo', 'flash', 429);
    recordFailure('foo', 'flash', 429);
    const snap = getCircuitState();
    expect(snap['foo:flash']).toBeDefined();
    expect(snap['foo:flash'].failures).toBe(3);
    expect(snap['foo:flash'].open).toBe(true);
    expect(typeof snap['foo:flash'].openedAt).toBe('number');
  });

  it('resetCircuit(module, model) cible un seul circuit', () => {
    recordFailure('foo', 'flash', 429);
    recordFailure('foo', 'flash', 429);
    recordFailure('foo', 'flash', 429);
    recordFailure('bar', 'pro', 429);
    recordFailure('bar', 'pro', 429);
    recordFailure('bar', 'pro', 429);
    resetCircuit('foo', 'flash');
    expect(isCircuitOpen('foo', 'flash')).toBe(false);
    expect(isCircuitOpen('bar', 'pro')).toBe(true);
  });

  it('resetCircuit() sans args reset tous', () => {
    recordFailure('foo', 'flash', 429);
    recordFailure('foo', 'flash', 429);
    recordFailure('foo', 'flash', 429);
    resetCircuit();
    expect(isCircuitOpen('foo', 'flash')).toBe(false);
  });
});

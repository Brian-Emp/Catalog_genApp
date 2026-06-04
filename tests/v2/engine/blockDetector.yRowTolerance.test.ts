/**
 * Tests computeYRowTolerance — tolerance Y adaptee a la taille de police.
 *
 * Faille review : Y_ROW_TOL=4 absolu etait trop strict sur grand format
 * (>20pt) ou jitter baseline peut depasser 4pt → noms de meme row classes
 * comme rows differentes → layout horizontal mal detecte.
 *
 * Fix : max(4, nameSize * 0.30).
 */
import { describe, it, expect } from 'vitest';
import { computeYRowTolerance } from '../../../src/v2/engine/blockDetector';

describe('computeYRowTolerance', () => {
  it('police Catalogue A (16pt) : tol = 4.8pt (proche de l ancien 4pt)', () => {
    expect(computeYRowTolerance(16)).toBeCloseTo(4.8, 5);
  });

  it('police small (12pt) : tol clampe a 4pt minimum', () => {
    // 12 * 0.30 = 3.6 < 4 → plancher 4
    expect(computeYRowTolerance(12)).toBe(4);
  });

  it('police standard (14pt) : tol clampe a 4pt minimum', () => {
    // 14 * 0.30 = 4.2 > 4 → 4.2
    expect(computeYRowTolerance(14)).toBeCloseTo(4.2, 5);
  });

  it('police large (24pt) : tol = 7.2pt (plus tolerant)', () => {
    expect(computeYRowTolerance(24)).toBeCloseTo(7.2, 5);
  });

  it('police tres large (36pt poster) : tol = 10.8pt', () => {
    expect(computeYRowTolerance(36)).toBeCloseTo(10.8, 5);
  });

  it('police 0 (cas degenere) : tol = 4 (plancher)', () => {
    expect(computeYRowTolerance(0)).toBe(4);
  });

  it('police negative (cas degenere) : tol = 4 (plancher)', () => {
    expect(computeYRowTolerance(-5)).toBe(4);
  });

  it('monotone : tol croit avec nameSize', () => {
    expect(computeYRowTolerance(20)).toBeGreaterThan(
      computeYRowTolerance(15),
    );
    expect(computeYRowTolerance(30)).toBeGreaterThan(
      computeYRowTolerance(25),
    );
  });

  it('invariant : tol >= 4 quel que soit nameSize', () => {
    for (const size of [0, 5, 10, 13, 14, 15, 16, 20, 24, 30, 48]) {
      expect(computeYRowTolerance(size)).toBeGreaterThanOrEqual(4);
    }
  });
});

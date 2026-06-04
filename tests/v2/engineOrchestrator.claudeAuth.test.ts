/**
 * Tests detectClaudeAuthFailure — promotion auth fail Claude des claudeNotes
 * vers warnings utilisateur (quick win audit).
 */
import { describe, it, expect } from 'vitest';
import { detectClaudeAuthFailure } from '../../src/v2/engineOrchestrator';

describe('detectClaudeAuthFailure', () => {
  it('note "claude auth expirée" → true', () => {
    expect(detectClaudeAuthFailure([
      'claude auth expirée — relance `claude login`',
    ])).toBe(true);
  });

  it('note avec "claude login" instruction → true', () => {
    expect(detectClaudeAuthFailure([
      'echec descriptions : merci de faire claude login',
    ])).toBe(true);
  });

  it('note avec "401" status → true', () => {
    expect(detectClaudeAuthFailure([
      'API returned 401 Unauthorized',
    ])).toBe(true);
  });

  it('note avec "authentication_error" → true', () => {
    expect(detectClaudeAuthFailure([
      'is_error=true (subtype: authentication_error)',
    ])).toBe(true);
  });

  it('note avec "Invalid authentication" → true', () => {
    expect(detectClaudeAuthFailure([
      'Invalid authentication credentials',
    ])).toBe(true);
  });

  it('notes normales (sans auth) → false', () => {
    expect(detectClaudeAuthFailure([
      'descriptions sommaire écrites',
      'audit visuel OK',
      'specs normalisées',
    ])).toBe(false);
  });

  it('liste vide → false', () => {
    expect(detectClaudeAuthFailure([])).toBe(false);
  });

  it('1 note auth + 5 notes normales → true (any match)', () => {
    expect(detectClaudeAuthFailure([
      'descriptions sommaire écrites',
      'audit visuel OK',
      'claude auth expirée',
      'specs normalisées',
      'format mismatch faible',
    ])).toBe(true);
  });
});

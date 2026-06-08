import { describe, it, expect, afterEach } from 'vitest';
import { errorBody, failMessage } from '../../src/middleware/httpError';

describe('httpError prod/dev gating', () => {
  const OLD = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = OLD; });

  it('dev : keeps detail + debug extras', () => {
    process.env.NODE_ENV = 'development';
    const b = errorBody('oops', { detail: '/internal/secret/path', debug: { orchestratorErrors: ['x'] } });
    expect(b.error).toBe('oops');
    expect(b.detail).toBe('/internal/secret/path');
    expect(b.orchestratorErrors).toEqual(['x']);
    expect(failMessage('Echec extraction', new Error('boom /srv/app'))).toBe('Echec extraction : boom /srv/app');
  });

  it('prod : strips detail + debug, generic failMessage', () => {
    process.env.NODE_ENV = 'production';
    const b = errorBody('oops', { detail: '/internal/secret/path', debug: { orchestratorErrors: ['x'] } });
    expect(b.error).toBe('oops');
    expect(b.detail).toBeUndefined();
    expect(b.orchestratorErrors).toBeUndefined();
    expect(failMessage('Echec extraction', new Error('boom /srv/app'))).toBe('Echec extraction.');
  });
});

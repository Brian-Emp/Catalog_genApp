import { describe, it, expect, afterEach } from 'vitest';
import {
  isAuthorized,
  requireAuth,
  safeStringEqual,
  extractToken,
  authConfigured,
} from '../../src/middleware/auth';

function mockReq(headers: Record<string, string> = {}): any {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { get: (name: string) => lower[name.toLowerCase()] };
}
function mockRes(): any {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}

describe('auth middleware', () => {
  afterEach(() => {
    delete process.env.ADMIN_TOKEN;
    delete process.env.APP_AUTH_TOKEN;
  });

  it('open mode (no token configured) → always authorized', () => {
    expect(authConfigured()).toBe(false);
    expect(isAuthorized(mockReq())).toBe(true);
  });

  it('closed mode : rejects missing/wrong, accepts header + bearer', () => {
    process.env.ADMIN_TOKEN = 'sekret-123';
    expect(authConfigured()).toBe(true);
    expect(isAuthorized(mockReq())).toBe(false);
    expect(isAuthorized(mockReq({ 'x-auth-token': 'nope' }))).toBe(false);
    expect(isAuthorized(mockReq({ 'x-auth-token': 'sekret-123' }))).toBe(true);
    expect(isAuthorized(mockReq({ authorization: 'Bearer sekret-123' }))).toBe(true);
  });

  it('APP_AUTH_TOKEN is an accepted alias', () => {
    process.env.APP_AUTH_TOKEN = 'alias-tok';
    expect(isAuthorized(mockReq({ 'x-auth-token': 'alias-tok' }))).toBe(true);
  });

  it('requireAuth → 401 when unauthorized, next() when ok', () => {
    process.env.ADMIN_TOKEN = 'k';
    let nexted = false;
    const res = mockRes();
    requireAuth(mockReq() as any, res, () => { nexted = true; });
    expect(res.statusCode).toBe(401);
    expect(nexted).toBe(false);

    const res2 = mockRes();
    nexted = false;
    requireAuth(mockReq({ 'x-auth-token': 'k' }) as any, res2, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(res2.statusCode).toBe(0);
  });

  it('safeStringEqual : exact match only, false on length diff', () => {
    expect(safeStringEqual('abc', 'abc')).toBe(true);
    expect(safeStringEqual('abc', 'abd')).toBe(false);
    expect(safeStringEqual('abc', 'abcd')).toBe(false);
    expect(safeStringEqual('', '')).toBe(true);
  });

  it('extractToken : x-auth-token then bearer then null', () => {
    expect(extractToken(mockReq({ 'x-auth-token': 'h' }) as any)).toBe('h');
    expect(extractToken(mockReq({ authorization: 'Bearer b' }) as any)).toBe('b');
    expect(extractToken(mockReq({ authorization: 'Basic xxx' }) as any)).toBeNull();
    expect(extractToken(mockReq() as any)).toBeNull();
  });
});

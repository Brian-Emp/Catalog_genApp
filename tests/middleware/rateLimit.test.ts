import { describe, it, expect } from 'vitest';
import { makeRateLimiter } from '../../src/middleware/rateLimit';

function mockReq(ip = '1.1.1.1', path = '/x'): any {
  return { ip, path };
}
function mockRes(): any {
  const r: any = { statusCode: 0, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  return r;
}

describe('makeRateLimiter', () => {
  it('allows up to max, then 429 with Retry-After', () => {
    const rl = makeRateLimiter({ windowMs: 10_000, max: 2 });
    let passed = 0;
    const run = () => { const res = mockRes(); rl(mockReq() as any, res, () => passed++); return res; };
    run();
    run();
    const third = run();
    expect(passed).toBe(2);
    expect(third.statusCode).toBe(429);
    expect(third.headers['Retry-After']).toBeDefined();
  });

  it('isolates counters per IP', () => {
    const rl = makeRateLimiter({ windowMs: 10_000, max: 1 });
    let a = 0;
    let b = 0;
    rl(mockReq('1.1.1.1') as any, mockRes() as any, () => a++);
    rl(mockReq('1.1.1.1') as any, mockRes() as any, () => a++); // blocked
    rl(mockReq('2.2.2.2') as any, mockRes() as any, () => b++); // fresh IP
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('skip predicate bypasses the limit entirely', () => {
    const rl = makeRateLimiter({ windowMs: 10_000, max: 0, skip: (r) => r.path === '/health' });
    let passed = 0;
    rl(mockReq('1.1.1.1', '/health') as any, mockRes() as any, () => passed++);
    expect(passed).toBe(1); // bypassed despite max 0

    const res = mockRes();
    rl(mockReq('1.1.1.1', '/other') as any, res, () => passed++);
    expect(res.statusCode).toBe(429); // not skipped → blocked
  });
});

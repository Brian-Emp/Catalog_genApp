/**
 * HTTP integration : drives the real Express app (buildApp) on an ephemeral
 * port. Asserts the security posture end-to-end. Only NON-destructive paths
 * are exercised (401s return before any handler side-effect; the open-mode
 * check uses the harmless stats reset).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { buildApp } from '../../src/app';
import { makeRateLimiter } from '../../src/middleware/rateLimit';

let server: Server;
let base = '';

beforeAll(() => {
  delete process.env.ADMIN_TOKEN;
  server = buildApp().listen(0);
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => { server?.close(); });
afterEach(() => { delete process.env.ADMIN_TOKEN; });

describe('security integration', () => {
  it('sends hardening headers (helmet)', async () => {
    const r = await fetch(`${base}/api/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBeTruthy(); // anti-clickjacking
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  });

  it('DELETE /api/history → 401 without token when ADMIN_TOKEN set', async () => {
    process.env.ADMIN_TOKEN = 'topsecret';
    const r = await fetch(`${base}/api/history?pdf=catalog_0000000000_zzzzzz.pdf`, { method: 'DELETE' });
    expect(r.status).toBe(401);
  });

  it('GET /api/gemini/smoke → 401 without token when ADMIN_TOKEN set', async () => {
    process.env.ADMIN_TOKEN = 'topsecret';
    const r = await fetch(`${base}/api/gemini/smoke`);
    expect(r.status).toBe(401);
  });

  it('?reset=1 → 401 without token, but read stays open', async () => {
    process.env.ADMIN_TOKEN = 'topsecret';
    const reset = await fetch(`${base}/api/gemini/stats?reset=1`);
    expect(reset.status).toBe(401);
    const read = await fetch(`${base}/api/gemini/stats`);
    expect(read.status).toBe(200);
  });

  it('open mode (no ADMIN_TOKEN) lets a reset through', async () => {
    delete process.env.ADMIN_TOKEN;
    const r = await fetch(`${base}/api/gemini/circuit?reset=1`);
    expect(r.status).toBe(200);
  });

  it('GET /generated with a bad token → 403', async () => {
    const r = await fetch(`${base}/generated/catalog_1_a.pdf?token=bad`);
    expect(r.status).toBe(403);
  });

  it('trust proxy is OFF by default (req.ip non spoofable)', () => {
    delete process.env.TRUST_PROXY;
    expect(buildApp().get('trust proxy')).toBe(false);
  });

  it('X-Forwarded-For does NOT bypass the rate limiter when trust proxy is off', async () => {
    // Mini-app isolée : limiter max=2, trust proxy false → req.ip = socket réelle.
    const mini = express();
    mini.set('trust proxy', false);
    mini.use(makeRateLimiter({ windowMs: 60_000, max: 2 }));
    mini.get('/', (_r, res) => res.json({ ok: true }));
    const s = mini.listen(0);
    const port = (s.address() as AddressInfo).port;
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'X-Forwarded-For': `9.9.9.${i}` } });
      codes.push(r.status);
    }
    s.close();
    // IP forgée différente à chaque requête, pourtant bloqué après max=2.
    expect(codes).toEqual([200, 200, 429, 429]);
  });

  it('POST /api/layout → 401 without token when ADMIN_TOKEN set (auth before multer)', async () => {
    process.env.ADMIN_TOKEN = 'topsecret';
    const r = await fetch(`${base}/api/layout`, { method: 'POST' });
    expect(r.status).toBe(401);
  });

  it('multer limit error → 413 (not 500) with no stack trace', async () => {
    delete process.env.ADMIN_TOKEN;
    const fd = new FormData();
    for (let i = 0; i < 25; i++) fd.append(`field${i}`, 'x'); // > 20 fields → LIMIT_FIELD_COUNT
    const r = await fetch(`${base}/api/generate`, { method: 'POST', body: fd });
    expect(r.status).toBe(413);
    const body = await r.text();
    expect(body).not.toMatch(/node_modules|\.ts:\d+|\.js:\d+/); // pas de stack trace
  });
});

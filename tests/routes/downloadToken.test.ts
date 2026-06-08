import { describe, it, expect, afterEach } from 'vitest';
import {
  signDownloadToken,
  signedUrl,
  verifyDownloadToken,
} from '../../src/routes/downloadToken';

function run(file: string, token?: string) {
  const req: any = { params: { file }, query: token === undefined ? {} : { token } };
  const res: any = { statusCode: 0, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  let ok = false;
  verifyDownloadToken(req, res, () => { ok = true; });
  return { res, ok };
}

describe('downloadToken', () => {
  afterEach(() => { delete process.env.DOWNLOAD_TTL_MS; });

  it('valid token (no TTL) passes; wrong/empty/length-diff fail with 403', () => {
    const f = 'catalog_1_a.pdf';
    const t = signDownloadToken(f);
    expect(run(f, t).ok).toBe(true);
    expect(run(f, 'deadbeef').res.statusCode).toBe(403);
    expect(run(f, `${t}x`).res.statusCode).toBe(403); // longueur differente
    expect(run(f).res.statusCode).toBe(403); // token absent
  });

  it('token is bound to the filename (no cross-file reuse)', () => {
    const t = signDownloadToken('a.pdf');
    expect(run('b.pdf', t).res.statusCode).toBe(403);
  });

  it('TTL token : valid before exp, 403 "expiré" after exp', () => {
    const f = 'c.pdf';
    const valid = signDownloadToken(f, Date.now() + 60_000);
    expect(run(f, valid).ok).toBe(true);

    const expired = signDownloadToken(f, Date.now() - 1_000);
    const r = run(f, expired);
    expect(r.res.statusCode).toBe(403);
    expect(String(r.res.body.error)).toMatch(/expir/i);
  });

  it('TTL token with tampered exp fails the signature', () => {
    const f = 'd.pdf';
    const t = signDownloadToken(f, Date.now() + 60_000);
    const sig = t.split('.')[0];
    const tampered = `${sig}.${Date.now() + 9_000_000}`; // exp bidouillé
    expect(run(f, tampered).res.statusCode).toBe(403);
  });

  it('signedUrl honours DOWNLOAD_TTL_MS', () => {
    expect(signedUrl('x.pdf')).toMatch(/token=[a-f0-9]{32}$/); // sans exp
    process.env.DOWNLOAD_TTL_MS = '60000';
    expect(signedUrl('x.pdf')).toMatch(/token=[a-f0-9]{32}\.\d+$/); // avec exp
  });

  it('TTL active : le token SANS expiration (plain) est refusé', () => {
    const f = 'e.pdf';
    const plain = signDownloadToken(f); // forme sans exp
    expect(run(f, plain).ok).toBe(true); // accepté quand TTL inactive

    process.env.DOWNLOAD_TTL_MS = '60000'; // TTL active
    expect(run(f, plain).res.statusCode).toBe(403); // plain refusé
    const ttl = signDownloadToken(f, Date.now() + 60_000);
    expect(run(f, ttl).ok).toBe(true); // un token TTL valide passe
  });
});

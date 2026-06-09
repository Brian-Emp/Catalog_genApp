/**
 * HMAC token to protect access to generated PDFs.
 *
 * The server signs the file name with a secret key (generated at startup if
 * absent from the env). The client receives the URL with ?token=...
 *
 * Expiration: by default the token is valid as long as the server is running
 * (same key), which keeps history links clickable. If `DOWNLOAD_TTL_MS` is
 * set (> 0), the token embeds a signed expiration date (`<sig>.<exp>`) and is
 * rejected past that point.
 *
 * Token comparison is constant-time (crypto.timingSafeEqual) so the signature
 * is not exposed through a timing side-channel.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

const SECRET = process.env.DOWNLOAD_SECRET ?? randomBytes(32).toString('hex');

/** TTL in ms; 0 (default) = no expiration. Read at call time for the tests. */
function ttlMs(): number {
  const n = Number(process.env.DOWNLOAD_TTL_MS ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function hmacHex(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 32);
}

/** Constant-time hex comparison, safe on differing lengths. */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Sign a file name → short hex token. If `exp` > 0, the token has the form
 * `<sig>.<exp>` (exp = epoch ms); the signature covers `filename|exp`.
 */
export function signDownloadToken(filename: string, exp = 0): string {
  if (exp > 0) return `${hmacHex(`${filename}|${exp}`)}.${exp}`;
  return hmacHex(filename);
}

/** Builds the full URL with token (and expiration if DOWNLOAD_TTL_MS). */
export function signedUrl(filename: string): string {
  const ttl = ttlMs();
  const exp = ttl > 0 ? Date.now() + ttl : 0;
  return `/generated/${filename}?token=${signDownloadToken(filename, exp)}`;
}

/** Express middleware: verifies the token query param (constant-time + TTL). */
export function verifyDownloadToken(req: Request, res: Response, next: NextFunction): void {
  const file = req.params.file;
  const raw = req.query.token;
  if (typeof raw !== 'string' || raw.length === 0) {
    res.status(403).json({ error: 'token invalide' });
    return;
  }
  // Form with expiration: "<sig>.<exp>". sig=hex (no dot), exp=digits.
  const dot = raw.lastIndexOf('.');
  if (dot > 0) {
    const exp = Number(raw.slice(dot + 1));
    if (!Number.isFinite(exp) || exp <= 0) {
      res.status(403).json({ error: 'token invalide' });
      return;
    }
    if (Date.now() > exp) {
      res.status(403).json({ error: 'token expiré' });
      return;
    }
    if (!safeEqualHex(raw, signDownloadToken(file, exp))) {
      res.status(403).json({ error: 'token invalide' });
      return;
    }
    next();
    return;
  }
  // Simple form without expiration. Rejected if a TTL is active, otherwise a
  // token without expiration would bypass the configured lifetime.
  if (ttlMs() > 0) {
    res.status(403).json({ error: 'token invalide' });
    return;
  }
  if (!safeEqualHex(raw, signDownloadToken(file))) {
    res.status(403).json({ error: 'token invalide' });
    return;
  }
  next();
}

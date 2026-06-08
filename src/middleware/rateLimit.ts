/**
 * Small in-memory sliding-window rate limiter (per client IP).
 *
 * Mono-instance only: the window state lives in process memory, so it does
 * not hold across replicas (documented trade-off — fine for the single-node
 * deployment this app targets). A `skip` predicate lets high-frequency read
 * endpoints (health probe, progress polling) bypass a broad limiter.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export interface RateLimitOptions {
  /** Window length in ms. */
  windowMs: number;
  /** Max requests allowed per IP within the window. */
  max: number;
  /** Message returned on 429. */
  message?: string;
  /** Optional predicate: return true to bypass the limiter for this request. */
  skip?: (req: Request) => boolean;
}

export function makeRateLimiter(opts: RateLimitOptions): RequestHandler {
  const { windowMs, max, skip } = opts;
  const message = opts.message ?? 'Trop de requêtes. Réessayez plus tard.';
  const hitsByIp = new Map<string, number[]>();

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    if (skip && skip(req)) {
      next();
      return;
    }
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const recent = (hitsByIp.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      const retryMs = windowMs - (now - recent[0]);
      res.setHeader('Retry-After', String(Math.ceil(retryMs / 1000)));
      res.status(429).json({ error: message });
      return;
    }
    recent.push(now);
    hitsByIp.set(ip, recent);
    // Amortised eviction of idle IPs to bound memory.
    if (hitsByIp.size > 1000) {
      for (const [k, ts] of hitsByIp) {
        if (ts.every((t) => now - t >= windowMs)) hitsByIp.delete(k);
      }
    }
    next();
  };
}

/**
 * Shared-token auth for mutating / costly endpoints.
 *
 * Design: the app targets a trusted single-user network and stays OPEN by
 * default (no token configured) so the local/dev experience is unchanged.
 * As soon as `ADMIN_TOKEN` (or `APP_AUTH_TOKEN`) is set in the environment,
 * the protected routes require that token via either:
 *   - `X-Auth-Token: <token>` header, or
 *   - `Authorization: Bearer <token>`.
 *
 * Comparison is constant-time (crypto.timingSafeEqual) to avoid leaking the
 * token through timing. The token is read at call time (not module load) so
 * tests and runtime config changes take effect without a reimport.
 */
import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/** Configured shared secret, or '' when auth is disabled (open mode). */
export function configuredToken(): string {
  return process.env.ADMIN_TOKEN ?? process.env.APP_AUTH_TOKEN ?? '';
}

/** True when a shared token is configured (i.e. protected routes are closed). */
export function authConfigured(): boolean {
  return configuredToken().length > 0;
}

/** Constant-time string compare that is safe on differing lengths. */
export function safeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract a bearer/x-auth token from the request, or null. */
export function extractToken(req: Request): string | null {
  const header = req.get('x-auth-token');
  if (typeof header === 'string' && header.length > 0) return header.trim();
  const auth = req.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) {
    const tok = auth.replace(/^Bearer\s+/i, '').trim();
    if (tok) return tok;
  }
  return null;
}

/** True if the request may proceed: open mode, or a valid token was supplied. */
export function isAuthorized(req: Request): boolean {
  const expected = configuredToken();
  if (expected.length === 0) return true; // open mode
  const provided = extractToken(req);
  return provided !== null && safeStringEqual(provided, expected);
}

/** Express middleware: 401 unless authorized (or open mode). */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthorized(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Authentification requise.' });
}

/** Logs a one-line warning at boot when protected routes are left open. */
export function warnIfAuthOpen(): void {
  if (!authConfigured()) {
    console.warn(
      '[security] ADMIN_TOKEN non défini : les routes mutantes/coûteuses '
        + '(DELETE /api/history, /api/gemini/smoke, POST /api/layout, ?reset=1) '
        + 'sont OUVERTES. Définis ADMIN_TOKEN si le serveur est exposé.',
    );
  }
}

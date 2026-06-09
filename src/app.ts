/**
 * Express app factory. Kept separate from `server.ts` so tests can build the
 * app and drive it over HTTP without binding a fixed port / starting a daemon.
 */
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import path from 'path';
import { generateRouter } from './routes/generate';
import { historyRouter } from './routes/history';
import { progressRouter } from './routes/progress';
import { verifyDownloadToken } from './routes/downloadToken';
import { makeRateLimiter } from './middleware/rateLimit';
import { warnIfAuthOpen } from './middleware/auth';
import { errorBody } from './middleware/httpError';

const num = (v: string | undefined, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export function buildApp(): express.Express {
  const app = express();
  // SECURITY: do NOT trust X-Forwarded-For by default. `true` would let any
  // client spoof req.ip via the header → full rate-limit bypass (a fresh
  // bucket per forged IP). Defaults to false → req.ip = the real socket IP
  // (non-spoofable). ONLY behind a trusted reverse proxy: TRUST_PROXY = number
  // of hops ("1") or the proxy's IP/CIDR.
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', tp ? (/^\d+$/.test(tp) ? Number(tp) : tp) : false);

  // Security headers (CSP, anti-clickjacking, nosniff, …). CSP deliberately
  // tight: same-origin scripts, PDF preview in a same-origin iframe, no inline
  // <script>. `upgrade-insecure-requests` removed (the app runs on
  // http://localhost).
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          frameSrc: ["'self'"],
          objectSrc: ["'self'"],
          frameAncestors: ["'self'"],
          connectSrc: ["'self'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: null,
        },
      },
      // PDFs served same-origin: same-origin CORP is fine, COEP left off.
      crossOriginEmbedderPolicy: false,
    }),
  );

  // General rate limit on /api (anti-flood safety net). Exempts the health
  // probe and progress polling (legitimately high-frequency).
  app.use(
    '/api',
    makeRateLimiter({
      windowMs: 60_000,
      max: num(process.env.RATE_MAX_API, 200),
      skip: (req) => req.path === '/health' || req.path.startsWith('/progress'),
    }),
  );
  // Generation: costly → strict limit (existing).
  app.use(
    '/api/generate',
    makeRateLimiter({
      windowMs: 60_000,
      max: num(process.env.RATE_MAX_GENERATE, 5),
      message: 'Trop de requêtes. Réessayez dans 1 minute.',
    }),
  );
  // Gemini smoke test: triggers real API calls (quota/money) → very strict.
  app.use(
    '/api/gemini/smoke',
    makeRateLimiter({
      windowMs: 5 * 60_000,
      max: num(process.env.RATE_MAX_SMOKE, 3),
      message: 'Smoke Gemini : trop de requêtes. Réessayez plus tard.',
    }),
  );
  // Experimental layout: Gemini Pro per page (~30-45s/page, very costly) →
  // strict limit (auth is enforced on the route itself).
  app.use(
    '/api/layout',
    makeRateLimiter({
      windowMs: 5 * 60_000,
      max: num(process.env.RATE_MAX_LAYOUT, 3),
      message: 'Layout : trop de requêtes. Réessayez plus tard.',
    }),
  );

  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.resolve('public')));

  // PDFs protected by an HMAC token (prevents brute-forcing the stamp).
  app.get('/generated/:file', verifyDownloadToken, (req, res) => {
    const filePath = path.resolve('generated', path.basename(req.params.file));
    res.sendFile(filePath, (err) => {
      if (err) res.status(404).json({ error: 'fichier introuvable' });
    });
  });

  app.use('/api', generateRouter);
  app.use('/api', historyRouter);
  app.use('/api', progressRouter);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Terminal error handler: without it, a multer error (file too large, too
  // many files/fields) or any framework error falls through to Express's
  // default handler → 500 + STACK TRACE in clear text (outside prod). Here:
  // MulterError → clean 4xx, otherwise a generic 500 (detail hidden in prod).
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof multer.MulterError) {
      const tooBig = ['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_FIELD_COUNT', 'LIMIT_PART_COUNT'].includes(
        err.code,
      );
      res.status(tooBig ? 413 : 400).json({ error: `Upload refusé (${err.code}).` });
      return;
    }
    res
      .status(500)
      .json(errorBody('Erreur interne.', { detail: err instanceof Error ? err.message : String(err) }));
  });

  warnIfAuthOpen();
  return app;
}

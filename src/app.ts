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
  // SÉCURITÉ : ne PAS faire confiance à X-Forwarded-For par défaut. `true`
  // laisserait n'importe quel client usurper req.ip via l'en-tête → bypass
  // total du rate-limit (un bucket neuf par IP forgée). Par défaut false →
  // req.ip = IP socket réelle (non spoofable). Derrière un reverse-proxy de
  // confiance UNIQUEMENT : TRUST_PROXY = nb de hops ("1") ou IP/CIDR du proxy.
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', tp ? (/^\d+$/.test(tp) ? Number(tp) : tp) : false);

  // Security headers (CSP, anti-clickjacking, nosniff, …). CSP volontairement
  // serrée : script same-origin, preview PDF en iframe same-origin, pas
  // d'inline <script>. `upgrade-insecure-requests` retiré (l'app tourne en
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
      // PDFs servis same-origin : CORP same-origin OK, COEP laissé off.
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Rate-limit général sur /api (filet anti-flood). Exempte le probe de santé
  // et le polling de progression (haute fréquence légitime).
  app.use(
    '/api',
    makeRateLimiter({
      windowMs: 60_000,
      max: num(process.env.RATE_MAX_API, 200),
      skip: (req) => req.path === '/health' || req.path.startsWith('/progress'),
    }),
  );
  // Génération : coûteuse → limite stricte (existant).
  app.use(
    '/api/generate',
    makeRateLimiter({
      windowMs: 60_000,
      max: num(process.env.RATE_MAX_GENERATE, 5),
      message: 'Trop de requêtes. Réessayez dans 1 minute.',
    }),
  );
  // Smoke Gemini : déclenche de vrais appels API (quota/argent) → très strict.
  app.use(
    '/api/gemini/smoke',
    makeRateLimiter({
      windowMs: 5 * 60_000,
      max: num(process.env.RATE_MAX_SMOKE, 3),
      message: 'Smoke Gemini : trop de requêtes. Réessayez plus tard.',
    }),
  );
  // Layout expérimental : Gemini Pro par page (~30-45s/page, très coûteux) →
  // limite stricte (l'auth est posée sur la route elle-même).
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

  // PDFs proteges par token HMAC (evite brute-force sur le stamp).
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

  // Error handler terminal : sans lui, une erreur multer (fichier trop gros,
  // trop de fichiers/champs) ou toute erreur framework tombe sur le handler
  // par défaut d'Express → 500 + STACK TRACE en clair (hors prod). Ici :
  // MulterError → 4xx propre, sinon 500 générique (détail masqué en prod).
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

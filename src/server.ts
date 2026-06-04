import express from 'express';
import path from 'path';
import { generateRouter } from './routes/generate';
import { historyRouter } from './routes/history';
import { progressRouter } from './routes/progress';
import { verifyDownloadToken } from './routes/downloadToken';

const app = express();
const PORT = Number(process.env.PORT ?? 8080);

// Rate limit basique sur /api/generate (max 5 req / min par IP).
const rateMap = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
app.use('/api/generate', (req, res, next) => {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const hits = (rateMap.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    res.status(429).json({ error: 'Trop de requêtes. Réessayez dans 1 minute.' });
    return;
  }
  hits.push(now);
  rateMap.set(ip, hits);
  // Eviction des IP inactives : empeche rateMap de croitre indefiniment
  // (fuite memoire lente). Balayage amorti, seulement au-dela de 1000 IP.
  if (rateMap.size > 1000) {
    for (const [k, ts] of rateMap) {
      if (ts.every((t) => now - t >= RATE_WINDOW_MS)) rateMap.delete(k);
    }
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.resolve('public')));
// PDFs proteges par token HMAC (evite brute-force sur le stamp).
app.get('/generated/:file', verifyDownloadToken, (_req, res) => {
  const filePath = path.resolve('generated', path.basename(_req.params.file));
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

app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});

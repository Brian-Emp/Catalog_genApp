/**
 * Token HMAC pour proteger l'acces aux PDFs generes.
 *
 * Le serveur signe le nom du fichier avec une cle secrete (generee au
 * demarrage si absente de l'env). Le client recoit l'URL avec ?token=...
 *
 * Expiration : par defaut le token est valable tant que le serveur tourne
 * (meme cle), ce qui garde les liens d'historique cliquables. Si
 * `DOWNLOAD_TTL_MS` est defini (> 0), le token embarque une date d'expiration
 * signee (`<sig>.<exp>`) et est refuse au-dela.
 *
 * La comparaison du token est constant-time (crypto.timingSafeEqual) pour ne
 * pas exposer la signature via un side-channel temporel.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

const SECRET = process.env.DOWNLOAD_SECRET ?? randomBytes(32).toString('hex');

/** TTL en ms ; 0 (defaut) = pas d'expiration. Lu au call time pour les tests. */
function ttlMs(): number {
  const n = Number(process.env.DOWNLOAD_TTL_MS ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function hmacHex(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 32);
}

/** Comparaison hex constant-time, sure sur longueurs differentes. */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Signe un nom de fichier → token hex court. Si `exp` > 0, le token est de la
 * forme `<sig>.<exp>` (exp = epoch ms) ; la signature couvre `filename|exp`.
 */
export function signDownloadToken(filename: string, exp = 0): string {
  if (exp > 0) return `${hmacHex(`${filename}|${exp}`)}.${exp}`;
  return hmacHex(filename);
}

/** Construit l'URL complete avec token (et expiration si DOWNLOAD_TTL_MS). */
export function signedUrl(filename: string): string {
  const ttl = ttlMs();
  const exp = ttl > 0 ? Date.now() + ttl : 0;
  return `/generated/${filename}?token=${signDownloadToken(filename, exp)}`;
}

/** Middleware Express : verifie le token query param (constant-time + TTL). */
export function verifyDownloadToken(req: Request, res: Response, next: NextFunction): void {
  const file = req.params.file;
  const raw = req.query.token;
  if (typeof raw !== 'string' || raw.length === 0) {
    res.status(403).json({ error: 'token invalide' });
    return;
  }
  // Forme avec expiration : "<sig>.<exp>". sig=hex (pas de point), exp=chiffres.
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
  // Forme simple sans expiration. Refusée si une TTL est active, sinon un
  // token sans expiration contournerait la durée de vie configurée.
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

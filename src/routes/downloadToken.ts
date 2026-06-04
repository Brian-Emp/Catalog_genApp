/**
 * Token HMAC pour proteger l'acces aux PDFs generes.
 *
 * Le serveur signe le nom du fichier avec une cle secrete (generee au
 * demarrage si absente de l'env). Le client recoit l'URL avec ?token=...
 * L'URL est valable indefiniment tant que le serveur tourne (meme cle).
 * Au redemarrage : nouvelle cle → anciens tokens invalides (acceptable
 * car les fichiers sont aussi nettoyes periodiquement).
 */
import { createHmac, randomBytes } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

const SECRET = process.env.DOWNLOAD_SECRET ?? randomBytes(32).toString('hex');

/** Signe un nom de fichier → token hex court. */
export function signDownloadToken(filename: string): string {
  return createHmac('sha256', SECRET).update(filename).digest('hex').slice(0, 32);
}

/** Construit l'URL complete avec token. */
export function signedUrl(filename: string): string {
  return `/generated/${filename}?token=${signDownloadToken(filename)}`;
}

/** Middleware Express : verifie le token query param. */
export function verifyDownloadToken(req: Request, res: Response, next: NextFunction): void {
  const file = req.params.file;
  const token = req.query.token;
  if (typeof token !== 'string' || token !== signDownloadToken(file)) {
    res.status(403).json({ error: 'token invalide' });
    return;
  }
  next();
}

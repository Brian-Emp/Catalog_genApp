/**
 * Rendu HTML → PDF via Chromium headless (Playwright).
 *
 * Complement de layoutGen.ts : le HTML genere par Pro est rendu en PDF A4
 * fidele. Chromium gere tout le CSS moderne (flex/grid, @page, polices).
 *
 * Les images en <img src="file://..."> sont chargees depuis le disque local
 * (assets produit). On attend le chargement reseau/fichier avant le print.
 */

import { promises as fs } from 'fs';
import path from 'path';

/**
 * Inline les images <img src="file://..."> (ou chemins absolus) en data URI
 * base64. Necessaire car Chromium via setContent() a une origine about:blank
 * qui ne peut PAS charger file:// (securite). Le base64 est aussi portable
 * (marche en Docker sans soucis de chemins). Exporte pour test.
 */
export async function inlineFileImages(html: string): Promise<string> {
  const MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  };
  // Capture src="file:///abs/x.png" | src="/abs/x.png" | src='file://...'
  const re = /(<img[^>]*\ssrc=)(["'])(file:\/\/)?(\/[^"']+?)(\2)/gi;
  const matches = [...html.matchAll(re)];
  let out = html;
  for (const m of matches) {
    const filePath = m[4];
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext];
    if (!mime) continue;
    try {
      const data = await fs.readFile(filePath);
      const dataUri = `data:${mime};base64,${data.toString('base64')}`;
      out = out.replace(m[0], `${m[1]}${m[2]}${dataUri}${m[5]}`);
    } catch {
      // image absente : on laisse le src tel quel (placeholder)
    }
  }
  return out;
}

export interface HtmlToPdfOptions {
  /** HTML complet (avec <style>). */
  html: string;
  /** Chemin de sortie du PDF. */
  outPdfPath: string;
  /** Format. Default A4. */
  format?: 'A4' | 'Letter';
  /** Timeout rendu ms. Default 30s. */
  timeoutMs?: number;
  /** Imprimer les couleurs de fond (print-color-adjust). Default true. */
  printBackground?: boolean;
}

export interface HtmlToPdfResult {
  ok: boolean;
  outPdfPath?: string;
  bytes?: number;
  /** Nombre de pages physiques du PDF rendu (1 attendu ; >1 = debordement). */
  pageCount?: number;
  error?: string;
  durationMs: number;
}

/**
 * Rend un HTML en PDF. Best-effort : retourne ok:false plutot que jeter.
 */
export async function htmlToPdf(opts: HtmlToPdfOptions): Promise<HtmlToPdfResult> {
  const t0 = Date.now();
  let browser: import('playwright').Browser | null = null;
  try {
    // Import dynamique : evite de charger Playwright (lourd) si non utilise.
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // Inline les images file:// en base64 (setContent ne charge pas file://).
    const html = await inlineFileImages(opts.html);
    await page.setContent(html, {
      waitUntil: 'networkidle',
      timeout: opts.timeoutMs ?? 30_000,
    });
    await fs.mkdir(path.dirname(opts.outPdfPath), { recursive: true });
    await page.pdf({
      path: opts.outPdfPath,
      format: opts.format ?? 'A4',
      printBackground: opts.printBackground ?? true,
      preferCSSPageSize: true,
    });
    await browser.close();
    browser = null;
    const st = await fs.stat(opts.outPdfPath);
    // Compte les pages : "/Type /Page" dans le PDF (heuristique fiable et sans
    // dependance). >1 = le contenu a deborde (a corriger via le prompt).
    let pageCount: number | undefined;
    try {
      const buf = await fs.readFile(opts.outPdfPath);
      const m = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
      pageCount = m ? m.length : undefined;
    } catch { /* best-effort */ }
    return { ok: true, outPdfPath: opts.outPdfPath, bytes: st.size, pageCount, durationMs: Date.now() - t0 };
  } catch (e) {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    return { ok: false, error: (e as Error).message, durationMs: Date.now() - t0 };
  }
}

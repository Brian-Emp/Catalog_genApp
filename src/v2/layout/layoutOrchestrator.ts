/**
 * Orchestrateur du pipeline LAYOUT GEN (mode parallele a la substitution).
 *
 * Flux : PlanProduct[] → pagination par section → 1 appel Pro/page (HTML) →
 * Chromium PDF/page → fusion en un seul PDF (pdf-lib).
 *
 * Active uniquement en mode opt-in : ne remplace PAS la substitution template,
 * c'est une alternative "composition from scratch" activable.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { generateLayoutHtml, extractStyleBlock, type LayoutPageInput, type LayoutProduct } from './layoutGen';
import { htmlToPdf } from './htmlToPdf';
import type { PlanProduct } from '../types';

export interface LayoutOrchestratorOptions {
  products: PlanProduct[];
  /** Dossier des assets images (pour resoudre image_path relatifs). */
  assetsDir?: string;
  /** Produits max par page A4. Default 3 (cf template catalogC). */
  productsPerPage?: number;
  /** Couleur d'accent du catalogue. */
  accentColor?: string;
  /** Concurrence des appels Pro (rate-limit OAuth). Default 2. */
  concurrency?: number;
  workDir: string;
  /** Chemin du PDF final. */
  outPdfPath: string;
}

export interface LayoutOrchestratorResult {
  ok: boolean;
  outPdfPath?: string;
  pageCount: number;
  durationMs: number;
  notes: string[];
}

/**
 * Convertit un PlanProduct en LayoutProduct (specs aplaties, image resolue).
 * Exporte pour test.
 */
export function planProductToLayout(p: PlanProduct, assetsDir?: string): LayoutProduct {
  let imagePath: string | null = p.image_path ?? null;
  if (imagePath && assetsDir && !path.isAbsolute(imagePath)) {
    imagePath = path.join(assetsDir, imagePath);
  }
  return {
    name: p.name,
    ref: p.ref,
    imagePath,
    specs: p.specs
      .filter((s) => s.values.length > 0)
      .map((s) => ({ key: s.key.replace(/\s*:\s*$/, ''), value: s.values.join(' / ') })),
  };
}

/**
 * Pagine les produits : groupes par section (dans l'ordre d'apparition), puis
 * decoupes en pages de productsPerPage. Exporte pour test.
 */
export function paginateBySection(
  products: PlanProduct[],
  perPage: number,
  accentColor?: string,
  assetsDir?: string,
): LayoutPageInput[] {
  // Groupes par section en preservant l'ordre.
  const order: string[] = [];
  const bySection = new Map<string, PlanProduct[]>();
  for (const p of products) {
    const sec = (p.section ?? p.family ?? 'PRODUITS').trim() || 'PRODUITS';
    if (!bySection.has(sec)) {
      bySection.set(sec, []);
      order.push(sec);
    }
    bySection.get(sec)!.push(p);
  }
  const pages: LayoutPageInput[] = [];
  for (const sec of order) {
    const prods = bySection.get(sec)!;
    for (let i = 0; i < prods.length; i += perPage) {
      pages.push({
        sectionTitle: sec.toUpperCase(),
        accentColor,
        products: prods.slice(i, i + perPage).map((p) => planProductToLayout(p, assetsDir)),
      });
    }
  }
  return pages;
}

export async function generateCatalogLayout(
  opts: LayoutOrchestratorOptions,
): Promise<LayoutOrchestratorResult> {
  const t0 = Date.now();
  const notes: string[] = [];
  const perPage = opts.productsPerPage ?? 3;
  const concurrency = Math.max(1, opts.concurrency ?? 2);

  const pageInputs = paginateBySection(opts.products, perPage, opts.accentColor, opts.assetsDir);
  if (pageInputs.length === 0) {
    return { ok: false, pageCount: 0, durationMs: Date.now() - t0, notes: ['aucun produit'] };
  }

  await fs.mkdir(opts.workDir, { recursive: true });
  const total = pageInputs.length;
  const pagePdfPaths: (string | null)[] = new Array(total).fill(null);

  // Helper : genere + rend une page, retourne le HTML (pour extraction CSS).
  const renderPage = async (
    idx: number,
    sharedCss?: string,
  ): Promise<string | null> => {
    const input = pageInputs[idx];
    const gen = await generateLayoutHtml(input, {
      workDir: opts.workDir,
      sharedCss,
      pageNumber: idx + 1,
      totalPages: total,
    });
    if (!gen.ok || !gen.html) {
      notes.push(`page ${idx + 1} (${input.sectionTitle}) : HTML KO — ${gen.error}`);
      return null;
    }
    const pagePdf = path.join(opts.workDir, `layout-page-${idx + 1}.pdf`);
    const rendered = await htmlToPdf({ html: gen.html, outPdfPath: pagePdf });
    if (!rendered.ok) {
      notes.push(`page ${idx + 1} : rendu PDF KO — ${rendered.error}`);
      return gen.html;
    }
    if (rendered.pageCount && rendered.pageCount > 1) {
      notes.push(`page ${idx + 1} : debordement (${rendered.pageCount} pages physiques au lieu d'1)`);
    }
    pagePdfPaths[idx] = pagePdf;
    return gen.html;
  };

  // COHERENCE : page 1 genere le design system complet ; on extrait son CSS et
  // on le reutilise VERBATIM sur les pages suivantes (Pro ne genere alors que
  // le body). Style identique garanti sur tout le catalogue.
  const firstHtml = await renderPage(0);
  const sharedCss = firstHtml ? extractStyleBlock(firstHtml) ?? undefined : undefined;
  if (!sharedCss) notes.push('CSS partage non extrait — pages suivantes en mode autonome');

  if (total > 1) {
    let cursor = 1;
    const worker = async (): Promise<void> => {
      while (cursor < total) {
        const idx = cursor++;
        await renderPage(idx, sharedCss);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total - 1) }, () => worker()));
  }

  // Fusion dans l'ordre.
  const merged = await PDFDocument.create();
  let mergedCount = 0;
  for (const pp of pagePdfPaths) {
    if (!pp) continue;
    try {
      const bytes = await fs.readFile(pp);
      const doc = await PDFDocument.load(bytes);
      const copied = await merged.copyPages(doc, doc.getPageIndices());
      for (const pg of copied) merged.addPage(pg);
      mergedCount++;
    } catch (e) {
      notes.push(`fusion page echec : ${(e as Error).message}`);
    }
  }
  if (mergedCount === 0) {
    return { ok: false, pageCount: 0, durationMs: Date.now() - t0, notes: [...notes, 'aucune page generee'] };
  }
  const out = await merged.save();
  await fs.mkdir(path.dirname(opts.outPdfPath), { recursive: true });
  await fs.writeFile(opts.outPdfPath, out);

  notes.push(`${mergedCount}/${pageInputs.length} pages generees`);
  return {
    ok: true,
    outPdfPath: opts.outPdfPath,
    pageCount: mergedCount,
    durationMs: Date.now() - t0,
    notes,
  };
}

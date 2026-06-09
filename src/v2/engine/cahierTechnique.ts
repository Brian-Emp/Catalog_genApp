/**
 * Cahier technique: inserts a 2x3 grid of schematics BEFORE the last page
 * of the PDF (the back cover stays at the end).
 *
 * Layout: 6 schematics per A4 page. Multiple pages on overflow. Each cell
 * contains name + ref + fit-to-cell schematic.
 *
 * Filtering: only products that are actually ALLOCATED (present on a
 * substituted product page of the PDF) are included. If
 * options.allocatedProductNames is provided, we filter on it. Otherwise: all
 * products with a schema_path pass through.
 *
 * Sommaire: if options.tocFinalPageNumber is provided, we add a
 * "CAHIER TECHNIQUE • pages X-Y" entry at the bottom of the sommaire page
 * (post-process).
 *
 * Position: by default, we insert the cahier pages JUST BEFORE the last page
 * of the PDF (= back cover). If insertBeforeLastPage=false, append at the
 * very end (old behavior).
 */

import { promises as fs } from 'fs';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFEmbeddedPage,
  type PDFPage,
  type PDFFont,
} from 'pdf-lib';
import type { PlanProduct } from '../types';

export interface CahierTechniqueOptions {
  /** Names (trim()) of the products actually substituted in the final PDF.
   *  If provided: we keep ONLY the products whose name is in this set (avoids
   *  adding the schematic of a product that found no slot). */
  allocatedProductNames?: Set<string>;
  /** Page number (1-based) of the sommaire in the final PDF. If provided: we
   *  add a "CAHIER TECHNIQUE … pages X-Y" entry at the bottom of that page. */
  tocFinalPageNumber?: number;
  /** True (default): inserts the cahier pages BEFORE the last page (back
   *  cover). False: append at the very end. */
  insertBeforeLastPage?: boolean;
}

export interface CahierTechniqueResult {
  /** Number of pages actually added to the PDF. */
  pagesAdded: number;
  /** Number of schematics placed in the grid. */
  schemasPlaced: number;
  /** 1-based page number of the first cahier page in the final PDF. */
  firstPageNumber: number | null;
  /** 1-based page number of the last cahier page in the final PDF. */
  lastPageNumber: number | null;
  /** Count of filtered-out products (with schema_path but not allocated). */
  filteredOut: number;
  /** Warnings produced per schematic (file not found, corrupt PDF, etc.). */
  warnings: string[];
}

// ─── Layout constants ────────────────────────────────────────────────────────
const A4_W = 595.28;
const A4_H = 841.89;
const PAGE_MARGIN = 40;
const HEADER_HEIGHT = 30;
const HEADER_FONT_SIZE = 12;
const FOOTER_HEIGHT = 0;

const GRID_COLS = 2;
const GRID_ROWS = 3;
const SCHEMAS_PER_PAGE = GRID_COLS * GRID_ROWS;
const CELL_GAP_X = 12;
const CELL_GAP_Y = 14;

const CELL_TITLE_SIZE = 9.5;
const CELL_REF_SIZE = 7.5;
const CELL_TITLE_AREA_H = 26;
const CELL_PADDING = 4;

// TOC entry append
const TOC_ENTRY_FONT_SIZE = 10;
const TOC_ENTRY_BOTTOM_MARGIN = 80;
const TOC_ENTRY_LEFT_MARGIN = 60;
const TOC_ENTRY_RIGHT_MARGIN = 60;

interface SchemaItem {
  product: PlanProduct;
  embedded: PDFEmbeddedPage;
}

export async function appendCahiersTechniques(
  outPdfPath: string,
  products: PlanProduct[],
  options: CahierTechniqueOptions = {},
): Promise<CahierTechniqueResult> {
  const warnings: string[] = [];
  const insertBeforeLast = options.insertBeforeLastPage !== false;

  // 1. Filtering: products with a schema_path
  const candidates = products.filter(
    (p) => typeof p.schema_path === 'string' && p.schema_path.length > 0,
  );

  // 2. Filtering: products actually allocated (if a list is provided).
  // Tolerant normalization (NFKD + diacritics + whitespace + lowercase) to
  // avoid an overly strict filter ("AQUASTAR  900" misses "AQUASTAR 900",
  // heterogeneous accents/case between XLSX/UI and internal allocations).
  // The caller may provide an already-normalized OR raw set: we re-normalize
  // both sides (idempotent) to guarantee the match.
  const normalize = (s: string): string => s
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  let withSchema = candidates;
  let filteredOut = 0;
  if (options.allocatedProductNames) {
    const normSet = new Set<string>();
    for (const n of options.allocatedProductNames) normSet.add(normalize(n));
    withSchema = candidates.filter((p) => normSet.has(normalize(p.name || '')));
    filteredOut = candidates.length - withSchema.length;
  }

  if (withSchema.length === 0) {
    return {
      pagesAdded: 0,
      schemasPlaced: 0,
      firstPageNumber: null,
      lastPageNumber: null,
      filteredOut,
      warnings,
    };
  }

  const outBytes = await fs.readFile(outPdfPath);
  const outDoc = await PDFDocument.load(outBytes);
  const boldFont = await outDoc.embedFont(StandardFonts.HelveticaBold);
  const regFont = await outDoc.embedFont(StandardFonts.Helvetica);

  // 3. Pre-embed schemas
  const items: SchemaItem[] = [];
  for (const p of withSchema) {
    const schemaPath = p.schema_path as string;
    try {
      const schBytes = await fs.readFile(schemaPath);
      const [embedded] = await outDoc.embedPdf(schBytes, [0]);
      items.push({ product: p, embedded });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(
        `cahier technique "${p.name}" (schema=${schemaPath}) : ${msg}`,
      );
    }
  }
  if (items.length === 0) {
    return {
      pagesAdded: 0,
      schemasPlaced: 0,
      firstPageNumber: null,
      lastPageNumber: null,
      filteredOut,
      warnings,
    };
  }

  const totalCahierPages = Math.ceil(items.length / SCHEMAS_PER_PAGE);
  const initialPageCount = outDoc.getPageCount();

  // 4. Determine the insertion index
  // - insertBeforeLast: just before the last existing page
  // - otherwise: at the end (append)
  // Insertion shifts the following pages, so we increment the index on each
  // iteration to preserve the order of the cahier pages.
  const baseInsertIdx = insertBeforeLast
    ? Math.max(0, initialPageCount - 1)
    : initialPageCount;
  const firstPageNumber1Based = baseInsertIdx + 1;
  const lastPageNumber1Based = baseInsertIdx + totalCahierPages;

  // 5. Draw the cahier pages
  let pagesAdded = 0;
  let schemasPlaced = 0;
  for (let pageIdx = 0; pageIdx < totalCahierPages; pageIdx++) {
    const insertIdx = baseInsertIdx + pageIdx;
    const page = outDoc.insertPage(insertIdx, [A4_W, A4_H]);
    pagesAdded++;

    drawPageHeader(
      page,
      pageIdx + 1,
      totalCahierPages,
      boldFont,
      regFont,
    );

    const startIdx = pageIdx * SCHEMAS_PER_PAGE;
    const endIdx = Math.min(startIdx + SCHEMAS_PER_PAGE, items.length);
    drawGrid(page, items.slice(startIdx, endIdx), boldFont, regFont);
    schemasPlaced += endIdx - startIdx;
  }

  // 6. Patch the sommaire if tocFinalPageNumber is provided
  if (options.tocFinalPageNumber && options.tocFinalPageNumber >= 1) {
    try {
      const tocPageIdx = options.tocFinalPageNumber - 1;
      if (tocPageIdx >= 0 && tocPageIdx < outDoc.getPageCount()) {
        const tocPage = outDoc.getPage(tocPageIdx);
        drawTocEntry(
          tocPage,
          firstPageNumber1Based,
          lastPageNumber1Based,
          boldFont,
          regFont,
        );
      } else {
        warnings.push(
          `cahier technique : tocFinalPageNumber ${options.tocFinalPageNumber} hors limites`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`cahier technique : patch sommaire echec (${msg})`);
    }
  }

  const finalBytes = await outDoc.save();
  await fs.writeFile(outPdfPath, finalBytes);

  return {
    pagesAdded,
    schemasPlaced,
    firstPageNumber: firstPageNumber1Based,
    lastPageNumber: lastPageNumber1Based,
    filteredOut,
    warnings,
  };
}

// ─── Drawing helpers ────────────────────────────────────────────────────────

function drawPageHeader(
  page: PDFPage,
  pageNum: number,
  totalPages: number,
  boldFont: PDFFont,
  regFont: PDFFont,
): void {
  const headerY = A4_H - PAGE_MARGIN;
  page.drawText('CAHIER TECHNIQUE', {
    x: PAGE_MARGIN,
    y: headerY - HEADER_FONT_SIZE,
    size: HEADER_FONT_SIZE,
    font: boldFont,
    color: rgb(0.15, 0.15, 0.15),
  });
  const pageLabel = `Page ${pageNum}/${totalPages}`;
  const pageLabelW = regFont.widthOfTextAtSize(pageLabel, HEADER_FONT_SIZE);
  page.drawText(pageLabel, {
    x: A4_W - PAGE_MARGIN - pageLabelW,
    y: headerY - HEADER_FONT_SIZE,
    size: HEADER_FONT_SIZE,
    font: regFont,
    color: rgb(0.4, 0.4, 0.4),
  });
  page.drawLine({
    start: { x: PAGE_MARGIN, y: headerY - HEADER_HEIGHT },
    end: { x: A4_W - PAGE_MARGIN, y: headerY - HEADER_HEIGHT },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  });
}

function drawGrid(
  page: PDFPage,
  items: SchemaItem[],
  boldFont: PDFFont,
  regFont: PDFFont,
): void {
  const headerY = A4_H - PAGE_MARGIN;
  const gridTop = headerY - HEADER_HEIGHT - 10;
  const gridBottom = PAGE_MARGIN + FOOTER_HEIGHT;
  const gridW = A4_W - 2 * PAGE_MARGIN;
  const gridH = gridTop - gridBottom;
  const cellW = (gridW - CELL_GAP_X * (GRID_COLS - 1)) / GRID_COLS;
  const cellH = (gridH - CELL_GAP_Y * (GRID_ROWS - 1)) / GRID_ROWS;

  for (let i = 0; i < items.length; i++) {
    const col = i % GRID_COLS;
    const row = Math.floor(i / GRID_COLS);
    const cellX = PAGE_MARGIN + col * (cellW + CELL_GAP_X);
    const cellY = gridTop - (row + 1) * cellH - row * CELL_GAP_Y;
    drawCell(page, items[i], cellX, cellY, cellW, cellH, boldFont, regFont);
  }
}

function drawCell(
  page: PDFPage,
  item: SchemaItem,
  x: number,
  y: number,
  w: number,
  h: number,
  boldFont: PDFFont,
  regFont: PDFFont,
): void {
  const { product, embedded } = item;
  page.drawRectangle({
    x,
    y,
    width: w,
    height: h,
    borderColor: rgb(0.85, 0.85, 0.85),
    borderWidth: 0.5,
  });

  const innerX = x + CELL_PADDING;
  const innerW = w - 2 * CELL_PADDING;
  const titleY = y + h - CELL_PADDING - CELL_TITLE_SIZE;
  const name = truncateForWidth(
    (product.name || '').trim(),
    innerW,
    CELL_TITLE_SIZE,
    boldFont,
  );
  page.drawText(name, {
    x: innerX,
    y: titleY,
    size: CELL_TITLE_SIZE,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.1),
  });
  if (product.ref) {
    const refText = `Réf. ${product.ref}`;
    const refTrunc = truncateForWidth(refText, innerW, CELL_REF_SIZE, regFont);
    page.drawText(refTrunc, {
      x: innerX,
      y: titleY - CELL_REF_SIZE - 2,
      size: CELL_REF_SIZE,
      font: regFont,
      color: rgb(0.45, 0.45, 0.45),
    });
  }

  const schemaTop = y + h - CELL_PADDING - CELL_TITLE_AREA_H;
  const schemaBottom = y + CELL_PADDING;
  const availW = innerW;
  const availH = schemaTop - schemaBottom;
  if (availW <= 0 || availH <= 0) return;

  const scale = Math.min(availW / embedded.width, availH / embedded.height);
  const drawW = embedded.width * scale;
  const drawH = embedded.height * scale;
  const drawX = innerX + (availW - drawW) / 2;
  const drawY = schemaBottom + (availH - drawH) / 2;
  page.drawPage(embedded, {
    x: drawX,
    y: drawY,
    width: drawW,
    height: drawH,
  });
}

/**
 * Adds a sommaire entry at the bottom of the TOC page:
 *   "Cahier technique ................. p. X-Y"
 *
 * No attempt to detect the existing layout: we simply draw at the bottom of
 * the page (Y = TOC_ENTRY_BOTTOM_MARGIN). It looks ugly if the TOC page is
 * already filled to the bottom, but it is robust.
 */
function drawTocEntry(
  tocPage: PDFPage,
  firstPage: number,
  lastPage: number,
  boldFont: PDFFont,
  regFont: PDFFont,
): void {
  const { width: pageW } = tocPage.getSize();
  const label = 'Cahier technique';
  const pageRef = firstPage === lastPage
    ? `${firstPage}`
    : `${firstPage}-${lastPage}`;
  const y = TOC_ENTRY_BOTTOM_MARGIN;
  const xLeft = TOC_ENTRY_LEFT_MARGIN;
  const xRight = pageW - TOC_ENTRY_RIGHT_MARGIN;

  // Draw the label on the left
  tocPage.drawText(label, {
    x: xLeft,
    y,
    size: TOC_ENTRY_FONT_SIZE,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.1),
  });
  // Draw the page number on the right
  const pageW2 = regFont.widthOfTextAtSize(pageRef, TOC_ENTRY_FONT_SIZE);
  tocPage.drawText(pageRef, {
    x: xRight - pageW2,
    y,
    size: TOC_ENTRY_FONT_SIZE,
    font: regFont,
    color: rgb(0.1, 0.1, 0.1),
  });
  // Dot leader between the two
  const labelW = boldFont.widthOfTextAtSize(label, TOC_ENTRY_FONT_SIZE);
  const dotStart = xLeft + labelW + 6;
  const dotEnd = xRight - pageW2 - 6;
  if (dotEnd > dotStart) {
    const dotW = regFont.widthOfTextAtSize('.', TOC_ENTRY_FONT_SIZE);
    const dotCount = Math.max(0, Math.floor((dotEnd - dotStart) / (dotW * 1.5)));
    let dots = '';
    for (let i = 0; i < dotCount; i++) dots += '.';
    if (dots) {
      tocPage.drawText(dots, {
        x: dotStart,
        y,
        size: TOC_ENTRY_FONT_SIZE,
        font: regFont,
        color: rgb(0.55, 0.55, 0.55),
      });
    }
  }
}

function truncateForWidth(
  text: string,
  maxWidth: number,
  size: number,
  font: PDFFont,
): string {
  const t = text.trim();
  if (font.widthOfTextAtSize(t, size) <= maxWidth) return t;
  const ell = '…';
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = t.slice(0, mid) + ell;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return t.slice(0, lo) + ell;
}

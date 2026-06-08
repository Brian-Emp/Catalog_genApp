/**
 * Guards the committed SYNTHETIC fixtures (tests/fixtures/synthetic/).
 *
 * These let the whole pipeline + smoke E2E run with zero client data. This
 * test runs in CI with no Docker / no binary : it only checks the fixtures are
 * present and well-formed, so a broken `npm run fixtures:synth` is caught.
 *
 * The full end-to-end run against these fixtures is `npm run smoke` (needs a
 * running container).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';

const DIR = path.resolve(__dirname, '../fixtures/synthetic');
const TEMPLATE = path.join(DIR, 'template.pdf');
const DATA = path.join(DIR, 'data.xlsx');
const ASSETS = path.join(DIR, 'assets.zip');

const EXPECTED_PRODUCTS = 6;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe('synthetic fixtures', () => {
  it('the three fixture files exist', () => {
    expect(existsSync(TEMPLATE), 'template.pdf').toBe(true);
    expect(existsSync(DATA), 'data.xlsx').toBe(true);
    expect(existsSync(ASSETS), 'assets.zip').toBe(true);
  });

  it('template.pdf is a valid multi-page A4 PDF', async () => {
    const doc = await PDFDocument.load(readFileSync(TEMPLATE));
    expect(doc.getPageCount()).toBe(8);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round(width)).toBe(595);
    expect(Math.round(height)).toBe(842);
  });

  it('data.xlsx has the expected schema and product count', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(DATA);
    const ws = wb.worksheets[0];
    expect(ws.rowCount).toBe(EXPECTED_PRODUCTS + 1); // header + products
    const headers = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
    expect(headers).toContain('Designation Produit');
    expect(headers).toContain('Code Produit');
    expect(headers.some((h) => /^100 /.test(h))).toBe(true); // numeric-prefixed spec column
  });

  it('assets.zip holds one valid PNG per product', () => {
    const entries = new AdmZip(ASSETS).getEntries();
    const pngs = entries.filter((e) => e.entryName.endsWith('.png'));
    expect(pngs).toHaveLength(EXPECTED_PRODUCTS);
    for (const e of pngs) {
      expect(e.getData().subarray(0, 8).equals(PNG_SIGNATURE), `${e.entryName} PNG header`).toBe(true);
    }
  });
});

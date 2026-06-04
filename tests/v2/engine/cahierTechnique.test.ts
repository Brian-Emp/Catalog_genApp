/**
 * Tests cahierTechnique : grille 2x3 de schemas en fin de PDF.
 *
 * Couvre :
 *  - no-op si aucun produit n'a schema_path
 *  - 1-6 produits = 1 page (grille remplie partiellement ou completement)
 *  - 7 produits = 2 pages (overflow)
 *  - 13 produits = 3 pages
 *  - warning sans crash si schema_path invalide
 *  - schema_path null/empty = ignore
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { appendCahiersTechniques } from '../../../src/v2/engine/cahierTechnique';
import type { PlanProduct } from '../../../src/v2/types';

let tmpDir: string;
let basePdfPath: string;
let schemaPdfPath: string;

async function makeBasePdf(filePath: string, label: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(label, { x: 50, y: 800, size: 14, font, color: rgb(0, 0, 0) });
  const bytes = await doc.save();
  await fs.writeFile(filePath, bytes);
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cahier-test-'));
  basePdfPath = path.join(tmpDir, 'base.pdf');
  schemaPdfPath = path.join(tmpDir, 'schema.pdf');
  await makeBasePdf(basePdfPath, 'PAGE PRINCIPALE');
  await makeBasePdf(schemaPdfPath, 'SCHEMA SOURCE');
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function product(name: string, schemaPath: string | null = null): PlanProduct {
  return {
    name,
    ref: `REF-${name.replace(/\s+/g, '')}`,
    color: null,
    image_path: null,
    specs: [],
    variants: [],
    schema_path: schemaPath,
  };
}

async function freshOut(suffix: string): Promise<string> {
  const p = path.join(tmpDir, `out_${suffix}.pdf`);
  await fs.copyFile(basePdfPath, p);
  return p;
}

async function pageCount(filePath: string): Promise<number> {
  const doc = await PDFDocument.load(await fs.readFile(filePath));
  return doc.getPageCount();
}

describe('appendCahiersTechniques grille 2x3', () => {
  it('no-op si aucun produit n a schema_path', async () => {
    const outPath = await freshOut('noop');
    const before = (await fs.readFile(outPath)).length;
    const res = await appendCahiersTechniques(outPath, [
      product('Sans1'),
      product('Sans2'),
    ]);
    expect(res.pagesAdded).toBe(0);
    expect(res.schemasPlaced).toBe(0);
    expect(res.warnings).toEqual([]);
    expect((await fs.readFile(outPath)).length).toBe(before);
  });

  it('1 produit avec schema = 1 page', async () => {
    const outPath = await freshOut('1product');
    const initial = await pageCount(outPath);
    const res = await appendCahiersTechniques(outPath, [
      product('A', schemaPdfPath),
    ]);
    expect(res.pagesAdded).toBe(1);
    expect(res.schemasPlaced).toBe(1);
    expect(await pageCount(outPath)).toBe(initial + 1);
  });

  it('6 produits avec schema = 1 page (grille pleine)', async () => {
    const outPath = await freshOut('6products');
    const initial = await pageCount(outPath);
    const items = Array.from({ length: 6 }, (_, i) => product(`P${i}`, schemaPdfPath));
    const res = await appendCahiersTechniques(outPath, items);
    expect(res.pagesAdded).toBe(1);
    expect(res.schemasPlaced).toBe(6);
    expect(await pageCount(outPath)).toBe(initial + 1);
  });

  it('7 produits = 2 pages (overflow)', async () => {
    const outPath = await freshOut('7products');
    const initial = await pageCount(outPath);
    const items = Array.from({ length: 7 }, (_, i) => product(`P${i}`, schemaPdfPath));
    const res = await appendCahiersTechniques(outPath, items);
    expect(res.pagesAdded).toBe(2);
    expect(res.schemasPlaced).toBe(7);
    expect(await pageCount(outPath)).toBe(initial + 2);
  });

  it('13 produits = 3 pages (6+6+1)', async () => {
    const outPath = await freshOut('13products');
    const initial = await pageCount(outPath);
    const items = Array.from({ length: 13 }, (_, i) => product(`P${i}`, schemaPdfPath));
    const res = await appendCahiersTechniques(outPath, items);
    expect(res.pagesAdded).toBe(3);
    expect(res.schemasPlaced).toBe(13);
    expect(await pageCount(outPath)).toBe(initial + 3);
  });

  it('warning sans crash si schema_path inexistant (mix avec valides)', async () => {
    const outPath = await freshOut('missing');
    const res = await appendCahiersTechniques(outPath, [
      product('Bad', '/tmp/does-not-exist-xyz-12345.pdf'),
      product('Good', schemaPdfPath),
    ]);
    // 1 schema OK → 1 page, 1 warning
    expect(res.pagesAdded).toBe(1);
    expect(res.schemasPlaced).toBe(1);
    expect(res.warnings.length).toBe(1);
    expect(res.warnings[0]).toContain('Bad');
  });

  it('schema_path null ou empty = ignore', async () => {
    const outPath = await freshOut('empty');
    const res = await appendCahiersTechniques(outPath, [
      product('Empty', ''),
      product('Null', null),
    ]);
    expect(res.pagesAdded).toBe(0);
    expect(res.schemasPlaced).toBe(0);
    expect(res.warnings).toEqual([]);
  });

  it('tronque nom long sans crash', async () => {
    const outPath = await freshOut('longname');
    const longName = 'PRODUIT AVEC UN NOM EXTREMEMENT LONG QUI DOIT ETRE TRONQUE AVEC ELLIPSE POUR TENIR DANS LA CELLULE';
    const res = await appendCahiersTechniques(outPath, [
      product(longName, schemaPdfPath),
    ]);
    expect(res.pagesAdded).toBe(1);
    expect(res.schemasPlaced).toBe(1);
    expect(res.warnings).toEqual([]);
  });

  it('filtrage normalise : tolere casse, whitespace multiple, accents', async () => {
    const outPath = await freshOut('norm');
    const res = await appendCahiersTechniques(
      outPath,
      [
        product('aquastar  900', schemaPdfPath),
        product('JÉTMAX PRO', schemaPdfPath),
        product('Turboflow XL', schemaPdfPath),
      ],
      {
        allocatedProductNames: new Set([
          'AQUASTAR 900',
          'JETMAX PRO',
          'TURBOFLOW XL',
        ]),
      },
    );
    expect(res.schemasPlaced).toBe(3);
    expect(res.filteredOut).toBe(0);
  });

  it('filtrage allocatedProductNames : exclut les non-alloues', async () => {
    const outPath = await freshOut('filter');
    const res = await appendCahiersTechniques(
      outPath,
      [
        product('AlloueA', schemaPdfPath),
        product('NonAlloue', schemaPdfPath),
        product('AlloueB', schemaPdfPath),
      ],
      { allocatedProductNames: new Set(['AlloueA', 'AlloueB']) },
    );
    expect(res.schemasPlaced).toBe(2);
    expect(res.filteredOut).toBe(1);
    expect(res.pagesAdded).toBe(1);
  });

  it('filtrage : tous filtres = no-op', async () => {
    const outPath = await freshOut('all-filtered');
    const res = await appendCahiersTechniques(
      outPath,
      [product('X', schemaPdfPath), product('Y', schemaPdfPath)],
      { allocatedProductNames: new Set<string>() },
    );
    expect(res.schemasPlaced).toBe(0);
    expect(res.filteredOut).toBe(2);
    expect(res.pagesAdded).toBe(0);
  });

  it('insertBeforeLastPage=true (default) : insere avant derniere page', async () => {
    const outPath = await freshOut('insert-before');
    // Base PDF a 1 page initiale. On va etendre a 3 pages pour le test.
    const doc = await PDFDocument.load(await fs.readFile(outPath));
    doc.addPage([595, 842]);
    doc.addPage([595, 842]); // page derniere
    await fs.writeFile(outPath, await doc.save());
    // PDF: P1 P2 P3 (3 pages)
    const res = await appendCahiersTechniques(
      outPath,
      [product('A', schemaPdfPath), product('B', schemaPdfPath)],
    );
    expect(res.pagesAdded).toBe(1);
    // PDF final: P1 P2 [Cahier] P3 (4 pages)
    expect(await pageCount(outPath)).toBe(4);
    // Cahier est a la position 3 (1-based)
    expect(res.firstPageNumber).toBe(3);
    expect(res.lastPageNumber).toBe(3);
  });

  it('insertBeforeLastPage=false : append a la fin', async () => {
    const outPath = await freshOut('append-end');
    const doc = await PDFDocument.load(await fs.readFile(outPath));
    doc.addPage([595, 842]);
    await fs.writeFile(outPath, await doc.save());
    // PDF: P1 P2 (2 pages)
    const res = await appendCahiersTechniques(
      outPath,
      [product('A', schemaPdfPath)],
      { insertBeforeLastPage: false },
    );
    expect(res.pagesAdded).toBe(1);
    expect(await pageCount(outPath)).toBe(3);
    expect(res.firstPageNumber).toBe(3);
  });

  it('tocFinalPageNumber : ajoute entree sommaire sans crash', async () => {
    const outPath = await freshOut('toc-entry');
    const res = await appendCahiersTechniques(
      outPath,
      [product('A', schemaPdfPath)],
      { tocFinalPageNumber: 1, insertBeforeLastPage: false },
    );
    expect(res.pagesAdded).toBe(1);
    expect(res.warnings).toEqual([]);
  });

  it('tocFinalPageNumber invalide : warning sans crash', async () => {
    const outPath = await freshOut('toc-invalid');
    const res = await appendCahiersTechniques(
      outPath,
      [product('A', schemaPdfPath)],
      { tocFinalPageNumber: 999 },
    );
    expect(res.pagesAdded).toBe(1);
    expect(res.warnings.length).toBe(1);
    expect(res.warnings[0]).toContain('hors limites');
  });
});

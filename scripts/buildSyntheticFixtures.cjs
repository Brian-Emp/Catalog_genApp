/**
 * Generates a fully SYNTHETIC, self-contained catalog fixture set so the whole
 * pipeline (extract -> classify -> substitute -> renumber -> TOC -> render) and
 * the smoke E2E can run with ZERO client data.
 *
 * Output (committed to git, see tests/fixtures/.gitignore):
 *   tests/fixtures/synthetic/template.pdf   multi-page catalog-shaped template
 *   tests/fixtures/synthetic/data.xlsx      6 fake products in 2 sections
 *   tests/fixtures/synthetic/assets.zip     6 placeholder PNGs (one per ref)
 *
 * Everything here is invented. No brand, no real product, no client reference.
 *
 * The page geometry mirrors what the heuristic detectors key on (see
 * src/v2/engine/profile.ts + blockDetector.ts):
 *   - product name : bold font, ~16pt, left zone (x < 45% page width)
 *   - spec key     : bold font, ~10pt, right zone (x > 40%), ends with ":"
 *   - spec value   : regular font, ~10pt, just right of the key
 *   - >= 3 spec keys per page so the profile is detected (not fallback)
 *
 * Regenerate with:  node scripts/buildSyntheticFixtures.cjs
 */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '../tests/fixtures/synthetic');
const PAGE_W = 595;
const PAGE_H = 842;

// ─── Synthetic catalog content (invented) ───────────────────────────────────
const SECTIONS = [
  {
    label: 'EVIERS',
    tocPage: 4,
    products: [
      { ref: 'SY-1001', name: 'EVIER SOLENE 1', specs: [['MATIERE', 'inox 304'], ['BACS', '1 bac'], ['LARGEUR', '60 cm']] },
      { ref: 'SY-1002', name: 'EVIER SOLENE 2', specs: [['MATIERE', 'inox 316'], ['BACS', '2 bacs'], ['LARGEUR', '80 cm']] },
      { ref: 'SY-1003', name: 'EVIER SOLENE 3', specs: [['MATIERE', 'granit'], ['BACS', '1 bac + egouttoir'], ['LARGEUR', '90 cm']] },
    ],
  },
  {
    label: 'MITIGEURS',
    tocPage: 6,
    products: [
      { ref: 'SY-2001', name: 'MITIGEUR AVRIL 1', specs: [['MECANISME', 'ceramique 35 mm'], ['FINITION', 'chrome'], ['HAUTEUR', '28 cm']] },
      { ref: 'SY-2002', name: 'MITIGEUR AVRIL 2', specs: [['MECANISME', 'ceramique 40 mm'], ['FINITION', 'noir mat'], ['HAUTEUR', '32 cm']] },
      { ref: 'SY-2003', name: 'MITIGEUR AVRIL 3', specs: [['MECANISME', 'cartouche C3'], ['FINITION', 'inox brosse'], ['HAUTEUR', '38 cm']] },
    ],
  },
];

// ─── PNG helper : solid-colour RGB PNG, pure Node (no PIL) ───────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function solidPng(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type RGB
  // 10,11,12 = compression/filter/interlace = 0
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── PDF helpers ─────────────────────────────────────────────────────────────
// We lay out in TOP-origin coordinates (y grows downward, like the extracted
// JSON). pdf-lib draws from the bottom, so convert: drawY = H - yTop - size.
function makeDrawer(page, fonts) {
  return (text, xLeft, yTop, size, weight, color) => {
    page.drawText(text, {
      x: xLeft,
      y: PAGE_H - yTop - size,
      size,
      font: weight === 'bold' ? fonts.bold : fonts.reg,
      color: color || rgb(0, 0, 0),
    });
  };
}

function drawProductPage(page, fonts, section, startNumber, footerNo) {
  const draw = makeDrawer(page, fonts);
  const grey = rgb(0.13, 0.13, 0.13);
  // Section ribbon (left edge, like a vertical tab — kept short so it is not a name)
  draw(section.label, 22, 40, 12, 'bold', rgb(0.4, 0.4, 0.4));

  const blockTops = [120, 360, 600];
  section.products.forEach((p, i) => {
    const yTop = blockTops[i];
    // image placeholder box (left)
    page.drawRectangle({
      x: 50, y: PAGE_H - (yTop + 150), width: 150, height: 150,
      color: rgb(0.88, 0.88, 0.88),
    });
    // product name (bold, ~16pt, left zone)
    draw(p.name, 220, yTop, 16, 'bold');
    // reference under the name
    draw('Ref. ' + p.ref, 220, yTop + 22, 9, 'reg', grey);
    // spec rows (key bold + ":" in specs zone, value regular to the right)
    p.specs.forEach(([k, v], j) => {
      const sy = yTop + 48 + j * 18;
      draw(k + ' :', 330, sy, 10, 'bold');
      draw(v, 430, sy, 10, 'reg', grey);
    });
  });
  // footer page number (bottom-centre)
  draw(String(footerNo), PAGE_W / 2 - 4, PAGE_H - 36, 10, 'reg', grey);
}

async function buildTemplate() {
  const doc = await PDFDocument.create();
  doc.setTitle('Synthetic demo catalog');
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const fonts = {
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    reg: await doc.embedFont(StandardFonts.Helvetica),
  };

  // 0 — COVER : giant headline + full-bleed light image rect
  {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: rgb(0.93, 0.95, 0.97) });
    const draw = makeDrawer(page, fonts);
    draw('CATALOGUE', 70, 300, 54, 'bold', rgb(0.1, 0.2, 0.35));
    draw('DEMO', 70, 370, 54, 'bold', rgb(0.1, 0.2, 0.35));
    draw('Edition synthetique - donnees fictives', 72, 450, 14, 'reg', rgb(0.3, 0.3, 0.3));
  }

  // 1 — IDENTITY : marketing paragraph
  {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const draw = makeDrawer(page, fonts);
    draw('NOTRE MAISON', 70, 120, 28, 'bold', rgb(0.1, 0.2, 0.35));
    const lines = [
      'Cette edition de demonstration est entierement synthetique.',
      'Aucune marque, aucun produit reel, aucune reference client.',
      'Elle sert uniquement a faire tourner le pipeline de bout en bout',
      'sans donnee proprietaire.',
    ];
    lines.forEach((l, i) => draw(l, 70, 180 + i * 22, 12, 'reg', rgb(0.2, 0.2, 0.2)));
  }

  // 2 — SOMMAIRE (TOC)
  {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const draw = makeDrawer(page, fonts);
    draw('SOMMAIRE', 70, 110, 30, 'bold', rgb(0.1, 0.2, 0.35));
    SECTIONS.forEach((s, i) => {
      const y = 190 + i * 40;
      draw(s.label, 80, y, 14, 'bold', rgb(0.15, 0.15, 0.15));
      draw('. . . . . . . . . . . . . . . . . . . . . . . . . . . . . .', 220, y, 14, 'reg', rgb(0.6, 0.6, 0.6));
      draw(String(s.tocPage), 510, y, 14, 'reg', rgb(0.15, 0.15, 0.15));
    });
  }

  // For each section : intercalaire page + product page
  let footer = 4;
  for (const section of SECTIONS) {
    // intercalaire (section divider)
    {
      const page = doc.addPage([PAGE_W, PAGE_H]);
      page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: rgb(0.1, 0.2, 0.35) });
      const draw = makeDrawer(page, fonts);
      draw(section.label, 70, 380, 40, 'bold', rgb(1, 1, 1));
      footer++;
    }
    // product page
    {
      const page = doc.addPage([PAGE_W, PAGE_H]);
      drawProductPage(page, fonts, section, 1, footer);
      footer++;
    }
  }

  // last — GLOSSARY
  {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const draw = makeDrawer(page, fonts);
    draw('GLOSSAIRE', 70, 110, 28, 'bold', rgb(0.1, 0.2, 0.35));
    const terms = [
      ['Inox 304', 'acier inoxydable austenitique courant.'],
      ['Mitigeur', 'robinet a commande unique melangeant chaud et froid.'],
      ['Cartouche', 'mecanisme ceramique interne du mitigeur.'],
    ];
    terms.forEach(([t, d], i) => {
      draw(t, 70, 180 + i * 26, 12, 'bold', rgb(0.15, 0.15, 0.15));
      draw(d, 200, 180 + i * 26, 12, 'reg', rgb(0.2, 0.2, 0.2));
    });
    draw(String(footer), PAGE_W / 2 - 4, PAGE_H - 36, 10, 'reg', rgb(0.13, 0.13, 0.13));
  }

  const bytes = await doc.save();
  fs.writeFileSync(path.join(OUT, 'template.pdf'), bytes);
  console.log('template.pdf  :', bytes.length, 'bytes,', doc.getPageCount(), 'pages');
}

async function buildData() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Feuil1');
  ws.columns = [
    { header: 'Code Produit', key: 'sku', width: 12 },
    { header: 'Gencod', key: 'gencod', width: 15 },
    { header: 'Designation Produit', key: 'name', width: 30 },
    { header: 'Libelle Famille', key: 'famille', width: 18 },
    { header: 'Libelle SFamille', key: 'sfamille', width: 22 },
    { header: '100 Matiere', key: 's100', width: 16 },
    { header: '101 Caracteristique', key: 's101', width: 22 },
    { header: '102 Dimension', key: 's102', width: 16 },
    { header: '103 Finition', key: 's103', width: 16 },
    { header: '104 Garantie', key: 's104', width: 12 },
  ];
  let gencodSeq = 3000000000001;
  for (const section of SECTIONS) {
    for (const p of section.products) {
      ws.addRow({
        sku: p.ref,
        gencod: String(gencodSeq++),
        name: p.name.replace(/\bSOLENE\b/, 'OPALE').replace(/\bAVRIL\b/, 'MISTRAL'), // data differs from template placeholders
        famille: section.label,
        sfamille: section.label === 'EVIERS' ? 'Eviers inox et granit' : 'Mitigeurs cuisine',
        s100: p.specs[0][1],
        s101: p.specs[1][0] + ' ' + p.specs[1][1],
        s102: p.specs[2][1],
        s103: section.label === 'EVIERS' ? 'standard' : p.specs[1][1],
        s104: '2 ans',
      });
    }
  }
  const out = path.join(OUT, 'data.xlsx');
  await wb.xlsx.writeFile(out);
  console.log('data.xlsx     :', fs.statSync(out).size, 'bytes,', SECTIONS.reduce((n, s) => n + s.products.length, 0), 'products');
}

function buildAssets() {
  const zip = new AdmZip();
  let i = 0;
  for (const section of SECTIONS) {
    for (const p of section.products) {
      const shade = 200 - (i % 3) * 20;
      zip.addFile(p.ref + '.png', solidPng(200, 300, [shade, shade, shade + 10 > 255 ? 255 : shade + 10]));
      i++;
    }
  }
  const out = path.join(OUT, 'assets.zip');
  zip.writeZip(out);
  console.log('assets.zip    :', fs.statSync(out).size, 'bytes,', i, 'images');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await buildTemplate();
  await buildData();
  buildAssets();
  console.log('Synthetic fixtures written to', OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });

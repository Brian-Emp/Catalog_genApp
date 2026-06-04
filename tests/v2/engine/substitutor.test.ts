/**
 * Tests de substitutor.ts (generation d'ops par bloc).
 */

import path from 'path';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { findProductBlocks } from '../../../src/v2/engine/blockDetector';
import type { ProductBlock } from '../../../src/v2/engine/blockDetector';
import { detectProfileHeuristic } from '../../../src/v2/engine/profile';
import { substituteBlock } from '../../../src/v2/engine/substitutor';
import type { ExtractedPage, OpInsertText, OpEraseRect, OpDrawImage, PlanProduct } from '../../../src/v2/types';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function loadPage(name: string): ExtractedPage {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8')) as ExtractedPage;
}

const FAKE_PRODUCT: PlanProduct = {
  name: 'MITIGEUR NEW PRODUCT TEST',
  ref: 'REF-9999',
  color: 'Chromé',
  image_path: 'fake.jpg',
  specs: [
    { key: 'MECANISME', values: ['cartouche céramique Ø 35 mm'] },
    { key: 'POIGNEE', values: ['métal'] },
    { key: 'CORPS', values: ['laiton'] },
  ],
  variants: [
    { color: '#cccccc', label: 'Inox' },
    { color: '#222222', label: 'Noir' },
  ],
};

describe('substituteBlock', () => {
  it('emet 1 op insert_text pour le nom produit', () => {
    const page = loadPage('page-030-real.json');
    const profile = detectProfileHeuristic([page]);
    const blocks = findProductBlocks(page, profile);
    const ops = substituteBlock(blocks[0], FAKE_PRODUCT, {
      pageWidth: page.page_size.width,
      pageHeight: page.page_size.height,
      profile,
    });

    const nameOps = ops.filter(
      (o): o is OpInsertText => o.op === 'insert_text' && o.text === FAKE_PRODUCT.name,
    );
    expect(nameOps).toHaveLength(1);
    expect(nameOps[0].font).toContain('SemiBold');
    expect(nameOps[0].size).toBeGreaterThan(13);
  });

  it('emet un erase_rect couvrant la zone specs entiere', () => {
    const page = loadPage('page-030-real.json');
    const profile = detectProfileHeuristic([page]);
    const blocks = findProductBlocks(page, profile);
    const ops = substituteBlock(blocks[0], FAKE_PRODUCT, {
      pageWidth: page.page_size.width,
      pageHeight: page.page_size.height,
      profile,
    });

    const erases = ops.filter((o): o is OpEraseRect => o.op === 'erase_rect');
    expect(erases.length).toBeGreaterThan(0);
    // Au moins un erase couvre une zone large (>200pt) et profonde
    const bigErase = erases.find(
      (e) => e.bbox[2] - e.bbox[0] > 200 && e.bbox[3] - e.bbox[1] > 30,
    );
    expect(bigErase).toBeDefined();
  });

  it('emet des insert_text pour chaque key + value de spec', () => {
    const page = loadPage('page-030-real.json');
    const profile = detectProfileHeuristic([page]);
    const blocks = findProductBlocks(page, profile);
    const ops = substituteBlock(blocks[0], FAKE_PRODUCT, {
      pageWidth: page.page_size.width,
      pageHeight: page.page_size.height,
      profile,
    });

    const inserts = ops.filter((o): o is OpInsertText => o.op === 'insert_text');
    // Au moins : nom + colorSpan + 3 keys + 3 values = 8
    expect(inserts.length).toBeGreaterThanOrEqual(8);

    const keyInserts = inserts.filter((i) => i.text.includes('MECANISME'));
    expect(keyInserts).toHaveLength(1);
  });

  it('emet un draw_image si product.image_path + mainImageBbox', () => {
    const page = loadPage('page-030-real.json');
    const profile = detectProfileHeuristic([page]);
    const blocks = findProductBlocks(page, profile);
    // On force mainImageBbox pour tester
    blocks[0].mainImageBbox = [50, 100, 200, 250];
    const ops = substituteBlock(blocks[0], FAKE_PRODUCT, {
      pageWidth: page.page_size.width,
      pageHeight: page.page_size.height,
      profile,
    });

    const imgOps = ops.filter((o): o is OpDrawImage => o.op === 'draw_image');
    expect(imgOps).toHaveLength(1);
    expect(imgOps[0].image_path).toBe('fake.jpg');
  });

  it('emprunte la couleur du span source pour les substitutions', () => {
    const page = loadPage('page-030-real.json');
    const profile = detectProfileHeuristic([page]);
    const blocks = findProductBlocks(page, profile);
    const ops = substituteBlock(blocks[0], FAKE_PRODUCT, {
      pageWidth: page.page_size.width,
      pageHeight: page.page_size.height,
      profile,
    });

    const nameOp = ops.find(
      (o): o is OpInsertText => o.op === 'insert_text' && o.text === FAKE_PRODUCT.name,
    );
    expect(nameOp).toBeDefined();
    // Couleur recuperee de raw_spans (Catalogue A : "#231f20")
    expect(nameOp!.color).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

// ─── Tests computeImageBbox (via substituteBlock) ─────────────────────────────

/** Construit un ProductBlock minimal pour tester computeImageBbox. */
function makeBlock(overrides: Partial<ProductBlock>): ProductBlock {
  const base: ProductBlock = {
    pageNumber: 0,
    nameSpan: { text: 'NOM', bbox: [100, 50, 200, 65], font: 'SemiBold', size: 14, color: '#000000' },
    nameWrappedCount: 1,
    refSpan: null,
    colorSpan: null,
    specs: [],
    variantImages: [],
    variantSpans: [],
    mainImageBbox: null,
    yTop: 40,
    yBottom: 350,
    specsYTop: 80,
    specsYBottom: 340,
    specsXLeft: 300,
  };
  return { ...base, ...overrides };
}

const PROFILE_FAKE = {
  ribbonMargin: 20,
  headerColorFontPattern: 'Regular',
  colorRefSpacing: 10,
  colorRefSizeRange: [8, 10] as [number, number],
  nameFontPattern: 'SemiBold',
  nameSizeRange: [13, 20] as [number, number],
  bannerMinSize: 14,
  specsKeyFontPattern: 'Regular',
  specsKeySizeRange: [7, 12] as [number, number],
};

describe('computeImageBbox (via substituteBlock)', () => {
  const IMG_PRODUCT: PlanProduct = {
    name: 'TEST', ref: null, color: null, image_path: 'test.jpg', specs: [], variants: [],
  };

  it('bbox image non degeneree (x0 < x1) meme si specsXLeft <= nameSpan.bbox[0]', () => {
    // Cas template compact : colonne specs au meme X que le nom
    const block = makeBlock({ specsXLeft: 100 }); // = nameSpan.bbox[0]
    const ops = substituteBlock(block, IMG_PRODUCT, {
      pageWidth: 595, pageHeight: 842, profile: PROFILE_FAKE as Parameters<typeof substituteBlock>[2]['profile'],
    });
    const imgOp = ops.find((o): o is OpDrawImage => o.op === 'draw_image');
    expect(imgOp).toBeDefined();
    // x0 < x1 : pas de bbox degeneree
    expect(imgOp!.bbox[0]).toBeLessThan(imgOp!.bbox[2]);
  });

  it('bbox image non depassante (y1 <= block.yBottom) meme si bloc tres court', () => {
    // Cas bloc < 30pt de haut : sans clamp, yBotZone deborde hors du bloc
    const block = makeBlock({
      yTop: 100,
      yBottom: 120,  // seulement 20pt → zone utile ~14pt < 30pt min
      specsYTop: 110,
      specsYBottom: 119,
      nameSpan: { text: 'NOM', bbox: [100, 100, 200, 114], font: 'SemiBold', size: 14, color: '#000000' },
    });
    const ops = substituteBlock(block, IMG_PRODUCT, {
      pageWidth: 595, pageHeight: 842, profile: PROFILE_FAKE as Parameters<typeof substituteBlock>[2]['profile'],
    });
    const imgOp = ops.find((o): o is OpDrawImage => o.op === 'draw_image');
    expect(imgOp).toBeDefined();
    // y1 <= block.yBottom : pas de debordement hors du bloc
    expect(imgOp!.bbox[3]).toBeLessThanOrEqual(block.yBottom);
  });

  it('bbox image y0 < y1 (pas degeneree verticalement) meme sur bloc normal', () => {
    const block = makeBlock({}); // bloc standard 310pt de haut
    const ops = substituteBlock(block, IMG_PRODUCT, {
      pageWidth: 595, pageHeight: 842, profile: PROFILE_FAKE as Parameters<typeof substituteBlock>[2]['profile'],
    });
    const imgOp = ops.find((o): o is OpDrawImage => o.op === 'draw_image');
    expect(imgOp).toBeDefined();
    expect(imgOp!.bbox[1]).toBeLessThan(imgOp!.bbox[3]);
  });
});

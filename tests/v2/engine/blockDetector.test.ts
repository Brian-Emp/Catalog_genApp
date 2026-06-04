/**
 * Tests de blockDetector.ts (port find_product_blocks V1).
 * Valide sur fixtures reelles du catalogue Catalogue A.
 */

import path from 'path';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { findProductBlocks } from '../../../src/v2/engine/blockDetector';
import { detectProfileHeuristic } from '../../../src/v2/engine/profile';
import type { ExtractedPage } from '../../../src/v2/types';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function loadPage(name: string): ExtractedPage {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8')) as ExtractedPage;
}

describe('findProductBlocks', () => {
  it('trouve les 3 fiches produit verticales d\'une page Catalogue A (page 30)', () => {
    const page = loadPage('page-030-real.json');
    const profile = detectProfileHeuristic([page]);
    const blocks = findProductBlocks(page, profile);

    expect(blocks).toHaveLength(3);
    const names = blocks.map((b) => b.nameSpan.text.trim());
    expect(names).toEqual([
      'MITIGEUR ÉVIER NEWBURY',
      'MITIGEUR ÉVIER EDINBURGH',
      'MITIGEUR ÉVIER TULSA',
    ]);

    // Tous ont au moins 5 specs (les fiches Catalogue A ont MECANISME, ÉCONOMIE, POIGNÉE, CORPS, BEC, EMBASE...)
    for (const b of blocks) {
      expect(b.specs.length).toBeGreaterThanOrEqual(5);
      expect(b.colorSpan?.text.trim()).toBe('Chromé');
    }
  });

  it('trouve les 3 fiches lavabo (page 80) avec colorSpan distincts', () => {
    const page = loadPage('page-080-real.json');
    const profile = detectProfileHeuristic([page]);
    const blocks = findProductBlocks(page, profile);

    expect(blocks).toHaveLength(3);
    const names = blocks.map((b) => b.nameSpan.text.trim());
    expect(names).toContain('MITIGEUR LAVABO DUNEDIN');
    expect(names).toContain('MITIGEUR LAVABO KOCHI');
    expect(names).toContain('MITIGEUR LAVABO OOLONG');

    const colors = blocks.map((b) => b.colorSpan?.text.trim());
    expect(colors).toContain('Chromé-noir');
  });

  it('retourne 0 blocs sur une page intercalaire (page 16 : 3 bandeaux sans specs)', () => {
    const page = loadPage('page-016-real.json');
    // Profile detecte depuis une page-fiche-produit (sinon retour defaults
    // et page 16 n'a pas de noms candidats valides non plus)
    const profile = detectProfileHeuristic([loadPage('page-030-real.json')]);
    const blocks = findProductBlocks(page, profile);
    expect(blocks).toHaveLength(0);
  });

  it('chaque bloc a un yTop/yBottom non degenere', () => {
    const page = loadPage('page-030-real.json');
    const profile = detectProfileHeuristic([page]);
    const blocks = findProductBlocks(page, profile);

    for (const b of blocks) {
      expect(b.yBottom).toBeGreaterThan(b.yTop);
      // Largeur de bloc raisonnable (au moins 100pt)
      expect(b.yBottom - b.yTop).toBeGreaterThan(50);
    }
  });

  it('detecte les specs avec values inline ET continuation', () => {
    const page = loadPage('page-030-real.json');
    const profile = detectProfileHeuristic([page]);
    const blocks = findProductBlocks(page, profile);

    const newbury = blocks.find((b) => b.nameSpan.text.includes('NEWBURY'));
    expect(newbury).toBeDefined();
    // Au moins une spec doit avoir au moins une value
    const withValues = newbury!.specs.filter((s) => s.values.length > 0);
    expect(withValues.length).toBeGreaterThan(3);
  });
});

describe('findProductBlocks — variantes via palette couleurs', () => {
  // Quand le template utilise une font non standard pour les labels de
  // variantes, le filtre font echoue mais isCommonColor (palette) recupere.
  function makePage(): ExtractedPage {
    return {
      page_number: 1,
      page_size: { width: 595, height: 842 },
      slots: [],
      raw_images: [],
      raw_spans: [
        // Nom produit
        {
          text: 'MITIGEUR VAR',
          bbox: [60, 100, 250, 120],
          font: 'Almanach-SemiBold',
          size: 16,
          color: '#000000',
        },
        // Color + Ref header (font standard)
        {
          text: 'Chromé',
          bbox: [60, 125, 130, 140],
          font: 'Almanach-Medium',
          size: 11,
          color: '#000000',
        },
        {
          text: 'AB1234',
          bbox: [140, 125, 210, 140],
          font: 'Almanach-Regular',
          size: 11,
          color: '#000000',
        },
        // Variantes en font NON-STANDARD ("Italic") mais texte de la palette
        {
          text: 'Noir',
          bbox: [60, 160, 100, 175],
          font: 'Almanach-Italic',
          size: 11,
          color: '#000000',
        },
        {
          text: 'Doré',
          bbox: [110, 160, 150, 175],
          font: 'Almanach-Italic',
          size: 11,
          color: '#000000',
        },
        // Bruit : texte non-couleur en italique → ne doit pas matcher
        {
          text: 'Note importante',
          bbox: [60, 200, 200, 215],
          font: 'Almanach-Italic',
          size: 11,
          color: '#000000',
        },
        // Spec key + value pour valider le block
        {
          text: 'MATIÈRE :',
          bbox: [290, 200, 360, 214],
          font: 'Almanach-Medium',
          size: 11,
          color: '#000000',
        },
        {
          text: 'Inox',
          bbox: [365, 200, 410, 214],
          font: 'Almanach-Light',
          size: 11,
          color: '#000000',
        },
      ],
    };
  }

  it('capture labels variantes via isCommonColor meme avec font non standard', () => {
    const page = makePage();
    const profile = detectProfileHeuristic([page]);
    profile.nameFontPattern = 'SemiBold';
    profile.keyFontPattern = 'Medium';
    profile.valueFontPattern = 'Light';
    profile.headerRefFontPattern = 'Regular';
    profile.headerColorFontPattern = 'Medium';
    profile.specsXMin = 280;
    profile.nameXMax = 260;
    profile.nameSizeRange = [14, 18];
    profile.colorRefSizeRange = [10, 13];

    const blocks = findProductBlocks(page, profile);
    expect(blocks).toHaveLength(1);
    const labels = blocks[0].variantSpans.map((s) => s.text);
    expect(labels).toContain('Noir');
    expect(labels).toContain('Doré');
    // "Note importante" est en italique mais PAS dans la palette → ne doit
    // pas matcher (anti faux positif texte libre).
    expect(labels).not.toContain('Note importante');
  });
});

describe('findProductBlocks — continuation multi-ligne', () => {
  // Construit une page synthetique avec UNE fiche produit dont une spec a
  // une valeur wrappee sur 3 lignes. Verifie qu'on capture les 3 lignes.
  function makePage(): ExtractedPage {
    return {
      page_number: 1,
      page_size: { width: 595, height: 842 },
      slots: [],
      raw_images: [],
      raw_spans: [
        // Nom produit (gauche, SemiBold, size 16)
        {
          text: 'MITIGEUR TEST',
          bbox: [60, 100, 250, 120],
          font: 'Almanach-SemiBold',
          size: 16,
          color: '#000000',
        },
        // Header ref (color + ref sous le nom)
        {
          text: 'Chromé',
          bbox: [60, 125, 130, 140],
          font: 'Almanach-Medium',
          size: 11,
          color: '#000000',
        },
        {
          text: 'AB1234',
          bbox: [140, 125, 210, 140],
          font: 'Almanach-Regular',
          size: 11,
          color: '#000000',
        },
        // 3 specs : 1 simple, 1 avec value 3-lignes, 1 simple en dessous
        // Spec 1 : MECANISME : Ceramique (inline)
        {
          text: 'MECANISME :',
          bbox: [290, 200, 360, 214],
          font: 'Almanach-Medium',
          size: 11,
          color: '#000000',
        },
        {
          text: 'Ceramique 35mm',
          bbox: [365, 200, 480, 214],
          font: 'Almanach-Light',
          size: 11,
          color: '#000000',
        },
        // Spec 2 : GARANTIE : 5 ans + 2 lignes de continuation
        {
          text: 'GARANTIE :',
          bbox: [290, 230, 360, 244],
          font: 'Almanach-Medium',
          size: 11,
          color: '#000000',
        },
        {
          text: '5 ans piece et main',
          bbox: [365, 230, 510, 244],
          font: 'Almanach-Light',
          size: 11,
          color: '#000000',
        },
        // Continuation ligne 2 (alignee X sur key, juste sous la baseline)
        {
          text: "d'oeuvre dans le reseau",
          bbox: [290, 244, 510, 258],
          font: 'Almanach-Light',
          size: 11,
          color: '#000000',
        },
        // Continuation ligne 3
        {
          text: 'Catalogue A partenaire',
          bbox: [290, 258, 510, 272],
          font: 'Almanach-Light',
          size: 11,
          color: '#000000',
        },
        // Spec 3 : ECONOMIE : 50% (apres la garantie wrappée → ne doit pas
        // etre absorbée comme continuation de GARANTIE)
        {
          text: 'ECONOMIE :',
          bbox: [290, 290, 360, 304],
          font: 'Almanach-Medium',
          size: 11,
          color: '#000000',
        },
        {
          text: '50%',
          bbox: [365, 290, 400, 304],
          font: 'Almanach-Light',
          size: 11,
          color: '#000000',
        },
      ],
    };
  }

  it('capture les 3 lignes de la spec GARANTIE wrappée', () => {
    const page = makePage();
    const profile = detectProfileHeuristic([page]);
    // Force profile coherent avec la fixture (le synthetique n'a pas
    // assez de keys pour heuristic, on patche manuellement).
    profile.nameFontPattern = 'SemiBold';
    profile.keyFontPattern = 'Medium';
    profile.valueFontPattern = 'Light';
    profile.headerRefFontPattern = 'Regular';
    profile.headerColorFontPattern = 'Medium';
    profile.specsXMin = 280;
    profile.nameXMax = 260;
    profile.nameSizeRange = [14, 18];
    profile.specContinuationXTolerance = 5;
    profile.specContinuationYExtra = 4;

    const blocks = findProductBlocks(page, profile);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];

    const garantie = block.specs.find((s) => s.key.text.includes('GARANTIE'));
    expect(garantie).toBeDefined();
    // 1 inline + 2 continuation = 3 values
    expect(garantie!.values).toHaveLength(3);
    const texts = garantie!.values.map((v) => v.text);
    expect(texts[0]).toContain('5 ans');
    expect(texts[1]).toContain("d'oeuvre");
    expect(texts[2]).toContain('partenaire');

    // ECONOMIE ne doit PAS etre absorbée par la continuation de GARANTIE
    const eco = block.specs.find((s) => s.key.text.includes('ECONOMIE'));
    expect(eco).toBeDefined();
    expect(eco!.values).toHaveLength(1);
    expect(eco!.values[0].text).toBe('50%');
  });
});

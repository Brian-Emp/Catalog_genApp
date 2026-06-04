/**
 * Tests du filtre code-barres/pictogrammes dans blockDetector.
 *
 * Le filtre `looksLikeBarcode` n'est pas exporté directement mais son
 * effet est observable via findProductBlocks : un span dont le texte
 * ressemble à un code-barre ne devient pas un name candidate.
 *
 * Cas couverts :
 *   - EAN-13 imprimé ("&:DCPNLA=UWWX[[:") — Catalogue C / Catalogue B
 *   - Ref nue chiffres uniquement ("3325310022366")
 *   - Pictogrammes / symboles ("■▶◀●")
 *   - Faux positifs à éviter : noms produits courts ("PER", "NF")
 */
import { describe, it, expect } from 'vitest';
import { findProductBlocks } from '../../../src/v2/engine/blockDetector';
import { DEFAULT_PROFILE } from '../../../src/v2/engine/profile';
import type { ExtractedPage, TextSpan } from '../../../src/v2/types';

function makeSpan(text: string, x: number, y: number, size = 16): TextSpan {
  return {
    text,
    bbox: [x, y, x + text.length * 8, y + size],
    font: 'Helvetica-SemiBold',
    size,
    color: '#000000',
  };
}

function makePage(spans: TextSpan[]): ExtractedPage {
  return {
    page_number: 1,
    page_size: { width: 595, height: 842 },
    slots: [],
    raw_spans: spans,
    raw_images: [],
  };
}

describe('blockDetector — filtre code-barres', () => {
  it('exclut un EAN-13 imprimé ("&:DCPNLA=UWWX[[:") du name candidate', () => {
    const page = makePage([
      // Vrai nom produit
      makeSpan('BARRE DOUCHE TAMARI 60 CHR BT', 100, 200),
      // EAN-13 imprimé (chars spéciaux dominants)
      makeSpan('&:DCPNLA=UWWX[[:', 100, 220),
      // Ref + spec en dessous (pour que hasRealContent valide le bloc)
      makeSpan('Chromé', 100, 240, 11),
      makeSpan('4027841', 150, 240, 11),
      makeSpan('MATIÈRE :', 300, 280, 11),
      makeSpan('Inox', 400, 280, 11),
    ]);
    const blocks = findProductBlocks(page, {
      ...DEFAULT_PROFILE,
      nameFontPattern: 'SemiBold',
      nameXMax: 400,
      specsXMin: 280,
    });
    // Le seul nom valide est "BARRE DOUCHE TAMARI 60 CHR BT", pas l'EAN
    const names = blocks.map((b) => b.nameSpan.text.trim());
    expect(names).not.toContain('&:DCPNLA=UWWX[[:');
  });

  it('exclut une ref nue chiffres uniquement ("3325310022366")', () => {
    const page = makePage([
      makeSpan('Mitigeur Cuisine', 100, 200),
      makeSpan('3325310022366', 100, 220),
      makeSpan('Chromé', 100, 240, 11),
      makeSpan('123456', 150, 240, 11),
      makeSpan('MATIÈRE :', 300, 280, 11),
      makeSpan('Laiton', 400, 280, 11),
    ]);
    const blocks = findProductBlocks(page, {
      ...DEFAULT_PROFILE,
      nameFontPattern: 'SemiBold',
      nameXMax: 400,
      specsXMin: 280,
    });
    const names = blocks.map((b) => b.nameSpan.text.trim());
    expect(names).not.toContain('3325310022366');
  });

  it('exclut pictogrammes / symboles uniquement', () => {
    const page = makePage([
      makeSpan('■▶◀●', 100, 200),
      makeSpan('Mitigeur Cuisine', 100, 230),
      makeSpan('Chromé', 100, 250, 11),
      makeSpan('4027841', 150, 250, 11),
      makeSpan('MATIÈRE :', 300, 290, 11),
      makeSpan('Laiton', 400, 290, 11),
    ]);
    const blocks = findProductBlocks(page, {
      ...DEFAULT_PROFILE,
      nameFontPattern: 'SemiBold',
      nameXMax: 400,
      specsXMin: 280,
    });
    const names = blocks.map((b) => b.nameSpan.text.trim());
    expect(names).not.toContain('■▶◀●');
  });

  it('garde les vrais noms produits courts (PER, NF, etc.)', () => {
    const page = makePage([
      makeSpan('PER', 100, 200),
      makeSpan('Chromé', 100, 220, 11),
      makeSpan('4027841', 150, 220, 11),
      makeSpan('MATIÈRE :', 300, 260, 11),
      makeSpan('Cuivre', 400, 260, 11),
    ]);
    const blocks = findProductBlocks(page, {
      ...DEFAULT_PROFILE,
      nameFontPattern: 'SemiBold',
      nameXMax: 400,
      specsXMin: 280,
    });
    // PER doit être accepté (3 lettres, 100% alpha)
    expect(blocks.some((b) => b.nameSpan.text.trim() === 'PER')).toBe(true);
  });

  it('garde les noms produit avec chiffres modérés (ECOP 100, BARRE 70)', () => {
    const page = makePage([
      makeSpan('ECOP 100', 100, 200),
      makeSpan('Chromé', 100, 220, 11),
      makeSpan('4027841', 150, 220, 11),
      makeSpan('MATIÈRE :', 300, 260, 11),
      makeSpan('Inox', 400, 260, 11),
    ]);
    const blocks = findProductBlocks(page, {
      ...DEFAULT_PROFILE,
      nameFontPattern: 'SemiBold',
      nameXMax: 400,
      specsXMin: 280,
    });
    // ECOP 100 = 4 lettres + 3 chiffres + 1 espace = 7/7 alpha-numérique
    // 4 lettres sur 7 chars non-ws = 57% > 50% → gardé
    expect(blocks.some((b) => b.nameSpan.text.trim().includes('ECOP'))).toBe(true);
  });
});

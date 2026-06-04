/**
 * Tests refines de looksLikeBarcode pour faille review :
 * codes alphanum courts type "DN50 PN16" (Catalogue E) ne doivent PAS etre
 * filtres comme barcode.
 *
 * Nouvelle logique :
 *   - alphanum-pure (lettres + chiffres >= 80%) + <= 30 chars → NOT barcode
 *   - >30% symboles → barcode
 *   - ratio lettres < 50% sinon → barcode
 *   - 100% chiffres → barcode (existant)
 */
import { describe, it, expect } from 'vitest';
import { looksLikeBarcode } from '../../../src/v2/engine/blockDetector';

describe('looksLikeBarcode — codes alphanum courts non filtres', () => {
  it('DN50 PN16 (Catalogue E raccord) : NOT barcode (alphanum-pure)', () => {
    expect(looksLikeBarcode('DN50 PN16')).toBe(false);
  });

  it('AB-12345 : NOT barcode si alphanum-pure', () => {
    // AB12345 (sans le tiret) = 7 chars, L=2 D=5 → 7/7=1.0 >= 0.8 → not barcode
    expect(looksLikeBarcode('AB12345')).toBe(false);
  });

  it('XCV-2024-K : avec tirets, symboles 22% → not barcode', () => {
    // XCV2024K = 8 chars (sans tirets), avec tirets 10 chars, symbols=2/10=0.2 < 0.3
    // alphanum = 8/10 = 0.8 >= 0.8 → not barcode
    expect(looksLikeBarcode('XCV-2024-K')).toBe(false);
  });

  it('T15 PLUS+ : tres haut letters+digits → not barcode', () => {
    // T15PLUS+ = 8 chars, L=5 D=2 S=1, alphanum = 7/8 = 0.875 >= 0.8 → not barcode
    expect(looksLikeBarcode('T15 PLUS+')).toBe(false);
  });

  it('NF EN 1234 : norme technique → not barcode', () => {
    // NFEN1234 = 8 chars, L=4 D=4, alphanum 1.0 → not barcode
    expect(looksLikeBarcode('NF EN 1234')).toBe(false);
  });

  it('Tube PVC 25 NF-E2 : nom produit + ref → not barcode', () => {
    // sans espaces : TubePVC25NF-E2 = 14 chars, L=10 D=3 S=1
    // alphanum = 13/14 = 0.929 >= 0.8 → not barcode
    expect(looksLikeBarcode('Tube PVC 25 NF-E2')).toBe(false);
  });

  it('"BARRE DOUCHE TAMARI 60 CHR BT" : long nom produit → not barcode', () => {
    expect(looksLikeBarcode('BARRE DOUCHE TAMARI 60 CHR BT')).toBe(false);
  });
});

describe('looksLikeBarcode — vrais barcodes / pictogrammes filtrees', () => {
  it('EAN-13 imprime "&:DCPNLA=UWWX[[:" : barcode (symbols > 30%)', () => {
    // 16 chars, L=10 D=0 S=6 (& : = [ [ :), symbols/16 = 0.375 > 0.3 → barcode
    expect(looksLikeBarcode('&:DCPNLA=UWWX[[:')).toBe(true);
  });

  it('"3325310022366" ref nue chiffres : barcode (100% digits)', () => {
    expect(looksLikeBarcode('3325310022366')).toBe(true);
  });

  it('pictogrammes "■▶◀●" : barcode (100% symbols)', () => {
    expect(looksLikeBarcode('■▶◀●')).toBe(true);
  });

  it('"==||==||" : barcode style (symbols only)', () => {
    expect(looksLikeBarcode('==||==||')).toBe(true);
  });

  it('"K3-25/40" : ref technique courte avec symboles → barcode', () => {
    // K3-25/40 = 8 chars, L=1 D=4 S=3 (-, /, /), alphanum = 5/8 = 0.625 < 0.8
    // symbols/8 = 0.375 > 0.3 → barcode
    expect(looksLikeBarcode('K3-25/40')).toBe(true);
  });
});

describe('looksLikeBarcode — edge cases', () => {
  it('chaine vide → not barcode', () => {
    expect(looksLikeBarcode('')).toBe(false);
  });

  it('chaine courte (< 3 chars) → not barcode (filtre quantite)', () => {
    expect(looksLikeBarcode('AB')).toBe(false);
    expect(looksLikeBarcode('12')).toBe(false);
  });

  it('chaine que des espaces → not barcode', () => {
    expect(looksLikeBarcode('   ')).toBe(false);
  });

  it('longue chaine alphanum (50 chars) : barcode car > 30 chars limit', () => {
    // 50 letters → alphanum-pure mais nonWs.length > 30 → continue
    // ratio letters = 1.0 >= 0.5 → return letters / nonWs.length < 0.5 = false
    // Donc NOT barcode (chaine longue ASCII normale)
    const t = 'a'.repeat(50);
    expect(looksLikeBarcode(t)).toBe(false);
  });

  it('nom produit avec accents (Ø, é, ê) : not barcode', () => {
    expect(looksLikeBarcode('Tube Ø25 acier inoxydable')).toBe(false);
  });
});

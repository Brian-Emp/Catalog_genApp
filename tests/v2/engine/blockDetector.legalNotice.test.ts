/**
 * Tests looksLikeLegalNotice — détection mentions légales pour eviter
 * contamination specs Regular.
 *
 * Faille review : un span "© 2024 Marque, tous droits reserves" en Regular
 * dans la zone specs etait attribue a une spec comme value. Solution :
 * filtre conservateur sur marqueurs typographiques + patterns notice.
 *
 * Critere zero-regression : ne JAMAIS filter une vraie value produit.
 */
import { describe, it, expect } from 'vitest';
import { looksLikeLegalNotice } from '../../../src/v2/engine/blockDetector';

describe('looksLikeLegalNotice — mentions filtrees', () => {
  it('symbole copyright © → notice', () => {
    expect(looksLikeLegalNotice('© 2024 Marque SA')).toBe(true);
    expect(looksLikeLegalNotice('Copyright © 2024')).toBe(true);
  });

  it('symbole registered ® → notice', () => {
    expect(looksLikeLegalNotice('Brand®')).toBe(true);
    expect(looksLikeLegalNotice('NF®')).toBe(true);
  });

  it('symbole trademark ™ → notice', () => {
    expect(looksLikeLegalNotice('Product™')).toBe(true);
  });

  it('phrase "Tous droits réservés"', () => {
    expect(looksLikeLegalNotice('Tous droits réservés')).toBe(true);
    expect(looksLikeLegalNotice('All rights reserved')).toBe(true);
  });

  it('phrase "Document non contractuel"', () => {
    expect(looksLikeLegalNotice('Document non contractuel - sous reserve d erreurs')).toBe(true);
  });

  it('phrase "Crédit photo"', () => {
    expect(looksLikeLegalNotice('Crédit photo : Studio XYZ')).toBe(true);
    expect(looksLikeLegalNotice('Photo credit: ABC')).toBe(true);
  });

  it('phrase tres longue (>80 chars, >=8 mots) → notice', () => {
    const long = 'Les informations contenues dans ce document sont fournies a titre indicatif et susceptibles de modifications';
    expect(looksLikeLegalNotice(long)).toBe(true);
  });
});

describe('looksLikeLegalNotice — vraies values produit (zero regression)', () => {
  it('value courte numerique → NOT notice', () => {
    expect(looksLikeLegalNotice('25 mm')).toBe(false);
    expect(looksLikeLegalNotice('2 kg')).toBe(false);
    expect(looksLikeLegalNotice('5 ans')).toBe(false);
  });

  it('value materiau → NOT notice', () => {
    expect(looksLikeLegalNotice('Inox')).toBe(false);
    expect(looksLikeLegalNotice('Acier inoxydable')).toBe(false);
    expect(looksLikeLegalNotice('PVC')).toBe(false);
  });

  it('value couleur → NOT notice', () => {
    expect(looksLikeLegalNotice('Chromé')).toBe(false);
    expect(looksLikeLegalNotice('Noir mat')).toBe(false);
  });

  it('value description moyenne (sans ©, < 80 chars) → NOT notice', () => {
    expect(looksLikeLegalNotice('Pommeau de douche fixe à 5 jets de massage')).toBe(false);
  });

  it('ref produit → NOT notice', () => {
    expect(looksLikeLegalNotice('1234567')).toBe(false);
    expect(looksLikeLegalNotice('AB-12345')).toBe(false);
  });

  it('norme technique sans © → NOT notice', () => {
    expect(looksLikeLegalNotice('Norme NF EN 1234')).toBe(false);
    expect(looksLikeLegalNotice('Conforme CE')).toBe(false);
  });

  it('phrase moyenne 5-7 mots → NOT notice', () => {
    expect(looksLikeLegalNotice('Pour usage interieur et exterieur')).toBe(false);
    expect(looksLikeLegalNotice('Garantie 2 ans piece et main d oeuvre')).toBe(false);
  });

  it('chaine vide → NOT notice', () => {
    expect(looksLikeLegalNotice('')).toBe(false);
    expect(looksLikeLegalNotice('   ')).toBe(false);
  });
});

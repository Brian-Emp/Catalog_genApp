/**
 * Tests des patterns REF_RE / YEAR_RE / DATE_RE utilises par
 * isPureIntercalaire dans engineOrchestrator.
 *
 * Faux positif identifie en review : "28062024" (date JJ/MM/AAAA concatenee)
 * passe REF_RE mais YEAR_RE ne la filtre pas (que 4 chiffres). Sans DATE_RE,
 * une page "Loi du 28/06/2024" est classee "produit deguisee" → exclue de
 * la re-attribution intercalaire → page d'identite perdue.
 */
import { describe, it, expect } from 'vitest';

// Patterns dupliques depuis engineOrchestrator.ts (pas exportes pour eviter
// de polluer l API publique). Si ces tests cassent, sync avec le source.
const REF_RE = /\b(?:\d{4,7}\s+)?\d{6,8}\b/;
const YEAR_RE = /^(?:19|20)\d{2}$/;
const DATE_RE = /\b(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)\d{2}\b/;

describe('REF_RE / YEAR_RE / DATE_RE patterns', () => {
  describe('REF_RE - codes 6-8 chiffres', () => {
    it('match codes 6 chiffres standalone', () => {
      expect(REF_RE.test('002236')).toBe(true);
      expect(REF_RE.test('123456')).toBe(true);
    });

    it('match codes 7 chiffres standalone', () => {
      expect(REF_RE.test('1234567')).toBe(true);
      expect(REF_RE.test('4027841')).toBe(true);
    });

    it('match codes 8 chiffres', () => {
      expect(REF_RE.test('12345678')).toBe(true);
    });

    it('match prefixe ERP + ref', () => {
      expect(REF_RE.test('304740 4061296')).toBe(true);
      expect(REF_RE.test('1234 567890')).toBe(true);
    });

    it('rejette codes < 6 chiffres', () => {
      expect(REF_RE.test('12345')).toBe(false);
      expect(REF_RE.test('123')).toBe(false);
    });

    it('match dans phrase ("Ref 1234567 disponible")', () => {
      expect(REF_RE.test('Ref 1234567 disponible')).toBe(true);
    });
  });

  describe('YEAR_RE - annees 1900-2099 standalone', () => {
    it('match annee 4 chiffres', () => {
      expect(YEAR_RE.test('2024')).toBe(true);
      expect(YEAR_RE.test('1999')).toBe(true);
    });

    it('rejette annee hors plage', () => {
      expect(YEAR_RE.test('1899')).toBe(false);
      expect(YEAR_RE.test('2100')).toBe(false);
    });

    it('rejette annee dans phrase (anchor strict)', () => {
      expect(YEAR_RE.test('en 2024')).toBe(false);
      expect(YEAR_RE.test('2024 edition')).toBe(false);
    });

    it('rejette nombres > 4 chiffres', () => {
      expect(YEAR_RE.test('20245')).toBe(false);
      expect(YEAR_RE.test('99999')).toBe(false);
    });
  });

  describe('DATE_RE - dates JJMMAAAA concatenees', () => {
    it('match dates valides JJMMAAAA', () => {
      expect(DATE_RE.test('28062024')).toBe(true); // 28/06/2024
      expect(DATE_RE.test('01012024')).toBe(true); // 01/01/2024
      expect(DATE_RE.test('31122099')).toBe(true); // 31/12/2099
      expect(DATE_RE.test('15071987')).toBe(true); // 15/07/1987
    });

    it('rejette jours invalides', () => {
      expect(DATE_RE.test('00062024')).toBe(false); // jour 00
      expect(DATE_RE.test('32062024')).toBe(false); // jour 32
      expect(DATE_RE.test('99062024')).toBe(false); // jour 99
    });

    it('rejette mois invalides', () => {
      expect(DATE_RE.test('28002024')).toBe(false); // mois 00
      expect(DATE_RE.test('28132024')).toBe(false); // mois 13
      expect(DATE_RE.test('28992024')).toBe(false); // mois 99
    });

    it('rejette annees hors plage 19xx/20xx', () => {
      expect(DATE_RE.test('28061899')).toBe(false);
      expect(DATE_RE.test('28062100')).toBe(false);
      expect(DATE_RE.test('28061000')).toBe(false);
    });

    it('rejette codes ref qui ressemblent par hasard a une date', () => {
      // 12345678 : jour 12 OK, mois 34 invalid → pas une date, devra etre traite comme ref
      expect(DATE_RE.test('12345678')).toBe(false);
      // 99999999 : jour 99 invalid → pas une date
      expect(DATE_RE.test('99999999')).toBe(false);
    });

    it('match dans phrase ("Loi du 28062024 - Code de la consommation")', () => {
      expect(DATE_RE.test('Loi du 28062024 - Code')).toBe(true);
    });
  });

  describe('Synergie : pages legales correctement filtrees', () => {
    it('"28062024" : DATE_RE match → filtre avant REF_RE', () => {
      // Simule le flow isPureIntercalaire
      const t = '28062024';
      const isYear = YEAR_RE.test(t);
      const isDate = DATE_RE.test(t);
      const isRef = REF_RE.test(t);
      expect(isYear).toBe(false); // 8 chiffres ≠ 4
      expect(isDate).toBe(true); // OUI date valide
      expect(isRef).toBe(true); // sans DATE_RE filter, on traiterait en ref
      // Conclusion : on doit filtrer DATE_RE AVANT REF_RE
    });

    it('"4027841" (ref Catalogue A) : DATE_RE no match → traite en ref', () => {
      const t = '4027841';
      expect(YEAR_RE.test(t)).toBe(false); // 7 chiffres
      expect(DATE_RE.test(t)).toBe(false); // 7 chiffres (8 requis)
      expect(REF_RE.test(t)).toBe(true); // OUI ref Catalogue A valide
    });

    it('"002236" (ref Catalogue C) : DATE_RE no match → traite en ref', () => {
      const t = '002236';
      expect(DATE_RE.test(t)).toBe(false);
      expect(REF_RE.test(t)).toBe(true);
    });
  });
});

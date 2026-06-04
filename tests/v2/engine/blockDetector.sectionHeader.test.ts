/**
 * Tests looksLikeSectionHeader — exclusion des titres de section qui
 * ressemblent a des noms produit. Multi-langue FR/EN/DE/ES.
 *
 * Faille Catalogue C : "CHECK-LIST ACCESSOIRES" devenait un 4e bloc produit
 * substitue par accident.
 */
import { describe, it, expect } from 'vitest';
// Le filtre est interne au blockDetector ; on teste indirectement via
// findProductBlocks (test integration) + on duplique la regex ici pour
// figer le comportement attendu.

const FR_RE = /^(?:CHECK-?LIST|LES\s*\+|OPTIONS?|ACCESSOIRES?|CARACT[ÉE]RISTIQUES|GAMMES?|NOS\s+(?:MARQUES|GAMMES|PRODUITS|SOLUTIONS)|BIEN\s+CHOISIR|COMMENT\s+CHOISIR|CONSEILS?|RÉCAPITULATIF|FOURNIS|CONSEILL[ÉE]S|INFOS?\s+PRODUITS?|DESCRIPTION)(?=$|\s|[^A-Z])/i;
const EN_RE = /^(?:CHECKLIST|ACCESSORIES|OPTIONS?|FEATURES?|PRODUCT\s+(?:HIGHLIGHTS|INFO|DETAILS)|HOW\s+TO\s+CHOOSE|CHOOSE\s+YOUR|TIPS?|SPECIFICATIONS?|INCLUDED|SUPPLIED|HIGHLIGHTS)(?=$|\s|[^A-Z])/i;
const DE_RE = /^(?:ZUBEHÖR|OPTIONEN?|EIGENSCHAFTEN|TIPPS?|MERKMALE|PRODUKTINFO|TECHNISCHE\s+DATEN)(?=$|\s|[^A-Z])/i;
const ES_RE = /^(?:ACCESORIOS?|OPCIONES?|CARACTER[ÍI]STICAS|VENTAJAS|CONSEJOS?|DETALLES|INCLUIDO)(?=$|\s|[^A-Z])/i;

function looksLikeSectionHeader(text: string): boolean {
  const t = text.trim().toUpperCase();
  return FR_RE.test(t) || EN_RE.test(t) || DE_RE.test(t) || ES_RE.test(t);
}

describe('looksLikeSectionHeader — patterns multi-langue', () => {
  describe('FR', () => {
    it('CHECK-LIST ACCESSOIRES → true', () => {
      expect(looksLikeSectionHeader('CHECK-LIST ACCESSOIRES')).toBe(true);
    });
    it('LES + PRODUITS → true', () => {
      expect(looksLikeSectionHeader('LES + PRODUITS')).toBe(true);
    });
    it('ACCESSOIRES → true', () => {
      expect(looksLikeSectionHeader('ACCESSOIRES')).toBe(true);
    });
    it('CARACTÉRISTIQUES → true (accent)', () => {
      expect(looksLikeSectionHeader('CARACTÉRISTIQUES')).toBe(true);
      expect(looksLikeSectionHeader('CARACTERISTIQUES')).toBe(true);
    });
    it('NOS MARQUES → true', () => {
      expect(looksLikeSectionHeader('NOS MARQUES')).toBe(true);
    });
    it('OPTIONS / Options → true', () => {
      expect(looksLikeSectionHeader('OPTIONS')).toBe(true);
      expect(looksLikeSectionHeader('Options')).toBe(true);
    });
    it('FOURNIS / CONSEILLÉS → true', () => {
      expect(looksLikeSectionHeader('FOURNIS')).toBe(true);
      expect(looksLikeSectionHeader('CONSEILLÉS')).toBe(true);
    });
  });

  describe('EN', () => {
    it('CHECKLIST → true', () => {
      expect(looksLikeSectionHeader('CHECKLIST')).toBe(true);
    });
    it('ACCESSORIES → true', () => {
      expect(looksLikeSectionHeader('ACCESSORIES')).toBe(true);
    });
    it('PRODUCT HIGHLIGHTS → true', () => {
      expect(looksLikeSectionHeader('PRODUCT HIGHLIGHTS')).toBe(true);
    });
    it('HOW TO CHOOSE → true', () => {
      expect(looksLikeSectionHeader('HOW TO CHOOSE YOUR PUMP')).toBe(true);
    });
  });

  describe('DE', () => {
    it('ZUBEHÖR → true', () => {
      expect(looksLikeSectionHeader('ZUBEHÖR')).toBe(true);
    });
    it('TECHNISCHE DATEN → true', () => {
      expect(looksLikeSectionHeader('TECHNISCHE DATEN')).toBe(true);
    });
  });

  describe('ES', () => {
    it('ACCESORIOS → true', () => {
      expect(looksLikeSectionHeader('ACCESORIOS')).toBe(true);
    });
    it('CARACTERÍSTICAS → true', () => {
      expect(looksLikeSectionHeader('CARACTERISTICAS')).toBe(true);
    });
  });

  describe('Anti-faux-positifs (vrais noms produit)', () => {
    it('ECOP 100 → false', () => {
      expect(looksLikeSectionHeader('ECOP 100')).toBe(false);
    });
    it('MITIGEUR CHROMÉ → false', () => {
      expect(looksLikeSectionHeader('MITIGEUR CHROMÉ')).toBe(false);
    });
    it('BARRE DOUCHE TAMARI 60 → false', () => {
      expect(looksLikeSectionHeader('BARRE DOUCHE TAMARI 60')).toBe(false);
    });
    it('Pompe Inox → false', () => {
      expect(looksLikeSectionHeader('Pompe Inox')).toBe(false);
    });
  });
});

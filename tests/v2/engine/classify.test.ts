/**
 * Tests classifyPage : kind inference avec keywords multilingues.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyPage,
  isRealSectionBannerLabel,
  PAGE_REF_INLINE_RE,
} from '../../../src/v2/engine/classify';
import { DEFAULT_PROFILE } from '../../../src/v2/engine/profile';
import type { ExtractedPage, TextSpan } from '../../../src/v2/types';

function span(text: string, y = 50): TextSpan {
  return {
    text,
    bbox: [50, y, 200, y + 14],
    font: 'Almanach-Regular',
    size: 12,
    color: '#000000',
  };
}

function makePage(spans: TextSpan[]): ExtractedPage {
  return {
    page_number: 0,
    page_size: { width: 595, height: 842 },
    slots: [],
    raw_spans: spans,
    raw_images: [],
  };
}

describe('classifyPage keywords multilingues', () => {
  it('FR : "Sommaire" → toc', () => {
    const c = classifyPage(makePage([span('Sommaire')]), DEFAULT_PROFILE);
    expect(c.kind).toBe('toc');
  });

  it('FR : "Cahier technique" → tech (drop zone produit, audit #8)', () => {
    const c = classifyPage(
      makePage([span('Cahier technique des produits')]),
      DEFAULT_PROFILE,
    );
    expect(c.kind).toBe('tech');
  });

  it('EN : "Table of contents" → toc', () => {
    const c = classifyPage(makePage([span('Table of contents')]), DEFAULT_PROFILE);
    expect(c.kind).toBe('toc');
  });

  it('DE : "Inhaltsverzeichnis" → toc', () => {
    const c = classifyPage(makePage([span('Inhaltsverzeichnis')]), DEFAULT_PROFILE);
    expect(c.kind).toBe('toc');
  });

  it('ES : "Tabla de contenidos" → toc', () => {
    const c = classifyPage(makePage([span('Tabla de contenidos')]), DEFAULT_PROFILE);
    expect(c.kind).toBe('toc');
  });

  it('insensible aux accents et à la casse', () => {
    const c = classifyPage(makePage([span('SOMMAIRE GENERAL')]), DEFAULT_PROFILE);
    expect(c.kind).toBe('toc');
    const c2 = classifyPage(makePage([span('Índice alfabético')]), DEFAULT_PROFILE);
    expect(c2.kind).toBe('toc');
  });

  it('page random sans keyword → identity', () => {
    const c = classifyPage(
      makePage([span('Bienvenue chez Catalogue A')]),
      DEFAULT_PROFILE,
    );
    expect(c.kind).toBe('identity');
  });

  it('IT : "Sommario" → toc', () => {
    const c = classifyPage(makePage([span('Sommario')]), DEFAULT_PROFILE);
    expect(c.kind).toBe('toc');
  });
  it('PT : "Sumario" → toc', () => {
    const c = classifyPage(makePage([span('Sumario')]), DEFAULT_PROFILE);
    expect(c.kind).toBe('toc');
  });
  it('FR : "Index produits" → toc', () => {
    const c = classifyPage(makePage([span('Index produits 2026')]), DEFAULT_PROFILE);
    expect(c.kind).toBe('toc');
  });
  it('EN : "Key to symbols" → glossaire', () => {
    const c = classifyPage(makePage([span('Key to symbols')]), DEFAULT_PROFILE);
    expect(c.kind).toBe('glossaire');
  });
  it('DE : "Zeichenerklarung" → glossaire', () => {
    const c = classifyPage(makePage([span('Zeichenerklärung')]), DEFAULT_PROFILE);
    expect(c.kind).toBe('glossaire');
  });
  it('ES : "Leyenda de pictogramas" → glossaire', () => {
    const c = classifyPage(
      makePage([span('Leyenda de pictogramas')]),
      DEFAULT_PROFILE,
    );
    expect(c.kind).toBe('glossaire');
  });
  it('IT : "Legenda dei pittogrammi" → glossaire', () => {
    const c = classifyPage(
      makePage([span('Legenda dei pittogrammi')]),
      DEFAULT_PROFILE,
    );
    expect(c.kind).toBe('glossaire');
  });
  it('EN : "Datasheet" / "Data sheet" → tech', () => {
    expect(
      classifyPage(makePage([span('Product Datasheet')]), DEFAULT_PROFILE).kind,
    ).toBe('tech');
    expect(
      classifyPage(makePage([span('Data Sheet rev. 2')]), DEFAULT_PROFILE).kind,
    ).toBe('tech');
  });
  it('DE : "Technische Daten" → tech', () => {
    const c = classifyPage(
      makePage([span('Technische Daten')]),
      DEFAULT_PROFILE,
    );
    expect(c.kind).toBe('tech');
  });
  it('mot seul trop generique NE matche PAS (anti faux positif)', () => {
    // "legende" seul (sans "des pictogrammes") ne doit pas classer en glossaire
    const c = classifyPage(
      makePage([span("Légende de l'affiche promotionnelle")]),
      DEFAULT_PROFILE,
    );
    expect(c.kind).toBe('identity');
    // "symbols" seul non plus
    const c2 = classifyPage(
      makePage([span('These symbols are decorative')]),
      DEFAULT_PROFILE,
    );
    expect(c2.kind).toBe('identity');
  });
});

describe('PAGE_REF_INLINE_RE — references de page multi-langue', () => {
  const m = (s: string) => PAGE_REF_INLINE_RE.test(s);

  it('legacy Catalogue A : p.12 / p. 12', () => {
    expect(m('Lavabos p.12')).toBe(true);
    expect(m('Lavabos p. 12')).toBe(true);
  });
  it('forme longue', () => {
    expect(m('Lavabos page 12')).toBe(true);
    expect(m('Lavabos Page 12')).toBe(true);
    expect(m('Lavabos pag. 12')).toBe(true);
    expect(m('Lavabos pagina 12')).toBe(true);
    expect(m('Lavabos pág. 12')).toBe(true);
    expect(m('Lavabos página 12')).toBe(true);
  });
  it('forme DE', () => {
    expect(m('Waschbecken Seite 12')).toBe(true);
    expect(m('Waschbecken S.12')).toBe(true);
    expect(m('Waschbecken S. 12')).toBe(true);
  });
  it('rejette chiffre seul (anti-faux-positif fiche produit)', () => {
    expect(m('60')).toBe(false);
    expect(m('30 35 38')).toBe(false);
    expect(m('Largeur 60 cm')).toBe(false);
  });
  it('rejette texte sans chiffre', () => {
    expect(m('Lavabos')).toBe(false);
    expect(m('page')).toBe(false);
  });
});

describe('isRealSectionBannerLabel — labels courts (WC, SDB)', () => {
  function makeLabel(text: string, size: number): TextSpan {
    return {
      text,
      bbox: [50, 50, 200, 50 + size],
      font: 'Almanach-SemiBold',
      size,
      color: '#000000',
    };
  }
  // DEFAULT_PROFILE.bannerMinSize = 14, nameSizeRange = [14, 18]
  // SHORT_LABEL_SIZE_RATIO = 1.5 → size >= 18 * 1.5 = 27 pour les courts.

  it('accepte "WC" en gros caractere (size 30, all caps)', () => {
    expect(isRealSectionBannerLabel(makeLabel('WC', 30), DEFAULT_PROFILE)).toBe(true);
  });
  it('accepte "SDB" en gros caractere (size 28, all caps)', () => {
    expect(isRealSectionBannerLabel(makeLabel('SDB', 28), DEFAULT_PROFILE)).toBe(true);
  });
  it('REJETTE "WC" en taille normale (size 20, < 27)', () => {
    expect(isRealSectionBannerLabel(makeLabel('WC', 20), DEFAULT_PROFILE)).toBe(false);
  });
  it('REJETTE "Inox" (PAS all caps, length < 6)', () => {
    expect(isRealSectionBannerLabel(makeLabel('Inox', 30), DEFAULT_PROFILE)).toBe(false);
  });
  it('REJETTE "Noir" (PAS all caps, length < 6)', () => {
    expect(isRealSectionBannerLabel(makeLabel('Noir', 30), DEFAULT_PROFILE)).toBe(false);
  });
  it('REJETTE "1" (length 1, sous le min absolu)', () => {
    expect(isRealSectionBannerLabel(makeLabel('1', 30), DEFAULT_PROFILE)).toBe(false);
  });
  it('accepte label long classique', () => {
    expect(
      isRealSectionBannerLabel(makeLabel('CUISINE & SALLE DE BAINS', 20), DEFAULT_PROFILE),
    ).toBe(true);
  });
  it('REJETTE label avec separator key:value', () => {
    expect(isRealSectionBannerLabel(makeLabel('MATIÈRE :', 20), DEFAULT_PROFILE)).toBe(false);
  });
  it('REJETTE label de taille trop petite (< bannerMinSize)', () => {
    expect(isRealSectionBannerLabel(makeLabel('CUISINE GENERALE', 10), DEFAULT_PROFILE)).toBe(false);
  });
});

describe('classifyPage : detection TOC heuristique sans slot', () => {
  it('FR : 10 spans "page X" → toc', () => {
    const spans = Array.from({ length: 10 }, (_, i) =>
      span(`Article ${i} page ${i + 10}`, 50 + i * 20),
    );
    const c = classifyPage(makePage(spans), DEFAULT_PROFILE);
    expect(c.kind).toBe('toc');
  });
  it('DE : 10 spans "Seite X" → toc', () => {
    const spans = Array.from({ length: 10 }, (_, i) =>
      span(`Eintrag ${i} Seite ${i + 10}`, 50 + i * 20),
    );
    const c = classifyPage(makePage(spans), DEFAULT_PROFILE);
    expect(c.kind).toBe('toc');
  });
  it('ES : 10 spans "pág. X" → toc', () => {
    const spans = Array.from({ length: 10 }, (_, i) =>
      span(`Articulo ${i} pág. ${i + 10}`, 50 + i * 20),
    );
    const c = classifyPage(makePage(spans), DEFAULT_PROFILE);
    expect(c.kind).toBe('toc');
  });
  it('moins de 8 spans page ref → pas toc', () => {
    const spans = Array.from({ length: 5 }, (_, i) =>
      span(`Eintrag ${i} page ${i + 10}`, 50 + i * 20),
    );
    const c = classifyPage(makePage(spans), DEFAULT_PROFILE);
    expect(c.kind).not.toBe('toc');
  });
});

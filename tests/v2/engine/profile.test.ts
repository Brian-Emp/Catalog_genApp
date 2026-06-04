/**
 * Tests de profile.ts (auto-detection du profil typographique).
 * Utilise des fixtures extracted reelles du fixture Catalogue A 188p (tests/fixtures/template.pdf).
 */

import path from 'path';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, detectProfile, detectProfileHeuristic, clearProfileCache } from '../../../src/v2/engine/profile';
import type { ExtractedPage } from '../../../src/v2/types';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function loadPage(name: string): ExtractedPage {
  const raw = readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
  return JSON.parse(raw) as ExtractedPage;
}

describe('detectProfileHeuristic', () => {
  it('retombe sur defaults si aucune page n\'a de spec keys', () => {
    const fakePages: ExtractedPage[] = [
      {
        page_number: 0,
        page_size: { width: 595, height: 842 },
        slots: [],
        raw_spans: [
          { text: 'COVER', bbox: [100, 100, 400, 130], font: 'Almanach-Bold', size: 30, color: '#000000' },
        ],
      },
    ];
    const p = detectProfileHeuristic(fakePages);
    expect(p.source).toBe('fallback');
    expect(p).toEqual(DEFAULT_PROFILE);
  });

  it('detecte le profil Catalogue A depuis une page-fiche-produit reelle (page 30)', () => {
    const page30 = loadPage('page-030-real.json');
    const p = detectProfileHeuristic([page30]);

    expect(p.source).toBe('heuristic');
    // Nom : Almanach-SemiBold size 16
    expect(p.nameFontPattern).toBe('SemiBold');
    expect(p.nameSizeRange[0]).toBeLessThanOrEqual(16);
    expect(p.nameSizeRange[1]).toBeGreaterThanOrEqual(16);
    // Cle : Almanach-Medium size 11
    expect(p.keyFontPattern).toBe('Medium');
    expect(p.keySize).toBe(11);
    // Valeur : Almanach-Light
    expect(p.valueFontPattern).toBe('Light');
    // Geometrie : keys a x=296 -> specsXMin ~= 292
    expect(p.specsXMin).toBeGreaterThan(280);
    expect(p.specsXMin).toBeLessThan(300);
    // nameXMax doit etre < specsXMin
    expect(p.nameXMax).toBeLessThan(p.specsXMin);
  });

  it('skip les pages intercalaires (page 16 = 3 bandeaux 20pt SemiBold sans specs)', () => {
    const page16 = loadPage('page-016-real.json');
    // Page 16 a 3 spans SemiBold 20pt mais 0 spec key ":"
    const p = detectProfileHeuristic([page16]);
    // L'heuristique doit retourner fallback car aucune page valide
    expect(p.source).toBe('fallback');
  });

  it('trouve une page-fiche-produit dans un melange mixte', () => {
    const page16 = loadPage('page-016-real.json');  // intercalaire
    const page30 = loadPage('page-030-real.json');  // fiche produit
    const page50 = loadPage('page-050-real.json');  // intercalaire
    const page80 = loadPage('page-080-real.json');  // fiche produit

    // Ordre melange pour s'assurer qu'on prend la 1ere valide, pas la 1ere tout court
    const p = detectProfileHeuristic([page16, page50, page30, page80]);
    expect(p.source).toBe('heuristic');
    expect(p.nameFontPattern).toBe('SemiBold');
    expect(p.keyFontPattern).toBe('Medium');
  });

  // P2.3 : couverture non-Catalogue A. Fixture synthétique avec font Bold + Helvetica
  // pour valider que l'heuristique ne presuppose pas la famille Almanach.
  // Heuristique requiert >= 3 keys (spans avec ":") ET >= 3 noms en Bold/SemiBold.
  it('detecte un profil sur template synthetique Bold/Helvetica', () => {
    const spans = [];
    // 3 produits avec leur nom + leurs specs respectives
    for (let i = 0; i < 3; i++) {
      const yBase = 100 + i * 200;
      spans.push(
        // Nom produit en Bold (zone gauche, size >= 13)
        { text: `PRODUIT TEST ${i + 1}`, bbox: [50, yBase, 300, yBase + 20], font: 'Helvetica-Bold', size: 18, color: '#000000' as const },
        // Specs : 3 paires clé/valeur (zone droite, contient ":")
        { text: 'MATIÈRE :', bbox: [320, yBase + 50, 410, yBase + 62], font: 'Helvetica-Bold', size: 11, color: '#000000' as const },
        { text: 'inox', bbox: [415, yBase + 50, 460, yBase + 62], font: 'Helvetica', size: 11, color: '#222222' as const },
        { text: 'POIDS :', bbox: [320, yBase + 65, 380, yBase + 77], font: 'Helvetica-Bold', size: 11, color: '#000000' as const },
        { text: '2.5 kg', bbox: [385, yBase + 65, 430, yBase + 77], font: 'Helvetica', size: 11, color: '#222222' as const },
        { text: 'DIAMÈTRE :', bbox: [320, yBase + 80, 410, yBase + 92], font: 'Helvetica-Bold', size: 11, color: '#000000' as const },
        { text: 'Ø 35mm', bbox: [415, yBase + 80, 470, yBase + 92], font: 'Helvetica', size: 11, color: '#222222' as const },
      );
    }
    const fakeProductPage: ExtractedPage = {
      page_number: 10,
      page_size: { width: 595, height: 842 },
      slots: [],
      raw_spans: spans,
    };
    const p = detectProfileHeuristic([fakeProductPage]);
    expect(p.source).toBe('heuristic');
    // Bold doit etre reconnu comme name font
    expect(p.nameFontPattern).toMatch(/Bold/);
    // Specs geometrie cohérente
    expect(p.specsXMin).toBeGreaterThan(300);
    expect(p.nameXMax).toBeLessThan(p.specsXMin);
  });

  // Adaptation multi-langue : templates FR/DE/ES doivent être détectés.
  // Le pattern "Gras" / "Fett" / "Negrita" doit matcher comme nom.
  it('detecte un template avec font "Roboto-Gras" (FR)', () => {
    const spans = [];
    for (let i = 0; i < 3; i++) {
      const yBase = 100 + i * 200;
      spans.push(
        { text: `PRODUIT FR ${i + 1}`, bbox: [50, yBase, 300, yBase + 20], font: 'Roboto-Gras', size: 16, color: '#000000' as const },
        { text: 'MATIÈRE :', bbox: [320, yBase + 50, 410, yBase + 62], font: 'Roboto-Medium', size: 11, color: '#000000' as const },
        { text: 'inox', bbox: [415, yBase + 50, 460, yBase + 62], font: 'Roboto', size: 11, color: '#222' as const },
        { text: 'POIDS :', bbox: [320, yBase + 65, 380, yBase + 77], font: 'Roboto-Medium', size: 11, color: '#000000' as const },
        { text: '2 kg', bbox: [385, yBase + 65, 430, yBase + 77], font: 'Roboto', size: 11, color: '#222' as const },
        { text: 'DIAMETRE :', bbox: [320, yBase + 80, 410, yBase + 92], font: 'Roboto-Medium', size: 11, color: '#000000' as const },
        { text: '35mm', bbox: [415, yBase + 80, 470, yBase + 92], font: 'Roboto', size: 11, color: '#222' as const },
      );
    }
    const page: ExtractedPage = { page_number: 5, page_size: { width: 595, height: 842 }, slots: [], raw_spans: spans };
    const p = detectProfileHeuristic([page]);
    expect(p.source).toBe('heuristic');
    expect(p.nameFontPattern).toMatch(/Gras/);
  });

  it('detecte un template avec font "OpenSans-Fett" (DE)', () => {
    const spans = [];
    for (let i = 0; i < 3; i++) {
      const yBase = 100 + i * 200;
      spans.push(
        { text: `PRODUKT DE ${i + 1}`, bbox: [50, yBase, 300, yBase + 20], font: 'OpenSans-Fett', size: 17, color: '#000000' as const },
        { text: 'MATERIAL :', bbox: [320, yBase + 50, 410, yBase + 62], font: 'OpenSans-Regular', size: 11, color: '#000000' as const },
        { text: 'Stahl', bbox: [415, yBase + 50, 460, yBase + 62], font: 'OpenSans-Regular', size: 11, color: '#222' as const },
        { text: 'GEWICHT :', bbox: [320, yBase + 65, 380, yBase + 77], font: 'OpenSans-Regular', size: 11, color: '#000000' as const },
        { text: '2 kg', bbox: [385, yBase + 65, 430, yBase + 77], font: 'OpenSans-Regular', size: 11, color: '#222' as const },
        { text: 'GROSSE :', bbox: [320, yBase + 80, 410, yBase + 92], font: 'OpenSans-Regular', size: 11, color: '#000000' as const },
        { text: 'M', bbox: [415, yBase + 80, 470, yBase + 92], font: 'OpenSans-Regular', size: 11, color: '#222' as const },
      );
    }
    const page: ExtractedPage = { page_number: 5, page_size: { width: 595, height: 842 }, slots: [], raw_spans: spans };
    const p = detectProfileHeuristic([page]);
    expect(p.source).toBe('heuristic');
    expect(p.nameFontPattern).toMatch(/Fett/);
  });

  it('detecte un template avec separateur "=" au lieu de ":"', () => {
    const spans = [];
    for (let i = 0; i < 3; i++) {
      const yBase = 100 + i * 200;
      spans.push(
        { text: `PROD ${i + 1}`, bbox: [50, yBase, 300, yBase + 20], font: 'Arial-Bold', size: 16, color: '#000000' as const },
        // Séparateur "=" pour catalogue technique
        { text: 'DEBIT = 5 L/min', bbox: [320, yBase + 50, 470, yBase + 62], font: 'Arial-Regular', size: 11, color: '#000000' as const },
        { text: 'PRESSION = 5 bar', bbox: [320, yBase + 65, 470, yBase + 77], font: 'Arial-Regular', size: 11, color: '#000000' as const },
        { text: 'TEMP = 85 C', bbox: [320, yBase + 80, 470, yBase + 92], font: 'Arial-Regular', size: 11, color: '#000000' as const },
      );
    }
    const page: ExtractedPage = { page_number: 5, page_size: { width: 595, height: 842 }, slots: [], raw_spans: spans };
    const p = detectProfileHeuristic([page]);
    // Doit reconnaître les keys via "=" (grâce au helper keyValueSeparator)
    expect(p.source).toBe('heuristic');
    expect(p.nameFontPattern).toMatch(/Bold/);
  });
});

describe('detectProfileHeuristic — fallback aggregation multi-pages', () => {
  function makePage(
    number: number,
    spans: { text: string; x: number; y: number; font: string; size: number }[],
  ): ExtractedPage {
    return {
      page_number: number,
      page_size: { width: 595, height: 842 },
      slots: [],
      raw_spans: spans.map((s) => ({
        text: s.text,
        bbox: [s.x, s.y, s.x + 100, s.y + s.size],
        font: s.font,
        size: s.size,
        color: '#000000',
      })),
    };
  }

  it('aggrege quand chaque page seule a < 3 keyCandidates', () => {
    // Chaque page n'a que 1 key + 1 nom : aucune ne passe le seuil de 3.
    // Mais l'aggregation sur 4 pages donne 4 keys + 4 noms → detection OK.
    const pages: ExtractedPage[] = [];
    for (let i = 0; i < 4; i++) {
      pages.push(
        makePage(i, [
          // Quelques spans bruits a gauche
          { text: 'CATALOGUE A', x: 50, y: 30, font: 'Almanach-Light', size: 8 },
          { text: 'PAGE ' + i, x: 50, y: 50, font: 'Almanach-Light', size: 8 },
          // 1 nom produit (zone gauche, gros, SemiBold)
          { text: 'Produit ' + i, x: 60, y: 100, font: 'Almanach-SemiBold', size: 16 },
          // 1 spec key (zone droite, Medium, avec ':')
          { text: 'MATIÈRE :', x: 350, y: 150, font: 'Almanach-Medium', size: 11 },
          // 1 spec value (zone droite, Light)
          { text: 'Inox', x: 410, y: 150, font: 'Almanach-Light', size: 11 },
        ]),
      );
    }
    const p = detectProfileHeuristic(pages);
    expect(p.source).toBe('heuristic');
    expect(p.nameFontPattern).toBe('SemiBold');
    expect(p.keyFontPattern).toBe('Medium');
    expect(p.keySize).toBe(11);
  });

  it('reste sur defaults si meme aggrege < 3 keyCandidates', () => {
    // 2 pages avec 1 spec key chacune → 2 keys aggreges, toujours < 3.
    const pages: ExtractedPage[] = [
      makePage(0, [
        { text: 'Produit', x: 60, y: 100, font: 'Almanach-SemiBold', size: 16 },
        { text: 'MATIÈRE :', x: 350, y: 150, font: 'Almanach-Medium', size: 11 },
        // pad
        { text: 'a', x: 50, y: 200, font: 'Almanach-Light', size: 10 },
        { text: 'b', x: 50, y: 220, font: 'Almanach-Light', size: 10 },
        { text: 'c', x: 50, y: 240, font: 'Almanach-Light', size: 10 },
      ]),
      makePage(1, [
        { text: 'Autre', x: 60, y: 100, font: 'Almanach-SemiBold', size: 16 },
        { text: 'COULEUR :', x: 350, y: 150, font: 'Almanach-Medium', size: 11 },
        { text: 'a', x: 50, y: 200, font: 'Almanach-Light', size: 10 },
        { text: 'b', x: 50, y: 220, font: 'Almanach-Light', size: 10 },
        { text: 'c', x: 50, y: 240, font: 'Almanach-Light', size: 10 },
      ]),
    ];
    const p = detectProfileHeuristic(pages);
    expect(p.source).toBe('fallback');
  });
});

// P2.7 : cache des profils par signature spans.
describe('detectProfile cache', () => {
  it('retourne la meme instance au 2eme appel (cached)', async () => {
    clearProfileCache();
    const page30 = loadPage('page-030-real.json');
    const p1 = await detectProfile({ pages: [page30], heuristicOnly: true });
    const p2 = await detectProfile({ pages: [page30], heuristicOnly: true });
    // Strict identity : meme instance retournee par le cache
    expect(p2).toBe(p1);
  });

  it('clearProfileCache invalide le cache', async () => {
    clearProfileCache();
    const page30 = loadPage('page-030-real.json');
    const p1 = await detectProfile({ pages: [page30], heuristicOnly: true });
    clearProfileCache();
    const p2 = await detectProfile({ pages: [page30], heuristicOnly: true });
    // Apres clear : nouvelle instance, mais memes valeurs
    expect(p2).not.toBe(p1);
    expect(p2).toEqual(p1);
  });
});

/**
 * Test du best-profile selection anti-outlier.
 *
 * Quand detectProfileHeuristic agrège des profils sur plusieurs pages :
 *   - cas homogene : tous similaires → on prend le plus grand nameXMax
 *   - cas heterogene legit : Catalogue C = quelques tabulaires + verticales → tabular gagne
 *   - cas anomalie : 1 page d'index parasite donne un nameXMax extreme isole →
 *     on doit le rejeter, sinon il pollue tout le catalogue.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { detectProfileHeuristic } from '../../../src/v2/engine/profile';
import type { ExtractedPage } from '../../../src/v2/types';

const FIX_CATALOGC = path.join(__dirname, '../fixtures/extracted/catalogC_p13.json');

describe('detectProfileHeuristic — anti-outlier best-profile selection', () => {
  it('catalogue homogene 1 page Catalogue C : tabular detecte (large nameXMax)', () => {
    const page: ExtractedPage = JSON.parse(readFileSync(FIX_CATALOGC, 'utf-8'));
    const profile = detectProfileHeuristic([page]);
    // Profil non-fallback puisque Catalogue C tabular detect via detectTabularKeys
    expect(profile).toBeDefined();
    expect(profile.nameXMax).toBeGreaterThan(0);
  });

  it('catalogue avec 1 page Catalogue C dupliquee : profile stable', () => {
    // Multiples copies de la meme page → tous profiles equivalents → pas d outlier
    const page: ExtractedPage = JSON.parse(readFileSync(FIX_CATALOGC, 'utf-8'));
    const p1 = detectProfileHeuristic([page]);
    const p2 = detectProfileHeuristic([page, page]);
    const p3 = detectProfileHeuristic([page, page, page]);
    // Le nameXMax doit etre identique car toutes les pages produisent le meme profil
    expect(p2.nameXMax).toBe(p1.nameXMax);
    expect(p3.nameXMax).toBe(p1.nameXMax);
  });

  it('liste vide → fallback profile', () => {
    const profile = detectProfileHeuristic([]);
    expect(profile.source).toBe('fallback');
  });

  it('page sans raw_spans → fallback profile', () => {
    const emptyPage: ExtractedPage = {
      page_number: 1,
      page_size: { width: 595, height: 842 },
      slots: [],
      raw_spans: [],
      raw_images: [],
    };
    const profile = detectProfileHeuristic([emptyPage]);
    expect(profile.source).toBe('fallback');
  });

  it('Anti-outlier : 3 pages similaires + 0 outlier → best = majorite', () => {
    // Avec 3 pages Catalogue C equivalentes, le branchement anti-outlier (length>=3)
    // s active mais aucun n est isole → on prend le top normalement.
    const page: ExtractedPage = JSON.parse(readFileSync(FIX_CATALOGC, 'utf-8'));
    const profile = detectProfileHeuristic([page, page, page]);
    // Resultat: identique a 1 page seul (pas d effet anti-outlier ici)
    const single = detectProfileHeuristic([page]);
    expect(profile.nameXMax).toBe(single.nameXMax);
  });
});

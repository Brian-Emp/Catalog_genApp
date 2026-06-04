/**
 * Verrouille le fix #1 (double-texte bandeau de section).
 *
 * Bug observe catalogue Catalogue A p6 : le bandeau-haut [303,12,560,27] etait
 * classe a la FOIS comme section_banner ET comme ribbon famille → 2 insert_text
 * superposes ("BARRES DE DOUCHES" + "SANITAIRE") = texte illisible.
 *
 * Fix (substitutor.ts:232-236) : substituteFamilyRibbon skippe un span deja
 * couvert (>50%) par un section_banner. Ce test garde la garde fermee : avec
 * banner → pas de label famille insere ; sans banner (controle) → le ruban
 * s'insere normalement (preuve que la machinerie fonctionne, seul l'overlap
 * est supprime).
 */
import { describe, it, expect } from 'vitest';
import { substitutePage, type SubstituteContext } from '../../../src/v2/engine/substitutor';
import { DEFAULT_PROFILE } from '../../../src/v2/engine/profile';
import type { TextSpan } from '../../../src/v2/types';

const OVERLAP_SPAN: TextSpan = {
  text: 'ÉVIERS BAS',
  bbox: [303, 12, 560, 27], // large + peu haut → ruban horizontal (bandeau page haut)
  font: 'Helvetica-Bold',
  size: 13,
  color: '#FFFFFF',
};

function baseCtx(overrides: Partial<SubstituteContext>): SubstituteContext {
  return {
    pageWidth: 595,
    pageHeight: 842,
    profile: DEFAULT_PROFILE,
    ribbonSpans: [OVERLAP_SPAN],
    newFamilyLabel: 'SANITAIRE',
    ...overrides,
  };
}

describe('substitutePage — anti double-substitution bandeau/ruban (fix #1)', () => {
  it('controle : sans banner, le ruban famille s\'insere bien', () => {
    const ops = substitutePage([], [], baseCtx({}));
    const inserts = ops.filter((o) => o.op === 'insert_text');
    const famille = inserts.filter((o) => /sanitaire/i.test((o as { text: string }).text));
    expect(famille.length, 'le ruban famille doit produire un insert_text quand aucun banner ne le couvre').toBeGreaterThan(0);
  });

  it('avec banner couvrant le meme span : aucun label famille insere', () => {
    const ops = substitutePage([], [], baseCtx({
      sectionBannerSpans: [OVERLAP_SPAN],
      newSectionLabel: 'BARRES DE DOUCHES',
    }));
    const inserts = ops.filter((o) => o.op === 'insert_text');
    const famille = inserts.filter((o) => /sanitaire/i.test((o as { text: string }).text));
    expect(famille.length, 'le span couvert par un section_banner ne doit PAS recevoir le ruban famille').toBe(0);
  });
});

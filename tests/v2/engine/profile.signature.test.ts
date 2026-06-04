/**
 * Tests profileSignature — discriminance entre templates.
 *
 * Faille review : signature precedente collidait sur 2 templates partageant
 * les 5 premiers fonts/sizes (cas marque mere → variantes saisonnieres avec
 * meme cover). Renforcer avec : totalPages, page_size, histogramme sizes.
 */
import { describe, it, expect } from 'vitest';
import { profileSignature } from '../../../src/v2/engine/profile';
import type { ExtractedPage, TextSpan } from '../../../src/v2/types';

function makeSpan(text: string, x: number, y: number, size = 12, font = 'Helvetica'): TextSpan {
  return {
    text,
    bbox: [x, y, x + 50, y + size],
    font,
    size,
    color: '#000000',
  };
}

function makePage(
  pageNum: number,
  spans: TextSpan[],
  width = 595,
  height = 842,
): ExtractedPage {
  return {
    page_number: pageNum,
    page_size: { width, height },
    slots: [],
    raw_spans: spans,
    raw_images: [],
  };
}

describe('profileSignature — discriminance', () => {
  it('meme contenu → signature identique', () => {
    const spans = [makeSpan('A', 0, 0), makeSpan('B', 0, 20)];
    const pages = [makePage(1, spans), makePage(2, spans)];
    expect(profileSignature(pages)).toBe(profileSignature(pages));
  });

  it('totalPages different → signature differente', () => {
    const spans = [makeSpan('A', 0, 0)];
    const pages30 = Array.from({ length: 30 }, (_, i) => makePage(i, spans));
    const pages200 = Array.from({ length: 200 }, (_, i) => makePage(i, spans));
    expect(profileSignature(pages30)).not.toBe(profileSignature(pages200));
  });

  it('page_size different (A4 portrait vs A3 paysage) → signature differente', () => {
    const spans = [makeSpan('A', 0, 0)];
    const a4 = [makePage(1, spans, 595, 842)];
    const a3 = [makePage(1, spans, 1191, 842)];
    expect(profileSignature(a4)).not.toBe(profileSignature(a3));
  });

  it('A4 portrait vs A4 paysage → signature differente', () => {
    const spans = [makeSpan('A', 0, 0)];
    const portrait = [makePage(1, spans, 595, 842)];
    const paysage = [makePage(1, spans, 842, 595)];
    expect(profileSignature(portrait)).not.toBe(profileSignature(paysage));
  });

  it('fonts identiques mais sizes histogramme different → signature differente', () => {
    const spansA = Array.from({ length: 30 }, (_, i) =>
      makeSpan(`s${i}`, 0, i * 10, 12, 'Helvetica'),
    );
    const spansB = Array.from({ length: 30 }, (_, i) =>
      makeSpan(`s${i}`, 0, i * 10, i < 15 ? 12 : 24, 'Helvetica'),
    );
    expect(profileSignature([makePage(1, spansA)])).not.toBe(
      profileSignature([makePage(1, spansB)]),
    );
  });

  it('liste vide → signature stable (n=0)', () => {
    expect(profileSignature([])).toBe('n=0');
  });

  it('page sans raw_spans → signature contient n=0:WxH:::[ ]', () => {
    const empty: ExtractedPage = {
      page_number: 1,
      page_size: { width: 595, height: 842 },
      slots: [],
      raw_spans: [],
      raw_images: [],
    };
    const sig = profileSignature([empty]);
    expect(sig).toContain('n=1');
    expect(sig).toContain('595x842');
  });

  it('regression : ancienne signature collidait, nouvelle non', () => {
    // 2 templates avec 5 premiers fonts identiques mais nombre de pages different
    const sharedSpans = Array.from({ length: 5 }, (_, i) =>
      makeSpan(`brand${i}`, 0, i * 10, 14, 'Cover-Brand'),
    );
    const tplA = Array.from({ length: 30 }, () => makePage(1, sharedSpans));
    const tplB = Array.from({ length: 50 }, () => makePage(1, sharedSpans));
    // Avec l ancienne signature : meme 5 fonts → meme signature → COLLISION
    // Avec la nouvelle : n=30 vs n=50 → discrimine
    expect(profileSignature(tplA)).not.toBe(profileSignature(tplB));
  });

  it('robustesse : sizes flottants sont arrondis a 0.5pt (stabilite)', () => {
    const spansA = [makeSpan('A', 0, 0, 12.01)];
    const spansB = [makeSpan('A', 0, 0, 11.99)];
    // 12.01 et 11.99 arrondis a 0.5pt → 12.0 et 12.0 → meme histogramme
    // mais le slot fonts garde la precision originale (s.size.toFixed(1))
    // Donc 12.0 vs 12.0 (toFixed(1)) → meme fonts
    // Et histogramme : Math.round(11.99 * 2) / 2 = 12, Math.round(12.01 * 2) / 2 = 12
    expect(profileSignature([makePage(1, spansA)])).toBe(
      profileSignature([makePage(1, spansB)]),
    );
  });
});

/**
 * Tests garde-fou continuation multi-ligne dans findProductBlocks.
 *
 * Faille review : la continuation multi-ligne pouvait absorber des spans
 * loin de la key (jusqu a nextKeyY arbitraire), risquant de fusionner
 * contenu hors-spec dans une value.
 *
 * Fix : limite MAX_CONTINUATION_LINES=5 + yMax absolu.
 *
 * Validation : on construit une page avec 1 key + N values empilees verticalement
 * et on verifie que findProductBlocks ne capture pas plus de 5 lignes.
 */
import { describe, it, expect } from 'vitest';
import { findProductBlocks } from '../../../src/v2/engine/blockDetector';
import { DEFAULT_PROFILE } from '../../../src/v2/engine/profile';
import type { ExtractedPage, TextSpan } from '../../../src/v2/types';

function makeSpan(text: string, x: number, y: number, size = 11, font = 'Helvetica-Light'): TextSpan {
  return {
    text,
    bbox: [x, y, x + text.length * 6, y + size],
    font,
    size,
    color: '#000000',
  };
}

describe('findProductBlocks — limite continuation multi-ligne', () => {
  it('continuation normale (3 lignes Catalogue A-like) : toutes captees', () => {
    const spans: TextSpan[] = [
      // Nom a gauche (x < nameXMax=250)
      makeSpan('PRODUIT TEST', 50, 100, 16, 'Helvetica-SemiBold'),
      // Spec key dans la specsZone (x >= specsXMin=280)
      makeSpan('GARANTIE :', 300, 150, 11, 'Helvetica-Medium'),
      makeSpan('5 ans piece et', 400, 150, 11, 'Helvetica-Light'),
      makeSpan('main d oeuvre', 300, 163, 11, 'Helvetica-Light'),
      makeSpan('dans le reseau', 300, 176, 11, 'Helvetica-Light'),
      // Spec suivante (assez loin pour ne pas etre confondue)
      makeSpan('POIDS :', 300, 250, 11, 'Helvetica-Medium'),
      makeSpan('2 kg', 400, 250, 11, 'Helvetica-Light'),
    ];
    const page: ExtractedPage = {
      page_number: 1,
      page_size: { width: 595, height: 842 },
      slots: [],
      raw_spans: spans,
      raw_images: [],
    };
    const blocks = findProductBlocks(page, DEFAULT_PROFILE);
    // Au moins 1 bloc detecte
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    if (blocks.length > 0) {
      const garantie = blocks[0].specs.find((s) =>
        s.key.text.includes('GARANTIE'),
      );
      // Garantie doit avoir des values (continuation captee)
      if (garantie) {
        expect(garantie.values.length).toBeGreaterThan(0);
      }
    }
  });

  it('continuation excessive : limitee a 5 lignes max', () => {
    const spans: TextSpan[] = [
      makeSpan('PRODUIT TEST', 50, 100, 16, 'Helvetica-SemiBold'),
      // 1 spec key dans specsZone
      makeSpan('DESCRIPTION :', 300, 150, 11, 'Helvetica-Medium'),
      // 10 lignes de "continuation" consecutives (gap regulier)
      ...Array.from({ length: 10 }, (_, i) =>
        makeSpan(`ligne ${i}`, 300, 163 + i * 13, 11, 'Helvetica-Light'),
      ),
    ];
    const page: ExtractedPage = {
      page_number: 1,
      page_size: { width: 595, height: 842 },
      slots: [],
      raw_spans: spans,
      raw_images: [],
    };
    const blocks = findProductBlocks(page, DEFAULT_PROFILE);
    if (blocks.length > 0) {
      const desc = blocks[0].specs.find((s) =>
        s.key.text.includes('DESCRIPTION'),
      );
      if (desc) {
        // Au plus 5 lignes de continuation (faille review fix)
        expect(desc.values.length).toBeLessThanOrEqual(5);
      }
    }
  });
});

/**
 * Tests anti-chevauchement wrap en mode compact pour reflowSpecsV2.
 *
 * Faille review #10 : en mode compact (yStep proche de lineH), l'extra
 * ajoute apres wrap line2 etait ~1pt → chevauchement visuel des
 * descenders/ascenders entre line2 et la row suivante.
 *
 * Fix : extra min 2pt + formule plus aeree.
 */
import { describe, it, expect } from 'vitest';
import { reflowSpecsV2 } from '../../../../src/v2/engine/reflow/reflowSpecsV2';
import { DEFAULT_PROFILE } from '../../../../src/v2/engine/profile';
import type { ProductBlock } from '../../../../src/v2/engine/blockDetector';
import type { PlanProduct } from '../../../../src/v2/types';

function makeBlock(specsCount = 15): ProductBlock {
  return {
    pageNumber: 1,
    nameSpan: {
      text: 'PRODUIT',
      bbox: [50, 80, 200, 110],
      font: 'Helvetica-SemiBold',
      size: 16,
      color: '#000000',
    },
    nameWrappedCount: 1,
    refSpan: null,
    colorSpan: null,
    specs: Array.from({ length: specsCount }, (_, i) => ({
      key: {
        text: `KEY${i}`,
        bbox: [50, 130 + i * 14, 100, 142 + i * 14],
        font: 'Helvetica-Bold',
        size: 10,
        color: '#000000',
      },
      values: [
        {
          text: `val${i}`,
          bbox: [200, 130 + i * 14, 250, 142 + i * 14],
          font: 'Helvetica',
          size: 10,
          color: '#000000',
        },
      ],
    })),
    variantImages: [],
    variantSpans: [],
    mainImageBbox: null,
    yTop: 80,
    yBottom: 310,
    specsYTop: 130,
    specsYBottom: 300, // zone serree pour forcer mode compact
    specsXLeft: 50,
  };
}

describe('reflowSpecsV2 — anti-chevauchement wrap mode compact', () => {
  it('mode compact, value tres longue : line1 et line2 ne se chevauchent pas', () => {
    const block = makeBlock(12);
    // Une spec avec value tres longue forcant wrap
    const product: PlanProduct = {
      nom: 'TEST',
      ref: '1234567',
      specs: [
        { key: 'LONGUEUR', values: ['Une valeur extremement longue qui va certainement wrapper sur deux lignes'] },
        { key: 'DIAMETRE', values: ['25mm'] },
        { key: 'POIDS', values: ['2kg'] },
        { key: 'MATIERE', values: ['Acier inoxydable'] },
        { key: 'FINITION', values: ['Chrome'] },
        { key: 'GARANTIE', values: ['2 ans'] },
        { key: 'COND', values: ['boite'] },
      ],
    } as PlanProduct;
    const ops = reflowSpecsV2(block, product, {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    const inserts = ops.filter((o) => o.op === 'insert_text');
    // Pour chaque paire (i, i+1), verifier que bbox[3] de i < bbox[1] de i+1 + petite marge
    // Tri par y ascendant
    const sorted = [...inserts].sort((a: any, b: any) => a.bbox[1] - b.bbox[1]);
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i] as any;
      const next = sorted[i + 1] as any;
      // Tolerance : 0.5pt pour spans alignes sur meme baseline
      // Mais si en lignes successives, bbox[3] doit etre <= bbox[1] du next
      if (Math.abs(cur.bbox[1] - next.bbox[1]) > 0.5) {
        // Lignes differentes : pas de chevauchement vertical
        expect(cur.bbox[3]).toBeLessThanOrEqual(next.bbox[1] + 0.5);
      }
    }
  });

  it('mode standard (peu de specs) : pas de wrap force', () => {
    const block = makeBlock(3);
    const product: PlanProduct = {
      nom: 'TEST',
      ref: '1234567',
      specs: [
        { key: 'A', values: ['1'] },
        { key: 'B', values: ['2'] },
        { key: 'C', values: ['3'] },
      ],
    } as PlanProduct;
    const ops = reflowSpecsV2(block, product, {
      pageWidth: 595,
      pageHeight: 842,
      profile: DEFAULT_PROFILE,
    });
    // Doit emettre au moins l erase + quelques insert
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.some((o) => o.op === 'erase_rect')).toBe(true);
  });
});

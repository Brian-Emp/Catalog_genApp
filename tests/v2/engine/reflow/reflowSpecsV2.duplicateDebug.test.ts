/**
 * Test debug : reproduit le cas Catalogue C "DIAMÈTREÈTRE" pour comprendre la
 * duplication observee dans le PDF generé.
 *
 * Hypothese : key longue "DIAMÈTRE MAXIMUM DES PARTICULES" sur template
 * avec key courte "DIAMÈTRE" cause une duplication visuelle.
 */
import { describe, it, expect } from 'vitest';
import { reflowSpecsV2 } from '../../../../src/v2/engine/reflow/reflowSpecsV2';
import { DEFAULT_PROFILE } from '../../../../src/v2/engine/profile';
import type { ProductBlock } from '../../../../src/v2/engine/blockDetector';
import type { PlanProduct, TextSpan } from '../../../../src/v2/types';

function makeBlock(): ProductBlock {
  const nameSpan: TextSpan = {
    text: 'TEMPLATE PROD',
    bbox: [50, 80, 200, 110],
    font: 'Helvetica-SemiBold',
    size: 16,
    color: '#000000',
  };
  return {
    pageNumber: 1,
    nameSpan,
    nameWrappedCount: 1,
    refSpan: null,
    colorSpan: null,
    specs: [
      // Template avec 2 keys "DIAMÈTRE..." courtes
      {
        key: {
          text: 'Diamètre :',
          bbox: [50, 130, 110, 142],
          font: 'Helvetica-Bold',
          size: 11,
          color: '#000000',
        },
        values: [
          { text: '25 mm', bbox: [200, 130, 230, 142], font: 'Helvetica', size: 11, color: '#000000' },
        ],
      },
      {
        key: {
          text: 'Hauteur :',
          bbox: [50, 145, 100, 157],
          font: 'Helvetica-Bold',
          size: 11,
          color: '#000000',
        },
        values: [
          { text: '6 m', bbox: [200, 145, 220, 157], font: 'Helvetica', size: 11, color: '#000000' },
        ],
      },
    ],
    variantImages: [],
    variantSpans: [],
    mainImageBbox: null,
    yTop: 80,
    yBottom: 200,
    specsYTop: 130,
    specsYBottom: 180,
    specsXLeft: 50,
  };
}

const CTX = { pageWidth: 595, profile: DEFAULT_PROFILE };

describe('reflowSpecsV2 — debug duplication DIAMÈTRE Catalogue C', () => {
  it('cas : 2 specs avec key longue (DIAMÈTRE MAXIMUM...)', () => {
    const block = makeBlock();
    const product: PlanProduct = {
      nom: 'ECOP 100',
      ref: '002236',
      specs: [
        { key: 'DIAMÈTRE MAXIMUM DES PARTICULES', values: ['ø 35mm'] },
        { key: 'DIAMÈTRE DE REFOULEMENT', values: ['F 33/42'] },
      ],
    } as PlanProduct;
    const ops = reflowSpecsV2(block, product, CTX);
    const inserts = ops.filter((o) => o.op === 'insert_text');
    const keyInserts = inserts.filter(
      (o: any) => /DIAMÈTRE|DIAMETRE/i.test(o.text),
    );
    // On attend 2 keys, pas 4 ni doublees
    expect(keyInserts.length).toBe(2);
    // Pas de doublon textuel "DIAMÈTREÈTRE"
    for (const op of keyInserts) {
      const text = (op as any).text as string;
      expect(text).not.toMatch(/DIAM.TRE.TRE/i);
    }
  });

  it('inspection : toutes les insert_text emises', () => {
    const block = makeBlock();
    const product: PlanProduct = {
      nom: 'ECOP 100',
      ref: '002236',
      specs: [
        { key: 'DIAMÈTRE MAXIMUM DES PARTICULES', values: ['ø 35mm'] },
      ],
    } as PlanProduct;
    const ops = reflowSpecsV2(block, product, CTX);
    const inserts = ops.filter((o) => o.op === 'insert_text');
    // Logguer pour audit (failure si > 5 inserts pour 1 spec)
    if (inserts.length > 5) {
      console.log('Inserts ops for 1 spec:');
      for (const o of inserts) {
        console.log(' ' + JSON.stringify({ text: (o as any).text, bbox: (o as any).bbox.map((n: number) => Math.round(n)) }));
      }
    }
    expect(inserts.length).toBeLessThan(10);
  });
});

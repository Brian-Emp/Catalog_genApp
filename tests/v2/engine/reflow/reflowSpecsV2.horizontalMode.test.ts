/**
 * Tests mode horizontal (S6.5) — bloc 1 de la session multi-cols.
 *
 * Etape 1 (ce commit) : routing du mode horizontal via ctx.horizontalMode.
 * En 'horizontal-secondary', l'erase se limite a horizontalColRight au lieu
 * de pageWidth - ribbonMargin.
 *
 * Mode 'vertical' (default) = backward compatible avec tests existants.
 */
import { describe, it, expect } from 'vitest';
import { reflowSpecsV2 } from '../../../../src/v2/engine/reflow/reflowSpecsV2';
import { DEFAULT_PROFILE } from '../../../../src/v2/engine/profile';
import type { ProductBlock } from '../../../../src/v2/engine/blockDetector';
import type { PlanProduct } from '../../../../src/v2/types';

function makeBlock(specsXLeft = 200): ProductBlock {
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
    specs: [
      {
        key: {
          text: 'MATIERE',
          bbox: [specsXLeft, 130, specsXLeft + 50, 142],
          font: 'Helvetica-Bold',
          size: 11,
          color: '#000000',
        },
        values: [
          {
            text: 'Inox',
            bbox: [specsXLeft + 60, 130, specsXLeft + 90, 142],
            font: 'Helvetica',
            size: 11,
            color: '#000000',
          },
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
    specsXLeft,
  };
}

const PRODUCT: PlanProduct = {
  nom: 'NOUVEAU',
  ref: '9999999',
  specs: [{ key: 'MATIERE', values: ['Bronze'] }],
} as PlanProduct;

describe('reflowSpecsV2 — mode horizontal routing (S6.5 etape 1)', () => {
  it('mode default (vertical) : erase pleine largeur jusqu au ribbon', () => {
    const block = makeBlock();
    const ops = reflowSpecsV2(block, PRODUCT, {
      pageWidth: 595,
      profile: DEFAULT_PROFILE,
    });
    const erase = ops.find((o) => o.op === 'erase_rect');
    expect(erase).toBeDefined();
    // 595 - ribbonMargin = 595 - 30 (default) = ~565
    expect((erase as any).bbox[2]).toBeGreaterThan(550);
  });

  it('mode horizontal-secondary : erase limite a horizontalColRight', () => {
    const block = makeBlock();
    const ops = reflowSpecsV2(block, PRODUCT, {
      pageWidth: 595,
      profile: DEFAULT_PROFILE,
      horizontalMode: 'horizontal-secondary',
      horizontalColRight: 350,
    });
    const erase = ops.find((o) => o.op === 'erase_rect');
    expect(erase).toBeDefined();
    // Erase doit s arreter a 350, pas a 565
    expect((erase as any).bbox[2]).toBe(350);
  });

  it('mode horizontal-primary : erase comportement standard', () => {
    // Phase 1 : horizontal-primary se comporte comme vertical (juste routing
    // accept). Phase 2 (next tour) implementera la logique col gauche partagee.
    const block = makeBlock();
    const ops = reflowSpecsV2(block, PRODUCT, {
      pageWidth: 595,
      profile: DEFAULT_PROFILE,
      horizontalMode: 'horizontal-primary',
    });
    const erase = ops.find((o) => o.op === 'erase_rect');
    expect(erase).toBeDefined();
    // Comme vertical pour l'instant
    expect((erase as any).bbox[2]).toBeGreaterThan(550);
  });

  it('horizontal-secondary : skip emission des keys (col gauche partagee)', () => {
    const block = makeBlock();
    const ops = reflowSpecsV2(block, PRODUCT, {
      pageWidth: 595,
      profile: DEFAULT_PROFILE,
      horizontalMode: 'horizontal-secondary',
      horizontalColRight: 350,
    });
    const inserts = ops.filter((o) => o.op === 'insert_text');
    // En secondary, on n attend AUCUNE insertion de key (MATIERE)
    const keyInserts = inserts.filter((o: any) => (o.text as string).includes('MATIERE'));
    expect(keyInserts).toHaveLength(0);
  });

  it('horizontal-primary : emet les keys (col gauche)', () => {
    const block = makeBlock();
    const ops = reflowSpecsV2(block, PRODUCT, {
      pageWidth: 595,
      profile: DEFAULT_PROFILE,
      horizontalMode: 'horizontal-primary',
    });
    const inserts = ops.filter((o) => o.op === 'insert_text');
    // Primary = comportement standard → keys emises
    const keyInserts = inserts.filter((o: any) => (o.text as string).includes('MATIERE'));
    expect(keyInserts.length).toBeGreaterThanOrEqual(1);
  });

  it('vertical : emet les keys (comportement legacy)', () => {
    const block = makeBlock();
    const ops = reflowSpecsV2(block, PRODUCT, {
      pageWidth: 595,
      profile: DEFAULT_PROFILE,
    });
    const inserts = ops.filter((o) => o.op === 'insert_text');
    const keyInserts = inserts.filter((o: any) => (o.text as string).includes('MATIERE'));
    expect(keyInserts.length).toBeGreaterThanOrEqual(1);
  });

  it('horizontalColRight sans mode : ignore (backward compat)', () => {
    const block = makeBlock();
    const ops = reflowSpecsV2(block, PRODUCT, {
      pageWidth: 595,
      profile: DEFAULT_PROFILE,
      horizontalColRight: 350,
      // pas de horizontalMode
    });
    const erase = ops.find((o) => o.op === 'erase_rect');
    // Sans horizontalMode = 'horizontal-secondary', on ignore horizontalColRight
    expect((erase as any).bbox[2]).toBeGreaterThan(550);
  });
});

/**
 * Tests synthesizeOverflowBlocks : génération de blocs synthétiques par
 * translation verticale du bloc template ref.
 */
import { describe, it, expect } from 'vitest';
import { synthesizeOverflowBlocks } from '../../../../src/v2/engine/reflow/gridLayout';
import type { ProductBlock } from '../../../../src/v2/engine/blockDetector';
import type { TextSpan } from '../../../../src/v2/types';

function mkSpan(x0: number, y0: number, x1: number, y1: number): TextSpan {
  return { text: 'T', font: 'F', size: 10, color: '#000', bbox: [x0, y0, x1, y1] };
}

function mkBlock(yTop: number, yBottom: number): ProductBlock {
  return {
    pageNumber: 1,
    nameSpan: mkSpan(50, yTop, 200, yTop + 20),
    nameWrappedCount: 1,
    refSpan: mkSpan(50, yTop + 22, 100, yTop + 32),
    colorSpan: null,
    specs: [
      { key: mkSpan(50, yTop + 50, 100, yTop + 60), values: [mkSpan(110, yTop + 50, 200, yTop + 60)] },
    ],
    variantImages: [[50, yTop + 80, 60, yTop + 90]],
    variantSpans: [],
    mainImageBbox: [50, yTop + 100, 200, yBottom - 10],
    yTop,
    yBottom,
    specsYTop: yTop + 50,
    specsYBottom: yTop + 60,
    specsXLeft: 50,
  };
}

describe('synthesizeOverflowBlocks', () => {
  it('pas d overflow → retourne blocs originaux tels quels', () => {
    const blocks = [mkBlock(50, 200), mkBlock(220, 370)];
    const r = synthesizeOverflowBlocks({ originalBlocks: blocks, nProducts: 2, pageHeight: 842 });
    expect(r.gridApplied).toBe(false);
    expect(r.rowsAdded).toBe(0);
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[0]).toBe(blocks[0]);
  });

  it('overflow simple → synthetise 1 bloc en dessous', () => {
    const blocks = [mkBlock(50, 200)];
    // hauteur bloc = 150, page = 842, footer 40, donc dispo dessous = 842-40-200 = 602
    // 602 / (150 + 8) ≈ 3.8 rangs possibles. On en veut 1.
    const r = synthesizeOverflowBlocks({ originalBlocks: blocks, nProducts: 2, pageHeight: 842 });
    expect(r.gridApplied).toBe(true);
    expect(r.rowsAdded).toBe(1);
    expect(r.blocks).toHaveLength(2);
    const synth = r.blocks[1];
    // Le bloc synthetise est translaté de (150 + 8) = 158pt en Y
    expect(synth.yTop).toBe(50 + 158);
    expect(synth.yBottom).toBe(200 + 158);
    // X inchangés
    expect(synth.specsXLeft).toBe(50);
  });

  it('cap : pas plus de rangs que de produits demandés', () => {
    const blocks = [mkBlock(50, 200)];
    const r = synthesizeOverflowBlocks({ originalBlocks: blocks, nProducts: 3, pageHeight: 842 });
    expect(r.rowsAdded).toBe(2); // 3 produits - 1 original = 2 rangs synthetises
    expect(r.blocks).toHaveLength(3);
  });

  it('cap : pas plus que ce qui tient dans la zone disponible', () => {
    const blocks = [mkBlock(50, 200)];
    // Page très basse (300pt) → dispo dessous = 300-40-200 = 60pt < 150pt bloc → 0 rang
    const r = synthesizeOverflowBlocks({ originalBlocks: blocks, nProducts: 5, pageHeight: 300 });
    expect(r.gridApplied).toBe(false);
    expect(r.rowsAdded).toBe(0);
    expect(r.blocks).toHaveLength(1);
  });

  it('bloc ref = le plus bas (yBottom max)', () => {
    const blocks = [mkBlock(50, 200), mkBlock(220, 400), mkBlock(50, 100)];
    // Le bloc le plus bas = celui avec yBottom 400 (index 1)
    const r = synthesizeOverflowBlocks({ originalBlocks: blocks, nProducts: 4, pageHeight: 842 });
    expect(r.gridApplied).toBe(true);
    // Le 1er synthetique doit etre translaté en partant du yBottom=400
    const firstSynth = r.blocks[3];
    expect(firstSynth.yTop).toBeGreaterThan(400);
  });

  it('originalBlocks vide → vide', () => {
    const r = synthesizeOverflowBlocks({ originalBlocks: [], nProducts: 5, pageHeight: 842 });
    expect(r.blocks).toEqual([]);
    expect(r.gridApplied).toBe(false);
  });

  it('preserve les attributs internes (style typo, font, color)', () => {
    const blocks = [mkBlock(50, 200)];
    const r = synthesizeOverflowBlocks({ originalBlocks: blocks, nProducts: 2, pageHeight: 842 });
    const synth = r.blocks[1];
    expect(synth.nameSpan.font).toBe('F');
    expect(synth.nameSpan.size).toBe(10);
    expect(synth.nameSpan.color).toBe('#000');
  });

  it('translate proprement specs + variantImages + mainImageBbox', () => {
    const blocks = [mkBlock(50, 200)];
    const r = synthesizeOverflowBlocks({ originalBlocks: blocks, nProducts: 2, pageHeight: 842 });
    const synth = r.blocks[1];
    const dy = 150 + 8;
    expect(synth.specs[0].key.bbox[1]).toBe(50 + 50 + dy);
    expect(synth.variantImages[0][1]).toBe(50 + 80 + dy);
    expect(synth.mainImageBbox?.[1]).toBe(50 + 100 + dy);
  });
});

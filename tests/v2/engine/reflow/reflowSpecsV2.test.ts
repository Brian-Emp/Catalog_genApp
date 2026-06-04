/**
 * Tests categorisation + regroupement de reflowSpecsV2.
 */
import { describe, it, expect } from 'vitest';
import { categorize, groupByCategory } from '../../../../src/v2/engine/reflow/reflowSpecsV2';

describe('categorize', () => {
  it('matière → TECHNIQUE', () => {
    expect(categorize('MATIÈRE')).toBe('TECHNIQUE');
    expect(categorize('matière')).toBe('TECHNIQUE');
  });
  it('longueur / diamètre / hauteur → DIMENSIONS', () => {
    expect(categorize('LONGUEUR BRAS DE DOUCHE')).toBe('DIMENSIONS');
    expect(categorize('Diamètre')).toBe('DIMENSIONS');
    expect(categorize('Hauteur totale')).toBe('DIMENSIONS');
    expect(categorize('épaisseur')).toBe('DIMENSIONS');
  });
  it('coloris / finition → FINITION', () => {
    expect(categorize('Coloris')).toBe('FINITION');
    expect(categorize('Finition')).toBe('FINITION');
    expect(categorize('couleur principale')).toBe('FINITION');
  });
  it('garantie / durée → GARANTIE', () => {
    expect(categorize('DUREE DE GARANTIE (EN ANNEES)')).toBe('GARANTIE');
    expect(categorize('Garantie')).toBe('GARANTIE');
  });
  it('conditionnement / coque / boîte → CONDITIONNEMENT', () => {
    expect(categorize('NATURE CONDITIONNEMENT')).toBe('CONDITIONNEMENT');
    expect(categorize('Conditionnement')).toBe('CONDITIONNEMENT');
    expect(categorize('Type de coque')).toBe('CONDITIONNEMENT');
  });
  it('débit / pression / température → TECHNIQUE', () => {
    expect(categorize('DEBIT')).toBe('TECHNIQUE');
    expect(categorize('Pression')).toBe('TECHNIQUE');
    expect(categorize('Température max')).toBe('TECHNIQUE');
    expect(categorize('Norme NF')).toBe('TECHNIQUE');
  });
  it('inconnu → AUTRES', () => {
    expect(categorize('SUPPORT DOUCHETTE FIXE')).toBe('AUTRES');
    expect(categorize('Accessoires fournis')).toBe('AUTRES');
  });
  it('EN : material / pressure / length / color / warranty / packaging', () => {
    expect(categorize('Material')).toBe('TECHNIQUE');
    expect(categorize('Pressure')).toBe('TECHNIQUE');
    expect(categorize('Length')).toBe('DIMENSIONS');
    expect(categorize('Color')).toBe('FINITION');
    expect(categorize('Warranty')).toBe('GARANTIE');
    expect(categorize('Packaging')).toBe('CONDITIONNEMENT');
  });
  it('DE : Druck / Länge / Farbe / Garantie / Verpackung', () => {
    expect(categorize('Druck')).toBe('TECHNIQUE');
    expect(categorize('Länge')).toBe('DIMENSIONS');
    expect(categorize('Farbe')).toBe('FINITION');
    expect(categorize('Garantie')).toBe('GARANTIE');
    expect(categorize('Verpackung')).toBe('CONDITIONNEMENT');
  });
  it('IT : materia / pressione / lunghezza / colore / garanzia / imballaggio', () => {
    expect(categorize('Materia')).toBe('TECHNIQUE');
    expect(categorize('Lunghezza')).toBe('DIMENSIONS');
    expect(categorize('Colore')).toBe('FINITION');
    expect(categorize('Garanzia')).toBe('GARANTIE');
    expect(categorize('Imballaggio')).toBe('CONDITIONNEMENT');
  });
  it('ES : longitud / acabado / garantia / embalaje', () => {
    expect(categorize('Longitud')).toBe('DIMENSIONS');
    expect(categorize('Acabado')).toBe('FINITION');
    expect(categorize('Garantía')).toBe('GARANTIE');
    expect(categorize('Embalaje')).toBe('CONDITIONNEMENT');
  });
  it('PT : cor / garantia / embalagem', () => {
    expect(categorize('Cor')).toBe('FINITION');
    expect(categorize('Garantia')).toBe('GARANTIE');
    expect(categorize('Embalagem')).toBe('CONDITIONNEMENT');
  });
});

describe('groupByCategory', () => {
  it('regroupe et trie selon l ordre TECHNIQUE → DIMENSIONS → FINITION → GARANTIE → CONDITIONNEMENT → AUTRES', () => {
    const specs = [
      { key: 'GARANTIE', values: ['2 ans'] },
      { key: 'COLORIS', values: ['Chromé'] },
      { key: 'MATIÈRE', values: ['Inox'] },
      { key: 'NATURE CONDITIONNEMENT', values: ['Coque'] },
      { key: 'LONGUEUR', values: ['70 cm'] },
    ];
    const groups = groupByCategory(specs);
    expect(groups.map((g) => g.key)).toEqual([
      'TECHNIQUE', 'DIMENSIONS', 'FINITION', 'GARANTIE', 'CONDITIONNEMENT',
    ]);
    expect(groups[0].specs[0].key).toBe('MATIÈRE');
    expect(groups[1].specs[0].key).toBe('LONGUEUR');
    expect(groups[2].specs[0].key).toBe('COLORIS');
    expect(groups[3].specs[0].key).toBe('GARANTIE');
    expect(groups[4].specs[0].key).toBe('NATURE CONDITIONNEMENT');
  });

  it('preserve l ordre d apparition au sein d une categorie', () => {
    const specs = [
      { key: 'DIAMÈTRE', values: ['22 mm'] },
      { key: 'LONGUEUR', values: ['70 cm'] },
      { key: 'HAUTEUR', values: ['80 cm'] },
    ];
    const groups = groupByCategory(specs);
    expect(groups).toHaveLength(1);
    expect(groups[0].specs.map((s) => s.key)).toEqual(['DIAMÈTRE', 'LONGUEUR', 'HAUTEUR']);
  });

  it('categorie AUTRES regroupe les inconnus en dernier', () => {
    const specs = [
      { key: 'SUPPORT DOUCHETTE FIXE', values: ['Coulissant'] },
      { key: 'MATIÈRE', values: ['Inox'] },
      { key: 'ACCESSOIRES FOURNIS', values: ['Porte savon'] },
    ];
    const groups = groupByCategory(specs);
    expect(groups[0].key).toBe('TECHNIQUE');
    expect(groups[groups.length - 1].key).toBe('AUTRES');
    expect(groups[groups.length - 1].specs).toHaveLength(2);
  });

  it('liste vide → groupes vides', () => {
    expect(groupByCategory([])).toEqual([]);
  });

  it('drop les categories vides', () => {
    const specs = [{ key: 'MATIÈRE', values: ['Inox'] }];
    const groups = groupByCategory(specs);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('TECHNIQUE');
  });
});

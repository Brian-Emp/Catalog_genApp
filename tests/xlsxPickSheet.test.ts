/**
 * Tests pickProductSheet : selection de l'onglet XLSX le plus probable de
 * contenir les donnees produit principales.
 */
import { describe, it, expect } from 'vitest';
import {
  pickProductSheet,
  isRowAllBlank,
  findHeaderRowIndex,
  cellToString,
} from '../src/services/extractors/xlsx';

describe('cellToString — types XLSX', () => {
  it('string → tel quel', () => {
    expect(cellToString('Inox')).toBe('Inox');
  });
  it('number → string', () => {
    expect(cellToString(42)).toBe('42');
    expect(cellToString(1.5)).toBe('1.5');
  });
  it('boolean → string', () => {
    expect(cellToString(true)).toBe('true');
    expect(cellToString(false)).toBe('false');
  });
  it('null/undefined → ""', () => {
    expect(cellToString(null)).toBe('');
    expect(cellToString(undefined)).toBe('');
  });
  it('Date → ISO YYYY-MM-DD', () => {
    expect(cellToString(new Date('2024-03-15T12:00:00Z'))).toBe('2024-03-15');
  });
  it('formule avec result → result extrait', () => {
    expect(cellToString({ formula: 'A1+B1', result: 5 })).toBe('5');
  });
  it('richText → concat segments', () => {
    expect(
      cellToString({
        richText: [{ text: 'Inox ' }, { text: 'brossé' }],
      }),
    ).toBe('Inox brossé');
  });
  it('hyperlink → texte de lien', () => {
    expect(cellToString({ hyperlink: 'https://example.com' })).toBe(
      'https://example.com',
    );
  });
});

describe('cellToString — erreurs Excel', () => {
  it('"#REF!" → ""', () => {
    expect(cellToString('#REF!')).toBe('');
  });
  it('"#N/A" → ""', () => {
    expect(cellToString('#N/A')).toBe('');
  });
  it('"#DIV/0!" / "#VALUE!" / "#NAME?" → ""', () => {
    expect(cellToString('#DIV/0!')).toBe('');
    expect(cellToString('#VALUE!')).toBe('');
    expect(cellToString('#NAME?')).toBe('');
  });
  it('"#NULL!" / "#NUM!" → ""', () => {
    expect(cellToString('#NULL!')).toBe('');
    expect(cellToString('#NUM!')).toBe('');
  });
  it('formule avec result erreur → ""', () => {
    expect(cellToString({ formula: '1/0', result: '#DIV/0!' })).toBe('');
  });
  it('cellule avec champ error explicite → ""', () => {
    expect(cellToString({ error: '#REF!' })).toBe('');
  });
  it('texte qui CONTIENT "#REF!" mais pas EXACT → preserve', () => {
    // "Voir #REF! ci-dessous" n'est PAS une erreur Excel pure
    expect(cellToString('Voir #REF! ci-dessous')).toBe('Voir #REF! ci-dessous');
  });
});

describe('findHeaderRowIndex', () => {
  it('row 0 = header normal → 0', () => {
    expect(findHeaderRowIndex([['Name', 'Ref', 'Color']])).toBe(0);
  });
  it('row 0 = titre 1-cell + row 1 = header → 1', () => {
    const rows = [
      ['Catalogue 2026'],
      ['Name', 'Ref', 'Color'],
      ['Mitigeur', 'AB12', 'Inox'],
    ];
    expect(findHeaderRowIndex(rows)).toBe(1);
  });
  it('row 0 = 2 cells (titre etendu) + row 1 = header → 1', () => {
    const rows = [
      ['Edition', 'Printemps 2026'],
      ['Name', 'Ref', 'Color', 'Size'],
      ['Mitigeur', 'AB12', 'Inox', 'M'],
    ];
    expect(findHeaderRowIndex(rows)).toBe(1);
  });
  it('row 0 et 1 = titres + row 2 = header → 2', () => {
    const rows = [
      ['Catalogue Printemps 2026'],
      ['Edition speciale'],
      ['Name', 'Ref', 'Color'],
    ];
    expect(findHeaderRowIndex(rows)).toBe(2);
  });
  it('rows vides → 0 (fallback)', () => {
    expect(findHeaderRowIndex([])).toBe(0);
  });
  it('aucune row avec >= 3 cellules → 0 (fallback)', () => {
    const rows = [['A'], ['B'], ['C', 'D']];
    expect(findHeaderRowIndex(rows)).toBe(0);
  });
  it('cellules whitespace ne comptent pas comme non-vides', () => {
    const rows = [
      ['Name', '', '   '],
      ['Name', 'Ref', 'Color'],
    ];
    expect(findHeaderRowIndex(rows)).toBe(1);
  });
});

describe('isRowAllBlank', () => {
  it('toutes cellules vides → blank', () => {
    expect(isRowAllBlank({ a: '', b: '', c: '' })).toBe(true);
  });
  it('toutes cellules whitespace → blank', () => {
    expect(isRowAllBlank({ a: '  ', b: '\t', c: '\n  ' })).toBe(true);
  });
  it('au moins 1 cellule non vide → pas blank', () => {
    expect(isRowAllBlank({ a: '', b: 'Inox', c: '' })).toBe(false);
  });
  it('cellule chiffre seul → pas blank', () => {
    expect(isRowAllBlank({ a: '0', b: '', c: '' })).toBe(false);
  });
  it('null/undefined comme cellule → vide', () => {
    expect(isRowAllBlank({ a: null as unknown as string, b: undefined as unknown as string })).toBe(true);
  });
  it('row vide (objet sans cles) → blank', () => {
    expect(isRowAllBlank({})).toBe(true);
  });
});

describe('pickProductSheet', () => {
  it('1 seul onglet → toujours le retourne', () => {
    expect(pickProductSheet([{ name: 'Feuille1', rowCount: 100 }])).toEqual({
      name: 'Feuille1',
      index: 0,
    });
  });

  it('aucun onglet → null', () => {
    expect(pickProductSheet([])).toBeNull();
  });

  it('prefere onglet "Produits" sur "Notes"', () => {
    const sheets = [
      { name: 'Notes', rowCount: 5 },
      { name: 'Produits', rowCount: 10 },
    ];
    const r = pickProductSheet(sheets);
    expect(r?.name).toBe('Produits');
  });

  it('prefere onglet "Products" (EN) sur "ReadMe"', () => {
    const sheets = [
      { name: 'ReadMe', rowCount: 50 },
      { name: 'Products', rowCount: 30 },
    ];
    const r = pickProductSheet(sheets);
    expect(r?.name).toBe('Products');
  });

  it('penalise onglet "Instructions" meme s\'il a plus de rows', () => {
    const sheets = [
      { name: 'Instructions', rowCount: 100 },
      { name: 'Articles', rowCount: 50 },
    ];
    const r = pickProductSheet(sheets);
    expect(r?.name).toBe('Articles');
  });

  it('multi-langue : "Prodotti" (IT) gagne sur "Foglio1"', () => {
    const sheets = [
      { name: 'Foglio1', rowCount: 20 },
      { name: 'Prodotti', rowCount: 30 },
    ];
    const r = pickProductSheet(sheets);
    expect(r?.name).toBe('Prodotti');
  });

  it('multi-langue : "Katalog" (DE) reconnu', () => {
    const sheets = [
      { name: 'Hilfe', rowCount: 10 },
      { name: 'Katalog 2026', rowCount: 200 },
    ];
    const r = pickProductSheet(sheets);
    expect(r?.name).toBe('Katalog 2026');
  });

  it('si pas de mot-cle, prend le plus rempli', () => {
    const sheets = [
      { name: 'Feuille1', rowCount: 10 },
      { name: 'Feuille2', rowCount: 500 },
      { name: 'Feuille3', rowCount: 50 },
    ];
    const r = pickProductSheet(sheets);
    expect(r?.name).toBe('Feuille2');
  });

  it('insensible casse', () => {
    const sheets = [
      { name: 'NOTES', rowCount: 100 },
      { name: 'PRODUCTS', rowCount: 50 },
    ];
    const r = pickProductSheet(sheets);
    expect(r?.name).toBe('PRODUCTS');
  });

  it('priorise rowCount entre 2 onglets non-labellisés', () => {
    const sheets = [
      { name: 'Sheet1', rowCount: 5 },
      { name: 'Sheet2', rowCount: 100 },
    ];
    expect(pickProductSheet(sheets)?.name).toBe('Sheet2');
  });

  it('skip onglet masque (hidden) meme s\'il a plus de rows', () => {
    const sheets = [
      { name: 'LookupTables', rowCount: 1000, state: 'hidden' as const },
      { name: 'Produits', rowCount: 50, state: 'visible' as const },
    ];
    expect(pickProductSheet(sheets)?.name).toBe('Produits');
  });

  it('skip onglet veryHidden', () => {
    const sheets = [
      { name: 'Internal', rowCount: 500, state: 'veryHidden' as const },
      { name: 'Catalog', rowCount: 100, state: 'visible' as const },
    ];
    expect(pickProductSheet(sheets)?.name).toBe('Catalog');
  });

  it('si tous les onglets sont masques, prend le moins pire', () => {
    const sheets = [
      { name: 'A', rowCount: 10, state: 'hidden' as const },
      { name: 'Produits', rowCount: 50, state: 'hidden' as const },
    ];
    // Tous masques, mais "Produits" gagne via keyword bonus
    expect(pickProductSheet(sheets)?.name).toBe('Produits');
  });
});

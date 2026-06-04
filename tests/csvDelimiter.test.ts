/**
 * Tests detectDelimiter : detection du separateur CSV en regardant plusieurs
 * lignes + cohérence (variance) au lieu de la 1ere ligne seule.
 */
import { describe, it, expect } from 'vitest';
import {
  detectDelimiter,
  detectEncoding,
  skipLeadingTitleRows,
} from '../src/services/extractors/csv';

describe('skipLeadingTitleRows', () => {
  it('pas de titre → text inchange', () => {
    const text = 'Name,Ref,Color\nA,B,C\nD,E,F';
    expect(skipLeadingTitleRows(text, ',')).toBe(text);
  });
  it('1 ligne titre + headers → skip titre', () => {
    const text = 'Catalogue 2026\nName,Ref,Color\nMitigeur,AB12,Inox';
    expect(skipLeadingTitleRows(text, ',')).toBe(
      'Name,Ref,Color\nMitigeur,AB12,Inox',
    );
  });
  it('2 lignes titre + headers → skip 2', () => {
    const text = 'Catalogue\nEdition Printemps\nName,Ref,Color\nA,B,C';
    expect(skipLeadingTitleRows(text, ',')).toBe('Name,Ref,Color\nA,B,C');
  });
  it('autre separateur ;', () => {
    const text = 'Titre\nName;Ref;Color\nA;B;C';
    expect(skipLeadingTitleRows(text, ';')).toBe('Name;Ref;Color\nA;B;C');
  });
  it('aucune ligne avec >= 2 separateurs → fallback intact', () => {
    const text = 'A,B\nC,D\nE,F';
    expect(skipLeadingTitleRows(text, ',')).toBe(text);
  });
  it('lignes vides en tete skippees lors du scan', () => {
    const text = '\n\nName,Ref,Color\nA,B,C';
    expect(skipLeadingTitleRows(text, ',')).toBe('Name,Ref,Color\nA,B,C');
  });
});

describe('detectDelimiter — separateurs evidents', () => {
  it('virgule (CSV standard)', () => {
    const sample = 'Name,Ref,Color\nMitigeur,AB12,Inox\nLavabo,CD34,Blanc';
    expect(detectDelimiter(sample)).toBe(',');
  });
  it('semicolon (CSV europeen)', () => {
    const sample = 'Name;Ref;Color\nMitigeur;AB12;Inox\nLavabo;CD34;Blanc';
    expect(detectDelimiter(sample)).toBe(';');
  });
  it('tab (TSV)', () => {
    const sample = 'Name\tRef\tColor\nMitigeur\tAB12\tInox\nLavabo\tCD34\tBlanc';
    expect(detectDelimiter(sample)).toBe('\t');
  });
  it('pipe (CSV exotique)', () => {
    const sample = 'Name|Ref|Color\nMitigeur|AB12|Inox\nLavabo|CD34|Blanc';
    expect(detectDelimiter(sample)).toBe('|');
  });
});

describe('detectDelimiter — coherence multi-lignes', () => {
  it('1ere ligne ambigue, lignes suivantes desambiguisent vers ";"', () => {
    // "Nom, Prénom" en header (header unique) + 3 cols separees par ";"
    // Si on regardait juste 1ere ligne, "," gagnerait. Avec multi-lignes,
    // ";" gagne car constant a 2 occurrences sur chaque ligne suivante.
    const sample = [
      'Nom, Prénom;Ref;Color',
      'Mitigeur Pro;AB12;Inox',
      'Lavabo Eco;CD34;Blanc',
      'Douche XL;EF56;Doré',
    ].join('\n');
    expect(detectDelimiter(sample)).toBe(';');
  });

  it('plusieurs seps presents, choisit le plus stable', () => {
    // Des virgules dans les values, mais le vrai sep est tab (1 par ligne)
    const sample = [
      'Name\tDescription',
      'Mitigeur\tInox, blanc, doré',
      'Lavabo\tBlanc, gris',
      'Douche\tDoré, argenté',
    ].join('\n');
    expect(detectDelimiter(sample)).toBe('\t');
  });
});

describe('detectEncoding — utf-8 vs latin1', () => {
  it('ASCII pur → utf-8', () => {
    expect(detectEncoding(Buffer.from('Hello, World!'))).toBe('utf-8');
  });
  it('UTF-8 avec accents → utf-8', () => {
    expect(detectEncoding(Buffer.from('Mégère, à côté', 'utf-8'))).toBe('utf-8');
  });
  it('UTF-8 BOM explicite → utf-8', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from('Hello', 'utf-8');
    expect(detectEncoding(Buffer.concat([bom, body]))).toBe('utf-8');
  });
  it('Latin1 (CP1252) avec accents → latin1', () => {
    // "Mégère" en latin1/CP1252 : M(0x4D) é(0xE9) g(0x67) è(0xE8) r(0x72) e(0x65)
    // L'octet 0xE9 isolé n'est pas une sequence utf-8 valide.
    expect(detectEncoding(Buffer.from('Mégère', 'latin1'))).toBe('latin1');
  });
  it('Latin1 avec multi-bytes invalides utf-8 → latin1', () => {
    // 0xE9 0xE0 0xF4 (é à ô en latin1) ne forment pas une sequence utf-8 valide
    const buf = Buffer.from([0x4d, 0xe9, 0xe0, 0xf4]);
    expect(detectEncoding(buf)).toBe('latin1');
  });
  it('Buffer vide → defaut utf-8', () => {
    expect(detectEncoding(Buffer.alloc(0))).toBe('utf-8');
  });
  it('UTF-16 LE BOM → utf-16le', () => {
    // BOM FF FE + "Hi" en UTF-16 LE : 48 00 69 00
    const buf = Buffer.from([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    expect(detectEncoding(buf)).toBe('utf-16le');
  });
});

describe('detectDelimiter — edge cases', () => {
  it('echantillon vide → defaut ","', () => {
    expect(detectDelimiter('')).toBe(',');
  });
  it('1 ligne sans separateur → defaut ","', () => {
    expect(detectDelimiter('JustOneColumn')).toBe(',');
  });
  it('CRLF (Windows) gere', () => {
    const sample = 'A;B;C\r\nx;y;z\r\np;q;r';
    expect(detectDelimiter(sample)).toBe(';');
  });
  it('lignes vides ignorees', () => {
    const sample = 'A,B,C\n\n\nx,y,z\n\n';
    expect(detectDelimiter(sample)).toBe(',');
  });
});

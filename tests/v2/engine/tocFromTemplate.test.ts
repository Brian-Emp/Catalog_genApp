/**
 * Tests unitaires pour la logique de regroupement hierarchique du sommaire :
 * - groupIntoHierarchy : section flat vs hierarchique (famille > section)
 */

import { describe, it, expect } from 'vitest';
import { groupIntoHierarchy, PAGE_NUM_RE, trimToCompletePhrase, type NewEntry } from '../../../src/v2/engine/tocFromTemplate';

describe('trimToCompletePhrase — fins de description tronquée', () => {
  it('retire une élision suspendue "d\'une" + pose un point', () => {
    expect(trimToCompletePhrase('Une barre de douche unique en Inox, d\'une'))
      .toBe('Une barre de douche unique en Inox.');
  });
  it('retire un mot de liaison final', () => {
    expect(trimToCompletePhrase('Gamme de barres inox, longueurs 60 à 70 cm et'))
      .toBe('Gamme de barres inox, longueurs 60 à 70 cm.');
  });
  it('drop une clause de mesure orpheline (profondeur sans valeur)', () => {
    expect(trimToCompletePhrase('Eviers inox à 1 ou 2 bacs, profondeur de'))
      .toBe('Eviers inox à 1 ou 2 bacs.');
  });
  it('ne touche pas une phrase complète (ajoute juste le point)', () => {
    expect(trimToCompletePhrase('Trois modèles de barres de douche en inox'))
      .toBe('Trois modèles de barres de douche en inox.');
  });
  it('préserve un point final existant', () => {
    expect(trimToCompletePhrase('Barres inox 60 cm.')).toBe('Barres inox 60 cm.');
  });
  it('coupe une parenthèse ouverte non fermée', () => {
    expect(trimToCompletePhrase('Deux barres de douche en Inox (dont'))
      .toBe('Deux barres de douche en Inox.');
  });
  it('coupe une parenthèse ouverte avec début de contenu', () => {
    expect(trimToCompletePhrase('Eviers inox 1 ou 2 bacs (profondeur'))
      .toBe('Eviers inox 1 ou 2 bacs.');
  });
  it('garde un mot élidé de contenu ("l\'eau")', () => {
    expect(trimToCompletePhrase('Mitigeurs pour l\'eau'))
      .toBe('Mitigeurs pour l\'eau.');
  });
  it('drop une clause Ø sans valeur (symbole de mesure orphelin)', () => {
    expect(trimToCompletePhrase('Barres de douche inox, longueurs 60-70 cm, Ø'))
      .toBe('Barres de douche inox, longueurs 60-70 cm.');
  });
  it('drop "Ø." en fin (avec ponctuation)', () => {
    expect(trimToCompletePhrase('Barres de douche inox ou ABS, 60-70 cm, Ø.'))
      .toBe('Barres de douche inox ou ABS, 60-70 cm.');
  });
  it('drop un lead-in de mesure sans valeur', () => {
    expect(trimToCompletePhrase('Barres de douche inox, longueurs'))
      .toBe('Barres de douche inox.');
  });
  it('garde une clause de mesure COMPLÈTE (avec valeur)', () => {
    expect(trimToCompletePhrase('Barre de douche inox, 60 cm, Ø 19 mm'))
      .toBe('Barre de douche inox, 60 cm, Ø 19 mm.');
  });
  it('ne droppe PAS une clause de contenu valide ("ou ABS")', () => {
    expect(trimToCompletePhrase('Barres de douche inox ou ABS'))
      .toBe('Barres de douche inox ou ABS.');
  });
});

describe('PAGE_NUM_RE — formats de numero de page', () => {
  const match = (s: string) => PAGE_NUM_RE.test(s);

  it('legacy Catalogue A : p.12 / p. 12', () => {
    expect(match('p.12')).toBe(true);
    expect(match('p. 12')).toBe(true);
    expect(match('p 12')).toBe(true);
    expect(match('P. 12')).toBe(true);
  });
  it('numero seul (design moderne)', () => {
    expect(match('12')).toBe(true);
    expect(match('  12 ')).toBe(true);
    expect(match('1234')).toBe(true);
  });
  it('numero avec point final', () => {
    expect(match('12.')).toBe(true);
    expect(match('12. ')).toBe(true);
  });
  it('forme longue FR/EN', () => {
    expect(match('page 12')).toBe(true);
    expect(match('Page 12')).toBe(true);
    expect(match('pg 12')).toBe(true);
    expect(match('pgs 12')).toBe(true);
  });
  it('forme longue IT/ES', () => {
    expect(match('pag 12')).toBe(true);
    expect(match('pag. 12')).toBe(true);
    expect(match('pagina 12')).toBe(true);
    expect(match('pág. 12')).toBe(true);
    expect(match('página 12')).toBe(true);
  });
  it('forme DE', () => {
    expect(match('Seite 12')).toBe(true);
    expect(match('seite 12')).toBe(true);
    expect(match('S. 12')).toBe(true);
    expect(match('S.12')).toBe(true);
  });
  it('prefixe puce / fleche (TOC design)', () => {
    expect(match('→ 12')).toBe(true);
    expect(match('▸ 12')).toBe(true);
    expect(match('● 12')).toBe(true);
    expect(match('• 12')).toBe(true);
  });
  it('rejette texte normal', () => {
    expect(match('60 cm')).toBe(false);
    expect(match('Inox brossé')).toBe(false);
    expect(match('Lavabos bas')).toBe(false);
    expect(match('')).toBe(false);
    expect(match('article 12 type')).toBe(false);
  });
  it('rejette nombre tres long (> 4 chiffres)', () => {
    expect(match('12345')).toBe(false);
  });
});

describe('groupIntoHierarchy', () => {
  it('materialise le niveau family meme avec 1 seule famille (exposer la structure)', () => {
    const entries: NewEntry[] = [
      { label: 'Lavabos', pageNumber: 3, family: 'Sanitaire', subFamily: '' },
      { label: 'Douches', pageNumber: 5, family: 'Sanitaire', subFamily: '' },
      { label: 'WC', pageNumber: 7, family: 'Sanitaire', subFamily: '' },
    ];
    const items = groupIntoHierarchy(entries);
    // 1 header family + 3 sections = 4 items
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({ kind: 'family', label: 'Sanitaire' });
    expect(items.slice(1).map((it) => it.label)).toEqual(['Lavabos', 'Douches', 'WC']);
  });

  it('retourne une liste plate quand aucune entry n a de famille', () => {
    const entries: NewEntry[] = [
      { label: 'Lavabos', pageNumber: 3, family: '', subFamily: '' },
      { label: 'Douches', pageNumber: 5, family: '', subFamily: '' },
    ];
    const items = groupIntoHierarchy(entries);
    expect(items).toHaveLength(2);
    expect(items.every((it) => it.kind === 'section')).toBe(true);
  });

  it('insere des headers famille quand plusieurs familles', () => {
    const entries: NewEntry[] = [
      { label: 'Lavabos', pageNumber: 3, family: 'Sanitaire', subFamily: '' },
      { label: 'Douches', pageNumber: 5, family: 'Sanitaire', subFamily: '' },
      { label: 'Mitigeurs', pageNumber: 8, family: 'Robinetterie', subFamily: '' },
      { label: 'Mélangeurs', pageNumber: 10, family: 'Robinetterie', subFamily: '' },
    ];
    const items = groupIntoHierarchy(entries);
    expect(items).toHaveLength(6); // 2 headers + 4 sections
    expect(items[0]).toEqual({ kind: 'family', label: 'Sanitaire' });
    expect(items[1]).toMatchObject({ kind: 'section', label: 'Lavabos', pageNumber: 3 });
    expect(items[2]).toMatchObject({ kind: 'section', label: 'Douches', pageNumber: 5 });
    expect(items[3]).toEqual({ kind: 'family', label: 'Robinetterie' });
    expect(items[4]).toMatchObject({ kind: 'section', label: 'Mitigeurs', pageNumber: 8 });
    expect(items[5]).toMatchObject({ kind: 'section', label: 'Mélangeurs', pageNumber: 10 });
  });

  it('ne duplique pas un header famille quand sections consecutives', () => {
    const entries: NewEntry[] = [
      { label: 'A', pageNumber: 2, family: 'F1', subFamily: '' },
      { label: 'B', pageNumber: 3, family: 'F1', subFamily: '' },
      { label: 'C', pageNumber: 4, family: 'F1', subFamily: '' },
      { label: 'D', pageNumber: 5, family: 'F2', subFamily: '' },
    ];
    const items = groupIntoHierarchy(entries);
    const familyHeaders = items.filter((it) => it.kind === 'family');
    expect(familyHeaders).toHaveLength(2);
    expect(familyHeaders[0].label).toBe('F1');
    expect(familyHeaders[1].label).toBe('F2');
  });

  it('preserve l ordre d apparition (pas de tri alpha)', () => {
    const entries: NewEntry[] = [
      { label: 'Z', pageNumber: 2, family: 'F1', subFamily: '' },
      { label: 'A', pageNumber: 3, family: 'F2', subFamily: '' },
      { label: 'M', pageNumber: 4, family: 'F1', subFamily: '' }, // F1 reapparait → 2e header F1
    ];
    const items = groupIntoHierarchy(entries);
    // F1 → Z, F2 → A, F1 → M  (F1 reapparait car interrompu par F2)
    expect(items.map((it) => `${it.kind}:${it.label}`)).toEqual([
      'family:F1', 'section:Z',
      'family:F2', 'section:A',
      'family:F1', 'section:M',
    ]);
  });

  it('gere les entries orphelines (sans famille) entre des familles', () => {
    const entries: NewEntry[] = [
      { label: 'A', pageNumber: 2, family: 'F1', subFamily: '' },
      { label: 'Orpheline', pageNumber: 3, family: '', subFamily: '' },
      { label: 'B', pageNumber: 4, family: 'F2', subFamily: '' },
    ];
    const items = groupIntoHierarchy(entries);
    // F1 → A → Autres → Orpheline → F2 → B
    expect(items[0]).toEqual({ kind: 'family', label: 'F1' });
    expect(items[1].label).toBe('A');
    expect(items[2]).toEqual({ kind: 'family', label: 'Autres' });
    expect(items[3].label).toBe('Orpheline');
    expect(items[4]).toEqual({ kind: 'family', label: 'F2' });
    expect(items[5].label).toBe('B');
  });

  it('retourne une liste vide quand entries vide', () => {
    expect(groupIntoHierarchy([])).toEqual([]);
  });

  it('section solo avec family renseignee → header family + section', () => {
    const entries: NewEntry[] = [
      { label: 'Solo', pageNumber: 5, family: 'UniqueFamily', subFamily: '' },
    ];
    const items = groupIntoHierarchy(entries);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: 'family', label: 'UniqueFamily' });
    expect(items[1].label).toBe('Solo');
  });

  it('3 niveaux : famille > sfamille > section', () => {
    const entries: NewEntry[] = [
      { label: 'Lavabos', pageNumber: 3, family: 'Sanitaire', subFamily: 'Robinetterie' },
      { label: 'Douches', pageNumber: 5, family: 'Sanitaire', subFamily: 'Robinetterie' },
      { label: 'WC', pageNumber: 7, family: 'Sanitaire', subFamily: 'Cuvettes' },
      { label: 'Radiateurs', pageNumber: 10, family: 'Chauffage', subFamily: 'Chauffage central' },
    ];
    const items = groupIntoHierarchy(entries);
    // Expected : F:Sanitaire > SF:Robinetterie > Lavabos, Douches > SF:Cuvettes > WC > F:Chauffage > SF:Chauffage central > Radiateurs
    expect(items.map((it) => `${it.kind}:${it.label}`)).toEqual([
      'family:Sanitaire',
      'subfamily:Robinetterie',
      'section:Lavabos',
      'section:Douches',
      'subfamily:Cuvettes',
      'section:WC',
      'family:Chauffage',
      'subfamily:Chauffage central',
      'section:Radiateurs',
    ]);
  });

  it('subFamily uniformes : emet quand meme le header subfamily (1 occurence)', () => {
    const entries: NewEntry[] = [
      { label: 'A', pageNumber: 2, family: 'F1', subFamily: 'Mêmesf' },
      { label: 'B', pageNumber: 3, family: 'F2', subFamily: 'Mêmesf' },
    ];
    const items = groupIntoHierarchy(entries);
    // Comme on a au moins UNE subFamily renseignee, hasAnySubFamily = true.
    // Donc on emet le header subfamily chaque fois qu'on rencontre une
    // nouvelle valeur (ici 'Mêmesf' apparait 1x après chaque family).
    const kinds = items.map((it) => it.kind);
    expect(kinds).toContain('family');
    expect(kinds).toContain('subfamily');
  });

  it('familles uniformes + subFamily multiples → famille puis sfamilles enchainees', () => {
    const entries: NewEntry[] = [
      { label: 'Lavabos', pageNumber: 3, family: 'Sanitaire', subFamily: 'Robinetterie' },
      { label: 'WC', pageNumber: 7, family: 'Sanitaire', subFamily: 'Cuvettes' },
    ];
    const items = groupIntoHierarchy(entries);
    // Famille emise 1x (1ere occurence), puis 2 sfamilles enchainees
    expect(items.map((it) => `${it.kind}:${it.label}`)).toEqual([
      'family:Sanitaire',
      'subfamily:Robinetterie',
      'section:Lavabos',
      'subfamily:Cuvettes',
      'section:WC',
    ]);
  });
});

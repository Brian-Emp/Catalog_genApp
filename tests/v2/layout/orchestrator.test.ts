import { describe, it, expect } from 'vitest';
import { planProductToLayout, paginateBySection } from '../../../src/v2/layout/layoutOrchestrator';
import type { PlanProduct } from '../../../src/v2/types';

function mkProduct(over: Partial<PlanProduct> = {}): PlanProduct {
  return {
    name: 'P', ref: 'R', color: null, image_path: null,
    specs: [], variants: [], ...over,
  } as PlanProduct;
}

describe('planProductToLayout', () => {
  it('aplatit les specs (values jointes) et strip le : final', () => {
    const p = mkProduct({ specs: [{ key: 'DÉBIT :', values: ['7 m³/h'] }, { key: 'COULEUR', values: ['Noir', 'Blanc'] }] });
    const l = planProductToLayout(p);
    expect(l.specs).toEqual([
      { key: 'DÉBIT', value: '7 m³/h' },
      { key: 'COULEUR', value: 'Noir / Blanc' },
    ]);
  });

  it('filtre les specs sans valeur', () => {
    const p = mkProduct({ specs: [{ key: 'A', values: [] }, { key: 'B', values: ['x'] }] });
    expect(planProductToLayout(p).specs).toEqual([{ key: 'B', value: 'x' }]);
  });

  it('resout image_path relatif avec assetsDir', () => {
    const p = mkProduct({ image_path: 'img/002236.png' });
    expect(planProductToLayout(p, '/assets').imagePath).toBe('/assets/img/002236.png');
  });

  it('garde image_path absolu tel quel', () => {
    const p = mkProduct({ image_path: '/abs/x.png' });
    expect(planProductToLayout(p, '/assets').imagePath).toBe('/abs/x.png');
  });
});

describe('paginateBySection', () => {
  it('groupe par section et decoupe en pages de perPage', () => {
    const prods = [
      mkProduct({ name: 'A', section: 'POMPES' }),
      mkProduct({ name: 'B', section: 'POMPES' }),
      mkProduct({ name: 'C', section: 'POMPES' }),
      mkProduct({ name: 'D', section: 'FILTRES' }),
    ];
    const pages = paginateBySection(prods, 2);
    // POMPES (3 prods → 2 pages : 2+1), FILTRES (1 prod → 1 page) = 3 pages
    expect(pages).toHaveLength(3);
    expect(pages[0].sectionTitle).toBe('POMPES');
    expect(pages[0].products).toHaveLength(2);
    expect(pages[1].sectionTitle).toBe('POMPES');
    expect(pages[1].products).toHaveLength(1);
    expect(pages[2].sectionTitle).toBe('FILTRES');
  });

  it('preserve l ordre d apparition des sections', () => {
    const prods = [
      mkProduct({ section: 'Z' }),
      mkProduct({ section: 'A' }),
      mkProduct({ section: 'Z' }),
    ];
    const pages = paginateBySection(prods, 5);
    expect(pages.map((p) => p.sectionTitle)).toEqual(['Z', 'A']);
    expect(pages[0].products).toHaveLength(2); // les 2 Z groupes
  });

  it('fallback family puis PRODUITS si section absente', () => {
    expect(paginateBySection([mkProduct({ section: null, family: 'FAM' })], 3)[0].sectionTitle).toBe('FAM');
    expect(paginateBySection([mkProduct({ section: null, family: null })], 3)[0].sectionTitle).toBe('PRODUITS');
  });

  it('liste vide → aucune page', () => {
    expect(paginateBySection([], 3)).toHaveLength(0);
  });
});

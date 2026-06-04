import { describe, it, expect } from 'vitest';
import { validatePlan } from '../../../src/v2/validation/plan';

function validPlan(): Record<string, unknown> {
  return {
    version: '1',
    pages: [
      { source_page: 0, page_number: null, render: { mode: 'keep_raw' } },
      {
        source_page: 4,
        page_number: 5,
        render: {
          mode: 'operations',
          operations: [
            { op: 'set_text', slot_id: 'banner_0', text: 'TUYAUTERIE' },
          ],
        },
      },
    ],
  };
}

describe('validatePlan', () => {
  describe('cas globaux', () => {
    it('accepte un plan minimal', () => {
      expect(validatePlan(validPlan()).ok).toBe(true);
    });

    it('rejette null', () => {
      expect(validatePlan(null).ok).toBe(false);
    });

    it('rejette tableau', () => {
      expect(validatePlan([]).ok).toBe(false);
    });
  });

  describe('version', () => {
    it('rejette version manquante', () => {
      const p = validPlan(); delete p.version;
      const r = validatePlan(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => e.path === 'version')).toBe(true);
    });

    it('rejette version "2"', () => {
      const p = validPlan(); p.version = '2';
      expect(validatePlan(p).ok).toBe(false);
    });
  });

  describe('pages', () => {
    it('accepte tableau vide', () => {
      const p = validPlan(); p.pages = [];
      expect(validatePlan(p).ok).toBe(true);
    });

    it('rejette si pas un tableau', () => {
      const p = validPlan(); p.pages = 'foo';
      expect(validatePlan(p).ok).toBe(false);
    });

    it('rejette source_page negatif', () => {
      const p = validPlan();
      (p.pages as Array<Record<string, unknown>>)[0].source_page = -1;
      expect(validatePlan(p).ok).toBe(false);
    });

    it('accepte page_number null', () => {
      expect(validatePlan(validPlan()).ok).toBe(true);
    });

    it('rejette page_number a 0', () => {
      const p = validPlan();
      (p.pages as Array<Record<string, unknown>>)[1].page_number = 0;
      expect(validatePlan(p).ok).toBe(false);
    });
  });

  describe('render', () => {
    it('accepte mode keep_raw', () => {
      const p = validPlan();
      p.pages = [{ source_page: 0, page_number: null, render: { mode: 'keep_raw' } }];
      expect(validatePlan(p).ok).toBe(true);
    });

    it('rejette mode inconnu', () => {
      const p = validPlan();
      p.pages = [{ source_page: 0, page_number: null, render: { mode: 'magie' } }];
      expect(validatePlan(p).ok).toBe(false);
    });

    it('rejette operations sans tableau', () => {
      const p = validPlan();
      p.pages = [{
        source_page: 0,
        page_number: null,
        render: { mode: 'operations', operations: 'foo' },
      }];
      expect(validatePlan(p).ok).toBe(false);
    });
  });

  describe('operations', () => {
    function planWithOp(op: unknown): Record<string, unknown> {
      return {
        version: '1',
        pages: [{
          source_page: 0,
          page_number: null,
          render: { mode: 'operations', operations: [op] },
        }],
      };
    }

    it('rejette op inconnu', () => {
      expect(validatePlan(planWithOp({ op: 'invalid' })).ok).toBe(false);
    });

    it('set_text : rejette text manquant', () => {
      expect(validatePlan(planWithOp({ op: 'set_text', slot_id: 'x' })).ok).toBe(false);
    });

    it('set_text : accepte slot_id + text', () => {
      expect(validatePlan(planWithOp({ op: 'set_text', slot_id: 'x', text: 'Hi' })).ok).toBe(true);
    });

    it('fill_product_slot : rejette product sans name', () => {
      expect(validatePlan(planWithOp({
        op: 'fill_product_slot',
        slot_id: 'p',
        product: { ref: null, color: null, image_path: null, specs: [], variants: [] },
      })).ok).toBe(false);
    });

    it('fill_product_slot : accepte minimal', () => {
      expect(validatePlan(planWithOp({
        op: 'fill_product_slot',
        slot_id: 'p',
        product: { name: 'X', ref: null, color: null, image_path: null, specs: [], variants: [] },
      })).ok).toBe(true);
    });

    it('fill_product_slot : rejette variant sans color hexa', () => {
      expect(validatePlan(planWithOp({
        op: 'fill_product_slot',
        slot_id: 'p',
        product: {
          name: 'X', ref: null, color: null, image_path: null, specs: [],
          variants: [{ color: 'rouge', label: null }],
        },
      })).ok).toBe(false);
    });

    it('erase_rect : rejette bbox a 3 elements', () => {
      expect(validatePlan(planWithOp({ op: 'erase_rect', bbox: [0, 0, 10] })).ok).toBe(false);
    });

    it('erase_rect : accepte bbox valide', () => {
      expect(validatePlan(planWithOp({ op: 'erase_rect', bbox: [0, 0, 10, 10] })).ok).toBe(true);
    });

    it('draw_circle : rejette center mal forme', () => {
      expect(validatePlan(planWithOp({
        op: 'draw_circle', center: [5], radius: 3, color: '#ff0000',
      })).ok).toBe(false);
    });

    it('draw_circle : rejette radius negatif', () => {
      expect(validatePlan(planWithOp({
        op: 'draw_circle', center: [5, 5], radius: -1, color: '#ff0000',
      })).ok).toBe(false);
    });

    it('draw_circle : accepte valid', () => {
      expect(validatePlan(planWithOp({
        op: 'draw_circle', center: [5, 5], radius: 3, color: '#ff0000',
      })).ok).toBe(true);
    });

    it('draw_image : rejette image_path vide', () => {
      expect(validatePlan(planWithOp({
        op: 'draw_image', bbox: [0, 0, 10, 10], image_path: '',
      })).ok).toBe(false);
    });

    it('draw_image : rejette fit inconnu', () => {
      expect(validatePlan(planWithOp({
        op: 'draw_image', bbox: [0, 0, 10, 10], image_path: 'a.png', fit: 'fit',
      })).ok).toBe(false);
    });

    it('draw_image : accepte avec fit cover', () => {
      expect(validatePlan(planWithOp({
        op: 'draw_image', bbox: [0, 0, 10, 10], image_path: 'a.png', fit: 'cover',
      })).ok).toBe(true);
    });
  });

  describe('warnings', () => {
    it('accepte tableau vide', () => {
      const p = validPlan(); p.warnings = [];
      expect(validatePlan(p).ok).toBe(true);
    });

    it('rejette warnings non string', () => {
      const p = validPlan(); p.warnings = [123];
      expect(validatePlan(p).ok).toBe(false);
    });
  });

  describe('stats', () => {
    it('accepte stats partiel', () => {
      const p = validPlan(); p.stats = { products_used: 6 };
      expect(validatePlan(p).ok).toBe(true);
    });

    it('rejette stats negatif', () => {
      const p = validPlan(); p.stats = { products_used: -1 };
      expect(validatePlan(p).ok).toBe(false);
    });
  });
});

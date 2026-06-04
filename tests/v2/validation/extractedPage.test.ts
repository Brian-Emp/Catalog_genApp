import { describe, it, expect } from 'vitest';
import { validateExtractedPage } from '../../../src/v2/validation/extractedPage';

// Helper : petite fixture valide qu'on peut muter pour tester les cas KO
function validPage(): Record<string, unknown> {
  return {
    page_number: 5,
    page_size: { width: 595, height: 842 },
    slots: [
      {
        type: 'section_banner',
        id: 'banner_0',
        bbox: [240, 0, 565, 35],
        label: {
          text: 'TUYAUTERIE',
          bbox: [400, 10, 540, 30],
          font: 'Almanach-Bold',
          size: 18,
          color: '#ffffff',
        },
      },
    ],
  };
}

describe('validateExtractedPage', () => {
  describe('cas globaux', () => {
    it('accepte une page minimale valide', () => {
      const r = validateExtractedPage(validPage());
      expect(r.ok).toBe(true);
    });

    it('rejette null', () => {
      const r = validateExtractedPage(null);
      expect(r.ok).toBe(false);
    });

    it('rejette une string', () => {
      const r = validateExtractedPage('hello');
      expect(r.ok).toBe(false);
    });

    it('rejette un tableau', () => {
      const r = validateExtractedPage([]);
      expect(r.ok).toBe(false);
    });
  });

  describe('page_number', () => {
    it('accepte 0', () => {
      const p = validPage(); p.page_number = 0;
      expect(validateExtractedPage(p).ok).toBe(true);
    });

    it('rejette negatif', () => {
      const p = validPage(); p.page_number = -1;
      const r = validateExtractedPage(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0].path).toBe('page_number');
    });

    it('rejette decimal', () => {
      const p = validPage(); p.page_number = 1.5;
      expect(validateExtractedPage(p).ok).toBe(false);
    });

    it('rejette string', () => {
      const p = validPage(); p.page_number = '5';
      expect(validateExtractedPage(p).ok).toBe(false);
    });

    it('rejette absence', () => {
      const p = validPage(); delete p.page_number;
      expect(validateExtractedPage(p).ok).toBe(false);
    });
  });

  describe('page_size', () => {
    it('rejette objet sans width', () => {
      const p = validPage(); p.page_size = { height: 842 };
      const r = validateExtractedPage(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => e.path === 'page_size.width')).toBe(true);
    });

    it('rejette width negatif', () => {
      const p = validPage(); p.page_size = { width: -1, height: 842 };
      expect(validateExtractedPage(p).ok).toBe(false);
    });

    it('rejette page_size string', () => {
      const p = validPage(); p.page_size = 'A4';
      expect(validateExtractedPage(p).ok).toBe(false);
    });
  });

  describe('slots', () => {
    it('accepte tableau vide', () => {
      const p = validPage(); p.slots = [];
      expect(validateExtractedPage(p).ok).toBe(true);
    });

    it('rejette si pas un tableau', () => {
      const p = validPage(); p.slots = 'foo';
      expect(validateExtractedPage(p).ok).toBe(false);
    });

    it('rejette type slot inconnu', () => {
      const p = validPage();
      (p.slots as unknown[])[0] = { type: 'unknown_thing', id: 'x', bbox: [0, 0, 1, 1] };
      const r = validateExtractedPage(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0].path).toMatch(/slots\[0\]\.type/);
    });

    it('chemin d\'erreur indique l\'index', () => {
      const p = validPage();
      (p.slots as unknown[]).push({ type: 'product_slot', id: 'p1', bbox: 'pas un bbox' });
      const r = validateExtractedPage(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => e.path.startsWith('slots[1]'))).toBe(true);
    });
  });

  describe('text_span (via section_banner.label)', () => {
    it('rejette label sans color', () => {
      const p = validPage();
      delete (p.slots as Array<Record<string, unknown>>)[0].label as unknown;
      const r = validateExtractedPage(p);
      expect(r.ok).toBe(false);
    });

    it('rejette color non hexa', () => {
      const p = validPage();
      const slot = (p.slots as Array<Record<string, unknown>>)[0];
      (slot.label as Record<string, unknown>).color = 'rouge';
      const r = validateExtractedPage(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => e.path === 'slots[0].label.color')).toBe(true);
    });

    it('accepte color hexa valide', () => {
      const p = validPage();
      const slot = (p.slots as Array<Record<string, unknown>>)[0];
      (slot.label as Record<string, unknown>).color = '#ABCdef';
      expect(validateExtractedPage(p).ok).toBe(true);
    });

    it('rejette bbox a 3 elements', () => {
      const p = validPage();
      const slot = (p.slots as Array<Record<string, unknown>>)[0];
      (slot.label as Record<string, unknown>).bbox = [0, 0, 1];
      expect(validateExtractedPage(p).ok).toBe(false);
    });

    it('rejette size negatif', () => {
      const p = validPage();
      const slot = (p.slots as Array<Record<string, unknown>>)[0];
      (slot.label as Record<string, unknown>).size = -3;
      expect(validateExtractedPage(p).ok).toBe(false);
    });
  });

  describe('product_slot', () => {
    function productPage(): Record<string, unknown> {
      const p = validPage();
      p.slots = [{
        type: 'product_slot',
        id: 'product_0',
        bbox: [50, 80, 540, 380],
        name: { text: 'BAR', bbox: [60, 100, 250, 120], font: 'F', size: 14, color: '#000000' },
        ref: null,
        color: null,
        image: { bbox: [60, 130, 270, 380] },
        specs: [],
        variants: [],
      }];
      return p;
    }

    it('accepte un product_slot minimal', () => {
      expect(validateExtractedPage(productPage()).ok).toBe(true);
    });

    it('rejette sans name', () => {
      const p = productPage();
      delete (p.slots as Array<Record<string, unknown>>)[0].name as unknown;
      expect(validateExtractedPage(p).ok).toBe(false);
    });

    it('rejette image sans bbox', () => {
      const p = productPage();
      (p.slots as Array<Record<string, unknown>>)[0].image = {};
      expect(validateExtractedPage(p).ok).toBe(false);
    });

    it('accepte specs vide', () => {
      const p = productPage();
      (p.slots as Array<Record<string, unknown>>)[0].specs = [];
      expect(validateExtractedPage(p).ok).toBe(true);
    });

    it('rejette spec sans key', () => {
      const p = productPage();
      (p.slots as Array<Record<string, unknown>>)[0].specs = [
        { values: [{ text: 'Inox', bbox: [1, 1, 10, 10], font: 'F', size: 11, color: '#000' }] },
      ];
      expect(validateExtractedPage(p).ok).toBe(false);
    });

    it('rejette variant sans color', () => {
      const p = productPage();
      (p.slots as Array<Record<string, unknown>>)[0].variants = [{ bbox: [1, 1, 10, 10], label: null }];
      expect(validateExtractedPage(p).ok).toBe(false);
    });
  });

  describe('keep_page_raw', () => {
    it('accepte sans reason', () => {
      const p = validPage();
      p.slots = [{ type: 'keep_page_raw', id: 'cover', bbox: [0, 0, 595, 842] }];
      expect(validateExtractedPage(p).ok).toBe(true);
    });

    it('accepte avec reason', () => {
      const p = validPage();
      p.slots = [{ type: 'keep_page_raw', id: 'cover', bbox: [0, 0, 595, 842], reason: 'cover' }];
      expect(validateExtractedPage(p).ok).toBe(true);
    });
  });

  describe('decoration', () => {
    it('rejette kind inconnu', () => {
      const p = validPage();
      p.slots = [{ type: 'decoration', id: 'd0', bbox: [0, 0, 1, 1], kind: 'pdf' }];
      expect(validateExtractedPage(p).ok).toBe(false);
    });

    it('accepte kind image', () => {
      const p = validPage();
      p.slots = [{ type: 'decoration', id: 'd0', bbox: [0, 0, 1, 1], kind: 'image' }];
      expect(validateExtractedPage(p).ok).toBe(true);
    });
  });

  describe('accumulation d\'erreurs', () => {
    it('collecte plusieurs erreurs en un seul appel', () => {
      const r = validateExtractedPage({
        page_number: -1,
        page_size: 'A4',
        slots: 'pas un tableau',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
    });
  });
});

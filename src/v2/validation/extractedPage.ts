/**
 * Validateur pour les fichiers extracted-page.json (cf
 * src/v2/schemas/extracted-page.schema.json).
 *
 * Strategie : on parcourt l'objet inconnu, on collecte TOUTES les erreurs
 * dans un accumulateur, puis on retourne soit ok(...) soit err([...]).
 * Collecter toutes les erreurs (au lieu de s'arreter au premier souci) aide
 * a debugger des extractions cassees plus vite.
 */

import type {
  Bbox,
  ExtractedPage,
  ProductSpec,
  ProductVariant,
  Slot,
  SlotType,
  TextSpan,
} from '../types';
import { SLOT_TYPES } from '../types';
import {
  isArray,
  isBbox,
  isHexColor,
  isInteger,
  isNumber,
  isObject,
  isOneOf,
  isString,
} from './helpers';
import type { Result, ValidationError } from './result';
import { err, ok } from './result';

/** Point d'entree public. Prend du JSON parse (unknown) et retourne soit
 *  un ExtractedPage type, soit la liste des erreurs trouvees. */
export function validateExtractedPage(input: unknown): Result<ExtractedPage> {
  const errors: ValidationError[] = [];

  if (!isObject(input)) {
    return err([{ path: '', message: 'doit etre un objet JSON' }]);
  }

  validatePageNumber(input.page_number, errors);
  validatePageSize(input.page_size, errors);
  validateSlots(input.slots, errors);
  validateExtractorVersion(input.extractor_version, errors);
  validateRawSpans(input.raw_spans, errors);
  validateRawImages(input.raw_images, errors);
  validateRawPaths(input.raw_paths, errors);

  if (errors.length > 0) return err(errors);
  return ok(input as unknown as ExtractedPage);
}

function validateRawPaths(v: unknown, errors: ValidationError[]): void {
  if (v === undefined) return;
  if (!isArray(v)) {
    errors.push({ path: 'raw_paths', message: 'doit etre un tableau si present' });
    return;
  }
  v.forEach((p, i) => {
    if (!isObject(p)) {
      errors.push({ path: `raw_paths[${i}]`, message: 'doit etre un objet' });
      return;
    }
    if (!isBbox(p.bbox)) {
      errors.push({ path: `raw_paths[${i}].bbox`, message: 'doit etre [x0,y0,x1,y1]' });
    }
    if (!isHexColor(p.fill_color)) {
      errors.push({ path: `raw_paths[${i}].fill_color`, message: 'doit etre #rrggbb' });
    }
  });
}

// ─── raw_spans (optionnel mais valide si present) ──────────────────────────

function validateRawSpans(v: unknown, errors: ValidationError[]): void {
  if (v === undefined) return;
  if (!isArray(v)) {
    errors.push({ path: 'raw_spans', message: 'doit etre un tableau si present' });
    return;
  }
  v.forEach((s, i) => {
    if (!isObject(s)) {
      errors.push({ path: `raw_spans[${i}]`, message: 'doit etre un objet span' });
      return;
    }
    if (!isString(s.text)) {
      errors.push({ path: `raw_spans[${i}].text`, message: 'doit etre une string' });
    }
    if (!isBbox(s.bbox)) {
      errors.push({ path: `raw_spans[${i}].bbox`, message: 'doit etre [x0,y0,x1,y1]' });
    } else {
      const b = s.bbox as number[];
      if (b[0] > b[2] || b[1] > b[3]) {
        errors.push({
          path: `raw_spans[${i}].bbox`,
          message: 'doit avoir x0 <= x2 et y0 <= y2',
        });
      }
    }
    if (!isString(s.font)) {
      errors.push({ path: `raw_spans[${i}].font`, message: 'doit etre une string' });
    }
    if (!isNumber(s.size) || s.size <= 0) {
      errors.push({ path: `raw_spans[${i}].size`, message: 'doit etre un nombre > 0' });
    }
    if (!isHexColor(s.color)) {
      errors.push({ path: `raw_spans[${i}].color`, message: 'doit etre #rrggbb' });
    }
  });
}

function validateRawImages(v: unknown, errors: ValidationError[]): void {
  if (v === undefined) return;
  if (!isArray(v)) {
    errors.push({ path: 'raw_images', message: 'doit etre un tableau si present' });
    return;
  }
  v.forEach((b, i) => {
    if (!isBbox(b)) {
      errors.push({ path: `raw_images[${i}]`, message: 'doit etre [x0,y0,x1,y1]' });
    }
  });
}

// ─── Champs top-level ──────────────────────────────────────────────────────

function validatePageNumber(v: unknown, errors: ValidationError[]): void {
  if (!isInteger(v) || v < 0) {
    errors.push({ path: 'page_number', message: 'doit etre un entier >= 0' });
  }
}

function validatePageSize(v: unknown, errors: ValidationError[]): void {
  if (!isObject(v)) {
    errors.push({ path: 'page_size', message: 'doit etre un objet { width, height }' });
    return;
  }
  if (!isNumber(v.width) || v.width < 0) {
    errors.push({ path: 'page_size.width', message: 'doit etre un nombre >= 0' });
  }
  if (!isNumber(v.height) || v.height < 0) {
    errors.push({ path: 'page_size.height', message: 'doit etre un nombre >= 0' });
  }
}

function validateExtractorVersion(v: unknown, errors: ValidationError[]): void {
  if (v !== undefined && !isString(v)) {
    errors.push({ path: 'extractor_version', message: 'doit etre une string si present' });
  }
}

// ─── Slots ─────────────────────────────────────────────────────────────────

function validateSlots(v: unknown, errors: ValidationError[]): void {
  if (!isArray(v)) {
    errors.push({ path: 'slots', message: 'doit etre un tableau' });
    return;
  }
  v.forEach((slot, i) => validateSlot(slot, `slots[${i}]`, errors));
}

function validateSlot(v: unknown, path: string, errors: ValidationError[]): void {
  if (!isObject(v)) {
    errors.push({ path, message: 'doit etre un objet' });
    return;
  }
  // Champs communs : type, id, bbox
  if (!isOneOf(v.type, SLOT_TYPES)) {
    errors.push({
      path: `${path}.type`,
      message: `doit etre l'une de : ${SLOT_TYPES.join(', ')}`,
    });
    return; // sans type valide on ne peut pas dispatcher
  }
  if (!isString(v.id) || v.id.length === 0) {
    errors.push({ path: `${path}.id`, message: 'doit etre une string non vide' });
  }
  if (!isBbox(v.bbox)) {
    errors.push({ path: `${path}.bbox`, message: 'doit etre [x0, y0, x1, y1]' });
  }

  // Dispatch sur type discriminant
  const slotType = v.type as SlotType;
  switch (slotType) {
    case 'section_banner':   validateSectionBanner(v, path, errors); break;
    case 'section_ribbon':   validateSectionRibbon(v, path, errors); break;
    case 'product_slot':     validateProductSlot(v, path, errors);   break;
    case 'toc_entry':        validateTocEntry(v, path, errors);      break;
    case 'toc_title':        validateTocTitle(v, path, errors);      break;
    case 'page_number':      validatePageNumberSlot(v, path, errors); break;
    case 'running_header':   validateRunningHeader(v, path, errors); break;
    case 'decoration':       validateDecoration(v, path, errors);    break;
    case 'keep_page_raw':    validateKeepPageRaw(v, path, errors);   break;
  }
}

// ─── text_span (sous-type reutilise) ───────────────────────────────────────

function validateTextSpan(v: unknown, path: string, errors: ValidationError[]): void {
  if (!isObject(v)) {
    errors.push({ path, message: 'doit etre un objet text_span' });
    return;
  }
  if (!isString(v.text)) errors.push({ path: `${path}.text`, message: 'doit etre une string' });
  if (!isBbox(v.bbox))   errors.push({ path: `${path}.bbox`, message: 'doit etre [x0, y0, x1, y1]' });
  if (!isString(v.font)) errors.push({ path: `${path}.font`, message: 'doit etre une string' });
  if (!isNumber(v.size) || v.size < 0) errors.push({ path: `${path}.size`, message: 'doit etre un nombre >= 0' });
  if (!isHexColor(v.color)) errors.push({ path: `${path}.color`, message: 'doit etre #rrggbb' });
}

function validateOptionalTextSpan(v: unknown, path: string, errors: ValidationError[]): void {
  if (v === null || v === undefined) return;
  validateTextSpan(v, path, errors);
}

// ─── Validators par type de slot ───────────────────────────────────────────

function validateSectionBanner(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  validateTextSpan(v.label, `${path}.label`, errors);
  if (v.background !== undefined && !isHexColor(v.background)) {
    errors.push({ path: `${path}.background`, message: 'doit etre #rrggbb si present' });
  }
}

function validateSectionRibbon(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  validateTextSpan(v.label, `${path}.label`, errors);
  if (v.rotation !== undefined && !isOneOf(String(v.rotation), ['0', '90', '180', '270'])) {
    errors.push({ path: `${path}.rotation`, message: 'doit etre 0, 90, 180 ou 270' });
  }
  if (v.background !== undefined && !isHexColor(v.background)) {
    errors.push({ path: `${path}.background`, message: 'doit etre #rrggbb si present' });
  }
}

function validateProductSlot(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  validateTextSpan(v.name, `${path}.name`, errors);
  validateOptionalTextSpan(v.ref, `${path}.ref`, errors);
  validateOptionalTextSpan(v.color, `${path}.color`, errors);

  // image
  if (!isObject(v.image)) {
    errors.push({ path: `${path}.image`, message: 'doit etre un objet { bbox }' });
  } else if (!isBbox(v.image.bbox)) {
    errors.push({ path: `${path}.image.bbox`, message: 'doit etre [x0, y0, x1, y1]' });
  }

  // specs
  if (v.specs !== undefined) {
    if (!isArray(v.specs)) {
      errors.push({ path: `${path}.specs`, message: 'doit etre un tableau' });
    } else {
      v.specs.forEach((s, i) => validateProductSpec(s, `${path}.specs[${i}]`, errors));
    }
  }

  // variants
  if (v.variants !== undefined) {
    if (!isArray(v.variants)) {
      errors.push({ path: `${path}.variants`, message: 'doit etre un tableau' });
    } else {
      v.variants.forEach((va, i) => validateProductVariant(va, `${path}.variants[${i}]`, errors));
    }
  }
}

function validateProductSpec(v: unknown, path: string, errors: ValidationError[]): void {
  if (!isObject(v)) {
    errors.push({ path, message: 'doit etre un objet { key, values }' });
    return;
  }
  validateTextSpan(v.key, `${path}.key`, errors);
  if (!isArray(v.values)) {
    errors.push({ path: `${path}.values`, message: 'doit etre un tableau de text_span' });
  } else {
    v.values.forEach((val, i) => validateTextSpan(val, `${path}.values[${i}]`, errors));
  }
}

function validateProductVariant(v: unknown, path: string, errors: ValidationError[]): void {
  if (!isObject(v)) {
    errors.push({ path, message: 'doit etre un objet { bbox, color, label }' });
    return;
  }
  if (!isBbox(v.bbox))      errors.push({ path: `${path}.bbox`, message: 'doit etre [x0, y0, x1, y1]' });
  if (!isHexColor(v.color)) errors.push({ path: `${path}.color`, message: 'doit etre #rrggbb' });
  validateOptionalTextSpan(v.label, `${path}.label`, errors);
}

function validateTocEntry(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  validateTextSpan(v.label, `${path}.label`, errors);
  validateTextSpan(v.page_number_text, `${path}.page_number_text`, errors);
}

function validateTocTitle(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  validateTextSpan(v.label, `${path}.label`, errors);
}

function validatePageNumberSlot(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  validateTextSpan(v.label, `${path}.label`, errors);
  if (v.current_number !== undefined && (!isInteger(v.current_number) || (v.current_number as number) < 0)) {
    errors.push({ path: `${path}.current_number`, message: 'doit etre un entier >= 0 si present' });
  }
}

function validateRunningHeader(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  validateTextSpan(v.label, `${path}.label`, errors);
}

function validateDecoration(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  if (!isOneOf(v.kind, ['image', 'vector'])) {
    errors.push({ path: `${path}.kind`, message: 'doit etre "image" ou "vector"' });
  }
}

function validateKeepPageRaw(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  if (v.reason !== undefined && !isString(v.reason)) {
    errors.push({ path: `${path}.reason`, message: 'doit etre une string si present' });
  }
}

// Inutilises mais re-exportes pour les tests qui voudraient valider isolement
export { validateTextSpan, validateSlot };
// Suppression warning TS6133 sur les types importes uniquement pour la signature
export type _internals = Bbox | TextSpan | ProductSpec | ProductVariant | Slot;

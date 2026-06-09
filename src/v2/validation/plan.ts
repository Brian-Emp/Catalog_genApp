/**
 * Validator for plan.json files (cf src/v2/schemas/plan.schema.json).
 * Same strategy as extractedPage: error accumulator, dispatch on the
 * discriminant.
 */

import type {
  Operation,
  OperationType,
  PagePlan,
  PageRender,
  Plan,
  PlanProduct,
  PlanProductSpec,
  PlanProductVariant,
} from '../types';
import { OPERATION_TYPES } from '../types';
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

export function validatePlan(input: unknown): Result<Plan> {
  const errors: ValidationError[] = [];

  if (!isObject(input)) {
    return err([{ path: '', message: 'doit etre un objet JSON' }]);
  }

  // version
  if (input.version !== '1') {
    errors.push({ path: 'version', message: 'doit valoir "1"' });
  }

  // template_pdf_hash (optional)
  if (input.template_pdf_hash !== undefined && !isString(input.template_pdf_hash)) {
    errors.push({ path: 'template_pdf_hash', message: 'doit etre une string si present' });
  }

  // pages (required)
  validatePages(input.pages, errors);

  // warnings (optional)
  if (input.warnings !== undefined) {
    if (!isArray(input.warnings)) {
      errors.push({ path: 'warnings', message: 'doit etre un tableau de strings' });
    } else {
      input.warnings.forEach((w, i) => {
        if (!isString(w)) {
          errors.push({ path: `warnings[${i}]`, message: 'doit etre une string' });
        }
      });
    }
  }

  // stats (optional)
  if (input.stats !== undefined) {
    validateStats(input.stats, errors);
  }

  if (errors.length > 0) return err(errors);
  return ok(input as unknown as Plan);
}

// ─── pages ──────────────────────────────────────────────────────────────────

function validatePages(v: unknown, errors: ValidationError[]): void {
  if (!isArray(v)) {
    errors.push({ path: 'pages', message: 'doit etre un tableau' });
    return;
  }
  v.forEach((p, i) => validatePagePlan(p, `pages[${i}]`, errors));
}

function validatePagePlan(v: unknown, path: string, errors: ValidationError[]): void {
  if (!isObject(v)) {
    errors.push({ path, message: 'doit etre un objet' });
    return;
  }
  if (!isInteger(v.source_page) || (v.source_page as number) < 0) {
    errors.push({ path: `${path}.source_page`, message: 'doit etre un entier >= 0' });
  }
  if (v.page_number !== null && v.page_number !== undefined) {
    if (!isInteger(v.page_number) || (v.page_number as number) < 1) {
      errors.push({ path: `${path}.page_number`, message: 'doit etre un entier >= 1 ou null' });
    }
  }
  validateRender(v.render, `${path}.render`, errors);
}

function validateRender(v: unknown, path: string, errors: ValidationError[]): void {
  if (!isObject(v)) {
    errors.push({ path, message: 'doit etre un objet { mode, ... }' });
    return;
  }
  if (v.mode === 'keep_raw') {
    // nothing else to validate
    return;
  }
  if (v.mode === 'operations') {
    if (!isArray(v.operations)) {
      errors.push({ path: `${path}.operations`, message: 'doit etre un tableau' });
      return;
    }
    v.operations.forEach((op, i) => validateOperation(op, `${path}.operations[${i}]`, errors));
    return;
  }
  errors.push({ path: `${path}.mode`, message: 'doit etre "keep_raw" ou "operations"' });
}

// ─── operations ─────────────────────────────────────────────────────────────

function validateOperation(v: unknown, path: string, errors: ValidationError[]): void {
  if (!isObject(v)) {
    errors.push({ path, message: 'doit etre un objet' });
    return;
  }
  if (!isOneOf(v.op, OPERATION_TYPES)) {
    errors.push({
      path: `${path}.op`,
      message: `doit etre l'une de : ${OPERATION_TYPES.join(', ')}`,
    });
    return;
  }
  const opType = v.op as OperationType;
  switch (opType) {
    case 'set_text':          validateOpSetText(v, path, errors); break;
    case 'insert_text':       validateOpInsertText(v, path, errors); break;
    case 'fill_product_slot': validateOpFillProductSlot(v, path, errors); break;
    case 'erase_rect':        validateOpEraseRect(v, path, errors); break;
    case 'remove_paths_in_bbox': validateOpEraseRect(v, path, errors); break;
    case 'remove_text_in_bbox':  validateOpEraseRect(v, path, errors); break;
    case 'draw_circle':       validateOpDrawCircle(v, path, errors); break;
    case 'draw_image':        validateOpDrawImage(v, path, errors); break;
  }
}

function validateOpInsertText(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  if (!isBbox(v.bbox)) errors.push({ path: `${path}.bbox`, message: 'doit etre [x0,y0,x1,y1]' });
  if (!isString(v.text)) errors.push({ path: `${path}.text`, message: 'doit etre une string' });
  if (!isString(v.font)) errors.push({ path: `${path}.font`, message: 'doit etre une string' });
  if (!isNumber(v.size) || (v.size as number) <= 0) {
    errors.push({ path: `${path}.size`, message: 'doit etre un nombre > 0' });
  }
  if (!isHexColor(v.color)) errors.push({ path: `${path}.color`, message: 'doit etre #rrggbb' });
}

function validateOpSetText(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  if (!isString(v.slot_id) || v.slot_id.length === 0) {
    errors.push({ path: `${path}.slot_id`, message: 'doit etre une string non vide' });
  }
  if (!isString(v.text)) {
    errors.push({ path: `${path}.text`, message: 'doit etre une string' });
  }
}

function validateOpFillProductSlot(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  if (!isString(v.slot_id) || v.slot_id.length === 0) {
    errors.push({ path: `${path}.slot_id`, message: 'doit etre une string non vide' });
  }
  validatePlanProduct(v.product, `${path}.product`, errors);
}

function validatePlanProduct(v: unknown, path: string, errors: ValidationError[]): void {
  if (!isObject(v)) {
    errors.push({ path, message: 'doit etre un objet produit' });
    return;
  }
  if (!isString(v.name)) {
    errors.push({ path: `${path}.name`, message: 'doit etre une string' });
  }
  if (v.ref !== null && v.ref !== undefined && !isString(v.ref)) {
    errors.push({ path: `${path}.ref`, message: 'doit etre une string ou null' });
  }
  if (v.color !== null && v.color !== undefined && !isString(v.color)) {
    errors.push({ path: `${path}.color`, message: 'doit etre une string ou null' });
  }
  if (v.image_path !== null && v.image_path !== undefined && !isString(v.image_path)) {
    errors.push({ path: `${path}.image_path`, message: 'doit etre une string ou null' });
  }
  // specs (optional)
  if (v.specs !== undefined) {
    if (!isArray(v.specs)) {
      errors.push({ path: `${path}.specs`, message: 'doit etre un tableau' });
    } else {
      v.specs.forEach((s, i) => validatePlanProductSpec(s, `${path}.specs[${i}]`, errors));
    }
  }
  // variants (optional)
  if (v.variants !== undefined) {
    if (!isArray(v.variants)) {
      errors.push({ path: `${path}.variants`, message: 'doit etre un tableau' });
    } else {
      v.variants.forEach((va, i) => validatePlanProductVariant(va, `${path}.variants[${i}]`, errors));
    }
  }
}

function validatePlanProductSpec(v: unknown, path: string, errors: ValidationError[]): void {
  if (!isObject(v)) {
    errors.push({ path, message: 'doit etre un objet { key, values }' });
    return;
  }
  if (!isString(v.key)) errors.push({ path: `${path}.key`, message: 'doit etre une string' });
  if (!isArray(v.values)) {
    errors.push({ path: `${path}.values`, message: 'doit etre un tableau de strings' });
  } else {
    v.values.forEach((val, i) => {
      if (!isString(val)) errors.push({ path: `${path}.values[${i}]`, message: 'doit etre une string' });
    });
  }
}

function validatePlanProductVariant(v: unknown, path: string, errors: ValidationError[]): void {
  if (!isObject(v)) {
    errors.push({ path, message: 'doit etre un objet { color, label }' });
    return;
  }
  if (!isHexColor(v.color)) errors.push({ path: `${path}.color`, message: 'doit etre #rrggbb' });
  if (v.label !== null && v.label !== undefined && !isString(v.label)) {
    errors.push({ path: `${path}.label`, message: 'doit etre une string ou null' });
  }
}

function validateOpEraseRect(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  if (!isBbox(v.bbox)) {
    errors.push({ path: `${path}.bbox`, message: 'doit etre [x0, y0, x1, y1]' });
  }
}

function validateOpDrawCircle(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  if (!isArray(v.center) || v.center.length !== 2 || !v.center.every((n) => isNumber(n))) {
    errors.push({ path: `${path}.center`, message: 'doit etre [x, y]' });
  }
  if (!isNumber(v.radius) || (v.radius as number) < 0) {
    errors.push({ path: `${path}.radius`, message: 'doit etre un nombre >= 0' });
  }
  if (!isHexColor(v.color)) {
    errors.push({ path: `${path}.color`, message: 'doit etre #rrggbb' });
  }
}

function validateOpDrawImage(v: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  if (!isBbox(v.bbox)) {
    errors.push({ path: `${path}.bbox`, message: 'doit etre [x0, y0, x1, y1]' });
  }
  if (!isString(v.image_path) || (v.image_path as string).length === 0) {
    errors.push({ path: `${path}.image_path`, message: 'doit etre une string non vide' });
  }
  if (v.fit !== undefined && !isOneOf(v.fit, ['contain', 'cover', 'stretch'])) {
    errors.push({ path: `${path}.fit`, message: 'doit etre "contain", "cover" ou "stretch"' });
  }
}

// ─── stats ──────────────────────────────────────────────────────────────────

function validateStats(v: unknown, errors: ValidationError[]): void {
  if (!isObject(v)) {
    errors.push({ path: 'stats', message: 'doit etre un objet' });
    return;
  }
  for (const k of ['products_used', 'products_remaining', 'pages_kept', 'pages_deleted'] as const) {
    if (v[k] !== undefined && (!isInteger(v[k]) || (v[k] as number) < 0)) {
      errors.push({ path: `stats.${k}`, message: 'doit etre un entier >= 0 si present' });
    }
  }
}

// Unused but re-exported for tests
export { validatePagePlan, validateOperation, validatePlanProduct };
export type _internals =
  | Operation
  | PagePlan
  | PageRender
  | PlanProduct
  | PlanProductSpec
  | PlanProductVariant;

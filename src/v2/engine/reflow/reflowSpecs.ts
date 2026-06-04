/**
 * @deprecated reflowSpecs V1 — DEPRECATED depuis Phase 2 refacto.
 * Conserve uniquement pour rollback via REFLOW_SPECS=v1. Le path par
 * defaut est reflowSpecsV2.ts. Sera supprime dans une version future.
 *
 * reflowSpecs — substitue les specs (key/value) d'un produit en respectant
 * la geometrie du template avec adaptation OVERFLOW (plus de specs que de
 * lignes prevues).
 *
 * Strategies :
 *
 *  Cas 1 — n_new <= n_tpl (normal) : on emet n_new specs aux positions
 *  template, ajustant la taille des values uniformement (shrink jusqu'a
 *  78%) pour qu'elles tiennent sur 1 ligne. Si une value depasse meme
 *  a la taille min : wrap 2 lignes + ellipse en dernier recours.
 *
 *  Cas 2 — n_new > n_tpl (OVERFLOW) : on calcule un yStep adaptatif pour
 *  faire tenir TOUTES les nouvelles specs dans la zone disponible. Si le
 *  yStep adaptif est trop serre pour la lisibilite (< refSize * 1.10), on
 *  capture le max qui tient et on signale "+N autres" sur la derniere ligne.
 *
 *  Cas 3 — n_new < n_tpl (underflow) : on emet n_new specs aux positions
 *  template, les lignes restantes sont effacees mais pas remplies (bunched
 *  en haut). Choix volontaire : eviter l'effet "ballonne" si on etirait
 *  yStep, et la zone reste visuellement coherente avec le reste du bloc.
 */

import type { Bbox, Operation, PlanProduct } from '../../types';
import type { ProductBlock } from '../blockDetector';
import type { TemplateProfile } from '../profile';
import { safeText } from '../safeText';
import { estimateTextWidth, splitForWrap, cleanupLineEnd } from './fit';
import { styleKeyFromTemplate } from './keyStyle';

const VALUE_FONT_SHRINK_MIN_RATIO = 0.78;
const VALUE_FONT_SHRINK_STEP = 0.25;
const SPEC_MIN_YSTEP_RATIO = 1.10;
/** Ratio yStep par defaut (interligne template) quand on ne peut pas
 *  mesurer une mediane sur les specs existants (= 1 seule spec, ou ecarts
 *  abherrants). Cal sur Catalogue A : refSize 11pt → yStep 14.5pt. Compromis
 *  lisibilite (>= 1.32x) vs compactage (<= 1.4x). Audit mineur. */
const DEFAULT_YSTEP_RATIO = 1.32;
/** Si overflow et qu'on capture le max, on garde au moins ce nb avant
 *  d'écrire "+N autres". Évite "+8 autres" sur une page presque vide. */
const SPEC_OVERFLOW_RESERVE = 1;

export interface ReflowSpecsContext {
  pageWidth: number;
  profile: TemplateProfile;
}

export function reflowSpecs(
  block: ProductBlock,
  product: PlanProduct,
  ctx: ReflowSpecsContext
): Operation[] {
  const ops: Operation[] = [];
  const newSpecs = product.specs ?? [];
  const tplSpecs = block.specs;

  // Erase global zone specs
  const eraseRight = ctx.pageWidth - ctx.profile.ribbonMargin;
  const eraseBbox: Bbox = [
    block.specsXLeft - 2.0,
    block.specsYTop - 4.0,
    eraseRight,
    block.specsYBottom + 6.0,
  ];
  ops.push({ op: 'erase_rect', bbox: eraseBbox });

  if (newSpecs.length === 0 || tplSpecs.length === 0) return ops;

  // ── Géometrie de base depuis le template ────────────────────────────────
  const firstY = tplSpecs[0].key.bbox[1];
  const refSize = tplSpecs[0].key.size;

  // yStep médian template (fallback : DEFAULT_YSTEP_RATIO si 1 seule spec)
  let yStepTpl = refSize * DEFAULT_YSTEP_RATIO;
  if (tplSpecs.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < tplSpecs.length; i++) {
      const gap = tplSpecs[i].key.bbox[1] - tplSpecs[i - 1].key.bbox[1];
      if (gap > 0 && gap < refSize * 2.0) gaps.push(gap);
    }
    if (gaps.length > 0) {
      gaps.sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)];
      yStepTpl = Math.max(refSize * DEFAULT_YSTEP_RATIO, median);
    }
  }

  // ── Décision overflow / normal / underflow ──────────────────────────────
  const n_new = newSpecs.length;
  const n_tpl = tplSpecs.length;

  // Pour overflow : calcul du yStep adaptatif et nombre max effectif
  const availableH = block.specsYBottom - firstY;
  const minStep = refSize * SPEC_MIN_YSTEP_RATIO;
  let n_effective = n_new;
  let yStep = yStepTpl;
  let overflowSurplus = 0;

  if (n_new > n_tpl) {
    // Combien tiennent au yStep template ?
    const fitsAtTpl = Math.floor(availableH / yStepTpl) + 1;
    if (fitsAtTpl >= n_new) {
      // Tient avec le yStep template (rare mais possible si availableH grand)
      n_effective = n_new;
      yStep = yStepTpl;
    } else {
      // Compaction : yStep adapté pour faire tenir tout
      const compactedStep = availableH / Math.max(1, n_new - 1);
      if (compactedStep >= minStep) {
        // Compaction acceptable → tout rentre
        yStep = compactedStep;
        n_effective = n_new;
      } else {
        // Trop serré : capture le max qui tient au minStep + reserve 1
        // ligne pour le signal "+N autres"
        const maxAtMinStep = Math.floor(availableH / minStep) + 1;
        n_effective = Math.max(SPEC_OVERFLOW_RESERVE, maxAtMinStep - 1);
        if (n_effective >= n_new) {
          n_effective = n_new;
        } else {
          overflowSurplus = n_new - n_effective;
        }
        yStep = minStep;
      }
    }
  }

  // ── Pré-pass : calcul des largeurs et taille uniforme des values ────────
  interface RowComputed {
    tplKeyIdx: number; // index dans tplSpecs (capé à n_tpl-1 si on extrapole)
    keyText: string;
    keyX: number;
    keyEndX: number;
    valueX: number;
    availableW: number;
    safeVal: string;
    originalValSize: number;
    keyFont: string;
    keyColor: string;
    keySize: number;
    valFont: string;
    valColor: string;
  }
  const rows: RowComputed[] = [];
  for (let i = 0; i < n_effective; i++) {
    // Pour i >= n_tpl, on extrapole depuis le dernier tplSpec
    const tplIdx = Math.min(i, n_tpl - 1);
    const tplKey = tplSpecs[tplIdx].key;
    const tplVal = tplSpecs[tplIdx].values[0];
    const newSpec = newSpecs[i];
    const keyText = styleKeyFromTemplate(newSpec.key, tplKey.text);
    const estKeyW = estimateTextWidth(keyText, tplKey.size) * 1.08;
    const tplKeyW = tplKey.bbox[2] - tplKey.bbox[0];
    const keyEndX = tplKey.bbox[0] + Math.max(tplKeyW, estKeyW);
    const minGap = tplKey.size * 0.3;
    const tplGap = tplVal ? Math.max(minGap, tplVal.bbox[0] - tplKey.bbox[2]) : minGap;
    const valueX = keyEndX + tplGap; // sera ecrase par colValueX uniforme plus bas
    const valueText = (newSpec.values ?? []).join(', ').trim();
    const safeVal = safeText(valueText);
    const originalValSize = tplVal?.size ?? tplKey.size;
    rows.push({
      tplKeyIdx: tplIdx,
      keyText, keyX: tplKey.bbox[0], keyEndX, valueX, availableW: 0, safeVal,
      originalValSize,
      keyFont: tplKey.font, keyColor: tplKey.color, keySize: tplKey.size,
      valFont: tplVal?.font ?? tplKey.font, valColor: tplVal?.color ?? tplKey.color,
    });
  }

  // ─── Alignement COLONNE VALUE uniforme ───────────────────────────────────
  // Au lieu de placer chaque value juste apres sa propre key (valueX par row,
  // dispersion visuelle), on aligne toutes les values sur une colonne unique
  // = max(valueX) sur l'ensemble des rows. Donne une lecture plus propre.
  const colValueX = rows.length > 0
    ? Math.max(...rows.map((r) => r.valueX))
    : block.specsXLeft;
  const colAvailableW = Math.max(20, eraseRight - colValueX);
  for (const r of rows) {
    r.valueX = colValueX;
    r.availableW = colAvailableW;
  }

  // Taille value uniforme (shrink jusqu'a 78% pour faire tenir tout sur 1 ligne)
  const refValSize = rows[0]?.originalValSize ?? refSize;
  const floorSize = refValSize * VALUE_FONT_SHRINK_MIN_RATIO;
  let uniformValSize = refValSize;
  for (const r of rows) {
    if (!r.safeVal) continue;
    let s = uniformValSize;
    while (estimateTextWidth(r.safeVal, s) > r.availableW && s > floorSize) {
      s -= VALUE_FONT_SHRINK_STEP;
    }
    if (s < uniformValSize) uniformValSize = s;
  }

  // ── Émission des ops par row ─────────────────────────────────────────────
  // yOffset cumulatif : decale les rows suivants quand une row precedente a
  // wrap sur 2 lignes (sinon la ligne 2 chevauche la key de la row suivante).
  let yOffset = 0;
  let emittedCount = 0;
  let runtimeTruncated = 0;
  for (let i = 0; i < n_effective; i++) {
    const r = rows[i];
    const tplKey = tplSpecs[r.tplKeyIdx].key;
    const lineH = tplKey.bbox[3] - tplKey.bbox[1];
    const keyY0 = firstY + i * yStep + yOffset;
    const keyY1 = keyY0 + lineH;

    // Stop runtime UNIQUEMENT si on a deja compacte yStep (overflow upstream)
    // et qu'on sort de la zone. Si yStep = yStep template, on accepte un
    // leger debordement (comportement legacy : le bloc suivant a ses propres
    // erases qui couvriront, et plus important : on perd pas la spec).
    const hasCompacted = yStep < yStepTpl;
    if (hasCompacted && keyY1 > block.specsYBottom + 4) {
      runtimeTruncated = n_effective - i;
      break;
    }

    ops.push({
      op: 'insert_text',
      bbox: [r.keyX, keyY0, r.keyEndX, keyY1],
      text: safeText(r.keyText),
      font: r.keyFont,
      size: r.keySize,
      color: r.keyColor,
    });
    emittedCount = i + 1;

    if (!r.safeVal) continue;
    const fullVal = r.safeVal;
    const fullW = estimateTextWidth(fullVal, uniformValSize);
    if (fullW <= r.availableW) {
      ops.push({
        op: 'insert_text',
        bbox: [r.valueX, keyY0, Math.min(eraseRight, r.valueX + fullW), keyY1],
        text: fullVal,
        font: r.valFont,
        size: uniformValSize,
        color: r.valColor,
      });
    } else {
      // Wrap 2 lignes via breakpoints semantiques (', et, ou, /, -, ;...).
      const split = splitForWrap(fullVal, r.availableW, uniformValSize);
      const line1 = split.line1;
      const line1W = estimateTextWidth(line1, uniformValSize);
      ops.push({
        op: 'insert_text',
        bbox: [r.valueX, keyY0, Math.min(eraseRight, r.valueX + line1W), keyY1],
        text: line1,
        font: r.valFont,
        size: uniformValSize,
        color: r.valColor,
      });
      if (split.line2) {
        let line2 = split.line2;
        let l2W = estimateTextWidth(line2, uniformValSize);
        if (l2W > r.availableW) {
          // Line 2 deborde → troncature avec ellipse (cleanup particules).
          const ellW = estimateTextWidth('…', uniformValSize);
          while (line2.length > 4 && estimateTextWidth(line2, uniformValSize) + ellW > r.availableW) {
            line2 = line2.slice(0, -1);
          }
          line2 = cleanupLineEnd(line2) + '…';
          l2W = estimateTextWidth(line2, uniformValSize);
        }
        const y2 = keyY0 + yStep * 0.5;
        ops.push({
          op: 'insert_text',
          bbox: [r.valueX, y2, Math.min(eraseRight, r.valueX + l2W), y2 + lineH],
          text: line2,
          font: r.valFont,
          size: uniformValSize,
          color: r.valColor,
        });
        // Décale les rows suivantes pour eviter que la 2e ligne de wrap
        // chevauche la key de la row n+1.
        const wrapGap = 2;
        const extra = Math.max(0, lineH + wrapGap - yStep * 0.5);
        yOffset += extra;
      }
    }
  }

  // Cumul des surplus : overflow upstream + truncated runtime (wraps consomment
  // plus de place que prevu)
  overflowSurplus += runtimeTruncated;

  // ── Signal overflow surplus ──────────────────────────────────────────────
  if (overflowSurplus > 0 && rows.length > 0) {
    const last = rows[Math.max(0, emittedCount - 1)];
    const tplKeyLast = tplSpecs[last.tplKeyIdx].key;
    // Position basée sur emittedCount + yOffset cumulé (tient compte des
    // wraps qui ont consommé du budget vertical)
    const noteY0 = firstY + emittedCount * yStep + yOffset;
    if (noteY0 + tplKeyLast.bbox[3] - tplKeyLast.bbox[1] <= block.specsYBottom + 4) {
      ops.push({
        op: 'insert_text',
        bbox: [last.keyX, noteY0, eraseRight, noteY0 + (tplKeyLast.bbox[3] - tplKeyLast.bbox[1])],
        text: `+ ${overflowSurplus} autre${overflowSurplus > 1 ? 's' : ''} caractéristique${overflowSurplus > 1 ? 's' : ''}`,
        font: last.valFont,
        size: uniformValSize * 0.92,
        color: last.valColor,
      });
    }
  }

  return ops;
}

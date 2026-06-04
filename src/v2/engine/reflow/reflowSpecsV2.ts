/**
 * reflowSpecsV2 — refonte du rendu des specs produit.
 *
 * Design : tableau 2 colonnes (key + dot leader + value) avec regroupement
 * par categorie (TECHNIQUE / DIMENSIONS / FINITION / GARANTIE /
 * CONDITIONNEMENT / AUTRES). Headers de categorie en gras petit, separateurs
 * fins entre groupes.
 *
 * Responsive :
 *  - peu (≤ 3 specs)     → pas de categories, vue aeree + interligne large
 *  - moyen (4-8 specs)   → tableau categorise standard
 *  - beaucoup (> 8 specs) → tableau compact (font value shrink + interligne
 *                          serre pour faire tenir tout)
 *
 * Layout colonne :
 *  - keyX  = block.specsXLeft (heritage template)
 *  - valX  = max(keyEndX) + gap uniforme sur toutes les rows
 *  - valW  = pageWidth - ribbonMargin - valX
 *  - dot leader entre keyEnd et valX en couleur grise tres claire
 *
 * Categorisation : regex sur les keys (insensible casse), fallback AUTRES.
 *
 * Anti-debordement : si meme apres font shrink la zone deborde, on signale
 * "+N autres" sur la derniere row visible (comme reflowSpecs V1).
 */

import type { Bbox, Operation, PlanProduct, PlanProductSpec } from '../../types';
import type { ProductBlock } from '../blockDetector';
import type { TemplateProfile } from '../profile';
import { safeText } from '../safeText';
import { estimateTextWidth, splitForWrap, cleanupLineEnd } from './fit';
import { normalizeValue } from './normalizeValue';
import { styleKeyFromTemplate } from './keyStyle';

// ── Categorisation ──────────────────────────────────────────────────────────

export type CategoryKey =
  | 'TECHNIQUE'
  | 'DIMENSIONS'
  | 'FINITION'
  | 'GARANTIE'
  | 'CONDITIONNEMENT'
  | 'AUTRES';

interface CategoryDef {
  key: CategoryKey;
  /** Label affiche dans le header. */
  label: string;
  /** Regex de matching des keys (insensible casse). */
  re: RegExp;
}

/** Ordre d'affichage des categories quand plusieurs sont presentes : on
 *  privilegie technique d'abord, puis dimensions, finition, garantie,
 *  conditionnement, et enfin les autres. */
const CATEGORIES: CategoryDef[] = [
  // TECHNIQUE : matière / mécanisme / débit / pression / température / norme
  // Multi-langue : FR + EN (material/mechanism/flow/pressure/temperature/standard)
  //               + DE (material/druck) + IT/ES (materia/presion) + PT (materia)
  { key: 'TECHNIQUE', label: 'Technique',
    re: /mati(?:è|e)re|material|materia|m(?:é|e)canisme|mechanism|meccanismo|m(?:é|e)ca\b|d(?:é|e)bit|flow|pression|pressure|druck|presion|temp(?:é|e)rature|temperature|norme|standard|certif|(?:é|e)nerg(?:é|e)tique|energy|(?:é|e)nergi|raccord|fitting|alim|power|cartouche|cartridge/i },
  // DIMENSIONS : longueur / largeur / hauteur / profondeur / épaisseur / taille / format
  // Multi-langue : FR + EN (length/width/height/depth/thickness/size/format)
  //               + DE (länge/breite/höhe/tiefe — translit) + IT (lunghezza/larghezza/altezza)
  //               + ES (longitud/anchura/altura/profundidad)
  { key: 'DIMENSIONS', label: 'Dimensions',
    re: /longueur|length|longitud|lunghezza|comprimento|laenge|l(?:ä|a)nge|diam(?:è|e)tre|diameter|diametro|durchmesser|hauteur|height|altura|altezza|h(?:ö|o)he|largeur|width|anchura|larghezza|breite|profondeur|depth|profundidad|profondit|tiefe|(?:é|e)paisseur|thickness|espesor|spessore|dicke|taille|size|tama|format|capacit|capacity|capacidad|capacita|encombrement|entr(?:é|e)es?\s+axes/i },
  // FINITION : couleur / finition / aspect / texture
  // Multi-langue : FR + EN (color/finish/aspect/texture) + DE (farbe/oberflache)
  //               + IT (colore/finitura) + ES (color/acabado) + PT (cor/acabamento)
  { key: 'FINITION', label: 'Finition',
    re: /coloris|finition|finish|couleur|color|colour|farbe|cor\b|colore|aspect|aspecto|texture|textur|oberfl(?:ä|a)che|acabado|acabamento|finitura/i },
  // GARANTIE : duree / durabilite / SAV
  // Multi-langue : FR + EN (warranty/durability/service) + DE (garantie/dauer)
  //               + IT (garanzia/durata) + ES (garantia/duracion) + PT (garantia/duracao)
  { key: 'GARANTIE', label: 'Garantie',
    re: /garantie|warranty|garant[ií]a|garanzia|dur(?:é|e)e|duration|durata|duracao|duraci(?:ó|o)n|dauer|durabilit|durability|sav\b|service/i },
  // CONDITIONNEMENT : emballage / packaging / carton / blister / boite
  // Multi-langue : FR + EN (packaging/box) + DE (verpackung/karton)
  //               + IT (imballaggio/scatola) + ES (embalaje/caja) + PT (embalagem/caixa)
  { key: 'CONDITIONNEMENT', label: 'Conditionnement',
    re: /conditionnement|emballage|packaging|embalaje|embalagem|imballaggio|verpackung|condit\.?|nature.*conditionnement|carton|karton|cartone|caja|caixa|bo[iî]te|box|scatola|coque|blister/i },
];

/** Categorise une key vers une CategoryKey. Cas non match → AUTRES. */
export function categorize(key: string): CategoryKey {
  const k = key.trim();
  for (const cat of CATEGORIES) {
    if (cat.re.test(k)) return cat.key;
  }
  return 'AUTRES';
}

interface SpecWithCat {
  spec: PlanProductSpec;
  category: CategoryKey;
}

interface CategoryGroup {
  key: CategoryKey;
  label: string;
  specs: PlanProductSpec[];
}

/** Repartit les specs par categorie en preservant l'ordre d'apparition
 *  d'origine au sein de chaque categorie. Categories vides droppees. */
export function groupByCategory(specs: PlanProductSpec[]): CategoryGroup[] {
  const withCat: SpecWithCat[] = specs.map((s) => ({ spec: s, category: categorize(s.key) }));
  const groups: CategoryGroup[] = [];
  const known: CategoryKey[] = ['TECHNIQUE', 'DIMENSIONS', 'FINITION', 'GARANTIE', 'CONDITIONNEMENT', 'AUTRES'];
  for (const cat of known) {
    const matching = withCat.filter((w) => w.category === cat).map((w) => w.spec);
    if (matching.length === 0) continue;
    const def = CATEGORIES.find((c) => c.key === cat);
    groups.push({ key: cat, label: def ? def.label : 'Autres', specs: matching });
  }
  return groups;
}

// ── Constantes layout ───────────────────────────────────────────────────────

/** Plancher du shrink relativement a la taille de DEPART. 0.88 = on tolere
 *  au plus 12% de reduction, sinon on wrap. Plus haut que V1 (0.72) pour
 *  garder les values bien lisibles. */
const VALUE_FONT_SHRINK_MIN_RATIO = 0.88;
const VALUE_FONT_SHRINK_STEP = 0.25;
/** Largeur MIN reservee a la colonne value (pt). Force la troncature ou le
 *  shrink des keys longues si necessaire, plutot que de laisser les keys
 *  coloniser toute la largeur et reduire la colonne value a quasi rien. */
const MIN_VALUE_COL_W = 110;
/** Plancher du shrink applique aux KEYS quand elles depassent le plafond
 *  colValueX impose. */
const KEY_FONT_SHRINK_MIN_RATIO = 0.80;
const KEY_VAL_GAP = 8;
const DOT_LEADER_CHAR = '·';
const DOT_LEADER_COLOR = '#bdbdbd';
const SEPARATOR_COLOR = '#e5e5e5';
const SEPARATOR_THICKNESS = 0.4;
const SEPARATOR_GAP_PT = 4;
const CATEGORY_HEADER_SIZE_RATIO = 0.85;
const CATEGORY_HEADER_COLOR = '#666666';
const CATEGORY_HEADER_GAP_PT = 2;
/** Seuil pour passer en mode aere (sans headers de categorie). */
const FEW_SPECS_THRESHOLD = 3;
/** Seuil pour passer en mode compact (font shrink + interligne serre). */
const MANY_SPECS_THRESHOLD = 9;
/** Interligne max pour la vue aeree : on ne souhaite pas etaler outre mesure. */
const AERATED_LINE_SPACING_RATIO = 1.60;
const STANDARD_LINE_SPACING_RATIO = 1.35;
const COMPACT_LINE_SPACING_RATIO = 1.10;

// Style key (heritage template) : voir reflow/keyStyle.ts — implementation
// consolidee (audit #5) partagee avec reflowSpecs.ts.

// ── Entry point ─────────────────────────────────────────────────────────────

export interface ReflowSpecsV2Context {
  pageWidth: number;
  profile: TemplateProfile;
  /** Mode multi-cols horizontal (S6.5).
   *  - 'vertical' (default) : layout standard, 1 produit par bloc.
   *  - 'horizontal-primary' : 1er bloc d'une row horizontale (emet keys
   *    en col gauche partagee + values dans sa colonne).
   *  - 'horizontal-secondary' : bloc suivant d'une row horizontale (emet
   *    SEULEMENT ses values dans sa colonne, pas les keys).
   *
   *  Quand non specifie : 'vertical'. Comportement backward-compatible. */
  horizontalMode?: 'vertical' | 'horizontal-primary' | 'horizontal-secondary';
  /** X droit de la colonne du bloc courant (mode horizontal).
   *  Au-dela : zone du bloc voisin → eviter d'eraser/inserer la-bas. */
  horizontalColRight?: number;
}

export function reflowSpecsV2(
  block: ProductBlock,
  product: PlanProduct,
  ctx: ReflowSpecsV2Context
): Operation[] {
  const ops: Operation[] = [];
  const newSpecs = product.specs ?? [];
  const tplSpecs = block.specs;
  if (tplSpecs.length === 0) return ops;

  // Zone d'effacement = pleine largeur specs jusqu'au ribbon margin.
  // Clamp protection : si specsYTop < nameSpan.bbox[3] (ex Catalogue E dense),
  // l'erase mordrait sur le nameSpan qui a deja ete insere par reflowName.
  // On force eraseTop >= nameSpan.bbox[3] + 1 (1pt gap) pour preserver le nom.
  //
  // Mode horizontal (S6.5) : en horizontal-primary ET horizontal-secondary,
  // on limite l'erase a la colonne du bloc (horizontalColRight) pour ne pas
  // effacer le contenu des blocs voisins meme row. Avant le fix, seul le
  // secondary etait clampe → primary effacait pleine page AVANT secondary
  // → conflit ordre erase/insert.
  const isHorizontal =
    ctx.horizontalMode === 'horizontal-secondary'
    || ctx.horizontalMode === 'horizontal-primary';
  const isHorizontalSecondary = ctx.horizontalMode === 'horizontal-secondary';
  const eraseRight = isHorizontal && ctx.horizontalColRight !== undefined
    ? ctx.horizontalColRight
    : ctx.pageWidth - ctx.profile.ribbonMargin;
  const nameBottom = block.nameSpan?.bbox?.[3];
  const rawEraseTop = block.specsYTop - 4;
  const safeEraseTop =
    typeof nameBottom === 'number'
      ? Math.max(rawEraseTop, nameBottom + 1)
      : rawEraseTop;
  // Pad gauche elargi (-12 vs -2) pour absorber les keys template longues
  // qui peuvent demarrer 2-6pt a gauche de specsXLeft (jitter PDFium baseline
  // + glyph metrics). Faille Catalogue C P6 "DIAMÈTREÈTRE" : ancien template
  // "Diamètre :" pas efface par l'erase fond, nouveau "DIAMÈTRE MAXIMUM..."
  // inscrit par-dessus → superposition visuelle.
  const eraseBbox: Bbox = [
    block.specsXLeft - 12,
    safeEraseTop,
    eraseRight,
    block.specsYBottom + 6,
  ];
  ops.push({ op: 'erase_rect', bbox: eraseBbox });

  if (newSpecs.length === 0) return ops;

  // Style template : heritage de la 1ere spec template (font/size/color key + value)
  const refKey = tplSpecs[0].key;
  const refVal = tplSpecs[0].values[0] ?? refKey;
  const refKeyFont = refKey.font;
  const refKeySize = refKey.size;
  const refKeyColor = refKey.color;
  const refValFont = refVal.font;
  const refValSize = refVal.size;
  const refValColor = refVal.color;

  // ── Decision mode responsive ────────────────────────────────────────────
  const n = newSpecs.length;
  const aerated = n <= FEW_SPECS_THRESHOLD;
  const compact = n >= MANY_SPECS_THRESHOLD;
  const useCategories = !aerated;

  // Regroupement (si mode tableau categorise)
  const groups = useCategories
    ? groupByCategory(newSpecs)
    : [{ key: 'AUTRES' as CategoryKey, label: '', specs: newSpecs }];

  // ── Calcul des largeurs : colonne value uniforme = max(keyEndX) ─────────
  // On precalcule chaque key stylee + sa largeur estimee pour decider valX.
  // keySize peut etre shrunk si les keys debordent le plafond colValueX.
  let keyFontSize = refKeySize;
  const keyFloorSize = refKeySize * KEY_FONT_SHRINK_MIN_RATIO;
  interface RowInfo {
    keyText: string;
    keyEndX: number;
    safeVal: string;
  }
  // Plafond colValueX : on garde au minimum MIN_VALUE_COL_W pour la colonne
  // value. Evite qu'une key tres longue ("DUREE DE GARANTIE (EN ANNEES) :")
  // ne pousse colValueX trop a droite et reduise la zone value a presque rien.
  const colValueXCap = eraseRight - MIN_VALUE_COL_W;

  function computeKeyEnd(keyText: string, size: number): number {
    const estKeyW = estimateTextWidth(keyText, size) * 1.08;
    const tplKeyW = refKey.bbox[2] - refKey.bbox[0];
    return block.specsXLeft + Math.max(tplKeyW, estKeyW);
  }

  // 1ere passe : keys a taille pleine
  const rowInfos: RowInfo[] = [];
  for (const g of groups) {
    for (const s of g.specs) {
      const keyText = styleKeyFromTemplate(s.key, refKey.text);
      const keyEndX = computeKeyEnd(keyText, keyFontSize);
      // Normalisation par value (espaces unites, casse) AVANT le join,
      // pour que les regles s'appliquent a chaque value individuelle.
      const valueText = (s.values ?? []).map(normalizeValue).join(', ').trim();
      rowInfos.push({ keyText, keyEndX, safeVal: safeText(valueText) });
    }
  }
  // Si une key depasse le cap : on shrink uniformement les keys du bloc
  let maxKeyEndX = rowInfos.length > 0
    ? Math.max(...rowInfos.map((r) => r.keyEndX))
    : block.specsXLeft;
  if (maxKeyEndX + KEY_VAL_GAP > colValueXCap && rowInfos.length > 0) {
    while (keyFontSize > keyFloorSize
        && maxKeyEndX + KEY_VAL_GAP > colValueXCap) {
      keyFontSize -= 0.25;
      // recalc maxKeyEndX
      maxKeyEndX = Math.max(
        ...rowInfos.map((r) => computeKeyEnd(r.keyText, keyFontSize))
      );
    }
    // Mise a jour des keyEndX recalculees avec la nouvelle keyFontSize
    for (const r of rowInfos) {
      r.keyEndX = computeKeyEnd(r.keyText, keyFontSize);
    }
  }
  // Mode horizontal multi-cols (S6.5) : la valeur de chaque bloc doit etre
  // dans la COL DU BLOC (X=nameSpan.bbox[0]) pas dans la col gauche commune.
  // Sinon les 3 valeurs des 3 blocs s'empilent au meme X (cas Catalogue C P14 :
  // "Puissance $800w" = 900W+1200W+1500W superposees illisible).
  const colValueX = isHorizontal
    ? Math.min(block.nameSpan.bbox[0], colValueXCap)
    : Math.min(maxKeyEndX + KEY_VAL_GAP, colValueXCap);
  const colAvailableW = Math.max(MIN_VALUE_COL_W, eraseRight - colValueX);

  // ── Shrink font value pour faire tenir sur 1 ligne (uniforme bloc) ──────
  // Taille de DEPART = refKeySize (= meme taille que la key). Cas template
  // ou la value template a une taille reduite par convention : on l'ignore
  // pour viser la meme lisibilite que les keys. La key shrink eventuelle
  // (keyFontSize < refKeySize) n'affecte PAS la value (les values restent
  // lisibles meme si keys un poil tassees).
  const startSize = refKeySize;
  const floorSize = startSize * VALUE_FONT_SHRINK_MIN_RATIO;
  let uniformValSize = startSize;
  for (const r of rowInfos) {
    if (!r.safeVal) continue;
    let s = uniformValSize;
    while (estimateTextWidth(r.safeVal, s) > colAvailableW && s > floorSize) {
      s -= VALUE_FONT_SHRINK_STEP;
    }
    if (s < uniformValSize) uniformValSize = s;
  }

  // ── Layout vertical : on calcule yStep adaptatif selon mode ────────────
  const lineH = refKey.bbox[3] - refKey.bbox[1];
  const lineSpacingRatio = aerated ? AERATED_LINE_SPACING_RATIO
    : compact ? COMPACT_LINE_SPACING_RATIO
    : STANDARD_LINE_SPACING_RATIO;
  let yStep = refKeySize * lineSpacingRatio;
  // Categorie header height + gap
  const catHeaderSize = refKeySize * CATEGORY_HEADER_SIZE_RATIO;
  const catHeaderH = catHeaderSize * 1.15 + CATEGORY_HEADER_GAP_PT;
  // Nombre d'elements verticaux total
  const nCatHeaders = useCategories ? groups.length : 0;
  const nSeparators = useCategories ? Math.max(0, groups.length - 1) : 0;
  const totalNeededH = nCatHeaders * catHeaderH
    + n * yStep
    + nSeparators * SEPARATOR_GAP_PT;
  const availableH = block.specsYBottom - block.specsYTop;
  // Si on deborde, on serre le yStep
  if (totalNeededH > availableH && n > 0) {
    const surplus = totalNeededH - availableH;
    const reduction = surplus / n;
    yStep = Math.max(refKeySize * COMPACT_LINE_SPACING_RATIO, yStep - reduction);
  }

  // ── Emission ops ─────────────────────────────────────────────────────────
  let y = block.specsYTop;
  let emittedCount = 0;
  let overflowSurplus = 0;
  let rowIdx = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    // Separator entre categories (pas avant la 1ere)
    if (useCategories && gi > 0) {
      const sepY = y + SEPARATOR_GAP_PT * 0.4;
      ops.push({
        op: 'erase_rect',
        bbox: [block.specsXLeft, sepY, eraseRight, sepY + SEPARATOR_THICKNESS],
        color: SEPARATOR_COLOR,
      });
      y += SEPARATOR_GAP_PT;
    }
    // Header de categorie. On le masque dans 3 cas :
    //  - mode aere (pas de regroupement visuel)
    //  - categorie AUTRES (= specs non classees, on ne veut pas afficher un
    //    label "AUTRES" disgracieux ; les specs sont affichees sans header)
    //  - g.specs vide (defense en profondeur : groupByCategory devrait deja
    //    avoir droppe les categories sans specs)
    const showHeader = useCategories
      && g.label
      && g.key !== 'AUTRES'
      && g.specs.length > 0;
    if (showHeader) {
      const headerY0 = y;
      const headerY1 = y + catHeaderSize * 1.15;
      // Verifie qu'on a la place pour [header + au moins 1 ligne spec]
      const minNeeded = headerY1 + CATEGORY_HEADER_GAP_PT + lineH;
      if (minNeeded > block.specsYBottom + 4) {
        // Pas la place pour header + 1 spec : skip cette categorie entiere,
        // signale en overflow.
        overflowSurplus += g.specs.length;
        rowIdx += g.specs.length;
        continue;
      }
      ops.push({
        op: 'insert_text',
        bbox: [block.specsXLeft, headerY0, eraseRight, headerY1],
        text: g.label.toUpperCase(),
        font: refKeyFont,
        size: catHeaderSize,
        color: CATEGORY_HEADER_COLOR,
      });
      y = headerY1 + CATEGORY_HEADER_GAP_PT;
    }
    // Specs de la categorie
    for (let si = 0; si < g.specs.length; si++) {
      const spec = g.specs[si];
      const info = rowInfos[rowIdx];
      rowIdx++;
      const keyY0 = y;
      const keyY1 = y + lineH;
      // Verifie debordement zone
      if (keyY1 > block.specsYBottom + 4) {
        overflowSurplus = newSpecs.length - emittedCount;
        break;
      }
      // Mode horizontal-secondary : on skip l'emission des keys (col gauche
      // deja emise par le bloc primary de la row). On insere SEULEMENT les
      // values dans la colonne du bloc courant (S6.5 etape 3).
      const skipKeys = ctx.horizontalMode === 'horizontal-secondary';
      // Insert key (avec keyFontSize potentiellement shrunk si keys longues)
      if (!skipKeys) {
        ops.push({
          op: 'insert_text',
          bbox: [block.specsXLeft, keyY0, info.keyEndX, keyY1],
          text: safeText(info.keyText),
          font: refKeyFont,
          size: keyFontSize,
          color: refKeyColor,
        });
      }
      // Dot leader entre keyEnd et colValueX (largeur calculee dynamiquement)
      const leaderStartX = info.keyEndX + 2;
      const leaderEndX = colValueX - 2;
      const leaderW = leaderEndX - leaderStartX;
      if (leaderW > 6 && !skipKeys) {
        const dotW = estimateTextWidth(DOT_LEADER_CHAR + ' ', uniformValSize) || 2;
        const nDots = Math.max(0, Math.floor(leaderW / dotW));
        if (nDots > 0) {
          const leaderText = (DOT_LEADER_CHAR + ' ').repeat(nDots).trimEnd();
          ops.push({
            op: 'insert_text',
            bbox: [leaderStartX, keyY0, leaderEndX, keyY1],
            text: leaderText,
            font: refValFont,
            size: uniformValSize,
            color: DOT_LEADER_COLOR,
          });
        }
      }
      // Insert value (wrap si necessaire)
      if (info.safeVal) {
        const fullW = estimateTextWidth(info.safeVal, uniformValSize);
        if (fullW <= colAvailableW) {
          ops.push({
            op: 'insert_text',
            bbox: [colValueX, keyY0, Math.min(eraseRight, colValueX + fullW), keyY1],
            text: info.safeVal,
            font: refValFont,
            size: uniformValSize,
            color: refValColor,
          });
        } else {
          // Wrap 2 lignes via splitForWrap (semantic breakpoints)
          const split = splitForWrap(info.safeVal, colAvailableW, uniformValSize);
          ops.push({
            op: 'insert_text',
            bbox: [colValueX, keyY0, eraseRight, keyY1],
            text: split.line1,
            font: refValFont,
            size: uniformValSize,
            color: refValColor,
          });
          if (split.line2) {
            // Position Y de la 2e ligne d'une value wrappee.
            // V2 utilise yStep * 0.55 (V1 = 0.5) car le layout V2 a un
            // interligne plus aere (AERATED/STANDARD_LINE_SPACING_RATIO),
            // donc on peut se permettre un offset un peu plus grand sans
            // chevaucher la row suivante. Audit #10 documente.
            const y2 = keyY0 + yStep * 0.55;
            let line2 = split.line2;
            const l2W = estimateTextWidth(line2, uniformValSize);
            if (l2W > colAvailableW) {
              const ellW = estimateTextWidth('…', uniformValSize);
              while (line2.length > 4
                  && estimateTextWidth(line2, uniformValSize) + ellW > colAvailableW) {
                line2 = line2.slice(0, -1);
              }
              line2 = cleanupLineEnd(line2) + '…';
            }
            ops.push({
              op: 'insert_text',
              bbox: [colValueX, y2, eraseRight, y2 + lineH],
              text: line2,
              font: refValFont,
              size: uniformValSize,
              color: refValColor,
            });
            // Decale la row suivante. En mode compact (yStep proche de lineH),
            // l'ancien max(0, lineH + 1 - yStep*0.45) donnait une marge ~1pt
            // entre line2 bottom et next row top → chevauchement visuel
            // (descenders/ascenders). On force min 2pt extra (faille review #10).
            const wrapExtra = Math.max(2, lineH + 2 - yStep * 0.40);
            y += wrapExtra;
          }
        }
      }
      y += yStep;
      emittedCount++;
    }
    if (emittedCount < rowInfos.filter((_, idx) => idx < rowIdx).length) break;
  }

  // ── Signal overflow ─────────────────────────────────────────────────────
  if (overflowSurplus > 0 && emittedCount > 0) {
    const noteY0 = y - yStep + lineH + 2;
    if (noteY0 + lineH <= block.specsYBottom + 4) {
      ops.push({
        op: 'insert_text',
        bbox: [block.specsXLeft, noteY0, eraseRight, noteY0 + lineH],
        text: `+ ${overflowSurplus} autre${overflowSurplus > 1 ? 's' : ''} caractéristique${overflowSurplus > 1 ? 's' : ''}`,
        font: refValFont,
        size: uniformValSize * 0.92,
        color: refValColor,
      });
    }
  }

  return ops;
}

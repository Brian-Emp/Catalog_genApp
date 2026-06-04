/**
 * Detecte les blocs produit sur une page extracted, en utilisant un
 * TemplateProfile.
 *
 * Port TS de python/substitute.py:find_product_blocks (L1494). La logique est
 * 100% heuristique typographique + geometrique, pas de LLM.
 *
 * Sortie : un tableau de ProductBlock decrivant chaque fiche produit detectee
 * sur la page (souvent 2-4 par page selon le template).
 */

import type { Bbox, ExtractedPage, TextSpan } from '../types';
import type { TemplateProfile } from './profile';
import { hasKeyValueSeparator } from './keyValueSeparator';
import { isCommonColor } from './colorPalette';

export interface ProductSpecBlock {
  key: TextSpan;
  values: TextSpan[];
}

export interface ProductBlock {
  pageNumber: number;
  nameSpan: TextSpan;
  /** Nb de spans fusionnes pour former nameSpan (cas wrapping multi-ligne). */
  nameWrappedCount: number;
  refSpan: TextSpan | null;
  colorSpan: TextSpan | null;
  specs: ProductSpecBlock[];
  /** Bbox des vignettes carrees de variantes (extraites de raw_images). */
  variantImages: Bbox[];
  /** Spans labels associes aux variantes (sous le header, en colonne produit). */
  variantSpans: TextSpan[];
  /** Image principale du produit (la plus grande, a gauche de specs). */
  mainImageBbox: Bbox | null;
  yTop: number;
  yBottom: number;
  specsYTop: number;
  specsYBottom: number;
  specsXLeft: number;
  /** Layout horizontal (mode multi-cols type Catalogue C/Catalogue B) detecte sur
   *  cette page. Quand true, les blocs partagent leurs keys (col gauche
   *  commune) et leurs values en colonnes paralleles. Downstream
   *  (reflowSpecsV2) doit gerer ce cas specifiquement, sinon les ops
   *  visuelles se chevauchent. */
  isHorizontalLayout?: boolean;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** Calcule la tolerance Y pour grouper les nameSpans en rows (mode horizontal).
 *  Adaptee a la taille de police pour eviter d'etre trop strict sur grand
 *  format. Plancher 4pt (cas Catalogue A 16pt). */
export function computeYRowTolerance(nameSize: number): number {
  return Math.max(4, nameSize * 0.30);
}

/** Détecte les titres de section (CHECK-LIST, LES + PRODUITS, ACCESSOIRES...)
 *  qui peuvent ressembler à des noms produit (all-caps, taille moyenne, font
 *  bold-condensed) mais ne sont PAS des fiches substituables.
 *
 *  Faille Catalogue C P14 : "CHECK-LIST ACCESSOIRES" detecte comme 4e bloc produit
 *  → pipeline tente de le substituer avec un produit Catalogue D.
 *
 *  Critere : texte all-caps contenant un mot-cle section header reconnaissable.
 *  Multi-langue : FR, EN, DE, ES (catalogues internationaux). */
function looksLikeSectionHeader(text: string): boolean {
  const t = text.trim().toUpperCase();
  // FR : check-list, les + produits, accessoires...
  // Note : pas de \b final car les patterns finissant par symbole ("LES +")
  // sont suivis d'espaces non-word qui invalident \b.
  const FR_RE = /^(?:CHECK-?LIST|LES\s*\+|OPTIONS?|ACCESSOIRES?|CARACT[ÉE]RISTIQUES|GAMMES?|NOS\s+(?:MARQUES|GAMMES|PRODUITS|SOLUTIONS)|BIEN\s+CHOISIR|COMMENT\s+CHOISIR|CONSEILS?|RÉCAPITULATIF|FOURNIS|CONSEILL[ÉE]S|INFOS?\s+PRODUITS?|DESCRIPTION)(?=$|\s|[^A-Z])/i;
  const EN_RE = /^(?:CHECKLIST|ACCESSORIES|OPTIONS?|FEATURES?|PRODUCT\s+(?:HIGHLIGHTS|INFO|DETAILS)|HOW\s+TO\s+CHOOSE|CHOOSE\s+YOUR|TIPS?|SPECIFICATIONS?|INCLUDED|SUPPLIED|HIGHLIGHTS)(?=$|\s|[^A-Z])/i;
  const DE_RE = /^(?:ZUBEHÖR|OPTIONEN?|EIGENSCHAFTEN|TIPPS?|MERKMALE|PRODUKTINFO|TECHNISCHE\s+DATEN)(?=$|\s|[^A-Z])/i;
  const ES_RE = /^(?:ACCESORIOS?|OPCIONES?|CARACTER[ÍI]STICAS|VENTAJAS|CONSEJOS?|DETALLES|INCLUIDO)(?=$|\s|[^A-Z])/i;
  // Sous-titres catalogue Catalogue C : "POMPES D'ÉVACUATION POUR EAUX CLAIRES",
  // "POMPES D'ARROSAGE MANUELLES", "AUTRE POMPE 12V", "APRÈS-VENTE",
  // "FORMATIONS", "SERVICE", "AGRÉÉ", "EAUX CLAIRES/CHARGÉES/...".
  // Apostrophe : utilise \S pour matcher TOUS les guillemets/apostrophes
  // (ASCII ' U+0027, smart ’ U+2019, etc.) sans dependance Unicode codepoint.
  // Ces patterns ne matchent PAS les noms produit Catalogue A (catalogue plomberie
  // ne commence pas par "POMPES" et n'inclut pas ces termes service).
  const CATALOGC_SUBTITLES_RE = /^(?:POMPES?\s+(?:D\S|DE\s+|POUR\s+|À\s+)|AUTRE\s+POMPES?|APR[ÉE]S[-\s]VENTE|FORMATIONS?|AGR[ÉE]+|EAUX\s+(?:CLAIRES?|CHARG[ÉE]ES?|GRISES?|NOIRES?|US[ÉE]ES?)|GROUPES?\s+DE\s+(?:SURPRESSION|FILTRATION))/i;
  return FR_RE.test(t) || EN_RE.test(t) || DE_RE.test(t) || ES_RE.test(t) || CATALOGC_SUBTITLES_RE.test(t);
}

/** Détecte les mentions légales / copyright / notices marketing qui peuvent
 *  contaminer la zone specs (faille review : un span "© 2024 Marque, tous
 *  droits réservés" en font Regular dans la zone specs etait attribué a
 *  une spec comme value).
 *
 *  Critères (un seul suffit) :
 *   - contient un marqueur typographique de mention (©, ®, ™)
 *   - phrase tres longue (> 80 chars) avec mots multiples (≥ 8 mots)
 *   - commence par marqueur de notice : "Crédit", "Photo", "Document non"
 *
 *  Conservatif : ne touche JAMAIS une vraie value produit (courte, sans ©). */
export function looksLikeLegalNotice(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // Marqueurs typographiques
  if (/[©®™]/.test(t)) return true;
  // Patterns mention legale courants
  if (/^(Cr[ée]dit\s+photo|Photo\s+credit|Document\s+non\s+contractuel|Tous\s+droits\s+r[ée]serv[ée]s|All\s+rights\s+reserved)/i.test(t)) {
    return true;
  }
  // Phrase tres longue avec beaucoup de mots = notice/disclaimer
  if (t.length > 80) {
    const words = t.split(/\s+/).filter((w) => w.length > 1);
    if (words.length >= 8) return true;
  }
  return false;
}

/** Heuristique générique : détecte si un texte ressemble à un code-barre
 *  ou pictogramme imprimé.
 *
 *  Critères (un seul suffit) :
 *   - 100% chiffres + espaces (ref nue type EAN-13 "3325310022366")
 *   - >30% de symboles speciaux (barcode imprime "&:DCPNLA=UWWX[[:")
 *   - ratio lettres < 50% ET pas alphanum-pure
 *
 *  Exception (faille review #) : un texte alphanum-pure (lettres+chiffres
 *  >= 80%) court (<= 30 chars) est considere comme nom/ref legitime, meme
 *  si le ratio lettres est faible (cas Catalogue E "DN50 PN16", refs courtes
 *  alphanum "AB12345"). */
export function looksLikeBarcode(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  const nonWs = trimmed.replace(/\s/g, '');
  if (nonWs.length === 0) return false;
  // 100% chiffres (avec espaces autorisés) = ref nue ou EAN, MAIS uniquement
  // si suffisamment long (>= 5 chiffres) — sinon "100", "250", "400" qui
  // sont des suffixes legitimes de noms produits (ECOP 100, ECL 250) seraient
  // exclus à tort (faille Catalogue C P14).
  if (/^[\d\s]+$/.test(trimmed) && nonWs.length >= 5) return true;
  const letters = (nonWs.match(/[a-zA-ZÀ-ÿœŒæÆ]/g) ?? []).length;
  const digits = (nonWs.match(/\d/g) ?? []).length;
  const symbols = nonWs.length - letters - digits;
  // Alphanum-pure (lettres + chiffres >= 80%) : nom produit / ref legit.
  // Limite a 30 chars : au-dela on est probablement face a un identifiant
  // technique long (URL, hash) qui ne devrait pas etre nom produit.
  if (nonWs.length <= 30 && (letters + digits) / nonWs.length >= 0.8) {
    return false;
  }
  // Forte presence de symboles (>30%) = barcode/picto imprime
  if (symbols / nonWs.length > 0.3) return true;
  // Conservatif : ratio lettres < 50%
  return letters / nonWs.length < 0.5;
}

export function findProductBlocks(
  page: ExtractedPage,
  profile: TemplateProfile,
): ProductBlock[] {
  const spans = page.raw_spans ?? [];
  const images = page.raw_images ?? [];
  if (spans.length === 0) return [];

  // ─── 1. Trouver tous les spans candidats "nom produit" ────────────────────
  // Filtre supplémentaire GÉNÉRIQUE : exclure les chaînes qui ressemblent
  // à des codes-barres ou symboles imprimés (ratio caractères non-lettres
  // > 50%). Cas connus : EAN-13 "&:DCPNLA=UWWX[[:" (Catalogue C), pictogrammes
  // imprimés "■▶◀●" (catalogues design), refs nues "3325310022366" (toutes
  // chiffres). Une vraie marque produit a une majorité de lettres.
  // Matching font fuzzy : sur certains catalogues le profile detecte un
  // pattern "trop specifique" (ex: Catalogue C detecte "MdCn" car les headers
  // de chapitre s'y trouvent souvent, mais les VRAIS noms produit sont en
  // "Cn" simple). Strategie : match strict d'abord ; si echec total (<2
  // candidats apres filtre size/X), retry avec un TOKEN TYPO DISCRIMINANT
  // present dans le pattern, choisi dans une whitelist conservatrice (les
  // suffixes typographiques standard PostScript/Adobe).
  //
  // SECURITE : ne kicke QUE si le pattern contient un token typo connu.
  // Eviter "ld" extrait de "SemiBold" qui matcherait "Bold"/"OldStyle"/etc.
  // → casse potentielle Catalogue A (nameFontPattern="SemiBold" → strict reste).
  const TYPO_TOKENS = ['Cn', 'Bd', 'Lt', 'Th', 'Rg', 'It', 'Md', 'Sm', 'Ult', 'Hv', 'Bk'];
  const matchFontStrict = (s: TextSpan) => s.font.includes(profile.nameFontPattern);
  const fuzzyToken = TYPO_TOKENS.find((tok) => profile.nameFontPattern.includes(tok));
  const matchFontFuzzy = fuzzyToken
    ? (s: TextSpan) => s.font.includes(fuzzyToken)
    : matchFontStrict;
  // Pre-passe : matching strict. Si <2 hits, switch au fuzzy (s'il existe).
  const strictHits = spans.filter(
    (s) =>
      matchFontStrict(s) &&
      s.size >= profile.nameSizeRange[0] &&
      s.size <= profile.nameSizeRange[1] &&
      s.bbox[0] < profile.nameXMax &&
      !looksLikeBarcode(s.text) &&
      !looksLikeSectionHeader(s.text),
  );
  const useFuzzy = strictHits.length < 2 && fuzzyToken !== undefined;
  const matchFont = useFuzzy ? matchFontFuzzy : matchFontStrict;
  const rawNameSpans = spans
    .filter(
      (s) =>
        matchFont(s) &&
        s.size >= profile.nameSizeRange[0] &&
        s.size <= profile.nameSizeRange[1] &&
        s.bbox[0] < profile.nameXMax &&
        !looksLikeBarcode(s.text) &&
        !looksLikeSectionHeader(s.text),
    )
    // Tri par Y croissant puis X croissant : critique pour le merge
    // horizontal (Y identique) ou vertical (X identique) qui itere les
    // spans consecutifs.
    .sort((a, b) => {
      const dy = a.bbox[1] - b.bbox[1];
      if (Math.abs(dy) > 1) return dy;
      return a.bbox[0] - b.bbox[0];
    });

  // ─── 2. Fusionner les noms wrappes sur plusieurs lignes ────────────────────
  // Deux modes de merge :
  //  - VERTICAL : X start identique + Y consecutif (= nom wrappe sur 2 lignes)
  //  - HORIZONTAL : Y identique + X end ≈ X start next (gap petit < 10pt)
  //    Cas Catalogue C P14 : "ECOP" + " 100" sont 2 spans separes mais collés.
  //    Merge horizontal SEULEMENT si gap petit (sinon "ECOP 100" et "ECL 250"
  //    se mergeraient à tort, ils sont a 69pt l'un de l'autre).
  const HORIZONTAL_MERGE_MAX_GAP = 10;
  const nameSpans: { span: TextSpan; wrapped: number }[] = [];
  let i = 0;
  while (i < rawNameSpans.length) {
    const s = rawNameSpans[i];
    let mergedText = s.text.replace(/\s+$/, '');
    const mergedBbox: Bbox = [s.bbox[0], s.bbox[1], s.bbox[2], s.bbox[3]];
    let j = i + 1;
    while (j < rawNameSpans.length) {
      const t = rawNameSpans[j];
      const sizeOk = Math.abs(t.size - s.size) < profile.nameMergeSizeTolerance;
      const verticalMerge =
        Math.abs(t.bbox[0] - s.bbox[0]) < profile.nameMergeXTolerance &&
        t.bbox[1] - mergedBbox[3] < profile.nameMergeYTolerance;
      const horizontalMerge =
        Math.abs(t.bbox[1] - s.bbox[1]) < profile.nameMergeYTolerance &&
        t.bbox[0] - mergedBbox[2] >= -2 &&
        t.bbox[0] - mergedBbox[2] < HORIZONTAL_MERGE_MAX_GAP;
      if (sizeOk && (verticalMerge || horizontalMerge)) {
        mergedText += ' ' + t.text.trim();
        mergedBbox[2] = Math.max(mergedBbox[2], t.bbox[2]);
        mergedBbox[3] = Math.max(mergedBbox[3], t.bbox[3]);
        j++;
      } else {
        break;
      }
    }
    nameSpans.push({
      span: { ...s, text: mergedText, bbox: mergedBbox },
      wrapped: j - i,
    });
    i = j;
  }

  // ─── 2bis. Détection mode layout (vertical vs horizontal) ─────────────────
  //
  // Pour chaque page, on regarde si plusieurs nameSpans sont à la même Y
  // (= ligne d'en-têtes de N colonnes produits, layout type Catalogue C /
  // Catalogue B). Sinon = layout vertical classique (1 produit par row Y).
  //
  // Critère : la row Y dominante (= celle avec le plus de noms) doit avoir
  // ≥ 2 noms ET ≥ 50% des noms de la page. Évite les faux positifs où 2
  // noms sont accidentellement alignés.
  //
  // Conservatif : Catalogue A reste en mode vertical (chaque row a 1 seul nom).
  //
  // Tolerance adaptee a la taille de police (faille review : 4pt absolu
  // etait trop strict sur grand format 24pt+ ou jitter baseline peut depasser
  // 4pt). Formule : max(4, nameSize_median * 0.30). Sur Catalogue A (16pt) → 4.8,
  // pratiquement inchange. Sur grand format (24pt) → 7.2, plus tolerant.
  const yRowTolBase =
    nameSpans.length > 0
      ? nameSpans
          .map((ns) => ns.span.size)
          .sort((a, b) => a - b)[Math.floor(nameSpans.length / 2)]
      : profile.nameSizeRange[1];
  const Y_ROW_TOL = computeYRowTolerance(yRowTolBase);
  const rowGroups: { y: number; count: number }[] = [];
  for (const ns of nameSpans) {
    const y = ns.span.bbox[1];
    const existing = rowGroups.find((g) => Math.abs(g.y - y) <= Y_ROW_TOL);
    if (existing) existing.count++;
    else rowGroups.push({ y, count: 1 });
  }
  const maxRowCount = rowGroups.reduce((m, g) => Math.max(m, g.count), 0);
  // Seuils assouplis (faille Catalogue C : ancien 3/0.4 manquait les cas 2-cols
  // ou 3-cols avec jitter Y residuel). Nouveau : 2/0.4 OU 3/0.33.
  // Conservateur Catalogue A : 3 produits sur 3 rows distinctes → maxRowCount=1,
  // ratio 1/3=0.33 → 1 < 2 → reste vertical. OK.
  const isHorizontalLayout =
    nameSpans.length >= 2 &&
    ((maxRowCount >= 2 && maxRowCount / nameSpans.length >= 0.4) ||
      (maxRowCount >= 3 && maxRowCount / nameSpans.length >= 0.33));

  // ─── 3. Pour chaque nom : delimiter le bloc + extraire ref/color/specs ────
  const blocks: ProductBlock[] = [];
  const pageH = page.page_size.height;

  /** Mode horizontal : retourne yBottom = top de la NEXT row Y (≠ même row). */
  const findNextRowY = (currentY: number): number => {
    let minNext = Infinity;
    for (const ns of nameSpans) {
      const y = ns.span.bbox[1];
      if (y - currentY > Y_ROW_TOL && y < minNext) minNext = y;
    }
    return minNext;
  };

  /** Mode horizontal : xRightBound = X du nom suivant SAME row. */
  const findXRightBound = (currentX: number, currentY: number): number => {
    let minRight = Infinity;
    for (const ns of nameSpans) {
      const y = ns.span.bbox[1];
      const x = ns.span.bbox[0];
      if (Math.abs(y - currentY) > Y_ROW_TOL) continue;
      if (x > currentX && x < minRight) minRight = x;
    }
    return minRight;
  };

  for (let bi = 0; bi < nameSpans.length; bi++) {
    const { span: nameSpan, wrapped } = nameSpans[bi];
    const yTop = nameSpan.bbox[1];
    let yBottom: number;
    let xLeftBound = -Infinity;
    let xRightBound = Infinity;
    if (isHorizontalLayout) {
      // yBottom = next ROW Y (pas next nameSpan Y, qui serait same row)
      const nextRow = findNextRowY(yTop);
      yBottom = nextRow < Infinity
        ? nextRow - profile.blockYGap
        : pageH - profile.blockLastBottomMargin;
      // xBounds : xLeft = 0 pour inclure les KEYS partagées (col gauche
      // commune à tous les blocs de la row). xRight = X du nom suivant
      // SAME row pour isoler les valeurs de cette colonne.
      xLeftBound = 0;
      xRightBound = findXRightBound(nameSpan.bbox[0], yTop);
    } else {
      // Mode vertical (Catalogue A, Catalogue E, etc.) — comportement historique
      yBottom =
        bi + 1 < nameSpans.length
          ? nameSpans[bi + 1].span.bbox[1] - profile.blockYGap
          : pageH - profile.blockLastBottomMargin;
    }

    const blockSpans = spans.filter(
      (s) =>
        s.bbox[1] >= yTop &&
        s.bbox[1] < yBottom &&
        s.bbox[0] >= xLeftBound &&
        s.bbox[0] < xRightBound,
    );

    // ─── Header : ref + color sous le nom ────────────────────────────────────
    const headerZoneH = Math.max(
      profile.blockHeaderZoneHeight,
      nameSpan.size * profile.blockHeaderZoneSizeRatio,
    );
    const headerXMax = isHorizontalLayout
      ? Math.min(xRightBound, Math.max(profile.nameXMax, profile.specsXMin))
      : Math.max(profile.nameXMax, profile.specsXMin);
    const [crMin, crMax] = profile.colorRefSizeRange;

    let refSpan: TextSpan | null = null;
    let colorSpan: TextSpan | null = null;
    const headerCandidates: TextSpan[] = [];

    for (const s of blockSpans) {
      if (s === nameSpan) continue;
      if (s.bbox[1] >= yTop + headerZoneH || s.bbox[0] >= headerXMax) continue;
      // FIX horizontal multi-cols : restreindre la zone header a la COLONNE
      // du bloc courant (X >= nameSpan.X) et SOUS le nom (Y > nameSpan.Y3).
      // Sinon, sur templates type Catalogue C ou` les 3 noms partagent la row Y,
      // les sub-spans qui composent le nameSpan virtuel mergé (ex: "ECOP" +
      // "100" → "ECOP 100") restent dans blockSpans et deviennent candidats
      // header/color/ref pour les blocs 2/3, qui prennent ainsi color/ref
      // du bloc 1 par erreur (positionnement Insert_text foireux).
      if (isHorizontalLayout) {
        if (s.bbox[0] < nameSpan.bbox[0]) continue;
        if (s.bbox[1] < nameSpan.bbox[3]) continue;
      }
      // Exclure les fonts code-barres (EanT30L, Ean13, ITF, etc.) : ce sont
      // des glyphes opaques qui passent les filtres color/ref (pas de digit
      // visible dans le texte) mais ne sont PAS du contenu humain. Sur
      // Catalogue C les EAN sous chaque nom polluaient le colorSpan via tier 3.
      const fontLower = s.font.toLowerCase();
      if (fontLower.includes('ean') || fontLower.includes('barcode') ||
          fontLower.includes('code128') || fontLower.includes('code39')) {
        continue;
      }
      headerCandidates.push(s);
      const hasDigit = /\d/.test(s.text);
      // Regles strictes : ref = font ref + digit, color = font color + sans digit
      if (!refSpan && s.font.includes(profile.headerRefFontPattern) && hasDigit) {
        refSpan = s;
      } else if (
        !colorSpan &&
        s.font.includes(profile.headerColorFontPattern) &&
        s.size >= crMin &&
        s.size <= crMax &&
        !hasDigit
      ) {
        colorSpan = s;
      }
    }
    // Tier 2 : si pas de color span trouve, essai palette de noms de
    // couleurs/finitions courantes (multi-langue). Beaucoup plus fiable
    // que "1er span sans digit" quand le template a une font color non
    // standard, car la palette discrimine semantiquement.
    if (!colorSpan && headerCandidates.length > 0) {
      for (const s of headerCandidates) {
        if (s === refSpan) continue;
        if (isCommonColor(s.text)) {
          colorSpan = s;
          break;
        }
      }
    }
    // Tier 3 (fallback permissif) : 1er span avec digit = ref, 1er sans = color.
    // Garde-fou final pour les noms de couleurs hors palette (codes RAL,
    // noms commerciaux, finitions exotiques).
    if ((!refSpan || !colorSpan) && headerCandidates.length > 0) {
      const sorted = [...headerCandidates].sort(
        (a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0],
      );
      for (const s of sorted) {
        const hasDigit = /\d/.test(s.text);
        if (!refSpan && hasDigit) refSpan = s;
        else if (!colorSpan && !hasDigit) colorSpan = s;
      }
    }

    // ─── Specs : keys + values ───────────────────────────────────────────────
    const specsZone = blockSpans.filter((s) => s.bbox[0] > profile.specsXMin);
    let keys = specsZone
      .filter(
        (s) => s.font.includes(profile.keyFontPattern) && hasKeyValueSeparator(s.text),
      )
      .sort((a, b) => a.bbox[1] - b.bbox[1]);
    // Fallback tabulaire (mode horizontal multi-cols) : keys sans `:`
    // mais alignées Y avec ≥1 valeur dans la zone X du bloc (à droite).
    // Cas Catalogue C / Catalogue B : "Référence" / "Puissance" en col gauche
    // partagée, valeurs en colonnes parallèles.
    //
    // En mode horizontal, on PREFERE TOUJOURS le fallback tabulaire sur les
    // keys inline "X : valeur" (qui sont en realite des VALEURS detectees a
    // tort). Cas Catalogue C P29 fiches surface : "19 mm : 2 sur 25 m" (= specs
    // dimension) etait capture comme key. Avec keys.length>0 le fallback ne
    // kickait pas → reflow placait les nouveaux specs a Y=476 (mauvaise ligne)
    // au lieu de Y=305 (Puissance). Donc en horizontal on FORCE fallback.
    if (isHorizontalLayout) {
      // keyXMax strict : la col gauche COMMUNE est typiquement a X ≈
      // specsXMin (~50pt). Au-dela on entre dans la col d'un bloc voisin
      // et on risque de capturer ses VALEURS comme keys (cas Catalogue C : "600 W"
      // valeur du bloc 0 a X=237 etait capturee comme key du bloc 1 a X=337
      // car keyXMax=block1.X-4=333 trop large). On limite a specsXMin + 20.
      const keyXMax = Math.min(nameSpan.bbox[0] - 4, profile.specsXMin + 20);
      const valueXMin = nameSpan.bbox[0];
      keys = blockSpans
        .filter((s) => {
          if (s === nameSpan) return false;
          const txt = s.text.trim();
          if (txt.length < 3) return false;
          if (looksLikeBarcode(txt)) return false;
          if (s.bbox[0] >= keyXMax) return false;
          if (s.size > profile.keySize * 1.5) return false; // pas un titre gros
          if (Math.abs(s.size - profile.keySize) > 2) return false;
          // Au moins une valeur same-Y dans la zone X du bloc
          const hasValue = blockSpans.some(
            (v) =>
              v !== s &&
              Math.abs(v.bbox[1] - s.bbox[1]) <= profile.specInlineYTolerance &&
              v.bbox[0] >= valueXMin,
          );
          return hasValue;
        })
        .sort((a, b) => a.bbox[1] - b.bbox[1]);
    }
    // Accepte la font value du profile (typiquement "Light") OU la font
    // Regular qui est un fallback courant sur les valeurs courtes. Ne pas
    // hardcoder seulement valueFontPattern : certaines specs Catalogue A mixent les
    // deux familles dans une meme zone (ex value en Regular au milieu de
    // Light) et seraient sinon ignorees.
    //
    // Filtre anti-contamination (faille review) : on exclut les spans
    // contenant des marqueurs typographiques de mention legale (©®™) ou
    // des phrases longues type notice/copyright. Ne touche jamais une vraie
    // value produit (qui n'a pas de © et est courte).
    const lights = specsZone.filter((s) => {
      const fontMatch =
        s.font.includes(profile.valueFontPattern)
        || s.font.includes(profile.headerRefFontPattern);
      if (!fontMatch) return false;
      // Exclure les marqueurs typographiques de mentions legales
      if (looksLikeLegalNotice(s.text)) return false;
      return true;
    });

    const specs: ProductSpecBlock[] = [];
    const attributed = new Set<TextSpan>();
    for (let ki = 0; ki < keys.length; ki++) {
      const key = keys[ki];
      attributed.add(key);
      const keyY0 = key.bbox[1];
      const keySize = key.size ?? profile.keySize;
      const keyBaselineBottom = keyY0 + keySize;
      const keyX0 = key.bbox[0];
      const keyX1 = key.bbox[2];
      // Borne basse pour la value courante : Y de la prochaine key (ou
      // yBottom du bloc si derniere key). Empeche d'absorber la value du
      // spec suivant lors de la continuation multi-ligne.
      const nextKeyY = ki + 1 < keys.length ? keys[ki + 1].bbox[1] : yBottom;

      const inline = lights.filter(
        (v) =>
          Math.abs(v.bbox[1] - keyY0) <= profile.specInlineYTolerance &&
          v.bbox[0] >= keyX1 - profile.specInlineXTolerance,
      );
      // Continuation MULTI-LIGNE : on collecte iterativement les lignes
      // alignees X et consecutives Y. Critere d'arret :
      //   - on atteint le Y de la prochaine key
      //   - une ligne candidate est trop loin (gap > keySize + extra) de
      //     la derniere ligne acceptee → la valeur a fini de wrapper
      // Permet de capturer les descriptions/specs longues qui s'etalent
      // sur 3+ lignes ("Garantie : 5 ans piece et main d'oeuvre dans le
      // reseau Catalogue A partenaire" → 3 lignes wrap).
      const continuationCandidates = lights
        .filter((v) => {
          if (v.bbox[1] < keyBaselineBottom) return false;
          if (v.bbox[1] >= nextKeyY) return false;
          if (Math.abs(v.bbox[0] - keyX0) > profile.specContinuationXTolerance)
            return false;
          return true;
        })
        .sort((a, b) => a.bbox[1] - b.bbox[1]);

      const continuation: TextSpan[] = [];
      let lastBottom = keyBaselineBottom;
      const maxGap = keySize + profile.specContinuationYExtra;
      // Garde-fou (faille review) : limite stricte sur le nombre de lignes
      // de continuation acceptees. Au-dela de 5 lignes apres la key, on
      // a probablement absorbe du contenu d'une autre spec ou section.
      //   Catalogue A reference : "Garantie : 5 ans piece et main d'oeuvre dans le
      //   reseau Catalogue A partenaire" wrappe en 3 lignes. Donc 5
      //   est conservateur (laisse de la marge sans casser).
      const MAX_CONTINUATION_LINES = 5;
      // Y max absolu = keyY0 + 5 lignes (eviter de descendre dans la zone
      // d'une key voisine quand nextKeyY est lointain - cas derniere spec
      // du bloc avec yBottom mal calibre).
      const yMaxContinuation = keyY0 + MAX_CONTINUATION_LINES * (keySize + 2);
      for (const v of continuationCandidates) {
        // Ligne consecutive : top de v est proche du bottom de la derniere
        // ligne acceptee (ou de la key).
        if (v.bbox[1] - lastBottom > maxGap) break;
        if (continuation.length >= MAX_CONTINUATION_LINES) break;
        if (v.bbox[1] > yMaxContinuation) break;
        continuation.push(v);
        lastBottom = v.bbox[3];
      }

      const vals = [...inline, ...continuation];
      vals.forEach((v) => attributed.add(v));
      specs.push({ key, values: vals });
    }
    // Si pas de specs detectees (template sans pattern "cle:valeur"), on
    // accepte quand meme le bloc SI le nom est confirme + au moins un
    // signe : header (ref/color) OU image bitmap dans la zone bloc.
    if (specs.length === 0) {
      const hasHeader = refSpan !== null || colorSpan !== null;
      const hasImage = images.some(
        (b) => b[0] < profile.specsXMin && b[1] >= yTop && b[1] < yBottom,
      );
      if (!hasHeader && !hasImage) continue;
    }

    const specsYTop = specs.length > 0 ? specs[0].key.bbox[1] : nameSpan.bbox[3] + 4;
    const allYBottoms: number[] = [];
    for (const { key, values } of specs) {
      allYBottoms.push(key.bbox[3]);
      for (const v of values) {
        if (v.text.trim()) allYBottoms.push(v.bbox[3]);
      }
    }
    const specsYBottom =
      allYBottoms.length > 0 ? Math.max(...allYBottoms) : yBottom - 10;
    const specsXLeft =
      specs.length > 0
        ? Math.min(...specs.map((s) => s.key.bbox[0]))
        : profile.specsXMin;

    // ─── Variantes : images carrees + spans labels ───────────────────────────
    const headerBottom =
      (colorSpan ? colorSpan.bbox[3] : refSpan ? refSpan.bbox[3] : nameSpan.bbox[3]) +
      profile.blockHeaderExcludeYOffset;
    const [vcMin, vcMax] = profile.variantCircleSizeRange;
    const [sqMin, sqMax] = profile.squareRatioRange;
    const variantImages = images.filter((b) => {
      const w = b[2] - b[0];
      const h = b[3] - b[1];
      return (
        b[0] < profile.specsXMin &&
        b[1] >= headerBottom &&
        b[1] < yBottom &&
        w >= vcMin &&
        w <= vcMax &&
        h >= vcMin &&
        h <= vcMax &&
        w / Math.max(h, 1) >= sqMin &&
        w / Math.max(h, 1) <= sqMax
      );
    });

    const attributedHeader = new Set<TextSpan>();
    if (colorSpan) attributedHeader.add(colorSpan);
    if (refSpan) attributedHeader.add(refSpan);
    attributedHeader.add(nameSpan);
    // Variantes : labels couleur dans la zone sous le header, taille
    // similaire au colorSpan. Le filtre font est permissif (color OU ref OU
    // text reconnu comme couleur de la palette) : certains templates
    // utilisent une font alternative pour les labels variantes que le
    // profile detection ne capte pas.
    const variantSpans = blockSpans.filter(
      (s) =>
        s.bbox[0] < profile.specsXMin &&
        s.bbox[1] >= headerBottom &&
        s.bbox[1] < yBottom &&
        !attributedHeader.has(s) &&
        s.size >= crMin &&
        s.size <= crMax &&
        (s.font.includes(profile.headerColorFontPattern) ||
          s.font.includes(profile.headerRefFontPattern) ||
          isCommonColor(s.text)),
    );

    // ─── Image principale produit ────────────────────────────────────────────
    const mainImageBbox = findMainProductImage(yTop, yBottom, page.page_size.width, images, profile);

    // Filtre anti-faux-positif : un "bloc produit" doit avoir au moins un
    // signal de fiche réelle (ref, ≥1 spec, ou image principale). Sinon
    // c'est probablement un titre de paragraphe / section qui matche le
    // pattern font/size mais n'est pas une fiche. Sans ce filtre, les
    // pages intro (style "Un savoir-faire logistique", "Notre mission")
    // deviennent product → allocator confus → mauvaise substitution.
    const hasRealContent =
      refSpan !== null || specs.length > 0 || mainImageBbox !== null;
    if (!hasRealContent) continue;

    blocks.push({
      pageNumber: page.page_number,
      nameSpan,
      nameWrappedCount: wrapped,
      refSpan,
      colorSpan,
      specs,
      variantImages,
      variantSpans,
      mainImageBbox,
      yTop,
      yBottom,
      specsYTop,
      specsYBottom,
      specsXLeft,
      isHorizontalLayout,
    });
  }
  // Tracker pages avec layout horizontal detecte : downstream
  // (reflowSpecsV2) ne le gere pas encore parfaitement → l'observabilite
  // permet de quantifier l'impact avant de coder le fix S6.5.
  if (isHorizontalLayout && blocks.length > 0) {
    recordHorizontalLayout(page.page_number, blocks.length);
  }

  // Filtre qualité GÉNÉRIQUE page : si la page a beaucoup de name
  // candidates mais peu deviennent des blocs valides, c'est probablement
  // une page complexe (table multi-dim, layout multi-colonnes non géré,
  // page avec contenu permanent type spec table) que le pipeline ne sait
  // pas substituer proprement. Mieux vaut drop (return []) et laisser
  // l'allocator chercher une autre page, plutôt que substituer 1 bloc
  // sur 5+ et laisser le reste comme contenu original parasite.
  //
  // Seuils calibrés conservativement :
  //   - rawNameSpans ≥ 5 (signal fiable de richesse de candidats)
  //   - blocks valides / candidats < 0.4 (< 40% de conversion)
  //
  // Sur Catalogue A : pages produit ont 3 candidates = 3 blocs (100%, < 5 → no-op).
  // Sur Catalogue C p13 : 8 candidates, 1-2 blocs (12-25% < 40% → drop).
  if (rawNameSpans.length >= 5 && blocks.length / rawNameSpans.length < 0.4) {
    recordDroppedPage(page.page_number, rawNameSpans.length, blocks.length);
    return [];
  }
  return blocks;
}

// ─── Stats drops silencieux (debug / monitoring) ────────────────────────────
/** Compteur de pages drops par le filtre de qualité.
 *  Permet d'auditer en aval (orchestrator) combien de pages sont éliminées
 *  silencieusement. Reset entre runs si besoin via resetDroppedPages(). */
export interface DroppedPageInfo {
  pageNumber: number;
  rawNameSpans: number;
  blocks: number;
  ratio: number;
}
const droppedPages: DroppedPageInfo[] = [];
function recordDroppedPage(pageNumber: number, rawNameSpans: number, blocks: number) {
  droppedPages.push({
    pageNumber,
    rawNameSpans,
    blocks,
    ratio: rawNameSpans === 0 ? 0 : blocks / rawNameSpans,
  });
  // En env DEBUG_BLOCKS, log explicite (sinon silencieux mais consultable).
  if (process.env.DEBUG_BLOCKS) {
    console.warn(
      `[blockDetector] page=${pageNumber} dropped: ${blocks}/${rawNameSpans} blocs (ratio=${(blocks / rawNameSpans).toFixed(2)} < 0.4)`,
    );
  }
}
export function getDroppedPages(): readonly DroppedPageInfo[] {
  return droppedPages;
}
export function resetDroppedPages(): void {
  droppedPages.length = 0;
}

// ─── Stats pages avec layout horizontal (audit S6.5) ────────────────────────
export interface HorizontalLayoutInfo {
  pageNumber: number;
  blockCount: number;
}
const horizontalLayoutPages: HorizontalLayoutInfo[] = [];
function recordHorizontalLayout(pageNumber: number, blockCount: number) {
  horizontalLayoutPages.push({ pageNumber, blockCount });
  if (process.env.DEBUG_BLOCKS) {
    console.warn(
      `[blockDetector] page=${pageNumber} layout horizontal (${blockCount} blocs) — reflowSpecsV2 mode horizontal pas encore implemente`,
    );
  }
}
export function getHorizontalLayoutPages(): readonly HorizontalLayoutInfo[] {
  return horizontalLayoutPages;
}
export function resetHorizontalLayoutPages(): void {
  horizontalLayoutPages.length = 0;
}

// ─── Image principale produit ────────────────────────────────────────────────

/**
 * Cherche le bitmap "image principale" dans un bloc produit.
 * Criteres :
 *  - position : a gauche de specs, dans le bloc Y
 *  - taille mini : > picto max (exclut NF/qualite/labels)
 *  - exclusions : pictos ronds tres serres (ratio carré strict),
 *    bandes decoratives touchant 2 bords opposes du bloc
 *
 * Si plusieurs candidats : prend le plus gros mais en pénalisant les
 * formats extremes (largeur >> hauteur ou vice-versa = probable bande deco).
 */
function findMainProductImage(
  yTop: number,
  yBottom: number,
  pageWidth: number,
  images: Bbox[],
  profile: TemplateProfile,
): Bbox | null {
  const pictoMax = profile.pictoSizeRange[1];
  const blockH = yBottom - yTop;
  const candidates = images.filter((b) => {
    const w = b[2] - b[0];
    const h = b[3] - b[1];
    if (b[0] >= profile.specsXMin) return false;
    if (b[1] < yTop || b[1] >= yBottom) return false;
    if (w < pictoMax || h < pictoMax) return false;
    // Reject bandes decoratives : touche les 2 bords du bloc
    const touchesTop = b[1] - yTop < 2;
    const touchesBottom = yBottom - b[3] < 2;
    if (touchesTop && touchesBottom) return false;
    // Reject bandes pleine hauteur OU pleine largeur sur le bloc
    if (h > blockH * 0.9 && w > pageWidth * 0.6) return false;
    // Reject bande lateral pleine largeur (logo collection horizontal)
    if (w > pageWidth * 0.5 && h < pictoMax * 2) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  // Score = aire + bonus si ratio proche du carre (1:1 a 1:2).
  candidates.sort((a, b) => {
    const aW = a[2] - a[0], aH = a[3] - a[1];
    const bW = b[2] - b[0], bH = b[3] - b[1];
    const aRatio = Math.max(aW / aH, aH / aW);
    const bRatio = Math.max(bW / bH, bH / bW);
    // Penalite : pour chaque unite au-dela de 1.0 on enleve 5% de l'aire.
    const aScore = aW * aH * (1 - Math.min(0.5, (aRatio - 1) * 0.05));
    const bScore = bW * bH * (1 - Math.min(0.5, (bRatio - 1) * 0.05));
    return bScore - aScore;
  });
  return candidates[0];
}

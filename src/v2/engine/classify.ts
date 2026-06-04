/**
 * Phase 1.1 : classification structurelle de chaque page du template.
 *
 * Decide pour chaque page : product / toc / glossaire / intercalaire / identity.
 * Sortie : 1 PageClassification par page, avec score de confiance ∈ [0, 1].
 *
 * Le score est INFORMATIF — aucun seuil dur n'est applique dans le pipeline
 * (pas de "if confidence < 0.7 then ...") : c'est Claude (phase 1.2 audit
 * optionnelle) qui peut overrider une classification a faible confiance.
 * Sans Claude, on garde le kind heuristique meme si confidence = 0.7.
 */

import type { ExtractedPage, Slot, SlotSectionBanner, TextSpan } from '../types';
import { findProductBlocks, type ProductBlock } from './blockDetector';
import type { TemplateProfile } from './profile';
import { hasKeyValueSeparator } from './keyValueSeparator';
import { stripAccents } from './textNormalize';

/**
 * Pattern d'une reference de page inline ("p.12", "page 12", "Seite 12",
 * "pag. 12", "pág. 12"). Sert a detecter heuristiquement les pages TOC
 * sans slot toc_entry pose par l'extracteur (= templates non-Catalogue A).
 *
 * Volontairement strict (= prefix textuel obligatoire) pour ne PAS matcher
 * les valeurs de variantes "30/35/38" sur les fiches produit.
 *
 * Deux alternances :
 *  - Forme longue avec whitespace obligatoire entre prefix et numero :
 *    `page 12`, `Page 12`, `pag 12`, `pag. 12`, `pagina 12`, `pág. 12`,
 *    `página 12`, `seite 12`, `Seite 12`.
 *  - Forme courte avec point obligatoire : `p.12`, `p. 12`, `S.12`, `S. 12`.
 */
export const PAGE_REF_INLINE_RE =
  /\b(?:page|pag(?:ina)?|pág(?:ina)?|seite)\.?\s+\d{1,4}\b|\b[ps]\.\s*\d{1,4}\b/i;

export type PageKind =
  | 'product'        // page-fiche produit du template (blocs detectes)
  | 'toc'            // sommaire general OU sommaire de section OU synoptique
  | 'glossaire'      // glossaire pictogrammes / index couleur / index alpha
  | 'tech'           // cahier technique / fiche technique / datasheet (audit #8)
  | 'intercalaire'   // intro de section (gros titre, pas de fiches)
  | 'identity';      // identite marque, intro/outro neutres, mentions legales

export interface PageClassification {
  pageNumber: number;
  extracted: ExtractedPage;
  blocks: ProductBlock[];
  kind: PageKind;
  /** Label section_banner detecte sur cette page (vrai, post-filtre). */
  sectionLabel: string | null;
  /** Section active = derniere sectionLabel rencontree (propagee). */
  activeSection: string;
  /** Score [0..1]. Sous 0.7 → cas borderline, Claude doit verifier. */
  confidence: number;
}

export function classifyAllPages(
  pages: ExtractedPage[],
  profile: TemplateProfile,
): PageClassification[] {
  const result: PageClassification[] = [];
  let activeSection = '';
  for (const page of pages) {
    const cls = classifyPage(page, profile, activeSection);
    if (cls.sectionLabel) activeSection = cls.sectionLabel;
    result.push(cls);
  }
  return result;
}

/** Classifie UNE page isolement. Expose pour les tests unitaires. */
export function classifyPage(
  page: ExtractedPage,
  profile: TemplateProfile,
  activeSection = '',
): PageClassification {
  const blocks = findProductBlocks(page, profile);
  const sectionLabel = detectSectionLabel(page, profile);
  const { kind, confidence } = inferKind(page, blocks, sectionLabel);
  return {
    pageNumber: page.page_number,
    extracted: page,
    blocks,
    kind,
    sectionLabel,
    activeSection: sectionLabel || activeSection,
    confidence,
  };
}

// ─── Detection section_banner fiable (filtre dur) ───────────────────────────

function detectSectionLabel(
  page: ExtractedPage,
  profile: TemplateProfile,
): string | null {
  // Priorite 1 : section_banner horizontal classique (Catalogue A, Catalogue E, etc.)
  for (const s of page.slots) {
    if (s.type !== 'section_banner') continue;
    if (!isRealSectionBanner(s, profile)) continue;
    return s.label.text.trim();
  }
  // Priorite 2 : section_banner en HAUT DE PAGE (Y < 50) ET all caps OU
  // dans un ribbon vertical (X < 30 et bbox haut). Cas Catalogue C ou` les banners
  // "POMPES D'ÉVACUATION" font 15pt = nameSize max → rejetes par le filtre
  // strict ci-dessus. Le critere positionnel discrimine sans ambiguite vs les
  // noms produit qui sont au milieu de page (Y > 100).
  for (const s of page.slots) {
    if (s.type !== 'section_banner') continue;
    const text = s.label?.text?.trim();
    if (!text || text.length < 2 || text.length > 80) continue;
    if (hasKeyValueSeparator(text)) continue;
    const y0 = s.bbox?.[1] ?? 1e9;
    const x0 = s.bbox?.[0] ?? 1e9;
    const size = s.label?.size ?? 0;
    // Header haut de page : Y < 50 ET size >= bannerMinSize ET all-caps
    const isAllCaps = text === text.toUpperCase() && /[A-ZÀ-Ý]/.test(text);
    if (y0 < 50 && size >= profile.bannerMinSize && isAllCaps) {
      return text;
    }
    // Ribbon vertical (X < 30, bbox haut + bord) : tolerant a la taille
    if (x0 < 30 && size >= 8 && isAllCaps) {
      return text;
    }
  }
  // Priorite 3 : section_ribbon vertical (Catalogue C, Catalogue D, catalogues ou`
  // le label famille est un ruban vertical sur le bord). Sans ce fallback,
  // les pages produit Catalogue C ne sont JAMAIS matchees a un produit (cause
  // racine du "94% pages drop / no_section_match").
  for (const s of page.slots) {
    if (s.type !== 'section_ribbon') continue;
    const label = s.label?.text?.trim();
    if (label && label.length >= 2 && label.length <= 80) {
      return label;
    }
  }
  return null;
}

function isRealSectionBanner(
  s: SlotSectionBanner,
  profile: TemplateProfile,
): boolean {
  return isRealSectionBannerLabel(s.label, profile);
}

/**
 * Variante qui travaille directement sur un TextSpan. Sert au substitutor
 * pour eviter de dupliquer les memes seuils (taille >= bannerMinSize,
 * pas de ':', taille > nameSizeRange[1], longueur 4-80) dans l'orchestrator.
 *
 * Exception length < 6 : accepte les labels TRES courts ("WC", "SDB", "SPA")
 * SI le texte est tout en majuscules ET la taille est nettement superieure
 * a celle d'un nom produit (ratio > 1.5x). Cette condition discrimine les
 * vrais section banners "WC" en gros caractere des couleurs "Noir"/"Inox"
 * ecrites a la taille standard d'un nom produit (12-16pt).
 */
export function isRealSectionBannerLabel(
  label: TextSpan,
  profile: TemplateProfile,
): boolean {
  const size = label.size;
  const text = label.text;
  if (size < profile.bannerMinSize) return false;
  if (hasKeyValueSeparator(text)) return false;
  if (size <= profile.nameSizeRange[1]) return false;
  const trimmed = text.trim();
  if (trimmed.length > 80) return false;
  if (trimmed.length < 6) {
    // Acceptation conditionnelle pour labels courts (>= 2 chars) : doivent
    // etre all caps ET avoir une taille bien superieure au nom produit max.
    const SHORT_LABEL_SIZE_RATIO = 1.5;
    if (trimmed.length < 2) return false;
    const isAllCaps =
      trimmed === trimmed.toUpperCase() && /[A-ZÀ-Ý]/.test(trimmed);
    if (!isAllCaps) return false;
    if (size < profile.nameSizeRange[1] * SHORT_LABEL_SIZE_RATIO) return false;
  }
  return true;
}

// ─── Inference du kind ──────────────────────────────────────────────────────

function inferKind(
  page: ExtractedPage,
  blocks: ProductBlock[],
  sectionLabel: string | null,
): { kind: PageKind; confidence: number } {
  // 1. Page produit : on a au moins 1 bloc detecte
  // Filtre supplementaire : page "cover design" (gros visuels + blocs
  // sans contenu reel) → on rejette la classification produit pour ne
  // pas que l'allocator place des produits sur une cover. Cas Catalogue C
  // "NOS MARQUES" / "JARDIN PISCINE" / Catalogue E covers.
  //
  // Filtre additionnel "page intro/marketing" : une vraie fiche produit a
  // TOUJOURS un refSpan (code SKU). Si aucun bloc n'a de ref, c'est
  // probablement une page intro/marketing (LA NORME NF, intro marque Catalogue A P4,
  // Catalogue C "NOS MARQUES"...).
  //
  // Exception : si le bloc a beaucoup de specs (>= 5 total), c'est probablement
  // une fiche datasheet B2B sans ref → on garde product.
  // Cas Catalogue A P4 NORME NF : 2 blocs sans ref + 0-3 paragraphes détectés comme
  // specs → marketing intro → identity → pictos preserves.
  const anyRef = blocks.some((b) => b.refSpan !== null);
  const totalSpecs = blocks.reduce((s, b) => s + b.specs.length, 0);
  const isMarketingIntro = blocks.length > 0 && !anyRef && totalSpecs < 5;
  // Filtre cartographie : page de comparaison avec >= 6 noms produit TINY
  // (size <= 8pt) dispersés sur la page. Cas Catalogue C P29 ("Cartographie selon
  // le débit") où des noms ECOP/ECL/JE-* apparaissent en mini comme cellules
  // de tableau et NON comme fiches. La page a typiquement 3 "blocs" detectés
  // (gros titres categorie) mais contient en plus 10+ noms en size=7.
  const tinyProductNames = (page.raw_spans ?? []).filter(
    (s) => s.size <= 8 && /^(?:[A-Z]{2,}[\s-]?\d+|\d{4,6})\b/.test(s.text.trim()),
  ).length;
  const isCartographie = tinyProductNames >= 6;
  if (blocks.length > 0 && !isCoverDesign(page, blocks) && !isMarketingIntro && !isCartographie) {
    return { kind: 'product', confidence: 0.95 };
  }

  // 2. Sommaire : slots toc_entry/toc_title OU page riche en refs "p.NN"
  const hasTocSlot = page.slots.some(
    (s) => s.type === 'toc_entry' || s.type === 'toc_title',
  );
  if (hasTocSlot) return { kind: 'toc', confidence: 0.9 };
  // Heuristique TOC : compte les spans contenant une reference de page
  // formelle. On accepte les conventions multi-langue les plus courantes :
  //   "p.12" / "p. 12"            FR/EN abrégé (legacy Catalogue A)
  //   "page 12" / "Page 12"       FR/EN long
  //   "pag. 12" / "pagina 12"     IT
  //   "pág. 12" / "página 12"     ES
  //   "S. 12" / "Seite 12"        DE
  // On NE matche PAS un chiffre seul ("12"), trop ambigu sur fiches produit
  // (cf. valeurs de variantes "30","35","38"). Le seuil reste >= 8 spans.
  const pageRefs = (page.raw_spans ?? []).filter((s) =>
    PAGE_REF_INLINE_RE.test(s.text),
  ).length;
  if (pageRefs >= 8) return { kind: 'toc', confidence: 0.85 };

  // 2bis. Keywords explicites (sommaire/glossaire/cahier tech) FR/EN/ES/DE/IT.
  // Porte V1 (`unwanted_keywords` + `tech_page_keywords`). Si match : on
  // classe en toc/glossaire selon le bucket, ce qui va les drop en zone
  // produit via la logique productZoneIdxs.
  const kw = matchUnwantedKeyword(page);
  if (kw) return { kind: kw, confidence: 0.85 };

  // 3. Glossaire pictos : paths vectoriels denses + nombreux short labels
  if (isGlossairePictos(page)) return { kind: 'glossaire', confidence: 0.8 };

  // 4. Intercalaire de section vs page intro marque (heuristique GÉNÉRIQUE)
  //
  // Une page avec sectionLabel détecté est typiquement un intercalaire
  // de section. MAIS certaines pages intro marque (cover variantes,
  // "NOS MARQUES", logos d'identité, RSE...) ont aussi un banner détecté
  // par le binaire C++ alors qu'elles ne sont pas vraiment des
  // intercalaires de section navigable. Discriminant fiable : la surface
  // couverte d'images.
  //
  // Un vrai intercalaire (Catalogue A : "BARRES DE DOUCHES" + 1 photo carrée) a
  // une couverture image modérée (~15-25%). Une page intro marque
  // (Catalogue C : 3 grandes photos paysage + logos) couvre ≥40% de la page
  // par les images. Au-delà, on classe en identity → keep_raw plutôt
  // que tentative de réanimation avec un label de section.
  if (sectionLabel) {
    const imgCoverage = computeImageCoverageRatio(page);
    if (imgCoverage < INTRO_BRAND_IMAGE_RATIO) {
      return { kind: 'intercalaire', confidence: 0.85 };
    }
    // Sinon : fall-through vers identity
  }

  // 5. Identite marque (catch-all)
  return { kind: 'identity', confidence: 0.7 };
}

/** Detecte une page "cover design" : gros visuels couvrent une grande
 *  surface ET les blocs detectes sont pauvres en contenu reel (pas de
 *  refs, peu de specs). Cas Catalogue C "NOS MARQUES" / "JARDIN PISCINE" :
 *  blockDetector trouve des "blocs" sur les gros titres mais ce ne sont
 *  pas de vraies fiches produit substituables.
 *
 *  Critere renforce (faille review : cover avec 2 specs random
 *  "Edition 2025" + "Version: 1.0" echappait l'ancien test) :
 *    - imgCoverage > 0.5 (vraiment design, Catalogue A produit ~20-30%)
 *    - ET aucun bloc n'a de ref (pas de refSpan trouve)
 *    - ET nb total de specs sur la page < 3 (la cover peut avoir 1-2
 *      labels marketing mais une vraie page produit a >= 3 specs total)
 *    - ET aucun bloc n'a une image principale identifiee (sur cover, les
 *      images sont decoratives, pas detectees comme mainImageBbox)
 *
 *  Sur Catalogue A : chaque bloc a refSpan + 4-6 specs → false (pas cover design).
 *  Sur Catalogue C cover : 0 refs + 0-1 specs total + 0 mainImage → true.
 */
export function isCoverDesign(
  page: ExtractedPage,
  blocks: ProductBlock[],
): boolean {
  // Cas spécial : pages avec headlines marketing géants (size > 30pt) qui
  // dépassent nameSizeRange du profile → 0 blocs détectés. Si la page est
  // très visuelle (imgCoverage > 0.7) ET contient ≥ 1 headline > 30pt,
  // c'est une cover design (NOS MARQUES & NOS GAMMES, NOTRE VISIBILITÉ...).
  if (blocks.length === 0) {
    const imgCoverage = computeImageCoverageRatio(page);
    if (imgCoverage > 0.7) {
      const hasGiantHeadline = (page.raw_spans ?? []).some(
        (s) => s.size > 30 && s.text.trim().length > 3,
      );
      if (hasGiantHeadline) return true;
    }
    return false;
  }
  // Critere 1 : couverture image totale > 50% (sum)
  // Critere 2 (alternatif) : 1 SEULE image couvre > 35% pageArea (cover full-bleed)
  // Critere 3 (alternatif) : tous les blocs ont nameSpan.size > 24pt (titre
  // marketing/headline gros = cover Catalogue C "NOS MARQUES" / "JARDIN PISCINE")
  const imgCoverage = computeImageCoverageRatio(page);
  const largestImgRatio = computeLargestImageRatio(page);
  const allHeadlineSize = blocks.every((b) => b.nameSpan.size > 24);
  const isVisuallyDominant =
    imgCoverage > 0.5 || largestImgRatio > 0.35 || allHeadlineSize;
  if (!isVisuallyDominant) return false;
  // Aucun bloc avec ref
  const anyHasRef = blocks.some((b) => b.refSpan !== null);
  if (anyHasRef) return false;
  // Aucun bloc avec image principale identifiee
  const anyHasMainImage = blocks.some((b) => b.mainImageBbox !== null);
  if (anyHasMainImage) return false;
  // Nb total specs sur la page < 3 (avant : per-block < 2 = trop laxiste)
  const totalSpecs = blocks.reduce((sum, b) => sum + b.specs.length, 0);
  return totalSpecs < 3;
}

/** Ratio de la plus grande image individuelle / aire page.
 *  Detecte les covers full-bleed type Catalogue C "NOS MARQUES" (1 grande image
 *  + texte design). Sur Catalogue A : variants 40+ petites images → max ~5%. */
export function computeLargestImageRatio(page: ExtractedPage): number {
  const pageArea = page.page_size.width * page.page_size.height;
  if (pageArea <= 0) return 0;
  const images = page.raw_images ?? [];
  let maxArea = 0;
  for (const bbox of images) {
    const w = Math.max(0, bbox[2] - bbox[0]);
    const h = Math.max(0, bbox[3] - bbox[1]);
    const area = w * h;
    if (area > maxArea) maxArea = area;
  }
  return Math.min(1, maxArea / pageArea);
}

/** Ratio surface couverte d'images sur la page. Approximation : somme
 *  des aires (bbox) divisée par aire totale page. Plafonne à 1 si des
 *  bbox se chevauchent (on ne fait pas de geometric union, juste somme
 *  capée pour performance). */
export function computeImageCoverageRatio(page: ExtractedPage): number {
  const pageArea = page.page_size.width * page.page_size.height;
  if (pageArea <= 0) return 0;
  const images = page.raw_images ?? [];
  let totalImgArea = 0;
  for (const bbox of images) {
    const w = Math.max(0, bbox[2] - bbox[0]);
    const h = Math.max(0, bbox[3] - bbox[1]);
    totalImgArea += w * h;
  }
  return Math.min(1, totalImgArea / pageArea);
}

const INTRO_BRAND_IMAGE_RATIO = 0.4;

// ─── Keywords multilingues sommaire/glossaire/tech ────────────────────────

// Note : on prefere des phrases MULTI-MOTS plutot que des mots seuls trop
// generiques ("contents", "legende", "symbols") qui matcheraient des phrases
// usuelles sur des pages produit (faux positifs).
const TOC_KEYWORDS = [
  // FR
  'table des matieres', 'sommaire', 'index alphabetique', 'index par couleur',
  'index general', 'index produits',
  // EN
  'table of contents', 'alphabetical index', 'color index', 'colour index',
  'product index', 'general index',
  // ES
  'indice alfabetico', 'indice de colores', 'tabla de contenidos',
  'indice general', 'indice de productos',
  // DE
  'inhaltsverzeichnis', 'farbindex', 'produktindex', 'gesamtindex',
  // IT
  'indice alfabetico', 'indice dei colori', 'sommario',
  'indice generale', 'indice prodotti',
  // PT
  'sumario', 'indice de cores', 'tabela de conteudos', 'indice geral',
];

const GLOSSAIRE_KEYWORDS = [
  // FR
  'glossaire des pictogrammes', 'glossaire pictogrammes',
  'legende des pictogrammes', 'legende des symboles',
  // EN
  'pictogram glossary', 'index of pictograms', 'key to symbols',
  'symbol legend', 'icon legend',
  // DE
  'piktogramm', 'piktogramme', 'zeichenerklarung', 'symbolerklarung',
  'symbollegende',
  // ES
  'leyenda de pictogramas', 'leyenda de simbolos', 'glosario de pictogramas',
  // IT
  'legenda dei pittogrammi', 'legenda dei simboli',
  // PT
  'legenda dos pictogramas', 'legenda dos simbolos',
];

const TECH_KEYWORDS = [
  // FR
  'cahier technique', 'aide technique', 'fiche technique', 'synoptique',
  'notice technique', 'donnees techniques', 'caracteristiques techniques',
  // EN
  'technical sheet', 'technical guide', 'technical data',
  'technical specifications', 'data sheet', 'datasheet', 'spec sheet',
  // ES
  'ficha tecnica', 'datos tecnicos', 'guia tecnica',
  'especificaciones tecnicas',
  // DE
  'technisches datenblatt', 'technische daten',
  'technische spezifikationen', 'datenblatt',
  // IT
  'scheda tecnica', 'dati tecnici', 'specifiche tecniche',
  // PT
  'ficha tecnica', 'dados tecnicos', 'especificacoes tecnicas',
];

/**
 * Cherche dans la page un keyword identifiant un sommaire / glossaire /
 * cahier tech. Si match : retourne le PageKind correspondant. Insensible
 * aux accents et a la casse (les pages templates peuvent avoir "Sommaire"
 * ou "SOMMAIRE").
 */
function matchUnwantedKeyword(page: ExtractedPage): PageKind | null {
  const spans = page.raw_spans ?? [];
  if (spans.length === 0) return null;
  // Concat top spans + bas pour matcher les titres typiques de page tech.
  // On normalise une seule fois pour eviter N*M comparisons couteuses.
  const normalized = spans
    .map((s) => stripAccents(s.text).toLowerCase())
    .join(' | ');
  for (const kw of TOC_KEYWORDS) if (normalized.includes(kw)) return 'toc';
  for (const kw of GLOSSAIRE_KEYWORDS) if (normalized.includes(kw)) return 'glossaire';
  // Cahier technique → 'tech' (semantique correcte, audit #8). Traite
  // comme drop par engineOrchestrator au meme titre que 'glossaire'.
  for (const kw of TECH_KEYWORDS) if (normalized.includes(kw)) return 'tech';
  return null;
}

// stripAccents : voir textNormalize.ts (factorise depuis 4 copies, audit #6).

function isGlossairePictos(page: ExtractedPage): boolean {
  const spans = page.raw_spans ?? [];
  if (spans.length < 25) return false;
  const shortLabels = spans.filter((s) => {
    const t = s.text.trim();
    return t.length >= 3 && t.length < 40 && !t.includes('.') && !hasKeyValueSeparator(t);
  });
  if (shortLabels.length < 12) return false;
  if (shortLabels.length / spans.length < 0.45) return false;
  const decoVector = page.slots.filter(
    (s) =>
      s.type === 'decoration' &&
      (s as { kind?: string }).kind === 'vector',
  ).length;
  // P1.6 : seuil relatif. Un glossaire pictos a typiquement 5-20 paths par
  // label. < 5x = page de sommaire avec décoration normale, pas glossaire.
  // Seuil absolu 150 garde un floor minimum (cas spans tres nombreux mais
  // peu de pictos).
  if (decoVector < 50) return false;
  return decoVector >= shortLabels.length * 5;
}

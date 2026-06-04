/**
 * PageSchema — approche B : vue STRUCTUREE d'une page extraite, avec
 * zones nommees (title, image_main, specs_block, page_number...) au lieu
 * de raw_spans + bbox bruts.
 *
 * Sert deux usages :
 *  1. Donner a Claude une representation lisible/raisonnable d'une page
 *     (au lieu de balancer 200 spans avec bbox).
 *  2. Resolver des "targets" lisibles (ex "page_3.title") en bbox
 *     concrets pour generer les ops bas niveau.
 */
import type { Bbox, ColorHex } from '../types';

/** Style typographique d'une zone texte (repris du template, sert au
 *  resolver pour reproduire le bon font/taille/couleur). */
export interface ZoneStyle {
  font: string;
  size: number;
  color: ColorHex;
}

/** Une zone texte simple (titre, numero de page, label banner, etc.). */
export interface TextZone {
  /** Contenu actuel (template) — utile a Claude pour comprendre la nature. */
  text: string;
  bbox: Bbox;
  style: ZoneStyle;
}

/** Zone image (image principale produit, vignette variante, photo lifestyle). */
export interface ImageZone {
  bbox: Bbox;
  /** ID image extrait du PDF (cf raw_images), si pertinent. */
  imageId?: string;
}

/** Bloc de specifications (key : value). Chaque item a sa propre bbox pour
 *  pouvoir cibler `specs_block.item_2.value` precisement. */
export interface SpecsItem {
  key: TextZone;
  value: TextZone;
}

export interface SpecsBlockZone {
  /** Bbox globale du bloc specs (utile pour layout et erase). */
  bbox: Bbox;
  items: SpecsItem[];
}

/** Zones d'UN bloc produit (cas multi-produits par page : 1 ProductBlockZone
 *  par bloc detecte). Les targets s'ecrivent `page_N.product_K.title`. */
export interface ProductBlockZone {
  title?: TextZone;
  reference?: TextZone;
  color?: TextZone;
  image_main?: ImageZone;
  specs_block?: SpecsBlockZone;
  variants?: { bbox: Bbox; images: ImageZone[]; labels: TextZone[] };
}

/** Schema complet d'une page produit. Champs optionnels : toutes les pages
 *  n'ont pas un title / image_main / specs (ex pages identite marque).
 *
 *  Rétro-compat : `title`, `reference`, `color`, `image_main`, `specs_block`,
 *  `variants` au niveau zones reflètent le 1er produit (= `products[0]`).
 *  Le tableau `products` est la SOURCE DE VERITE pour les pages multi-blocs ;
 *  les targets historiques `page_N.title` restent valides et pointent product[0].
 */
export interface PageSchema {
  sourcePage: number;
  kind: 'product' | 'toc' | 'glossaire' | 'tech' | 'intercalaire' | 'identity' | 'unknown';
  pageSize: { width: number; height: number };
  zones: {
    title?: TextZone;
    reference?: TextZone;
    color?: TextZone;
    image_main?: ImageZone;
    specs_block?: SpecsBlockZone;
    variants?: { bbox: Bbox; images: ImageZone[]; labels: TextZone[] };
    page_number?: TextZone;
    section_banner?: TextZone;
    /** Liste de TOUS les blocs produit detectes sur la page (>= 1). */
    products?: ProductBlockZone[];
  };
}

/** Type des selecteurs targets compris par le resolver.
 *  Format : `page_<N>.[product_<K>.]<zone>[.<sub>[.item_<i>][.key|value]]`
 *
 *  Exemples :
 *    page_3.title                                 (legacy = product_0.title)
 *    page_3.product_0.title                       (explicite)
 *    page_3.product_2.specs_block.item_1.value    (multi-produits)
 *    page_3.image_main                            (legacy = product_0.image_main)
 *    page_3.page_number                           (toujours niveau page)
 *    page_3.section_banner                        (toujours niveau page)
 */
export type TargetSelector = string;

/** Resultat d'une resolution de target → bbox + style. */
export interface ResolvedTarget {
  bbox: Bbox;
  style?: ZoneStyle;
  /** True si la cible est une zone texte (vs image). */
  isText: boolean;
}

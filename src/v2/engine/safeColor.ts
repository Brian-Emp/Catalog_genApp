/**
 * safeColor : normalise une couleur de texte pour le rendu substitue.
 *
 * Probleme racine : sur certains catalogues (Catalogue C notamment), les noms
 * produit du template sont en BLANC car ils s'affichent sur un CARTOUCHE
 * COLORE (path background bleu/vert/etc.). Quand on substitue le bloc, le
 * pipeline efface le fond du bloc (erase fond bloc large blanc) MAIS conserve
 * la couleur du span template => texte blanc sur fond blanc = invisible.
 *
 * Le fix detecte les couleurs "trop claires" (proches du blanc) et les
 * bascule en noir pour rester lisibles apres effacement du fond.
 *
 * Convention : '#rrggbb' (alpha non gere). Si format invalide, on retourne
 * la valeur d'origine (no-op safe).
 */

import type { ColorHex } from '../types';

/** Seuil de luminosite au-dela duquel on considere une couleur "trop claire"
 *  pour etre lisible sur fond blanc. R+G+B somme = 765 max ; on prend 700
 *  (~91% de blanc) = whiteish. */
const LIGHT_THRESHOLD_SUM = 700;

/**
 * Retourne une couleur SAFE pour rendu de texte sur fond blanc :
 *  - Si la couleur d'origine est tres claire (proche blanc) → '#000000' (noir).
 *  - Sinon → couleur d'origine inchangee.
 *
 * Cas d'usage : utiliser pour TOUT insert_text qui reprend span.color d'un
 * template ou` le fond cartouche est efface.
 */
export function safeTextColor(color: ColorHex | null | undefined): ColorHex {
  if (!color) return '#000000';
  const norm = color.trim().toLowerCase();
  // Format attendu: #rrggbb (7 chars). Si autre format on fait safe.
  if (!/^#[0-9a-f]{6}$/.test(norm)) return color;
  const r = parseInt(norm.slice(1, 3), 16);
  const g = parseInt(norm.slice(3, 5), 16);
  const b = parseInt(norm.slice(5, 7), 16);
  if (r + g + b >= LIGHT_THRESHOLD_SUM) {
    return '#000000';
  }
  return color;
}

/** Variante : retourne true si la couleur est trop claire (proche blanc). */
export function isLightColor(color: ColorHex | null | undefined): boolean {
  if (!color) return false;
  const norm = color.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(norm)) return false;
  const r = parseInt(norm.slice(1, 3), 16);
  const g = parseInt(norm.slice(3, 5), 16);
  const b = parseInt(norm.slice(5, 7), 16);
  return r + g + b >= LIGHT_THRESHOLD_SUM;
}

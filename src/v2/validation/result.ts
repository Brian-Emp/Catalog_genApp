/**
 * Pattern Result<T, E> — alternative aux exceptions.
 *
 * Une fonction qui peut echouer renvoie soit { ok: true, data: ... } soit
 * { ok: false, errors: [...] }. Le compilateur TS force le code appelant a
 * gerer les 2 cas (impossible d'oublier).
 *
 * Inspire de Rust (Result<T, E>) et Go (val, err pattern).
 */

/** Une erreur de validation : chemin dans le JSON + message en clair. */
export type ValidationError = {
  /** Chemin pointant vers le champ fautif, ex "slots[2].name.bbox". */
  path: string;
  /** Description en francais lisible. */
  message: string;
};

/** Resultat d'une validation : succes (data type) ou echec (liste d'erreurs). */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; errors: ValidationError[] };

/** Helper pour construire un succes. */
export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

/** Helper pour construire un echec. */
export function err(errors: ValidationError[]): Result<never> {
  return { ok: false, errors };
}

/** Helper pour echec avec une seule erreur. */
export function singleErr(path: string, message: string): Result<never> {
  return { ok: false, errors: [{ path, message }] };
}

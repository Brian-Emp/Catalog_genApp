/**
 * Result<T, E> pattern — an alternative to exceptions.
 *
 * A function that can fail returns either { ok: true, data: ... } or
 * { ok: false, errors: [...] }. The TS compiler forces the calling code
 * to handle both cases (impossible to forget).
 *
 * Inspired by Rust (Result<T, E>) and Go (val, err pattern).
 */

/** A validation error: path within the JSON + plain-text message. */
export type ValidationError = {
  /** Path pointing to the offending field, e.g. "slots[2].name.bbox". */
  path: string;
  /** Human-readable description in French. */
  message: string;
};

/** Result of a validation: success (typed data) or failure (list of errors). */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; errors: ValidationError[] };

/** Helper to build a success. */
export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

/** Helper to build a failure. */
export function err(errors: ValidationError[]): Result<never> {
  return { ok: false, errors };
}

/** Helper for a failure with a single error. */
export function singleErr(path: string, message: string): Result<never> {
  return { ok: false, errors: [{ path, message }] };
}

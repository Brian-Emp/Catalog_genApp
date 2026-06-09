/**
 * Reusable validation building blocks. All are "type guards":
 * functions that return a boolean AND tell the TS compiler "if I
 * return true, then the value passed as parameter is of such-and-such type".
 *
 * This lets you write:
 *   if (isString(x)) {
 *     // here TS knows that x: string
 *     console.log(x.toUpperCase());
 *   }
 */

/** True if v is an object (and not null, not an array). */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True if v is an array (of anything). */
export function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/** True if v is a string. */
export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/** True if v is a finite number (not NaN, not Infinity). */
export function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** True if v is an integer (number with no decimal part). */
export function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** True if v is a boolean. */
export function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/** True if v is null. */
export function isNull(v: unknown): v is null {
  return v === null;
}

/**
 * True if v is exactly one of the values in the list.
 * The `as const` on the caller side guarantees that TS sees the values as
 * string literals (and not as `string`), which enables the narrowing.
 */
export function isOneOf<T extends string>(
  v: unknown,
  values: readonly T[],
): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v);
}

/** True if v is a hex color "#rrggbb" (case-insensitive). */
export function isHexColor(v: unknown): v is string {
  return isString(v) && /^#[0-9a-fA-F]{6}$/.test(v);
}

/** True if v is a bbox: [x0, y0, x1, y1] of 4 finite numbers. */
export function isBbox(v: unknown): v is [number, number, number, number] {
  return (
    isArray(v) &&
    v.length === 4 &&
    v.every((n) => isNumber(n))
  );
}

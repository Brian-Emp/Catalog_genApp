/**
 * Briques de validation reutilisables. Toutes sont des "type guards" :
 * fonctions qui retournent un boolean ET disent au compilateur TS "si je
 * retourne true, alors la valeur passee en parametre est de tel type".
 *
 * Ca permet de faire :
 *   if (isString(x)) {
 *     // ici TS sait que x: string
 *     console.log(x.toUpperCase());
 *   }
 */

/** Vrai si v est un objet (et pas null, pas un array). */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Vrai si v est un tableau (de quoi que ce soit). */
export function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/** Vrai si v est une string. */
export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/** Vrai si v est un number fini (pas NaN, pas Infinity). */
export function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Vrai si v est un entier (number sans partie decimale). */
export function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Vrai si v est un boolean. */
export function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/** Vrai si v est null. */
export function isNull(v: unknown): v is null {
  return v === null;
}

/**
 * Vrai si v est exactement l'une des valeurs de la liste.
 * Le `as const` cote appelant garantit que TS voit les valeurs comme
 * des string litterales (et pas comme `string`), ce qui permet le narrowing.
 */
export function isOneOf<T extends string>(
  v: unknown,
  values: readonly T[],
): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v);
}

/** Vrai si v est une couleur hexa "#rrggbb" (insensible a la casse). */
export function isHexColor(v: unknown): v is string {
  return isString(v) && /^#[0-9a-fA-F]{6}$/.test(v);
}

/** Vrai si v est une bbox : [x0, y0, x1, y1] de 4 numbers finis. */
export function isBbox(v: unknown): v is [number, number, number, number] {
  return (
    isArray(v) &&
    v.length === 4 &&
    v.every((n) => isNumber(n))
  );
}

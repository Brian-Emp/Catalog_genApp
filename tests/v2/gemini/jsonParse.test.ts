import { describe, it, expect } from 'vitest';
import { parseGeminiJson } from '../../../src/v2/gemini/jsonParse';

describe('parseGeminiJson', () => {
  it('parse JSON propre', () => {
    expect(parseGeminiJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('parse array', () => {
    expect(parseGeminiJson<number[]>('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('strip ```json fence', () => {
    expect(parseGeminiJson<{ x: string }>('```json\n{"x":"y"}\n```')).toEqual({ x: 'y' });
  });

  it('strip ``` fence sans json', () => {
    expect(parseGeminiJson<{ a: number }>('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extract {...} apres prose', () => {
    expect(parseGeminiJson<{ k: string }>('Voici ta reponse : {"k":"v"} c est tout.')).toEqual({ k: 'v' });
  });

  it('extract [...] apres prose', () => {
    expect(parseGeminiJson<number[]>('Resultat: [1,2,3] fin.')).toEqual([1, 2, 3]);
  });

  it('retourne null si vide', () => {
    expect(parseGeminiJson('')).toBeNull();
    // @ts-expect-error test runtime
    expect(parseGeminiJson(null)).toBeNull();
  });

  it('retourne null si pas de JSON', () => {
    expect(parseGeminiJson('hello world')).toBeNull();
  });

  it('parse objet avec nested arrays', () => {
    const r = parseGeminiJson<{ items: number[] }>('```json\n{"items":[1,2]}\n```');
    expect(r).toEqual({ items: [1, 2] });
  });
});

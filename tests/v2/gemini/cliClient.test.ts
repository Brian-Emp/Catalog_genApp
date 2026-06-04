import { describe, it, expect } from 'vitest';
import { extractCliText, GEMINI_CLI_MODELS } from '../../../src/v2/gemini/cliClient';

describe('extractCliText', () => {
  it('extrait le champ response (format json CLI)', () => {
    expect(extractCliText('{"response":"Bonjour"}')).toBe('Bonjour');
  });

  it('extrait result si pas de response', () => {
    expect(extractCliText('{"result":"OK"}')).toBe('OK');
  });

  it('extrait text / content / output', () => {
    expect(extractCliText('{"text":"A"}')).toBe('A');
    expect(extractCliText('{"content":"B"}')).toBe('B');
    expect(extractCliText('{"output":"C"}')).toBe('C');
  });

  it('priorise response sur les autres cles', () => {
    expect(extractCliText('{"response":"R","text":"T"}')).toBe('R');
  });

  it('trim le texte extrait', () => {
    expect(extractCliText('{"response":"  hi  "}')).toBe('hi');
  });

  it('fallback texte brut si output-format text', () => {
    expect(extractCliText('Juste du texte brut')).toBe('Juste du texte brut');
  });

  it('retourne le JSON brut si parse OK mais aucune cle texte connue', () => {
    // Cas : le prompt demandait du JSON metier (mapping), le CLI le renvoie
    // directement comme reponse json sans wrapper. Le caller le parsera.
    const raw = '{"name":"Designation","sku":"Code"}';
    expect(extractCliText(raw)).toBe(raw);
  });

  it('retourne null si vide', () => {
    expect(extractCliText('')).toBeNull();
    expect(extractCliText('   ')).toBeNull();
  });

  it('ignore les cles non-string', () => {
    // response numerique ignoree → fallback JSON brut
    const raw = '{"response":123,"stats":{}}';
    expect(extractCliText(raw)).toBe(raw);
  });

  it('extrait message si present', () => {
    expect(extractCliText('{"message":"coucou"}')).toBe('coucou');
  });
});

describe('GEMINI_CLI_MODELS', () => {
  it('expose pro + flash', () => {
    expect(GEMINI_CLI_MODELS.pro).toBe('gemini-2.5-pro');
    expect(GEMINI_CLI_MODELS.flash).toBe('gemini-2.5-flash');
  });
});

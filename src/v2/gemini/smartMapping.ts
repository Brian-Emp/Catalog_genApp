/**
 * Smart mapping XLSX → produits via Gemini (alternative à Claude CLI).
 *
 * Reçoit : headers XLSX + qq lignes d'exemple + mapping heuristique (avec
 * trous éventuels).
 * Retourne : mapping complet { name, sku, color, image, section, family }.
 *
 * Avantages vs Claude CLI :
 *  - Gratuit free tier (Gemini Flash 15 RPM / 1500 RPD)
 *  - Pas d'expiration auth (clé API stable)
 *  - Plus rapide (HTTP direct vs spawn CLI)
 *  - Context 1M tokens = peut analyser des XLSX larges en une passe
 *
 * Contract identique a claudeColumnMap : même types I/O pour swap drop-in.
 */

import { isGeminiAvailable } from './client';
import { routedGenerateText } from './providerRouter';
import { parseGeminiJson } from './jsonParse';
import type { ClaudeColumnMapping } from '../../services/claudeColumnMapper';

export interface GeminiMappingOptions {
  headers: string[];
  sampleRows: Record<string, string>[];
  /** Pre-detection heuristique : Gemini complète les trous. */
  heuristic?: Partial<ClaudeColumnMapping>;
  /** Si false : retourne null sans appel Gemini. Default true. */
  enabled?: boolean;
}

export interface GeminiMappingResult {
  /** Mapping fusionne (heuristique + Gemini pour les champs manquants). */
  mapping: ClaudeColumnMapping | null;
  ran: boolean;
  durationMs: number;
  /** Cout estime (USD). Optionnel : Gemini free tier = 0. */
  costUsd?: number;
  notes: string[];
}

const MAX_HEADERS_FOR_PROMPT = 100;
const MAX_SAMPLE_ROWS = 3;

export async function geminiColumnMap(
  opts: GeminiMappingOptions,
): Promise<GeminiMappingResult> {
  const t0 = Date.now();
  const notes: string[] = [];

  if (opts.enabled === false) {
    return { mapping: null, ran: false, durationMs: 0, notes: ['disabled'] };
  }
  if (!opts.headers || opts.headers.length === 0) {
    return { mapping: null, ran: false, durationMs: 0, notes: ['no headers'] };
  }
  if (!(await isGeminiAvailable())) {
    return { mapping: null, ran: false, durationMs: Date.now() - t0, notes: ['GEMINI_KEY absente'] };
  }

  // Cap : si trop de headers, on tronque (sample des 100 premiers).
  const headers = opts.headers.slice(0, MAX_HEADERS_FOR_PROMPT);
  const sampleRows = (opts.sampleRows ?? []).slice(0, MAX_SAMPLE_ROWS);
  const heuristic: ClaudeColumnMapping = {
    name: opts.heuristic?.name ?? null,
    sku: opts.heuristic?.sku ?? null,
    color: opts.heuristic?.color ?? null,
    image: opts.heuristic?.image ?? null,
    section: opts.heuristic?.section ?? null,
    family: opts.heuristic?.family ?? null,
  };

  const prompt = buildPrompt(headers, sampleRows, heuristic);
  // pref 'speed' : mapping = sortie JSON courte, l'API flash-lite (1-3s) est
  // ideale. Fallback CLI Gemini Pro si l'API est en quota (resilience).
  const res = await routedGenerateText({
    prompt,
    pref: 'speed',
    temperature: 0.1, // strict pour mapping
    maxOutputTokens: 1024,
    module: 'smartMapping',
  });
  if (!res.ok || !res.text) {
    notes.push(`gemini error: ${res.error}`);
    return { mapping: null, ran: false, durationMs: Date.now() - t0, notes };
  }

  const parsed = parseMappingJson(res.text);
  if (!parsed) {
    notes.push('reponse non-JSON parseable');
    return { mapping: null, ran: true, durationMs: Date.now() - t0, notes };
  }

  // Fusion : Gemini ne peut OVERRIDE l'heuristique. Il ne remplit que les
  // trous (champs null). On valide aussi que chaque mapped column existe
  // bien dans headers (Gemini hallucine parfois des noms).
  const headerSet = new Set(headers);
  const mapping: ClaudeColumnMapping = { ...heuristic };
  for (const key of ['name', 'sku', 'color', 'image', 'section', 'family'] as const) {
    if (mapping[key]) continue; // garde la valeur heuristique
    const candidate = parsed[key];
    if (candidate && headerSet.has(candidate)) {
      mapping[key] = candidate;
    }
  }

  return {
    mapping,
    ran: true,
    durationMs: Date.now() - t0,
    notes,
  };
}

function buildPrompt(
  headers: string[],
  sampleRows: Record<string, string>[],
  heuristic: ClaudeColumnMapping,
): string {
  const headerList = headers.map((h) => `- ${h}`).join('\n');
  const sample = sampleRows.length === 0
    ? 'AUCUN'
    : sampleRows.map((r, i) => `Ligne ${i + 1} : ${JSON.stringify(r).slice(0, 300)}`).join('\n');
  const heuristicJson = JSON.stringify(heuristic, null, 2);

  return `Tu es un mapper de colonnes XLSX pour un pipeline de generation de catalogue produit.

HEADERS XLSX (colonnes disponibles, choisir EXACTEMENT parmi ceux-ci) :
${headerList}

ECHANTILLON DE DONNEES :
${sample}

MAPPING HEURISTIQUE EXISTANT (a completer, pas modifier) :
${heuristicJson}

TACHE : pour CHAQUE champ encore null dans le mapping heuristique, devine
le nom EXACT du header XLSX qui correspond.

CHAMPS A MAPPER :
- name : nom commercial du produit (ex "Désignation Produit", "Libellé article")
- sku : code/référence unique (ex "Code Produit", "Réf.", "EAN", "Gencod")
- color : couleur/finition (ex "Coloris", "Finition", "Color")
- image : nom de fichier image (ex "image_path", "photo", "media")
- section : sous-categorie (ex "Libellé SSFamille", "Catégorie", "Sous-famille")
- family : famille macro (ex "Libellé Famille", "Famille", "Type")

Si AUCUN header ne correspond a un champ, mets null pour ce champ.

REPONDS UNIQUEMENT en JSON pur (pas de markdown, pas de prose) :
{
  "name": "<header exact ou null>",
  "sku": "<header exact ou null>",
  "color": "<header exact ou null>",
  "image": "<header exact ou null>",
  "section": "<header exact ou null>",
  "family": "<header exact ou null>"
}`;
}

interface ParsedMapping {
  name?: string | null;
  sku?: string | null;
  color?: string | null;
  image?: string | null;
  section?: string | null;
  family?: string | null;
}

function parseMappingJson(text: string): ParsedMapping | null {
  return parseGeminiJson<ParsedMapping>(text);
}

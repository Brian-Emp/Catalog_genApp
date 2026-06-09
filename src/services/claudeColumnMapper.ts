/**
 * Smart xlsx/csv column mapping via Claude.
 *
 * Optional call when the regex heuristic doesn't find everything (typically:
 * exotic headers, foreign language, custom client naming). Claude looks at the
 * headers + 3 sample rows and proposes the most likely mapping.
 *
 * Output: { name, sku, color, image, section, family }. Everything is nullable.
 * The caller merges with the heuristic, keeping Claude's values for the
 * missing or ambiguous fields.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { callClaudeCli } from '../v2/claudeCli';
import { CLAUDE_CLI_TIMEOUT_MS } from '../v2/timeouts';

export interface ClaudeColumnMapping {
  name: string | null;
  sku: string | null;
  color: string | null;
  image: string | null;
  section: string | null;
  family: string | null;
}

export interface ColumnMapperOptions {
  headers: string[];
  sampleRows: Record<string, string>[];
  workDir: string;
  projectDir: string;
  claudeBin?: string;
  /** Heuristic pre-detection: Claude will fill in the gaps. */
  heuristic?: Partial<ClaudeColumnMapping>;
  /** If false, returns null without calling Claude. Default true. */
  enabled?: boolean;
}

export interface ColumnMapperResult {
  /** Merged mapping (heuristic + Claude for the missing fields). null if Claude was not called. */
  mapping: ClaudeColumnMapping | null;
  /** True if Claude was actually invoked. */
  ran: boolean;
  durationMs: number;
  costUsd?: number;
  notes: string[];
}

export async function claudeColumnMap(
  opts: ColumnMapperOptions,
): Promise<ColumnMapperResult> {
  const t0 = Date.now();
  if (opts.enabled === false) {
    return { mapping: null, ran: false, durationMs: 0, notes: ['disabled'] };
  }
  if (opts.headers.length === 0) {
    return { mapping: null, ran: false, durationMs: 0, notes: ['no headers'] };
  }

  const auditPath = path.join(opts.workDir, 'column-mapping.json');
  const seed: ClaudeColumnMapping = {
    name: opts.heuristic?.name ?? null,
    sku: opts.heuristic?.sku ?? null,
    color: opts.heuristic?.color ?? null,
    image: opts.heuristic?.image ?? null,
    section: opts.heuristic?.section ?? null,
    family: opts.heuristic?.family ?? null,
  };
  await fs.writeFile(auditPath, JSON.stringify({ mapping: seed, notes: [] }, null, 2), 'utf8');

  const prompt = buildPrompt(opts.headers, opts.sampleRows.slice(0, 3), seed, auditPath);
  const res = await callClaudeCli({
    prompt,
    workDir: opts.workDir,
    projectDir: opts.projectDir,
    claudeBin: opts.claudeBin,
    timeoutMs: CLAUDE_CLI_TIMEOUT_MS,
    allowedTools: 'Edit',
  });

  const notes: string[] = [];
  if (!res.ok) {
    notes.push('claude column mapper failed: ' + (res.result?.slice(0, 200) ?? 'unknown'));
    return { mapping: null, ran: false, durationMs: Date.now() - t0, notes };
  }
  let parsed: { mapping?: unknown; notes?: unknown };
  try {
    parsed = JSON.parse(await fs.readFile(auditPath, 'utf8'));
  } catch (e) {
    notes.push('parse column-mapping failed: ' + (e as Error).message);
    return { mapping: null, ran: false, durationMs: Date.now() - t0, notes };
  }
  const claudeMapping = sanitizeMapping(parsed.mapping, opts.headers);
  if (Array.isArray(parsed.notes)) {
    for (const n of parsed.notes) if (typeof n === 'string') notes.push(n);
  }
  // Merge: Claude will fill in the nulls. The heuristic takes precedence for
  // its own positive detections (so as not to break a mapping that works).
  const merged: ClaudeColumnMapping = {
    name: seed.name ?? claudeMapping.name,
    sku: seed.sku ?? claudeMapping.sku,
    color: seed.color ?? claudeMapping.color,
    image: seed.image ?? claudeMapping.image,
    section: seed.section ?? claudeMapping.section,
    family: seed.family ?? claudeMapping.family,
  };
  return {
    mapping: merged,
    ran: true,
    durationMs: Date.now() - t0,
    costUsd: res.costUsd,
    notes,
  };
}

function sanitizeMapping(raw: unknown, headers: string[]): ClaudeColumnMapping {
  const empty: ClaudeColumnMapping = {
    name: null, sku: null, color: null, image: null, section: null, family: null,
  };
  if (!raw || typeof raw !== 'object') return empty;
  const o = raw as Record<string, unknown>;
  const allowed = new Set(headers);
  const pick = (v: unknown): string | null =>
    typeof v === 'string' && allowed.has(v) ? v : null;
  return {
    name: pick(o.name),
    sku: pick(o.sku),
    color: pick(o.color),
    image: pick(o.image),
    section: pick(o.section),
    family: pick(o.family),
  };
}

function buildPrompt(
  headers: string[],
  sampleRows: Record<string, string>[],
  heuristic: ClaudeColumnMapping,
  auditPath: string,
): string {
  const sampleText = sampleRows
    .map((row, i) => {
      const cols = headers
        .map((h) => `  ${h}: ${truncate(String(row[h] ?? ''), 80)}`)
        .join('\n');
      return `Ligne ${i + 1} :\n${cols}`;
    })
    .join('\n\n');
  return `Tu es l'auditeur du mapping colonnes d'un xlsx/csv produit vers les champs standards d'un catalogue.

HEADERS DU FICHIER :
${headers.map((h, i) => `  [${i}] ${h}`).join('\n')}

ECHANTILLON (3 premieres lignes) :
${sampleText}

MAPPING HEURISTIQUE DEJA TROUVE (a confirmer / completer, les nulls sont a remplir si possible) :
${JSON.stringify(heuristic, null, 2)}

TA MISSION : pour CHAQUE champ standard (name, sku, color, image, section, family),
identifie le HEADER EXACT (ou null si absent dans ce fichier).

DEFINITIONS des champs :
- name : nom commercial du produit, ex "BARRE DOUCHE TAMARI 60 CHR BT". Pas un code, pas une famille.
- sku : reference unique du produit, code alphanumerique court (ex "4027841", "ECOP100"). EAN/gencod acceptable si rien d'autre.
- color : finition ou couleur (ex "Chromé", "Noir", "Inox"). null si absent.
- image : nom de fichier image du produit (ex "image.jpg"). null si pas de colonne dediee.
- section : sous-categorie / sous-famille (ex "BARRES DE DOUCHES"). null si absent.
- family : famille macro (ex "Robinetterie", "Salle de bains"). null si absent.

REGLES :
- Le header doit etre UN EXACT match d'un header liste ci-dessus (sensible a la casse + accents).
- Si plusieurs candidats, choisis le plus specifique (ex "Designation Produit" > "Libelle Court").
- Si tu n'es pas sur, mets null.
- Conserve les valeurs heuristiques NON-NULL telles quelles (ne les ecrase pas).

REPONDS UNIQUEMENT en editant ${auditPath} avec ce schema EXACT :
{
  "mapping": {
    "name": "<header exact>" | null,
    "sku": "<header exact>" | null,
    "color": "<header exact>" | null,
    "image": "<header exact>" | null,
    "section": "<header exact>" | null,
    "family": "<header exact>" | null
  },
  "notes": [
    "<une phrase explicative si choix non evident>"
  ]
}

Ne reponds RIEN d'autre que cet edit.`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

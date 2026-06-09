/**
 * Normalization of product spec keys to the template's style via Claude.
 *
 * Use case: a client xlsx with keys in a different language/style than the
 * template (e.g. "Largo bras" on the xlsx side, "LONGUEUR :" on the template
 * side). Without remapping, the substitutor displays "LARGO BRAS :" instead
 * of "LONGUEUR :", which breaks the catalog's appearance.
 *
 * Strategy: triggered automatically on mismatch detection (> 50% of product
 * keys absent from the template). On a low mismatch: silent skip, no
 * pointless Claude call.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { callClaudeCli } from '../claudeCli';
import { CLAUDE_CLI_TIMEOUT_MS } from '../timeouts';
import type { PlanProduct } from '../types';

const MIN_TRIGGER_MISMATCH_RATIO = 0.5;
const MIN_SUSPECT_RATIO = 0.5;
const MAX_TEMPLATE_KEYS_SAMPLE = 30;

/** "Suspect" key = contains an underscore (signature of a raw ERP-style xlsx
 *  header "Material_principal", "Largo_cm"). A clean humanized French key has
 *  no underscore. A simple, robust criterion that avoids the baseline drift
 *  where Claude "simplifies" an already-clean humanized key
 *  (e.g. "DURÉE DE GARANTIE (EN ANNÉES) :" → "GARANTIE :"). */
const SUSPECT_KEY_RE = /_/;

export interface SpecNormalizerOptions {
  products: PlanProduct[];
  /** List of spec keys seen in the template (extracted by the caller from the
   *  ProductBlock blocks detected in Phase 1). */
  templateSpecKeys: string[];
  workDir: string;
  projectDir: string;
  claudeBin?: string;
  enabled?: boolean;
}

export interface SpecNormalizerResult {
  ran: boolean;
  durationMs: number;
  costUsd?: number;
  notes: string[];
  keysRemapped: number;
}

export async function normalizeSpecs(
  opts: SpecNormalizerOptions,
): Promise<SpecNormalizerResult> {
  const t0 = Date.now();
  if (opts.enabled === false) {
    return { ran: false, durationMs: 0, notes: ['disabled'], keysRemapped: 0 };
  }
  const templateKeys = dedupTrim(opts.templateSpecKeys);
  if (templateKeys.length === 0) {
    return { ran: false, durationMs: 0, notes: ['template sans spec keys'], keysRemapped: 0 };
  }
  const productKeys = new Set<string>();
  for (const p of opts.products) {
    for (const s of p.specs) productKeys.add(s.key);
  }
  if (productKeys.size === 0) {
    return { ran: false, durationMs: 0, notes: ['aucune spec produit'], keysRemapped: 0 };
  }
  const templateKeySet = new Set(templateKeys.map(normalizeForMatch));
  let matchedCount = 0;
  for (const pk of productKeys) {
    if (templateKeySet.has(normalizeForMatch(pk))) matchedCount++;
  }
  const mismatchRatio = 1 - matchedCount / productKeys.size;
  if (mismatchRatio < MIN_TRIGGER_MISMATCH_RATIO) {
    return {
      ran: false,
      durationMs: Date.now() - t0,
      notes: [
        `mismatch ${Math.round(mismatchRatio * 100)}% < seuil ${Math.round(MIN_TRIGGER_MISMATCH_RATIO * 100)}% — skip`,
      ],
      keysRemapped: 0,
    };
  }
  // Trigger only if the product keys are REALLY exotic (raw ASCII ERP code).
  // A clean humanized French key should not be remapped, otherwise Claude
  // "simplifies" abusively (e.g. "DURÉE DE GARANTIE (EN ANNÉES) :" →
  // "GARANTIE :" because the allocated template mentions "GARANTIE :").
  let suspectCount = 0;
  for (const pk of productKeys) if (SUSPECT_KEY_RE.test(pk)) suspectCount++;
  const suspectRatio = suspectCount / productKeys.size;
  if (suspectRatio < MIN_SUSPECT_RATIO) {
    return {
      ran: false,
      durationMs: Date.now() - t0,
      notes: [
        `keys produit deja propres (${Math.round((1 - suspectRatio) * 100)}% non-ASCII / humanisees) — skip`,
      ],
      keysRemapped: 0,
    };
  }

  // Try Gemini first (free + fast). Fallback to Claude on failure.
  const notes: string[] = [];
  let mapping: Record<string, string> = {};
  let costUsd: number | undefined;
  let usedFallback = false;

  try {
    const { geminiNormalizeSpecs } = await import('../gemini/specNormalizer');
    const gem = await geminiNormalizeSpecs({
      productKeys: [...productKeys],
      templateKeys: templateKeys.slice(0, MAX_TEMPLATE_KEYS_SAMPLE),
      enabled: true,
    });
    if (gem.ran && Object.keys(gem.mapping).length > 0) {
      mapping = gem.mapping;
      notes.push('spec mapping via Gemini Flash', ...gem.notes);
    } else if (gem.ran) {
      notes.push('Gemini : 0 remap');
    } else {
      notes.push(...gem.notes);
      usedFallback = true;
    }
  } catch (e) {
    notes.push(`gemini spec normalizer failed: ${(e as Error).message}`);
    usedFallback = true;
  }

  // Fallback to Claude if Gemini failed
  if (usedFallback || Object.keys(mapping).length === 0) {
    const auditPath = path.join(opts.workDir, 'spec-mapping.json');
    await fs.writeFile(auditPath, JSON.stringify({ mapping: {}, notes: [] }, null, 2), 'utf8');
    const prompt = buildPrompt(
      templateKeys.slice(0, MAX_TEMPLATE_KEYS_SAMPLE),
      [...productKeys],
      auditPath,
    );
    const res = await callClaudeCli({
      prompt,
      workDir: opts.workDir,
      projectDir: opts.projectDir,
      claudeBin: opts.claudeBin,
      timeoutMs: CLAUDE_CLI_TIMEOUT_MS,
      allowedTools: 'Edit',
    });
    if (!res.ok) {
      notes.push('claude spec normalizer failed: ' + (res.result?.slice(0, 200) ?? 'unknown'));
      return { ran: false, durationMs: Date.now() - t0, notes, keysRemapped: 0 };
    }
    costUsd = res.costUsd;
    try {
      const parsed = JSON.parse(await fs.readFile(auditPath, 'utf8')) as {
        mapping?: unknown;
        notes?: unknown;
      };
      if (parsed.mapping && typeof parsed.mapping === 'object') {
        for (const [k, v] of Object.entries(parsed.mapping as Record<string, unknown>)) {
          if (typeof v === 'string' && productKeys.has(k) && v !== k) {
            mapping[k] = v;
          }
        }
      }
      if (Array.isArray(parsed.notes)) {
        for (const n of parsed.notes) if (typeof n === 'string') notes.push(n);
      }
    } catch (e) {
      notes.push('parse spec-mapping failed: ' + (e as Error).message);
      return { ran: false, durationMs: Date.now() - t0, notes, keysRemapped: 0 };
    }
  } // end Claude fallback
  // In-place mutation: the substitutor reads the spec keys by product
  // reference, so remapping in place is enough. No need to rebuild
  // analysis/allocation.
  let remapped = 0;
  for (const p of opts.products) {
    for (const s of p.specs) {
      const newKey = mapping[s.key];
      if (newKey) {
        s.key = newKey;
        remapped++;
      }
    }
  }
  return {
    ran: true,
    durationMs: Date.now() - t0,
    costUsd,
    notes,
    keysRemapped: remapped,
  };
}

function dedupTrim(keys: string[]): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    const t = k.trim();
    if (t.length > 0 && t.length < 80) out.add(t);
  }
  return [...out];
}

function normalizeForMatch(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildPrompt(
  templateKeys: string[],
  productKeys: string[],
  auditPath: string,
): string {
  return `Tu es l'auditeur de normalisation des "spec keys" entre un fichier produit xlsx et un template PDF.

KEYS DU TEMPLATE (style attendu, a respecter scrupuleusement avec accents, casse, ponctuation, parentheses, deux-points) :
${templateKeys.map((k) => `  - "${k}"`).join('\n')}

KEYS DU XLSX (a remapper vers le style template quand applicable) :
${productKeys.map((k) => `  - "${k}"`).join('\n')}

TA MISSION : pour CHAQUE key xlsx qui designe la MEME notion qu'une key template, produit une entree mapping { keyXlsx: keyTemplate }.

REGLES :
- N'ajoute une entree QUE si tu es sur que les deux keys designent la meme info (ex "Largo cm" → "LONGUEUR :" : OUI ; "Material" → "FINITION :" : NON, ce sont deux notions distinctes).
- Conserve EXACTEMENT le style du template (espaces, accents, ":", parentheses, casse).
- Si une key xlsx n'a pas d'equivalent template, NE PAS l'ajouter au mapping.
- Ne mets QUE des cles xlsx presentes dans la liste ci-dessus. Ne mets QUE des valeurs template presentes dans la liste ci-dessus.

REPONDS UNIQUEMENT en editant ${auditPath} avec ce schema EXACT :
{
  "mapping": {
    "<key xlsx>": "<key template>",
    ...
  },
  "notes": [
    "<une phrase si choix non evident>"
  ]
}

Ne reponds RIEN d'autre que cet edit. Si aucun mapping evident, mapping={} et au moins 1 note explicative.`;
}

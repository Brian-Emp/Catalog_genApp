/**
 * Normalisation des spec keys produit au style du template via Claude.
 *
 * Cas d'usage : xlsx client avec keys en langue/style different du template
 * (ex "Largo bras" cote xlsx, "LONGUEUR :" cote template). Sans remap, le
 * substitutor affiche "LARGO BRAS :" au lieu de "LONGUEUR :", ce qui casse
 * l'apparence du catalogue.
 *
 * Strategie : declenchement automatique sur detection de mismatch (> 50% des
 * keys produit absentes du template). Si mismatch faible : skip silencieux,
 * pas d'appel Claude inutile.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { callClaudeCli } from '../claudeCli';
import { CLAUDE_CLI_TIMEOUT_MS } from '../timeouts';
import type { PlanProduct } from '../types';

const MIN_TRIGGER_MISMATCH_RATIO = 0.5;
const MIN_SUSPECT_RATIO = 0.5;
const MAX_TEMPLATE_KEYS_SAMPLE = 30;

/** Cle "suspecte" = contient un underscore (signature d'un header xlsx
 *  brut style ERP "Material_principal", "Largo_cm"). Une cle francaise
 *  humanisee propre n'a pas d'underscore. Critere simple, robuste, et qui
 *  evite la derive baseline ou Claude "simplifie" une key humanisee deja
 *  propre (ex "DURÉE DE GARANTIE (EN ANNÉES) :" → "GARANTIE :"). */
const SUSPECT_KEY_RE = /_/;

export interface SpecNormalizerOptions {
  products: PlanProduct[];
  /** Liste des spec keys vues dans le template (extraite par le caller depuis
   *  les blocks ProductBlock detectes en Phase 1). */
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
  // Trigger seulement si les product keys sont VRAIMENT exotiques (code ERP
  // brut ASCII). Une key francaise humanisee propre n'est pas a remapper, sinon
  // Claude "simplifie" abusivement (ex "DURÉE DE GARANTIE (EN ANNÉES) :" →
  // "GARANTIE :" parce que le template alloue parle de "GARANTIE :").
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

  // Tente Gemini en premier (gratuit + rapide). Fallback Claude si KO.
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

  // Fallback Claude si Gemini KO
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
  } // fin fallback Claude
  // Mutation in-place : substitutor lit les spec keys par reference produit,
  // donc remapper en place suffit. Pas besoin de recreer analysis/allocation.
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

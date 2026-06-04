/**
 * Boucle iterative Claude → IntentOps → re-render.
 *
 * Apres le 1er render C++, on rastere un echantillon de pages produit
 * substituees, on demande a Claude vision des IntentOps correctives, on
 * les resout en Operations bas niveau et on les injecte dans le plan.json
 * pour un nouveau passage du binaire C++.
 *
 * Iteration : on s'arrete des qu'une passe ne produit plus aucun intent,
 * ou apres `maxIterations` passes (defaut 2).
 *
 * Le binaire C++ ne bouge pas : on ne fait qu'ajouter des Operations a
 * `pages[i].render.operations` et reecrire plan.json.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { renderPagePng } from '../engine/visualAudit';
import { resolveIntents } from './resolver';
import { suggestIntentsForPage, type ExpectedProductSummary } from './claudeSuggest';
import type { Plan, Operation } from '../types';
import type { PageAllocation } from '../engine/allocator';
import type { PageSchema } from './schema';
import type { IntentOp } from './intent';

export interface IntentLoopOptions {
  outPdfPath: string;
  plan: Plan;
  /** Schemas indexes par sourcePage (pas par finalNum — un meme template
   *  page peut etre substitue plusieurs fois mais on prend le 1er). */
  schemas: Map<number, PageSchema>;
  /** Allocations produits indexees par sourcePage. Sert a passer la liste
   *  des produits ATTENDUS dans le prompt Claude pour qu'il ne confonde
   *  pas substitution vs erreur. */
  allocations?: Map<number, PageAllocation>;
  workDir: string;
  projectDir: string;
  /** Callback qui re-render le PDF apres mutation du plan. L'orchestrator
   *  passe la fermeture vers runBinary(render) — on evite ainsi de dupliquer
   *  la connaissance des paths (binary, template, templates, assets). */
  rerender: (planPath: string) => Promise<{ ok: boolean; stderr: string }>;
  claudeBin?: string;
  /** Nombre max de pages produit rasterisees + envoyees a Claude par passe.
   *  Defaut 5 (plafond cout/latence). */
  samplePages?: number;
  /** Nombre max de passes Claude → resolve → re-render. Defaut 2. */
  maxIterations?: number;
}

export interface IntentLoopResult {
  ran: boolean;
  iterations: number;
  /** Total IntentOps recues de Claude (toutes passes confondues). */
  totalIntents: number;
  /** Total Operations bas niveau injectees dans le plan. */
  totalOps: number;
  /** Total IntentOps non resolues (target invalide, etc.). */
  totalUnresolved: number;
  durationMs: number;
  costUsd: number;
  notes: string[];
}

const DEFAULT_SAMPLE = 5;
const DEFAULT_MAX_ITER = 2;
/** Budget max Claude en USD. Au-dela, la boucle s'arrete. */
const MAX_COST_USD = 1.0;

export async function runIntentLoop(opts: IntentLoopOptions): Promise<IntentLoopResult> {
  const t0 = Date.now();
  const samplePages = opts.samplePages ?? DEFAULT_SAMPLE;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITER;
  const notes: string[] = [];
  let totalIntents = 0;
  let totalOps = 0;
  let totalUnresolved = 0;
  let costUsd = 0;

  // Indices des pages substituees (mode operations) avec un schema dispo.
  const candidates: { finalIdx: number; finalNum: number; sourcePage: number; schema: PageSchema }[] = [];
  for (let i = 0; i < opts.plan.pages.length; i++) {
    const p = opts.plan.pages[i];
    if (p.render.mode !== 'operations') continue;
    const schema = opts.schemas.get(p.source_page);
    if (!schema) continue;
    candidates.push({ finalIdx: i, finalNum: i + 1, sourcePage: p.source_page, schema });
  }
  if (candidates.length === 0) {
    return {
      ran: false, iterations: 0, totalIntents: 0, totalOps: 0, totalUnresolved: 0,
      durationMs: Date.now() - t0, costUsd: 0,
      notes: ['aucune page substituee avec schema dispo'],
    };
  }

  const sampled = pickSample(candidates, samplePages);
  notes.push(`intent loop : ${sampled.length} pages echantillonnees sur ${candidates.length} substituees`);

  const auditDir = path.join(opts.workDir, 'intent-loop-images');
  await fs.mkdir(auditDir, { recursive: true });
  const planPath = path.join(opts.workDir, 'plan.json');

  // Pour detecter la stagnation : on hash les intents de l'iter precedente.
  // Si l'iter courante propose exactement le meme set d'intents, c'est que
  // les corrections appliquees n'ont rien debloque (Claude voit le meme defaut
  // et propose le meme fix qui ne marche pas) — on stop.
  let prevIntentsHash: string | null = null;
  let iterations = 0;
  for (let iter = 0; iter < maxIterations; iter++) {
    // Budget cap : stop si on a deja depense trop
    if (costUsd >= MAX_COST_USD) {
      notes.push(`budget cap $${MAX_COST_USD} atteint ($${costUsd.toFixed(2)}) — boucle stop`);
      break;
    }
    iterations = iter + 1;
    const iterDir = path.join(auditDir, `iter-${iterations}`);
    await fs.mkdir(iterDir, { recursive: true });

    // Rasterise les pages echantillonees du PDF courant.
    const rendered: { sample: typeof sampled[number]; pngPath: string }[] = [];
    for (const s of sampled) {
      const png = await renderPagePng(opts.outPdfPath, s.finalNum, iterDir);
      if (png) rendered.push({ sample: s, pngPath: png });
    }
    if (rendered.length === 0) {
      notes.push(`iter ${iterations} : pdftoppm a echoue sur toutes les pages — boucle stop`);
      break;
    }

    // Appel Claude vision en parallele sur chaque page.
    const suggestions = await Promise.all(
      rendered.map((r) => {
        const alloc = opts.allocations?.get(r.sample.sourcePage);
        const expectedProducts: ExpectedProductSummary[] = (alloc?.products ?? []).map((p) => ({
          name: p.name,
          ref: p.ref,
          specCount: p.specs.length,
          hasImage: Boolean(p.image_path),
        }));
        return suggestIntentsForPage({
          schema: r.sample.schema,
          pngPath: r.pngPath,
          workDir: iterDir,
          projectDir: opts.projectDir,
          claudeBin: opts.claudeBin,
          expectedProducts,
        }).then((sg) => ({ r, sg }));
      }),
    );

    let iterIntents = 0;
    let iterOps = 0;
    let iterUnresolved = 0;
    const allIntents: IntentOp[] = [];

    for (const { r, sg } of suggestions) {
      if (sg.costUsd) costUsd += sg.costUsd;
      for (const n of sg.notes) notes.push(`p${r.sample.finalNum}: ${n}`);
      if (sg.intents.length === 0) continue;
      iterIntents += sg.intents.length;
      allIntents.push(...(sg.intents as IntentOp[]));

      const { operations, unresolved } = resolveIntents(sg.intents as IntentOp[], r.sample.schema);
      iterOps += operations.length;
      iterUnresolved += unresolved.length;
      for (const u of unresolved) {
        notes.push(`p${r.sample.finalNum} unresolved: ${u.reason}`);
      }
      if (operations.length > 0) {
        appendOperations(opts.plan, r.sample.finalIdx, operations);
      }
    }

    totalIntents += iterIntents;
    totalOps += iterOps;
    totalUnresolved += iterUnresolved;

    if (iterIntents === 0) {
      notes.push(`iter ${iterations} : aucun intent — boucle stop`);
      break;
    }
    if (iterOps === 0) {
      notes.push(`iter ${iterations} : ${iterIntents} intents recus, 0 resolus — boucle stop`);
      break;
    }
    // Stagnation : meme set d'intents qu'a l'iter precedente → on stoppe
    // pour eviter de payer Claude sur un fix qui ne debloque pas le defaut
    // (typiquement : replace_text sur une bbox trop etroite, le texte reste
    // tronque, Claude re-propose le meme intent).
    const curHash = hashIntents(allIntents);
    if (prevIntentsHash !== null && curHash === prevIntentsHash) {
      notes.push(`iter ${iterations} : meme set d'intents qu'iter ${iterations - 1} — stagnation, boucle stop`);
      break;
    }
    prevIntentsHash = curHash;

    // Reecrit plan.json et re-render via callback orchestrator.
    await fs.writeFile(planPath, JSON.stringify(opts.plan, null, 2), 'utf8');
    const rr = await opts.rerender(planPath);
    if (!rr.ok) {
      notes.push(`iter ${iterations} : re-render KO — boucle stop (${rr.stderr.slice(0, 200)})`);
      break;
    }
    notes.push(`iter ${iterations} : ${iterIntents} intents → ${iterOps} ops appliquees, PDF re-rendu`);
  }

  return {
    ran: true,
    iterations,
    totalIntents,
    totalOps,
    totalUnresolved,
    durationMs: Date.now() - t0,
    costUsd,
    notes,
  };
}

function appendOperations(plan: Plan, finalIdx: number, ops: Operation[]): void {
  const page = plan.pages[finalIdx];
  if (page.render.mode !== 'operations') return;
  page.render.operations.push(...ops);
}

/** Hash deterministe d'un set d'intents pour detecter une iter identique
 *  a la precedente. JSON.stringify trie pas → on serialise apres tri par
 *  signature stable (op|target|content). */
function hashIntents(intents: IntentOp[]): string {
  const sigs = intents.map((i) => {
    const base = `${i.op}|${i.target}`;
    if (i.op === 'replace_text') return `${base}|${i.text}`;
    if (i.op === 'swap_image') return `${base}|${i.image_path}|${i.fit ?? ''}`;
    if (i.op === 'update_spec') return `${base}|${i.key ?? ''}|${i.value}`;
    if (i.op === 'set_color') return `${base}|${i.color}`;
    return base; // remove_element
  });
  sigs.sort();
  return sigs.join('\n');
}

function pickSample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice();
  const out: T[] = [];
  const step = (arr.length - 1) / (n - 1);
  const taken = new Set<number>();
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * step);
    if (!taken.has(idx)) {
      taken.add(idx);
      out.push(arr[idx]);
    }
  }
  return out;
}

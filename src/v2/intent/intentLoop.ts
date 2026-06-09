/**
 * Iterative loop Claude → IntentOps → re-render.
 *
 * After the 1st C++ render, we rasterize a sample of substituted product
 * pages, ask Claude vision for corrective IntentOps, resolve them into
 * low-level Operations, and inject them into plan.json for another pass of
 * the C++ binary.
 *
 * Iteration: we stop as soon as a pass produces no more intents, or after
 * `maxIterations` passes (default 2).
 *
 * The C++ binary stays put: we only add Operations to
 * `pages[i].render.operations` and rewrite plan.json.
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
  /** Schemas indexed by sourcePage (not by finalNum — the same template
   *  page may be substituted several times but we take the 1st). */
  schemas: Map<number, PageSchema>;
  /** Product allocations indexed by sourcePage. Used to pass the list of
   *  EXPECTED products into the Claude prompt so it doesn't confuse
   *  substitution with an error. */
  allocations?: Map<number, PageAllocation>;
  workDir: string;
  projectDir: string;
  /** Callback that re-renders the PDF after mutating the plan. The
   *  orchestrator passes the closure over runBinary(render) — this avoids
   *  duplicating knowledge of the paths (binary, template, templates, assets). */
  rerender: (planPath: string) => Promise<{ ok: boolean; stderr: string }>;
  claudeBin?: string;
  /** Max number of product pages rasterized + sent to Claude per pass.
   *  Default 5 (cost/latency cap). */
  samplePages?: number;
  /** Max number of Claude → resolve → re-render passes. Default 2. */
  maxIterations?: number;
}

export interface IntentLoopResult {
  ran: boolean;
  iterations: number;
  /** Total IntentOps received from Claude (across all passes). */
  totalIntents: number;
  /** Total low-level Operations injected into the plan. */
  totalOps: number;
  /** Total unresolved IntentOps (invalid target, etc.). */
  totalUnresolved: number;
  durationMs: number;
  costUsd: number;
  notes: string[];
}

const DEFAULT_SAMPLE = 5;
const DEFAULT_MAX_ITER = 2;
/** Max Claude budget in USD. Beyond it, the loop stops. */
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

  // Indices of the substituted pages (operations mode) with a schema available.
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

  // To detect stagnation: we hash the intents of the previous iteration.
  // If the current iteration proposes exactly the same set of intents, it
  // means the applied corrections unblocked nothing (Claude sees the same
  // defect and proposes the same fix that doesn't work) — we stop.
  let prevIntentsHash: string | null = null;
  let iterations = 0;
  for (let iter = 0; iter < maxIterations; iter++) {
    // Budget cap: stop if we've already spent too much
    if (costUsd >= MAX_COST_USD) {
      notes.push(`budget cap $${MAX_COST_USD} atteint ($${costUsd.toFixed(2)}) — boucle stop`);
      break;
    }
    iterations = iter + 1;
    const iterDir = path.join(auditDir, `iter-${iterations}`);
    await fs.mkdir(iterDir, { recursive: true });

    // Rasterize the sampled pages of the current PDF.
    const rendered: { sample: typeof sampled[number]; pngPath: string }[] = [];
    for (const s of sampled) {
      const png = await renderPagePng(opts.outPdfPath, s.finalNum, iterDir);
      if (png) rendered.push({ sample: s, pngPath: png });
    }
    if (rendered.length === 0) {
      notes.push(`iter ${iterations} : pdftoppm a echoue sur toutes les pages — boucle stop`);
      break;
    }

    // Claude vision call in parallel on each page.
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
    // Stagnation: same set of intents as the previous iteration → we stop
    // to avoid paying Claude for a fix that doesn't unblock the defect
    // (typically: replace_text on a bbox that's too narrow, the text stays
    // truncated, Claude re-proposes the same intent).
    const curHash = hashIntents(allIntents);
    if (prevIntentsHash !== null && curHash === prevIntentsHash) {
      notes.push(`iter ${iterations} : meme set d'intents qu'iter ${iterations - 1} — stagnation, boucle stop`);
      break;
    }
    prevIntentsHash = curHash;

    // Rewrite plan.json and re-render via the orchestrator callback.
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

/** Deterministic hash of a set of intents to detect an iteration identical
 *  to the previous one. JSON.stringify doesn't sort → we serialize after
 *  sorting by a stable signature (op|target|content). */
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

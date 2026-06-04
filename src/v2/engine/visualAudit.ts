/**
 * Audit visuel final par Claude (vision).
 *
 * Apres le render C++, on echantillonne N pages substituees, on les rastere
 * en PNG via pdftoppm, et on envoie le tout a Claude CLI avec contexte des
 * produits attendus. Claude utilise Read sur chaque PNG (Read est multimodal)
 * et liste les anomalies dans `visual-audit.json`.
 *
 * Objectif : detecter les regressions silencieuses (texte qui deborde, image
 * coupee, chevauchement de glyphes, mauvais produit) que la verification
 * textuelle ne peut pas attraper.
 *
 * Cout : ~1 appel Claude (~30s, ~$0.04 pour 6 pages a 100 DPI). On factorise
 * tous les samples dans UN seul prompt pour minimiser la latence vs N appels.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { runBinary } from '../binaryRunner';
import { callClaudeCli } from '../claudeCli';
import { CLAUDE_CLI_TIMEOUT_MS } from '../timeouts';
import type { Plan } from '../types';
import type { PageAllocation } from './allocator';

const PDFTOPPM_TIMEOUT_MS = 30_000;
// 72 DPI = densite cible (1pt = 1px), suffisant pour audit de glyphes /
// chevauchements / images mal cadrees. 100 DPI = +40% tokens vision pour
// gain visuel marginal sur ce use case.
const VISUAL_AUDIT_DPI = 72;
// 3 pages echantillonees (debut/milieu/fin) suffisent pour detecter les
// regressions visuelles. 6 etait du gachis : cout proportionnel pour gain
// marginal sur les cas normaux.
const DEFAULT_SAMPLE_SIZE = 3;

export type VisualAuditSeverity = 'critical' | 'minor';

export interface VisualAuditIssue {
  finalPageNumber: number;
  sourcePage: number;
  severity: VisualAuditSeverity;
  category: 'overflow' | 'mismatch' | 'cropped' | 'missing_image' | 'overlap' | 'other';
  description: string;
  productName?: string;
}

export interface VisualAuditResult {
  /** True si l'audit a vraiment tourne (pdftoppm dispo, render OK, Claude OK). */
  ran: boolean;
  issues: VisualAuditIssue[];
  sampledPages: number[];
  durationMs: number;
  costUsd?: number;
  notes: string[];
}

export interface VisualAuditOptions {
  outPdfPath: string;
  plan: Plan;
  allocations: PageAllocation[];
  workDir: string;
  projectDir: string;
  claudeBin?: string;
  /** Nombre de pages a echantillonner. 'all' pour toutes. Default 6. */
  sampleSize?: number | 'all';
  /** Active l'audit. Default true. */
  enabled?: boolean;
}

export async function visualAudit(
  opts: VisualAuditOptions,
): Promise<VisualAuditResult> {
  const t0 = Date.now();
  if (opts.enabled === false) {
    return { ran: false, issues: [], sampledPages: [], durationMs: 0, notes: ['disabled by caller'] };
  }
  const finalPages: { finalNum: number; sourcePage: number }[] = [];
  for (let i = 0; i < opts.plan.pages.length; i++) {
    const p = opts.plan.pages[i];
    if (p.render.mode === 'operations') {
      finalPages.push({ finalNum: i + 1, sourcePage: p.source_page });
    }
  }
  if (finalPages.length === 0) {
    return { ran: false, issues: [], sampledPages: [], durationMs: Date.now() - t0, notes: ['aucune page substituee'] };
  }

  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const sampled = sampleSize === 'all' ? finalPages : pickSample(finalPages, sampleSize);

  const auditDir = path.join(opts.workDir, 'audit-images');
  await fs.mkdir(auditDir, { recursive: true });
  const rendered: { finalNum: number; sourcePage: number; pngPath: string }[] = [];
  for (const p of sampled) {
    const png = await renderPagePng(opts.outPdfPath, p.finalNum, auditDir);
    if (png) rendered.push({ ...p, pngPath: png });
  }
  if (rendered.length === 0) {
    return {
      ran: false,
      issues: [],
      sampledPages: [],
      durationMs: Date.now() - t0,
      notes: ['pdftoppm indisponible ou rasterisation echouee — audit skip'],
    };
  }

  const allocByPage = new Map(opts.allocations.map((a) => [a.sourcePage, a]));
  const contexts: ClaudeContext[] = rendered.map((r) => ({
    finalPageNumber: r.finalNum,
    sourcePage: r.sourcePage,
    pngPath: r.pngPath,
    expectedProducts: (allocByPage.get(r.sourcePage)?.products ?? []).map((p) => ({
      name: p.name,
      ref: p.ref,
      specCount: p.specs.length,
      hasImage: Boolean(p.image_path),
    })),
  }));

  const auditPath = path.join(opts.workDir, 'visual-audit.json');
  await fs.writeFile(auditPath, JSON.stringify({ issues: [], notes: [] }, null, 2), 'utf8');

  const prompt = buildPrompt(contexts, auditPath);
  const res = await callClaudeCli({
    prompt,
    workDir: auditDir,
    projectDir: opts.projectDir,
    claudeBin: opts.claudeBin,
    timeoutMs: CLAUDE_CLI_TIMEOUT_MS,
    allowedTools: 'Read,Edit',
  });

  const notes: string[] = [];
  let issues: VisualAuditIssue[] = [];
  if (!res.ok) {
    notes.push('claude visual audit failed: ' + (res.result?.slice(0, 200) ?? 'unknown'));
  } else {
    try {
      const raw = await fs.readFile(auditPath, 'utf8');
      const parsed = JSON.parse(raw) as { issues?: unknown; notes?: unknown };
      issues = Array.isArray(parsed.issues) ? parsed.issues.filter(isValidIssue) : [];
      if (Array.isArray(parsed.notes)) {
        for (const n of parsed.notes) {
          if (typeof n === 'string') notes.push(n);
        }
      }
    } catch (e) {
      notes.push('parse visual-audit failed: ' + (e as Error).message);
    }
  }
  return {
    ran: res.ok,
    issues,
    sampledPages: sampled.map((s) => s.finalNum),
    durationMs: Date.now() - t0,
    costUsd: res.costUsd,
    notes,
  };
}

function pickSample<T extends { finalNum: number }>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const result: T[] = [];
  const step = (arr.length - 1) / (n - 1);
  const taken = new Set<number>();
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * step);
    if (!taken.has(idx)) {
      taken.add(idx);
      result.push(arr[idx]);
    }
  }
  return result;
}

export async function renderPagePng(
  pdfPath: string,
  pageNum: number,
  outDir: string,
): Promise<string | null> {
  const outBase = path.join(outDir, `page-${String(pageNum).padStart(3, '0')}`);
  const res = await runBinary({
    bin: 'pdftoppm',
    args: [
      '-r', String(VISUAL_AUDIT_DPI),
      '-f', String(pageNum),
      '-l', String(pageNum),
      '-png',
      pdfPath,
      outBase,
    ],
    timeoutMs: PDFTOPPM_TIMEOUT_MS,
  });
  if (!res.ok) return null;
  // pdftoppm ecrit <outBase>-<N>.png ou <outBase>-<NN>.png selon padding interne
  const entries = await fs.readdir(outDir).catch(() => []);
  const baseName = path.basename(outBase);
  const match = entries.find((e) => e.startsWith(`${baseName}-`) && e.endsWith('.png'));
  return match ? path.join(outDir, match) : null;
}

interface ExpectedProductSummary {
  name: string;
  ref: string | null;
  specCount: number;
  hasImage: boolean;
}

interface ClaudeContext {
  finalPageNumber: number;
  sourcePage: number;
  pngPath: string;
  expectedProducts: ExpectedProductSummary[];
}

function buildPrompt(contexts: ClaudeContext[], auditPath: string): string {
  const pageList = contexts
    .map((c) => {
      const products = c.expectedProducts.length === 0
        ? 'AUCUN (page vide attendue)'
        : c.expectedProducts
            .map(
              (p) =>
                `${p.name}${p.ref ? ` (ref ${p.ref})` : ''} [${p.specCount} specs${p.hasImage ? ', img' : ', no img'}]`,
            )
            .join(' | ');
      return `- page finale ${c.finalPageNumber} (template src ${c.sourcePage})\n  image : ${c.pngPath}\n  produits attendus : ${products}`;
    })
    .join('\n');
  return `Tu es l'auditeur visuel d'un catalogue PDF qui vient d'etre genere par substitution sur un template.

Pour CHAQUE page ci-dessous :
1. Utilise Read sur le chemin PNG (l'image te sera presentee visuellement).
2. Compare ce que tu VOIS avec les produits ATTENDUS listes.
3. Note uniquement les problemes visuels REELS et bloquants.

PAGES A AUDITER :
${pageList}

SEVERITES :
- critical : texte coupe / chevauchement de glyphes / image manquante ou cadrage grossierement faux / mauvais produit affiche / numero de page absent ou en double / cartouche section vide
- minor : alignement legerement off / espacement irregulier / typo discrete mais lisible

NE PAS remonter :
- preferences esthetiques sans bug concret
- specs presentes mais dans un ordre different
- texte legerement plus court / plus long que le template (c'est attendu)
- variations de couleur typographique si globalement coherentes

Si la page est SAINE : pas d'entree dans issues.

REPONDS UNIQUEMENT en editant ${auditPath} avec ce schema EXACT :
{
  "issues": [
    {
      "finalPageNumber": <N>,
      "sourcePage": <S>,
      "severity": "critical" | "minor",
      "category": "overflow" | "mismatch" | "cropped" | "missing_image" | "overlap" | "other",
      "description": "<une phrase precise sur ce que tu vois>",
      "productName": "<nom si applicable, sinon omet>"
    }
  ],
  "notes": [
    "<ex: 'rendu globalement propre sur les 6 pages auditees'>"
  ]
}

Ne reponds RIEN d'autre que cet edit. Si tout est OK, edit avec issues=[] et au moins 1 note descriptive.`;
}

function isValidIssue(x: unknown): x is VisualAuditIssue {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.finalPageNumber === 'number'
    && typeof o.sourcePage === 'number'
    && (o.severity === 'critical' || o.severity === 'minor')
    && typeof o.description === 'string'
  );
}

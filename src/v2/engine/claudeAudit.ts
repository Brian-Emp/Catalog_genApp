/**
 * Phase 1.2 : Claude audit le pipeline.
 *
 * Claude est chef d'orchestre : il valide la classification, peut suggerer
 * des corrections de kind, demander de DROP des pages additionnelles, et
 * laisser des notes. Acces complet : Read (peut consulter n'importe quelle
 * page-NN.json), Edit + Write (peut modifier audit-decisions.json).
 *
 * Strategie : on lui passe un resume compact (kind, sample texte, contexte
 * section) + les allocations. Il sort un JSON de corrections que le caller
 * applique avant la suppression finale.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { callClaudeCli } from '../claudeCli';
import { CLAUDE_CLI_TIMEOUT_MS } from '../timeouts';
import type { AllocationResult } from './allocator';
import type { PageClassification, PageKind } from './classify';
import type { ProductsAnalysis } from './inputs';

export interface AuditCorrection {
  pageNumber: number;
  /** Si fourni : change le kind. Sinon : juste un commentaire. */
  newKind?: PageKind;
  /** Si true : force le drop de cette page meme si kind=identity. */
  shouldDrop?: boolean;
  reason?: string;
}

export interface AuditResult {
  corrections: AuditCorrection[];
  /** Notes generales de Claude sur la generation. */
  notes: string[];
  /** Cost USD si retourne par la CLI. */
  costUsd?: number;
  durationMs: number;
}

export interface ClaudeAuditOptions {
  classifications: PageClassification[];
  analysis: ProductsAnalysis;
  allocation: AllocationResult;
  templatesDir: string;
  workDir: string;
  projectDir: string;
  claudeBin?: string;
  timeoutMs?: number;
}

export async function claudeAudit(
  opts: ClaudeAuditOptions,
): Promise<AuditResult> {
  const t0 = Date.now();
  const summary = buildClassificationSummary(opts.classifications);
  const sectionInfo = Array.from(opts.analysis.bySection.entries())
    .filter(([, list]) => list.length > 0)
    .map(([key, products]) => ({
      section: opts.analysis.sectionLabels.get(key) ?? key,
      products: products.length,
      sample_names: products.slice(0, 3).map((p) => p.name),
    }));
  const allocSummary = opts.allocation.allocations.map((a) => ({
    source_page: a.sourcePage,
    section: a.sectionLabel,
    products_placed: a.products.length,
    blocks_on_page: a.blockCount,
  }));

  const auditPath = path.join(opts.workDir, 'audit-decisions.json');
  await fs.writeFile(
    auditPath,
    JSON.stringify({ corrections: [], notes: [] }, null, 2),
    'utf8',
  );

  const prompt = buildAuditPrompt({
    summary,
    sectionInfo,
    allocSummary,
    auditPath,
    templatesDir: opts.templatesDir,
    unmatchedCount: opts.allocation.unmatched.length,
  });

  const res = await callClaudeCli({
    prompt,
    workDir: opts.workDir,
    projectDir: opts.projectDir,
    claudeBin: opts.claudeBin,
    timeoutMs: opts.timeoutMs ?? CLAUDE_CLI_TIMEOUT_MS,
    allowedTools: 'Read,Edit,Write,Glob,Grep',
  });

  const durationMs = Date.now() - t0;
  if (!res.ok) {
    return {
      corrections: [],
      notes: ['claude audit failed: ' + (res.result?.slice(0, 200) ?? 'unknown')],
      durationMs,
    };
  }

  try {
    const raw = await fs.readFile(auditPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AuditResult>;
    return {
      corrections: Array.isArray(parsed.corrections) ? parsed.corrections : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      costUsd: res.costUsd,
      durationMs,
    };
  } catch (e) {
    return {
      corrections: [],
      notes: ['parse audit failed: ' + (e as Error).message],
      durationMs,
    };
  }
}

// ─── Application des corrections ─────────────────────────────────────────────

/**
 * Applique les corrections Claude sur les classifications + l'allocation.
 * Retourne un nouvel objet de classifications. Les corrections shouldDrop
 * sont prises en compte par le caller dans la phase de drop finale.
 */
export function applyAuditCorrections(
  classifications: PageClassification[],
  audit: AuditResult,
): { updated: PageClassification[]; forcedDrops: Set<number> } {
  const correctionsByPage = new Map<number, AuditCorrection>();
  for (const c of audit.corrections) correctionsByPage.set(c.pageNumber, c);
  const forcedDrops = new Set<number>();
  const updated = classifications.map((cls) => {
    const corr = correctionsByPage.get(cls.pageNumber);
    if (!corr) return cls;
    if (corr.shouldDrop) forcedDrops.add(cls.pageNumber);
    if (corr.newKind) {
      return { ...cls, kind: corr.newKind, confidence: 1.0 };
    }
    return cls;
  });
  return { updated, forcedDrops };
}

// ─── Prompt builder ─────────────────────────────────────────────────────────

interface PromptInputs {
  summary: ClassificationSummaryRow[];
  sectionInfo: { section: string; products: number; sample_names: string[] }[];
  allocSummary: {
    source_page: number;
    section: string;
    products_placed: number;
    blocks_on_page: number;
  }[];
  auditPath: string;
  templatesDir: string;
  unmatchedCount: number;
}

function buildAuditPrompt(p: PromptInputs): string {
  return `Tu es l'auditeur du pipeline de generation de catalogue produit. Tu as PLEINS POUVOIRS :
- Read sur les page-NN.json (dir : ${p.templatesDir}) pour analyser une page douteuse
- Edit/Write sur ${p.auditPath} pour donner tes decisions
- Glob/Grep pour explorer

OBJECTIF GENERAL : produire un catalogue ou TOUTES les pages sont legitimes :
- pages d'identite de marque (cover, histoire, NF, RSE, mentions, photos d'ambiance, 4eme de couverture) → GARDER
- pages produit substituees avec les nouveaux produits → GARDER
- TOUT le reste (sommaires, glossaires, fiches produit non utilisees, pages tech non rattachees) → DROP

CLASSIFICATIONS POSSIBLES par page :
- product : page avec fiches produit du template
- toc : sommaire general / sommaire de section / synoptique
- glossaire : pictogrammes / index couleur / index alpha
- intercalaire : page intro de section (gros titre, pas de fiche)
- identity : identite marque, intro/outro neutres, mentions legales

CLASSIFICATIONS ACTUELLES (extrait jusqu'a 200 pages) :
${JSON.stringify(p.summary.slice(0, 200), null, 1)}

PRODUITS NOUVEAUX A PLACER (par section) :
${JSON.stringify(p.sectionInfo, null, 2)}

ALLOCATION PRODUITS → PAGES TEMPLATE :
${JSON.stringify(p.allocSummary, null, 2)}

Produits non places (manque de pages adaptees) : ${p.unmatchedCount}

TA MISSION :
1. Pour chaque page ou tu n'es pas d'accord avec la classification, AJOUTE une correction.
2. Si une page d'identite "identity" parle en fait de PRODUITS specifiques du template d'origine (ex page lifestyle "salle de bains" avec robinets visibles, page "decouvrez nos collections", page "garantie 10 ans sur ces robinets"), force shouldDrop=true OU change kind a 'intercalaire' / 'toc'.
3. Si tu remarques que des pages classees "identity" pourraient etre des pages techniques/synoptiques qui ont echappe a la classification automatique, force shouldDrop.
4. Si tu vois une incoherence dans l'allocation (ex une page allouee a une section qui ne correspond pas du tout), ajoute un commentaire dans notes.
5. Si une page est ambigue, RELIS-LA via Read (les fichiers sont ${p.templatesDir}/page-NNN.json).

REPONDS en editant ${p.auditPath} avec ce schema EXACT :
{
  "corrections": [
    { "pageNumber": <N>, "newKind": "toc", "reason": "page sommaire de section non detectee" },
    { "pageNumber": <M>, "shouldDrop": true, "reason": "page lifestyle avec robinetterie visible" }
  ],
  "notes": [
    "Allocation OK pour BARRES DOUCHES mais aucune page n'a 3 blocs verticaux purs",
    "..."
  ]
}

Ne reponds RIEN d'autre que cet edit. Si tout est OK, edit avec corrections=[] et au moins 1 note "OK".`;
}

interface ClassificationSummaryRow {
  page: number;
  kind: PageKind;
  confidence: number;
  section: string | null;
  blocks: number;
  has_banner: boolean;
  sample: string;
}

function buildClassificationSummary(
  classifications: PageClassification[],
): ClassificationSummaryRow[] {
  return classifications.map((c) => ({
    page: c.pageNumber,
    kind: c.kind,
    confidence: Math.round(c.confidence * 100) / 100,
    section: c.activeSection || null,
    blocks: c.blocks.length,
    has_banner: !!c.sectionLabel,
    sample: extractSampleText(c.extracted.raw_spans ?? []),
  }));
}

function extractSampleText(spans: { text: string }[]): string {
  const collected: string[] = [];
  for (const s of spans) {
    const t = s.text.trim();
    if (t.length === 0) continue;
    collected.push(t);
    if (collected.join(' | ').length > 150) break;
  }
  return collected.join(' | ').slice(0, 200);
}

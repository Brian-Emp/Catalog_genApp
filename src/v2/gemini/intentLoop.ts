/**
 * Gemini intent loop: audit loop + correction proposals.
 *
 * Phase 1 (this module): for each detected visual bug, ask Gemini Vision for
 * a textual intent PROPOSAL ("shift the title 4pt to the left", "increase the
 * product name size from 11 to 13pt", etc.).
 *
 * Phase 2 (TODO): interpret these intents into concrete ops (erase+insert
 * with adjusted parameters) and re-run the render. Loop until convergence
 * (zero critical issues or max_iterations reached).
 *
 * Today: we just return the textual intents for visualization in the UI
 * warnings. Application stays manual (the dev edits the code/prompt based on
 * the suggestions).
 */

import { promises as fs } from 'fs';
import { analyzeImage, GEMINI_MODELS, isGeminiAvailable } from './client';
import { parseGeminiJson } from './jsonParse';
import { renderPagePng } from '../engine/visualAudit';
import type { Plan } from '../types';
import type { VisualAuditIssue } from '../engine/visualAudit';

export interface IntentLoopOptions {
  outPdfPath: string;
  plan: Plan;
  /** Bugs detected by visualAudit (page-by-page). We propose corrections
   *  for the critical ones only. */
  issues: VisualAuditIssue[];
  workDir: string;
  enabled?: boolean;
  model?: string;
}

export interface IntentSuggestion {
  /** Page concerned. */
  finalPageNumber: number;
  /** Original issue (reminder). */
  issueDescription: string;
  /** Textual intent proposed by Gemini (description of the action). */
  intent: string;
  /** Confidence (subjective, 0-1). */
  confidence: number;
}

export interface IntentLoopResult {
  ran: boolean;
  suggestions: IntentSuggestion[];
  durationMs: number;
  notes: string[];
}

export async function geminiIntentLoop(
  opts: IntentLoopOptions,
): Promise<IntentLoopResult> {
  const t0 = Date.now();
  const notes: string[] = [];

  if (opts.enabled === false) {
    return { ran: false, suggestions: [], durationMs: 0, notes: ['disabled'] };
  }
  if (!(await isGeminiAvailable())) {
    return { ran: false, suggestions: [], durationMs: Date.now() - t0, notes: ['GEMINI_KEY absente'] };
  }

  // We only propose corrections for the CRITICAL ones (the minor ones aren't
  // worth the extra Gemini quota).
  const critical = opts.issues.filter((i) => i.severity === 'critical');
  if (critical.length === 0) {
    return { ran: false, suggestions: [], durationMs: Date.now() - t0, notes: ['aucun bug critique a corriger'] };
  }

  // Group issues per page (1 Gemini call per page with its issues)
  const byPage = new Map<number, VisualAuditIssue[]>();
  for (const issue of critical) {
    const arr = byPage.get(issue.finalPageNumber) ?? [];
    arr.push(issue);
    byPage.set(issue.finalPageNumber, arr);
  }

  const suggestions: IntentSuggestion[] = [];
  for (const [pageNum, pageIssues] of byPage) {
    const png = await renderPagePng(opts.outPdfPath, pageNum, opts.workDir);
    if (!png) {
      notes.push(`p.${pageNum} : rasterisation echec`);
      continue;
    }
    let imageBytes: Buffer;
    try {
      imageBytes = await fs.readFile(png);
    } catch {
      notes.push(`p.${pageNum} : lecture png echec`);
      continue;
    }
    const prompt = buildIntentPrompt(pageNum, pageIssues);
    const res = await analyzeImage({
      prompt,
      imageBytes,
      mimeType: 'image/png',
      model: opts.model ?? GEMINI_MODELS.flash,
      fallbackModel: GEMINI_MODELS.flashLite,
      module: 'intentLoop',
      // Auxiliary intent loop: fail-fast on quota (cf. visualAudit).
      maxRetryDelayMs: 8000,
    });
    if (!res.ok || !res.text) {
      notes.push(`p.${pageNum} : gemini error : ${res.error}`);
      continue;
    }
    if (res.usedFallback) {
      notes.push(`p.${pageNum} : fallback flash-lite (quota flash epuise)`);
    }
    const parsed = parseIntentsJson(res.text);
    if (!parsed) {
      notes.push(`p.${pageNum} : reponse non-JSON parseable`);
      continue;
    }
    for (const s of parsed) {
      if (!s.intent) continue;
      const origIssue = pageIssues.find((i) => i.description.includes(s.issueRef ?? '')) ?? pageIssues[0];
      suggestions.push({
        finalPageNumber: pageNum,
        issueDescription: origIssue.description,
        intent: s.intent,
        confidence: typeof s.confidence === 'number' ? Math.max(0, Math.min(1, s.confidence)) : 0.5,
      });
    }
  }

  return {
    ran: true,
    suggestions,
    durationMs: Date.now() - t0,
    notes,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildIntentPrompt(pageNum: number, issues: VisualAuditIssue[]): string {
  const issueList = issues
    .map((i, idx) => `${idx}. [${i.category}] ${i.description}`)
    .join('\n');
  return `Tu es un correcteur de catalogue PDF. Tu vois l'image d'une page generee + une liste de bugs visuels deja detectes.

PAGE : ${pageNum}
BUGS CRITIQUES :
${issueList}

TACHE : pour CHAQUE bug, propose UNE action correctrice CONCRETE et MINIMALE.
Format de l'intent : phrase imperative qui decrit l'action (taille / position / contenu).

EXEMPLES BON :
- "Décaler le nom produit de 4pt vers la droite pour eviter le chevauchement avec l'image."
- "Augmenter le erase_rect autour de la ref a 8pt de gap pour effacer les residus."
- "Remplacer la couleur blanche du nom produit par noir (font invisible sur fond blanc)."

EXEMPLES MAUVAIS :
- "Corriger le bug." (trop vague)
- "Refaire la page." (pas minimal)

REPONDS UNIQUEMENT en JSON pur (pas de markdown) :
{
  "suggestions": [
    {
      "issueRef": "<extrait de la description du bug>",
      "intent": "<phrase imperative>",
      "confidence": 0.0 a 1.0
    }
  ]
}

Si tu ne sais pas corriger un bug, omets-le.`;
}

interface ParsedIntent {
  issueRef?: string;
  intent?: string;
  confidence?: number;
}

function parseIntentsJson(text: string): ParsedIntent[] | null {
  const parsed = parseGeminiJson<{ suggestions?: unknown }>(text);
  if (!parsed || !Array.isArray(parsed.suggestions)) return null;
  const out: ParsedIntent[] = [];
  for (const s of parsed.suggestions) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    out.push({
      issueRef: typeof o.issueRef === 'string' ? o.issueRef : undefined,
      intent: typeof o.intent === 'string' ? o.intent : undefined,
      confidence: typeof o.confidence === 'number' ? o.confidence : undefined,
    });
  }
  return out;
}

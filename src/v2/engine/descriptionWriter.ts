/**
 * Description marketing par section : Claude genere 1-2 phrases courtes
 * presentant chaque section produit. Inseree dans la zone description du
 * sommaire (a la place du texte template effaces).
 *
 * Output : map section → phrase. Le caller decide ou inserer (sur sommaire,
 * sous banner produit, etc.).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { callClaudeCli } from '../claudeCli';
import { CLAUDE_CLI_TIMEOUT_MS } from '../timeouts';
import type { PlanProduct } from '../types';

export interface DescriptionWriterOptions {
  /** Sections a documenter : 1 entry par section, avec ses produits. */
  sections: { label: string; products: PlanProduct[] }[];
  workDir: string;
  projectDir: string;
  claudeBin?: string;
  enabled?: boolean;
}

export interface DescriptionWriterResult {
  ran: boolean;
  durationMs: number;
  costUsd?: number;
  notes: string[];
  /** Map section label → phrase marketing (1-2 phrases courtes). */
  descriptions: Record<string, string>;
}

export async function generateDescriptions(
  opts: DescriptionWriterOptions,
): Promise<DescriptionWriterResult> {
  const t0 = Date.now();
  if (opts.enabled === false || opts.sections.length === 0) {
    return { ran: false, durationMs: 0, notes: ['skip'], descriptions: {} };
  }

  const auditPath = path.join(opts.workDir, 'descriptions.json');
  try {
    await fs.writeFile(auditPath, JSON.stringify({ descriptions: {}, notes: [] }, null, 2), 'utf8');
  } catch (e) {
    // workDir disparu (race avec cleanup) ou disque plein → on remonte
    // l'erreur en note, pipeline continue sans descriptions.
    return {
      ran: false,
      durationMs: Date.now() - t0,
      notes: ['init descriptions.json failed: ' + (e as Error).message],
      descriptions: {},
    };
  }
  const prompt = buildPrompt(opts.sections, auditPath);
  const res = await callClaudeCli({
    prompt,
    workDir: opts.workDir,
    projectDir: opts.projectDir,
    claudeBin: opts.claudeBin,
    timeoutMs: CLAUDE_CLI_TIMEOUT_MS,
    allowedTools: 'Edit',
    // Haiku 4.5 : rapide (~5-8s) et fiable si le prompt met l'instruction
    // Edit EN TOUT PREMIER et donne le schema avant les regles. Cf. prompt
    // restructure ci-dessous. On pin la version (pas l'alias 'haiku') pour
    // garantir la reproductibilite des resultats.
    model: 'claude-haiku-4-5',
  });
  if (!res.ok) {
    const rawMsg = res.result ?? '';
    // Detection auth fail Claude : message explicite pour que l'utilisateur
    // sache qu'il doit re-login (vs un echec mystere "failed: ").
    const isAuthFail = /401|authenticate|authentication_error|Invalid authentication/i.test(rawMsg);
    const note = isAuthFail
      ? 'claude auth expirée — relance `claude login` puis copie ~/.claude/.credentials.json (descriptions sommaire désactivées)'
      : 'claude descriptions failed: ' + (rawMsg.slice(0, 200) || 'unknown');
    return {
      ran: false,
      durationMs: Date.now() - t0,
      notes: [note],
      descriptions: {},
    };
  }
  let descriptions: Record<string, string> = {};
  const notes: string[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(auditPath, 'utf8')) as {
      descriptions?: unknown;
      notes?: unknown;
    };
    const validLabels = new Set(opts.sections.map((s) => s.label));
    if (parsed.descriptions && typeof parsed.descriptions === 'object') {
      for (const [k, v] of Object.entries(parsed.descriptions as Record<string, unknown>)) {
        if (typeof v !== 'string') continue;
        if (!validLabels.has(k)) continue;
        const trimmed = v.trim();
        if (trimmed.length === 0 || trimmed.length > 300) continue;
        descriptions[k] = trimmed;
      }
    }
    if (Array.isArray(parsed.notes)) {
      for (const n of parsed.notes) if (typeof n === 'string') notes.push(n);
    }
  } catch (e) {
    notes.push('parse descriptions failed: ' + (e as Error).message);
  }
  // Fallback : si Claude a repondu en TEXTE au lieu d'editer (cas observe sur
  // Haiku avec plusieurs sections), on parse la reponse pour y extraire un
  // JSON ou des paires label/phrase. Permet de recuperer le travail meme
  // quand le tool Edit n'a pas ete invoque.
  if (Object.keys(descriptions).length === 0 && res.result) {
    const fallback = parseClaudeTextFallback(res.result, opts.sections.map((s) => s.label));
    if (Object.keys(fallback).length > 0) {
      descriptions = fallback;
      notes.push(`fallback texte : ${Object.keys(fallback).length} description(s) extraite(s) de la reponse non-Edit`);
      // Persiste pour debug.
      await fs.writeFile(auditPath, JSON.stringify({ descriptions, notes }, null, 2), 'utf8').catch(() => {});
    } else {
      // Log debug : on garde les 600 premiers chars de la reponse Claude
      // pour comprendre pourquoi rien n'a ete extrait (cf. logs Docker).
      console.error('[descriptionWriter] claude empty descriptions ; raw result:', res.result.slice(0, 600));
    }
  }
  return {
    ran: true,
    durationMs: Date.now() - t0,
    costUsd: res.costUsd,
    notes,
    descriptions,
  };
}

/** Cherche un objet JSON dans le texte (regex sur premier bloc {...}) et tente
 *  de parser. Si echoue, cherche des paires "LABEL": "phrase" ligne par ligne.
 *  Sert de filet de secours quand Claude n'utilise pas le tool Edit. */
function parseClaudeTextFallback(
  text: string,
  validLabels: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const labelSet = new Set(validLabels);
  // 1) Recherche bloc JSON entier
  const jsonMatch = text.match(/\{[\s\S]*"descriptions"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj.descriptions && typeof obj.descriptions === 'object') {
        for (const [k, v] of Object.entries(obj.descriptions as Record<string, unknown>)) {
          if (typeof v !== 'string') continue;
          if (!labelSet.has(k)) continue;
          const t = v.trim();
          if (t.length > 0 && t.length <= 300) out[k] = t;
        }
        if (Object.keys(out).length > 0) return out;
      }
    } catch {
      /* JSON malforme, on continue avec le fallback ligne-par-ligne */
    }
  }
  // 2) Fallback ligne par ligne : "LABEL": "phrase" ou LABEL: phrase
  for (const label of validLabels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`"?${escaped}"?\\s*:\\s*"([^"]{20,200})"`, 'i');
    const m = text.match(re);
    if (m) {
      const t = m[1].trim();
      if (t.length > 0) out[label] = t;
    }
  }
  return out;
}

function buildPrompt(
  sections: { label: string; products: PlanProduct[] }[],
  auditPath: string,
): string {
  // Prompt compact pour Haiku 4.5 : 3 produits/section (vs 5 avant) avec
  // max 2 specs cles. Reduit le contexte de ~40% sans amputer trop la
  // matiere : 2 produits etaient trop peu (phrases <40 chars).
  const sectionList = sections
    .map((s) => {
      const sampleLines = s.products.slice(0, 3).map((p) => {
        const parts = [p.name];
        const specs = (p.specs ?? [])
          .slice(0, 2)
          .map((sp) => `${sp.key}: ${sp.values.slice(0, 2).join('/')}`)
          .filter((s) => s.length > 0)
          .join(' ; ');
        if (specs) parts.push(`— ${specs}`);
        return `    * ${parts.join(' ')}`;
      }).join('\n');
      return `  "${s.label}" (${s.products.length} produits) :\n${sampleLines}`;
    })
    .join('\n\n');

  const schemaExample: Record<string, string> = {};
  for (const s of sections) {
    schemaExample[s.label] = '<phrase>';
  }
  const schemaJson = JSON.stringify({ descriptions: schemaExample, notes: [] }, null, 2);

  return `TACHE : edite ${auditPath} avec le tool Edit. Remplace TOUT son contenu par un JSON :

${schemaJson}

Pour chaque section, redige UNE phrase de chapeau (sommaire catalogue produit BtoB sanitaire/cuisine).

PRODUITS :
${sectionList}

REGLES :
- 1 phrase finie par un point, concise (50-150 chars selon richesse des infos).
- S'appuie sur des FAITS concrets des produits : matiere, dimensions, finition, raccord, nb de modeles.
- Pas de cliches marketing ("qualite", "robuste", "fiable", "durable", "ideal", "pour vos installations", "decouvrez").
- Ton catalogue pro factuel, pas d'argumentaire vente.

EXEMPLE :
"Eviers inox 304 a 1 ou 2 bacs, profondeur 180 mm, avec ou sans egouttoir."

Edite ${auditPath} maintenant. Pas de texte de reponse, juste l'Edit.`;
}

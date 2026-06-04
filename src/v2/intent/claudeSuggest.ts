/**
 * Démo Claude vision sur PageSchema : on présente la page (PNG + schema
 * sémantique) à Claude et on lui demande de suggérer des IntentOps pour
 * améliorer le rendu (texte coupé, image qui déborde, etc.).
 *
 * NB : c'est une démo, pas un appel intégré dans l'orchestrator. Le but
 * est de prouver que Claude peut produire des IntentOps valides qu'on
 * sait résoudre en Operations bas niveau.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { callClaudeCli } from '../claudeCli';
import { CLAUDE_CLI_TIMEOUT_MS } from '../timeouts';
import type { PageSchema } from './schema';
import type { IntentOp } from './intent';

export interface ExpectedProductSummary {
  name: string;
  ref: string | null;
  specCount: number;
  hasImage: boolean;
}

export interface SuggestOptions {
  schema: PageSchema;
  /** PNG de la page rendue (apres substitute) pour que Claude la voie. */
  pngPath: string;
  workDir: string;
  projectDir: string;
  claudeBin?: string;
  /** Produits ATTENDUS sur cette page (post-substitution). Permet a Claude
   *  de NE PAS comparer au template d'origine mais au resultat attendu, et
   *  de ne remonter que les defauts visuels (overflow, coupure, image
   *  deformee, chevauchement). */
  expectedProducts?: ExpectedProductSummary[];
}

export interface SuggestResult {
  ran: boolean;
  intents: IntentOp[];
  notes: string[];
  costUsd?: number;
  durationMs: number;
}

export async function suggestIntentsForPage(opts: SuggestOptions): Promise<SuggestResult> {
  const t0 = Date.now();
  const auditPath = path.join(opts.workDir, `intent-suggest-${opts.schema.sourcePage}.json`);
  await fs.writeFile(auditPath, JSON.stringify({ intents: [], notes: [] }, null, 2), 'utf8');

  const prompt = buildPrompt(opts.schema, opts.pngPath, auditPath, opts.expectedProducts ?? []);
  const res = await callClaudeCli({
    prompt,
    workDir: opts.workDir,
    projectDir: opts.projectDir,
    claudeBin: opts.claudeBin,
    timeoutMs: CLAUDE_CLI_TIMEOUT_MS,
    allowedTools: 'Read,Edit',
    model: 'sonnet',
  });

  if (!res.ok) {
    return {
      ran: false,
      intents: [],
      notes: ['claude suggest failed: ' + (res.result?.slice(0, 200) ?? 'unknown')],
      durationMs: Date.now() - t0,
    };
  }

  let intents: IntentOp[] = [];
  const notes: string[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(auditPath, 'utf8')) as {
      intents?: unknown;
      notes?: unknown;
    };
    if (Array.isArray(parsed.intents)) {
      intents = parsed.intents.filter(isValidIntent) as IntentOp[];
    }
    if (Array.isArray(parsed.notes)) {
      for (const n of parsed.notes) if (typeof n === 'string') notes.push(n);
    }
  } catch (e) {
    notes.push('parse intent-suggest failed: ' + (e as Error).message);
  }

  return {
    ran: true,
    intents,
    notes,
    costUsd: res.costUsd,
    durationMs: Date.now() - t0,
  };
}

/** Valide la structure complete d'un IntentOp. Chaque op a des champs
 *  obligatoires — sans validation, le resolver crasherait sur undefined. */
function isValidIntent(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.op !== 'string' || typeof o.target !== 'string') return false;
  switch (o.op) {
    case 'replace_text':
      return typeof o.text === 'string';
    case 'swap_image':
      return typeof o.image_path === 'string';
    case 'update_spec':
      return typeof o.value === 'string';
    case 'set_color':
      return typeof o.color === 'string';
    case 'remove_element':
      return true;
    default:
      return false;
  }
}

function buildPrompt(
  schema: PageSchema,
  pngPath: string,
  auditPath: string,
  expectedProducts: ExpectedProductSummary[],
): string {
  // On serialise les zones disponibles (= cibles valides pour les targets).
  // ATTENTION : on n'inclut PAS les textes courants du template car la page
  // a ete substituee — afficher "title : THERMOSTATIQUE..." alors que Claude
  // voit "SOLANO" le confond et il croit a une erreur de substitution.
  // On donne juste les targets canoniques et la nature de chaque zone.
  const targets: string[] = [];
  const z = schema.zones;
  const prefix = `page_${schema.sourcePage}`;

  const products = z.products ?? [];
  if (products.length > 1) {
    // Multi-produits : on expose chaque product_K.* explicitement.
    for (let k = 0; k < products.length; k++) {
      const p = products[k];
      const pfx = `${prefix}.product_${k}`;
      targets.push(`  # produit ${k}`);
      if (p.title) targets.push(`  - ${pfx}.title : titre`);
      if (p.reference) targets.push(`  - ${pfx}.reference : ref`);
      if (p.color) targets.push(`  - ${pfx}.color : couleur`);
      if (p.image_main) targets.push(`  - ${pfx}.image_main : image principale`);
      if (p.specs_block) {
        for (let i = 0; i < p.specs_block.items.length; i++) {
          targets.push(`  - ${pfx}.specs_block.item_${i}.key / .value`);
        }
      }
    }
  } else {
    // Mono-produit : targets historiques (page_N.zone sans product_).
    if (z.title) targets.push(`  - ${prefix}.title : titre principal du produit`);
    if (z.reference) targets.push(`  - ${prefix}.reference : reference produit`);
    if (z.color) targets.push(`  - ${prefix}.color : couleur / finition`);
    if (z.image_main) targets.push(`  - ${prefix}.image_main : image principale`);
    if (z.specs_block) {
      for (let i = 0; i < z.specs_block.items.length; i++) {
        targets.push(`  - ${prefix}.specs_block.item_${i}.key (libelle) / .value (valeur)`);
      }
    }
  }
  if (z.page_number) targets.push(`  - ${prefix}.page_number : numero de page`);
  if (z.section_banner) targets.push(`  - ${prefix}.section_banner : bandeau de section`);

  const expectedLines = expectedProducts.length === 0
    ? 'AUCUN produit attendu (page vide ou section).'
    : expectedProducts.map(
        (p) =>
          `  - "${p.name}"${p.ref ? ` (ref ${p.ref})` : ''}, ${p.specCount} specs, image ${p.hasImage ? 'oui' : 'non'}`,
      ).join('\n');

  return `TACHE : regarde l'image ${pngPath} (page produit substituee dans un catalogue PDF) puis edite ${auditPath} avec ce JSON :

{
  "intents": [ /* IntentOps correctives, ou [] si rendu propre */ ],
  "notes": [ /* observations courtes en FR */ ]
}

CONTEXTE :
- Cette page a ete substituee : le pipeline a injecte les produits ci-dessous dans le template original.
- Le contenu visuel doit donc correspondre aux produits attendus, PAS au template d'origine.
- Tu n'as PAS a verifier que le texte affiche correspond au produit (le pipeline s'en charge). Tu dois reperer uniquement les DEFAUTS VISUELS dans le rendu.

PRODUITS ATTENDUS SUR CETTE PAGE :
${expectedLines}

DEFAUTS A REMONTER (suggerer un IntentOp correctif) :
- texte tronque / coupe par une bbox trop etroite → propose un replace_text avec un texte plus court
- texte qui deborde visiblement de sa zone → idem
- image deformee, mal cadree, ou qui chevauche un autre element → propose swap_image avec fit "contain"
- glyphes invisibles ou contraste illisible (texte blanc sur blanc) → set_color
- element parasite du template oublie (numero de page d'origine visible, bandeau redondant) → remove_element

A NE PAS REMONTER :
- difference entre contenu affiche et template (c'est la substitution, c'est NORMAL)
- preferences esthetiques (alignement parfait, espacement, typo)
- texte plus court ou plus long que dans le template

ZONES DISPONIBLES (cibles valides pour les "target") :
${targets.join('\n')}

IntentOps SUPPORTES :
  { "op": "replace_text", "target": "<selector>", "text": "<nouveau texte>" }
  { "op": "swap_image", "target": "<selector>", "image_path": "<path>", "fit": "contain"|"cover" }
  { "op": "update_spec", "target": "${prefix}.specs_block.item_N", "key": "<optionnel>", "value": "<nouvelle valeur>" }
  { "op": "set_color", "target": "<selector>", "color": "#rrggbb" }
  { "op": "remove_element", "target": "<selector>" }

REGLES :
- Rendu propre → "intents": [], 1 note explicative.
- Reste minimal : 1-5 intents max par page, uniquement sur des defauts visuels REELS.
- Sur une page multi-produits : si le MEME defaut apparait sur plusieurs produits (ex texte tronque sur 3 produits), propose un intent PAR produit affecte (ex product_0.specs_block.item_4.value, product_1..., product_2...).
- Si tu hesites sur un defaut (low-confidence), PROPOSE quand meme l'intent + ajoute une note "low-confidence: <selector>: <raison>" plutot que de l'omettre. Mieux vaut un intent en trop qu'un defaut manque.
- Le "target" DOIT etre un selector liste ci-dessus.

Edite ${auditPath} avec le tool Edit, rien d'autre.`;
}

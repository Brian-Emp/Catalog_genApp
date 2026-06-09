/**
 * Marketing descriptions per section via Gemini Pro (alternative to Claude Haiku).
 *
 * Contract identical to generateDescriptions: same I/O types for a drop-in swap.
 * Gemini advantage: free tier, no auth expiration, faster (direct HTTP vs
 * CLI spawn).
 *
 * The prompt follows the same logic: 1 factual sentence per section, without
 * marketing cliches, based on the products' specs.
 */

import { isGeminiAvailable } from './client';
import { routedGenerateText } from './providerRouter';
import { parseGeminiJson } from './jsonParse';
import type { PlanProduct } from '../types';

export interface GeminiDescriptionsOptions {
  sections: { label: string; products: PlanProduct[] }[];
  enabled?: boolean;
}

export interface GeminiDescriptionsResult {
  ran: boolean;
  durationMs: number;
  costUsd?: number;
  notes: string[];
  descriptions: Record<string, string>;
}

export async function generateDescriptionsGemini(
  opts: GeminiDescriptionsOptions,
): Promise<GeminiDescriptionsResult> {
  const t0 = Date.now();
  const notes: string[] = [];

  if (opts.enabled === false || opts.sections.length === 0) {
    return { ran: false, durationMs: 0, notes: ['skip'], descriptions: {} };
  }
  if (!(await isGeminiAvailable())) {
    return { ran: false, durationMs: Date.now() - t0, notes: ['GEMINI_KEY absente'], descriptions: {} };
  }

  const prompt = buildPrompt(opts.sections);
  // pref 'speed': flash-lite API by default (fast, ~1s). The Pro CLI is
  // VARIABLE (8-88s observed) → not acceptable on the standard path. The CLI
  // stays as a FALLBACK if the API hits its quota (429). Decision: speed by
  // default, the Pro quality gain isn't worth a systematic +60s wait.
  const res = await routedGenerateText({
    prompt,
    pref: 'speed',
    temperature: 0.6, // a bit of variation to avoid robotic sentences
    maxOutputTokens: 2048,
    module: 'descriptions',
  });
  if (!res.ok || !res.text) {
    notes.push(`gemini error : ${res.error}`);
    return { ran: false, durationMs: Date.now() - t0, notes, descriptions: {} };
  }

  const parsed = parseDescriptionsJson(res.text);
  if (!parsed) {
    notes.push('reponse Gemini non-JSON parseable');
    return { ran: true, durationMs: Date.now() - t0, notes, descriptions: {} };
  }

  // Validation: keep only the requested sections
  const validLabels = new Set(opts.sections.map((s) => s.label));
  const descriptions: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (validLabels.has(k) && typeof v === 'string' && v.trim().length > 0) {
      descriptions[k] = v.trim();
    }
  }

  return {
    ran: true,
    durationMs: Date.now() - t0,
    notes,
    descriptions,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildPrompt(sections: { label: string; products: PlanProduct[] }[]): string {
  const sectionList = sections
    .map((s) => {
      const sampleLines = s.products.slice(0, 6).map((p) => {
        const parts = [p.name];
        const specs = (p.specs ?? [])
          .slice(0, 4)
          .map((sp) => `${sp.key}: ${sp.values.slice(0, 3).join('/')}`)
          .filter((s) => s.length > 0)
          .join(' ; ');
        if (specs) parts.push(`— ${specs}`);
        return `    * ${parts.join(' ')}`;
      }).join('\n');
      return `  "${s.label}" (${s.products.length} produits) :\n${sampleLines}`;
    })
    .join('\n\n');

  return `Tu rediges les phrases de chapeau d'un sommaire catalogue produit BtoB
(sanitaire / cuisine / pompes / piscine selon contexte).

PRODUITS PAR SECTION :
${sectionList}

REGLES STRICTES :
- 1 phrase finie par un point pour CHAQUE section listee ci-dessus.
- RICHE MAIS COMPLETE : 80-110 caracteres, tient sur 2 lignes courtes MAX du sommaire. C'est une phrase ENTIERE, finie par un point, qui agrege 2 a 3 faits concrets et se termine sur un FAIT (matiere, valeur, finition) — JAMAIS sur une clause en suspens, un chiffre sans unite ("60 cm" pas "60"), ou un mot de quantite seul ("...en deux", "...1 ou 2" → toujours suivi du nom : "1 ou 2 bacs"). Mieux vaut 2 faits COMPLETS qu'une liste tronquee.
- N'INCLUS PAS les noms de modeles individuels (ex "Tamari", "Solano", "Maha") : decris la GAMME globalement (matiere + dimensions agregees), pas produit par produit. Ces noms gaspillent la place et coupent la phrase.
- S'appuie sur des FAITS concrets : matiere, dimensions, finition, raccord, nb de modeles, puissance, debit, etc.
- INCLUS les VALEURS CHIFFREES presentes (longueurs, diametres, profondeur, debit, puissance, garantie…) — pas seulement le type ou la matiere. AGREGE les variations entre produits (ex "longueurs 60 a 70 cm", "Ø 22-25 mm", "1 ou 2 bacs") plutot que de rester vague ("avec longueurs de bras") ou de ne citer qu'un seul produit.
- INTERDIT : "qualite", "robuste", "fiable", "durable", "ideal", "pour vos installations", "decouvrez", argumentaire vente.
- INTERDIT aussi les mots de remplissage vides : "disponible(s)", "varie(s)", "divers", "plusieurs modeles" seul, "gamme complete", "differents". Ne JAMAIS finir la phrase sur un mot vague ou de liaison : la phrase doit se terminer sur un FAIT (matiere, valeur, finition).
- Ton catalogue pro factuel.

EXEMPLE BON (~90 car., 2 lignes, complet) : "Barres de douche inox, longueurs 60 a 70 cm, Ø 22-25 mm, support coulissant et inclinable."
EXEMPLE BON (~80 car., 2 lignes, complet) : "Eviers inox 304 a 1 ou 2 bacs, profondeur 180 mm, avec ou sans egouttoir."
EXEMPLE MAUVAIS (coupe/suspendu) : "Barres de douche inox proposees en deux." → ecrire "Barres de douche inox, 2 longueurs 60 et 70 cm, Ø 22-25 mm."
EXEMPLE MAUVAIS (noms de modeles) : "Barres Tamari et Solano en inox." → decrire la gamme : "Barres de douche inox, 60 a 70 cm, support coulissant."
EXEMPLE MAUVAIS (marketing) : "Decouvrez nos eviers ideaux pour vos installations."

REPONDS UNIQUEMENT en JSON pur (pas de markdown, pas de prose), schema :
{
  "<section_label>": "<phrase>",
  ...
}

Inclus TOUTES les sections listees, meme si tu hesites sur la formulation.`;
}

function parseDescriptionsJson(text: string): Record<string, unknown> | null {
  return parseGeminiJson<Record<string, unknown>>(text);
}

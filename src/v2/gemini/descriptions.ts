/**
 * Descriptions marketing par section via Gemini Pro (alternative a Claude Haiku).
 *
 * Contract identique a generateDescriptions : meme types I/O pour swap drop-in.
 * Avantage Gemini : gratuit free tier, pas d'expiration auth, plus rapide
 * (HTTP direct vs spawn CLI).
 *
 * Le prompt reprend la meme logique : 1 phrase factuelle par section, sans
 * cliches marketing, basee sur les specs des produits.
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
  // pref 'speed' : API flash-lite par defaut (rapide, ~1s). Le CLI Pro est
  // VARIABLE (8-88s observe) → pas acceptable sur le chemin standard. Le CLI
  // reste en FALLBACK si l'API tape son quota (429). Decision : vitesse par
  // defaut, le gain qualite Pro ne vaut pas +60s d'attente systematique.
  const res = await routedGenerateText({
    prompt,
    pref: 'speed',
    temperature: 0.6, // un peu de variation pour eviter phrases robotiques
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

  // Validation : ne garde que les sections demandees
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
- TRES concise : 45-75 caracteres MAX, doit tenir sur UNE seule ligne courte (sinon coupee). Agrege les valeurs de facon compacte (ex "bras 60-70 cm, Ø 22-25 mm"). Mieux vaut 2 faits COMPLETS qu'une liste tronquee. Ne finis jamais sur un chiffre sans unite (ecris "60 cm" pas "60").
- S'appuie sur des FAITS concrets : matiere, dimensions, finition, raccord, nb de modeles, puissance, debit, etc.
- INCLUS les VALEURS CHIFFREES presentes (longueurs, diametres, profondeur, debit, puissance, garantie…) — pas seulement le type ou la matiere. AGREGE les variations entre produits (ex "longueurs 60 a 70 cm", "Ø 22-25 mm", "1 ou 2 bacs") plutot que de rester vague ("avec longueurs de bras") ou de ne citer qu'un seul produit.
- INTERDIT : "qualite", "robuste", "fiable", "durable", "ideal", "pour vos installations", "decouvrez", argumentaire vente.
- INTERDIT aussi les mots de remplissage vides : "disponible(s)", "varie(s)", "divers", "plusieurs modeles" seul, "gamme complete", "differents". Ne JAMAIS finir la phrase sur un mot vague ou de liaison : la phrase doit se terminer sur un FAIT (matiere, valeur, finition).
- Ton catalogue pro factuel.

EXEMPLE BON : "Barres de douche inox, longueurs 60 a 70 cm, Ø 22-25 mm, support coulissant et inclinable."
EXEMPLE BON : "Eviers inox 304 a 1 ou 2 bacs, profondeur 180 mm, avec ou sans egouttoir."
EXEMPLE MAUVAIS (vague, valeurs manquantes) : "Trois modeles en inox avec longueurs de bras."
EXEMPLE MAUVAIS (marketing) : "Decouvrez nos eviers ideaux pour vos installations."
EXEMPLE MAUVAIS (filler en fin) : "Barres de douche en inox, disponibles." → ecrire plutot "Barres de douche inox, longueurs 60-70 cm, Ø 22-25 mm."

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

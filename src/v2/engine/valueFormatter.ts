/**
 * Normalisation du formatting des spec VALUES au style template via Claude.
 *
 * Cas d'usage : xlsx avec valeurs minimales ("60", "5") alors que le template
 * attend des valeurs formatees ("60 cm", "5 ans"). Sans normalize, le rendu
 * affiche le bare value et casse l'apparence.
 *
 * Strategie : on regroupe par key (apres normalizeSpecs) les valeurs template
 * vs produit. Si visible mismatch (format different), Claude unifie en suivant
 * le template comme style guide. Mutation in-place sur products.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { callClaudeCli } from '../claudeCli';
import { CLAUDE_CLI_TIMEOUT_MS } from '../timeouts';
import { routedGenerateText } from '../gemini/providerRouter';
import { parseGeminiJson } from '../gemini/jsonParse';
import type { PlanProduct } from '../types';

const MAX_TEMPLATE_SAMPLES_PER_KEY = 4;
const MAX_PRODUCT_SAMPLES_PER_KEY = 4;
const MIN_KEYS_WITH_MISMATCH = 2;

export interface KeyValueSample {
  key: string;
  templateValues: string[];
  productValues: string[];
}

export interface ValueFormatterOptions {
  products: PlanProduct[];
  /** Map key → samples values vues dans le template (collectees par caller
   *  depuis les blocks ProductBlock allocates). */
  templateValuesByKey: Map<string, string[]>;
  workDir: string;
  projectDir: string;
  claudeBin?: string;
  enabled?: boolean;
}

export interface ValueFormatterResult {
  ran: boolean;
  durationMs: number;
  costUsd?: number;
  notes: string[];
  valuesReformatted: number;
}

export async function formatSpecValues(
  opts: ValueFormatterOptions,
): Promise<ValueFormatterResult> {
  const t0 = Date.now();
  if (opts.enabled === false) {
    return { ran: false, durationMs: 0, notes: ['disabled'], valuesReformatted: 0 };
  }
  if (opts.products.length === 0 || opts.templateValuesByKey.size === 0) {
    return {
      ran: false,
      durationMs: 0,
      notes: ['inputs vides'],
      valuesReformatted: 0,
    };
  }

  // Match template ↔ product keys via normalisation (lowercase + alphanum)
  // pour tolerer les variations de trailing space, casse, accents.
  const productValuesByKey = collectProductValues(opts.products);
  const tplByNormKey = new Map<string, string[]>();
  for (const [k, vs] of opts.templateValuesByKey.entries()) {
    const nk = normalizeForMatch(k);
    const arr = tplByNormKey.get(nk) ?? [];
    for (const v of vs) {
      const t = v.trim();
      if (t.length > 0) arr.push(t);
    }
    tplByNormKey.set(nk, arr);
  }
  const candidates: KeyValueSample[] = [];
  for (const [pkey, prodValues] of productValuesByKey.entries()) {
    if (prodValues.length === 0) continue;
    const nk = normalizeForMatch(pkey);
    const tplValues = tplByNormKey.get(nk);
    if (!tplValues || tplValues.length === 0) continue;
    if (!hasFormatMismatch(tplValues, prodValues)) continue;
    candidates.push({
      key: pkey,
      templateValues: [...new Set(tplValues)].slice(0, MAX_TEMPLATE_SAMPLES_PER_KEY),
      productValues: [...new Set(prodValues)].slice(0, MAX_PRODUCT_SAMPLES_PER_KEY),
    });
  }
  if (candidates.length < MIN_KEYS_WITH_MISMATCH) {
    return {
      ran: false,
      durationMs: Date.now() - t0,
      notes: [`format mismatch trop faible (${candidates.length} key(s) candidat(s))`],
      valuesReformatted: 0,
    };
  }

  // Le mapping rules est indexe par product key (pas template), car c'est
  // ce que le mutator va chercher sur s.key.
  const candidateKeys = new Set(candidates.map((c) => c.key));
  const notes: string[] = [];
  let rules: Record<string, string> = {};
  let costUsd: number | undefined;

  // 1. Provider router : API Gemini (cascade de modeles), retour JSON direct.
  //    enableClaudeFallback:false → on NE laisse PAS le router tenter Claude,
  //    car on a deja notre propre fallback Claude agentic (Edit) en aval (etape
  //    2) ; sinon double invocation Claude (latence + 401 redondant).
  const routed = await routedGenerateText({
    prompt: buildPromptDirect(candidates),
    pref: 'speed',
    temperature: 0.1,
    maxOutputTokens: 1024,
    module: 'valueFormatter',
    workDir: opts.workDir,
    enableClaudeFallback: false,
  });
  if (routed.ok && routed.text) {
    const parsed = parseGeminiJson<{ rules?: unknown; notes?: unknown }>(routed.text);
    rules = extractRules(parsed, candidateKeys, notes);
    notes.push(`value formatter via ${routed.provider}`);
  } else {
    // 2. Fallback Claude agentic (file-edit) si tous les providers Gemini KO.
    const auditPath = path.join(opts.workDir, 'value-formatting.json');
    await fs.writeFile(auditPath, JSON.stringify({ rules: {}, notes: [] }, null, 2), 'utf8');
    const res = await callClaudeCli({
      prompt: buildPrompt(candidates, auditPath),
      workDir: opts.workDir,
      projectDir: opts.projectDir,
      claudeBin: opts.claudeBin,
      timeoutMs: CLAUDE_CLI_TIMEOUT_MS,
      allowedTools: 'Edit',
    });
    if (!res.ok) {
      notes.push(`value formatter KO (router: ${routed.error ?? '?'} ; claude: ${res.result?.slice(0, 120) ?? '?'})`);
      return { ran: false, durationMs: Date.now() - t0, notes, valuesReformatted: 0 };
    }
    costUsd = res.costUsd;
    try {
      const parsed = JSON.parse(await fs.readFile(auditPath, 'utf8')) as { rules?: unknown; notes?: unknown };
      rules = extractRules(parsed, candidateKeys, notes);
    } catch (e) {
      notes.push('parse value-formatting failed: ' + (e as Error).message);
      return { ran: false, durationMs: Date.now() - t0, notes, valuesReformatted: 0 };
    }
  }
  // Applique les regles in-place sur les products (mutation, pas de clone)
  let count = 0;
  for (const p of opts.products) {
    for (const s of p.specs) {
      const rule = rules[s.key];
      if (!rule) continue;
      const newValues = s.values
        .map((v) => applyRule(v, rule))
        .filter((v) => v.length > 0);
      // Mutation seulement si changement effectif (evite incrementer count
      // pour des reformattings no-op type "Inox" → "Inox").
      if (newValues.some((nv, i) => nv !== s.values[i])) {
        s.values = newValues;
        count++;
      }
    }
  }
  return {
    ran: true,
    durationMs: Date.now() - t0,
    costUsd,
    notes,
    valuesReformatted: count,
  };
}

/**
 * Extrait les regles {key: template} d'une reponse parsee, filtrant sur les
 * keys candidates connues. Pousse les notes eventuelles. Mutualise le parsing
 * entre le chemin router (Gemini) et le fallback Claude.
 */
function extractRules(
  parsed: { rules?: unknown; notes?: unknown } | null,
  candidateKeys: Set<string>,
  notes: string[],
): Record<string, string> {
  const rules: Record<string, string> = {};
  if (!parsed) return rules;
  if (parsed.rules && typeof parsed.rules === 'object') {
    for (const [k, v] of Object.entries(parsed.rules as Record<string, unknown>)) {
      if (typeof v === 'string' && candidateKeys.has(k)) rules[k] = v;
    }
  }
  if (Array.isArray(parsed.notes)) {
    for (const n of parsed.notes) if (typeof n === 'string') notes.push(n);
  }
  return rules;
}

function collectProductValues(products: PlanProduct[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of products) {
    for (const s of p.specs) {
      const arr = out.get(s.key) ?? [];
      for (const v of s.values) {
        const t = v.trim();
        if (t.length > 0) arr.push(t);
      }
      out.set(s.key, arr);
    }
  }
  return out;
}

/** Detection heuristique : mismatch si les valeurs template ont une unite
 *  (cm/mm/ans/L/kg/inch/lb/°F/Hz/W/...) ou un suffixe dont les valeurs produit
 *  sont depourvues, OU si longueur moyenne tres differente (factor 1.5+). */
function hasFormatMismatch(tplValues: string[], prodValues: string[]): boolean {
  const tplAvgLen = avgLen(tplValues);
  const prodAvgLen = avgLen(prodValues);
  if (tplAvgLen > prodAvgLen * 1.5 && tplAvgLen - prodAvgLen >= 2) return true;
  if (prodAvgLen > tplAvgLen * 1.5 && prodAvgLen - tplAvgLen >= 2) return true;
  const tplHasUnit = tplValues.some((v) => UNIT_RE.test(v));
  const prodHasUnit = prodValues.some((v) => UNIT_RE.test(v));
  if (tplHasUnit && !prodHasUnit) return true;
  return false;
}

/** Liste exhaustive des unites detectees comme suffixe de valeur ("60 cm",
 *  "5 ans", "12 inches", "220 V", "16 GB"). Multi-langue + multi-domaine
 *  (linéaire, poids, volume, temp, élec, fréquence, pression, info, mécanique,
 *  acoustique, lumière, durée FR/EN/DE/ES).
 *
 *  Triee par longueur decroissante a la compilation pour que les tokens longs
 *  soient testes avant leurs prefixes ("kWh" avant "Wh", "années" avant "an"). */
export const UNIT_TOKENS: ReadonlyArray<string> = [
  // Linéaire métrique
  'mm', 'cm', 'dm', 'km', 'm',
  // Linéaire impériale
  'inches', 'inch', 'feet', 'foot', 'yards', 'yard', 'in', 'ft', 'yd', 'mil',
  // Poids
  'kg', 'mg', 'g', 't',
  'pounds', 'pound', 'lbs', 'lb', 'oz', 'tons', 'ton',
  // Volume
  'gallons', 'gallon', 'gal', 'ml', 'cl', 'dl', 'hl', 'qt', 'pt', 'fl', 'L', 'l',
  // Température
  '°C', '°F', '°K', '°', 'degrees', 'degree', 'deg',
  // Pourcentage / permille
  '%', '‰',
  // Électrique
  'kWh', 'mAh', 'Wh', 'Ah',
  'kW', 'MW', 'mW', 'W', 'Watts', 'Watt', 'watts', 'watt',
  'kV', 'mV', 'V', 'Volts', 'Volt', 'volts', 'volt',
  'mA', 'A', 'Amps', 'Amp', 'amps', 'amp',
  'kJ', 'J', 'cal',
  // Fréquence / rotation
  'GHz', 'MHz', 'kHz', 'Hz', 'tr/min', 'rpm', 'tpm',
  // Pression
  'mbar', 'bar', 'psi', 'kPa', 'MPa', 'Pa', 'atm',
  // Information
  'Tbit', 'Gbit', 'Mbit', 'kbit', 'bits', 'bit',
  'TB', 'GB', 'MB', 'kB', 'To', 'Go', 'Mo', 'ko',
  'Mpix', 'Mpx', 'dpi', 'ppi',
  // Mécanique
  'kN', 'Nm', 'N', 'lbf',
  // Surface / Volume imperial (formes contigues)
  'sqft', 'sqin', 'sqyd', 'sqm', 'sqcm',
  'cuft', 'cuin', 'cuyd', 'cum', 'cucm',
  // Vitesse
  'mph', 'kph', 'kmh', 'mps', 'fps', 'rps',
  // Acoustique
  'dBA', 'dBa', 'dB',
  // Lumière
  'lm', 'lux', 'cd',
  // Temps court
  'ms', 'sec', 's',
  'mins', 'min', 'minutes', 'minute',
  'hrs', 'hr', 'hours', 'hour', 'h',
  // Durée FR
  'années', 'année', 'annees', 'annee', 'ans', 'an',
  'mois', 'semaines', 'semaine', 'jours', 'jour',
  // Durée EN
  'years', 'year', 'months', 'month', 'weeks', 'week', 'days', 'day',
  // Durée DE
  'Jahren', 'Jahre', 'Jahr', 'Monaten', 'Monate', 'Monat',
  'Wochen', 'Woche', 'Tagen', 'Tage', 'Tag', 'Stunden', 'Stunde',
  // Durée ES / PT
  'años', 'año', 'meses', 'mes', 'días', 'día', 'dias', 'dia',
  'semanas', 'semana', 'horas', 'hora',
  // Devises symboles + codes ISO (Phase 4 T1)
  'EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'KRW',
  '€', '$', '£', '¥', '₩',
];

/** Detection des devises en prefixe (ex "$5", "£10", "CHF 25").
 *  Le pattern principal UNIT_RE exige `(?<=\d)` ce qui ne couvre que les
 *  suffixes. Pour les devises prefixees (anglo-saxon : "$5"), on ajoute
 *  ce pattern complementaire. */
const CURRENCY_PREFIX_RE = /(?:^|\s)(?:EUR|USD|GBP|JPY|CHF|CAD|AUD|CNY|KRW|[€$£¥₩])\s*\d/u;

export function hasCurrencyPrefix(text: string): boolean {
  return CURRENCY_PREFIX_RE.test(text);
}

function buildUnitRegex(): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Trie par longueur decroissante pour eviter qu'un prefixe consomme avant
  // le full match ("kg" avant "g", "inches" avant "inch", "années" avant "an").
  const sorted = [...UNIT_TOKENS].sort((a, b) => b.length - a.length).map(escape);
  // (?<=\d) : precede d'un chiffre. \s* : whitespace optionnel.
  // (?![A-Za-zÀ-ÿ]) : pas suivi d'une lettre (evite que "5inchworm" matche "inch").
  // On n'utilise pas \b car \b ne marche pas correctement avec ° et %.
  return new RegExp(
    `(?<=\\d)\\s*(?:${sorted.join('|')})(?![A-Za-zÀ-ÿ])`,
    'u',
  );
}

export const UNIT_RE = buildUnitRegex();

/** True si la chaine contient au moins un suffixe "nombre + unite" reconnu,
 *  OU un prefixe devise (ex "$5", "CHF 25"). */
export function hasUnitSuffix(text: string): boolean {
  return UNIT_RE.test(text) || CURRENCY_PREFIX_RE.test(text);
}

function normalizeForMatch(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function avgLen(arr: string[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v.length, 0) / arr.length;
}

/** Applique une regle de formatting. Si la regle contient `{value}`, on
 *  substitue. Sinon : on retourne la regle telle quelle. */
export function applyRule(original: string, rule: string): string {
  const o = original.trim();
  if (o.length === 0) return o;
  if (rule.includes('{value}')) {
    // Garde anti-double-unite : si la valeur contient DEJA le littéral que la
    // regle ajoute (ex regle "{value} m3/h" sur une valeur source "7 m³/h"),
    // ne pas reappliquer — sinon on produit "7 m³/h m3/h". Comparaison
    // normalisee (casse, espaces, exposants ³→3) pour attraper les variantes
    // typographiques. Bug observe E2E catalogC : DÉBIT "7 m³/h" → "7 m3/h m3/h".
    const literal = rule.replace('{value}', '').trim();
    if (literal.length > 0 && normalizeUnit(o).includes(normalizeUnit(literal))) {
      return o;
    }
    return rule.replace('{value}', o);
  }
  if (rule.includes('{n}')) {
    return rule.replace('{n}', o);
  }
  return rule;
}

/** Normalise une chaine d'unite pour comparaison tolerante : minuscule,
 *  sans espaces, exposants decomposes (³→3, ²→2 via NFKD). */
function normalizeUnit(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/\s+/g, '');
}

/**
 * Variante du prompt pour les providers qui retournent le texte sur stdout
 * (Gemini via router) au lieu d'editer un fichier (Claude agentic). Meme
 * consigne metier, mais sortie JSON pure directe.
 */
function buildPromptDirect(samples: KeyValueSample[]): string {
  const block = samples
    .map(
      (s) =>
        `KEY "${s.key}"
  template values : ${s.templateValues.map((v) => JSON.stringify(v)).join(', ')}
  product values  : ${s.productValues.map((v) => JSON.stringify(v)).join(', ')}`,
    )
    .join('\n\n');
  return `Tu es l'auditeur du formatting des spec values entre un xlsx produit et un template PDF.

Pour CHAQUE key ci-dessous, compare les valeurs template (style cible) avec les valeurs produit (a reformulater).

${block}

TA MISSION : pour CHAQUE key ou un reformatting est evident (et SEULEMENT dans ce cas), produis une regle de transformation.

REGLES :
- Regles sous forme de TEMPLATE STRING avec le placeholder \`{value}\` remplace par chaque valeur brute produit.
- Exemples : "{value} cm" → "60" devient "60 cm" ; "{value} ans" → "5" devient "5 ans".
- "{value}" (identite) = inutile, NE PAS ajouter.
- N'ajoute une regle QUE si TOUTES les valeurs produit suivront le meme pattern.
- N'ajoute PAS si : deja bien formatees, formats varies, ou doute.
- CRITIQUE : si les valeurs produit contiennent DEJA l'unite (meme variante
  typographique, ex "7 m³/h" vs template "m3/h", ou "60 cm" vs "cm"), c'est une
  simple variation d'ecriture, PAS un mismatch — NE PAS ajouter de regle (sinon
  unite dupliquee "7 m³/h m3/h").

REPONDS UNIQUEMENT en JSON pur (pas de markdown, pas de prose) :
{
  "rules": { "<key>": "<template avec {value}>" },
  "notes": ["<explication si choix non evident>"]
}

Si aucune regle evidente : {"rules":{},"notes":["..."]}.`;
}

function buildPrompt(samples: KeyValueSample[], auditPath: string): string {
  const block = samples
    .map(
      (s) =>
        `KEY "${s.key}"
  template values : ${s.templateValues.map((v) => JSON.stringify(v)).join(', ')}
  product values  : ${s.productValues.map((v) => JSON.stringify(v)).join(', ')}`,
    )
    .join('\n\n');
  return `Tu es l'auditeur du formatting des spec values entre un xlsx produit et un template PDF.

Pour CHAQUE key ci-dessous, tu compares les valeurs template (style cible) avec les valeurs produit (a reformulater).

${block}

TA MISSION : pour CHAQUE key ou un reformatting est evident (et SEULEMENT dans ce cas), produis une regle de transformation.

REGLES :
- Tu produis des regles sous forme de TEMPLATE STRING avec le placeholder \`{value}\` qui sera remplace par chaque valeur brute du produit.
- Exemples valides :
    "{value} cm"       → "60" devient "60 cm"
    "{value} ans"      → "5" devient "5 ans"
    "{value}"          → identite, inutile, NE PAS ajouter au mapping
- N'ajoute une regle QUE si tu es sur que TOUTES les valeurs produit suivront le meme pattern (ex toutes les valeurs LONGUEUR sont des nombres → safe).
- N'ajoute PAS de regle si :
   * les valeurs produit sont deja bien formatees
   * les valeurs produit ont des formats varies (certaines avec unite, d'autres sans)
   * tu n'es pas sur du pattern

REPONDS UNIQUEMENT en editant ${auditPath} avec ce schema EXACT :
{
  "rules": {
    "<key>": "<template avec {value}>",
    ...
  },
  "notes": [
    "<explication si choix non evident>"
  ]
}

Ne reponds RIEN d'autre que cet edit. Si aucune regle evidente, rules={} et au moins 1 note descriptive.`;
}

/**
 * Normalization of spec VALUE formatting to the template's style via Claude.
 *
 * Use case: an xlsx with minimal values ("60", "5") while the template
 * expects formatted values ("60 cm", "5 ans"). Without normalization, the
 * render shows the bare value and breaks the appearance.
 *
 * Strategy: we group the template vs product values by key (after
 * normalizeSpecs). On a visible mismatch (different format), Claude unifies
 * them using the template as a style guide. In-place mutation on products.
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
  /** Map key → sample values seen in the template (collected by the caller
   *  from the allocated ProductBlock blocks). */
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

  // Match template ↔ product keys via normalization (lowercase + alphanum)
  // to tolerate variations in trailing space, case, accents.
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

  // The rules mapping is indexed by product key (not template), since that
  // is what the mutator looks up on s.key.
  const candidateKeys = new Set(candidates.map((c) => c.key));
  const notes: string[] = [];
  let rules: Record<string, string> = {};
  let costUsd: number | undefined;

  // 1. Provider router: Gemini API (model cascade), direct JSON return.
  //    enableClaudeFallback:false → we do NOT let the router try Claude,
  //    because we already have our own agentic Claude fallback (Edit)
  //    downstream (step 2); otherwise a double Claude invocation (latency +
  //    redundant 401).
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
    // 2. Agentic Claude fallback (file-edit) if all Gemini providers fail.
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
  // Apply the rules in place on the products (mutation, no clone)
  let count = 0;
  for (const p of opts.products) {
    for (const s of p.specs) {
      const rule = rules[s.key];
      if (!rule) continue;
      const newValues = s.values
        .map((v) => applyRule(v, rule))
        .filter((v) => v.length > 0);
      // Mutate only on an actual change (avoids incrementing count for no-op
      // reformattings like "Inox" → "Inox").
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
 * Extracts the {key: template} rules from a parsed response, filtering on the
 * known candidate keys. Pushes any notes. Shares the parsing between the
 * router path (Gemini) and the Claude fallback.
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

/** Heuristic detection: mismatch if the template values have a unit
 *  (cm/mm/ans/L/kg/inch/lb/°F/Hz/W/...) or a suffix that the product values
 *  lack, OR if the average length is very different (factor 1.5+). */
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

/** Exhaustive list of units detected as a value suffix ("60 cm", "5 ans",
 *  "12 inches", "220 V", "16 GB"). Multi-language + multi-domain (linear,
 *  weight, volume, temp, electrical, frequency, pressure, info, mechanical,
 *  acoustic, light, duration FR/EN/DE/ES).
 *
 *  Sorted by decreasing length at compile time so that long tokens are tested
 *  before their prefixes ("kWh" before "Wh", "années" before "an"). */
export const UNIT_TOKENS: ReadonlyArray<string> = [
  // Linear metric
  'mm', 'cm', 'dm', 'km', 'm',
  // Linear imperial
  'inches', 'inch', 'feet', 'foot', 'yards', 'yard', 'in', 'ft', 'yd', 'mil',
  // Weight
  'kg', 'mg', 'g', 't',
  'pounds', 'pound', 'lbs', 'lb', 'oz', 'tons', 'ton',
  // Volume
  'gallons', 'gallon', 'gal', 'ml', 'cl', 'dl', 'hl', 'qt', 'pt', 'fl', 'L', 'l',
  // Temperature
  '°C', '°F', '°K', '°', 'degrees', 'degree', 'deg',
  // Percentage / permille
  '%', '‰',
  // Electrical
  'kWh', 'mAh', 'Wh', 'Ah',
  'kW', 'MW', 'mW', 'W', 'Watts', 'Watt', 'watts', 'watt',
  'kV', 'mV', 'V', 'Volts', 'Volt', 'volts', 'volt',
  'mA', 'A', 'Amps', 'Amp', 'amps', 'amp',
  'kJ', 'J', 'cal',
  // Frequency / rotation
  'GHz', 'MHz', 'kHz', 'Hz', 'tr/min', 'rpm', 'tpm',
  // Pressure
  'mbar', 'bar', 'psi', 'kPa', 'MPa', 'Pa', 'atm',
  // Information
  'Tbit', 'Gbit', 'Mbit', 'kbit', 'bits', 'bit',
  'TB', 'GB', 'MB', 'kB', 'To', 'Go', 'Mo', 'ko',
  'Mpix', 'Mpx', 'dpi', 'ppi',
  // Mechanical
  'kN', 'Nm', 'N', 'lbf',
  // Imperial area / volume (contiguous forms)
  'sqft', 'sqin', 'sqyd', 'sqm', 'sqcm',
  'cuft', 'cuin', 'cuyd', 'cum', 'cucm',
  // Speed
  'mph', 'kph', 'kmh', 'mps', 'fps', 'rps',
  // Acoustic
  'dBA', 'dBa', 'dB',
  // Light
  'lm', 'lux', 'cd',
  // Short time
  'ms', 'sec', 's',
  'mins', 'min', 'minutes', 'minute',
  'hrs', 'hr', 'hours', 'hour', 'h',
  // Duration FR
  'années', 'année', 'annees', 'annee', 'ans', 'an',
  'mois', 'semaines', 'semaine', 'jours', 'jour',
  // Duration EN
  'years', 'year', 'months', 'month', 'weeks', 'week', 'days', 'day',
  // Duration DE
  'Jahren', 'Jahre', 'Jahr', 'Monaten', 'Monate', 'Monat',
  'Wochen', 'Woche', 'Tagen', 'Tage', 'Tag', 'Stunden', 'Stunde',
  // Duration ES / PT
  'años', 'año', 'meses', 'mes', 'días', 'día', 'dias', 'dia',
  'semanas', 'semana', 'horas', 'hora',
  // Currency symbols + ISO codes (Phase 4 T1)
  'EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'KRW',
  '€', '$', '£', '¥', '₩',
];

/** Detection of currencies in prefix position (e.g. "$5", "£10", "CHF 25").
 *  The main UNIT_RE pattern requires `(?<=\d)`, which only covers suffixes.
 *  For prefixed currencies (Anglo-Saxon: "$5"), we add this complementary
 *  pattern. */
const CURRENCY_PREFIX_RE = /(?:^|\s)(?:EUR|USD|GBP|JPY|CHF|CAD|AUD|CNY|KRW|[€$£¥₩])\s*\d/u;

export function hasCurrencyPrefix(text: string): boolean {
  return CURRENCY_PREFIX_RE.test(text);
}

function buildUnitRegex(): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Sort by decreasing length to avoid a prefix being consumed before the
  // full match ("kg" before "g", "inches" before "inch", "années" before "an").
  const sorted = [...UNIT_TOKENS].sort((a, b) => b.length - a.length).map(escape);
  // (?<=\d): preceded by a digit. \s*: optional whitespace.
  // (?![A-Za-zÀ-ÿ]): not followed by a letter (prevents "5inchworm" matching "inch").
  // We don't use \b because \b does not work correctly with ° and %.
  return new RegExp(
    `(?<=\\d)\\s*(?:${sorted.join('|')})(?![A-Za-zÀ-ÿ])`,
    'u',
  );
}

export const UNIT_RE = buildUnitRegex();

/** True if the string contains at least one recognized "number + unit"
 *  suffix, OR a currency prefix (e.g. "$5", "CHF 25"). */
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

/** Applies a formatting rule. If the rule contains `{value}`, we substitute.
 *  Otherwise: we return the rule as-is. */
export function applyRule(original: string, rule: string): string {
  const o = original.trim();
  if (o.length === 0) return o;
  if (rule.includes('{value}')) {
    // Double-unit guard: if the value ALREADY contains the literal that the
    // rule adds (e.g. rule "{value} m3/h" on a source value "7 m³/h"), do not
    // reapply — otherwise we produce "7 m³/h m3/h". Normalized comparison
    // (case, spaces, superscripts ³→3) to catch typographic variants. Bug
    // observed E2E catalogC: DÉBIT "7 m³/h" → "7 m3/h m3/h".
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

/** Normalizes a unit string for tolerant comparison: lowercase, no spaces,
 *  decomposed superscripts (³→3, ²→2 via NFKD). */
function normalizeUnit(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/\s+/g, '');
}

/**
 * Variant of the prompt for providers that return text on stdout (Gemini via
 * the router) instead of editing a file (agentic Claude). Same business
 * instructions, but direct pure-JSON output.
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

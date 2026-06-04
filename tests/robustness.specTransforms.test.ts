/**
 * Stress-test de ROBUSTESSE des transformations de clés/valeurs specs.
 *
 * Objectif : garder fermee la classe de bugs "DIAMÈTREÈTRE" (une transformation
 * qui DUPLIQUE un fragment de mot) et garantir l'absence de regression sur les
 * expansions legitimes. Property-test : on passe un large jeu de mots francais
 * (dont des pieges qui CONTIENNENT un motif d'abreviation) et on verifie qu'AUCUN
 * ne produit de duplication de sous-chaine.
 */
import { describe, it, expect } from 'vitest';
import { __testing } from '../src/services/productsAdapter';
import { applyRule } from '../src/v2/engine/valueFormatter';

const { humanizeKey, expandAbbreviations } = __testing;

/** Detecte une sous-chaine de >=3 lettres immediatement repetee (ex "ètreètre",
 *  "eureur"). Unicode-aware (\p{L} + flag u) pour attraper les accents. */
const DUP_RE = /([\p{L}]{3,})\1/iu;

// Mots francais reels du domaine catalogue qui CONTIENNENT un motif d'abreviation
// (diam, long, haut, prof, larg, temp, press, vol, surf, deb, vit, ep, dim, fin,
//  mat, gar, cap, ref, cond...) sans en etre — ils ne doivent JAMAIS etre alteres.
const TRAP_WORDS = [
  'Diamètre', 'Longueur', 'Hauteur', 'Profondeur', 'Largeur', 'Température',
  'Pression', 'Puissance', 'Tension', 'Volume', 'Surface', 'Débit', 'Vitesse',
  'Épaisseur', 'Dimensions', 'Finition', 'Matière', 'Garantie', 'Capacité',
  'Référence', 'Conditionnement', 'Intensité', 'Fréquence', 'Poids',
  'longévité', 'diamétral', 'hautement', 'professionnel', 'profilé', 'largement',
  'temporaire', 'tempête', 'pressostat', 'volet', 'volant', 'surfacique',
  'débitmètre', 'vitrage', 'vital', 'diminuer', 'dimanche', 'final', 'matériel',
  'matinal', 'garage', 'capot', 'capable', 'refoulement', 'réflexion', 'conducteur',
];

describe('robustesse transformations specs — anti-duplication (classe DIAMÈTRE)', () => {
  it('humanizeKey ne duplique jamais un fragment', () => {
    for (const w of TRAP_WORDS) {
      const out = humanizeKey(w);
      expect(DUP_RE.test(out), `humanizeKey("${w}") = "${out}" duplique un fragment`).toBe(false);
    }
  });

  it('expandAbbreviations ne duplique jamais un fragment', () => {
    for (const w of TRAP_WORDS) {
      const out = expandAbbreviations(w);
      expect(DUP_RE.test(out), `expandAbbreviations("${w}") = "${out}" duplique`).toBe(false);
    }
  });

  it('cles realistes avec prefixe numerique restent propres', () => {
    const keys = ['612 Diamètre bras de douche', '538 Longueur', '100_Profondeur utile', '12-Épaisseur'];
    for (const k of keys) {
      expect(DUP_RE.test(humanizeKey(k)), `humanizeKey("${k}") duplique`).toBe(false);
    }
    expect(humanizeKey('612 Diamètre bras de douche')).toBe('DIAMÈTRE BRAS DE DOUCHE :');
  });
});

describe('robustesse transformations specs — pas de regression sur expansions', () => {
  it('les vraies abreviations restent expansees', () => {
    expect(humanizeKey('deb')).toBe('DÉBIT :');
    expect(humanizeKey('diam')).toBe('DIAMÈTRE :');
    expect(humanizeKey('haut max')).toBe('HAUTEUR MAX :');
    expect(humanizeKey('PUISS')).toBe('PUISSANCE :');
    expect(humanizeKey('temp')).toBe('TEMPÉRATURE :');
  });
});

describe('robustesse value formatter — anti-double-unite', () => {
  const DUP_UNIT_RE = /([\p{L}]{2,})\s*\1/iu;
  it('applyRule ne double jamais une unite', () => {
    const cases: [string, string][] = [
      ['7 m³/h', '{value} m3/h'], ['60', '{value} cm'], ['5', '{value} ans'],
      ['220 V', '{value} v'], ['12', '{value} mm'], ['250 W', '{value} w'],
      ['Ø 5 mm', '{value} mm'],
    ];
    for (const [v, rule] of cases) {
      const out = applyRule(v, rule);
      expect(DUP_UNIT_RE.test(out), `applyRule("${v}","${rule}") = "${out}" double`).toBe(false);
    }
  });
});

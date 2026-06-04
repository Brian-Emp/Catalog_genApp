import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __testing } from '../src/services/productsAdapter';

const {
  stripAccents,
  humanizeKey,
  cleanValue,
  slugify,
  normForMatch,
  identifierValues,
  findByPrefix,
  matchAsset,
  familyToRibbon,
  detectCols,
  expandAbbreviations,
  splitMultiValue,
  IMAGE_EXTS,
  SCHEMA_EXTS,
  DEFAULT_TECHNICAL_KEY_PATTERN,
  CATEGORY_KEYWORD_RE,
} = __testing;

interface MockEntry { absPath: string; baseLower: string; kind: 'image' | 'schema' }
function mockIndex(names: string[]): { entries: MockEntry[]; byBaseLower: Map<string, MockEntry> } {
  const entries: MockEntry[] = names.map((n) => ({ absPath: `/tmp/${n}`, baseLower: n.replace(/\.[^.]+$/, '').toLowerCase(), kind: 'image' }));
  // Reproduit la logique de buildAssetIndex : keys brutes + stripped accents
  // pour permettre lookup byBaseLower.get("megere") sur asset "Mégère.jpg".
  const byBaseLower = new Map<string, MockEntry>();
  for (const e of entries) {
    byBaseLower.set(e.baseLower, e);
    const stripped = e.baseLower.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (stripped !== e.baseLower && !byBaseLower.has(stripped)) {
      byBaseLower.set(stripped, e);
    }
  }
  return { entries, byBaseLower };
}

describe('stripAccents', () => {
  it('retire les diacritiques', () => {
    expect(stripAccents('éàüñç')).toBe('eaunc');
    expect(stripAccents('Mécanisme')).toBe('Mecanisme');
  });
  it('laisse les ASCII intactes', () => {
    expect(stripAccents('hello world')).toBe('hello world');
  });
});

describe('humanizeKey', () => {
  it('retire les prefixes numériques + uppercase + ajoute " :"', () => {
    expect(humanizeKey('538 Longueur bras de douche')).toBe('LONGUEUR BRAS DE DOUCHE :');
  });
  it('compresse les espaces', () => {
    expect(humanizeKey('  Mécanisme   ')).toBe('MÉCANISME :');
  });
  it('retourne chaîne vide si vide après nettoyage', () => {
    expect(humanizeKey('   ')).toBe('');
    expect(humanizeKey('')).toBe('');
  });
  it("ne retire pas un nombre seul (pas un prefixe d'attribut)", () => {
    expect(humanizeKey('538')).toBe('538 :');
  });
  it('strip prefix avec separateur ERP "_" (538_Longueur → LONGUEUR :)', () => {
    expect(humanizeKey('538_Longueur')).toBe('LONGUEUR :');
  });
  it('strip prefix avec separateur ERP "-" (12-Largeur → LARGEUR :)', () => {
    expect(humanizeKey('12-Largeur')).toBe('LARGEUR :');
  });
  it('strip prefix combine _ et - ("100_attr-name" → ATTR NAME :)', () => {
    expect(humanizeKey('100_attr-name')).toBe('ATTR NAME :');
  });
  it('n abime pas un mot accentue contenant une abreviation (bug Diamètreètre)', () => {
    // "\bdiam\b" ASCII matchait "diam" dans "diamètre" (è = non-mot) → doublon.
    expect(humanizeKey('612 Diamètre bras de douche')).toBe('DIAMÈTRE BRAS DE DOUCHE :');
    expect(humanizeKey('Température')).toBe('TEMPÉRATURE :');
    expect(humanizeKey('Longueur')).toBe('LONGUEUR :');
  });
  it('expand toujours une abreviation isolee', () => {
    expect(humanizeKey('Diam')).toBe('DIAMÈTRE :');
    expect(humanizeKey('diam max')).toBe('DIAMÈTRE MAX :');
  });
});

describe('cleanValue', () => {
  it('renvoie la valeur trim si valide', () => {
    expect(cleanValue('  hello  ')).toBe('hello');
    expect(cleanValue(42)).toBe('42');
  });
  it("renvoie null pour des valeurs non informatives", () => {
    expect(cleanValue('non')).toBeNull();
    expect(cleanValue('N/A')).toBeNull();
    expect(cleanValue('-')).toBeNull();
    expect(cleanValue('vide')).toBeNull();
    expect(cleanValue('oui')).toBeNull();
  });
  it("filtre valeurs non informatives multilingues", () => {
    // FR
    expect(cleanValue('neant')).toBeNull();
    expect(cleanValue('néant')).toBeNull();
    expect(cleanValue('inconnu')).toBeNull();
    expect(cleanValue('sans')).toBeNull();
    // EN
    expect(cleanValue('none')).toBeNull();
    expect(cleanValue('null')).toBeNull();
    expect(cleanValue('unknown')).toBeNull();
    expect(cleanValue('empty')).toBeNull();
    expect(cleanValue('yes')).toBeNull();
    // DE
    expect(cleanValue('keine')).toBeNull();
    expect(cleanValue('nichts')).toBeNull();
    // IT
    expect(cleanValue('niente')).toBeNull();
    expect(cleanValue('nessuno')).toBeNull();
    // ES
    expect(cleanValue('ninguno')).toBeNull();
    // PT
    expect(cleanValue('nenhum')).toBeNull();
    // Variantes ERP : "0", "x", "??", "---"
    expect(cleanValue('0')).toBeNull();
    expect(cleanValue('x')).toBeNull();
    expect(cleanValue('??')).toBeNull();
    expect(cleanValue('---')).toBeNull();
  });
  it("preserve valeurs avec contenu utile", () => {
    expect(cleanValue('Inox')).toBe('Inox');
    expect(cleanValue('70 cm')).toBe('70 cm');
    expect(cleanValue('Acier inoxydable')).toBe('Acier inoxydable');
    // "non" est filtré mais "nonante" est gardé (mot complet)
    expect(cleanValue('nonante')).toBe('nonante');
  });
  it('renvoie null pour vide / null / undefined', () => {
    expect(cleanValue('')).toBeNull();
    expect(cleanValue(null)).toBeNull();
    expect(cleanValue(undefined)).toBeNull();
  });
  it('filtre abrev. ponctuees : n.a., n.d., n.s.', () => {
    expect(cleanValue('n.a.')).toBeNull();
    expect(cleanValue('N.A.')).toBeNull();
    expect(cleanValue('n.d.')).toBeNull();
    expect(cleanValue('N.D.')).toBeNull();
    expect(cleanValue('n.s.')).toBeNull();
  });
  it('filtre abrev. courantes nc / nd / ns / na / tbd / tba', () => {
    expect(cleanValue('nc')).toBeNull();
    expect(cleanValue('NC')).toBeNull();
    expect(cleanValue('nd')).toBeNull();
    expect(cleanValue('ns')).toBeNull();
    expect(cleanValue('na')).toBeNull();
    expect(cleanValue('tbd')).toBeNull();
    expect(cleanValue('tba')).toBeNull();
    expect(cleanValue('TBD')).toBeNull();
  });
  it('filtre dashes unicode seuls', () => {
    expect(cleanValue('—')).toBeNull();
    expect(cleanValue('–')).toBeNull();
    expect(cleanValue('---')).toBeNull();
  });
  it('filtre void / variable / cancelled', () => {
    expect(cleanValue('void')).toBeNull();
    expect(cleanValue('var')).toBeNull();
    expect(cleanValue('variable')).toBeNull();
    expect(cleanValue('cancelled')).toBeNull();
  });
  it('strip ponctuation finale avant test', () => {
    expect(cleanValue('N/A.')).toBeNull();
    expect(cleanValue('N.D.,')).toBeNull();
    expect(cleanValue('tbd...')).toBeNull();
    expect(cleanValue('non;')).toBeNull();
  });
  it('filtre points/whitespace seuls', () => {
    expect(cleanValue('.')).toBeNull();
    expect(cleanValue('...')).toBeNull();
    expect(cleanValue('   ')).toBeNull();
  });
  it('strip quotes englobantes simples', () => {
    expect(cleanValue("'Inox'")).toBe('Inox');
    expect(cleanValue('"60 cm"')).toBe('60 cm');
    expect(cleanValue('`AB12`')).toBe('AB12');
  });
  it('strip guillemets typographiques', () => {
    expect(cleanValue('«Eco»')).toBe('Eco');
    expect(cleanValue('“Premium”')).toBe('Premium');
    expect(cleanValue('‹Mini›')).toBe('Mini');
  });
  it('PRESERVE quotes internes', () => {
    // "Eco-stop" entre guillemets DANS un texte plus long
    expect(cleanValue('Butée «Eco-stop»')).toBe('Butée «Eco-stop»');
    expect(cleanValue("L'eau chaude")).toBe("L'eau chaude");
  });
  it('strip quotes vide → null', () => {
    expect(cleanValue("''")).toBeNull();
    expect(cleanValue('""')).toBeNull();
  });
  it('filtre multilingue affirmatif degenere', () => {
    expect(cleanValue('ja')).toBeNull(); // DE
    expect(cleanValue('si')).toBeNull(); // IT/ES
    expect(cleanValue('sim')).toBeNull(); // PT
  });
  it('filtre langues supplementaires "non"', () => {
    expect(cleanValue('nein')).toBeNull(); // DE
    expect(cleanValue('não')).toBeNull(); // PT
    expect(cleanValue('nao')).toBeNull(); // PT sans accent
  });
  it('preserve valeurs ambigues utiles', () => {
    // "nc" est court mais "ncco" est mot entier
    expect(cleanValue('ncco')).toBe('ncco');
    // "var" est filtré mais "variation" est mot complet
    expect(cleanValue('variation')).toBe('variation');
    // Booleen vrai/true gardes (peuvent etre informatifs)
    expect(cleanValue('vrai')).toBe('vrai');
    expect(cleanValue('true')).toBe('true');
  });
});

describe('slugify', () => {
  it('produit un slug ASCII propre', () => {
    expect(slugify('Mitigeur Évier Pro')).toBe('mitigeur-evier-pro');
    expect(slugify('  Hello, World!  ')).toBe('hello-world');
  });
  it('strip les tirets de bord', () => {
    expect(slugify('---abc---')).toBe('abc');
  });
  it('transliteration allemande ß → ss', () => {
    expect(slugify('Straße der Liebe')).toBe('strasse-der-liebe');
    expect(slugify('Weißbier')).toBe('weissbier');
  });
  it('transliteration scandinave ø/å', () => {
    expect(slugify('Skåne Møbler')).toBe('skane-mobler');
  });
  it('transliteration islandais ð/þ', () => {
    expect(slugify('Þórður')).toBe('thordur');
    expect(slugify('Eyjafjörður')).toBe('eyjafjordur');
  });
  it('transliteration polonais ł', () => {
    expect(slugify('Łódź')).toBe('lodz');
  });
  it('transliteration ligatures œ/æ', () => {
    expect(slugify('Sœur')).toBe('soeur');
    expect(slugify('Caesar')).toBe('caesar');
    expect(slugify('Encyclopædia')).toBe('encyclopaedia');
  });
  it('transliteration symboles commerciaux', () => {
    // & → and (sans espaces ajoutes, "R&D" devient "RandD")
    expect(slugify('R&D Lab')).toBe('randd-lab');
    expect(slugify('Tom & Jerry')).toBe('tom-and-jerry');
    expect(slugify('Plus+ Edition')).toBe('plusplus-edition');
  });
  it('preserve les chiffres et lettres ASCII', () => {
    expect(slugify('ABC123')).toBe('abc123');
    expect(slugify('item-42_v3')).toBe('item-42-v3');
  });
});

describe('normForMatch', () => {
  it('compresse en alphanum lowercase', () => {
    expect(normForMatch('999100 0001234')).toBe('9991000001234');
    expect(normForMatch('REF-AB_42')).toBe('refab42');
  });
  it('strip accents (preserve la semantique alphabetique)', () => {
    expect(normForMatch('Mégère')).toBe('megere');
    expect(normForMatch('Cafetière')).toBe('cafetiere');
    expect(normForMatch('À côté')).toBe('acote');
  });
  it('asset accent matche ref sans accent', () => {
    // Cas reel : asset "Mégère.jpg" doit matcher ref XLSX "MEGERE"
    expect(normForMatch('Mégère')).toBe(normForMatch('MEGERE'));
  });
});

describe('identifierValues', () => {
  it("collecte les colonnes id, dedupe et trie par longueur decroissante", () => {
    const headers = ['nom', 'ref', 'sku', 'ean', 'autre'];
    const row = { nom: 'X', ref: 'AB12', sku: 'AB12', ean: '1234567890123', autre: 'zzz' };
    const out = identifierValues(row, headers);
    expect(out[0]).toBe('1234567890123');
    expect(out).toContain('AB12');
    expect(out.filter((v) => v === 'AB12').length).toBe(1);
  });
  it('ignore les valeurs trop courtes (< 3 chars)', () => {
    const headers = ['ref'];
    expect(identifierValues({ ref: 'AB' }, headers)).toEqual([]);
  });
});

describe('findByPrefix', () => {
  const idx = mockIndex(['mitigeur-pro.jpg', 'casque-rouge.png', 'ref_99910001234.png']);

  it('matche exact (basename sans ext)', () => {
    expect(findByPrefix(idx, 'mitigeur-pro')?.baseLower).toBe('mitigeur-pro');
  });
  it('matche par prefix', () => {
    expect(findByPrefix(idx, 'casque')?.baseLower).toBe('casque-rouge');
  });
  it('matche par substring si pas de prefix', () => {
    expect(findByPrefix(idx, '99910001234')?.baseLower).toBe('ref_99910001234');
  });
  it('matche tolerant (ponctuation/espaces) en dernier recours', () => {
    expect(findByPrefix(idx, '999 100 0123 4')?.baseLower).toBe('ref_99910001234');
  });
  it('renvoie undefined si rien ne matche', () => {
    expect(findByPrefix(idx, 'xyz')).toBeUndefined();
  });
  it('tolere leading zeros sur candidate (ref ERP zero-padded)', () => {
    // L'asset est "ref_99910001234.png", candidate "0099910001234" → match
    expect(findByPrefix(idx, '0099910001234')?.baseLower).toBe('ref_99910001234');
  });
  it('tolere leading zeros sur baseLower', () => {
    // Asset zero-padded "0012345.jpg", candidate "12345" → match
    const idxZ = mockIndex(['0012345.jpg', 'autre.png']);
    expect(findByPrefix(idxZ, '12345')?.baseLower).toBe('0012345');
  });
  it('match inverse : asset stem dans la ref XLSX prefixee/suffixee', () => {
    // Asset "ab12.jpg", ref XLSX "REF-AB12-2024" → match (ref contient stem)
    const idxR = mockIndex(['ab12.jpg', 'casque.png']);
    expect(findByPrefix(idxR, 'REF-AB12-2024')?.baseLower).toBe('ab12');
  });
  it('match inverse rejette stems trop courts (anti faux positif)', () => {
    // Asset "ab.jpg" (3 chars), candidate "AB-1234" → stem trop court (< 4)
    // pour eviter de matcher n'importe quel candidate contenant "ab".
    const idxR = mockIndex(['ab.jpg', 'cd.png']);
    expect(findByPrefix(idxR, 'AB-1234')).toBeUndefined();
  });
});

describe('matchAsset', () => {
  const idx = mockIndex(['mitigeur-pro.jpg', 'AB12.png', 'casque-rouge-ergonomique.png']);

  it('priorité 1 : colonne image explicite', () => {
    const out = matchAsset({ image: 'mitigeur-pro.jpg', ref: 'XX' }, ['image', 'ref'], { image: 'image', name: 'ref' }, idx);
    expect(out?.baseLower).toBe('mitigeur-pro');
  });
  it('priorité 1 : URL avec query params (strip ?v=2)', () => {
    const out = matchAsset(
      { image: 'https://cdn.example.com/products/mitigeur-pro.jpg?v=2&w=800' },
      ['image'],
      { image: 'image' },
      idx,
    );
    expect(out?.baseLower).toBe('mitigeur-pro');
  });
  it('priorité 1 : URL avec fragment (strip #anchor)', () => {
    const out = matchAsset(
      { image: 'https://example.com/img/AB12.png#top' },
      ['image'],
      { image: 'image' },
      idx,
    );
    expect(out?.baseLower).toBe('ab12');
  });
  it("priorité 2 : SKU/ref si pas d'image", () => {
    const out = matchAsset({ ref: 'AB12', name: 'Mitigeur' }, ['ref', 'name'], { name: 'name' }, idx);
    expect(out?.baseLower).toBe('ab12');
  });
  it('priorité 3 : slug du nom', () => {
    const out = matchAsset({ name: 'Casque Rouge' }, ['name'], { name: 'name' }, idx);
    expect(out?.baseLower).toBe('casque-rouge-ergonomique');
  });
  it('renvoie undefined si rien ne matche', () => {
    const out = matchAsset({ name: 'Inconnu' }, ['name'], { name: 'name' }, idx);
    expect(out).toBeUndefined();
  });
  it('exact match accent-insensible : asset "Mégère" match ref "MEGERE"', () => {
    // L'asset est indexe avec sa cle stripped, donc byBaseLower.get("megere")
    // retourne l'asset "Mégère.jpg".
    const idxAcc = mockIndex(['Mégère.jpg']);
    // mockIndex met baseLower en lowercase mais ne strip pas accents.
    // On verifie via findByPrefix qui doit utiliser la map enrichie.
    expect(findByPrefix(idxAcc, 'mégère')?.baseLower).toBe('mégère');
    expect(findByPrefix(idxAcc, 'megere')?.baseLower).toBe('mégère');
  });
  it('lookup symetrique : candidate "Mégère" matche asset "megere"', () => {
    // Cas inverse : asset sans accents (typique exports normalisés), ref
    // XLSX avec accents → findByPrefix doit faire lookup avec stripAccents.
    const idxFlat = mockIndex(['megere.jpg', 'autre.png']);
    expect(findByPrefix(idxFlat, 'Mégère')?.baseLower).toBe('megere');
  });
  it('priorité 3 : nom avec suffixe annee → match inverse via findByPrefix', () => {
    // Asset "casque-rouge.jpg", nom XLSX "Casque rouge été 2026"
    // slug → "casque-rouge-ete-2026" qui CONTIENT le stem "casque-rouge"
    // (substring directe via match inverse de findByPrefix).
    const idxLong = mockIndex(['casque-rouge.jpg']);
    const out = matchAsset(
      { name: 'Casque rouge été 2026' },
      ['name'],
      { name: 'name' },
      idxLong,
    );
    expect(out?.baseLower).toBe('casque-rouge');
  });
});

describe('familyToRibbon', () => {
  const mapEr = [
    { ribbon: 'cuisine', keywords: ['cuisine', 'evier', 'mitigeur', 'kitchen'] },
    { ribbon: 'salle de bains', keywords: ['sanitaire', 'bain', 'douche', 'lavabo', 'salle', 'wc', 'bath', 'shower'] },
  ];
  it('mappe via mots-cles vers le ruban canonique', () => {
    expect(familyToRibbon('Robinetterie cuisine', mapEr)).toBe('cuisine');
    expect(familyToRibbon('Évier inox', mapEr)).toBe('cuisine');
    expect(familyToRibbon('Bain & douche', mapEr)).toBe('salle de bains');
  });
  it("renvoie le brut lowercase si aucun match", () => {
    expect(familyToRibbon('autre famille', mapEr)).toBe('autre famille');
  });
  it("renvoie undefined sur entree vide", () => {
    expect(familyToRibbon('')).toBeUndefined();
  });
  it('sans mapping (defaut vide) retourne le brut lowercase', () => {
    expect(familyToRibbon('Cuisine')).toBe('cuisine');
  });
  it('respecte un mapping override', () => {
    const map = [{ ribbon: 'jardin', keywords: ['arrosage'] }];
    expect(familyToRibbon('système d\'arrosage', map)).toBe('jardin');
  });
});

describe('detectCols', () => {
  it('détecte name, sku, color, image, section, family', () => {
    const headers = ['Designation', 'Reference', 'Couleur', 'Image', 'libelle_famille', 'libelle_sfamille'];
    const cols = detectCols(headers);
    expect(cols.name).toBe('Designation');
    expect(cols.sku).toBe('Reference');
    expect(cols.color).toBe('Couleur');
    expect(cols.image).toBe('Image');
    expect(cols.family).toBe('libelle_famille');
    expect(cols.section).toBe('libelle_sfamille');
  });
  it("fallback name = premier header si rien ne matche", () => {
    const cols = detectCols(['col_a', 'col_b']);
    expect(cols.name).toBe('col_a');
  });
  it('NAME multi-langue : NO/DK "Navn"', () => {
    expect(detectCols(['Navn', 'Pris']).name).toBe('Navn');
  });
  it('NAME multi-langue : SE "Varunamn"', () => {
    expect(detectCols(['Varunamn', 'Pris']).name).toBe('Varunamn');
  });
  it('NAME ERP : "Intitule"', () => {
    expect(detectCols(['Intitule', 'Reference']).name).toBe('Intitule');
  });
  it('NAME variantes : "short_desc" / "display_name"', () => {
    expect(detectCols(['short_desc', 'sku']).name).toBe('short_desc');
    expect(detectCols(['display_name', 'sku']).name).toBe('display_name');
  });

  describe('détection couleur multilingue', () => {
    it('FR : "Couleur" + "Finition" + "Coloris" + "Teinte"', () => {
      expect(detectCols(['Nom', 'Couleur']).color).toBe('Couleur');
      expect(detectCols(['Nom', 'Finition']).color).toBe('Finition');
      expect(detectCols(['Nom', 'Coloris']).color).toBe('Coloris');
      expect(detectCols(['Nom', 'Teinte']).color).toBe('Teinte');
    });
    it('EN : "Color" / "Colour" / "Finish" / "Shade"', () => {
      expect(detectCols(['Name', 'Color']).color).toBe('Color');
      expect(detectCols(['Name', 'Colour']).color).toBe('Colour');
      expect(detectCols(['Name', 'Finish']).color).toBe('Finish');
      expect(detectCols(['Name', 'Shade']).color).toBe('Shade');
    });
    it('DE : "Farbe" + "Farbton" + "Ausfuhrung"', () => {
      expect(detectCols(['Name', 'Farbe']).color).toBe('Farbe');
      expect(detectCols(['Name', 'Farbton']).color).toBe('Farbton');
      expect(detectCols(['Name', 'Ausfuhrung']).color).toBe('Ausfuhrung');
    });
    it('ES : "Acabado" + "Tonalidad" + "Matiz"', () => {
      expect(detectCols(['Nombre', 'Acabado']).color).toBe('Acabado');
      expect(detectCols(['Nombre', 'Tonalidad']).color).toBe('Tonalidad');
      expect(detectCols(['Nombre', 'Matiz']).color).toBe('Matiz');
    });
    it('IT : "Colore" + "Finitura" + "Tinta"', () => {
      expect(detectCols(['Nome', 'Colore']).color).toBe('Colore');
      expect(detectCols(['Nome', 'Finitura']).color).toBe('Finitura');
      expect(detectCols(['Nome', 'Tinta']).color).toBe('Tinta');
    });
    it('PT : "Cor" + "Acabamento" + "Tonalidade"', () => {
      expect(detectCols(['Nome', 'Cor']).color).toBe('Cor');
      expect(detectCols(['Nome', 'Acabamento']).color).toBe('Acabamento');
      expect(detectCols(['Nome', 'Tonalidade']).color).toBe('Tonalidade');
    });
    it('NO/DK : "Farve"', () => {
      expect(detectCols(['Navn', 'Farve']).color).toBe('Farve');
    });
    it('SE : "Färg" / "Farg"', () => {
      expect(detectCols(['Namn', 'Färg']).color).toBe('Färg');
      expect(detectCols(['Namn', 'Farg']).color).toBe('Farg');
    });
    it('PL : "Kolor"', () => {
      expect(detectCols(['Nazwa', 'Kolor']).color).toBe('Kolor');
    });
  });

  describe('détection NAME multilingue', () => {
    it('IT : "Prodotto" / "Articolo" / "Descrizione"', () => {
      expect(detectCols(['Prodotto', 'X']).name).toBe('Prodotto');
      expect(detectCols(['Articolo', 'X']).name).toBe('Articolo');
      expect(detectCols(['Descrizione', 'X']).name).toBe('Descrizione');
    });
    it('PT : "Nome" / "Descrição"', () => {
      expect(detectCols(['Nome', 'X']).name).toBe('Nome');
      expect(detectCols(['Descrição', 'X']).name).toBe('Descrição');
    });
    it('DE : "Produkt" / "Bezeichnung"', () => {
      expect(detectCols(['Produkt', 'X']).name).toBe('Produkt');
      expect(detectCols(['Bezeichnung', 'X']).name).toBe('Bezeichnung');
    });
    it('NL/SE/PL : "Namn" / "Nazwa"', () => {
      expect(detectCols(['Namn', 'X']).name).toBe('Namn');
      expect(detectCols(['Nazwa', 'X']).name).toBe('Nazwa');
    });
    it('EN variants : "Item Name" / "Product Name"', () => {
      expect(detectCols(['Item Name', 'X']).name).toBe('Item Name');
      expect(detectCols(['Product Name', 'X']).name).toBe('Product Name');
    });
  });

  describe('détection SKU multilingue', () => {
    it('IT : "Riferimento" / "Articolo"', () => {
      expect(detectCols(['Nome', 'Riferimento']).sku).toBe('Riferimento');
    });
    it('PT : "Referência" / "Artigo"', () => {
      expect(detectCols(['Nome', 'Referência']).sku).toBe('Referência');
    });
    it('GTIN / EAN / ISBN', () => {
      expect(detectCols(['Name', 'GTIN']).sku).toBe('GTIN');
      expect(detectCols(['Name', 'EAN']).sku).toBe('EAN');
      expect(detectCols(['Name', 'ISBN']).sku).toBe('ISBN');
    });
    it('PL : "Kod" / "Nr"', () => {
      expect(detectCols(['Nazwa', 'Kod']).sku).toBe('Kod');
    });
    it('NO/DK : "Varenr" / "Varenummer"', () => {
      expect(detectCols(['Navn', 'Varenr']).sku).toBe('Varenr');
      expect(detectCols(['Navn', 'Varenummer']).sku).toBe('Varenummer');
    });
    it('Model / Modèle / Modell (multi-langue)', () => {
      expect(detectCols(['Name', 'Model']).sku).toBe('Model');
      expect(detectCols(['Nom', 'Modèle']).sku).toBe('Modèle');
      expect(detectCols(['Name', 'Modell']).sku).toBe('Modell');
      expect(detectCols(['Nome', 'Modello']).sku).toBe('Modello');
      expect(detectCols(['Nombre', 'Modelo']).sku).toBe('Modelo');
    });
    it('Part Number variantes', () => {
      expect(detectCols(['Name', 'Part Number']).sku).toBe('Part Number');
      expect(detectCols(['Name', 'PartNo']).sku).toBe('PartNo');
      expect(detectCols(['Name', 'P/N']).sku).toBe('P/N');
    });
  });

  describe('expandAbbreviations', () => {
    it('DEB → Débit', () => expect(expandAbbreviations('DEB')).toBe('Débit'));
    it('TEMP → Température', () => expect(expandAbbreviations('TEMP')).toBe('Température'));
    it('PRESS → Pression', () => expect(expandAbbreviations('PRESS')).toBe('Pression'));
    it('DIAM MAX → Diamètre MAX', () => {
      expect(expandAbbreviations('DIAM MAX')).toBe('Diamètre MAX');
    });
    it('mots normaux non touchés', () => {
      expect(expandAbbreviations('Acier Inox')).toBe('Acier Inox');
    });
    it("pas de faux positifs (ne touche pas 'temperature' complet)", () => {
      // 'temp' est mot entier dans "TEMP MAX" mais pas dans "TEMPERATURE"
      expect(expandAbbreviations('TEMPERATURE')).toBe('TEMPERATURE');
    });
    it('boundary check : preserve mots longs (deboiteur n est pas Débit)', () => {
      expect(expandAbbreviations('Deboiteur')).toBe('Deboiteur');
    });
    it('multiple abbréviations dans la même chaîne', () => {
      expect(expandAbbreviations('TEMP DEB PRESS')).toBe('Température Débit Pression');
    });
    it('FR nouvelles : puiss / vit / vol / surf / cap', () => {
      expect(expandAbbreviations('PUISS')).toBe('Puissance');
      expect(expandAbbreviations('VIT')).toBe('Vitesse');
      expect(expandAbbreviations('VOL')).toBe('Volume');
      expect(expandAbbreviations('SURF')).toBe('Surface');
      expect(expandAbbreviations('CAP')).toBe('Capacité');
      expect(expandAbbreviations('TENS')).toBe('Tension');
      expect(expandAbbreviations('FREQ')).toBe('Fréquence');
    });
    it('EN dimensionnel : len / wid / hgt / wgt / qty', () => {
      expect(expandAbbreviations('LEN')).toBe('Length');
      expect(expandAbbreviations('WID')).toBe('Width');
      expect(expandAbbreviations('HGT')).toBe('Height');
      expect(expandAbbreviations('HGHT')).toBe('Height');
      expect(expandAbbreviations('WGT')).toBe('Weight');
      expect(expandAbbreviations('QTY')).toBe('Quantity');
      expect(expandAbbreviations('QNTY')).toBe('Quantity');
    });
    it('boundary : preserve "lenteur", "widget", "capacite", "vitesse"', () => {
      expect(expandAbbreviations('lenteur')).toBe('lenteur');
      expect(expandAbbreviations('widget')).toBe('widget');
      expect(expandAbbreviations('capacite')).toBe('capacite');
      expect(expandAbbreviations('vitesse')).toBe('vitesse');
    });
    it('intentionnellement NON expansé : MIN / MAX / MOY (qualifiers)', () => {
      expect(expandAbbreviations('MAX')).toBe('MAX');
      expect(expandAbbreviations('MIN')).toBe('MIN');
      expect(expandAbbreviations('MOY')).toBe('MOY');
    });
  });

  describe('CATEGORY_KEYWORD_RE (audit #7)', () => {
    const re = CATEGORY_KEYWORD_RE as RegExp;
    const m = (h: string) => re.test(h);
    it('FR : famille / univers / rayon / gamme / categorie', () => {
      expect(m('famille')).toBe(true);
      expect(m('Univers')).toBe(true);
      expect(m('Rayon')).toBe(true);
      expect(m('Gamme')).toBe(true);
      expect(m('Categorie')).toBe(true);
      expect(m('Chapitre')).toBe(true);
      expect(m('Ligne')).toBe(true);
    });
    it('EN : family / category / department / range / series / collection', () => {
      expect(m('Family')).toBe(true);
      expect(m('Category')).toBe(true);
      expect(m('Department')).toBe(true);
      expect(m('Range')).toBe(true);
      expect(m('Series')).toBe(true);
      expect(m('Collection')).toBe(true);
      expect(m('Classification')).toBe(true);
    });
    it('DE : familie / kategorie / rubrik / abteilung / gruppe / kollektion', () => {
      expect(m('Familie')).toBe(true);
      expect(m('Kategorie')).toBe(true);
      expect(m('Rubrik')).toBe(true);
      expect(m('Abteilung')).toBe(true);
      expect(m('Gruppe')).toBe(true);
      expect(m('Kollektion')).toBe(true);
    });
    it('ES : familia / categoría / sección / grupo / colección', () => {
      expect(m('Familia')).toBe(true);
      expect(m('Categoría')).toBe(true);
      expect(m('Sección')).toBe(true);
      expect(m('Grupo')).toBe(true);
      expect(m('Colección')).toBe(true);
    });
    it('IT : famiglia / categoria / gamma / collezione / serie', () => {
      expect(m('famiglia')).toBe(false); // n'est pas dans le regex (juste famille)
      expect(m('categoria')).toBe(true);
      expect(m('gamma')).toBe(true);
      expect(m('collezione')).toBe(true);
      expect(m('serie')).toBe(true);
    });
    it('PT : familia / colecao / serie', () => {
      expect(m('familia')).toBe(true);
      expect(m('colecao')).toBe(true);
    });
    it('NL/SE/PL : avdelning / kategori / kategoria', () => {
      expect(m('avdelning')).toBe(true);
      expect(m('kategori')).toBe(true);
      expect(m('kategoria')).toBe(true);
    });
    it('Variantes : type_produit / product_type / type produit', () => {
      expect(m('type_produit')).toBe(true);
      expect(m('product_type')).toBe(true);
      expect(m('product type')).toBe(true);
    });
    it('rejette colonnes non-catégorie', () => {
      expect(m('nom')).toBe(false);
      expect(m('reference')).toBe(false);
      expect(m('prix')).toBe(false);
      expect(m('image')).toBe(false);
      expect(m('couleur')).toBe(false);
    });
  });

  describe('DEFAULT_TECHNICAL_KEY_PATTERN', () => {
    const re = DEFAULT_TECHNICAL_KEY_PATTERN as RegExp;
    const matches = (h: string) => re.test(h);

    it('filtre cles ERP internes', () => {
      expect(matches('bdd_id')).toBe(true);
      expect(matches('bdd.priv')).toBe(true);
      expect(matches('attribut')).toBe(true);
      expect(matches('statut')).toBe(true);
      expect(matches('code produit')).toBe(true);
    });
    it('filtre niveaux famille (deja remontes en hierarchie)', () => {
      expect(matches('libelle famille')).toBe(true);
      expect(matches('libelle sfamille')).toBe(true);
      expect(matches('libelle ssfamille')).toBe(true);
      expect(matches('sfamille')).toBe(true);
      expect(matches('ssfamille')).toBe(true);
    });
    it('filtre codes barres (deja en ref/sku)', () => {
      expect(matches('gencod')).toBe(true);
      expect(matches('gtin')).toBe(true);
      expect(matches('ean')).toBe(true);
      expect(matches('upc')).toBe(true);
      expect(matches('isbn')).toBe(true);
    });
    it('filtre identifiants techniques', () => {
      expect(matches('id')).toBe(true);
      expect(matches('uid')).toBe(true);
      expect(matches('uuid')).toBe(true);
      expect(matches('guid')).toBe(true);
    });
    it('filtre marque / certification', () => {
      expect(matches('marque')).toBe(true);
      expect(matches('nf')).toBe(true);
    });
    it('filtre supply chain', () => {
      expect(matches('fournisseur')).toBe(true);
      expect(matches('supplier')).toBe(true);
      expect(matches('vendor')).toBe(true);
      expect(matches('stock')).toBe(true);
      expect(matches('warehouse')).toBe(true);
      expect(matches('entrepot')).toBe(true);
    });
    it('filtre cycle de vie', () => {
      expect(matches('obsolete')).toBe(true);
      expect(matches('archive')).toBe(true);
      expect(matches('deleted')).toBe(true);
      expect(matches('inactif')).toBe(true);
    });
    it('filtre meta dates / version', () => {
      expect(matches('version')).toBe(true);
      expect(matches('revision')).toBe(true);
      expect(matches('rev')).toBe(true);
      expect(matches('created_at')).toBe(true);
      expect(matches('updated_at')).toBe(true);
      expect(matches('date_creation')).toBe(true);
      expect(matches('date_modification')).toBe(true);
      expect(matches('date_maj')).toBe(true);
    });
    it('insensible casse', () => {
      expect(matches('MARQUE')).toBe(true);
      expect(matches('STOCK')).toBe(true);
      expect(matches('Vendor')).toBe(true);
    });
    it('PRESERVE keys metier utiles', () => {
      // mots qui contiennent une keyword mais sont des vraies specs
      expect(matches('matiere')).toBe(false);
      expect(matches('longueur')).toBe(false);
      expect(matches('marque-modele')).toBe(false); // pas marque seul
      expect(matches('idee')).toBe(false); // pas id seul
      expect(matches('versions disponibles')).toBe(false); // pas version seul
    });
  });

  describe('IMAGE_EXTS / SCHEMA_EXTS', () => {
    it('formats classiques (niveau 1)', () => {
      expect(IMAGE_EXTS.has('.png')).toBe(true);
      expect(IMAGE_EXTS.has('.jpg')).toBe(true);
      expect(IMAGE_EXTS.has('.jpeg')).toBe(true);
      expect(IMAGE_EXTS.has('.gif')).toBe(true);
      expect(IMAGE_EXTS.has('.webp')).toBe(true);
    });
    it('formats etendus Pillow (niveau 2)', () => {
      expect(IMAGE_EXTS.has('.tiff')).toBe(true);
      expect(IMAGE_EXTS.has('.tif')).toBe(true);
      expect(IMAGE_EXTS.has('.bmp')).toBe(true);
      expect(IMAGE_EXTS.has('.jfif')).toBe(true);
      expect(IMAGE_EXTS.has('.ico')).toBe(true);
    });
    it('formats modernes (niveau 3)', () => {
      expect(IMAGE_EXTS.has('.heic')).toBe(true);
      expect(IMAGE_EXTS.has('.heif')).toBe(true);
      expect(IMAGE_EXTS.has('.avif')).toBe(true);
    });
    it('rejette formats non-image', () => {
      expect(IMAGE_EXTS.has('.pdf')).toBe(false);
      expect(IMAGE_EXTS.has('.svg')).toBe(false);
      expect(IMAGE_EXTS.has('.txt')).toBe(false);
      expect(IMAGE_EXTS.has('.xlsx')).toBe(false);
    });
    it('schema = pdf uniquement', () => {
      expect(SCHEMA_EXTS.has('.pdf')).toBe(true);
      expect(SCHEMA_EXTS.has('.png')).toBe(false);
    });
  });

  describe('splitMultiValue', () => {
    it('split sur newline', () => {
      expect(splitMultiValue('60 cm\n80 cm\n100 cm')).toEqual([
        '60 cm', '80 cm', '100 cm',
      ]);
    });
    it('split sur newline windows (\\r\\n)', () => {
      expect(splitMultiValue('A\r\nB\r\nC')).toEqual(['A', 'B', 'C']);
    });
    it('split sur " | " (pipe entoure d\'espaces)', () => {
      expect(splitMultiValue('Inox | Chrome | Doré')).toEqual([
        'Inox', 'Chrome', 'Doré',
      ]);
    });
    it('split sur " ; " (semi-colon entoure d\'espaces)', () => {
      expect(splitMultiValue('5 ans ; 2 ans accessoires')).toEqual([
        '5 ans', '2 ans accessoires',
      ]);
    });
    it('NE split PAS sur virgule simple (ambigu)', () => {
      expect(splitMultiValue('Mat, brillant')).toEqual(['Mat, brillant']);
    });
    it('NE split PAS sur "x" / dimensions composites', () => {
      expect(splitMultiValue('60x80x30')).toEqual(['60x80x30']);
    });
    it('NE split PAS pipe colle "A|B" (interne)', () => {
      expect(splitMultiValue('A|B')).toEqual(['A|B']);
    });
    it('filtre segments vides apres split', () => {
      expect(splitMultiValue('A\n\nB\n')).toEqual(['A', 'B']);
    });
    it('filtre segments non-informatives apres split', () => {
      expect(splitMultiValue('60 cm\nN/A\n80 cm')).toEqual(['60 cm', '80 cm']);
      expect(splitMultiValue('Inox | - | Chrome')).toEqual(['Inox', 'Chrome']);
    });
    it('value sans separateur reste un seul element', () => {
      expect(splitMultiValue('Acier inoxydable')).toEqual(['Acier inoxydable']);
    });
    it('chaine vide → tableau vide', () => {
      expect(splitMultiValue('')).toEqual([]);
    });
    it('combine separateurs : newline + pipe', () => {
      expect(splitMultiValue('A | B\nC | D')).toEqual(['A', 'B', 'C', 'D']);
    });
  });

  describe('détection IMAGE multilingue', () => {
    it('IT/PT : "Immagine" / "Imagem"', () => {
      expect(detectCols(['Nome', 'Immagine']).image).toBe('Immagine');
      expect(detectCols(['Nome', 'Imagem']).image).toBe('Imagem');
    });
    it('DE : "Abbildung" / "Grafik"', () => {
      expect(detectCols(['Name', 'Abbildung']).image).toBe('Abbildung');
      expect(detectCols(['Name', 'Grafik']).image).toBe('Grafik');
    });
    it('variantes : "Foto" / "Vignette" / "Thumbnail"', () => {
      expect(detectCols(['Name', 'Foto']).image).toBe('Foto');
      expect(detectCols(['Name', 'Vignette']).image).toBe('Vignette');
      expect(detectCols(['Name', 'Thumbnail']).image).toBe('Thumbnail');
    });
    it('NO : "Bilde" / DK : "Billede"', () => {
      expect(detectCols(['Navn', 'Bilde']).image).toBe('Bilde');
      expect(detectCols(['Navn', 'Billede']).image).toBe('Billede');
    });
    it('PL : "Obraz" / "Zdjecie"', () => {
      expect(detectCols(['Nazwa', 'Obraz']).image).toBe('Obraz');
      expect(detectCols(['Nazwa', 'Zdjecie']).image).toBe('Zdjecie');
    });
    it('variantes EN : "Snapshot" / "Cover" / "image_url"', () => {
      expect(detectCols(['Name', 'Snapshot']).image).toBe('Snapshot');
      expect(detectCols(['Name', 'Cover']).image).toBe('Cover');
      expect(detectCols(['Name', 'image_url']).image).toBe('image_url');
      expect(detectCols(['Name', 'product_image']).image).toBe('product_image');
    });
  });

  describe('détection auto via cardinalité (rows fournis)', () => {
    it('3 niveaux : trie par cardinalité croissante (peu de valeurs = haut)', () => {
      const headers = ['Designation', 'Univers', 'Rayon', 'Categorie'];
      // 2 univers, 4 rayons, 8 catégories → univers=family, rayon=subFamily, categorie=section
      const rows = [
        { Designation: 'P1', Univers: 'Sanitaire', Rayon: 'Robinetterie', Categorie: 'Mitigeurs' },
        { Designation: 'P2', Univers: 'Sanitaire', Rayon: 'Robinetterie', Categorie: 'Mélangeurs' },
        { Designation: 'P3', Univers: 'Sanitaire', Rayon: 'Douches', Categorie: 'Barres' },
        { Designation: 'P4', Univers: 'Sanitaire', Rayon: 'Douches', Categorie: 'Têtes' },
        { Designation: 'P5', Univers: 'Chauffage', Rayon: 'Radiateurs', Categorie: 'Aluminium' },
        { Designation: 'P6', Univers: 'Chauffage', Rayon: 'Radiateurs', Categorie: 'Fonte' },
        { Designation: 'P7', Univers: 'Chauffage', Rayon: 'Pompes', Categorie: 'Centrifuges' },
        { Designation: 'P8', Univers: 'Chauffage', Rayon: 'Pompes', Categorie: 'Volumétriques' },
      ];
      const cols = detectCols(headers, undefined, rows);
      expect(cols.family).toBe('Univers');
      expect(cols.subFamily).toBe('Rayon');
      expect(cols.section).toBe('Categorie');
    });

    it('detection avec "Collection" / "Ligne" / "Series"', () => {
      const headers = ['Name', 'Collection', 'Ligne'];
      const rows = [
        { Name: 'P1', Collection: 'Premium', Ligne: 'Eco' },
        { Name: 'P2', Collection: 'Premium', Ligne: 'Pro' },
        { Name: 'P3', Collection: 'Standard', Ligne: 'Pro' },
      ];
      const cols = detectCols(headers, undefined, rows);
      // 2 collections, 2 lignes → cardinalité égale, l'ordre dans CATEGORY_KEYWORD_RE
      // décide. Ce qu'on vérifie : les 2 colonnes sont reconnues comme categorie.
      expect([cols.family, cols.subFamily, cols.section].filter(Boolean).length).toBeGreaterThanOrEqual(2);
    });

    it('2 niveaux : famille = colonne avec le moins de valeurs', () => {
      const headers = ['Designation', 'Department', 'Classification'];
      const rows = [
        { Designation: 'P1', Department: 'A', Classification: 'X' },
        { Designation: 'P2', Department: 'A', Classification: 'Y' },
        { Designation: 'P3', Department: 'B', Classification: 'Z' },
      ];
      const cols = detectCols(headers, undefined, rows);
      expect(cols.family).toBe('Department');
      expect(cols.section).toBe('Classification');
    });

    it('marche pour noms de colonnes non-français (EN/DE)', () => {
      const headers = ['Name', 'Department', 'Classification'];
      const rows = [
        { Name: 'P1', Department: 'Tools', Classification: 'Hammer' },
        { Name: 'P2', Department: 'Tools', Classification: 'Screw' },
        { Name: 'P3', Department: 'Garden', Classification: 'Plant' },
      ];
      const cols = detectCols(headers, undefined, rows);
      expect(cols.family).toBe('Department');
      expect(cols.section).toBe('Classification');
    });

    it('ignore colonnes trop spécifiques (> 200 valeurs)', () => {
      const headers = ['Designation', 'Famille', 'Type_Produit'];
      const rows = Array.from({ length: 250 }, (_, i) => ({
        Designation: `P${i}`,
        Famille: i < 125 ? 'A' : 'B',
        Type_Produit: `Unique${i}`, // 250 valeurs distinctes = trop
      }));
      const cols = detectCols(headers, undefined, rows);
      // Famille a 2 valeurs → garde. Type_Produit a 250 valeurs → drop.
      expect(cols.family).toBe('Famille');
      // section fallback sur les patterns regex (Type_Produit ne match pas les
      // patterns mais quand même utilisé en section ? Non, on retourne undefined
      // si pas trouvé dans auto + pas dans patterns regex).
    });

    it('fallback regex si pas de rows', () => {
      const headers = ['Designation', 'libelle_famille', 'libelle_ssfamille'];
      const cols = detectCols(headers);
      // Sans rows : utilise les patterns regex
      expect(cols.family).toBe('libelle_famille');
      expect(cols.section).toBe('libelle_ssfamille');
    });
  });
});


import { buildProductInputs } from '../src/services/productsAdapter';
import type { ExtractedFile } from '../src/types';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

function mockXlsxFile(headers: string[], rows: Record<string, string>[]): ExtractedFile {
  return {
    originalName: 'test.xlsx',
    storedPath: '/tmp/fake-not-used.xlsx',
    mimeType: 'application/octet-stream',
    sizeBytes: 0,
    kind: 'xlsx',
    category: 'data',
    extracted: {
      kind: 'xlsx',
      sheets: ['Sheet1'],
      headers,
      rowCount: rows.length,
      rows,
    },
  };
}

describe('buildProductInputs warnings', () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-'));
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  it('warn quand aucun fichier data fourni', async () => {
    const r = await buildProductInputs([], workDir);
    expect(r.warnings.some((w) => /aucun fichier de donnees/i.test(w))).toBe(true);
  });

  it('warn quand aucun fichier d\'assets fourni', async () => {
    const file = mockXlsxFile(['Designation'], [{ Designation: 'Produit A' }]);
    const r = await buildProductInputs([file], workDir);
    expect(r.warnings.some((w) => /aucun fichier d'assets/i.test(w))).toBe(true);
  });

  it('warn quand fichier data sans lignes', async () => {
    const file = mockXlsxFile(['Designation'], []);
    const r = await buildProductInputs([file], workDir);
    expect(r.warnings.some((w) => /aucune ligne/i.test(w))).toBe(true);
  });

  it('warn quand pas de colonne nom matchee (fallback 1ere col)', async () => {
    const file = mockXlsxFile(['col_a', 'col_b'], [{ col_a: 'X', col_b: 'Y' }]);
    const r = await buildProductInputs([file], workDir);
    expect(r.warnings.some((w) => /aucune colonne de nom matchee/i.test(w))).toBe(true);
  });

  it('warn quand pas de colonne sku', async () => {
    const file = mockXlsxFile(['Designation'], [{ Designation: 'X' }]);
    const r = await buildProductInputs([file], workDir);
    expect(r.warnings.some((w) => /colonne ref\/SKU/i.test(w))).toBe(true);
  });

  it('warn quand pas de colonne famille', async () => {
    const file = mockXlsxFile(['Designation', 'Reference'], [{ Designation: 'X', Reference: '123' }]);
    const r = await buildProductInputs([file], workDir);
    expect(r.warnings.some((w) => /colonne famille/i.test(w))).toBe(true);
  });

  it('warn sur ref dupliquee', async () => {
    const file = mockXlsxFile(
      ['Designation', 'Reference'],
      [
        { Designation: 'A', Reference: '123' },
        { Designation: 'B', Reference: '123' }, // dup
      ],
    );
    const r = await buildProductInputs([file], workDir);
    expect(r.warnings.some((w) => /deja vue/i.test(w))).toBe(true);
  });

  it('lignes vides : fallback name "Produit N" applique sans warn 0-produit', async () => {
    // Le builder applique un fallback name quand Designation est vide. Le
    // warning "aucun produit construit" ne fire QUE si toutes les lignes
    // levent une exception. Ici on verifie le contrat de fallback.
    const file = mockXlsxFile(
      ['Designation'],
      [{ Designation: '' }, { Designation: '   ' }],
    );
    const r = await buildProductInputs([file], workDir);
    expect(r.products.length).toBeGreaterThanOrEqual(1);
  });

  it('fallback name = ref si name vide (mieux que "Produit N+1" generique)', async () => {
    const file = mockXlsxFile(
      ['Designation', 'Reference'],
      [
        { Designation: '', Reference: 'AB1234' },
        { Designation: '  ', Reference: 'CD5678' },
      ],
    );
    const r = await buildProductInputs([file], workDir);
    expect(r.products).toHaveLength(2);
    // Verifie que les noms sont des refs (pas "Produit 1"/"Produit 2")
    expect(r.products[0].name).toBe('AB1234');
    expect(r.products[1].name).toBe('CD5678');
  });

  it('warn pattern color_column_pattern invalide', async () => {
    const file = mockXlsxFile(['Designation'], [{ Designation: 'A' }]);
    const r = await buildProductInputs([file], workDir, {
      colorColumnPattern: '[invalid(regex',
    });
    expect(r.warnings.some((w) => /color_column_pattern invalide/i.test(w))).toBe(true);
  });

  it('warn quand aucune image matchee', async () => {
    const file = mockXlsxFile(
      ['Designation', 'Reference'],
      [
        { Designation: 'Produit A', Reference: '123' },
      ],
    );
    const r = await buildProductInputs([file], workDir);
    expect(r.products.length).toBe(1);
    expect(r.matchedImageCount).toBe(0);
  });
});

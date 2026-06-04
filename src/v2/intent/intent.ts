/**
 * IntentOp DSL — approche C : ops haut niveau lisibles, agnostiques des
 * coordonnees PDF. Le resolver les transforme en `Operation[]` bas niveau
 * compatibles avec le binaire C++ inchange.
 *
 * Format `plan_v2.json` :
 *   { pages: [{ sourcePage: 3, intents: [{op: 'replace_text', target: 'page_3.title', text: '...'}] }] }
 *
 * Le `target` est un selecteur lisible resolu par le resolver via le
 * PageSchema correspondant.
 */
import type { TargetSelector } from './schema';

export type IntentOp =
  | {
      op: 'replace_text';
      target: TargetSelector;
      text: string;
      /** Si true (defaut), reprend font/size/color du template. Sinon styles fournis. */
      preserve_style?: boolean;
    }
  | {
      op: 'swap_image';
      target: TargetSelector;
      image_path: string;
      fit?: 'contain' | 'cover';
    }
  | {
      op: 'update_spec';
      target: TargetSelector;  // ex 'page_3.specs_block.item_2'
      /** Nouveau libelle de la cle. Si absent, on garde le template. */
      key?: string;
      /** Nouvelle valeur. */
      value: string;
    }
  | {
      op: 'set_color';
      target: TargetSelector;
      color: string;  // hex
    }
  | {
      op: 'remove_element';
      target: TargetSelector;
    };

/** Plan haut niveau pour 1 page. */
export interface IntentPagePlan {
  sourcePage: number;
  intents: IntentOp[];
}

/** Format complet du plan_v2.json. */
export interface IntentPlan {
  version: '1';
  pages: IntentPagePlan[];
}

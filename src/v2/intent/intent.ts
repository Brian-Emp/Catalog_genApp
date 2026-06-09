/**
 * IntentOp DSL — approach C: high-level readable ops, agnostic to PDF
 * coordinates. The resolver transforms them into low-level `Operation[]`
 * compatible with the unchanged C++ binary.
 *
 * `plan_v2.json` format:
 *   { pages: [{ sourcePage: 3, intents: [{op: 'replace_text', target: 'page_3.title', text: '...'}] }] }
 *
 * The `target` is a readable selector resolved by the resolver via the
 * corresponding PageSchema.
 */
import type { TargetSelector } from './schema';

export type IntentOp =
  | {
      op: 'replace_text';
      target: TargetSelector;
      text: string;
      /** If true (default), reuses the template's font/size/color. Otherwise uses the provided styles. */
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
      target: TargetSelector;  // e.g. 'page_3.specs_block.item_2'
      /** New label for the key. If absent, we keep the template's. */
      key?: string;
      /** New value. */
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

/** High-level plan for 1 page. */
export interface IntentPagePlan {
  sourcePage: number;
  intents: IntentOp[];
}

/** Complete format of plan_v2.json. */
export interface IntentPlan {
  version: '1';
  pages: IntentPagePlan[];
}

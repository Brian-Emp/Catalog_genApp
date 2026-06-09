/**
 * Bbox utilities factored out (was duplicated across substitutor, tocFromTemplate, resolver).
 */
import type { Bbox } from '../types';

export function padBbox(bbox: Bbox, pad: number): Bbox {
  return [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
}

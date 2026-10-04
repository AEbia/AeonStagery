// Lens-filter source-param normalization: drop overrides that the active recipe category does not support.
import { getLensFilterCategory } from '../../../engine/visual-runtime/BuiltInVisualRecipeCatalog';
import type { TimelineScene } from '../semanticTimelineTypes';

export const LENS_FILTER_CATEGORY_LABELS: Record<string, string> = {
  grade: '色调基底',
  optics: '镜头质感',
  atmosphere: '空气氛围',
  texture: '画面纹理',
};

const FILTER_OVERRIDE_KEYS = ['warmth', 'bloom', 'rgbSplit', 'blend', 'contamination'] as const;

export function normalizeFilterSourceParams(
  sourceParams: Readonly<Record<string, unknown>>,
  sceneVisual: TimelineScene['visual'],
  recipeId: string,
): Record<string, unknown> {
  const nextParams: Record<string, unknown> = { ...sourceParams, recipeId };
  const category = getLensFilterCategory(sceneVisual, recipeId);
  const validKeys = new Set<string>(['intensity']);
  if (category === 'grade' || category === 'atmosphere') validKeys.add('warmth');
  if (category === 'optics' || category === 'atmosphere') validKeys.add('bloom');
  if (category === 'optics') validKeys.add('rgbSplit');
  if (category === 'atmosphere') {
    validKeys.add('blend');
    validKeys.add('contamination');
  }
  for (const key of FILTER_OVERRIDE_KEYS) {
    if (!validKeys.has(key)) delete nextParams[key];
  }
  return nextParams;
}

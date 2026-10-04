// Semantics/labels/option-list helpers for visual-style and lighting source params.
import type { CompositeSlot } from '../../../api/types/visual';
import type { TimelineScene } from '../semanticTimelineTypes';
import { listBuiltInCompositeRecipeIds, listSceneRecipeIds } from '../../../engine/visual-runtime/BuiltInVisualRecipeCatalog';

const COMPOSITE_VISUAL_SLOTS = ['grounding', 'integration', 'accent', 'distortion'] as const satisfies readonly CompositeSlot[];

function isCompositeVisualSlot(slot: string): slot is CompositeSlot {
  return COMPOSITE_VISUAL_SLOTS.includes(slot as CompositeSlot);
}

export function listVisualRecipeIds(
  sceneVisual: TimelineScene['visual'],
  scope: string,
  slot: string,
): string[] {
  if (scope === 'object' && isCompositeVisualSlot(slot)) {
    return [
      ...listBuiltInCompositeRecipeIds(slot),
      ...listSceneRecipeIds(sceneVisual, 'composite', slot),
    ];
  }
  return [];
}

export const visualSemanticDefaults: Record<string, number> = {
  intensity: 1,
  brightness: 0,
  warmth: 0,
  bloom: 0,
  rgbSplit: 0.45,
  blend: 0.3,
  contamination: 0.2,
};

export const VISUAL_STYLE_OVERRIDE_KEYS: Record<string, readonly string[]> = {
  grounding: ['intensity', 'blend', 'contamination', 'shadowDistance', 'shadowSoftness'],
  integration: ['intensity', 'brightness', 'warmth', 'blend', 'contamination', 'color', 'colorStops', 'colorBlendMode'],
  accent: ['intensity', 'warmth'],
  distortion: ['intensity', 'bloom', 'rgbSplit'],
};

const VISUAL_STYLE_OVERRIDE_LABELS: Record<string, string> = {
  intensity: '强度',
  brightness: '亮度',
  warmth: '冷暖',
  bloom: 'Bloom',
  rgbSplit: '色差',
  blend: '融入度',
  contamination: '环境染色',
  color: '颜色',
  colorStops: '颜色组',
  colorBlendMode: '混合模式',
  shadowDistance: '阴影距离',
  shadowSoftness: '阴影柔和度',
};

const VISUAL_STYLE_OVERRIDE_SLOT_LABELS: Record<string, Readonly<Record<string, string>>> = {
  grounding: {
    blend: '阴影延展',
    contamination: '边缘柔和度',
  },
  integration: {
    blend: '融入度',
    contamination: '环境染色',
  },
};

export function getVisualStyleOverrideLabel(slot: string, key: string): string {
  return VISUAL_STYLE_OVERRIDE_SLOT_LABELS[slot]?.[key]
    || VISUAL_STYLE_OVERRIDE_LABELS[key]
    || key;
}

export function getVisualStyleOverrideConfig(key: string): { min?: string; max?: string; popoverMin?: string; popoverMax?: string; step?: string } {
  switch (key) {
    case 'blend':
    case 'contamination':
      return { min: '0', max: '1', step: '0.05' };
    case 'brightness':
    case 'warmth':
      return { min: '-1', max: '1', step: '0.05' };
    case 'shadowDistance':
      return { min: '0', popoverMin: '0', popoverMax: '100', step: '1' };
    case 'shadowSoftness':
      return { min: '0', popoverMin: '0', popoverMax: '50', step: '1' };
    case 'intensity':
    case 'bloom':
      return { min: '0', popoverMin: '0', popoverMax: '2', step: '0.05' };
    case 'rgbSplit':
      return { min: '0', popoverMin: '0', popoverMax: '20', step: '0.5' };
    default:
      return { step: '0.05' };
  }
}

export function getVisualStyleSemanticLabel(params: Readonly<Record<string, unknown>>): string {
  const mode = String(params.mode || 'set');
  const slot = String(params.slot || 'integration');
  const baseLabel = ({
    grounding: '角色明暗融入',
    integration: '角色色彩融入',
    accent: '角色风格强调',
    distortion: '角色异化',
    'rim-light': '角色轮廓光',
  } as Record<string, string>)[slot] || '角色融入';
  if (mode === 'reset') return `重置${baseLabel}`;
  if (mode === 'modulate') return `变化${baseLabel}`;
  return baseLabel;
}

export function getLightingSemanticLabel(params: Readonly<Record<string, unknown>>): string {
  const effect = String(params.effect || 'preset');
  const mode = String(params.mode || 'set');
  const baseLabel = ({
    preset: '光照预设',
    blur: '模糊',
    godrays: '体积光',
    post: '后期处理',
    overlay: '色彩叠加',
    pointLight: '点光源',
  } as Record<string, string>)[effect] || '光照';
  if (mode === 'reset') return `重置${baseLabel}`;
  if (mode === 'remove') return `移除${baseLabel}`;
  if (mode === 'clear') return `清除全部${baseLabel}`;
  if (mode === 'modulate') return `变化${baseLabel}`;
  if (effect === 'overlay' || effect === 'pointLight') return `添加${baseLabel}`;
  return `设置${baseLabel}`;
}

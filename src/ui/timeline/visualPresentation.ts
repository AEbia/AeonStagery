import type { CompositeSlot, LensStyleSlot, RecipeId, SceneVisualBlock } from '../../api/types/visual';

const LENS_SLOT_LABELS: Record<LensStyleSlot, string> = {
  grade: '色调基底',
  optics: '镜头质感',
  atmosphere: '空气氛围',
  texture: '画面纹理',
};

const COMPOSITE_SLOT_LABELS: Record<CompositeSlot, string> = {
  grounding: '贴地关系',
  integration: '环境融入',
  accent: '风格强调',
  distortion: '异化形变',
};

const RECIPE_LABELS: Record<string, string> = {
  'builtin:default-grade': '默认色调',
  'builtin:cinematic-grade': '电影感提色',
  'builtin:cinematic-cold': '冷调电影感',
  'builtin:grade-a': '轻微提色',
  'builtin:grade-b': '冷灰层次',
  'builtin:soft-bloom-rgb': '柔光色差',
  'builtin:haze-godray': '雾光空气',
  'builtin:film-grain': '胶片颗粒',
  'builtin:ground-shadow-soft': '软阴影贴地',
  'builtin:default-integration': '默认融入',
  'builtin:integration-soft': '柔和融入',
  'builtin:integration-soft-warm': '暖调融入',
  'builtin:integration-soft-cool': '冷调融入',
  'builtin:accent-pop': '主体提神',
  'builtin:rgb-blur': '色差虚化',
};

export type VisualTier = 'wheelchair' | 'advanced' | 'custom';

export const VISUAL_TIER_LABELS: Record<VisualTier, string> = {
  wheelchair: '轮椅阶 · 角色融入',
  advanced: '进阶级 · 镜头与氛围',
  custom: '自定义级 · 专业光影',
};

export const VISUAL_TIER_DESCRIPTIONS: Record<VisualTier, string> = {
  wheelchair: '零配置即开即用，一键实现角色融入背景、轮廓边光与贴地软阴影',
  advanced: '环境色彩叠加（正片叠底/滤色）与景深虚化',
  custom: '空间自由定位点光源、底层 Bloom/色差/调色着色器深度控制',
};

export function getLensSlotLabel(slot: LensStyleSlot): string {
  return LENS_SLOT_LABELS[slot];
}

export function getCompositeSlotLabel(slot: CompositeSlot): string {
  return COMPOSITE_SLOT_LABELS[slot];
}

export function getVisualModeLabel(mode: string): string {
  switch (mode) {
    case 'latching':
      return '持续生效';
    case 'envelope':
      return '渐入渐出';
    default:
      return mode;
  }
}

export function getRecipeDisplayLabel(sceneVisual: SceneVisualBlock | undefined, recipeId: RecipeId): string {
  const overlayLabel = sceneVisual?.recipeOverlay?.[recipeId]?.label?.trim();
  if (overlayLabel) return overlayLabel;
  return RECIPE_LABELS[recipeId] || recipeId;
}

import type { StatementFamily } from '../../api/types/semantic-scene';
import type { SceneVisualBlock } from '../../api/types/visual';
import {
  DEFAULT_AUDIO_BGM_FADE_IN_SECONDS,
  DEFAULT_AUDIO_STOP_FADE_OUT_SECONDS,
  DEFAULT_CHARACTER_ENTER_TRANSITION,
  DEFAULT_CHARACTER_EXIT_TRANSITION,
  DEFAULT_CHARACTER_PRESENCE_TRANSITION_SECONDS,
  DEFAULT_ENVIRONMENT_REMOVE_DURATION_SECONDS,
  DEFAULT_ENVIRONMENT_REMOVE_TRANSITION,
  DEFAULT_ENVIRONMENT_SET_DURATION_SECONDS,
  DEFAULT_ENVIRONMENT_SET_TRANSITION,
  DEFAULT_ENVIRONMENT_TRANSFORM_DURATION_SECONDS,
} from '../../services/semantic-scene';
import { getLensFilterCategory } from '../../engine/visual-runtime/BuiltInVisualRecipeCatalog';
import { getDefaultDialogueDurationSeconds } from '../SettingsStore';
import { resolveDialogueDuration } from '../../services/pacing/pacing';

export type SemanticInspectorFieldVisibility = 'authoring' | 'advanced';
export type SemanticInspectorFieldSurface = 'generic' | 'semantic' | 'nested';
export type SemanticInspectorFieldValueType = 'boolean' | 'number' | 'string';

export type SemanticInspectorFieldDefault = (
  params: Readonly<Record<string, unknown>>,
  sceneVisual?: SceneVisualBlock,
) => unknown;

export interface SemanticInspectorField {
  readonly key: string;
  readonly label: string;
  readonly visibility: SemanticInspectorFieldVisibility;
  readonly surface?: SemanticInspectorFieldSurface;
  readonly valueType?: SemanticInspectorFieldValueType;
  readonly min?: string;
  readonly max?: string;
  readonly popoverMin?: string;
  readonly popoverMax?: string;
  readonly step?: string;
  readonly when?: (params: Readonly<Record<string, unknown>>, sceneVisual?: SceneVisualBlock) => boolean;
  readonly defaultValue?: SemanticInspectorFieldDefault;
}

type SemanticInspectorFieldOptions = {
  readonly visibility?: SemanticInspectorFieldVisibility;
  readonly surface?: SemanticInspectorFieldSurface;
  readonly valueType?: SemanticInspectorFieldValueType;
  readonly min?: string;
  readonly max?: string;
  readonly popoverMin?: string;
  readonly popoverMax?: string;
  readonly step?: string;
  readonly when?: (params: Readonly<Record<string, unknown>>, sceneVisual?: SceneVisualBlock) => boolean;
  readonly defaultValue?: SemanticInspectorFieldDefault;
};

export type SemanticInspectorFieldCatalog = Readonly<{
  readonly [Family in StatementFamily]: readonly SemanticInspectorField[];
}>;

function field(
  key: string,
  label: string,
  options: SemanticInspectorFieldOptions = {},
): SemanticInspectorField {
  return {
    ...options,
    key,
    label,
    visibility: options.visibility ?? 'authoring',
    surface: options.surface ?? 'generic',
  };
}

function inspectorDefault(value: unknown): SemanticInspectorFieldDefault {
  return () => value;
}

function hasOwn(params: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(params, key);
}

function modeIs(mode: string): (params: Readonly<Record<string, unknown>>) => boolean {
  return (params) => params.mode === mode;
}

function modeIsOneOf(...modes: string[]): (params: Readonly<Record<string, unknown>>) => boolean {
  return (params) => modes.includes(String(params.mode));
}

function roleIs(role: string, mode?: string): (params: Readonly<Record<string, unknown>>) => boolean {
  return (params) => params.role === role && (mode === undefined || params.mode === mode);
}

function scopeIs(scope: string): (params: Readonly<Record<string, unknown>>) => boolean {
  return (params) => params.scope === scope;
}

function filterCategory(
  params: Readonly<Record<string, unknown>>,
  sceneVisual?: SceneVisualBlock,
): string | undefined {
  if (typeof params.category === 'string') return params.category;
  const recipeId = typeof params.recipeId === 'string' ? params.recipeId : undefined;
  return getLensFilterCategory(sceneVisual, recipeId) ?? undefined;
}

function filterCategoryIs(...categories: string[]) {
  return (
    params: Readonly<Record<string, unknown>>,
    sceneVisual?: SceneVisualBlock,
  ): boolean => categories.includes(filterCategory(params, sceneVisual) ?? '');
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneValue(item)]),
    ) as T;
  }
  return value;
}

function environmentImageField(params: Readonly<Record<string, unknown>>): boolean {
  return hasOwn(params, 'image') || (
    params.mode === 'set' && !hasOwn(params, 'file') && !hasOwn(params, 'image')
  );
}

function customAnimationResourceField(key: string) {
  return (params: Readonly<Record<string, unknown>>) => (
    hasOwn(params, key) || (!hasOwn(params, 'file') && !hasOwn(params, 'animation') && key === 'animation')
  );
}

function defaultCameraFocusPosition(params: Readonly<Record<string, unknown>>): unknown {
  return hasOwn(params, 'target') ? undefined : [0.5, 0.5];
}

function defaultCameraZoom(params: Readonly<Record<string, unknown>>): unknown {
  return params.mode === 'focus' ? { kind: 'absolute', value: 1.08 } : undefined;
}

function defaultVisualRecipe(params: Readonly<Record<string, unknown>>): unknown {
  if (params.mode !== 'set') return undefined;
  if (params.scope === 'object' && params.slot === 'grounding') return 'builtin:ground-shadow-soft';
  if (params.scope === 'object' && params.slot === 'integration') return 'builtin:integration-soft';
  return undefined;
}

function isRimLightVisualStyle(params: Readonly<Record<string, unknown>>): boolean {
  return params.scope === 'object' && params.slot === 'rim-light';
}

function defaultVisualNumber(key: string, params: Readonly<Record<string, unknown>>): unknown {
  if (isRimLightVisualStyle(params) && params.mode === 'set') {
    return {
      intensity: 1,
      durationSeconds: 0,
    }[key];
  }
  if (isRimLightVisualStyle(params) && params.mode === 'modulate') {
    return {
      intensity: 1,
      durationSeconds: 1,
    }[key];
  }
  if (params.scope === 'object' && params.slot === 'grounding' && params.mode === 'set') {
    return {
      intensity: 0.95,
      blend: 0.52,
      contamination: 0.34,
    }[key];
  }
  if (params.scope === 'object' && params.slot === 'integration' && params.mode === 'set') {
    return {
      intensity: 0.8,
      brightness: 0,
      blend: 0.36,
      contamination: 0.18,
      warmth: 0,
    }[key];
  }
  if (params.mode === 'modulate' && key === 'brightness') return 0;
  if (params.mode === 'modulate' && ['intensity', 'durationSeconds'].includes(key)) return 1;
  if (params.mode === 'set' && key === 'durationSeconds') return 0;
  if (params.mode === 'reset' && key === 'durationSeconds') return 0.4;
  return undefined;
}

function defaultLightingDuration(params: Readonly<Record<string, unknown>>): unknown {
  if (params.mode === 'modulate') return 1;
  if (params.mode === 'reset' || params.mode === 'remove') return 0.4;
  if (params.mode === 'clear') return 0.4;
  if (params.mode === 'set') return 0.5;
  return undefined;
}

function lightingValueMode(params: Readonly<Record<string, unknown>>): boolean {
  return params.mode === 'set' || params.mode === 'modulate';
}

function lightingResettableMode(params: Readonly<Record<string, unknown>>): boolean {
  return params.mode === 'set' || params.mode === 'modulate' || params.mode === 'reset';
}

function visualStyleValueMode(params: Readonly<Record<string, unknown>>): boolean {
  return params.mode === 'set' || params.mode === 'modulate';
}

function visualStyleNonRimLightValueMode(params: Readonly<Record<string, unknown>>): boolean {
  return visualStyleValueMode(params) && !isRimLightVisualStyle(params);
}

function visualStyleSlotModeIs(scope: string, slots: readonly string[], modes: readonly string[] = ['set', 'modulate']) {
  return (params: Readonly<Record<string, unknown>>): boolean => (
    params.scope === scope
    && slots.includes(String(params.slot))
    && modes.includes(String(params.mode))
  );
}

function lightingEffectModeIs(effect: string, modes: readonly string[] = ['set', 'modulate']) {
  return (params: Readonly<Record<string, unknown>>): boolean => (
    params.effect === effect && modes.includes(String(params.mode))
  );
}

function defaultRimLightValue(key: string, params: Readonly<Record<string, unknown>>): unknown {
  if (!isRimLightVisualStyle(params) || !visualStyleValueMode(params)) return undefined;
  return {
    color: '#ffffff',
    intensity: 1,
    thickness: 10,
    angle: 45,
    softness: 2,
  }[key];
}

export const SEMANTIC_INSPECTOR_FIELD_CATALOG: SemanticInspectorFieldCatalog = {
  dialogue: [
    field('speakerId', '绑定角色'),
    field('text', '对话文本', { defaultValue: inspectorDefault('新对白') }),
    field('durationSeconds', '时长', {
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '10',
      step: '0.1',
      defaultValue: () => resolveDialogueDuration({
        context: 'manual-default',
        defaultDurationSeconds: getDefaultDialogueDurationSeconds(),
      }),
    }),
    field('voice', '语音文件'),
    field('style', '字幕样式'),
    field('textColor', '文本颜色'),
    field('lipSync', '口型同步'),
  ],
  characterPresence: [
    field('mode', '在场操作', { visibility: 'authoring', surface: 'semantic' }),
    field('id', '绑定角色'),
    field('model', '模型文件', { when: modeIs('enter') }),
    field('variant', '模型变体', { visibility: 'advanced', when: modeIs('enter') }),
    field('position', '空间坐标', {
      when: modeIs('enter'),
      defaultValue: (params) => params.mode === 'enter' ? [0.5, 1] : undefined,
    }),
    field('scale', '缩放比例', {
      valueType: 'number',
      min: '0.05',
      popoverMin: '0.1',
      popoverMax: '3',
      step: '0.05',
      when: modeIs('enter'),
      defaultValue: (params) => params.mode === 'enter' ? 1 : undefined,
    }),
    field('rotation', '旋转角度', {
      valueType: 'number',
      popoverMin: '-180',
      popoverMax: '180',
      step: '1',
      when: modeIs('enter'),
    }),
    field('opacity', '不透明度', {
      valueType: 'number',
      min: '0',
      max: '1',
      step: '0.05',
      when: modeIs('enter'),
    }),
    field('z', '深度 (Z)', {
      valueType: 'number',
      popoverMin: '-100',
      popoverMax: '100',
      step: '10',
      when: modeIs('enter'),
    }),
    field('transition', '切换效果', {
      when: modeIsOneOf('enter', 'exit'),
      defaultValue: (params) => params.mode === 'enter'
        ? DEFAULT_CHARACTER_ENTER_TRANSITION
        : params.mode === 'exit'
          ? DEFAULT_CHARACTER_EXIT_TRANSITION
          : undefined,
    }),
    field('durationSeconds', '时长', {
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '5',
      step: '0.1',
      when: modeIsOneOf('enter', 'exit'),
      defaultValue: (params) => params.mode === 'enter' || params.mode === 'exit'
        ? DEFAULT_CHARACTER_PRESENCE_TRANSITION_SECONDS
        : undefined,
    }),
    field('ease', '缓动曲线', { when: modeIsOneOf('enter', 'exit') }),
  ],
  characterTransform: [
    field('id', '绑定角色'),
    field('position', '空间坐标', { defaultValue: inspectorDefault([0.5, 1]) }),
    field('scale', '缩放比例', {
      valueType: 'number',
      min: '0.05',
      popoverMin: '0.1',
      popoverMax: '3',
      step: '0.05',
      defaultValue: inspectorDefault(1),
    }),
    field('rotation', '旋转角度', {
      valueType: 'number',
      popoverMin: '-180',
      popoverMax: '180',
      step: '1',
    }),
    field('opacity', '不透明度', {
      valueType: 'number',
      min: '0',
      max: '1',
      step: '0.05',
    }),
    field('z', '深度 (Z)', {
      valueType: 'number',
      popoverMin: '-100',
      popoverMax: '100',
      step: '10',
    }),
    field('durationSeconds', '时长', {
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '5',
      step: '0.1',
      defaultValue: inspectorDefault(1),
    }),
    field('ease', '缓动曲线', { defaultValue: inspectorDefault('smooth') }),
  ],
  characterPerformance: [
    field('target', '绑定角色'),
    field('motion', '动作名', {
      when: (params) => (!params.lookAt && !params.blink) || Boolean(params.motion) || Boolean(params.expression),
    }),
    field('expression', '表情名', {
      when: (params) => (!params.lookAt && !params.blink) || Boolean(params.motion) || Boolean(params.expression),
    }),
    field('lookAt', '视线控制', {
      surface: 'nested',
      when: (params) => Boolean(params.lookAt),
    }),
    field('blink', '眨眼控制', {
      surface: 'nested',
      when: (params) => Boolean(params.blink),
    }),
  ],
  camera: [
    field('mode', '镜头模式', { surface: 'semantic' }),
    field('target', '目标角色', { surface: 'semantic', when: (params) => ['focus', 'follow', 'hitchcock'].includes(String(params.mode)) }),
    field('targetPart', '对焦部位', { surface: 'semantic', when: (params) => ['focus', 'hitchcock'].includes(String(params.mode)) }),
    field('position', '空间坐标', {
      when: (params) => params.mode === 'focus',
      defaultValue: defaultCameraFocusPosition,
    }),
    field('to', '移动终点（标准化坐标）', { when: modeIs('move') }),
    field('zoom', '镜头缩放', {
      surface: 'semantic',
      valueType: 'number',
      min: '0.1',
      popoverMin: '0.5',
      popoverMax: '3',
      step: '0.05',
      when: modeIs('focus'),
      defaultValue: defaultCameraZoom,
    }),
    field('zoom', '终点变焦', {
      surface: 'semantic',
      valueType: 'number',
      min: '0.1',
      popoverMin: '0.5',
      popoverMax: '3',
      step: '0.05',
      when: modeIs('move'),
    }),
    field('rotation', '终点旋转', {
      valueType: 'number',
      popoverMin: '-180',
      popoverMax: '180',
      step: '1',
      when: (params) => ['focus', 'move'].includes(String(params.mode)),
    }),
    field('operation', '跟随操作', { surface: 'semantic', when: modeIs('follow') }),
    field('offset', '跟随偏移（标准化坐标）', { when: modeIs('follow') }),
    field('smoothing', '平滑度', {
      valueType: 'number',
      min: '0',
      max: '1',
      step: '0.05',
      when: modeIs('follow'),
    }),
    field('keyframes', '关键帧', { surface: 'nested', when: modeIs('path') }),
    field('intensity', '强度', {
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '1',
      step: '0.05',
      when: modeIs('shake'),
      defaultValue: inspectorDefault(0.2),
    }),
    field('frequency', '频率', {
      valueType: 'number',
      min: '1',
      popoverMin: '1',
      popoverMax: '60',
      step: '1',
      when: modeIs('shake'),
      defaultValue: inspectorDefault(18),
    }),
    field('decay', '衰减', { when: modeIs('shake'), defaultValue: inspectorDefault(true) }),
    field('direction', '震动方向', { when: modeIs('shake'), defaultValue: inspectorDefault('both') }),
    field('screenTarget', '屏幕目标（标准化坐标）', { when: modeIs('hitchcock') }),
    field('zoomStart', '起始变焦', {
      valueType: 'number',
      min: '0.1',
      popoverMin: '0.5',
      popoverMax: '3',
      step: '0.05',
      when: modeIs('hitchcock'),
    }),
    field('zoomEnd', '结束变焦', {
      valueType: 'number',
      min: '0.1',
      popoverMin: '0.5',
      popoverMax: '3',
      step: '0.05',
      when: modeIs('hitchcock'),
    }),
    field('scaleStart', '起始缩放', {
      valueType: 'number',
      min: '0.1',
      popoverMin: '0.5',
      popoverMax: '3',
      step: '0.05',
      when: modeIs('hitchcock'),
    }),
    field('scaleEnd', '结束缩放', {
      valueType: 'number',
      min: '0.1',
      popoverMin: '0.5',
      popoverMax: '3',
      step: '0.05',
      when: modeIs('hitchcock'),
    }),
    field('durationSeconds', '时长', {
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '10',
      step: '0.1',
      when: (params) => ['focus', 'move', 'path', 'shake', 'hitchcock', 'reset'].includes(String(params.mode)),
      defaultValue: (params) => params.mode === 'shake' ? 0.6 : params.mode === 'reset' ? 0.5 : ['focus', 'move'].includes(String(params.mode)) ? 1 : undefined,
    }),
    field('ease', '缓动曲线', {
      when: (params) => ['focus', 'move', 'path', 'hitchcock', 'reset'].includes(String(params.mode)),
      defaultValue: (params) => ['focus', 'move', 'reset'].includes(String(params.mode)) ? 'smooth' : undefined,
    }),
    field('repeat', '重复次数', {
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '10',
      step: '1',
      when: modeIs('path'),
    }),
    field('loop', '循环播放', { when: modeIs('path') }),
    field('yoyo', '往返播放', { when: modeIs('path') }),
  ],
  environmentLayer: [
    field('mode', '图层操作', { surface: 'semantic' }),
    field('layerId', '环境层名称', { surface: 'semantic', defaultValue: inspectorDefault('background') }),
    field('file', '资源路径', { when: (params) => params.mode === 'set' && hasOwn(params, 'file') }),
    field('image', '背景图片', { when: (params) => params.mode === 'set' && environmentImageField(params) }),
    field('position', '空间坐标', { when: modeIsOneOf('set', 'transform'), defaultValue: (params) => params.mode === 'transform' ? [0.5, 0.5] : undefined }),
    field('scale', '缩放比例', {
      valueType: 'number',
      min: '0.05',
      popoverMin: '0.1',
      popoverMax: '3',
      step: '0.05',
      when: modeIsOneOf('set', 'transform'),
      defaultValue: (params) => params.mode === 'transform' ? 1 : undefined,
    }),
    field('rotation', '旋转角度', {
      valueType: 'number',
      popoverMin: '-180',
      popoverMax: '180',
      step: '1',
      when: modeIsOneOf('set', 'transform'),
    }),
    field('opacity', '不透明度', {
      valueType: 'number',
      min: '0',
      max: '1',
      step: '0.05',
      when: modeIsOneOf('set', 'transform'),
      defaultValue: (params) => params.mode === 'transform' ? 1 : undefined,
    }),
    field('z', '深度 (Z)', {
      valueType: 'number',
      popoverMin: '-100',
      popoverMax: '100',
      step: '10',
      when: modeIsOneOf('set', 'transform'),
    }),
    field('durationSeconds', '时长', {
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '5',
      step: '0.1',
      when: modeIsOneOf('set', 'transform', 'remove'),
      defaultValue: (params) => params.mode === 'set'
        ? DEFAULT_ENVIRONMENT_SET_DURATION_SECONDS
        : params.mode === 'transform'
          ? DEFAULT_ENVIRONMENT_TRANSFORM_DURATION_SECONDS
          : params.mode === 'remove'
            ? DEFAULT_ENVIRONMENT_REMOVE_DURATION_SECONDS
            : undefined,
    }),
    field('ease', '缓动曲线', { when: modeIsOneOf('set', 'transform'), defaultValue: (params) => params.mode === 'transform' ? 'smooth' : undefined }),
    field('transition', '切换效果', {
      when: modeIsOneOf('set', 'remove'),
      defaultValue: (params) => params.mode === 'set'
        ? DEFAULT_ENVIRONMENT_SET_TRANSITION
        : params.mode === 'remove'
          ? DEFAULT_ENVIRONMENT_REMOVE_TRANSITION
          : undefined,
    }),
  ],
  visualStyle: [
    field('scope', '作用范围', { surface: 'semantic' }),
    field('target', '目标对象', { surface: 'semantic', when: scopeIs('object') }),
    field('slot', '效果槽位', { surface: 'semantic' }),
    field('mode', '状态模式', { surface: 'semantic' }),
    field('recipeId', '风格配方', { when: (params) => params.mode === 'set' && !isRimLightVisualStyle(params), defaultValue: defaultVisualRecipe }),
    field('intensity', '强度', {
      when: visualStyleSlotModeIs('object', ['grounding', 'integration', 'accent', 'distortion', 'rim-light']),
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '2',
      step: '0.05',
      defaultValue: (params) => defaultRimLightValue('intensity', params) ?? defaultVisualNumber('intensity', params),
    }),
    field('brightness', '亮度', {
      when: visualStyleSlotModeIs('object', ['integration']),
      valueType: 'number',
      min: '-1',
      max: '1',
      step: '0.05',
      defaultValue: (params) => defaultVisualNumber('brightness', params),
    }),
    field('warmth', '冷暖', {
      when: visualStyleSlotModeIs('object', ['integration', 'accent']),
      valueType: 'number',
      min: '-1',
      max: '1',
      step: '0.05',
      defaultValue: (params) => defaultVisualNumber('warmth', params),
    }),
    field('blend', '阴影延展', {
      when: visualStyleSlotModeIs('object', ['grounding']),
      valueType: 'number',
      min: '0',
      max: '1',
      step: '0.05',
      defaultValue: (params) => defaultVisualNumber('blend', params),
    }),
    field('blend', '融入度', {
      when: visualStyleSlotModeIs('object', ['integration']),
      valueType: 'number',
      min: '0',
      max: '1',
      step: '0.05',
      defaultValue: (params) => defaultVisualNumber('blend', params),
    }),
    field('contamination', '边缘柔和度', {
      when: visualStyleSlotModeIs('object', ['grounding']),
      valueType: 'number',
      min: '0',
      max: '1',
      step: '0.05',
      defaultValue: (params) => defaultVisualNumber('contamination', params),
    }),
    field('contamination', '环境染色', {
      when: visualStyleSlotModeIs('object', ['integration']),
      valueType: 'number',
      min: '0',
      max: '1',
      step: '0.05',
      defaultValue: (params) => defaultVisualNumber('contamination', params),
    }),
    field('bloom', 'Bloom', {
      when: visualStyleSlotModeIs('object', ['distortion']),
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '3',
      step: '0.05',
      defaultValue: (params) => defaultVisualNumber('bloom', params),
    }),
    field('rgbSplit', '色差', {
      when: visualStyleSlotModeIs('object', ['distortion']),
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '5',
      step: '0.05',
      defaultValue: (params) => defaultVisualNumber('rgbSplit', params),
    }),
    field('shadowDistance', '阴影距离', {
      when: visualStyleSlotModeIs('object', ['grounding']),
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '100',
      step: '1',
    }),
    field('shadowSoftness', '阴影柔和度', {
      when: visualStyleSlotModeIs('object', ['grounding']),
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '50',
      step: '1',
    }),
    field('colorStops', '颜色组', { when: visualStyleSlotModeIs('object', ['integration']) }),
    field('colorBlendMode', '混合模式', { when: visualStyleSlotModeIs('object', ['integration']), defaultValue: (params) => params.mode === 'set' ? 'multiply' : undefined }),
    field('color', '颜色', { when: visualStyleSlotModeIs('object', ['integration', 'rim-light']), defaultValue: (params) => defaultRimLightValue('color', params) }),
    field('thickness', '厚度', {
      when: visualStyleSlotModeIs('object', ['rim-light']),
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '50',
      step: '1',
      defaultValue: (params) => defaultRimLightValue('thickness', params),
    }),
    field('angle', '角度', {
      when: visualStyleSlotModeIs('object', ['rim-light']),
      valueType: 'number',
      min: '0',
      max: '360',
      step: '1',
      defaultValue: (params) => defaultRimLightValue('angle', params),
    }),
    field('softness', '边缘柔和度', {
      when: visualStyleSlotModeIs('object', ['rim-light']),
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '20',
      step: '0.5',
      defaultValue: (params) => defaultRimLightValue('softness', params),
    }),
    field('semanticOverride', '风格微调', { surface: 'nested', when: visualStyleNonRimLightValueMode }),
    field('advancedOverride', '高级参数', { visibility: 'advanced', when: visualStyleNonRimLightValueMode }),
    field('durationSeconds', '过渡时长', {
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '5',
      step: '0.1',
      when: modeIsOneOf('set', 'modulate', 'reset'),
      defaultValue: (params) => defaultVisualNumber('durationSeconds', params),
    }),
  ],
  filterAdd: [
    field('recipeId', '滤镜模板', { surface: 'semantic' }),
    field('intensity', '后期强度', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '2', step: '0.05', defaultValue: inspectorDefault(1) }),
    field('warmth', '冷暖', { valueType: 'number', min: '-1', max: '1', step: '0.05', when: filterCategoryIs('grade', 'atmosphere'), defaultValue: inspectorDefault(0) }),
    field('bloom', 'Bloom', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '3', step: '0.05', when: filterCategoryIs('optics', 'atmosphere'), defaultValue: inspectorDefault(0) }),
    field('rgbSplit', '色差', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '5', step: '0.05', when: filterCategoryIs('optics'), defaultValue: inspectorDefault(0) }),
    field('blend', '空气感', { valueType: 'number', min: '0', max: '1', step: '0.05', when: filterCategoryIs('atmosphere'), defaultValue: inspectorDefault(0) }),
    field('contamination', '介质感', { valueType: 'number', min: '0', max: '1', step: '0.05', when: filterCategoryIs('atmosphere'), defaultValue: inspectorDefault(0) }),
    field('durationSeconds', '过渡时长', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '5', step: '0.1', defaultValue: inspectorDefault(0.6) }),
  ],
  filterChange: [
    field('fromRecipeId', '当前滤镜', { surface: 'semantic' }),
    field('recipeId', '滤镜模板', { surface: 'semantic' }),
    field('intensity', '后期强度', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '2', step: '0.05', defaultValue: inspectorDefault(1) }),
    field('warmth', '冷暖', { valueType: 'number', min: '-1', max: '1', step: '0.05', when: filterCategoryIs('grade', 'atmosphere'), defaultValue: inspectorDefault(0) }),
    field('bloom', 'Bloom', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '3', step: '0.05', when: filterCategoryIs('optics', 'atmosphere'), defaultValue: inspectorDefault(0) }),
    field('rgbSplit', '色差', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '5', step: '0.05', when: filterCategoryIs('optics'), defaultValue: inspectorDefault(0) }),
    field('blend', '空气感', { valueType: 'number', min: '0', max: '1', step: '0.05', when: filterCategoryIs('atmosphere'), defaultValue: inspectorDefault(0) }),
    field('contamination', '介质感', { valueType: 'number', min: '0', max: '1', step: '0.05', when: filterCategoryIs('atmosphere'), defaultValue: inspectorDefault(0) }),
    field('durationSeconds', '过渡时长', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '5', step: '0.1', defaultValue: inspectorDefault(0.6) }),
  ],
  filterReset: [
    field('durationSeconds', '过渡时长', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '5', step: '0.1', defaultValue: inspectorDefault(0.4) }),
  ],
  lighting: [
    field('effect', '效果', { surface: 'semantic' }),
    field('mode', '生命周期', { surface: 'semantic' }),
    field('id', '对象 ID', { surface: 'semantic', when: (params) => ['overlay', 'pointLight'].includes(String(params.effect)) && params.mode !== 'clear' }),
    field('target', '作用目标', {
      surface: 'semantic',
      when: (params) => ['blur', 'post'].includes(String(params.effect)) && lightingResettableMode(params),
      defaultValue: (params) => params.effect === 'post' ? 'panorama' : 'global',
    }),
    field('preset', '光照预设', { when: (params) => params.effect === 'preset' && lightingValueMode(params), defaultValue: (params) => params.mode === 'set' ? 'warm' : undefined }),
    field('intensity', '强度', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '2', step: '0.05', when: (params) => ['preset', 'blur', 'godrays', 'overlay', 'pointLight'].includes(String(params.effect)) && lightingValueMode(params), defaultValue: inspectorDefault(1) }),
    field('angle', '角度', { valueType: 'number', min: '0', max: '360', step: '1', when: lightingEffectModeIs('godrays'), defaultValue: inspectorDefault(30) }),
    field('lacunarity', 'Lacunarity', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '10', step: '0.1', when: lightingEffectModeIs('godrays'), defaultValue: inspectorDefault(2) }),
    field('color', '颜色', { when: (params) => ['overlay', 'pointLight'].includes(String(params.effect)) && lightingValueMode(params) }),
    field('blendMode', '混合模式', { when: lightingEffectModeIs('overlay'), defaultValue: inspectorDefault('multiply') }),
    field('x', 'X', { valueType: 'number', min: '0', max: '1', step: '0.01', when: lightingEffectModeIs('pointLight'), defaultValue: inspectorDefault(0.5) }),
    field('y', 'Y', { valueType: 'number', min: '0', max: '1', step: '0.01', when: lightingEffectModeIs('pointLight'), defaultValue: inspectorDefault(0.5) }),
    field('radius', '半径', { valueType: 'number', min: '10', popoverMin: '10', popoverMax: '1000', step: '10', when: lightingEffectModeIs('pointLight'), defaultValue: inspectorDefault(240) }),
    field('adjBrightness', '亮度', { valueType: 'number', popoverMin: '0', popoverMax: '2', step: '0.01', when: lightingEffectModeIs('post'), defaultValue: inspectorDefault(1) }),
    field('adjContrast', '对比度', { valueType: 'number', popoverMin: '0', popoverMax: '2', step: '0.01', when: lightingEffectModeIs('post'), defaultValue: inspectorDefault(1) }),
    field('adjSaturation', '饱和度', { valueType: 'number', popoverMin: '0', popoverMax: '2', step: '0.01', when: lightingEffectModeIs('post'), defaultValue: inspectorDefault(1) }),
    field('adjGamma', 'Gamma', { valueType: 'number', min: '0.1', popoverMin: '0.1', popoverMax: '1.9', step: '0.01', when: lightingEffectModeIs('post'), defaultValue: inspectorDefault(1) }),
    field('adjRed', '红色通道', { valueType: 'number', popoverMin: '0', popoverMax: '2', step: '0.01', when: lightingEffectModeIs('post'), defaultValue: inspectorDefault(1) }),
    field('adjGreen', '绿色通道', { valueType: 'number', popoverMin: '0', popoverMax: '2', step: '0.01', when: lightingEffectModeIs('post'), defaultValue: inspectorDefault(1) }),
    field('adjBlue', '蓝色通道', { valueType: 'number', popoverMin: '0', popoverMax: '2', step: '0.01', when: lightingEffectModeIs('post'), defaultValue: inspectorDefault(1) }),
    field('overlayColor', '后期叠加颜色', { when: lightingEffectModeIs('post'), defaultValue: inspectorDefault('#ffffff') }),
    field('overlayBlendMode', '后期叠加模式', { when: lightingEffectModeIs('post'), defaultValue: inspectorDefault('multiply') }),
    field('overlayIntensity', '后期叠加强度', { valueType: 'number', min: '0', max: '1', step: '0.05', when: lightingEffectModeIs('post'), defaultValue: inspectorDefault(0) }),
    field('rgbSplitX', 'RGB 分离 X', { valueType: 'number', popoverMin: '-5', popoverMax: '5', step: '0.01', when: lightingEffectModeIs('post'), defaultValue: inspectorDefault(0) }),
    field('rgbSplitY', 'RGB 分离 Y', { valueType: 'number', popoverMin: '-5', popoverMax: '5', step: '0.01', when: lightingEffectModeIs('post'), defaultValue: inspectorDefault(0) }),
    field('godrayGain', '体积光强度', { valueType: 'number', popoverMin: '0', popoverMax: '1', step: '0.01', when: lightingEffectModeIs('post'), defaultValue: inspectorDefault(0) }),
    field('godrayLacunarity', '体积光细节', { valueType: 'number', popoverMin: '0', popoverMax: '10', step: '0.1', when: lightingEffectModeIs('post'), defaultValue: (params) => params.mode === 'set' ? 2.5 : 2 }),
    field('godrayAngle', '体积光角度', { valueType: 'number', min: '0', max: '360', popoverMin: '0', popoverMax: '360', step: '1', when: lightingEffectModeIs('post'), defaultValue: inspectorDefault(30) }),
    field('bloomThreshold', 'Bloom 阈值', { valueType: 'number', min: '0', max: '1', step: '0.01', when: lightingEffectModeIs('post'), defaultValue: (params) => params.mode === 'set' ? 0.5 : 0.8 }),
    field('bloomBloomScale', 'Bloom 强度', { valueType: 'number', popoverMin: '0', popoverMax: '5', step: '0.05', when: lightingEffectModeIs('post'), defaultValue: (params) => params.mode === 'set' ? 0 : 1 }),
    field('bloomBrightness', 'Bloom 亮度', { valueType: 'number', popoverMin: '0', popoverMax: '2', step: '0.01', when: lightingEffectModeIs('post'), defaultValue: inspectorDefault(1) }),
    field('durationSeconds', '过渡时长', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '10', step: '0.1', when: modeIsOneOf('set', 'modulate', 'reset', 'remove', 'clear'), defaultValue: defaultLightingDuration }),
  ],
  audio: [
    field('role', '音频角色', { surface: 'semantic' }),
    field('mode', '播放操作', { surface: 'semantic' }),
    field('instanceId', '音效实例 ID', { visibility: 'advanced', when: (params) => params.role === 'sfx' }),
    field('file', '音频文件', { when: (params) => params.mode === 'play' }),
    field('volume', '音量大小', { valueType: 'number', min: '0', max: '1', step: '0.05', when: (params) => params.mode === 'play', defaultValue: inspectorDefault(1) }),
    field('loop', '循环播放', {
      valueType: 'boolean',
      when: (params) => params.mode === 'play' && (params.role === 'bgm' || params.role === 'sfx'),
      defaultValue: (params) => params.role === 'bgm' ? true : undefined,
    }),
    field('durationSeconds', '时长', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '10', step: '0.1', when: roleIs('sfx', 'play') }),
    field('fadeIn', '淡入', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '10', step: '0.1', when: (params) => params.mode === 'play', defaultValue: (params) => params.role === 'bgm' ? DEFAULT_AUDIO_BGM_FADE_IN_SECONDS : undefined }),
    field('fadeOut', '淡出', { valueType: 'number', min: '0', popoverMin: '0', popoverMax: '10', step: '0.1', when: (params) => params.mode === 'play' || params.mode === 'stop', defaultValue: (params) => params.mode === 'stop' ? DEFAULT_AUDIO_STOP_FADE_OUT_SECONDS : undefined }),
  ],
  graphicLayer: [
    field('kind', '图层类型', { surface: 'semantic' }),
    field('mode', '图层操作', { surface: 'semantic' }),
    field('id', '图层 ID', { visibility: 'advanced' }),
    field('file', '图片文件', { when: (params) => params.kind === 'image' && params.mode === 'set' }),
    field('text', '文本内容', { when: (params) => params.kind === 'text' && params.mode === 'set', defaultValue: (params) => params.mode === 'set' ? '文本' : undefined }),
    field('position', '空间坐标', { when: modeIsOneOf('set', 'transform'), defaultValue: (params) => ['set', 'transform'].includes(String(params.mode)) ? [0.5, 0.5] : undefined }),
    field('scale', '缩放比例', {
      valueType: 'number',
      min: '0.05',
      popoverMin: '0.1',
      popoverMax: '3',
      step: '0.05',
      when: modeIsOneOf('set', 'transform'),
      defaultValue: (params) => ['set', 'transform'].includes(String(params.mode)) ? 1 : undefined,
    }),
    field('rotation', '旋转角度', {
      valueType: 'number',
      popoverMin: '-180',
      popoverMax: '180',
      step: '1',
      when: modeIsOneOf('set', 'transform'),
    }),
    field('opacity', '不透明度', {
      valueType: 'number',
      min: '0',
      max: '1',
      step: '0.05',
      when: modeIsOneOf('set', 'transform'),
      defaultValue: (params) => params.mode === 'transform' ? 1 : undefined,
    }),
    field('z', '深度 (Z)', {
      valueType: 'number',
      popoverMin: '-100',
      popoverMax: '100',
      step: '10',
      when: modeIsOneOf('set', 'transform'),
    }),
    field('zIndex', '层级', {
      valueType: 'number',
      popoverMin: '-10',
      popoverMax: '10',
      step: '1',
      when: modeIsOneOf('set', 'transform'),
    }),
    field('durationSeconds', '时长', {
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '5',
      step: '0.1',
      when: modeIsOneOf('set', 'transform', 'remove'),
      defaultValue: (params) => params.mode === 'transform' ? 1 : undefined,
    }),
    field('ease', '缓动曲线', { when: modeIsOneOf('transform', 'remove'), defaultValue: (params) => params.mode === 'transform' ? 'smooth' : undefined }),
    field('fontFamily', '字体', { when: (params) => params.kind === 'text' && params.mode !== 'remove' }),
    field('fontSize', '字号', {
      valueType: 'number',
      min: '8',
      popoverMin: '12',
      popoverMax: '120',
      step: '1',
      when: (params) => params.kind === 'text' && params.mode === 'set',
      defaultValue: (params) => params.mode === 'set' ? 36 : undefined,
    }),
    field('color', '颜色', { when: (params) => params.kind === 'text' && params.mode === 'set', defaultValue: (params) => params.mode === 'set' ? '#ffffff' : undefined }),
    field('style', '动画风格', { when: (params) => params.kind === 'text' && params.mode === 'set' }),
  ],
  customAnimation: [
    field('target', '绑定对象'),
    field('file', '动画文件', { when: customAnimationResourceField('file') }),
    field('animation', '动画资源', { when: customAnimationResourceField('animation') }),
    field('durationSeconds', '时长', {
      valueType: 'number',
      min: '0',
      popoverMin: '0',
      popoverMax: '10',
      step: '0.1',
      defaultValue: inspectorDefault(1),
    }),
    field('loop', '循环播放', { defaultValue: inspectorDefault(false) }),
  ],
};

export function getSemanticInspectorFields(
  family: StatementFamily,
  params: Readonly<Record<string, unknown>> = {},
  sceneVisual?: SceneVisualBlock,
): readonly SemanticInspectorField[] {
  return SEMANTIC_INSPECTOR_FIELD_CATALOG[family].filter((fieldDefinition) => (
    !fieldDefinition.when || fieldDefinition.when(params, sceneVisual)
  ));
}

export function materializeSemanticInspectorParams(
  family: StatementFamily,
  sourceParams: Readonly<Record<string, unknown>>,
  sceneVisual?: SceneVisualBlock,
): Record<string, unknown> {
  const params = cloneValue(sourceParams) as Record<string, unknown>;
  for (const fieldDefinition of getSemanticInspectorFields(family, sourceParams, sceneVisual)) {
    if (fieldDefinition.defaultValue === undefined || hasOwn(params, fieldDefinition.key)) continue;
    const value = fieldDefinition.defaultValue(sourceParams, sceneVisual);
    if (value !== undefined) params[fieldDefinition.key] = cloneValue(value);
  }
  return params;
}

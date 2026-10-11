import type { SceneMeta } from '../../api/types/scene-common';
import type { LightingParams, SceneStatementDraft, StatementFamily } from '../../api/types/semantic-scene';
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
} from '../../services/semantic-scene';
import { getDefaultDialogueDurationSeconds } from '../SettingsStore';
import { resolveDialogueDuration } from '../../services/pacing/pacing';
import type { VisualTier } from './visualPresentation';

export type SemanticStatementBlockCategory =
  | 'dialogue'
  | 'character'
  | 'camera'
  | 'scene'
  | 'visual'
  | 'audio'
  | 'layer';

export interface SemanticStatementBlockEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly category: SemanticStatementBlockCategory;
  readonly visualTier?: VisualTier;
  readonly description?: string;
  readonly lifecycleEndCommand?: {
    readonly presentationTypeKey: string;
    readonly match: 'draft-state-key' | 'unique-active';
  };
  readonly stateSpanDependencyCommand?: {
    readonly presentationTypeKey: string;
    readonly statementType: StatementFamily;
    readonly paramsTemplate: Readonly<Record<string, unknown>>;
  };
  createDraft(input: SemanticStatementBlockDraftInput): SceneStatementDraft | null;
}

export interface SemanticStatementBlockDraftInput {
  readonly sceneMeta?: SceneMeta | null;
  readonly charId?: string | null;
  readonly stateTarget?: string;
  readonly currentFilterId?: string;
  readonly filePath?: string;
  readonly sourceKind?: string;
  readonly dialoguePresentation?: import('../../api/types/semantic-scene').DialogueImagePresentation;
  readonly dialogueTemplate?: 'glass' | 'minimal' | 'classic';
}

// Keep these entries available to compatibility helpers and inspectors for old
// scenes, while excluding them from every new statement insertion surface.
export const NON_INSERTABLE_SEMANTIC_STATEMENT_BLOCK_IDS: ReadonlySet<string> = new Set([
  'camera.hitchcock',
  'visual.character-grounding',
  'visual.modulate-character-grounding',
  'visual.reset-character-grounding',
]);

const DEFAULT_LIGHTING_SET_DURATION_SECONDS = 0.5;
const DEFAULT_LIGHTING_CHANGE_DURATION_SECONDS = 1;
const DEFAULT_LIGHTING_RESET_DURATION_SECONDS = 0.4;
const DEFAULT_LIGHTING_OVERLAY_ID = 'overlay_1';
const DEFAULT_LIGHTING_POINT_LIGHT_ID = 'point_light_1';

function createLightingStatement(params: LightingParams): SceneStatementDraft {
  return { type: 'lighting', params };
}

function createLightingSetDraft(effect: 'blur' | 'post', stateTarget?: string): SceneStatementDraft {
  if (effect === 'blur') {
    return createLightingStatement({
      effect,
      mode: 'set',
      target: 'global',
      intensity: 0.5,
      durationSeconds: DEFAULT_LIGHTING_SET_DURATION_SECONDS,
    });
  }
  return createLightingStatement({
    effect,
    mode: 'set',
    target: stateTarget || 'panorama',
    bloomThreshold: 0.5,
    bloomBloomScale: 0,
    bloomBrightness: 1,
    rgbSplitX: 0,
    rgbSplitY: 0,
    godrayGain: 0,
    godrayLacunarity: 2.5,
    godrayAngle: 30,
    adjGamma: 1,
    adjContrast: 1,
    adjSaturation: 1,
    adjBrightness: 1,
    adjRed: 1,
    adjGreen: 1,
    adjBlue: 1,
    overlayColor: '#ffffff',
    overlayBlendMode: 'multiply',
    overlayIntensity: 0,
    durationSeconds: DEFAULT_LIGHTING_SET_DURATION_SECONDS,
  });
}

function createLightingChangeDraft(
  effect: 'blur' | 'post',
  stateTarget?: string,
): SceneStatementDraft {
  if (effect === 'blur') {
    const target = stateTarget === 'background' || stateTarget === 'characters' || stateTarget === 'global'
      ? stateTarget
      : 'global';
    return createLightingStatement({
      effect,
      mode: 'modulate',
      target,
      intensity: 1,
      durationSeconds: DEFAULT_LIGHTING_CHANGE_DURATION_SECONDS,
    });
  }
  return createLightingStatement({
    effect,
    mode: 'modulate',
    target: stateTarget || 'panorama',
    bloomThreshold: 0.8,
    bloomBloomScale: 1,
    bloomBrightness: 1,
    rgbSplitX: 0,
    rgbSplitY: 0,
    godrayGain: 0,
    godrayLacunarity: 2,
    godrayAngle: 30,
    adjGamma: 1,
    adjContrast: 1,
    adjSaturation: 1,
    adjBrightness: 1,
    adjRed: 1,
    adjGreen: 1,
    adjBlue: 1,
    overlayColor: '#ffffff',
    overlayBlendMode: 'multiply',
    overlayIntensity: 0,
    durationSeconds: DEFAULT_LIGHTING_CHANGE_DURATION_SECONDS,
  });
}

function createLightingResetDraft(effect: 'blur' | 'post', stateTarget?: string): SceneStatementDraft {
  return createLightingStatement({
    effect,
    mode: 'reset',
    ...(effect === 'post' ? { target: stateTarget || 'panorama' } : {}),
    durationSeconds: DEFAULT_LIGHTING_RESET_DURATION_SECONDS,
  } as LightingParams);
}

export const SEMANTIC_STATEMENT_BLOCKS: readonly SemanticStatementBlockEntry[] = [
  {
    id: 'dialogue.basic',
    label: '对话',
    icon: 'dialogue',
    category: 'dialogue',
    createDraft: ({ sceneMeta, charId, dialoguePresentation, dialogueTemplate }) => {
      const character = charId ? resolveCharacter(sceneMeta, charId) : null;
      return {
        type: 'dialogue',
        params: {
          ...(character ? { speakerId: character.id, speaker: character.name || character.id } : {}),
          text: '新对白',
          durationSeconds: resolveDialogueDuration({
            context: 'manual-default',
            defaultDurationSeconds: getDefaultDialogueDurationSeconds(),
          }),
          ...(dialogueTemplate ? { template: dialogueTemplate } : {}),
          ...(dialoguePresentation ? { presentation: JSON.parse(JSON.stringify(dialoguePresentation)) } : {}),
        },
      };
    },
  },
  {
    id: 'dialogue.hide',
    label: '隐藏字幕框',
    icon: 'dialogue',
    category: 'dialogue',
    createDraft: () => ({ type: 'dialogueVisibility', params: { visible: false, durationSeconds: 0.3 } }),
  },
  {
    id: 'dialogue.show',
    label: '显示字幕框',
    icon: 'dialogue',
    category: 'dialogue',
    createDraft: () => ({ type: 'dialogueVisibility', params: { visible: true, durationSeconds: 0.3 } }),
  },
  {
    id: 'character.enter',
    label: '角色登场',
    icon: 'addCharacter',
    category: 'character',
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'characterPresence',
      params: {
        mode: 'enter',
        id: resolveCharacterId(sceneMeta, charId),
        position: [0.5, 1],
        scale: 1,
        transition: DEFAULT_CHARACTER_ENTER_TRANSITION,
        durationSeconds: DEFAULT_CHARACTER_PRESENCE_TRANSITION_SECONDS,
      },
    }),
  },
  {
    id: 'character.exit',
    label: '角色退场',
    icon: 'removeCharacter',
    category: 'character',
    lifecycleEndCommand: { presentationTypeKey: 'characterPresence:presence', match: 'draft-state-key' },
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'characterPresence',
      params: {
        mode: 'exit',
        id: resolveCharacterId(sceneMeta, charId),
        transition: DEFAULT_CHARACTER_EXIT_TRANSITION,
        durationSeconds: DEFAULT_CHARACTER_PRESENCE_TRANSITION_SECONDS,
      },
    }),
  },
  {
    id: 'character.transform',
    label: '角色变换',
    icon: 'transformCharacter',
    category: 'character',
    stateSpanDependencyCommand: {
      presentationTypeKey: 'characterPresence:presence',
      statementType: 'characterTransform',
      paramsTemplate: {
        position: [0.5, 1],
        scale: 1,
        durationSeconds: 1,
        ease: 'smooth',
      },
    },
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'characterTransform',
      params: {
        id: resolveCharacterId(sceneMeta, charId),
        position: [0.5, 1],
        scale: 1,
        durationSeconds: 1,
        ease: 'smooth',
      },
    }),
  },
  {
    id: 'character.performance.motion',
    label: '角色动作',
    icon: 'playMotion',
    category: 'character',
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'characterPerformance',
      params: {
        target: resolveCharacterId(sceneMeta, charId),
        motion: { kind: 'resource', key: 'idle' },
      },
    }),
  },
  {
    id: 'character.performance.expression',
    label: '角色表情',
    icon: 'setExpression',
    category: 'character',
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'characterPerformance',
      params: {
        target: resolveCharacterId(sceneMeta, charId),
        expression: 'smile',
      },
    }),
  },
  {
    id: 'character.performance.look-at',
    label: '角色视线',
    icon: 'characterLookAt',
    category: 'character',
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'characterPerformance',
      params: {
        target: resolveCharacterId(sceneMeta, charId),
        lookAt: {
          point: [0, 0],
          intensity: 1,
          enabled: true,
        },
      },
    }),
  },
  {
    id: 'character.performance.blink',
    label: '角色眨眼',
    icon: 'characterBlink',
    category: 'character',
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'characterPerformance',
      params: {
        target: resolveCharacterId(sceneMeta, charId),
        blink: {
          enabled: true,
          interval: 4,
        },
      },
    }),
  },
  {
    id: 'camera.focus',
    label: '镜头对焦',
    icon: 'cameraMove',
    category: 'camera',
    createDraft: ({ sceneMeta, charId }) => {
      const character = resolveCharacter(sceneMeta, charId);
      return {
        type: 'camera',
        params: character
          ? {
              mode: 'focus',
              target: character.id,
              targetPart: 'chest',
              zoom: { kind: 'absolute', value: 1.08 },
              durationSeconds: 1,
              ease: 'smooth',
            }
          : {
              mode: 'focus',
              position: [0.5, 0.5],
              zoom: { kind: 'absolute', value: 1.08 },
              durationSeconds: 1,
              ease: 'smooth',
            },
      };
    },
  },
  {
    id: 'camera.move',
    label: '镜头移动',
    icon: 'cameraMove',
    category: 'camera',
    createDraft: () => ({
      type: 'camera',
      params: {
        mode: 'move',
        to: [0.5, 0.5],
        zoom: { kind: 'absolute', value: 1 },
        rotation: 0,
        durationSeconds: 1,
        ease: 'smooth',
      },
    }),
  },
  {
    id: 'camera.follow',
    label: '镜头跟随',
    icon: 'cameraFollow',
    category: 'camera',
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'camera',
      params: {
        mode: 'follow',
        operation: 'start',
        target: resolveCharacterId(sceneMeta, charId),
        offset: [0, 0],
        smoothing: 0.85,
      },
    }),
  },
  {
    id: 'camera.stop-follow',
    label: '停止镜头跟随',
    icon: 'cameraReset',
    category: 'camera',
    lifecycleEndCommand: { presentationTypeKey: 'camera:follow', match: 'unique-active' },
    createDraft: () => ({
      type: 'camera',
      params: { mode: 'follow', operation: 'stop' },
    }),
  },
  {
    id: 'camera.path',
    label: '镜头路径',
    icon: 'cameraPath',
    category: 'camera',
    createDraft: () => ({
      type: 'camera',
      params: {
        mode: 'path',
        keyframes: [
          { time: 0, position: [0.5, 0.5] },
          { time: 1, position: [0.5, 0.5] },
        ],
        durationSeconds: 1,
        ease: 'smooth',
        repeat: 0,
        loop: false,
        yoyo: false,
      },
    }),
  },
  {
    id: 'camera.shake',
    label: '镜头震动',
    icon: 'cameraShake',
    category: 'camera',
    createDraft: () => ({
      type: 'camera',
      params: {
        mode: 'shake',
        intensity: 0.2,
        frequency: 18,
        durationSeconds: 0.6,
        decay: true,
        direction: 'both',
      },
    }),
  },
  {
    id: 'camera.hitchcock',
    label: '希区柯克变焦',
    icon: 'cameraHitchcock',
    category: 'camera',
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'camera',
      params: {
        mode: 'hitchcock',
        target: resolveCharacterId(sceneMeta, charId),
        targetPart: 'chest',
        screenTarget: [0.5, 0.5],
        zoomStart: 1,
        zoomEnd: 1.3,
        scaleStart: 1,
        scaleEnd: 0.8,
        durationSeconds: 2,
        ease: 'smooth',
      },
    }),
  },
  {
    id: 'camera.reset',
    label: '镜头重置',
    icon: 'cameraReset',
    category: 'camera',
    createDraft: () => ({
      type: 'camera',
      params: {
        mode: 'reset',
        durationSeconds: 0.5,
        ease: 'smooth',
      },
    }),
  },
  {
    id: 'environment.set-background',
    label: '放入环境画面',
    icon: 'setEnvironmentLayer',
    category: 'scene',
    description: '从资源浏览器选择图片，或在检查器中指定文件。',
    createDraft: ({ filePath }) => {
      const file = normalizeResourcePath(filePath) ?? '';
      return {
        type: 'environmentLayer',
        params: {
          mode: 'set',
          layerId: 'background',
          file,
          transition: DEFAULT_ENVIRONMENT_SET_TRANSITION,
          durationSeconds: DEFAULT_ENVIRONMENT_SET_DURATION_SECONDS,
        },
      };
    },
  },
  {
    id: 'environment.transform-layer',
    label: '环境图层变化',
    icon: 'transformEnvironmentLayer',
    category: 'scene',
    stateSpanDependencyCommand: {
      presentationTypeKey: 'environmentLayer:layer',
      statementType: 'environmentLayer',
      paramsTemplate: {
        position: [0.5, 0.5],
        scale: 1,
        opacity: 1,
        durationSeconds: 1,
        ease: 'smooth',
      },
    },
    createDraft: () => null,
  },
  // -------------------------------------------------------------
  // Visual Effects: 轮椅阶 (Wheelchair / Character Compositing)
  // -------------------------------------------------------------
  {
    id: 'visual.character-integration',
    label: '角色色彩融入',
    icon: 'setCompositeRecipe',
    category: 'visual',
    visualTier: 'wheelchair',
    description: '将角色色彩与光影自然融入背景色调与环境光。',
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: resolveCharacterId(sceneMeta, charId),
        slot: 'integration',
        mode: 'set',
        recipeId: 'builtin:integration-soft',
        intensity: 0.8,
        blend: 0.36,
        contamination: 0.18,
        warmth: 0,
        colorBlendMode: 'multiply',
      },
    }),
  },
  {
    id: 'visual.character-rim-light',
    label: '角色边光',
    icon: 'setCharacterRimLight',
    category: 'visual',
    visualTier: 'wheelchair',
    description: '设置持久角色轮廓光 / 剪影高光，直到同一角色边光被重置。',
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: resolveCharacterId(sceneMeta, charId),
        slot: 'rim-light',
        mode: 'set',
        intensity: 1,
        color: '#ffffff',
        thickness: 10,
        angle: 45,
        softness: 2,
        durationSeconds: 0,
      },
    }),
  },
  {
    id: 'visual.character-grounding',
    label: '角色明暗融入',
    icon: 'setCompositeRecipe',
    category: 'visual',
    visualTier: 'wheelchair',
    description: '角色下部明暗压暗与脚底贴地软阴影。',
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: resolveCharacterId(sceneMeta, charId),
        slot: 'grounding',
        mode: 'set',
        recipeId: 'builtin:ground-shadow-soft',
        intensity: 0.95,
        blend: 0.52,
        contamination: 0.34,
      },
    }),
  },
  {
    id: 'visual.modulate-character-integration',
    label: '角色色彩融入变化',
    icon: 'modulateComposite',
    category: 'visual',
    visualTier: 'wheelchair',
    stateSpanDependencyCommand: {
      presentationTypeKey: 'visualStyle:object',
      statementType: 'visualStyle',
      paramsTemplate: { intensity: 1, durationSeconds: 1 },
    },
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: resolveCharacterId(sceneMeta, charId),
        slot: 'integration',
        mode: 'modulate',
        intensity: 1,
        warmth: 0,
        blend: 0.3,
        contamination: 0.2,
        durationSeconds: 1,
      },
    }),
  },
  {
    id: 'visual.modulate-character-grounding',
    label: '角色明暗融入变化',
    icon: 'modulateComposite',
    category: 'visual',
    visualTier: 'wheelchair',
    stateSpanDependencyCommand: {
      presentationTypeKey: 'visualStyle:object',
      statementType: 'visualStyle',
      paramsTemplate: { intensity: 1, durationSeconds: 1 },
    },
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: resolveCharacterId(sceneMeta, charId),
        slot: 'grounding',
        mode: 'modulate',
        intensity: 1,
        blend: 0.5,
        contamination: 0.2,
        durationSeconds: 1,
      },
    }),
  },
  {
    id: 'visual.reset-character-integration',
    label: '重置角色色彩融入',
    icon: 'resetLighting',
    category: 'visual',
    visualTier: 'wheelchair',
    lifecycleEndCommand: { presentationTypeKey: 'visualStyle:object', match: 'draft-state-key' },
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: resolveCharacterId(sceneMeta, charId),
        slot: 'integration',
        mode: 'reset',
        durationSeconds: 0.4,
      },
    }),
  },
  {
    id: 'visual.reset-character-rim-light',
    label: '重置角色边光',
    icon: 'resetLighting',
    category: 'visual',
    visualTier: 'wheelchair',
    description: '结束角色边光并回到场景视觉基线。',
    lifecycleEndCommand: { presentationTypeKey: 'visualStyle:object', match: 'draft-state-key' },
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: resolveCharacterId(sceneMeta, charId),
        slot: 'rim-light',
        mode: 'reset',
        durationSeconds: 0.4,
      },
    }),
  },
  {
    id: 'visual.reset-character-grounding',
    label: '重置角色明暗融入',
    icon: 'resetLighting',
    category: 'visual',
    visualTier: 'wheelchair',
    lifecycleEndCommand: { presentationTypeKey: 'visualStyle:object', match: 'draft-state-key' },
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: resolveCharacterId(sceneMeta, charId),
        slot: 'grounding',
        mode: 'reset',
        durationSeconds: 0.4,
      },
    }),
  },

  // -------------------------------------------------------------
  // Visual Effects: 进阶级 (Advanced / Lens & Atmospheric Atmosphere)
  // -------------------------------------------------------------
  {
    id: 'lighting.overlay',
    label: '添加色彩叠加',
    icon: 'addColorOverlay',
    category: 'visual',
    visualTier: 'advanced',
    description: '全画面色调冲刷与光照氛围（正片叠底 / 滤色）。',
    createDraft: ({ stateTarget }) => createLightingStatement({
      effect: 'overlay',
      mode: 'set',
      id: stateTarget || DEFAULT_LIGHTING_OVERLAY_ID,
      color: '#ffffff',
      blendMode: 'multiply',
      intensity: 0.5,
      durationSeconds: DEFAULT_LIGHTING_SET_DURATION_SECONDS,
    }),
  },
  {
    id: 'lighting.blur',
    label: '设置模糊',
    icon: 'setBlur',
    category: 'visual',
    visualTier: 'advanced',
    description: '背景虚化突出主体，或全屏虚化景深。',
    createDraft: () => createLightingSetDraft('blur'),
  },
  {
    id: 'lighting.modulate-overlay',
    label: '变化色彩叠加',
    icon: 'addColorOverlay',
    category: 'visual',
    visualTier: 'advanced',
    stateSpanDependencyCommand: {
      presentationTypeKey: 'lighting:overlay',
      statementType: 'lighting',
      paramsTemplate: { intensity: 1, durationSeconds: 1 },
    },
    createDraft: ({ stateTarget }) => createLightingStatement({
      effect: 'overlay',
      mode: 'modulate',
      id: stateTarget || DEFAULT_LIGHTING_OVERLAY_ID,
      color: '#ffffff',
      blendMode: 'multiply',
      intensity: 1,
      durationSeconds: DEFAULT_LIGHTING_CHANGE_DURATION_SECONDS,
    }),
  },
  {
    id: 'lighting.modulate-blur',
    label: '变化模糊',
    icon: 'setBlur',
    category: 'visual',
    visualTier: 'advanced',
    stateSpanDependencyCommand: {
      presentationTypeKey: 'lighting:blur',
      statementType: 'lighting',
      paramsTemplate: { intensity: 1, durationSeconds: 1 },
    },
    createDraft: ({ stateTarget }: SemanticStatementBlockDraftInput) => createLightingChangeDraft('blur', stateTarget),
  },
  {
    id: 'lighting.remove-overlay',
    label: '移除色彩叠加',
    icon: 'removeColorOverlay',
    category: 'visual',
    visualTier: 'advanced',
    lifecycleEndCommand: { presentationTypeKey: 'lighting:overlay', match: 'unique-active' },
    createDraft: ({ stateTarget }) => createLightingStatement({
      effect: 'overlay',
      mode: 'remove',
      id: stateTarget || DEFAULT_LIGHTING_OVERLAY_ID,
      durationSeconds: DEFAULT_LIGHTING_RESET_DURATION_SECONDS,
    }),
  },
  {
    id: 'lighting.clear-overlay',
    label: '清除全部色彩叠加',
    icon: 'clearColorOverlays',
    category: 'visual',
    visualTier: 'advanced',
    createDraft: () => createLightingStatement({
      effect: 'overlay',
      mode: 'clear',
      durationSeconds: DEFAULT_LIGHTING_RESET_DURATION_SECONDS,
    }),
  },
  {
    id: 'lighting.reset-blur',
    label: '重置模糊',
    icon: 'resetBlur',
    category: 'visual',
    visualTier: 'advanced',
    lifecycleEndCommand: { presentationTypeKey: 'lighting:blur', match: 'unique-active' },
    createDraft: () => createLightingResetDraft('blur'),
  },

  // -------------------------------------------------------------
  // Visual Effects: 自定义级 (Custom / Pro Point Light & Post Processing)
  // -------------------------------------------------------------
  {
    id: 'lighting.point-light',
    label: '添加点光源',
    icon: 'addPointLight',
    category: 'visual',
    visualTier: 'custom',
    description: '舞台与画面空间定位点光源。',
    createDraft: ({ stateTarget }) => createLightingStatement({
      effect: 'pointLight',
      mode: 'set',
      id: stateTarget || DEFAULT_LIGHTING_POINT_LIGHT_ID,
      x: 0.5,
      y: 0.5,
      color: '#ffffff',
      radius: 240,
      intensity: 0.8,
      durationSeconds: DEFAULT_LIGHTING_SET_DURATION_SECONDS,
    }),
  },
  {
    id: 'lighting.post',
    label: '设置后期处理',
    icon: 'setPostProcessing',
    category: 'visual',
    visualTier: 'custom',
    description: '泛光 Bloom、RGB 色差与底层调色着色器深度控制。',
    createDraft: ({ stateTarget }) => createLightingSetDraft('post', stateTarget),
  },
  {
    id: 'visual.modulate-character-accent',
    label: '角色风格强调变化',
    icon: 'modulateComposite',
    category: 'visual',
    visualTier: 'custom',
    stateSpanDependencyCommand: {
      presentationTypeKey: 'visualStyle:object',
      statementType: 'visualStyle',
      paramsTemplate: { intensity: 1, durationSeconds: 1 },
    },
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: resolveCharacterId(sceneMeta, charId),
        slot: 'accent',
        mode: 'modulate',
        intensity: 1,
        warmth: 0,
        durationSeconds: 1,
      },
    }),
  },
  {
    id: 'visual.modulate-character-distortion',
    label: '角色异化变化',
    icon: 'modulateComposite',
    category: 'visual',
    visualTier: 'custom',
    stateSpanDependencyCommand: {
      presentationTypeKey: 'visualStyle:object',
      statementType: 'visualStyle',
      paramsTemplate: { intensity: 1, durationSeconds: 1 },
    },
    createDraft: ({ sceneMeta, charId }) => ({
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: resolveCharacterId(sceneMeta, charId),
        slot: 'distortion',
        mode: 'modulate',
        intensity: 1,
        bloom: 0.2,
        rgbSplit: 0.1,
        durationSeconds: 1,
      },
    }),
  },
  {
    id: 'lighting.modulate-post',
    label: '变化后期处理',
    icon: 'setPostProcessing',
    category: 'visual',
    visualTier: 'custom',
    stateSpanDependencyCommand: {
      presentationTypeKey: 'lighting:post',
      statementType: 'lighting',
      paramsTemplate: { bloomBloomScale: 1, durationSeconds: 1 },
    },
    createDraft: ({ stateTarget }: SemanticStatementBlockDraftInput) => createLightingChangeDraft('post', stateTarget),
  },
  {
    id: 'lighting.modulate-point-light',
    label: '变化点光源',
    icon: 'addPointLight',
    category: 'visual',
    visualTier: 'custom',
    stateSpanDependencyCommand: {
      presentationTypeKey: 'lighting:pointLight',
      statementType: 'lighting',
      paramsTemplate: { intensity: 1, durationSeconds: 1 },
    },
    createDraft: ({ stateTarget }) => createLightingStatement({
      effect: 'pointLight',
      mode: 'modulate',
      id: stateTarget || DEFAULT_LIGHTING_POINT_LIGHT_ID,
      x: 0.5,
      y: 0.5,
      color: '#ffffff',
      radius: 240,
      intensity: 0.8,
      durationSeconds: DEFAULT_LIGHTING_CHANGE_DURATION_SECONDS,
    }),
  },
  {
    id: 'lighting.remove-point-light',
    label: '移除点光源',
    icon: 'removePointLight',
    category: 'visual',
    visualTier: 'custom',
    lifecycleEndCommand: { presentationTypeKey: 'lighting:pointLight', match: 'unique-active' },
    createDraft: ({ stateTarget }) => createLightingStatement({
      effect: 'pointLight',
      mode: 'remove',
      id: stateTarget || DEFAULT_LIGHTING_POINT_LIGHT_ID,
      durationSeconds: DEFAULT_LIGHTING_RESET_DURATION_SECONDS,
    }),
  },
  {
    id: 'lighting.clear-point-light',
    label: '清除全部点光源',
    icon: 'clearPointLights',
    category: 'visual',
    visualTier: 'custom',
    createDraft: () => createLightingStatement({
      effect: 'pointLight',
      mode: 'clear',
      durationSeconds: DEFAULT_LIGHTING_RESET_DURATION_SECONDS,
    }),
  },
  {
    id: 'lighting.reset-post',
    label: '重置后期处理',
    icon: 'resetPostProcessing',
    category: 'visual',
    visualTier: 'custom',
    lifecycleEndCommand: { presentationTypeKey: 'lighting:post', match: 'unique-active' },
    createDraft: ({ stateTarget }) => createLightingResetDraft('post', stateTarget),
  },

  {
    id: 'environment.remove-background',
    label: '收起环境画面',
    icon: 'removeEnvironmentLayer',
    category: 'scene',
    lifecycleEndCommand: { presentationTypeKey: 'environmentLayer:layer', match: 'draft-state-key' },
    createDraft: () => ({
      type: 'environmentLayer',
      params: {
        mode: 'remove',
        layerId: 'background',
        transition: DEFAULT_ENVIRONMENT_REMOVE_TRANSITION,
        durationSeconds: DEFAULT_ENVIRONMENT_REMOVE_DURATION_SECONDS,
      },
    }),
  },
  {
    id: 'environment.remove-layer',
    label: '收起环境图层',
    icon: 'removeEnvironmentLayer',
    category: 'scene',
    lifecycleEndCommand: { presentationTypeKey: 'environmentLayer:layer', match: 'unique-active' },
    createDraft: () => null,
  },
  {
    id: 'audio.bgm',
    label: '背景音乐',
    icon: 'setBGM',
    category: 'audio',
    description: '从资源浏览器选择有效音频，或在检查器中指定文件。',
    createDraft: ({ filePath }) => {
      const file = normalizeResourcePath(filePath) ?? '';
      return {
        type: 'audio',
        params: {
          role: 'bgm',
          mode: 'play',
          file,
          volume: 1,
          loop: true,
          fadeIn: DEFAULT_AUDIO_BGM_FADE_IN_SECONDS,
        },
      };
    },
  },
  {
    id: 'audio.stop-bgm',
    label: '停止背景音乐',
    icon: 'stopAudio',
    category: 'audio',
    lifecycleEndCommand: { presentationTypeKey: 'audio:bgm', match: 'draft-state-key' },
    createDraft: () => ({
      type: 'audio',
      params: { role: 'bgm', mode: 'stop', fadeOut: DEFAULT_AUDIO_STOP_FADE_OUT_SECONDS },
    }),
  },
  {
    id: 'audio.sfx',
    label: '音效',
    icon: 'playAudio',
    category: 'audio',
    description: '从资源浏览器选择有效音频，或在检查器中指定文件。',
    createDraft: ({ filePath }) => {
      const file = normalizeResourcePath(filePath) ?? '';
      return {
        type: 'audio',
        params: {
          role: 'sfx',
          mode: 'play',
          instanceId: createTransientId('sfx'),
          file,
          volume: 1,
        },
      };
    },
  },
  {
    id: 'graphic.image',
    label: '图片图层',
    icon: 'addImage',
    category: 'layer',
    description: '从资源浏览器选择图片，或在检查器中指定文件。',
    createDraft: ({ filePath }) => {
      const file = normalizeResourcePath(filePath) ?? '';
      return {
        type: 'graphicLayer',
        params: {
          kind: 'image',
          mode: 'set',
          id: createTransientId('image'),
          file,
          position: [0.5, 0.5],
          scale: 1,
        },
      };
    },
  },
  {
    id: 'graphic.transform-image',
    label: '图片图层变化',
    icon: 'transformImage',
    category: 'layer',
    stateSpanDependencyCommand: {
      presentationTypeKey: 'graphicLayer:image',
      statementType: 'graphicLayer',
      paramsTemplate: {
        position: [0.5, 0.5],
        scale: 1,
        opacity: 1,
        durationSeconds: 1,
        ease: 'smooth',
      },
    },
    createDraft: () => null,
  },
  {
    id: 'graphic.remove-image',
    label: '移除图片图层',
    icon: 'removeImage',
    category: 'layer',
    lifecycleEndCommand: { presentationTypeKey: 'graphicLayer:image', match: 'unique-active' },
    createDraft: () => null,
  },
  {
    id: 'graphic.text',
    label: '文本图层',
    icon: 'addTextLayer',
    category: 'layer',
    createDraft: () => ({
      type: 'graphicLayer',
      params: {
        kind: 'text',
        mode: 'set',
        id: createTransientId('text'),
        text: '文本',
        position: [0.5, 0.5],
        scale: 1,
        fontSize: 36,
        color: '#ffffff',
      },
    }),
  },
  {
    id: 'graphic.transform-text',
    label: '文字图层变化',
    icon: 'transformTextLayer',
    category: 'layer',
    stateSpanDependencyCommand: {
      presentationTypeKey: 'graphicLayer:text',
      statementType: 'graphicLayer',
      paramsTemplate: {
        position: [0.5, 0.5],
        scale: 1,
        opacity: 1,
        durationSeconds: 1,
        ease: 'smooth',
      },
    },
    createDraft: () => null,
  },
  {
    id: 'graphic.remove-text',
    label: '移除文字图层',
    icon: 'removeTextLayer',
    category: 'layer',
    lifecycleEndCommand: { presentationTypeKey: 'graphicLayer:text', match: 'unique-active' },
    createDraft: () => null,
  },
];

export function createSemanticStatementDraftForBlock(
  blockId: string,
  input: SemanticStatementBlockDraftInput,
): SceneStatementDraft | null {
  return SEMANTIC_STATEMENT_BLOCKS.find((block) => block.id === blockId)?.createDraft(input) ?? null;
}

export function getSemanticStatementBlock(blockId: string): SemanticStatementBlockEntry | undefined {
  return SEMANTIC_STATEMENT_BLOCKS.find((block) => block.id === blockId);
}

export function createSemanticStatementDraftForResource(
  input: SemanticStatementBlockDraftInput & { filePath: string },
): SceneStatementDraft | null {
  const filePath = normalizeResourcePath(input.filePath) ?? '';
  const sourceKind = normalizeResourceKind(input.sourceKind);
  if (sourceKind === 'background') {
    return {
      type: 'environmentLayer',
      params: {
        mode: 'set',
        layerId: 'background',
        file: filePath,
        transition: DEFAULT_ENVIRONMENT_SET_TRANSITION,
        durationSeconds: DEFAULT_ENVIRONMENT_SET_DURATION_SECONDS,
      },
    };
  }
  if (sourceKind === 'bgm') {
    return {
      type: 'audio',
      params: {
        role: 'bgm',
        mode: 'play',
        file: filePath,
        volume: 1,
        loop: true,
        fadeIn: DEFAULT_AUDIO_BGM_FADE_IN_SECONDS,
      },
    };
  }
  if (sourceKind === 'vocal') {
    const character = input.charId ? resolveCharacter(input.sceneMeta, input.charId) : null;
    return {
      type: 'dialogue',
      params: {
        ...(character ? { speakerId: character.id, speaker: character.name || character.id } : {}),
        text: '新对白',
        voice: filePath,
        durationSeconds: resolveDialogueDuration({
          context: 'manual-default',
          defaultDurationSeconds: getDefaultDialogueDurationSeconds(),
        }),
      },
    };
  }
  if (sourceKind === 'animation') {
    return {
      type: 'customAnimation',
      params: {
        target: resolveCharacterId(input.sceneMeta, input.charId),
        file: filePath,
        durationSeconds: 1,
        loop: false,
      },
    };
  }
  if (sourceKind === 'figure') {
    return {
      type: 'characterPresence',
      params: {
        mode: 'enter',
        id: resolveCharacterId(input.sceneMeta, input.charId),
        model: filePath,
        position: [0.5, 1],
        scale: 1,
        transition: DEFAULT_CHARACTER_ENTER_TRANSITION,
        durationSeconds: DEFAULT_CHARACTER_PRESENCE_TRANSITION_SECONDS,
      },
    };
  }

  if (sourceKind === 'sfx') {
    return {
      type: 'audio',
      params: {
        role: 'sfx',
        mode: 'play',
        instanceId: createTransientId('sfx'),
        file: filePath,
        volume: 1,
      },
    };
  }
  if (sourceKind === 'images') {
    return createSemanticStatementDraftForBlock('graphic.image', { ...input, filePath });
  }

  if (!filePath) return null;

  const lower = filePath.toLowerCase();
  if (/\.(png|jpe?g|webp|gif|svg)$/.test(lower)) {
    return createSemanticStatementDraftForBlock('graphic.image', input);
  }
  if (/\.(mp3|wav|ogg|flac|m4a)$/.test(lower)) {
    return {
      type: 'audio',
      params: {
        role: 'sfx',
        mode: 'play',
        instanceId: createTransientId('sfx'),
        file: filePath,
        volume: 1,
      },
    };
  }
  if (/\.(model3?\.json|wmdl|json)$/.test(lower)) {
    return {
      type: 'characterPresence',
      params: {
        mode: 'enter',
        id: resolveCharacterId(input.sceneMeta, input.charId),
        model: filePath,
        position: [0.5, 1],
        scale: 1,
        transition: DEFAULT_CHARACTER_ENTER_TRANSITION,
        durationSeconds: DEFAULT_CHARACTER_PRESENCE_TRANSITION_SECONDS,
      },
    };
  }
  return null;
}

function normalizeResourcePath(pathValue: string | null | undefined): string | null {
  const normalized = typeof pathValue === 'string' ? pathValue.trim().replace(/\\/g, '/') : '';
  return normalized || null;
}

function normalizeResourceKind(sourceKind: string | null | undefined): string | undefined {
  const normalized = typeof sourceKind === 'string'
    ? sourceKind.trim().replace(/\\/g, '/').split('/')[0]
    : '';
  return normalized || undefined;
}

function resolveCharacter(sceneMeta: SceneMeta | null | undefined, charId: string | null | undefined) {
  const characters = sceneMeta?.characters ?? [];
  return characters.find((character) => character.id === charId) ?? characters[0] ?? null;
}

function resolveCharacterId(sceneMeta: SceneMeta | null | undefined, charId: string | null | undefined): string {
  return resolveCharacter(sceneMeta, charId)?.id ?? charId ?? 'character_1';
}

function createTransientId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

import type {
  AudioParams,
  CameraParams,
  CharacterPerformanceParams,
  CharacterPresenceParams,
  EnvironmentLayerParams,
  GraphicLayerParams,
  LightingParams,
  SceneStatement,
  StatementFamily,
  VisualStyleParams,
} from '../../api/types/semantic-scene';
import type {
  SceneStatementDefinitionMap,
  SceneStatementPatchMetadata,
  SceneStatementTimelinePresentation,
  SceneStatementLifecyclePresentation,
} from './SceneStatementDefinitionTypes';
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
  resolveFilterTransitionDuration,
} from './SceneStatementDefinitionTypes';
import {
  collectDialogueAssets,
  compact,
  expectKeys,
  expectRecord,
  optionalBoolean,
  optionalNonNegativeNumber,
  parseAudioParams,
  parseCameraParams,
  parseCharacterPerformanceParams,
  parseCharacterPresenceParams,
  parseCharacterTransformParams,
  parseCustomAnimationParams,
  parseDialogueParams,
  parseEnvironmentLayerParams,
  parseFilterAddParams,
  parseFilterChangeParams,
  parseFilterResetParams,
  parseGraphicLayerParams,
  parseLightingParams,
  parseVisualStyleParams,
  oneAsset,
} from './SceneStatementParamParsers';
function duration(value: number | undefined): number {
  return value ?? 0;
}

export function resolveCharacterPresenceTransition(params: CharacterPresenceParams): string {
  if (params.mode === 'exit') {
    return params.transition ?? DEFAULT_CHARACTER_EXIT_TRANSITION;
  }
  return params.transition ?? DEFAULT_CHARACTER_ENTER_TRANSITION;
}

export function resolveCharacterPresenceTransitionDuration(params: CharacterPresenceParams): number {
  if (params.durationSeconds !== undefined) return duration(params.durationSeconds);
  if (params.transition === 'none') return 0;
  return DEFAULT_CHARACTER_PRESENCE_TRANSITION_SECONDS;
}

export function resolveEnvironmentLayerTransition(params: EnvironmentLayerParams): string | undefined {
  if (params.mode === 'set') return params.transition ?? DEFAULT_ENVIRONMENT_SET_TRANSITION;
  if (params.mode === 'remove') return params.transition ?? DEFAULT_ENVIRONMENT_REMOVE_TRANSITION;
  return params.transition;
}

export function resolveEnvironmentLayerDuration(params: EnvironmentLayerParams): number {
  if (params.durationSeconds !== undefined) return duration(params.durationSeconds);
  if (params.mode === 'set') return DEFAULT_ENVIRONMENT_SET_DURATION_SECONDS;
  if (params.mode === 'transform') return DEFAULT_ENVIRONMENT_TRANSFORM_DURATION_SECONDS;
  if (params.mode === 'remove') {
    return resolveEnvironmentLayerTransition(params) === 'none'
      ? 0
      : DEFAULT_ENVIRONMENT_REMOVE_DURATION_SECONDS;
  }
  return 0;
}

export function resolveAudioFadeIn(params: AudioParams): number | undefined {
  if (params.mode !== 'play') return undefined;
  if (params.role === 'bgm') {
    return params.fadeIn ?? DEFAULT_AUDIO_BGM_FADE_IN_SECONDS;
  }
  return params.fadeIn;
}

export function resolveAudioFadeOut(params: AudioParams): number | undefined {
  if (params.mode === 'stop') {
    return params.fadeOut ?? DEFAULT_AUDIO_STOP_FADE_OUT_SECONDS;
  }
  return params.fadeOut;
}

/**
 * ADR-0022 placeholder detection for the characterPerformance family: the
 * exact empty-string motion marks a performance placeholder that lowers to no
 * runtime action until a human or enhancement fills a real motion key.
 * Derived, never stored — any non-empty motion turns the same slot into a
 * real performance companion.
 */
export function isCharacterPerformancePlaceholderParams(
  params: CharacterPerformanceParams | { readonly motion?: unknown },
): boolean {
  return params.motion === '';
}

export function isCharacterPerformancePlaceholderCompanion(
  companion: { readonly type: unknown; readonly params: unknown },
): boolean {
  return companion.type === 'characterPerformance'
    && isCharacterPerformancePlaceholderParams(companion.params as CharacterPerformanceParams);
}

export function resolveLifecycleTransitionDuration(
  statement: Pick<SceneStatement, 'type' | 'params'>,
  boundary: 'start' | 'end',
  transitionDurationValue: unknown,
): number {
  if (typeof transitionDurationValue === 'number' && Number.isFinite(transitionDurationValue)) {
    return Math.max(0, transitionDurationValue);
  }

  switch (statement.type) {
    case 'characterPresence':
      return resolveCharacterPresenceTransitionDuration(statement.params as CharacterPresenceParams);
    case 'environmentLayer':
      return resolveEnvironmentLayerDuration(statement.params as EnvironmentLayerParams);
    case 'audio': {
      const params = statement.params as AudioParams;
      const value = boundary === 'start'
        ? resolveAudioFadeIn(params)
        : resolveAudioFadeOut(params);
      return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
    }
    default:
      return 0;
  }
}

function dialogueTimelinePresentation(): SceneStatementTimelinePresentation {
  return { label: '对话', iconKey: 'dialogue' };
}

function characterPresenceTimelinePresentation(params: CharacterPresenceParams): SceneStatementTimelinePresentation {
  return params.mode === 'exit'
    ? { label: '角色退场', iconKey: 'removeCharacter' }
    : { label: '角色登场', iconKey: 'addCharacter' };
}

function characterTransformTimelinePresentation(): SceneStatementTimelinePresentation {
  return { label: '调整角色', iconKey: 'transformCharacter' };
}

function characterPerformanceTimelinePresentation(params: CharacterPerformanceParams): SceneStatementTimelinePresentation {
  if (params.expression) return { label: params.motion ? '角色表演' : '角色表情', iconKey: 'setExpression' };
  if (params.motion) return { label: '角色动作', iconKey: 'playMotion' };
  if (params.lookAt) return { label: '角色视线', iconKey: 'characterLookAt' };
  if (params.blink) return { label: '角色眨眼', iconKey: 'characterBlink' };
  return { label: '角色表演', iconKey: 'playMotion' };
}

function cameraTimelinePresentation(params: CameraParams): SceneStatementTimelinePresentation {
  switch (params.mode) {
    case 'focus':
      return { label: '镜头聚焦', iconKey: 'cameraMotion' };
    case 'move':
      return { label: '镜头移动', iconKey: 'cameraMotion' };
    case 'follow':
      return {
        label: params.operation === 'stop' ? '停止跟随' : '镜头跟随',
        iconKey: 'cameraFollow',
      };
    case 'path':
      return { label: '镜头路径', iconKey: 'cameraPath' };
    case 'shake':
      return { label: '镜头震动', iconKey: 'cameraShake' };
    case 'hitchcock':
      return { label: '希区柯克变焦', iconKey: 'cameraHitchcock' };
    case 'reset':
      return { label: '镜头复位', iconKey: 'cameraReset' };
  }
}

function environmentLayerTimelinePresentation(params: EnvironmentLayerParams): SceneStatementTimelinePresentation {
  if (params.mode === 'transform') return { label: '调整环境画面', iconKey: 'transformEnvironmentLayer' };
  if (params.mode === 'remove') return { label: '收起环境画面', iconKey: 'removeEnvironmentLayer' };
  return { label: '放入环境画面', iconKey: 'setEnvironmentLayer' };
}

function visualStyleTimelinePresentation(params: VisualStyleParams): SceneStatementTimelinePresentation {
  const slotLabel = params.slot === 'grounding'
    ? '角色明暗融入'
    : params.slot === 'integration'
      ? '角色色彩融入'
      : params.slot === 'rim-light'
        ? '角色轮廓光'
        : params.slot === 'accent'
          ? '角色风格强调'
          : '角色异化';
  if (params.mode === 'reset') return { label: `重置${slotLabel}`, iconKey: 'resetCompositeRecipe' };
  if (params.mode === 'modulate') return { label: `变化${slotLabel}`, iconKey: 'modulateComposite' };
  return { label: `设置${slotLabel}`, iconKey: params.slot === 'rim-light' ? 'setCharacterRimLight' : 'setCompositeRecipe' };
}

/** @deprecated Render historical lens filter statements in the timeline only. */
function filterAddTimelinePresentation(): SceneStatementTimelinePresentation {
  return { label: '添加滤镜', iconKey: 'addLensFilter' };
}

/** @deprecated Render historical lens filter statements in the timeline only. */
function filterChangeTimelinePresentation(): SceneStatementTimelinePresentation {
  return { label: '变化滤镜', iconKey: 'changeLensFilter' };
}

/** @deprecated Render historical lens filter statements in the timeline only. */
function filterResetTimelinePresentation(): SceneStatementTimelinePresentation {
  return { label: '重置滤镜', iconKey: 'resetLensFilters' };
}

function lightingTimelinePresentation(params: LightingParams): SceneStatementTimelinePresentation {
  const singletonLabels = {
    preset: '光照预设',
    blur: '模糊',
    godrays: '体积光',
    post: '后期处理',
  } as const;
  const singletonIcons = {
    preset: { set: 'setLighting', modulate: 'setLighting', reset: 'resetLighting' },
    blur: { set: 'setBlur', modulate: 'setBlur', reset: 'resetBlur' },
    godrays: { set: 'setGodrays', modulate: 'setGodrays', reset: 'resetGodrays' },
    post: { set: 'setPostProcessing', modulate: 'setPostProcessing', reset: 'resetPostProcessing' },
  } as const;
  if (params.effect in singletonLabels) {
    const label = singletonLabels[params.effect as keyof typeof singletonLabels];
    const icons = singletonIcons[params.effect as keyof typeof singletonIcons];
    if (params.mode === 'reset') return { label: `重置${label}`, iconKey: icons.reset };
    if (params.mode === 'modulate') return { label: `变化${label}`, iconKey: icons.modulate };
    return { label: `设置${label}`, iconKey: icons.set };
  }
  const label = params.effect === 'overlay' ? '色彩叠加' : '点光源';
  if (params.mode === 'clear') return { label: `清除全部${label}`, iconKey: params.effect === 'overlay' ? 'clearColorOverlays' : 'clearPointLights' };
  if (params.mode === 'remove') return { label: `移除${label}`, iconKey: params.effect === 'overlay' ? 'removeColorOverlay' : 'removePointLight' };
  if (params.mode === 'modulate') return { label: `变化${label}`, iconKey: params.effect === 'overlay' ? 'addColorOverlay' : 'addPointLight' };
  return { label: `添加${label}`, iconKey: params.effect === 'overlay' ? 'addColorOverlay' : 'addPointLight' };
}

function audioTimelinePresentation(params: AudioParams): SceneStatementTimelinePresentation {
  if (params.role === 'bgm') {
    return params.mode === 'stop'
      ? { label: '停止 BGM', iconKey: 'stopAudio' }
      : { label: 'BGM', iconKey: 'setBGM' };
  }
  return params.mode === 'stop'
    ? { label: '停止音效', iconKey: 'stopAudio' }
    : { label: '音效', iconKey: 'playAudio' };
}

function graphicLayerTimelinePresentation(params: GraphicLayerParams): SceneStatementTimelinePresentation {
  if (params.kind === 'text') {
    if (params.mode === 'transform') return { label: '调整文字', iconKey: 'transformTextLayer' };
    if (params.mode === 'remove') return { label: '移除文字', iconKey: 'removeTextLayer' };
    return { label: '文字', iconKey: 'addTextLayer' };
  }
  if (params.mode === 'transform') return { label: '调整图片', iconKey: 'transformImage' };
  if (params.mode === 'remove') return { label: '移除图片', iconKey: 'removeImage' };
  return { label: '图片', iconKey: 'addImage' };
}

function customAnimationTimelinePresentation(): SceneStatementTimelinePresentation {
  return { label: '特效', iconKey: 'playCustomAnimation' };
}

function lifecyclePresentation<Family extends StatementFamily>(
  definition: SceneStatementLifecyclePresentation<Family>,
): SceneStatementLifecyclePresentation<Family> {
  return definition;
}

const definitions = {
  dialogueVisibility: {
    family: 'dialogueVisibility',
    minimumSceneSchemaVersion: 5,
    category: 'dialogue',
    label: 'Dialogue Visibility',
    discriminators: ['type'],
    parseParams: (input, path) => {
      const record = expectRecord(input, path);
      expectKeys(record, path, ['visible', 'durationSeconds']);
      const visible = optionalBoolean(record.visible, `${path}.visible`);
      if (visible === undefined) throw new Error(`Expected boolean at ${path}.visible`);
      return compact({
        visible,
        durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
      });
    },
    temporalExtent: (params) => duration(params.durationSeconds),
    collectAssetReferences: () => [],
    timelinePresentation: (params) => ({
      label: params.visible ? '显示字幕框' : '隐藏字幕框',
      iconKey: 'dialogue',
    }),
  },
  dialogue: {
    family: 'dialogue',
    category: 'dialogue',
    label: 'Dialogue',
    discriminators: ['type'],
    parseParams: parseDialogueParams,
    temporalExtent: (params) => params.durationSeconds,
    collectAssetReferences: collectDialogueAssets,
    compiledAssetSlots: [
      { outputKey: 'primary', path: 'params.voice', kind: 'vocal' },
      { outputKey: 'primary', path: 'params.presentation.textbox.image', kind: 'images' },
      { outputKey: 'primary', path: 'params.presentation.namebox.image', kind: 'images' },
      { outputKey: 'primary', path: 'params.presentation.text.fontFile', kind: 'images' },
      { outputKey: 'primary', path: 'params.presentation.speaker.fontFile', kind: 'images' },
    ],
    sourceAssetSlots: [
      { path: 'params.voice', kind: 'vocal', resourceKind: 'voice' },
      { path: 'params.presentation.textbox.image', kind: 'images', resourceKind: 'image' },
      { path: 'params.presentation.namebox.image', kind: 'images', resourceKind: 'image' },
      { path: 'params.presentation.text.fontFile', kind: 'images', resourceKind: 'font' },
      { path: 'params.presentation.speaker.fontFile', kind: 'images', resourceKind: 'font' },
    ],
    timelinePresentation: dialogueTimelinePresentation,
  },
  characterPresence: {
    family: 'characterPresence',
    category: 'character',
    label: 'Character Presence',
    discriminators: ['params.mode'],
    parseParams: parseCharacterPresenceParams,
    temporalExtent: resolveCharacterPresenceTransitionDuration,
    collectAssetReferences: (params) => oneAsset('params.model', params.model, 'figure', 'live2dModel'),
    compiledAssetSlots: [{ outputKey: 'primary', path: 'params.model', kind: 'figure' }],
    sourceAssetSlots: [{ path: 'params.model', kind: 'figure', resourceKind: 'live2dModel' }],
    timelinePresentation: characterPresenceTimelinePresentation,
    lifecyclePresentations: [lifecyclePresentation<'characterPresence'>({
      variant: 'presence',
      presentationTypeKey: 'characterPresence:presence',
      operationField: 'mode',
      startOperations: ['enter'],
      endOperations: ['exit'],
      target: { namespace: 'character', fields: ['id'] },
      transitionDurationFields: { start: 'durationSeconds', end: 'durationSeconds' },
      configurable: true,
      settingsLabel: '角色在场',
      settingsGroup: '角色',
      settingsOrder: 100,
      defaultPreference: 'endpoint',
    })],
  },
  characterTransform: {
    family: 'characterTransform',
    category: 'character',
    label: 'Character Transform',
    discriminators: [],
    parseParams: parseCharacterTransformParams,
    temporalExtent: (params) => duration(params.durationSeconds),
    collectAssetReferences: () => [],
    compiledAssetSlots: [],
    timelinePresentation: characterTransformTimelinePresentation,
    stateSpanDependencies: [{
      presentationTypeKey: 'characterPresence:presence',
      target: { namespace: 'character', fields: ['id'] },
    }],
  },
  characterPerformance: {
    family: 'characterPerformance',
    category: 'character',
    label: 'Character Performance',
    discriminators: ['params.motion', 'params.expression', 'params.lookAt', 'params.blink'],
    attachableTo: ['dialogue'],
    parseParams: parseCharacterPerformanceParams,
    temporalExtent: (params) => typeof params.motion === 'object' && params.motion.kind === 'custom'
      ? params.motion.durationSeconds
      : 0,
    collectAssetReferences: () => [],
    compiledAssetSlots: [],
    timelinePresentation: characterPerformanceTimelinePresentation,
  },
  camera: {
    family: 'camera',
    category: 'camera',
    label: 'Camera',
    discriminators: ['params.mode'],
    attachableTo: ['dialogue'],
    parseParams: parseCameraParams,
    temporalExtent: (params) => {
      if (params.mode === 'path') {
        const lastKeyframe = params.keyframes.reduce((max, keyframe) => Math.max(max, keyframe.time), 0);
        return Math.max(duration(params.durationSeconds), lastKeyframe);
      }
      if (params.mode === 'follow') return 0;
      return duration(params.durationSeconds);
    },
    collectAssetReferences: () => [],
    compiledAssetSlots: [],
    timelinePresentation: cameraTimelinePresentation,
    lifecyclePresentations: [lifecyclePresentation<'camera'>({
      variant: 'follow',
      presentationTypeKey: 'camera:follow',
      when: { mode: 'follow' },
      operationField: 'operation',
      startOperations: ['start'],
      endOperations: ['stop'],
      target: { namespace: 'camera:follow', fields: [] },
      configurable: true,
      settingsLabel: '镜头跟随',
      settingsGroup: '镜头与视觉',
      settingsOrder: 400,
      defaultPreference: 'auto',
    })],
    isAttachable: (params, parentFamily) => parentFamily === 'dialogue' && params.mode === 'focus',
  },
  environmentLayer: {
    family: 'environmentLayer',
    category: 'scene',
    label: 'Environment Layer',
    discriminators: ['params.mode'],
    parseParams: parseEnvironmentLayerParams,
    temporalExtent: resolveEnvironmentLayerDuration,
    collectAssetReferences: (params) => [
      ...oneAsset('params.file', params.file, 'background', 'background'),
      ...oneAsset('params.image', params.image, 'background', 'background'),
    ],
    compiledAssetSlots: [{ outputKey: 'primary', path: 'params.image', kind: 'background' }],
    sourceAssetSlots: [
      { path: 'params.file', kind: 'background', resourceKind: 'background' },
      { path: 'params.image', kind: 'background', resourceKind: 'background' },
    ],
    timelinePresentation: environmentLayerTimelinePresentation,
    lifecyclePresentations: [lifecyclePresentation<'environmentLayer'>({
      variant: 'layer',
      presentationTypeKey: 'environmentLayer:layer',
      operationField: 'mode',
      startOperations: ['set'],
      endOperations: ['remove'],
      target: { namespace: 'environmentLayer', fields: ['layerId'] },
      transitionDurationFields: { start: 'durationSeconds', end: 'durationSeconds' },
      configurable: true,
      settingsLabel: '环境/背景图层',
      settingsGroup: '场景与图层',
      settingsOrder: 200,
      defaultPreference: 'auto',
    })],
    stateSpanDependencies: [{
      presentationTypeKey: 'environmentLayer:layer',
      operationField: 'mode',
      operations: ['transform'],
      target: { namespace: 'environmentLayer', fields: ['layerId'] },
    }],
  },
  visualStyle: {
    family: 'visualStyle',
    category: 'visual',
    label: 'Visual Style',
    discriminators: ['params.scope', 'params.mode'],
    attachableTo: ['dialogue'],
    parseParams: parseVisualStyleParams,
    temporalExtent: (params) => duration(params.durationSeconds),
    collectAssetReferences: () => [],
    compiledAssetSlots: [],
    timelinePresentation: visualStyleTimelinePresentation,
    lifecyclePresentations: [lifecyclePresentation<'visualStyle'>({
        variant: 'object',
        presentationTypeKey: 'visualStyle:object',
        when: { scope: 'object' },
        operationField: 'mode',
        startOperations: ['set'],
        endOperations: ['reset'],
        target: { namespace: 'visualStyle:object', fields: ['target', 'slot'] },
        transitionDurationFields: { start: 'durationSeconds', end: 'durationSeconds' },
        configurable: true,
        settingsLabel: '对象画面风格',
        settingsGroup: '镜头与视觉',
        settingsOrder: 420,
        defaultPreference: 'endpoint',
      })],
    stateSpanDependencies: [{
        presentationTypeKey: 'visualStyle:object',
        when: { scope: 'object' },
        operationField: 'mode',
        operations: ['modulate'],
        target: { namespace: 'visualStyle:object', fields: ['target', 'slot'] },
      }],
  },
  // @deprecated Historical compatibility definition; no new authoring entry.
  filterAdd: {
    family: 'filterAdd',
    category: 'visual',
    label: '添加滤镜',
    discriminators: [],
    parseParams: parseFilterAddParams,
    temporalExtent: resolveFilterTransitionDuration,
    collectAssetReferences: () => [],
    timelinePresentation: filterAddTimelinePresentation,
  },
  // @deprecated Historical compatibility definition; no new authoring entry.
  filterChange: {
    family: 'filterChange',
    category: 'visual',
    label: '变化滤镜',
    discriminators: [],
    parseParams: parseFilterChangeParams,
    temporalExtent: resolveFilterTransitionDuration,
    collectAssetReferences: () => [],
    timelinePresentation: filterChangeTimelinePresentation,
  },
  // @deprecated Historical compatibility definition; no new authoring entry.
  filterReset: {
    family: 'filterReset',
    category: 'visual',
    label: '重置滤镜',
    discriminators: [],
    parseParams: parseFilterResetParams,
    temporalExtent: resolveFilterTransitionDuration,
    collectAssetReferences: () => [],
    timelinePresentation: filterResetTimelinePresentation,
  },
  lighting: {
    family: 'lighting',
    category: 'visual',
    label: 'Lighting',
    discriminators: ['params.effect', 'params.mode'],
    parseParams: parseLightingParams,
    temporalExtent: (params) => duration(params.durationSeconds),
    collectAssetReferences: () => [],
    compiledAssetSlots: [],
    timelinePresentation: lightingTimelinePresentation,
    lifecyclePresentations: [
      ...(['blur', 'post'] as const).map((effect, index) => lifecyclePresentation<'lighting'>({
        variant: effect,
        presentationTypeKey: `lighting:${effect}`,
        when: { effect },
        operationField: 'mode',
        startOperations: ['set'],
        endOperations: ['reset'],
        target: { namespace: `lighting:${effect}`, fields: [], optionalFields: ['target'] },
        transitionDurationFields: { start: 'durationSeconds', end: 'durationSeconds' },
        configurable: true,
        settingsLabel: ({ blur: '模糊', post: '后期处理' } as const)[effect],
        settingsGroup: '镜头与视觉',
        settingsOrder: 430 + index,
        defaultPreference: 'endpoint',
      })),
      lifecyclePresentation<'lighting'>({
        variant: 'overlay',
        presentationTypeKey: 'lighting:overlay',
        when: { effect: 'overlay' },
        operationField: 'mode',
        startOperations: ['set'],
        endOperations: ['remove'],
        target: { namespace: 'lighting:overlay', fields: ['id'] },
        transitionDurationFields: { start: 'durationSeconds', end: 'durationSeconds' },
        configurable: true,
        settingsLabel: '色彩叠加',
        settingsGroup: '镜头与视觉',
        settingsOrder: 440,
        defaultPreference: 'endpoint',
      }),
      lifecyclePresentation<'lighting'>({
        variant: 'pointLight',
        presentationTypeKey: 'lighting:pointLight',
        when: { effect: 'pointLight' },
        operationField: 'mode',
        startOperations: ['set'],
        endOperations: ['remove'],
        target: { namespace: 'lighting:pointLight', fields: ['id'] },
        transitionDurationFields: { start: 'durationSeconds', end: 'durationSeconds' },
        configurable: true,
        settingsLabel: '点光源',
        settingsGroup: '镜头与视觉',
        settingsOrder: 450,
        defaultPreference: 'endpoint',
      }),
    ],
    stateSpanDependencies: [
      ...(['blur', 'post'] as const).map((effect) => ({
        presentationTypeKey: `lighting:${effect}`,
        when: { effect },
        operationField: 'mode',
        operations: ['modulate'],
        target: { namespace: `lighting:${effect}`, fields: [], optionalFields: ['target'] },
        inheritFields: ['target'],
      })),
      {
        presentationTypeKey: 'lighting:overlay',
        when: { effect: 'overlay' },
        operationField: 'mode',
        operations: ['modulate'],
        target: { namespace: 'lighting:overlay', fields: ['id'] },
        inheritFields: ['color', 'blendMode', 'intensity'],
      },
      {
        presentationTypeKey: 'lighting:pointLight',
        when: { effect: 'pointLight' },
        operationField: 'mode',
        operations: ['modulate'],
        target: { namespace: 'lighting:pointLight', fields: ['id'] },
        inheritFields: ['x', 'y', 'color', 'radius', 'intensity'],
      },
    ],
  },
  audio: {
    family: 'audio',
    category: 'audio',
    label: 'Audio',
    discriminators: ['params.role', 'params.mode'],
    attachableTo: ['dialogue'],
    parseParams: parseAudioParams,
    temporalExtent: (params) => params.role === 'sfx' && params.mode === 'play' ? duration(params.durationSeconds) : 0,
    collectAssetReferences: (params) => params.mode === 'play'
      ? oneAsset('params.file', params.file, params.role === 'bgm' ? 'bgm' : 'generic', params.role === 'bgm' ? 'bgm' : 'sfx')
      : [],
    compiledAssetSlots: [{ outputKey: 'primary', path: 'params.file', kind: 'bgm' }],
    sourceAssetSlots: [{ path: 'params.file', kind: 'bgm', resourceKind: 'bgm' }],
    timelinePresentation: audioTimelinePresentation,
    lifecyclePresentations: [lifecyclePresentation<'audio'>({
      variant: 'bgm',
      presentationTypeKey: 'audio:bgm',
      when: { role: 'bgm' },
      operationField: 'mode',
      startOperations: ['play'],
      endOperations: ['stop'],
      target: { namespace: 'audio:bgm', fields: [] },
      transitionDurationFields: { start: 'fadeIn', end: 'fadeOut' },
      configurable: true,
      settingsLabel: '背景音乐',
      settingsGroup: '音频',
      settingsOrder: 300,
      defaultPreference: 'span',
    })],
    isAttachable: (params, parentFamily) => parentFamily === 'dialogue' && params.role === 'sfx' && params.mode === 'play',
  },
  graphicLayer: {
    family: 'graphicLayer',
    category: 'layer',
    label: 'Graphic Layer',
    discriminators: ['params.kind', 'params.mode'],
    parseParams: parseGraphicLayerParams,
    temporalExtent: (params) => duration(params.durationSeconds),
    collectAssetReferences: (params) => params.kind === 'image' ? oneAsset('params.file', params.file, 'images', 'image') : [],
    compiledAssetSlots: [{ outputKey: 'primary', path: 'params.file', kind: 'images' }],
    sourceAssetSlots: [{ path: 'params.file', kind: 'images', resourceKind: 'image' }],
    timelinePresentation: graphicLayerTimelinePresentation,
    lifecyclePresentations: [
      lifecyclePresentation<'graphicLayer'>({
        variant: 'image',
        presentationTypeKey: 'graphicLayer:image',
        when: { kind: 'image' },
        operationField: 'mode',
        startOperations: ['set'],
        endOperations: ['remove'],
        target: { namespace: 'graphicLayer:image', fields: ['id'] },
        transitionDurationFields: { start: 'durationSeconds', end: 'durationSeconds' },
        configurable: true,
        settingsLabel: '图片图层',
        settingsGroup: '场景与图层',
        settingsOrder: 210,
        defaultPreference: 'auto',
      }),
      lifecyclePresentation<'graphicLayer'>({
        variant: 'text',
        presentationTypeKey: 'graphicLayer:text',
        when: { kind: 'text' },
        operationField: 'mode',
        startOperations: ['set'],
        endOperations: ['remove'],
        target: { namespace: 'graphicLayer:text', fields: ['id'] },
        transitionDurationFields: { start: 'durationSeconds', end: 'durationSeconds' },
        configurable: true,
        settingsLabel: '文字图层',
        settingsGroup: '场景与图层',
        settingsOrder: 220,
        defaultPreference: 'auto',
      }),
    ],
    stateSpanDependencies: [
      {
        presentationTypeKey: 'graphicLayer:image',
        when: { kind: 'image' },
        operationField: 'mode',
        operations: ['transform'],
        target: { namespace: 'graphicLayer:image', fields: ['id'] },
      },
      {
        presentationTypeKey: 'graphicLayer:text',
        when: { kind: 'text' },
        operationField: 'mode',
        operations: ['transform'],
        target: { namespace: 'graphicLayer:text', fields: ['id'] },
      },
    ],
  },
  customAnimation: {
    family: 'customAnimation',
    category: 'layer',
    label: 'Custom Animation',
    discriminators: [],
    parseParams: parseCustomAnimationParams,
    temporalExtent: (params) => params.durationSeconds,
    collectAssetReferences: (params) => [
      ...oneAsset('params.file', params.file, 'animation', 'animation'),
      ...oneAsset('params.animation', params.animation, 'animation', 'animation'),
    ],
    compiledAssetSlots: [{ outputKey: 'primary', path: 'params.file', kind: 'animation' }],
    sourceAssetSlots: [
      { path: 'params.file', kind: 'animation', resourceKind: 'animation' },
      { path: 'params.animation', kind: 'animation', resourceKind: 'animation' },
    ],
    timelinePresentation: customAnimationTimelinePresentation,
  },
} satisfies SceneStatementDefinitionMap;

export const SCENE_STATEMENT_DEFINITIONS: SceneStatementDefinitionMap = Object.freeze(definitions);

/**
 * Default patch metadata. Statement/companion UUIDs are structural host identity
 * and never appear in the model-facing line projection (only `params` are shown).
 * Nested authoring keys such as character `id`, layerId, recipeId stay visible:
 * this table must not blanket-hide every field named `id`.
 */
const DEFAULT_STATEMENT_FORBIDDEN = ['id', 'time', 'companions'] as const;
const DEFAULT_COMPANION_FORBIDDEN = ['id'] as const;

function defaultPatchMetadata(): SceneStatementPatchMetadata {
  return {
    hiddenTechnicalIdentityPaths: [],
    statementForbiddenPatchPaths: DEFAULT_STATEMENT_FORBIDDEN,
    companionForbiddenPatchPaths: DEFAULT_COMPANION_FORBIDDEN,
  };
}

export const SCENE_STATEMENT_PATCH_METADATA: Readonly<{
  [Family in StatementFamily]: SceneStatementPatchMetadata;
}> = Object.freeze({
  dialogue: defaultPatchMetadata(),
  dialogueVisibility: defaultPatchMetadata(),
  characterPresence: defaultPatchMetadata(),
  characterTransform: defaultPatchMetadata(),
  characterPerformance: defaultPatchMetadata(),
  camera: defaultPatchMetadata(),
  environmentLayer: defaultPatchMetadata(),
  visualStyle: defaultPatchMetadata(),
  filterAdd: defaultPatchMetadata(),
  filterChange: defaultPatchMetadata(),
  filterReset: defaultPatchMetadata(),
  lighting: defaultPatchMetadata(),
  audio: defaultPatchMetadata(),
  graphicLayer: defaultPatchMetadata(),
  customAnimation: defaultPatchMetadata(),
});

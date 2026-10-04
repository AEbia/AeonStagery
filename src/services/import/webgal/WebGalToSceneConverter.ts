import type {
  AudioParams,
  CharacterPerformanceParams,
  CharacterPresenceParams,
  CharacterTransformParams,
  DialogueParams,
  EnvironmentLayerParams,
  CurrentSceneMeta,
  LightingPostProcessingParams,
  VisualStyleParams,
} from '../../../api/types/semantic-scene';
import {
  sceneStatementFactory,
  type SceneStatementCreationDraft,
} from '../../semantic-scene/SceneStatementFactory';
import {
  TRANSITION_DURATIONS,
  resolveDialogueDuration,
} from '../../pacing/pacing';
import { parseWebGalScript } from './WebGalScriptParser';
import {
  hasFilterEffects,
  parseWebGalTransform,
  readMillisecondsAsSeconds,
  resolveWebGalEase,
  type WebGalTransformEffects,
} from './WebGalTransformEffects';
import type {
  WebGalFlagValue,
  WebGalImportInput,
  WebGalImportOptions,
  WebGalImportReport,
  WebGalImportResult,
  WebGalSentence,
} from './WebGalImportTypes';

const SCENE_FPS = 60;
const SCENE_RESOLUTION: [number, number] = [1920, 1080];
// WebGAL renders on a 2560x1440 stage; its `-transform` positions are pixels
// relative to the stage center in that coordinate space.
const WEBGAL_STAGE_WIDTH = 2560;
const WEBGAL_STAGE_HEIGHT = 1440;
// Maps WebGAL's typical figure scale (0.8 = 80% of the WebGAL stage) onto
// AeonStagery's standing size of 110% of the 1080-tall stage, so a `scale: 0.8`
// figure converts to `scale: 1.1`.
const SCALE_COMPENSATION = 1.1 / 0.8;

// WebGAL attaches dialogue voice as a bare `-path.wav` flag. Anything that
// looks like an audio file and carries no value is treated as the voice.
const AUDIO_FLAG_PATTERN = /\.(wav|ogg|mp3|m4a|flac|aac)$/i;

interface CharacterRecord {
  id: string;
  name: string;
  model?: string;
}

interface TrackedTransform {
  position?: [number, number];
  scale?: number;
  opacity?: number;
  rotation?: number;
  z?: number;
}

/** WebGAL boolean flags parse as `-flag` with an `undefined` value. */
function hasFlag(flags: Record<string, WebGalFlagValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(flags, key);
}

interface ConversionContext {
  cursor: number;
  drafts: SceneStatementCreationDraft[];
  characters: Map<string, CharacterRecord>;
  speakerToCharacterId: Map<string, string>;
  figureIdToCharacterId: Map<string, string>;
  lastTransform: Map<string, TrackedTransform>;
  currentModel: Map<string, string>;
  present: Set<string>;
  lastFocusedCharacterId?: string;
  fallbackCharacterIndex: number;
  /** setTransition registers the next enter/exit preset per target id. */
  pendingTransitions: Map<string, { enter?: string; exit?: string }>;
  mountId?: string;
  duration: WebGalImportOptions['duration'];
  report: WebGalImportReport;
  voiceWithoutMountLines: number[];
}

/**
 * Merges a WebGAL import input's script parts into one raw script text, in
 * selection order. A single conversion of the merged text produces one
 * continuous scene timeline: stage state (background, figures, audio) carries
 * across chapter boundaries, so playback never pauses between scripts.
 * Each part's leading BOM is dropped so later files parse cleanly.
 *
 * Between two parts a synthetic `chapterBreak:<transition>;` marker is
 * inserted. The converter handles the marker by exiting every on-stage
 * character and applying the requested background treatment.
 */
export function joinWebGalScriptTexts(input: WebGalImportInput): string {
  const parts = [
    input.scriptText,
    ...(input.additionalScripts ?? []).map((part) => part.scriptText),
  ];
  if (parts.length <= 1) return input.scriptText.replace(/^\uFEFF/, '');
  const transition = input.chapterTransition ?? 'black';
  const marker = `\nchapterBreak:${transition};\n`;
  return parts.map((text) => text.replace(/^\uFEFF/, '')).join(marker);
}

export function convertWebGalToSceneDocument(
  rawScript: string,
  options: WebGalImportOptions = {},
): WebGalImportResult {
  const { sentences } = parseWebGalScript(rawScript);
  const report: WebGalImportReport = {
    stats: {
      narrationCount: 0,
      dialogueCount: 0,
      multiSpeakerCount: 0,
      backgroundChanges: 0,
      figureEnters: 0,
      figureExits: 0,
      transforms: 0,
      performances: 0,
      cameraFocuses: 0,
      bgmCount: 0,
      sfxCount: 0,
    },
    characters: [],
    notes: [],
    unsupportedCommands: [],
  };

  const context: ConversionContext = {
    cursor: 0,
    drafts: [],
    characters: new Map(),
    speakerToCharacterId: new Map(),
    figureIdToCharacterId: new Map(),
    lastTransform: new Map(),
    currentModel: new Map(),
    present: new Set(),
    fallbackCharacterIndex: 0,
    pendingTransitions: new Map(),
    mountId: options.mountId,
    duration: options.duration,
    report,
    voiceWithoutMountLines: [],
  };

  for (const sentence of sentences) {
    switch (sentence.kind) {
      case 'narration':
        convertTextSentence(sentence, undefined, context);
        break;
      case 'dialogue':
        convertTextSentence(sentence, sentence.speaker, context);
        break;
      case 'command':
        consumeCommand(sentence, context);
        break;
    }
  }

  if (context.voiceWithoutMountLines.length > 0) {
    context.report.notes.push({
      lineNumber: context.voiceWithoutMountLines[0],
      message: `剧本中 ${context.voiceWithoutMountLines.length} 句台词带配音，但未选择素材目录，配音无法挂载播放；时长按文字估算。`,
    });
  }

  const meta: CurrentSceneMeta = {
    title: options.sceneTitle ?? '导入的 WebGAL 剧本',
    fps: SCENE_FPS,
    resolution: SCENE_RESOLUTION,
    characters: [...context.characters.values()].map((character) => ({
      id: character.id,
      name: character.name,
      ...(character.model ? { model: character.model } : {}),
    })),
    markers: [],
  };

  const document = sceneStatementFactory.createDocument({
    meta,
    statements: context.drafts,
  });

  report.characters = [...context.characters.values()].map((character) => ({
    id: character.id,
    name: character.name,
    ...(character.model ? { model: character.model } : {}),
  }));

  return { document, report };
}

function convertTextSentence(
  sentence: Extract<WebGalSentence, { kind: 'narration' | 'dialogue' }>,
  speaker: string | undefined,
  context: ConversionContext,
): void {
  const isMultiSpeaker = speaker !== undefined && speaker.includes(' & ');
  const speakerId = speaker && !isMultiSpeaker
    ? resolveSpeakerId(
        sentence as Extract<WebGalSentence, { kind: 'dialogue' }>,
        speaker,
        context,
      )
    : undefined;

  if (speaker) {
    context.report.stats.dialogueCount += 1;
    if (isMultiSpeaker) context.report.stats.multiSpeakerCount += 1;
  } else {
    context.report.stats.narrationCount += 1;
  }

  const durationSeconds = resolveDialogueDuration({
    context: 'reading-speed',
    text: sentence.text,
    options: context.duration,
  });
  const voice = findVoiceFlagValue(sentence.flags);
  const params: DialogueParams = {
    ...(speakerId ? { speakerId } : {}),
    ...(speaker ? { speaker } : {}),
    text: sentence.text,
    durationSeconds,
    ...(voice ? { voice: toVoiceReference(voice, context, sentence.lineNumber) } : {}),
  };
  context.drafts.push({ time: context.cursor, type: 'dialogue', params });
  context.cursor += durationSeconds;
}

function consumeCommand(sentence: Extract<WebGalSentence, { kind: 'command' }>, context: ConversionContext): void {
  const { command, content, flags, lineNumber } = sentence;
  const isNext = Object.prototype.hasOwnProperty.call(flags, 'next');

  let duration = 0;
  switch (command) {
    case 'changebg':
      duration = handleChangeBg(content, lineNumber, context, flags);
      break;
    case 'changefigure':
      duration = handleChangeFigure(sentence, context);
      break;
    case 'settransform':
      duration = handleSetTransform(sentence, context);
      break;
    case 'bgm':
    case 'playbgm':
      duration = handleBgm(sentence, context);
      break;
    case 'stopbgm':
      duration = handleBgmStop(context);
      break;
    case 'playeffect':
      duration = handlePlayEffect(sentence, context);
      break;
    case 'stopeffect':
      duration = handleStopEffect(sentence, context);
      break;
    case 'settempanimation':
      duration = handleSetTempAnimation(sentence, context);
      break;
    case 'setcomplexanimation':
      duration = handleSetComplexAnimation(sentence, context);
      break;
    case 'settransition':
      duration = handleSetTransition(sentence, context);
      break;
    case 'intro':
      duration = handleIntro(sentence, context);
      break;
    case 'wait':
      duration = handleWait(sentence, context);
      break;
    case 'chapterbreak':
      duration = handleChapterBreak(sentence, context);
      break;
    default:
      context.report.unsupportedCommands.push({ command, lineNumber, raw: sentence.raw });
      return;
  }

  // WebGAL `-next` chains the following sentence immediately (a single burst),
  // so it does NOT advance the cursor. A command without `-next` is a pause
  // point: it advances the timeline by its own animation duration.
  if (!isNext) context.cursor += duration;
}

function handleChangeBg(
  content: string,
  lineNumber: number,
  context: ConversionContext,
  flags: Record<string, WebGalFlagValue>,
): number {
  const trimmed = content.trim().toLowerCase();
  const pendingTransition = takePendingTransition('bg-main', context);
  if (trimmed === '' || trimmed === 'none') {
    // WebGAL: an empty changeBg removes the background.
    const exitDuration = readMillisecondsAsSeconds(flags.exitDuration)
      ?? readMillisecondsAsSeconds(flags.duration)
      ?? TRANSITION_DURATIONS.backgroundChange;
    const params: EnvironmentLayerParams = {
      mode: 'remove',
      layerId: 'background',
      durationSeconds: exitDuration,
      transition: pendingTransition.exit ?? 'fadeOut',
    };
    const ease = resolveWebGalEase(flags.ease);
    if (ease) params.ease = ease;
    context.drafts.push({ time: context.cursor, type: 'environmentLayer', params });
    return exitDuration;
  }

  const file = toAssetReference(content, 'background', context);
  const enterDuration = readMillisecondsAsSeconds(flags.enterDuration)
    ?? readMillisecondsAsSeconds(flags.duration)
    ?? TRANSITION_DURATIONS.backgroundChange;
  const params: EnvironmentLayerParams = {
    mode: 'set',
    layerId: 'background',
    file,
    durationSeconds: enterDuration,
    // Background transitions only support fades; any WebGAL preset becomes a cross-fade.
    transition: pendingTransition.enter ? 'crossFade' : 'fadeIn',
  };
  const ease = resolveWebGalEase(flags.ease);
  if (ease) params.ease = ease;
  context.drafts.push({ time: context.cursor, type: 'environmentLayer', params });
  context.report.stats.backgroundChanges += 1;
  emitTransformEffects(
    parseWebGalTransform(flags.transform),
    { kind: 'background', lineNumber, durationSeconds: enterDuration },
    context,
  );
  return enterDuration;
}

/**
 * WebGAL `changeFigure` sets the figure's current state — it is NOT an
 * entrance. This handler tracks which characters are on stage:
 * - an absent character emits an entrance (enter);
 * - a present character only changing motion/expression/blink emits a
 *   performance statement;
 * - a present character given a new model emits a re-model entrance
 *   (the runtime swaps the model, preserving position);
 * - a present character moved/scaled via `-transform` emits a transform;
 * - an empty or `none` figure content emits an exit.
 */
function handleChangeFigure(
  sentence: Extract<WebGalSentence, { kind: 'command' }>,
  context: ConversionContext,
): number {
  const { content, flags, lineNumber } = sentence;

  if (content.trim() === '' || content.trim().toLowerCase() === 'none') {
    return handleFigureExit(sentence, context);
  }

  const model = toAssetReference(content, 'figure', context);
  // WebGAL: -left / -right without an -id default to the fig-left / fig-right ids.
  const figureId = flags.id
    ?? (hasFlag(flags, 'left') ? 'fig-left' : hasFlag(flags, 'right') ? 'fig-right' : undefined);
  const characterId = resolveFigureCharacterId(figureId, content, context);
  ensureCharacterModel(characterId, model, context);
  const pendingTransition = takePendingTransition(figureId ?? 'fig-center', context);
  const enterDuration = readMillisecondsAsSeconds(flags.enterDuration)
    ?? readMillisecondsAsSeconds(flags.duration)
    ?? TRANSITION_DURATIONS.figureEnter;
  const ease = resolveWebGalEase(flags.ease);

  let duration = 0;

  if (!context.present.has(characterId)) {
    duration = enterDuration;
    const presenceParams: CharacterPresenceParams = {
      mode: 'enter',
      id: characterId,
      model,
      durationSeconds: enterDuration,
      transition: pendingTransition.enter ?? 'fadeIn',
    };
    if (ease) presenceParams.ease = ease;
    applyTrackedTransform(presenceParams, characterId, flags.transform, context);
    applyPositionPreset(presenceParams, characterId, flags, context);
    applyZIndex(presenceParams, characterId, flags, context);
    context.drafts.push({ time: context.cursor, type: 'characterPresence', params: presenceParams });
    context.report.stats.figureEnters += 1;
    context.present.add(characterId);
    context.currentModel.set(characterId, model);
    emitTransformEffects(
      parseWebGalTransform(flags.transform),
      { kind: 'character', characterId, lineNumber, durationSeconds: enterDuration },
      context,
    );
  } else if (context.currentModel.get(characterId) !== model) {
    // Outfit/model swap: re-model the on-stage character, preserving its
    // tracked transform so it does not jump back to the default placement.
    duration = enterDuration;
    const presenceParams: CharacterPresenceParams = {
      mode: 'enter',
      id: characterId,
      model,
      durationSeconds: enterDuration,
      transition: pendingTransition.enter ?? 'fadeIn',
    };
    if (ease) presenceParams.ease = ease;
    applyTrackedTransform(presenceParams, characterId, flags.transform, context);
    applyPositionPreset(presenceParams, characterId, flags, context);
    applyZIndex(presenceParams, characterId, flags, context);
    context.drafts.push({ time: context.cursor, type: 'characterPresence', params: presenceParams });
    context.report.stats.figureEnters += 1;
    context.currentModel.set(characterId, model);
    emitTransformEffects(
      parseWebGalTransform(flags.transform),
      { kind: 'character', characterId, lineNumber, durationSeconds: enterDuration },
      context,
    );
  } else {
    // Present character, same model: a state update. Move/scale it when the
    // transform actually changes something, otherwise leave the timeline clean.
    const before = context.lastTransform.get(characterId) ?? {};
    const transformParams: CharacterTransformParams = { id: characterId };
    applyTrackedTransform(transformParams, characterId, flags.transform, context);
    applyZIndex(transformParams, characterId, flags, context);
    const after = context.lastTransform.get(characterId) ?? {};
    if (hasTransformDelta(before, after)) {
      transformParams.durationSeconds = TRANSITION_DURATIONS.setTransform;
      context.drafts.push({ time: context.cursor, type: 'characterTransform', params: transformParams });
      context.report.stats.transforms += 1;
      duration = TRANSITION_DURATIONS.setTransform;
    }
    emitTransformEffects(
      parseWebGalTransform(flags.transform),
      { kind: 'character', characterId, lineNumber, durationSeconds: duration || TRANSITION_DURATIONS.setTransform },
      context,
    );
  }

  // WebGAL `-focus` is the Live2D gaze point (eye look direction), not a
  // camera move; AeonStagery expresses it through the character's lookAt.
  const lookAt = parseFocusLookAt(flags.focus);
  if (lookAt) {
    context.report.notes.push({
      lineNumber,
      message: 'WebGAL 的 focus 已转换为角色的注视点（lookAt）。',
    });
  }
  const performance = buildPerformanceParams(characterId, flags, lookAt);
  if (performance) {
    context.drafts.push({ time: context.cursor, type: 'characterPerformance', params: performance });
    context.report.stats.performances += 1;
    if (duration === 0) duration = TRANSITION_DURATIONS.figureEnter;
  }

  context.lastFocusedCharacterId = characterId;
  return duration;
}

function handleFigureExit(
  sentence: Extract<WebGalSentence, { kind: 'command' }>,
  context: ConversionContext,
): number {
  const { flags, lineNumber } = sentence;
  const figureId = flags.id
    ?? (hasFlag(flags, 'left') ? 'fig-left' : hasFlag(flags, 'right') ? 'fig-right' : undefined);
  const characterId = resolveExitTarget(figureId, context);
  if (!characterId || !context.present.has(characterId)) {
    context.report.notes.push({
      lineNumber,
      message: 'changeFigure 移除时找不到在场的目标立绘，已跳过。',
    });
    return 0;
  }

  const exitDuration = readMillisecondsAsSeconds(flags.exitDuration)
    ?? readMillisecondsAsSeconds(flags.duration)
    ?? TRANSITION_DURATIONS.figureExit;
  const pendingTransition = takePendingTransition(
    figureId ?? 'fig-center',
    context,
  );
  const params: CharacterPresenceParams = {
    mode: 'exit',
    id: characterId,
    durationSeconds: exitDuration,
    transition: pendingTransition.exit ?? 'fadeOut',
  };
  const ease = resolveWebGalEase(flags.ease);
  if (ease) params.ease = ease;
  context.drafts.push({ time: context.cursor, type: 'characterPresence', params });
  context.report.stats.figureExits += 1;
  context.present.delete(characterId);
  context.lastTransform.delete(characterId);
  context.currentModel.delete(characterId);
  if (context.lastFocusedCharacterId === characterId) context.lastFocusedCharacterId = undefined;
  return exitDuration;
}

function handleSetTransform(
  sentence: Extract<WebGalSentence, { kind: 'command' }>,
  context: ConversionContext,
): number {
  const { content, flags, lineNumber } = sentence;
  if (flags.target === 'bg-main') {
    const durationSeconds = readMillisecondsAsSeconds(flags.duration)
      ?? TRANSITION_DURATIONS.setTransform;
    const effects = parseWebGalTransform(content);
    const params: EnvironmentLayerParams = {
      mode: 'transform',
      layerId: 'background',
      durationSeconds,
    };
    if (effects?.position) params.position = normalizeBackgroundPosition(effects.position);
    if (effects?.scale !== undefined) params.scale = readUniformScale(effects.scale);
    if (effects?.alpha !== undefined) params.opacity = effects.alpha;
    if (effects?.rotation !== undefined) params.rotation = effects.rotation;
    const ease = resolveWebGalEase(flags.ease);
    if (ease) params.ease = ease;
    context.drafts.push({ time: context.cursor, type: 'environmentLayer', params });
    context.report.stats.transforms += 1;
    emitTransformEffects(
      effects,
      { kind: 'background', lineNumber, durationSeconds },
      context,
    );
    return durationSeconds;
  }
  if (flags.target === 'stage-main') {
    context.report.notes.push({
      lineNumber,
      message: 'setTransform 作用于舞台整体（stage-main）不受支持，已跳过。',
    });
    return 0;
  }

  const characterId = resolveAnimatedTarget(flags.target, context);
  if (!characterId) {
    context.report.notes.push({
      lineNumber,
      message: `setTransform 找不到目标立绘（target=${String(flags.target)}），已跳过。`,
    });
    return 0;
  }

  const params: CharacterTransformParams = { id: characterId };
  applyTrackedTransform(params, characterId, content, context);
  const durationSeconds = readMillisecondsAsSeconds(flags.duration)
    ?? TRANSITION_DURATIONS.setTransform;
  params.durationSeconds = durationSeconds;
  const ease = resolveWebGalEase(flags.ease);
  if (ease) params.ease = ease;
  context.drafts.push({ time: context.cursor, type: 'characterTransform', params });
  context.report.stats.transforms += 1;
  emitTransformEffects(
    parseWebGalTransform(content),
    { kind: 'character', characterId, lineNumber, durationSeconds },
    context,
  );
  return durationSeconds;
}

/**
 * WebGAL transform filters are per-object (a figure or the background);
 * AeonStagery exposes them as screen-level lighting plus an object-level
 * rim-light for the bevel filter. The mapping is deliberately approximate:
 * - blur → lighting blur (targeted at characters or the background);
 * - brightness/contrast/saturation/gamma/colorRGB → lighting post processing;
 * - bloom/bloomThreshold/bloomBrightness/bloomBlur → lighting post bloom;
 * - rgbFilm → post rgb-split; godrayFilm → volumetric godrays;
 * - bevel/bevelThickness/bevelRed/Green/Blue/bevelRotation/bevelSoftness →
 *   visualStyle rim-light (character edge light);
 * - oldFilm/dotFilm/glitchFilm/reflectionFilm/shockwave/radiusAlpha and any
 *   unknown field are dropped with a note.
 */
function emitTransformEffects(
  effects: WebGalTransformEffects | undefined,
  target: {
    kind: 'character' | 'background';
    characterId?: string;
    lineNumber: number;
    durationSeconds: number;
  },
  context: ConversionContext,
): void {
  if (!effects || !hasFilterEffects(effects)) return;
  const { kind, characterId, lineNumber, durationSeconds } = target;

  const post: LightingPostProcessingParams & {
    effect: 'post';
    mode: 'set';
    durationSeconds: number;
  } = { effect: 'post', mode: 'set', durationSeconds };

  if (effects.blur !== undefined && effects.blur > 0) {
    context.drafts.push({
      time: context.cursor,
      type: 'lighting',
      params: {
        effect: 'blur',
        mode: 'set',
        target: kind === 'background' ? 'background' : 'characters',
        intensity: effects.blur / 10,
        durationSeconds,
      },
    });
  }

  if (effects.brightness !== undefined) post.adjBrightness = effects.brightness;
  if (effects.contrast !== undefined) post.adjContrast = effects.contrast;
  if (effects.saturation !== undefined) post.adjSaturation = effects.saturation;
  if (effects.gamma !== undefined) post.adjGamma = effects.gamma;
  if (effects.colorRed !== undefined) post.adjRed = effects.colorRed / 255;
  if (effects.colorGreen !== undefined) post.adjGreen = effects.colorGreen / 255;
  if (effects.colorBlue !== undefined) post.adjBlue = effects.colorBlue / 255;
  if (effects.bloomThreshold !== undefined) post.bloomThreshold = effects.bloomThreshold;
  if (effects.bloomBlur !== undefined) post.bloomBloomScale = effects.bloomBlur / 10;
  if (effects.bloomBrightness !== undefined) post.bloomBrightness = effects.bloomBrightness;
  if (effects.bloom !== undefined) {
    // WebGAL has no separate bloom strength; drive it through the bloom
    // brightness so a raised bloom visibly brightens the glow.
    post.bloomBrightness = (effects.bloomBrightness ?? 1) * (0.5 + effects.bloom / 2);
  }
  if (effects.rgbFilm !== undefined && effects.rgbFilm > 0) {
    post.rgbSplitX = RGB_SPLIT_AMOUNT;
    post.rgbSplitY = RGB_SPLIT_AMOUNT;
  }

  const hasPostValues = Object.values(post).some((value) => value !== undefined && value !== 'post' && value !== 'set');
  if (hasPostValues) {
    context.drafts.push({ time: context.cursor, type: 'lighting', params: post });
  }

  if (effects.godrayFilm !== undefined && effects.godrayFilm > 0) {
    context.drafts.push({
      time: context.cursor,
      type: 'lighting',
      params: { effect: 'godrays', mode: 'set', intensity: 1, durationSeconds },
    });
  }

  if (kind === 'character' && characterId
    && (effects.bevel !== undefined || effects.bevelThickness !== undefined)) {
    const params: VisualStyleParams = {
      scope: 'object',
      target: characterId,
      slot: 'rim-light',
      mode: 'set',
      durationSeconds,
    };
    if (effects.bevel !== undefined) params.intensity = effects.bevel;
    if (effects.bevelThickness !== undefined) params.thickness = effects.bevelThickness;
    if (effects.bevelRed !== undefined || effects.bevelGreen !== undefined || effects.bevelBlue !== undefined) {
      params.color = rgbToHex(effects.bevelRed, effects.bevelGreen, effects.bevelBlue);
    }
    if (effects.bevelRotation !== undefined) params.angle = effects.bevelRotation;
    if (effects.bevelSoftness !== undefined) params.softness = effects.bevelSoftness;
    context.drafts.push({ time: context.cursor, type: 'visualStyle', params });
  }

  const dropped: string[] = [];
  if (kind !== 'character' && (effects.bevel !== undefined || effects.bevelThickness !== undefined)) {
    dropped.push('bevel 倒角（仅支持人物边缘光）');
  }
  if (effects.oldFilm !== undefined && effects.oldFilm > 0) dropped.push('oldFilm 老电影');
  if (effects.dotFilm !== undefined && effects.dotFilm > 0) dropped.push('dotFilm 点状');
  if (effects.glitchFilm !== undefined && effects.glitchFilm > 0) dropped.push('glitchFilm 故障');
  if (effects.reflectionFilm !== undefined && effects.reflectionFilm > 0) dropped.push('reflectionFilm 反射');
  if (effects.shockwave !== undefined && effects.shockwave > 0) dropped.push('shockwave 冲击波');
  if (effects.radiusAlpha !== undefined && effects.radiusAlpha > 0) dropped.push('radiusAlpha 径向透明');
  for (const field of effects.unknown) dropped.push(field);
  if (dropped.length > 0) {
    context.report.notes.push({
      lineNumber,
      message: `transform 中无法转换的滤镜已忽略：${dropped.join('、')}。`,
    });
  }
}

const RGB_SPLIT_AMOUNT = 0.003;

function rgbToHex(red: number | undefined, green: number | undefined, blue: number | undefined): string {
  const channels = [red ?? 255, green ?? 255, blue ?? 255];
  const hex = channels.map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('');
  return `#${hex}`;
}

/**
 * WebGAL `bgm:` plays, switches or stops the background music (empty / `none`
 * stops). Music never blocks the timeline, so the handler returns no duration.
 * `-volume` is a 0..100 percentage, `-enter` is a fade-in time in milliseconds.
 */
function handleBgm(
  sentence: Extract<WebGalSentence, { kind: 'command' }>,
  context: ConversionContext,
): number {
  const { content, flags, lineNumber } = sentence;
  const trimmed = content.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'none') {
    context.drafts.push({
      time: context.cursor,
      type: 'audio',
      params: { role: 'bgm', mode: 'stop' },
    });
    context.report.notes.push({
      lineNumber,
      message: 'bgm 停止播放。',
    });
    return 0;
  }

  const file = toAudioReference(content, context);
  const params: AudioParams = {
    role: 'bgm',
    mode: 'play',
    file,
    loop: true,
  };
  const volume = readPercentage(flags.volume);
  if (volume !== undefined) params.volume = volume;
  const fadeIn = readMillisecondsAsSeconds(flags.enter);
  if (fadeIn !== undefined) params.fadeIn = fadeIn;
  context.drafts.push({ time: context.cursor, type: 'audio', params });
  context.report.stats.bgmCount += 1;
  return 0;
}

function handleBgmStop(
  context: ConversionContext,
): number {
  context.drafts.push({
    time: context.cursor,
    type: 'audio',
    params: { role: 'bgm', mode: 'stop' },
  });
  context.report.stats.bgmCount += 1;
  return 0;
}

/**
 * WebGAL `playEffect:` plays, replaces or stops a sound effect. Effects with
 * an `-id` loop and can stack with other ids; effects without an id share a
 * single default channel.
 */
function handlePlayEffect(
  sentence: Extract<WebGalSentence, { kind: 'command' }>,
  context: ConversionContext,
): number {
  const { content, flags } = sentence;
  const trimmed = content.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'none') {
    return handleStopEffect(sentence, context);
  }

  const instanceId = readInstanceId(flags.id);
  const file = toAudioReference(content, context);
  const params: AudioParams = {
    role: 'sfx',
    mode: 'play',
    instanceId,
    file,
  };
  const volume = readPercentage(flags.volume);
  if (volume !== undefined) params.volume = volume;
  // WebGAL: an effect with an `-id` is allowed to loop (footsteps, rain, ...).
  if (flags.id !== undefined) params.loop = true;
  context.drafts.push({ time: context.cursor, type: 'audio', params });
  context.report.stats.sfxCount += 1;
  return 0;
}

function handleStopEffect(
  sentence: Extract<WebGalSentence, { kind: 'command' }>,
  context: ConversionContext,
): number {
  const { flags } = sentence;
  const instanceId = readInstanceId(flags.id);
  context.drafts.push({
    time: context.cursor,
    type: 'audio',
    params: { role: 'sfx', mode: 'stop', instanceId },
  });
  context.report.stats.sfxCount += 1;
  return 0;
}

/** WebGAL effects without an `-id` share one unnamed channel. */
const DEFAULT_SFX_INSTANCE = 'webgal-sfx';

function readInstanceId(raw: WebGalFlagValue): string {
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return DEFAULT_SFX_INSTANCE;
}

/**
 * WebGAL `setTempAnimation` inlines a keyframe list `[{...},{...}]`; each frame
 * animates the target to its transform values over `duration` milliseconds.
 * Frames unfold into consecutive character transforms (a frame without any
 * transform value is a pure hold). Filters inside frames cannot map onto the
 * per-frame animation model and are reported once.
 */
function handleSetTempAnimation(
  sentence: Extract<WebGalSentence, { kind: 'command' }>,
  context: ConversionContext,
): number {
  const { content, flags, lineNumber } = sentence;
  const characterId = resolveAnimatedTarget(flags.target, context);
  if (!characterId) {
    context.report.notes.push({
      lineNumber,
      message: `setTempAnimation 找不到目标立绘（target=${String(flags.target)}），已跳过。`,
    });
    return 0;
  }

  let frames: unknown;
  try {
    frames = JSON.parse(content);
  } catch {
    context.report.notes.push({ lineNumber, message: 'setTempAnimation 的动画片段不是合法 JSON，已跳过。' });
    return 0;
  }
  if (!Array.isArray(frames) || frames.length === 0) {
    context.report.notes.push({ lineNumber, message: 'setTempAnimation 没有动画片段，已跳过。' });
    return 0;
  }

  let total = 0;
  let droppedFilters = false;
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') continue;
    const record = frame as Record<string, unknown>;
    const durationSeconds = readFrameDuration(record.duration);
    total += durationSeconds;
    const params: CharacterTransformParams = {
      id: characterId,
      durationSeconds,
    };
    const position = record.position && typeof record.position === 'object'
      ? normalizePosition(record.position as Record<string, unknown>)
      : undefined;
    if (position) params.position = position;
    const scale = typeof record.scale === 'number'
      ? record.scale * SCALE_COMPENSATION
      : (record.scale && typeof record.scale === 'object'
        ? readUniformScale(record.scale as { x?: number; y?: number }) * SCALE_COMPENSATION
        : undefined);
    if (scale !== undefined) params.scale = scale;
    const alpha = readFinite(record.alpha);
    if (alpha !== undefined) params.opacity = alpha;
    const rotation = readFinite(record.rotation);
    if (rotation !== undefined) params.rotation = rotation;
    const ease = resolveWebGalEase(typeof record.ease === 'string' ? record.ease : undefined);
    if (ease) params.ease = ease;

    if (params.position !== undefined || params.scale !== undefined
      || params.opacity !== undefined || params.rotation !== undefined) {
      context.drafts.push({ time: context.cursor + total - durationSeconds, type: 'characterTransform', params });
    }
    if (hasFrameFilters(record)) droppedFilters = true;
  }
  if (droppedFilters) {
    context.report.notes.push({
      lineNumber,
      message: 'setTempAnimation 中的滤镜属性（模糊、染色等）无法逐帧转换，已忽略。',
    });
  }

  // Update tracked transform for character with final frame values
  const currentTracked = context.lastTransform.get(characterId) ?? {};
  let trackedPos = currentTracked.position;
  let trackedScale = currentTracked.scale;
  let trackedOpacity = currentTracked.opacity;
  let trackedRot = currentTracked.rotation;
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') continue;
    const record = frame as Record<string, unknown>;
    if (record.position && typeof record.position === 'object') {
      trackedPos = normalizePosition(record.position as Record<string, unknown>) ?? trackedPos;
    }
    if (typeof record.scale === 'number') {
      trackedScale = record.scale * SCALE_COMPENSATION;
    } else if (record.scale && typeof record.scale === 'object') {
      const s = readUniformScale(record.scale as { x?: number; y?: number });
      if (s !== undefined) trackedScale = s * SCALE_COMPENSATION;
    }
    const a = readFinite(record.alpha);
    if (a !== undefined) trackedOpacity = a;
    const r = readFinite(record.rotation);
    if (r !== undefined) trackedRot = r;
  }
  context.lastTransform.set(characterId, {
    ...currentTracked,
    ...(trackedPos ? { position: trackedPos } : {}),
    ...(trackedScale !== undefined ? { scale: trackedScale } : {}),
    ...(trackedOpacity !== undefined ? { opacity: trackedOpacity } : {}),
    ...(trackedRot !== undefined ? { rotation: trackedRot } : {}),
  });

  return total;
}

function readFrameDuration(value: unknown): number {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
}

function readFinite(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

const FRAME_FILTER_FIELDS = new Set([
  'blur', 'brightness', 'contrast', 'saturation', 'gamma',
  'colorRed', 'colorGreen', 'colorBlue', 'bloom', 'bloomBrightness',
  'bloomBlur', 'bloomThreshold', 'bevel', 'bevelThickness', 'bevelRed',
  'bevelGreen', 'bevelBlue', 'bevelRotation', 'bevelSoftness',
  'oldFilm', 'dotFilm', 'rgbFilm', 'glitchFilm', 'godrayFilm',
  'reflectionFilm', 'shockwave', 'radiusAlpha',
]);

function hasFrameFilters(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => FRAME_FILTER_FIELDS.has(key));
}

/**
 * WebGAL `setComplexAnimation` plays one of the built-in soft fades:
 * `universalSoftIn` fades the target in, `universalSoftOff` fades it out.
 */
function handleSetComplexAnimation(
  sentence: Extract<WebGalSentence, { kind: 'command' }>,
  context: ConversionContext,
): number {
  const { content, flags, lineNumber } = sentence;
  const name = content.trim().toLowerCase();
  const durationSeconds = readMillisecondsAsSeconds(flags.duration) ?? 0.5;
  const fadeIn = name === 'universalsoftin';
  const fadeOut = name === 'universalsoftoff';
  if (!fadeIn && !fadeOut) {
    context.report.notes.push({ lineNumber, message: `复杂动画「${content.trim()}」不受支持，已跳过。` });
    return 0;
  }

  const target = flags.target;
  if (target === 'bg-main') {
    context.drafts.push({
      time: context.cursor,
      type: 'environmentLayer',
      params: { mode: 'transform', layerId: 'background', opacity: fadeIn ? 1 : 0, durationSeconds },
    });
    return durationSeconds;
  }
  const characterId = resolveAnimatedTarget(target, context);
  if (characterId) {
    context.drafts.push({
      time: context.cursor,
      type: 'characterTransform',
      params: { id: characterId, opacity: fadeIn ? 1 : 0, durationSeconds },
    });
    return durationSeconds;
  }
  context.report.notes.push({
    lineNumber,
    message: `setComplexAnimation 找不到目标（target=${String(target)}），已跳过。`,
  });
  return 0;
}

/**
 * WebGAL `setTransition` registers the entrance/exit animation the target will
 * play on its next changeBg/changeFigure. WebGAL's preset names map onto the
 * engine's built-in enter/exit presets; unknown names fall back to fades.
 */
function handleSetTransition(
  sentence: Extract<WebGalSentence, { kind: 'command' }>,
  context: ConversionContext,
): number {
  const { flags } = sentence;
  const target = typeof flags.target === 'string' && flags.target !== '' ? flags.target : 'fig-center';
  const enter = typeof flags.enter === 'string' ? mapEnterPreset(flags.enter) : undefined;
  const exit = typeof flags.exit === 'string' ? mapExitPreset(flags.exit) : undefined;
  context.pendingTransitions.set(target, {
    ...(enter ? { enter } : {}),
    ...(exit ? { exit } : {}),
  });
  return 0;
}

const ENTER_PRESET_MAP: Record<string, string> = {
  'enter-from-left': 'slideFromLeft',
  'enter-from-right': 'slideFromRight',
  'enter-from-bottom': 'slideFromBottom',
  'enter-from-top': 'dropIn',
  'enter-scale-in': 'zoomIn',
};

const EXIT_PRESET_MAP: Record<string, string> = {
  'exit-to-left': 'slideToLeft',
  'exit-to-right': 'slideToRight',
  'exit-to-top': 'slideToTop',
  'exit-to-bottom': 'dissolve',
  'exit-scale-out': 'zoomOut',
};

function mapEnterPreset(name: string): string | undefined {
  const normalized = name.trim().toLowerCase();
  return ENTER_PRESET_MAP[normalized] ?? (normalized.startsWith('enter') ? 'fadeIn' : undefined);
}

function mapExitPreset(name: string): string | undefined {
  const normalized = name.trim().toLowerCase();
  return EXIT_PRESET_MAP[normalized] ?? (normalized.startsWith('exit') ? 'fadeOut' : undefined);
}

/** Resolves a setTempAnimation / setComplexAnimation target to a character. */
function resolveAnimatedTarget(
  raw: WebGalFlagValue,
  context: ConversionContext,
): string | undefined {
  if (typeof raw === 'string' && raw !== '' && raw !== 'bg-main' && raw !== 'stage-main') {
    return context.figureIdToCharacterId.get(raw)
      ?? context.speakerToCharacterId.get(raw)
      ?? (context.characters.has(raw) ? raw : undefined);
  }
  if (raw === 'bg-main') return undefined;
  // Without a target, WebGAL animates the figure that currently has focus.
  return context.lastFocusedCharacterId;
}

/** Consumes the transition registered by setTransition for a target id. */
function takePendingTransition(
  targetId: string,
  context: ConversionContext,
): { enter?: string; exit?: string } {
  const pending = context.pendingTransitions.get(targetId);
  if (!pending) return {};
  context.pendingTransitions.delete(targetId);
  return pending;
}

const INTRO_LAYER_ID = 'webgal-intro';
const INTRO_BG_LAYER_ID = 'webgal-intro-bg';
const INTRO_ENTRANCE_SECONDS = 0.5;
const INTRO_LINE_DELAY_MS = 1500;
const INTRO_HOLD_SECONDS = 1.5;

/** All on-stage characters exit together at a chapter boundary. */
const CHAPTER_EXIT_SECONDS = 0.45;
/** The previous background fades out over this long at a boundary. */
const CHAPTER_BLACK_FADE_SECONDS = 1.0;
/** The held black screen before the next chapter begins (`black` mode). */
const CHAPTER_BLACK_HOLD_SECONDS = 2.0;

/**
 * Synthetic `chapterBreak:<transition>;` marker injected between merged
 * scripts. Fixed behavior: every character still on stage exits (in parallel).
 * The background then follows the marker's requested treatment:
 * - `black`: fade out to a held black screen (the stage's near-black base
 *   shows through once the background layer is removed);
 * - `fade`: fade out only — the next chapter's own changeBg fades back in;
 * - `none`: leave the background untouched (seamless continuity).
 */
function handleChapterBreak(
  sentence: Extract<WebGalSentence, { kind: 'command' }>,
  context: ConversionContext,
): number {
  const transition = sentence.content.trim().toLowerCase() === 'none'
    ? 'none'
    : sentence.content.trim().toLowerCase() === 'fade'
      ? 'fade'
      : 'black';

  for (const characterId of [...context.present]) {
    context.drafts.push({
      time: context.cursor,
      type: 'characterPresence',
      params: {
        mode: 'exit',
        id: characterId,
        durationSeconds: CHAPTER_EXIT_SECONDS,
        transition: 'fadeOut',
      },
    });
    context.report.stats.figureExits += 1;
  }
  context.present.clear();
  context.lastTransform.clear();
  context.currentModel.clear();
  context.lastFocusedCharacterId = undefined;

  let duration = CHAPTER_EXIT_SECONDS;
  if (transition !== 'none') {
    context.drafts.push({
      time: context.cursor,
      type: 'environmentLayer',
      params: {
        mode: 'remove',
        layerId: 'background',
        durationSeconds: CHAPTER_BLACK_FADE_SECONDS,
        transition: 'fadeOut',
      },
    });
    duration = Math.max(duration, CHAPTER_BLACK_FADE_SECONDS);
  }
  if (transition === 'black') {
    duration += CHAPTER_BLACK_HOLD_SECONDS;
  }
  return duration;
}

/**
 * WebGAL `wait:N` pauses for N milliseconds. In a linear video timeline that
 * is an empty shot: the cursor advances and the frame simply holds. The wait
 * always advances even when `-next` is present (WebGAL documents that `-next`
 * has no effect on wait).
 */
function handleWait(
  sentence: Extract<WebGalSentence, { kind: 'command' }>,
  context: ConversionContext,
): number {
  const { content, lineNumber } = sentence;
  const ms = Number(content);
  const seconds = Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
  if (seconds <= 0) {
    context.report.notes.push({ lineNumber, message: `wait 时长无效（${content}），已跳过。` });
    return 0;
  }
  context.cursor += seconds;
  return 0;
}

/**
 * WebGAL `intro:` shows full-screen text lines separated by `|`. AeonStagery
 * has no dedicated black-screen statement, so the intro becomes a full-screen
 * text layer (optionally over a background image layer) that fades in and is
 * removed when its reading time elapses. `-hold` / `-userForward` (wait for a
 * click) are approximated by a fixed extra hold, since a video timeline never
 * waits for input.
 */
function handleIntro(
  sentence: Extract<WebGalSentence, { kind: 'command' }>,
  context: ConversionContext,
): number {
  const { content, flags, lineNumber } = sentence;
  const lines = content.split('|').filter((line) => line.trim() !== '');
  if (lines.length === 0) return 0;

  const delaySeconds = (readMillisecondsAsSeconds(flags.delayTime) ?? INTRO_LINE_DELAY_MS / 1000);
  let holdSeconds = Math.max(INTRO_ENTRANCE_SECONDS, lines.length * delaySeconds);
  if (hasFlag(flags, 'hold') || hasFlag(flags, 'userForward')) {
    holdSeconds += INTRO_HOLD_SECONDS;
  }

  const fontSize = readIntroFontSize(flags.fontSize);
  const fontColor = typeof flags.fontColor === 'string' && flags.fontColor !== ''
    ? flags.fontColor
    : undefined;
  const backgroundImage = typeof flags.backgroundImage === 'string' && flags.backgroundImage !== ''
    ? flags.backgroundImage
    : undefined;

  const text: string = lines.join('\n');
  if (backgroundImage) {
    context.drafts.push({
      time: context.cursor,
      type: 'graphicLayer',
      params: {
        kind: 'image',
        mode: 'set',
        id: INTRO_BG_LAYER_ID,
        file: toAssetReference(backgroundImage, 'background', context),
        position: [0.5, 0.5],
        durationSeconds: INTRO_ENTRANCE_SECONDS,
      },
    });
    context.drafts.push({
      time: context.cursor + holdSeconds,
      type: 'graphicLayer',
      params: { kind: 'image', mode: 'remove', id: INTRO_BG_LAYER_ID },
    });
  }
  context.drafts.push({
    time: context.cursor,
    type: 'graphicLayer',
    params: {
      kind: 'text',
      mode: 'set',
      id: INTRO_LAYER_ID,
      text,
      ...(fontSize !== undefined ? { fontSize } : {}),
      ...(fontColor ? { color: fontColor } : {}),
      style: 'fadeIn',
      durationSeconds: INTRO_ENTRANCE_SECONDS,
    },
  });
  context.drafts.push({
    time: context.cursor + holdSeconds,
    type: 'graphicLayer',
    params: { kind: 'text', mode: 'remove', id: INTRO_LAYER_ID },
  });

  const animation = flags.animation;
  if (typeof animation === 'string' && animation !== '' && animation !== 'fadeIn') {
    context.report.notes.push({
      lineNumber,
      message: `intro 的显示动画「${animation}」仅支持淡入效果，已近似。`,
    });
  }
  if (typeof flags.backgroundColor === 'string' && flags.backgroundColor !== '') {
    context.report.notes.push({
      lineNumber,
      message: 'intro 的 backgroundColor 无法转换（无纯色图层），已忽略。',
    });
  }
  return holdSeconds;
}

const INTRO_FONT_SIZES: Record<string, number> = {
  small: 36,
  medium: 60,
  large: 84,
};

function readIntroFontSize(raw: WebGalFlagValue): number | undefined {
  if (typeof raw !== 'string') return undefined;
  return INTRO_FONT_SIZES[raw.trim().toLowerCase()];
}

function readPercentage(raw: WebGalFlagValue): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value / 100));
}

function resolveSpeakerId(
  sentence: Extract<WebGalSentence, { kind: 'dialogue' }>,
  speaker: string,
  context: ConversionContext,
): string | undefined {
  // WebGAL dialogue lines may use `-figureId` or `-id` to point at the speaking figure.
  const figureId = sentence.flags.figureId ?? sentence.flags.id;
  const byFigure = figureId ? context.figureIdToCharacterId.get(figureId) : undefined;
  if (byFigure) {
    registerSpeakerAlias(speaker, byFigure, context);
    return byFigure;
  }

  const existing = context.speakerToCharacterId.get(speaker);
  if (existing) return existing;

  // A figure may already own the speaker's id (a changeFigure with a matching
  // model claimed it first). The speaker must bind to that character instead
  // of splitting one person into `soyo` and `soyo_2` (ADR-0026).
  const slug = slugifyCharacterId(speaker);
  const bySlug = slug ? context.characters.get(slug) : undefined;
  if (bySlug) {
    registerSpeakerAlias(speaker, bySlug.id, context);
    if (figureId) context.figureIdToCharacterId.set(figureId, bySlug.id);
    return bySlug.id;
  }

  const characterId = claimCharacterId(slug, context);
  registerCharacter(characterId, speaker, undefined, context);
  context.speakerToCharacterId.set(speaker, characterId);
  // A figure entering later with the same -id must resolve to THIS character,
  // otherwise the speaker and the on-stage figure become two characters.
  if (figureId) context.figureIdToCharacterId.set(figureId, characterId);
  return characterId;
}

function resolveFigureCharacterId(
  figureId: WebGalFlagValue,
  model: string | undefined,
  context: ConversionContext,
): string {
  if (figureId) {
    const existing = context.figureIdToCharacterId.get(figureId);
    if (existing) return existing;
  }

  const baseId = model ? characterIdFromModel(model) : undefined;
  if (baseId) {
    // WebGAL keys figures by their model path unless an explicit -id is
    // given: a character already claimed under the model's id (a speaker line
    // or a previous figure) is the same character. The only exception is an
    // explicit second instance — a different -id that already owns the id.
    const existing = context.characters.get(baseId);
    const ownedByOtherFigureId = figureId !== undefined
      && [...context.figureIdToCharacterId.values()].includes(baseId);
    if (existing && !ownedByOtherFigureId) {
      if (figureId) context.figureIdToCharacterId.set(figureId, baseId);
      return baseId;
    }
  }

  const characterId = claimCharacterId(baseId ?? `figure_${figureId ?? 'unknown'}`, context);
  if (figureId) context.figureIdToCharacterId.set(figureId, characterId);
  return characterId;
}

function resolveExitTarget(
  figureId: WebGalFlagValue,
  context: ConversionContext,
): string | undefined {
  if (figureId) return context.figureIdToCharacterId.get(figureId);
  // Without -id, WebGAL removes the figure that currently has focus.
  return context.lastFocusedCharacterId;
}

function buildPerformanceParams(
  characterId: string,
  flags: Record<string, WebGalFlagValue>,
  lookAt?: CharacterPerformanceParams['lookAt'],
): CharacterPerformanceParams | undefined {
  const motion = flags.motion;
  const expression = flags.expression;
  const blink = parseBlink(flags.blink);
  if (!motion && !expression && !blink && !lookAt) return undefined;

  const params: CharacterPerformanceParams = { target: characterId };
  if (motion) params.motion = { kind: 'resource', key: motion };
  if (expression) params.expression = expression;
  if (blink) params.blink = blink;
  if (lookAt) params.lookAt = lookAt;
  return params;
}

function parseBlink(raw: WebGalFlagValue): CharacterPerformanceParams['blink'] | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { enabled: true };
  }
  if (!parsed || typeof parsed !== 'object') return { enabled: true };
  const record = parsed as Record<string, unknown>;
  const blinkIntervalMs = Number(record.blinkInterval);
  return Number.isFinite(blinkIntervalMs) && blinkIntervalMs > 0
    ? { enabled: true, interval: blinkIntervalMs / 1000 }
    : { enabled: true };
}

/**
 * WebGAL `-focus={"x":0.6,"y":-0.2,"instant":false}` drives where the Live2D
 * figure looks; both x and y range -1..1 with y up, matching the runtime's
 * lookAt point. Unknown or invalid JSON falls back to no lookAt.
 */
function parseFocusLookAt(raw: WebGalFlagValue): CharacterPerformanceParams['lookAt'] | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  if (!Number.isFinite(x) && !Number.isFinite(y)) return undefined;
  return {
    enabled: true,
    point: [
      Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0,
      Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0,
    ],
  };
}

/**
 * Applies a transform to a statement's params while preserving the character's
 * last-known transform. WebGAL keeps a figure's transform when it is re-added
 * without an explicit `-transform`, so re-entries must not reset to the center.
 */
function applyTrackedTransform(
  params: CharacterPresenceParams | CharacterTransformParams,
  characterId: string,
  raw: WebGalFlagValue,
  context: ConversionContext,
): void {
  const statementTransform = parseWebGalTransform(raw);
  const tracked = context.lastTransform.get(characterId);
  const position = statementTransform?.position
    ? normalizePosition(statementTransform.position)
    : tracked?.position;
  const scale = statementTransform?.scale !== undefined
    ? readUniformScale(statementTransform.scale) * SCALE_COMPENSATION
    : tracked?.scale;
  const opacity = statementTransform?.alpha ?? tracked?.opacity;
  const rotation = statementTransform?.rotation ?? tracked?.rotation;

  if (position) params.position = position;
  if (scale !== undefined) params.scale = scale;
  if (opacity !== undefined) params.opacity = opacity;
  if (rotation !== undefined) params.rotation = rotation;

  const next: TrackedTransform = {};
  if (position) next.position = position;
  if (scale !== undefined) next.scale = scale;
  if (opacity !== undefined) next.opacity = opacity;
  if (rotation !== undefined) next.rotation = rotation;
  context.lastTransform.set(characterId, next);
}

/** WebGAL `-position` presets: left/right hug the edge, thirds, quarters. */
function applyPositionPreset(
  params: CharacterPresenceParams,
  characterId: string,
  flags: Record<string, WebGalFlagValue>,
  context: ConversionContext,
): void {
  if (!parseWebGalTransform(flags.transform)?.position) {
    // Modern `-left` / `-right` boolean flags.
    const sidePreset = hasFlag(flags, 'left') ? 'left' : hasFlag(flags, 'right') ? 'right' : undefined;
    const preset = sidePreset ?? (typeof flags.position === 'string' ? flags.position : undefined);
    if (preset !== undefined) {
      const presetPosition: [number, number] = [presetPositionX(preset), 1];
      params.position = presetPosition;
      const tracked = context.lastTransform.get(characterId) ?? {};
      context.lastTransform.set(characterId, { ...tracked, position: presetPosition });
    }
  }

  if (!params.position) {
    // Characters without an explicit position stand center-stage at the bottom
    // (WebGAL's default placement), never at the mid-screen engine fallback.
    params.position = [0.5, 1];
    const tracked = context.lastTransform.get(characterId) ?? {};
    context.lastTransform.set(characterId, { ...tracked, position: [0.5, 1] });
  }
}

/** WebGAL `-zIndex` controls front-to-back order; AeonStagery exposes it as `z`. */
function applyZIndex(
  params: CharacterPresenceParams | CharacterTransformParams,
  characterId: string,
  flags: Record<string, WebGalFlagValue>,
  context: ConversionContext,
): void {
  const z = readZIndex(flags.zIndex);
  if (z === undefined) return;
  params.z = z;
  const tracked = context.lastTransform.get(characterId) ?? {};
  context.lastTransform.set(characterId, { ...tracked, z });
}

function readZIndex(raw: WebGalFlagValue): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function hasTransformDelta(before: TrackedTransform, after: TrackedTransform): boolean {
  if (after.position && (!before.position || after.position[0] !== before.position[0]
    || after.position[1] !== before.position[1])) {
    return true;
  }
  if (after.scale !== undefined && after.scale !== before.scale) return true;
  if (after.opacity !== undefined && after.opacity !== before.opacity) return true;
  if (after.rotation !== undefined && after.rotation !== before.rotation) return true;
  if (after.z !== undefined && after.z !== before.z) return true;
  return false;
}

function readUniformScale(scale: { x?: number; y?: number }): number {
  if (scale.x !== undefined) return scale.x;
  return scale.y ?? 1;
}

/**
 * WebGAL `-position` presets place the figure at fixed fractions of the stage
 * width (`left`/`right` hug the screen edge; `left13`/`right13` are thirds;
 * `left14`/`right14` are quarters). `left`/`right` centers are approximated for
 * a typical portrait figure since WebGAL anchors them by the figure's own width.
 */
function presetPositionX(position: string): number {
  switch (position) {
    case 'left':
      return 0.2;
    case 'right':
      return 0.8;
    case 'left13':
      return 1 / 3;
    case 'right13':
      return 2 / 3;
    case 'left14':
      return 0.25;
    case 'right14':
      return 0.75;
    default:
      return 0.5;
  }
}

/**
 * Converts WebGAL center-relative pixel positions to AeonStagery normalized
 * coordinates. Horizontal default is the stage center (0.5); vertical default is
 * the standing position (1.0, feet at the stage bottom) so characters do not
 * float mid-screen or stand on the text box.
 */
function normalizePosition(vec: { x?: number; y?: number }): [number, number] | undefined {
  const { x, y } = vec;
  if (x === undefined && y === undefined) return undefined;
  return [
    x !== undefined ? 0.5 + x / WEBGAL_STAGE_WIDTH : 0.5,
    y !== undefined ? 1 + y / WEBGAL_STAGE_HEIGHT : 1,
  ];
}

/** Backgrounds center on the stage, so both axes default to 0.5. */
function normalizeBackgroundPosition(vec: { x?: number; y?: number }): [number, number] | undefined {
  const { x, y } = vec;
  if (x === undefined && y === undefined) return undefined;
  return [
    x !== undefined ? 0.5 + x / WEBGAL_STAGE_WIDTH : 0.5,
    y !== undefined ? 0.5 + y / WEBGAL_STAGE_HEIGHT : 0.5,
  ];
}

function findVoiceFlagValue(flags: Record<string, WebGalFlagValue>): string | undefined {
  // WebGAL's shorthand attaches the voice as a bare `-path.wav` flag.
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined) continue;
    if (AUDIO_FLAG_PATTERN.test(key)) return key;
  }
  // The documented form writes the voice behind `-vocal=path.wav`.
  const vocal = flags.vocal;
  if (typeof vocal === 'string' && vocal.trim() !== '') return vocal.trim();
  return undefined;
}

/**
 * Music and effect files keep their WebGAL path relative to the asset root
 * (no `figure/` or `background/` prefix; a WebGAL project often stores them
 * under `bgm/`, `audio/`, or the game root itself).
 */
function toAudioReference(value: string, context: ConversionContext): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (context.mountId) return `@mount/${context.mountId}/${normalized}`;
  return normalized;
}

/**
 * WebGAL dialogue voices live under the asset `vocal/` directory in the
 * projects this importer targets. A bare `-soyo/x.wav` flag becomes
 * `vocal/soyo/x.wav` under the mount or project root.
 */
function toVoiceReference(
  value: string,
  context: ConversionContext,
  lineNumber: number,
): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  const path = `vocal/${normalized}`;
  if (context.mountId) return `@mount/${context.mountId}/${path}`;
  context.voiceWithoutMountLines.push(lineNumber);
  return path;
}

function characterIdFromModel(model: string): string {
  const normalized = model.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return slugifyCharacterId(segments[0] ?? '');
}

function slugifyCharacterId(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || '';
}

function claimCharacterId(baseId: string, context: ConversionContext): string {
  const cleanBase = baseId.trim() || `character_${context.fallbackCharacterIndex}`;
  if (!context.characters.has(cleanBase)) {
    registerCharacter(cleanBase, cleanBase, undefined, context);
    return cleanBase;
  }
  let index = 2;
  while (context.characters.has(`${cleanBase}_${index}`)) index += 1;
  const uniqueId = `${cleanBase}_${index}`;
  registerCharacter(uniqueId, uniqueId, undefined, context);
  return uniqueId;
}

function registerCharacter(
  id: string,
  name: string,
  model: string | undefined,
  context: ConversionContext,
): void {
  const existing = context.characters.get(id);
  if (existing) {
    if (model && !existing.model) existing.model = model;
    if (existing.name === id && name !== id) existing.name = name;
    return;
  }
  context.characters.set(id, {
    id,
    name: name || id,
    ...(model ? { model } : {}),
  });
}

function ensureCharacterModel(
  characterId: string,
  model: string,
  context: ConversionContext,
): void {
  const character = context.characters.get(characterId);
  if (!character) {
    registerCharacter(characterId, characterId, model, context);
    return;
  }
  if (model && !character.model) character.model = model;
}

function registerSpeakerAlias(
  speaker: string,
  characterId: string,
  context: ConversionContext,
): void {
  context.speakerToCharacterId.set(speaker, characterId);
  const character = context.characters.get(characterId);
  if (character && character.name === characterId) character.name = speaker;
}

function toAssetReference(
  value: string,
  kind: 'figure' | 'background',
  context: ConversionContext,
): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (context.mountId) return `@mount/${context.mountId}/${kind}/${normalized}`;
  return `${kind}/${normalized}`;
}

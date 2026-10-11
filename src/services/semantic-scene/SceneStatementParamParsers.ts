import type {
  AudioParams,
  CameraParams,
  CharacterMotionOutput,
  CharacterPerformanceParams,
  CustomMotionDerivedFrom,
  CustomMotionKeyframe,
  CustomMotionSegment,
  CustomMotionTrack,
  CharacterPresenceParams,
  CharacterTransformParams,
  CustomAnimationParams,
  DialogueImagePanelStyle,
  DialogueImagePresentation,
  DialogueImageSpeakerStyle,
  DialogueImageTextStyle,
  DialogueNineSlice,
  DialogueParams,
  EnvironmentLayerParams,
  FilterAddParams,
  FilterChangeParams,
  FilterResetParams,
  GraphicLayerParams,
  LightingParams,
  Vec2,
  VisualStyleParams,
  ZoomIntent,
} from '../../api/types/semantic-scene';
import { assertCanonicalCustomMotion, CustomMotionContractError } from './CustomMotionContract';
import type { AdvancedStyleOverride, SemanticStyleOverride } from '../../api/types/visual';
import { BLEND_MODES } from '../../api/types/blend-mode';
import type { ResourceImportKind, ResourceKind } from '../../api/types/project';
import {
  UnknownSceneDiscriminatorError,
  UnknownSceneFieldError,
} from './SceneDocumentContractErrors';
import type { AssetReferenceField } from './SceneStatementDefinitionTypes';
export function expectRecord(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Expected object at ${path}`);
  }
  return input as Record<string, unknown>;
}

export function expectKeys(record: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new UnknownSceneFieldError(record, key, path, allowed);
    }
  }
}

function expectString(input: unknown, path: string): string {
  if (input === undefined) {
    throw new Error(`Missing required field at ${path}`);
  }
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error(`Expected non-empty string at ${path}`);
  }
  return input;
}

function expectStringIncludingEmpty(input: unknown, path: string): string {
  if (typeof input !== 'string') {
    throw new Error(`Expected string at ${path}`);
  }
  return input;
}

function optionalString(input: unknown, path: string): string | undefined {
  if (input === undefined) return undefined;
  return expectString(input, path);
}

/**
 * Keep operation-dependent empty values in the source document so semantic
 * validation can report them against the authored statement. Shape and type
 * failures still belong to the parser boundary.
 */
function optionalDiagnosticString(input: unknown, path: string): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string') {
    throw new Error(`Expected string at ${path}`);
  }
  return input;
}

function diagnosticString(input: unknown, path: string): string {
  if (typeof input !== 'string') {
    throw new Error(`Expected string at ${path}`);
  }
  return input;
}

function optionalResourcePath(input: unknown, path: string): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string') {
    throw new Error(`Expected string at ${path}`);
  }
  return input;
}

function expectFiniteNumber(input: unknown, path: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`Expected finite number at ${path}`);
  }
  return input;
}

function optionalFiniteNumber(input: unknown, path: string): number | undefined {
  if (input === undefined) return undefined;
  return expectFiniteNumber(input, path);
}

function optionalNumberBetween(input: unknown, path: string, min: number, max: number): number | undefined {
  const value = optionalFiniteNumber(input, path);
  if (value !== undefined && (value < min || value > max)) {
    throw new Error(`Expected number between ${min} and ${max} at ${path}`);
  }
  return value;
}

export function optionalNonNegativeNumber(input: unknown, path: string): number | undefined {
  const value = optionalFiniteNumber(input, path);
  if (value !== undefined && value < 0) {
    throw new Error(`Expected non-negative number at ${path}`);
  }
  return value;
}

function expectPositiveNumber(input: unknown, path: string): number {
  const value = expectFiniteNumber(input, path);
  if (value <= 0) throw new Error(`Expected positive number at ${path}`);
  return value;
}

function optionalPositiveNumber(input: unknown, path: string): number | undefined {
  if (input === undefined) return undefined;
  return expectPositiveNumber(input, path);
}

export function optionalBoolean(input: unknown, path: string): boolean | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'boolean') throw new Error(`Expected boolean at ${path}`);
  return input;
}

function expectOneOf<const Values extends readonly string[]>(
  input: unknown,
  path: string,
  values: Values,
): Values[number] {
  const value = expectString(input, path);
  if (!values.includes(value)) {
    throw new UnknownSceneDiscriminatorError(path, value, values);
  }
  return value as Values[number];
}

function optionalOneOf<const Values extends readonly string[]>(
  input: unknown,
  path: string,
  values: Values,
): Values[number] | undefined {
  if (input === undefined) return undefined;
  return expectOneOf(input, path, values);
}

function optionalDiagnosticOneOf<const Values extends readonly string[]>(
  input: unknown,
  path: string,
  values: Values,
): Values[number] | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string') {
    throw new Error(`Expected string at ${path}`);
  }
  if (input.trim() === '') return input as Values[number];
  if (!values.includes(input)) {
    throw new UnknownSceneDiscriminatorError(path, input, values);
  }
  return input as Values[number];
}

function optionalVec2(input: unknown, path: string): Vec2 | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length !== 2) {
    throw new Error(`Expected [number, number] at ${path}`);
  }
  const x = expectFiniteNumber(input[0], `${path}[0]`);
  const y = expectFiniteNumber(input[1], `${path}[1]`);
  return [x, y];
}

function parseZoomIntent(input: unknown, path: string): ZoomIntent | undefined {
  if (input === undefined) return undefined;
  const record = expectRecord(input, path);
  expectKeys(record, path, ['kind', 'value']);
  return {
    kind: expectOneOf(record.kind, `${path}.kind`, ['absolute', 'delta']),
    value: expectFiniteNumber(record.value, `${path}.value`),
  };
}

function optionalStringArray(input: unknown, path: string): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new Error(`Expected array at ${path}`);
  return input.map((item, index) => expectString(item, `${path}[${index}]`));
}

function optionalSemanticStyleOverride(
  input: unknown,
  path: string,
  allowBrightness = false,
): SemanticStyleOverride | undefined {
  if (input === undefined) return undefined;
  const record = expectRecord(input, path);
  expectKeys(record, path, [
    'intensity',
    ...(allowBrightness ? ['brightness'] : []),
    'warmth',
    'bloom',
    'rgbSplit',
    'blend',
    'contamination',
    'color',
    'colorStops',
    'colorBlendMode',
    'shadowDistance',
    'shadowSoftness',
  ]);
  return compact({
    intensity: optionalFiniteNumber(record.intensity, `${path}.intensity`),
    ...(allowBrightness ? { brightness: optionalNumberBetween(record.brightness, `${path}.brightness`, -1, 1) } : {}),
    warmth: optionalFiniteNumber(record.warmth, `${path}.warmth`),
    bloom: optionalFiniteNumber(record.bloom, `${path}.bloom`),
    rgbSplit: optionalFiniteNumber(record.rgbSplit, `${path}.rgbSplit`),
    blend: optionalFiniteNumber(record.blend, `${path}.blend`),
    contamination: optionalFiniteNumber(record.contamination, `${path}.contamination`),
    color: optionalString(record.color, `${path}.color`),
    colorStops: optionalStringArray(record.colorStops, `${path}.colorStops`),
    colorBlendMode: optionalOneOf(record.colorBlendMode, `${path}.colorBlendMode`, BLEND_MODES),
    shadowDistance: optionalFiniteNumber(record.shadowDistance, `${path}.shadowDistance`),
    shadowSoftness: optionalFiniteNumber(record.shadowSoftness, `${path}.shadowSoftness`),
  }) as SemanticStyleOverride;
}

function optionalAdvancedStyleOverride(input: unknown, path: string): AdvancedStyleOverride | undefined {
  if (input === undefined) return undefined;
  return JSON.parse(JSON.stringify(expectRecord(input, path))) as AdvancedStyleOverride;
}

export function compact<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

export function oneAsset(path: string, value: string | undefined, kind: ResourceImportKind, resourceKind: ResourceKind): readonly AssetReferenceField[] {
  return value ? [{ path, value, kind, resourceKind }] : [];
}

export function collectDialogueAssets(params: DialogueParams): readonly AssetReferenceField[] {
  return [
    ...oneAsset('params.voice', params.voice, 'vocal', 'voice'),
    ...oneAsset('params.presentation.textbox.image', params.presentation?.textbox.image, 'images', 'image'),
    ...oneAsset('params.presentation.namebox.image', params.presentation?.namebox?.image, 'images', 'image'),
    ...oneAsset('params.presentation.text.fontFile', params.presentation?.text.fontFile, 'images', 'font'),
    ...oneAsset('params.presentation.speaker.fontFile', params.presentation?.speaker?.fontFile, 'images', 'font'),
  ];
}

function optionalDialogueNineSlice(input: unknown, path: string): DialogueNineSlice | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length !== 4) {
    throw new Error(`Expected [left, top, right, bottom] at ${path}`);
  }
  const values = input.map((value, index) => {
    const parsed = expectFiniteNumber(value, `${path}[${index}]`);
    if (parsed < 0) throw new Error(`Expected non-negative number at ${path}[${index}]`);
    return parsed;
  });
  return values as unknown as DialogueNineSlice;
}

function parseDialogueImagePanelStyle(input: unknown, path: string): DialogueImagePanelStyle {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['image', 'nineSlice', 'x', 'y', 'width', 'height', 'minHeight', 'opacity']);
  const opacity = optionalFiniteNumber(record.opacity, `${path}.opacity`);
  if (opacity !== undefined && (opacity < 0 || opacity > 1)) {
    throw new Error(`Expected opacity between 0 and 1 at ${path}.opacity`);
  }
  return compact({
    image: expectString(record.image, `${path}.image`),
    nineSlice: optionalDialogueNineSlice(record.nineSlice, `${path}.nineSlice`),
    x: expectFiniteNumber(record.x, `${path}.x`),
    y: expectFiniteNumber(record.y, `${path}.y`),
    width: expectPositiveNumber(record.width, `${path}.width`),
    height: record.height === undefined ? undefined : expectPositiveNumber(record.height, `${path}.height`),
    minHeight: record.minHeight === undefined ? undefined : expectPositiveNumber(record.minHeight, `${path}.minHeight`),
    opacity,
  });
}

function parseDialogueImageTextStyle(input: unknown, path: string): DialogueImageTextStyle {
  const record = expectRecord(input, path);
  expectKeys(record, path, [
    'fontFile', 'fontFamily', 'fontSize', 'fontWeight', 'color', 'x', 'y', 'maxWidth',
    'lineHeight', 'align', 'strokeColor', 'strokeWidth', 'dropShadow', 'dropShadowColor',
    'dropShadowAlpha', 'dropShadowBlur', 'dropShadowDistance',
  ]);
  const dropShadowAlpha = optionalFiniteNumber(record.dropShadowAlpha, `${path}.dropShadowAlpha`);
  if (dropShadowAlpha !== undefined && (dropShadowAlpha < 0 || dropShadowAlpha > 1)) {
    throw new Error(`Expected opacity between 0 and 1 at ${path}.dropShadowAlpha`);
  }
  const parsed = compact({
    fontFile: optionalResourcePath(record.fontFile, `${path}.fontFile`),
    fontFamily: optionalString(record.fontFamily, `${path}.fontFamily`),
    fontSize: record.fontSize === undefined ? undefined : expectPositiveNumber(record.fontSize, `${path}.fontSize`),
    fontWeight: optionalString(record.fontWeight, `${path}.fontWeight`),
    color: optionalString(record.color, `${path}.color`),
    x: expectFiniteNumber(record.x, `${path}.x`),
    y: expectFiniteNumber(record.y, `${path}.y`),
    maxWidth: expectPositiveNumber(record.maxWidth, `${path}.maxWidth`),
    lineHeight: record.lineHeight === undefined ? undefined : expectPositiveNumber(record.lineHeight, `${path}.lineHeight`),
    align: optionalOneOf(record.align, `${path}.align`, ['left', 'center', 'right']),
    strokeColor: optionalString(record.strokeColor, `${path}.strokeColor`),
    strokeWidth: optionalNonNegativeNumber(record.strokeWidth, `${path}.strokeWidth`),
    dropShadow: optionalBoolean(record.dropShadow, `${path}.dropShadow`),
    dropShadowColor: optionalString(record.dropShadowColor, `${path}.dropShadowColor`),
    dropShadowAlpha,
    dropShadowBlur: optionalNonNegativeNumber(record.dropShadowBlur, `${path}.dropShadowBlur`),
    dropShadowDistance: optionalNonNegativeNumber(record.dropShadowDistance, `${path}.dropShadowDistance`),
  });
  if (parsed.fontFile && !parsed.fontFamily) {
    throw new Error(`fontFamily is required when fontFile is set at ${path}`);
  }
  return parsed;
}

function parseDialogueImageSpeakerStyle(input: unknown, path: string): DialogueImageSpeakerStyle | undefined {
  if (input === undefined) return undefined;
  const record = expectRecord(input, path);
  expectKeys(record, path, [
    'fontFile', 'fontFamily', 'fontSize', 'fontWeight', 'color', 'padding', 'textOffset',
  ]);
  const parsed = compact({
    fontFile: optionalResourcePath(record.fontFile, `${path}.fontFile`),
    fontFamily: optionalString(record.fontFamily, `${path}.fontFamily`),
    fontSize: record.fontSize === undefined ? undefined : expectPositiveNumber(record.fontSize, `${path}.fontSize`),
    fontWeight: optionalString(record.fontWeight, `${path}.fontWeight`),
    color: optionalString(record.color, `${path}.color`),
    padding: optionalDialogueNineSlice(record.padding, `${path}.padding`),
    textOffset: optionalVec2(record.textOffset, `${path}.textOffset`),
  });
  if (parsed.fontFile && !parsed.fontFamily) {
    throw new Error(`fontFamily is required when fontFile is set at ${path}`);
  }
  return parsed;
}

export function parseDialogueImagePresentation(input: unknown, path: string): DialogueImagePresentation | undefined {
  if (input === undefined) return undefined;
  const record = expectRecord(input, path);
  expectKeys(record, path, ['renderer', 'styleId', 'textbox', 'namebox', 'text', 'speaker']);
  return compact({
    renderer: expectOneOf(record.renderer, `${path}.renderer`, ['image-dialogue-v1']),
    styleId: optionalString(record.styleId, `${path}.styleId`),
    textbox: parseDialogueImagePanelStyle(record.textbox, `${path}.textbox`),
    namebox: record.namebox === undefined ? undefined : parseDialogueImagePanelStyle(record.namebox, `${path}.namebox`),
    text: parseDialogueImageTextStyle(record.text, `${path}.text`),
    speaker: parseDialogueImageSpeakerStyle(record.speaker, `${path}.speaker`),
  });
}

export function parseDialogueParams(input: unknown, path: string): DialogueParams {
  const record = expectRecord(input, path);
  expectKeys(record, path, [
    'speakerId',
    'speaker',
    'text',
    'durationSeconds',
    'voice',
    'voiceDuration',
    'voiceDurationSeconds',
    'style',
    'speakerColor',
    'textColor',
    'lipSync',
    'template',
    'presentation',
  ]);
  return compact({
    speakerId: optionalString(record.speakerId, `${path}.speakerId`),
    speaker: optionalString(record.speaker, `${path}.speaker`),
    text: expectStringIncludingEmpty(record.text, `${path}.text`),
    durationSeconds: expectPositiveNumber(record.durationSeconds, `${path}.durationSeconds`),
    voice: optionalResourcePath(record.voice, `${path}.voice`),
    voiceDuration: optionalPositiveNumber(record.voiceDuration, `${path}.voiceDuration`),
    voiceDurationSeconds: optionalPositiveNumber(record.voiceDurationSeconds, `${path}.voiceDurationSeconds`),
    style: optionalString(record.style, `${path}.style`),
    speakerColor: optionalString(record.speakerColor, `${path}.speakerColor`),
    textColor: optionalString(record.textColor, `${path}.textColor`),
    lipSync: optionalBoolean(record.lipSync, `${path}.lipSync`),
    template: optionalOneOf(record.template, `${path}.template`, ['glass', 'minimal', 'classic']),
    presentation: parseDialogueImagePresentation(record.presentation, `${path}.presentation`),
  });
}

export function parseCharacterPresenceParams(input: unknown, path: string): CharacterPresenceParams {
  const record = expectRecord(input, path);
  expectKeys(record, path, [
    'mode',
    'id',
    'model',
    'variant',
    'position',
    'scale',
    'rotation',
    'opacity',
    'z',
    'transition',
    'durationSeconds',
    'ease',
  ]);
  return compact({
    mode: expectOneOf(record.mode, `${path}.mode`, ['enter', 'exit']),
    id: expectString(record.id, `${path}.id`),
    model: optionalResourcePath(record.model, `${path}.model`),
    variant: optionalString(record.variant, `${path}.variant`),
    position: optionalVec2(record.position, `${path}.position`),
    scale: optionalFiniteNumber(record.scale, `${path}.scale`),
    rotation: optionalFiniteNumber(record.rotation, `${path}.rotation`),
    opacity: optionalFiniteNumber(record.opacity, `${path}.opacity`),
    z: optionalFiniteNumber(record.z, `${path}.z`),
    transition: optionalString(record.transition, `${path}.transition`),
    durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
    ease: optionalString(record.ease, `${path}.ease`),
  });
}

export function parseCharacterTransformParams(input: unknown, path: string): CharacterTransformParams {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['id', 'position', 'scale', 'rotation', 'opacity', 'z', 'durationSeconds', 'ease']);
  return compact({
    id: expectString(record.id, `${path}.id`),
    position: optionalVec2(record.position, `${path}.position`),
    scale: optionalFiniteNumber(record.scale, `${path}.scale`),
    rotation: optionalFiniteNumber(record.rotation, `${path}.rotation`),
    opacity: optionalFiniteNumber(record.opacity, `${path}.opacity`),
    z: optionalFiniteNumber(record.z, `${path}.z`),
    durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
    ease: optionalString(record.ease, `${path}.ease`),
  });
}

/**
 * ADR-0022: exact empty-string motion is a legal performance placeholder.
 * Whitespace-only motion remains illegal and is not auto-trimmed.
 */
function parsePerformanceMotion(input: unknown, path: string): CharacterPerformanceParams['motion'] {
  if (input === undefined) return undefined;
  if (input === '') return input;
  if (typeof input === 'string' && input.trim() === '') {
    throw new Error(`Expected non-empty string at ${path}`);
  }
  return parseCharacterMotionOutput(input, path);
}

export function parseCharacterPerformanceParams(input: unknown, path: string): CharacterPerformanceParams {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['target', 'motion', 'expression', 'lookAt', 'blink']);
  const lookAt = parseLookAt(record.lookAt, `${path}.lookAt`);
  const blink = parseBlink(record.blink, `${path}.blink`);
  const motion = parsePerformanceMotion(record.motion, `${path}.motion`);
  if (
    motion === undefined &&
    record.expression === undefined &&
    lookAt === undefined &&
    blink === undefined
  ) {
    throw new Error(`Expected at least one performance field at ${path}`);
  }
  return compact({
    target: expectString(record.target, `${path}.target`),
    motion,
    expression: optionalString(record.expression, `${path}.expression`),
    lookAt,
    blink,
  });
}

function parseCharacterMotionOutput(input: unknown, path: string): CharacterMotionOutput | undefined {
  if (input === undefined) return undefined;
  const record = expectRecord(input, path);
  const kind = expectOneOf(record.kind, `${path}.kind`, ['resource', 'custom']);
  if (kind === 'resource') {
    expectKeys(record, path, ['kind', 'key', 'fadeInSeconds']);
    return compact({
      kind,
      key: expectString(record.key, `${path}.key`),
      fadeInSeconds: optionalNonNegativeNumber(record.fadeInSeconds, `${path}.fadeInSeconds`),
    });
  }

  expectKeys(record, path, ['kind', 'durationSeconds', 'fadeInSeconds', 'derivedFrom', 'tracks']);
  const motion: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
    kind,
    durationSeconds: expectFiniteNumber(record.durationSeconds, `${path}.durationSeconds`),
    fadeInSeconds: expectFiniteNumber(record.fadeInSeconds, `${path}.fadeInSeconds`),
    derivedFrom: parseCustomMotionDerivedFrom(record.derivedFrom, `${path}.derivedFrom`),
    tracks: parseCustomMotionTracks(record.tracks, `${path}.tracks`),
  };
  try {
    assertCanonicalCustomMotion(motion);
  } catch (error) {
    if (error instanceof CustomMotionContractError) {
      throw new Error(`${error.message} at ${path}.${error.path}`);
    }
    throw error;
  }
  return motion;
}

function parseCustomMotionDerivedFrom(input: unknown, path: string): CustomMotionDerivedFrom {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['key', 'fadeInSeconds', 'fadeOutSeconds']);
  return compact({
    key: expectString(record.key, `${path}.key`),
    fadeInSeconds: optionalFiniteNumber(record.fadeInSeconds, `${path}.fadeInSeconds`),
    fadeOutSeconds: optionalFiniteNumber(record.fadeOutSeconds, `${path}.fadeOutSeconds`),
  });
}

function parseCustomMotionTracks(input: unknown, path: string): CustomMotionTrack[] {
  if (!Array.isArray(input)) throw new Error(`Expected array at ${path}`);
  return input.map((track, index) => parseCustomMotionTrack(track, `${path}[${index}]`));
}

function parseCustomMotionTrack(input: unknown, path: string): CustomMotionTrack {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['parameterId', 'fadeInSeconds', 'keyframes']);
  return compact({
    parameterId: expectString(record.parameterId, `${path}.parameterId`),
    fadeInSeconds: optionalFiniteNumber(record.fadeInSeconds, `${path}.fadeInSeconds`),
    keyframes: parseCustomMotionKeyframes(record.keyframes, `${path}.keyframes`),
  });
}

function parseCustomMotionKeyframes(input: unknown, path: string): CustomMotionKeyframe[] {
  if (!Array.isArray(input)) throw new Error(`Expected array at ${path}`);
  return input.map((keyframe, index) => parseCustomMotionKeyframe(keyframe, `${path}[${index}]`));
}

function parseCustomMotionKeyframe(
  input: unknown,
  path: string,
): CustomMotionKeyframe {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['time', 'value', 'segment']);
  return compact({
    time: expectFiniteNumber(record.time, `${path}.time`),
    value: expectFiniteNumber(record.value, `${path}.value`),
    segment: parseCustomMotionSegment(record.segment, `${path}.segment`),
  });
}

function parseCustomMotionSegment(
  input: unknown,
  path: string,
): CustomMotionSegment | undefined {
  if (input === undefined) return undefined;
  const record = expectRecord(input, path);
  const type = expectOneOf(record.type, `${path}.type`, ['linear', 'bezier', 'stepped', 'inverseStepped']);
  if (type === 'bezier') {
    expectKeys(record, path, ['type', 'controlPoints']);
    return {
      type,
      controlPoints: parseCustomMotionControlPoints(record.controlPoints, `${path}.controlPoints`),
    };
  }
  expectKeys(record, path, ['type']);
  return { type };
}

function parseCustomMotionControlPoints(
  input: unknown,
  path: string,
): readonly [{ readonly time: number; readonly value: number }, { readonly time: number; readonly value: number }] {
  if (!Array.isArray(input)) throw new Error(`Expected array at ${path}`);
  return input.map((point, index) => parseCustomMotionControlPoint(point, `${path}[${index}]`)) as unknown as readonly [
    { readonly time: number; readonly value: number },
    { readonly time: number; readonly value: number },
  ];
}

function parseCustomMotionControlPoint(input: unknown, path: string): { readonly time: number; readonly value: number } {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['time', 'value']);
  return {
    time: expectFiniteNumber(record.time, `${path}.time`),
    value: expectFiniteNumber(record.value, `${path}.value`),
  };
}


function parseLookAt(input: unknown, path: string): CharacterPerformanceParams['lookAt'] {
  if (input === undefined) return undefined;
  const record = expectRecord(input, path);
  expectKeys(record, path, ['target', 'point', 'enabled', 'intensity']);
  return compact({
    target: optionalString(record.target, `${path}.target`),
    point: optionalVec2(record.point, `${path}.point`),
    enabled: optionalBoolean(record.enabled, `${path}.enabled`),
    intensity: optionalFiniteNumber(record.intensity, `${path}.intensity`),
  });
}

function parseBlink(input: unknown, path: string): CharacterPerformanceParams['blink'] {
  if (input === undefined) return undefined;
  const record = expectRecord(input, path);
  expectKeys(record, path, ['enabled', 'interval', 'intervalRange']);
  return compact({
    enabled: optionalBoolean(record.enabled, `${path}.enabled`),
    interval: optionalNonNegativeNumber(record.interval, `${path}.interval`),
    intervalRange: optionalNonNegativeNumber(record.intervalRange, `${path}.intervalRange`),
  });
}

export function parseCameraParams(input: unknown, path: string): CameraParams {
  const record = expectRecord(input, path);
  const mode = expectOneOf(record.mode, `${path}.mode`, [
    'focus',
    'move',
    'follow',
    'path',
    'shake',
    'hitchcock',
    'reset',
  ]);
  switch (mode) {
    case 'focus':
      expectKeys(record, path, ['mode', 'target', 'targetPart', 'position', 'zoom', 'rotation', 'durationSeconds', 'ease']);
      if (record.target === undefined && record.position === undefined) {
        throw new Error(`Expected target or position at ${path}`);
      }
      return compact({
        mode,
        target: optionalDiagnosticString(record.target, `${path}.target`),
        targetPart: optionalOneOf(record.targetPart, `${path}.targetPart`, ['head', 'chest', 'feet', 'center']),
        position: optionalVec2(record.position, `${path}.position`),
        zoom: parseZoomIntent(record.zoom, `${path}.zoom`),
        rotation: optionalFiniteNumber(record.rotation, `${path}.rotation`),
        durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
        ease: optionalString(record.ease, `${path}.ease`),
      });
    case 'move':
      // Accept the short-lived start-point field when opening an existing scene,
      // but discard it so authored camera moves always start from live state.
      expectKeys(record, path, ['mode', 'position', 'from', 'to', 'zoom', 'rotation', 'durationSeconds', 'ease']);
      return compact({
        mode,
        position: optionalVec2(record.position, `${path}.position`),
        to: optionalVec2(record.to, `${path}.to`),
        zoom: parseZoomIntent(record.zoom, `${path}.zoom`),
        rotation: optionalFiniteNumber(record.rotation, `${path}.rotation`),
        durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
        ease: optionalString(record.ease, `${path}.ease`),
      });
    case 'follow':
      expectKeys(record, path, ['mode', 'operation', 'target', 'offset', 'smoothing']);
      return compact({
        mode,
        operation: expectOneOf(record.operation, `${path}.operation`, ['start', 'stop']),
        target: optionalDiagnosticString(record.target, `${path}.target`),
        offset: optionalVec2(record.offset, `${path}.offset`),
        smoothing: optionalFiniteNumber(record.smoothing, `${path}.smoothing`),
      });
    case 'path':
      expectKeys(record, path, ['mode', 'keyframes', 'durationSeconds', 'ease', 'loop', 'repeat', 'yoyo']);
      return compact({
        mode,
        keyframes: parseCameraKeyframes(record.keyframes, `${path}.keyframes`),
        durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
        ease: optionalString(record.ease, `${path}.ease`),
        loop: optionalBoolean(record.loop, `${path}.loop`),
        repeat: optionalFiniteNumber(record.repeat, `${path}.repeat`),
        yoyo: optionalBoolean(record.yoyo, `${path}.yoyo`),
      });
    case 'shake':
      expectKeys(record, path, ['mode', 'intensity', 'frequency', 'durationSeconds', 'decay', 'direction']);
      return compact({
        mode,
        intensity: optionalFiniteNumber(record.intensity, `${path}.intensity`),
        frequency: optionalFiniteNumber(record.frequency, `${path}.frequency`),
        durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
        decay: optionalBoolean(record.decay, `${path}.decay`),
        direction: optionalOneOf(record.direction, `${path}.direction`, ['both', 'horizontal', 'vertical']),
      });
    case 'hitchcock':
      expectKeys(record, path, [
        'mode',
        'target',
        'targetPart',
        'screenTarget',
        'zoomStart',
        'zoomEnd',
        'scaleStart',
        'scaleEnd',
        'durationSeconds',
        'ease',
      ]);
      return compact({
        mode,
        target: expectString(record.target, `${path}.target`),
        targetPart: optionalOneOf(record.targetPart, `${path}.targetPart`, ['head', 'chest', 'feet', 'center']),
        screenTarget: optionalVec2(record.screenTarget, `${path}.screenTarget`),
        zoomStart: expectFiniteNumber(record.zoomStart, `${path}.zoomStart`),
        zoomEnd: expectFiniteNumber(record.zoomEnd, `${path}.zoomEnd`),
        scaleStart: expectFiniteNumber(record.scaleStart, `${path}.scaleStart`),
        scaleEnd: expectFiniteNumber(record.scaleEnd, `${path}.scaleEnd`),
        durationSeconds: expectPositiveNumber(record.durationSeconds, `${path}.durationSeconds`),
        ease: optionalString(record.ease, `${path}.ease`),
      });
    case 'reset':
      expectKeys(record, path, ['mode', 'durationSeconds', 'ease']);
      return compact({
        mode,
        durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
        ease: optionalString(record.ease, `${path}.ease`),
      });
  }
}

function parseCameraKeyframes(input: unknown, path: string): Extract<CameraParams, { mode: 'path' }>['keyframes'] {
  if (!Array.isArray(input) || input.length < 2) {
    throw new Error(`Expected at least two camera keyframes at ${path}`);
  }
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = expectRecord(item, itemPath);
    expectKeys(record, itemPath, ['time', 'position', 'zoom', 'rotation', 'ease', 'label']);
    return compact({
      time: expectFiniteNumber(record.time, `${itemPath}.time`),
      position: optionalVec2(record.position, `${itemPath}.position`),
      zoom: optionalFiniteNumber(record.zoom, `${itemPath}.zoom`),
      rotation: optionalFiniteNumber(record.rotation, `${itemPath}.rotation`),
      ease: optionalString(record.ease, `${itemPath}.ease`),
      label: optionalString(record.label, `${itemPath}.label`),
    });
  });
}

export function parseEnvironmentLayerParams(input: unknown, path: string): EnvironmentLayerParams {
  const record = expectRecord(input, path);
  expectKeys(record, path, [
    'mode',
    'layerId',
    'label',
    'file',
    'image',
    'position',
    'scale',
    'rotation',
    'opacity',
    'z',
    'zIndex',
    'durationSeconds',
    'ease',
    'transition',
  ]);
  return compact({
    mode: expectOneOf(record.mode, `${path}.mode`, ['set', 'transform', 'remove']),
    layerId: expectString(record.layerId, `${path}.layerId`),
    label: optionalString(record.label, `${path}.label`),
    file: optionalResourcePath(record.file, `${path}.file`),
    image: optionalResourcePath(record.image, `${path}.image`),
    position: optionalVec2(record.position, `${path}.position`),
    scale: optionalFiniteNumber(record.scale, `${path}.scale`),
    rotation: optionalFiniteNumber(record.rotation, `${path}.rotation`),
    opacity: optionalFiniteNumber(record.opacity, `${path}.opacity`),
    z: optionalFiniteNumber(record.z, `${path}.z`),
    zIndex: optionalFiniteNumber(record.zIndex, `${path}.zIndex`),
    durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
    ease: optionalString(record.ease, `${path}.ease`),
    transition: optionalString(record.transition, `${path}.transition`),
  });
}

export function parseVisualStyleParams(input: unknown, path: string): VisualStyleParams {
  const record = expectRecord(input, path);
  if (record.scope !== 'object') {
    throw new Error(`Lens visualStyle is not supported in the current Scene Document at ${path}; use filterAdd/filterChange/filterReset`);
  }
  const target = expectString(record.target, `${path}.target`);
  const slot = expectOneOf(record.slot, `${path}.slot`, ['grounding', 'integration', 'accent', 'distortion', 'rim-light']);
  const mode = expectOneOf(record.mode, `${path}.mode`, ['set', 'modulate', 'reset']);
  const common = {
    scope: 'object' as const,
    target,
    slot,
    durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
  };

  if (mode === 'reset') {
    expectKeys(record, path, ['scope', 'target', 'slot', 'mode', 'durationSeconds']);
    return { ...common, mode };
  }

  expectKeys(record, path, [
    'scope',
    'target',
    'slot',
    'mode',
    'recipeId',
    'intensity',
    ...(slot === 'integration' ? ['brightness'] : []),
    'warmth',
    'bloom',
    'rgbSplit',
    'blend',
    'contamination',
    'colorStops',
    'colorBlendMode',
    'color',
    'thickness',
    'angle',
    'softness',
    'shadowDistance',
    'shadowSoftness',
    'semanticOverride',
    'advancedOverride',
    'durationSeconds',
  ]);

  if (mode === 'set' && slot !== 'rim-light' && record.recipeId === undefined) {
    throw new Error(`Expected recipeId for set visualStyle at ${path}.recipeId`);
  }
  if (mode === 'modulate' && record.recipeId !== undefined) {
    throw new Error(`Modulate visualStyle cannot replace its recipe at ${path}.recipeId`);
  }
  if (slot === 'rim-light' && record.recipeId !== undefined) {
    throw new Error(`Rim-light visualStyle does not accept recipeId at ${path}.recipeId`);
  }

  return compact({
    ...common,
    mode,
    ...(record.recipeId !== undefined ? { recipeId: expectString(record.recipeId, `${path}.recipeId`) } : {}),
    intensity: optionalFiniteNumber(record.intensity, `${path}.intensity`),
    ...(slot === 'integration' ? { brightness: optionalNumberBetween(record.brightness, `${path}.brightness`, -1, 1) } : {}),
    warmth: optionalFiniteNumber(record.warmth, `${path}.warmth`),
    bloom: optionalFiniteNumber(record.bloom, `${path}.bloom`),
    rgbSplit: optionalFiniteNumber(record.rgbSplit, `${path}.rgbSplit`),
    blend: optionalFiniteNumber(record.blend, `${path}.blend`),
    contamination: optionalFiniteNumber(record.contamination, `${path}.contamination`),
    colorStops: optionalStringArray(record.colorStops, `${path}.colorStops`),
    colorBlendMode: optionalOneOf(record.colorBlendMode, `${path}.colorBlendMode`, BLEND_MODES),
    color: optionalString(record.color, `${path}.color`),
    thickness: optionalNonNegativeNumber(record.thickness, `${path}.thickness`),
    angle: optionalFiniteNumber(record.angle, `${path}.angle`),
    softness: optionalNonNegativeNumber(record.softness, `${path}.softness`),
    shadowDistance: optionalNonNegativeNumber(record.shadowDistance, `${path}.shadowDistance`),
    shadowSoftness: optionalNonNegativeNumber(record.shadowSoftness, `${path}.shadowSoftness`),
    semanticOverride: optionalSemanticStyleOverride(record.semanticOverride, `${path}.semanticOverride`, slot === 'integration'),
    advancedOverride: optionalAdvancedStyleOverride(record.advancedOverride, `${path}.advancedOverride`),
  }) as VisualStyleParams;
}

function parseLensFilterOverrides(
  record: Record<string, unknown>,
  path: string,
): Pick<FilterAddParams, 'intensity' | 'warmth' | 'bloom' | 'rgbSplit' | 'blend' | 'contamination' | 'durationSeconds'> {
  return compact({
    intensity: optionalFiniteNumber(record.intensity, `${path}.intensity`),
    warmth: optionalFiniteNumber(record.warmth, `${path}.warmth`),
    bloom: optionalFiniteNumber(record.bloom, `${path}.bloom`),
    rgbSplit: optionalFiniteNumber(record.rgbSplit, `${path}.rgbSplit`),
    blend: optionalFiniteNumber(record.blend, `${path}.blend`),
    contamination: optionalFiniteNumber(record.contamination, `${path}.contamination`),
    durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
  });
}

/** @deprecated Parse historical lens filter statements for compatibility only. */
export function parseFilterAddParams(input: unknown, path: string): FilterAddParams {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['recipeId', 'intensity', 'warmth', 'bloom', 'rgbSplit', 'blend', 'contamination', 'durationSeconds']);
  return {
    recipeId: expectString(record.recipeId, `${path}.recipeId`),
    ...parseLensFilterOverrides(record, path),
  };
}

/** @deprecated Parse historical lens filter statements for compatibility only. */
export function parseFilterChangeParams(input: unknown, path: string): FilterChangeParams {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['fromRecipeId', 'recipeId', 'intensity', 'warmth', 'bloom', 'rgbSplit', 'blend', 'contamination', 'durationSeconds']);
  return {
    fromRecipeId: expectString(record.fromRecipeId, `${path}.fromRecipeId`),
    recipeId: expectString(record.recipeId, `${path}.recipeId`),
    ...parseLensFilterOverrides(record, path),
  };
}

/** @deprecated Parse historical lens filter statements for compatibility only. */
export function parseFilterResetParams(input: unknown, path: string): FilterResetParams {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['durationSeconds']);
  return compact({
    durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
  });
}

export function parseLightingParams(input: unknown, path: string): LightingParams {
  const record = expectRecord(input, path);
  const effect = expectOneOf(record.effect, `${path}.effect`, ['preset', 'blur', 'godrays', 'post', 'overlay', 'pointLight']);
  const mode = expectOneOf(record.mode, `${path}.mode`, ['set', 'modulate', 'reset', 'remove', 'clear']);
  const durationSeconds = optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`);

  if (effect === 'preset') {
    if (mode === 'reset') {
      expectKeys(record, path, ['effect', 'mode', 'durationSeconds']);
      return { effect, mode, durationSeconds };
    }
    if (mode !== 'set' && mode !== 'modulate') throw new Error('Invalid mode for lighting preset at ' + path + '.mode');
    expectKeys(record, path, ['effect', 'mode', 'preset', 'intensity', 'durationSeconds']);
    return compact({
      effect,
      mode,
      preset: diagnosticString(record.preset, `${path}.preset`),
      intensity: optionalFiniteNumber(record.intensity, `${path}.intensity`),
      durationSeconds,
    });
  }

  if (effect === 'blur') {
    if (mode === 'reset') {
      expectKeys(record, path, ['effect', 'mode', 'target', 'durationSeconds']);
      return compact({
        effect,
        mode,
        target: optionalDiagnosticOneOf(record.target, `${path}.target`, ['global', 'background', 'characters']),
        durationSeconds,
      });
    }
    if (mode !== 'set' && mode !== 'modulate') throw new Error('Invalid mode for blur at ' + path + '.mode');
    expectKeys(record, path, ['effect', 'mode', 'target', 'intensity', 'durationSeconds']);
    return compact({
      effect,
      mode,
      target: optionalDiagnosticOneOf(record.target, `${path}.target`, ['global', 'background', 'characters']),
      intensity: optionalFiniteNumber(record.intensity, `${path}.intensity`),
      durationSeconds,
    });
  }

  if (effect === 'godrays') {
    if (mode === 'reset') {
      expectKeys(record, path, ['effect', 'mode', 'durationSeconds']);
      return { effect, mode, durationSeconds };
    }
    if (mode !== 'set' && mode !== 'modulate') throw new Error('Invalid mode for godrays at ' + path + '.mode');
    expectKeys(record, path, ['effect', 'mode', 'intensity', 'angle', 'lacunarity', 'durationSeconds']);
    return compact({
      effect,
      mode,
      intensity: optionalFiniteNumber(record.intensity, `${path}.intensity`),
      angle: optionalFiniteNumber(record.angle, `${path}.angle`),
      lacunarity: optionalFiniteNumber(record.lacunarity, `${path}.lacunarity`),
      durationSeconds,
    });
  }

  if (effect === 'post') {
    const postKeys = [
      'target',
      'bloomThreshold',
      'bloomBloomScale',
      'bloomBrightness',
      'rgbSplitX',
      'rgbSplitY',
      'godrayGain',
      'godrayLacunarity',
      'godrayAngle',
      'adjGamma',
      'adjContrast',
      'adjSaturation',
      'adjBrightness',
      'adjRed',
      'adjGreen',
      'adjBlue',
      'overlayColor',
      'overlayBlendMode',
      'overlayIntensity',
    ] as const;
    if (mode === 'reset') {
      expectKeys(record, path, ['effect', 'mode', 'target', 'durationSeconds']);
      return compact({
        effect,
        mode,
        target: optionalDiagnosticString(record.target, `${path}.target`),
        durationSeconds,
      }) as LightingParams;
    }
    if (mode !== 'set' && mode !== 'modulate') throw new Error('Invalid mode for post at ' + path + '.mode');
    expectKeys(record, path, ['effect', 'mode', ...postKeys, 'durationSeconds']);
    const values = {
      target: optionalDiagnosticString(record.target, `${path}.target`),
      bloomThreshold: optionalFiniteNumber(record.bloomThreshold, `${path}.bloomThreshold`),
      bloomBloomScale: optionalFiniteNumber(record.bloomBloomScale, `${path}.bloomBloomScale`),
      bloomBrightness: optionalFiniteNumber(record.bloomBrightness, `${path}.bloomBrightness`),
      rgbSplitX: optionalFiniteNumber(record.rgbSplitX, `${path}.rgbSplitX`),
      rgbSplitY: optionalFiniteNumber(record.rgbSplitY, `${path}.rgbSplitY`),
      godrayGain: optionalFiniteNumber(record.godrayGain, `${path}.godrayGain`),
      godrayLacunarity: optionalFiniteNumber(record.godrayLacunarity, `${path}.godrayLacunarity`),
      godrayAngle: optionalFiniteNumber(record.godrayAngle, `${path}.godrayAngle`),
      adjGamma: optionalFiniteNumber(record.adjGamma, `${path}.adjGamma`),
      adjContrast: optionalFiniteNumber(record.adjContrast, `${path}.adjContrast`),
      adjSaturation: optionalFiniteNumber(record.adjSaturation, `${path}.adjSaturation`),
      adjBrightness: optionalFiniteNumber(record.adjBrightness, `${path}.adjBrightness`),
      adjRed: optionalFiniteNumber(record.adjRed, `${path}.adjRed`),
      adjGreen: optionalFiniteNumber(record.adjGreen, `${path}.adjGreen`),
      adjBlue: optionalFiniteNumber(record.adjBlue, `${path}.adjBlue`),
      overlayColor: optionalString(record.overlayColor, `${path}.overlayColor`),
      overlayBlendMode: optionalOneOf(record.overlayBlendMode, `${path}.overlayBlendMode`, BLEND_MODES),
      overlayIntensity: optionalFiniteNumber(record.overlayIntensity, `${path}.overlayIntensity`),
    };
    return compact({ effect, mode, ...values, durationSeconds }) as LightingParams;
  }

  if (effect === 'overlay') {
    if (mode === 'clear') {
      expectKeys(record, path, ['effect', 'mode', 'durationSeconds']);
      return { effect, mode, durationSeconds };
    }
    if (mode === 'remove') {
      expectKeys(record, path, ['effect', 'mode', 'id', 'durationSeconds']);
      return { effect, mode, id: diagnosticString(record.id, `${path}.id`), durationSeconds };
    }
    if (mode !== 'set' && mode !== 'modulate') throw new Error('Invalid mode for overlay at ' + path + '.mode');
    expectKeys(record, path, ['effect', 'mode', 'id', 'color', 'blendMode', 'intensity', 'durationSeconds']);
    return compact({
      effect,
      mode,
      id: diagnosticString(record.id, `${path}.id`),
      color: optionalString(record.color, `${path}.color`),
      blendMode: optionalOneOf(record.blendMode, `${path}.blendMode`, BLEND_MODES),
      intensity: optionalFiniteNumber(record.intensity, `${path}.intensity`),
      durationSeconds,
    });
  }

  if (mode === 'clear') {
    expectKeys(record, path, ['effect', 'mode', 'durationSeconds']);
    return { effect, mode, durationSeconds };
  }
  if (mode === 'remove') {
    expectKeys(record, path, ['effect', 'mode', 'id', 'durationSeconds']);
    return { effect, mode, id: diagnosticString(record.id, `${path}.id`), durationSeconds };
  }
  if (mode !== 'set' && mode !== 'modulate') throw new Error('Invalid mode for pointLight at ' + path + '.mode');
  expectKeys(record, path, ['effect', 'mode', 'id', 'x', 'y', 'color', 'radius', 'intensity', 'durationSeconds']);
  return compact({
    effect,
    mode,
    id: diagnosticString(record.id, `${path}.id`),
    x: optionalFiniteNumber(record.x, `${path}.x`),
    y: optionalFiniteNumber(record.y, `${path}.y`),
    color: optionalString(record.color, `${path}.color`),
    radius: optionalFiniteNumber(record.radius, `${path}.radius`),
    intensity: optionalFiniteNumber(record.intensity, `${path}.intensity`),
    durationSeconds,
  });
}

export function parseAudioParams(input: unknown, path: string): AudioParams {
  const record = expectRecord(input, path);
  const role = expectOneOf(record.role, `${path}.role`, ['bgm', 'sfx']);
  const mode = expectOneOf(record.mode, `${path}.mode`, ['play', 'stop']);
  if (role === 'bgm' && mode === 'play') {
    expectKeys(record, path, ['role', 'mode', 'file', 'volume', 'loop', 'fadeIn', 'fadeOut']);
    return compact({
      role,
      mode,
      file: optionalResourcePath(record.file, `${path}.file`) ?? '',
      volume: optionalFiniteNumber(record.volume, `${path}.volume`),
      loop: optionalBoolean(record.loop, `${path}.loop`),
      fadeIn: optionalNonNegativeNumber(record.fadeIn, `${path}.fadeIn`),
      fadeOut: optionalNonNegativeNumber(record.fadeOut, `${path}.fadeOut`),
    });
  }
  if (role === 'bgm') {
    expectKeys(record, path, ['role', 'mode', 'fadeOut']);
    return compact({
      role,
      mode: 'stop',
      fadeOut: optionalNonNegativeNumber(record.fadeOut, `${path}.fadeOut`),
    });
  }
  if (mode === 'play') {
    expectKeys(record, path, [
      'role',
      'mode',
      'instanceId',
      'file',
      'volume',
      'loop',
      'durationSeconds',
      'fadeIn',
      'fadeOut',
    ]);
    return compact({
      role,
      mode,
      instanceId: expectString(record.instanceId, `${path}.instanceId`),
      file: optionalResourcePath(record.file, `${path}.file`) ?? '',
      volume: optionalFiniteNumber(record.volume, `${path}.volume`),
      loop: optionalBoolean(record.loop, `${path}.loop`),
      durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
      fadeIn: optionalNonNegativeNumber(record.fadeIn, `${path}.fadeIn`),
      fadeOut: optionalNonNegativeNumber(record.fadeOut, `${path}.fadeOut`),
    });
  }
  expectKeys(record, path, ['role', 'mode', 'instanceId', 'fadeOut']);
  return compact({
    role,
    mode: 'stop',
    instanceId: expectString(record.instanceId, `${path}.instanceId`),
    fadeOut: optionalNonNegativeNumber(record.fadeOut, `${path}.fadeOut`),
  });
}

export function parseGraphicLayerParams(input: unknown, path: string): GraphicLayerParams {
  const record = expectRecord(input, path);
  const kind = expectOneOf(record.kind, `${path}.kind`, ['image', 'text']);
  const allowed = [
    'kind',
    'mode',
    'id',
    'file',
    'text',
    'position',
    'scale',
    'rotation',
    'opacity',
    'z',
    'zIndex',
    'durationSeconds',
    'ease',
    'fontFamily',
    'fontSize',
    'color',
    'style',
  ];
  expectKeys(record, path, allowed);
  const base = compact({
    kind,
    mode: expectOneOf(record.mode, `${path}.mode`, ['set', 'transform', 'remove']),
    id: expectString(record.id, `${path}.id`),
    position: optionalVec2(record.position, `${path}.position`),
    scale: optionalFiniteNumber(record.scale, `${path}.scale`),
    rotation: optionalFiniteNumber(record.rotation, `${path}.rotation`),
    opacity: optionalFiniteNumber(record.opacity, `${path}.opacity`),
    z: optionalFiniteNumber(record.z, `${path}.z`),
    zIndex: optionalFiniteNumber(record.zIndex, `${path}.zIndex`),
    durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
    ease: optionalString(record.ease, `${path}.ease`),
  });
  if (kind === 'image') {
    return compact({
      ...base,
      kind,
      file: optionalResourcePath(record.file, `${path}.file`),
    });
  }
  return compact({
    ...base,
    kind,
    text: optionalString(record.text, `${path}.text`),
    fontFamily: optionalString(record.fontFamily, `${path}.fontFamily`),
    fontSize: optionalFiniteNumber(record.fontSize, `${path}.fontSize`),
    color: optionalString(record.color, `${path}.color`),
    style: optionalString(record.style, `${path}.style`),
  });
}

export function parseCustomAnimationParams(input: unknown, path: string): CustomAnimationParams {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['target', 'file', 'animation', 'durationSeconds', 'loop']);
  if (record.file === undefined && record.animation === undefined) {
    throw new Error(`Expected file or animation at ${path}`);
  }
  return compact({
    target: expectString(record.target, `${path}.target`),
    file: optionalResourcePath(record.file, `${path}.file`),
    animation: optionalResourcePath(record.animation, `${path}.animation`),
    durationSeconds: expectPositiveNumber(record.durationSeconds, `${path}.durationSeconds`),
    loop: optionalBoolean(record.loop, `${path}.loop`),
  });
}

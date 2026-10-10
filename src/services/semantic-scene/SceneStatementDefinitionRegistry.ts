import type {
  AudioParams,
  CameraPathKeyframe,
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
  SceneStatement,
  SceneStatementDraft,
  StatementCategory,
  StatementFamily,
  StatementParamsByFamily,
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

export interface AssetReferenceField {
  readonly path: string;
  readonly value: string;
  readonly kind: ResourceImportKind;
  readonly resourceKind: ResourceKind;
}

export interface CompiledAssetSlotDefinition {
  readonly outputKey: string;
  readonly path: string;
  readonly kind: ResourceImportKind;
}

export interface SourceAssetSlotDefinition {
  readonly path: string;
  readonly kind: ResourceImportKind;
  readonly resourceKind: ResourceKind;
}

export interface SceneStatementTimelinePresentation {
  readonly label: string;
  readonly iconKey: string;
}

/**
 * Metadata consumed by the renderer-agnostic semantic patch seam. Technical
 * identity is structural metadata, not a convention based on field names:
 * params.id and other domain keys remain visible to an agent.
 */
export interface SceneStatementPatchMetadata {
  readonly hiddenTechnicalIdentityPaths?: readonly string[];
  readonly statementForbiddenPatchPaths?: readonly string[];
  readonly companionForbiddenPatchPaths?: readonly string[];
}

export type TimelineStateSpanPresentationPreference = 'auto' | 'endpoint' | 'span';

export interface TimelineStateSpanTargetRule {
  readonly namespace: string;
  readonly fields: readonly string[];
  readonly optionalFields?: readonly string[];
}

export interface SceneStatementLifecyclePresentation<Family extends StatementFamily = StatementFamily> {
  readonly variant: string;
  readonly presentationTypeKey: `${Family}:${string}`;
  readonly when?: Readonly<Record<string, string>>;
  readonly operationField: string;
  readonly startOperations: readonly string[];
  readonly endOperations: readonly string[];
  readonly target: TimelineStateSpanTargetRule;
  readonly transitionDurationFields?: {
    readonly start?: string;
    readonly end?: string;
  };
  readonly configurable: true;
  readonly settingsLabel: string;
  readonly settingsGroup: string;
  readonly settingsOrder: number;
  readonly defaultPreference: TimelineStateSpanPresentationPreference;
}

export interface RegisteredSceneStatementLifecyclePresentation extends SceneStatementLifecyclePresentation {
  readonly family: StatementFamily;
}

export interface ResolvedSceneStatementLifecyclePresentation {
  readonly definition: RegisteredSceneStatementLifecyclePresentation;
  readonly boundary: 'start' | 'end';
  readonly stateKey: string;
  readonly transitionDurationSeconds: number;
}

export interface SceneStatementStateSpanDependency {
  readonly presentationTypeKey: string;
  readonly when?: Readonly<Record<string, string>>;
  readonly operationField?: string;
  readonly operations?: readonly string[];
  readonly target: TimelineStateSpanTargetRule;
  readonly inheritFields?: readonly string[];
}

export interface ResolvedSceneStatementStateSpanDependency {
  readonly presentationTypeKey: string;
  readonly stateKey: string;
}

export interface SceneStatementDefinition<Family extends StatementFamily = StatementFamily> {
  readonly family: Family;
  readonly category: StatementCategory;
  readonly label: string;
  readonly discriminators: readonly string[];
  readonly attachableTo?: readonly StatementFamily[];
  parseParams(input: unknown, path: string): StatementParamsByFamily[Family];
  temporalExtent(params: StatementParamsByFamily[Family]): number;
  collectAssetReferences(params: StatementParamsByFamily[Family]): readonly AssetReferenceField[];
  readonly compiledAssetSlots?: readonly CompiledAssetSlotDefinition[];
  readonly sourceAssetSlots?: readonly SourceAssetSlotDefinition[];
  readonly patchMetadata?: SceneStatementPatchMetadata;
  timelinePresentation(params: StatementParamsByFamily[Family]): SceneStatementTimelinePresentation;
  readonly lifecyclePresentations?: readonly SceneStatementLifecyclePresentation<Family>[];
  readonly stateSpanDependencies?: readonly SceneStatementStateSpanDependency[];
  isAttachable?(params: StatementParamsByFamily[Family], parentFamily: StatementFamily): boolean;
}

export const DEFAULT_CHARACTER_ENTER_TRANSITION = 'fadeIn';
export const DEFAULT_CHARACTER_EXIT_TRANSITION = 'fadeOut';
export const DEFAULT_CHARACTER_PRESENCE_TRANSITION_SECONDS = 0.6;
export const DEFAULT_ENVIRONMENT_SET_TRANSITION = 'crossFade';
export const DEFAULT_ENVIRONMENT_REMOVE_TRANSITION = 'fadeOut';
export const DEFAULT_ENVIRONMENT_SET_DURATION_SECONDS = 1;
export const DEFAULT_ENVIRONMENT_TRANSFORM_DURATION_SECONDS = 1;
export const DEFAULT_ENVIRONMENT_REMOVE_DURATION_SECONDS = 0.6;
export const DEFAULT_AUDIO_BGM_FADE_IN_SECONDS = 0.5;
export const DEFAULT_AUDIO_STOP_FADE_OUT_SECONDS = 0.5;
export const DEFAULT_FILTER_ADD_DURATION_SECONDS = 0.6;
export const DEFAULT_FILTER_CHANGE_DURATION_SECONDS = 0.6;
export const DEFAULT_FILTER_RESET_DURATION_SECONDS = 0.4;

export function resolveFilterTransitionDuration(
  params: FilterAddParams | FilterChangeParams | FilterResetParams,
): number {
  if (params.durationSeconds !== undefined) return params.durationSeconds;
  if ('fromRecipeId' in params) return DEFAULT_FILTER_CHANGE_DURATION_SECONDS;
  if ('recipeId' in params) return DEFAULT_FILTER_ADD_DURATION_SECONDS;
  return DEFAULT_FILTER_RESET_DURATION_SECONDS;
}

export type SceneStatementDefinitionMap = {
  readonly [Family in StatementFamily]: SceneStatementDefinition<Family>;
};

/**
 * Camera paths are authored in source space. Keep the editor fallback next to
 * the strict parser that enforces the same minimum cardinality, so a newly
 * created/editing path cannot temporarily become a one-keyframe statement.
 */
export const DEFAULT_CAMERA_PATH_KEYFRAMES: readonly CameraPathKeyframe[] = Object.freeze([
  Object.freeze({ time: 0, position: Object.freeze([0.5, 0.5]) as [number, number] }),
  Object.freeze({ time: 1, position: Object.freeze([0.5, 0.5]) as [number, number] }),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize an authoring value without discarding fields authored on valid
 * keyframes. One-keyframe values receive a cloned endpoint; empty/invalid
 * values receive the schema-safe neutral path.
 */
export function ensureCameraPathKeyframes(value: unknown): CameraPathKeyframe[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = undefined;
    }
  }

  const authored = Array.isArray(parsed)
    ? parsed
      .filter(isRecord)
      .map((keyframe) => ({
        ...keyframe,
        ...(Array.isArray(keyframe.position) ? { position: [...keyframe.position] } : {}),
      })) as CameraPathKeyframe[]
    : [];

  if (authored.length >= 2) return authored;
  if (authored.length === 1) {
    const first = authored[0];
    const firstTime = typeof first.time === 'number' && Number.isFinite(first.time) ? first.time : 0;
    return [
      first,
      {
        ...first,
        time: Math.max(1, firstTime + 1),
        ...(Array.isArray(first.position)
          ? { position: [...first.position] as [number, number] }
          : { position: [0.5, 0.5] as [number, number] }),
      },
    ];
  }

  return DEFAULT_CAMERA_PATH_KEYFRAMES.map((keyframe) => ({
    ...keyframe,
    position: [...(keyframe.position ?? [0.5, 0.5])] as [number, number],
  }));
}

function expectRecord(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Expected object at ${path}`);
  }
  return input as Record<string, unknown>;
}

function expectKeys(record: Record<string, unknown>, path: string, allowed: readonly string[]): void {
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

function optionalNonNegativeNumber(input: unknown, path: string): number | undefined {
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

function optionalBoolean(input: unknown, path: string): boolean | undefined {
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

function compact<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

function oneAsset(path: string, value: string | undefined, kind: ResourceImportKind, resourceKind: ResourceKind): readonly AssetReferenceField[] {
  return value ? [{ path, value, kind, resourceKind }] : [];
}

function collectDialogueAssets(params: DialogueParams): readonly AssetReferenceField[] {
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

function parseDialogueParams(input: unknown, path: string): DialogueParams {
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

function parseCharacterPresenceParams(input: unknown, path: string): CharacterPresenceParams {
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

function parseCharacterTransformParams(input: unknown, path: string): CharacterTransformParams {
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

function parseCharacterPerformanceParams(input: unknown, path: string): CharacterPerformanceParams {
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

function parseCameraParams(input: unknown, path: string): CameraParams {
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

function parseEnvironmentLayerParams(input: unknown, path: string): EnvironmentLayerParams {
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

function parseVisualStyleParams(input: unknown, path: string): VisualStyleParams {
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
function parseFilterAddParams(input: unknown, path: string): FilterAddParams {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['recipeId', 'intensity', 'warmth', 'bloom', 'rgbSplit', 'blend', 'contamination', 'durationSeconds']);
  return {
    recipeId: expectString(record.recipeId, `${path}.recipeId`),
    ...parseLensFilterOverrides(record, path),
  };
}

/** @deprecated Parse historical lens filter statements for compatibility only. */
function parseFilterChangeParams(input: unknown, path: string): FilterChangeParams {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['fromRecipeId', 'recipeId', 'intensity', 'warmth', 'bloom', 'rgbSplit', 'blend', 'contamination', 'durationSeconds']);
  return {
    fromRecipeId: expectString(record.fromRecipeId, `${path}.fromRecipeId`),
    recipeId: expectString(record.recipeId, `${path}.recipeId`),
    ...parseLensFilterOverrides(record, path),
  };
}

/** @deprecated Parse historical lens filter statements for compatibility only. */
function parseFilterResetParams(input: unknown, path: string): FilterResetParams {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['durationSeconds']);
  return compact({
    durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
  });
}

function parseLightingParams(input: unknown, path: string): LightingParams {
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

function parseAudioParams(input: unknown, path: string): AudioParams {
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

function parseGraphicLayerParams(input: unknown, path: string): GraphicLayerParams {
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

function parseCustomAnimationParams(input: unknown, path: string): CustomAnimationParams {
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

function resolveLifecycleTransitionDuration(
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

export class SceneStatementDefinitionRegistry {
  private readonly definitions: SceneStatementDefinitionMap;

  constructor(definitionMap: SceneStatementDefinitionMap = SCENE_STATEMENT_DEFINITIONS) {
    this.definitions = definitionMap;
  }

  get<Family extends StatementFamily>(family: Family): SceneStatementDefinition<Family> {
    return this.definitions[family];
  }

  patchMetadata(family: StatementFamily): SceneStatementPatchMetadata {
    return this.get(family).patchMetadata ?? SCENE_STATEMENT_PATCH_METADATA[family];
  }

  has(family: string): family is StatementFamily {
    return Object.prototype.hasOwnProperty.call(this.definitions, family);
  }

  list(): readonly SceneStatementDefinition[] {
    return Object.freeze(Object.values(this.definitions));
  }

  listLifecyclePresentations(): readonly RegisteredSceneStatementLifecyclePresentation[] {
    const entries = Object.values(this.definitions).flatMap((definition) => (
      (definition.lifecyclePresentations ?? []).map((presentation) => ({
        ...presentation,
        family: definition.family,
      } as RegisteredSceneStatementLifecyclePresentation))
    ));
    const keys = new Set<string>();
    for (const entry of entries) {
      if (keys.has(entry.presentationTypeKey)) {
        throw new Error(`Duplicate lifecycle presentation type: ${entry.presentationTypeKey}`);
      }
      if (!entry.presentationTypeKey.startsWith(`${entry.family}:`)) {
        throw new Error(`Lifecycle presentation type must use its family prefix: ${entry.presentationTypeKey}`);
      }
      if (entry.startOperations.length === 0 || entry.endOperations.length === 0) {
        throw new Error(`Lifecycle presentation must declare both boundaries: ${entry.presentationTypeKey}`);
      }
      if (entry.startOperations.some((operation) => entry.endOperations.includes(operation))) {
        throw new Error(`Lifecycle presentation boundaries overlap: ${entry.presentationTypeKey}`);
      }
      const targetFields = [...entry.target.fields, ...(entry.target.optionalFields ?? [])];
      if (new Set(targetFields).size !== targetFields.length) {
        throw new Error(`Lifecycle presentation target fields must be unique: ${entry.presentationTypeKey}`);
      }
      keys.add(entry.presentationTypeKey);
    }
    return Object.freeze(entries.sort((left, right) => left.settingsOrder - right.settingsOrder));
  }

  parseParams<Family extends StatementFamily>(
    family: Family,
    input: unknown,
    path: string,
  ): StatementParamsByFamily[Family] {
    return this.get(family).parseParams(input, path);
  }

  temporalExtent(statement: SceneStatement): number {
    const definition = this.get(statement.type);
    return definition.temporalExtent(statement.params as never);
  }

  collectAssetReferences(statement: SceneStatement): readonly AssetReferenceField[] {
    const definition = this.get(statement.type);
    return definition.collectAssetReferences(statement.params as never);
  }

  compiledAssetSlots(
    statement: Pick<SceneStatement, 'type'>,
    outputKey: string,
  ): readonly CompiledAssetSlotDefinition[] {
    return (this.get(statement.type).compiledAssetSlots ?? []).filter((slot) => slot.outputKey === outputKey);
  }

  sourceAssetSlot(
    statement: Pick<SceneStatement, 'type' | 'params'>,
    path: string,
  ): SourceAssetSlotDefinition | undefined {
    const slot = this.sourceAssetSlots(statement).find((candidate) => candidate.path === path);
    if (!slot) return undefined;
    if (statement.type === 'audio' && path === 'params.file') {
      const params = statement.params as AudioParams;
      return params.role === 'sfx'
        ? { path, kind: 'generic', resourceKind: 'sfx' }
        : slot;
    }
    return slot;
  }

  sourceAssetSlots(
    statement: Pick<SceneStatement, 'type' | 'params'>,
  ): readonly SourceAssetSlotDefinition[] {
    const slots = this.get(statement.type).sourceAssetSlots ?? [];
    const params = statement.params as unknown as Record<string, unknown>;
    if (statement.type === 'characterPresence' && params.mode !== 'enter') return [];
    if (statement.type === 'environmentLayer') {
      if (params.mode !== 'set') return [];
      const preferredPath = typeof params.file === 'string' && !params.image ? 'params.file' : 'params.image';
      return slots.filter((slot) => slot.path === preferredPath);
    }
    if (statement.type === 'audio' && params.mode !== 'play') return [];
    if (statement.type === 'graphicLayer' && (params.kind !== 'image' || params.mode !== 'set')) return [];
    if (statement.type === 'customAnimation') {
      const preferredPath = typeof params.animation === 'string' && !params.file ? 'params.animation' : 'params.file';
      return slots.filter((slot) => slot.path === preferredPath);
    }
    return slots;
  }

  timelinePresentation(statement: Pick<SceneStatement, 'type' | 'params'>): SceneStatementTimelinePresentation {
    const definition = this.get(statement.type);
    return definition.timelinePresentation(statement.params as never);
  }

  timelineLifecyclePresentation(
    statement: Pick<SceneStatement, 'type' | 'params'>,
  ): ResolvedSceneStatementLifecyclePresentation | undefined {
    const params = statement.params as unknown as Record<string, unknown>;
    const presentations = this.get(statement.type).lifecyclePresentations ?? [];
    for (const presentation of presentations) {
      if (presentation.when && Object.entries(presentation.when).some(([key, value]) => params[key] !== value)) {
        continue;
      }
      const operation = params[presentation.operationField];
      const boundary = presentation.startOperations.includes(operation as string)
        ? 'start'
        : presentation.endOperations.includes(operation as string)
          ? 'end'
          : undefined;
      if (!boundary) continue;
      const stateKey = resolveLifecycleStateKey(presentation.target, params);
      if (!stateKey) continue;
      const transitionDurationField = presentation.transitionDurationFields?.[boundary];
      const transitionDurationValue = transitionDurationField ? params[transitionDurationField] : undefined;
      return {
        definition: {
          ...presentation,
          family: statement.type,
        } as RegisteredSceneStatementLifecyclePresentation,
        boundary,
        stateKey,
        transitionDurationSeconds: resolveLifecycleTransitionDuration(
          statement,
          boundary,
          transitionDurationValue,
        ),
      };
    }
    return undefined;
  }

  timelineStateSpanDependency(
    statement: Pick<SceneStatement, 'type' | 'params'>,
  ): ResolvedSceneStatementStateSpanDependency | undefined {
    const params = statement.params as unknown as Record<string, unknown>;
    for (const dependency of this.get(statement.type).stateSpanDependencies ?? []) {
      if (dependency.when && Object.entries(dependency.when).some(([key, value]) => params[key] !== value)) {
        continue;
      }
      if (
        dependency.operationField
        && !dependency.operations?.includes(params[dependency.operationField] as string)
      ) {
        continue;
      }
      const stateKey = resolveLifecycleStateKey(dependency.target, params);
      if (!stateKey) continue;
      return {
        presentationTypeKey: dependency.presentationTypeKey,
        stateKey,
      };
    }
    return undefined;
  }

  materializeLifecycleEndDraft(
    startStatement: Pick<SceneStatement, 'type' | 'params'>,
    transitionDurationSeconds = 0,
    endParamsTemplate: Readonly<Record<string, unknown>> = {},
  ): SceneStatementDraft {
    const lifecycle = this.timelineLifecyclePresentation(startStatement);
    if (!lifecycle || lifecycle.boundary !== 'start') {
      throw new Error(`Statement is not a State Span start boundary: ${startStatement.type}`);
    }
    const definition = lifecycle.definition;
    const sourceParams = startStatement.params as unknown as Record<string, unknown>;
    const params: Record<string, unknown> = {
      ...endParamsTemplate,
      ...(definition.when ?? {}),
      [definition.operationField]: definition.endOperations[0],
    };
    for (const field of definition.target.fields) params[field] = sourceParams[field];
    for (const field of definition.target.optionalFields ?? []) {
      if (sourceParams[field] !== undefined) params[field] = sourceParams[field];
    }
    const durationField = definition.transitionDurationFields?.end;
    if (durationField) {
      params[durationField] = Number.isFinite(transitionDurationSeconds)
        ? Math.max(0, transitionDurationSeconds)
        : 0;
    }
    return {
      type: startStatement.type,
      params: this.parseParams(startStatement.type, params, 'materializedStateSpanEnd.params'),
    } as SceneStatementDraft;
  }

  materializeStateSpanDependencyDraft(
    startStatement: Pick<SceneStatement, 'type' | 'params'>,
    dependencyType: StatementFamily,
    presentationTypeKey: string,
    paramsTemplate: Readonly<Record<string, unknown>> = {},
  ): SceneStatementDraft {
    const lifecycle = this.timelineLifecyclePresentation(startStatement);
    if (
      !lifecycle
      || lifecycle.boundary !== 'start'
      || lifecycle.definition.presentationTypeKey !== presentationTypeKey
    ) {
      throw new Error(`Statement is not the requested State Span start boundary: ${presentationTypeKey}`);
    }
    const dependency = (this.get(dependencyType).stateSpanDependencies ?? [])
      .find((candidate) => candidate.presentationTypeKey === presentationTypeKey);
    if (!dependency) {
      throw new Error(`Statement family does not depend on State Span type: ${dependencyType} -> ${presentationTypeKey}`);
    }

    const sourceParams = startStatement.params as unknown as Record<string, unknown>;
    const params: Record<string, unknown> = {
      ...paramsTemplate,
      ...(dependency.when ?? {}),
    };
    if (dependency.operationField && dependency.operations?.[0]) {
      params[dependency.operationField] = dependency.operations[0];
    }
    for (const field of dependency.target.fields) params[field] = sourceParams[field];
    for (const field of dependency.target.optionalFields ?? []) {
      if (sourceParams[field] !== undefined) params[field] = sourceParams[field];
    }
    for (const field of dependency.inheritFields ?? []) {
      if (sourceParams[field] !== undefined) params[field] = sourceParams[field];
    }

    const draft = {
      type: dependencyType,
      params: this.parseParams(dependencyType, params, 'materializedStateSpanDependency.params'),
    } as SceneStatementDraft;
    const resolved = this.timelineStateSpanDependency(draft);
    if (
      !resolved
      || resolved.presentationTypeKey !== presentationTypeKey
      || resolved.stateKey !== lifecycle.stateKey
    ) {
      throw new Error(`Materialized dependency does not target its State Span: ${presentationTypeKey}`);
    }
    return draft;
  }

  isAttachableToDialogue(statement: Pick<SceneStatement, 'type' | 'params'>): boolean {
    const definition = this.get(statement.type);
    if (!definition.attachableTo?.includes('dialogue')) return false;
    return definition.isAttachable
      ? definition.isAttachable(statement.params as never, 'dialogue')
      : true;
  }
}

function resolveLifecycleStateKey(
  target: TimelineStateSpanTargetRule,
  params: Readonly<Record<string, unknown>>,
): string | undefined {
  const values: string[] = [];
  for (const field of target.fields) {
    const value = params[field];
    if (typeof value !== 'string' || value.length === 0) return undefined;
    values.push(`${field}=${JSON.stringify(value)}`);
  }
  for (const field of target.optionalFields ?? []) {
    const value = params[field];
    // Post-processing's omitted target is the panorama. Keep omitted and
    // explicit panorama statements in the same lifecycle state span so a
    // reset/modulate operation cannot accidentally pair with another target.
    if (value === undefined && target.namespace === 'lighting:post' && field === 'target') {
      values.push(`${field}=${JSON.stringify('panorama')}`);
      continue;
    }
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0) return undefined;
    values.push(`${field}=${JSON.stringify(value)}`);
  }
  return values.length > 0 ? `${target.namespace}:${values.join('|')}` : target.namespace;
}

export const sceneStatementDefinitionRegistry = new SceneStatementDefinitionRegistry();

/**
 * Deterministic execution-contract fingerprint over the statement families
 * the project-Agent write tools depend on (ADR0023): family identity, patch
 * metadata and asset-slot shapes. A changed registry between sessions must
 * trigger journal migration and a forced continuation compaction; the
 * fingerprint is stable across calls for the same registry.
 */
export function deriveSceneStatementRegistryFingerprint(
  registry?: SceneStatementDefinitionRegistry,
): string {
  const definitions = registry ? registry.list() : Object.values(SCENE_STATEMENT_DEFINITIONS);
  const parts = definitions.map((definition) => JSON.stringify({
    family: definition.family,
    category: definition.category,
    label: definition.label,
    discriminators: definition.discriminators,
    ...(definition.attachableTo ? { attachableTo: [...definition.attachableTo].sort() } : {}),
    ...(definition.patchMetadata ? { patchMetadata: definition.patchMetadata } : {}),
    ...(definition.compiledAssetSlots ? { compiledAssetSlots: definition.compiledAssetSlots } : {}),
    ...(definition.sourceAssetSlots ? { sourceAssetSlots: definition.sourceAssetSlots } : {}),
  })).sort();
  return fnv1a8(parts.join('\n'));
}

function fnv1a8(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

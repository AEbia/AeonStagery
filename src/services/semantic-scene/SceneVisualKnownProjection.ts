import type { SceneVisualBlock } from '../../api/types/visual';
import { BLEND_MODES } from '../../api/types/blend-mode';
import { UnknownSceneDiscriminatorError } from './SceneDocumentContractErrors';

const LENS_SLOTS = ['grade', 'optics', 'atmosphere', 'texture'] as const;
const COMPOSITE_SLOTS = ['grounding', 'integration', 'accent', 'distortion'] as const;

export function projectKnownSceneVisualBlock(
  input: unknown,
  path = 'scene.visual',
): SceneVisualBlock {
  const record = expectRecord(input, path);
  return compact({
    visualTargets: projectRecordMap(
      record.visualTargets,
      `${path}.visualTargets`,
      projectVisualTarget,
    ),
    segments: projectRecordMap(record.segments, `${path}.segments`, projectSegment),
    recipeOverlay: projectRecordMap(
      record.recipeOverlay,
      `${path}.recipeOverlay`,
      projectStyleRecipe,
    ),
  }) as SceneVisualBlock;
}

function projectVisualTarget(input: unknown, path: string): Record<string, unknown> {
  const record = expectRecord(input, path);
  return compact({
    targetType: expectOneOf(
      record.targetType,
      `${path}.targetType`,
      ['character', 'background', 'environment-layer', 'image-layer', 'text-layer'],
    ),
    objectCompositeBaseline: projectFixedRecord(
      record.objectCompositeBaseline,
      `${path}.objectCompositeBaseline`,
      COMPOSITE_SLOTS,
      projectSlotRecipeState,
    ),
    rimLightBaseline: projectFlatRecord(
      record.rimLightBaseline,
      `${path}.rimLightBaseline`,
      ['color', 'intensity', 'thickness', 'angle', 'softness'],
    ),
    targetEnvironmentOverride: projectEnvironmentOverride(
      record.targetEnvironmentOverride,
      `${path}.targetEnvironmentOverride`,
    ),
  });
}

function projectSegment(input: unknown, path: string): Record<string, unknown> {
  const record = expectRecord(input, path);
  return compact({
    boundaryRef: projectFlatRecord(
      record.boundaryRef,
      `${path}.boundaryRef`,
      ['startMarkerId'],
    ),
    lensStyleBaseline: projectFixedRecord(
      record.lensStyleBaseline,
      `${path}.lensStyleBaseline`,
      LENS_SLOTS,
      projectSlotRecipeState,
    ),
    lensEnvironmentOverride: projectEnvironmentOverride(
      record.lensEnvironmentOverride,
      `${path}.lensEnvironmentOverride`,
    ),
    adjustedCompositeByTarget: projectRecordMap(
      record.adjustedCompositeByTarget,
      `${path}.adjustedCompositeByTarget`,
      (value, valuePath) => projectFixedRecord(
        value,
        valuePath,
        COMPOSITE_SLOTS,
        projectSlotRecipeState,
      ) ?? {},
    ),
  });
}

function projectSlotRecipeState(input: unknown, path: string): Record<string, unknown> {
  const record = expectRecord(input, path);
  return compact({
    recipeId: expectString(record.recipeId, `${path}.recipeId`),
    semanticOverride: projectSemanticStyleOverride(
      record.semanticOverride,
      `${path}.semanticOverride`,
    ),
    // Advanced overrides are deliberately an open extension dictionary.
    advancedOverride: record.advancedOverride === undefined
      ? undefined
      : cloneJson(expectRecord(record.advancedOverride, `${path}.advancedOverride`)),
  });
}

function projectSemanticStyleOverride(input: unknown, path: string): Record<string, unknown> | undefined {
  const projected = projectFlatRecord(input, path, [
    'intensity',
    'brightness',
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
  if (!projected) return undefined;
  if (projected.colorBlendMode !== undefined) {
    projected.colorBlendMode = expectOneOf(
      projected.colorBlendMode,
      `${path}.colorBlendMode`,
      BLEND_MODES,
    );
  }
  return projected;
}

function projectEnvironmentOverride(input: unknown, path: string): Record<string, unknown> | undefined {
  const projected = projectFlatRecord(input, path, [
    'environmentColor',
    'warmthBias',
    'exposureBias',
    'atmosphereBias',
    'primaryLightDirection',
  ]);
  if (!projected) return undefined;
  if (projected.primaryLightDirection !== undefined) {
    projected.primaryLightDirection = expectOneOf(
      projected.primaryLightDirection,
      `${path}.primaryLightDirection`,
      ['left', 'right', 'center', 'mixed'],
    );
  }
  return projected;
}

function projectStyleRecipe(input: unknown, path: string): Record<string, unknown> {
  const record = expectRecord(input, path);
  const stack = expectOneOf(record.stack, `${path}.stack`, ['lens', 'composite']);
  const common = {
    stack,
    extendsRecipeId: optionalClone(record.extendsRecipeId),
    label: optionalClone(record.label),
  };
  if (stack === 'lens') {
    const slot = expectOneOf(record.slot, `${path}.slot`, LENS_SLOTS);
    return compact({
      ...common,
      slot,
      payload: projectLensRecipePayload(record.payload, `${path}.payload`, slot),
    });
  }
  const slot = expectOneOf(record.slot, `${path}.slot`, COMPOSITE_SLOTS);
  return compact({
    ...common,
    slot,
    payload: projectCompositeRecipePayload(record.payload, `${path}.payload`),
  });
}

function projectLensRecipePayload(
  input: unknown,
  path: string,
  slot: typeof LENS_SLOTS[number],
): Record<string, unknown> {
  switch (slot) {
    case 'grade':
      return projectRequiredFlatRecord(
        input,
        path,
        ['brightness', 'contrast', 'saturation', 'red', 'green', 'blue'],
      );
    case 'optics':
      return projectRequiredFlatRecord(input, path, ['bloomScale', 'bloomThreshold', 'rgbSplit']);
    case 'atmosphere':
      return projectOverlayRecipePayload(
        input,
        path,
        ['bloomScale', 'bloomThreshold', 'godrayAngle', 'godrayGain'],
      );
    case 'texture':
      return projectOverlayRecipePayload(input, path, ['contrast', 'saturation']);
  }
}

function projectOverlayRecipePayload(
  input: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> {
  const record = expectRecord(input, path);
  return compact({
    ...pickKnownFields(record, fields),
    overlays: projectArray(record.overlays, `${path}.overlays`, projectColorOverlay),
  });
}

function projectColorOverlay(input: unknown, path: string): Record<string, unknown> {
  const record = expectRecord(input, path);
  return {
    color: cloneJson(record.color),
    intensity: cloneJson(record.intensity),
    mode: expectOneOf(record.mode, `${path}.mode`, BLEND_MODES),
  };
}

function projectCompositeRecipePayload(input: unknown, path: string): Record<string, unknown> {
  const record = expectRecord(input, path);
  const colorOverlay = projectFlatRecord(
    record.colorOverlay,
    `${path}.colorOverlay`,
    ['alpha', 'color', 'colorStops', 'mode'],
  );
  if (colorOverlay?.mode !== undefined) {
    colorOverlay.mode = expectOneOf(
      colorOverlay.mode,
      `${path}.colorOverlay.mode`,
      BLEND_MODES,
    );
  }
  return compact({
    adjustment: projectFlatRecord(
      record.adjustment,
      `${path}.adjustment`,
      ['brightness', 'contrast', 'saturation', 'red', 'green', 'blue'],
    ),
    colorOverlay,
    blur: optionalClone(record.blur),
    rgbSplit: projectFlatRecord(record.rgbSplit, `${path}.rgbSplit`, ['x', 'y']),
    shadow: projectFlatRecord(
      record.shadow,
      `${path}.shadow`,
      ['alpha', 'blur', 'color', 'distance', 'rotation'],
    ),
  });
}

function projectRecordMap<T>(
  input: unknown,
  path: string,
  project: (value: unknown, path: string) => T,
): Record<string, T> | undefined {
  if (input === undefined) return undefined;
  const record = expectRecord(input, path);
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, project(value, `${path}.${key}`)]),
  );
}

function projectFixedRecord<T>(
  input: unknown,
  path: string,
  keys: readonly string[],
  project: (value: unknown, path: string) => T,
): Record<string, T> | undefined {
  if (input === undefined) return undefined;
  const record = expectRecord(input, path);
  return Object.fromEntries(keys.flatMap((key) => (
    record[key] === undefined ? [] : [[key, project(record[key], `${path}.${key}`)]]
  )));
}

function projectArray<T>(
  input: unknown,
  path: string,
  project: (value: unknown, path: string) => T,
): T[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new Error(`Expected array at ${path}`);
  return input.map((value, index) => project(value, `${path}[${index}]`));
}

function projectRequiredFlatRecord(
  input: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> {
  return pickKnownFields(expectRecord(input, path), fields);
}

function projectFlatRecord(
  input: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> | undefined {
  if (input === undefined) return undefined;
  return pickKnownFields(expectRecord(input, path), fields);
}

function pickKnownFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap((field) => (
    record[field] === undefined ? [] : [[field, cloneJson(record[field])]]
  )));
}

function expectRecord(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Expected object at ${path}`);
  }
  return input as Record<string, unknown>;
}

function expectString(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error(`Expected non-empty string at ${path}`);
  }
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

function optionalClone(input: unknown): unknown {
  return input === undefined ? undefined : cloneJson(input);
}

function compact<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

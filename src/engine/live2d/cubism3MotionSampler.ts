import {
  parseCubism3MotionBuffer,
  type Cubism3MotionParseResult,
  type Cubism3MotionParserOptions,
} from './cubism3MotionParser';

/** Runtime-owned settings needed to resolve a Cubism 3+ motion resource. */
export interface Cubism3MotionSamplerTarget {
  readonly kind: 'cubism3-plus';
  readonly settings: unknown;
}

export interface Cubism3MotionMeta {
  readonly durationSeconds: number;
  readonly fadeInSeconds: number;
  readonly fadeOutSeconds: number;
  readonly hasNonParameterCurves: boolean;
}

export class Cubism3MotionSamplingError extends Error {
  constructor(
    message: string,
    readonly code: 'motion-not-found' | 'motion-file-unavailable' | 'invalid-motion',
  ) {
    super(message);
    this.name = 'Cubism3MotionSamplingError';
  }
}

interface MotionDefinition {
  readonly File?: unknown;
  readonly file?: unknown;
}

interface MotionSettings {
  readonly motions?: Record<string, unknown>;
  readonly resolveURL?: (file: string) => string;
  readonly getEyeBlinkParameters?: () => readonly string[];
  readonly getLipSyncParameters?: () => readonly string[];
}

function settingsOf(target: Cubism3MotionSamplerTarget): MotionSettings {
  return target.settings && typeof target.settings === 'object'
    ? target.settings as MotionSettings
    : {};
}

function resolveDefinition(target: Cubism3MotionSamplerTarget, motionKey: string): MotionDefinition {
  const definitions = settingsOf(target).motions?.[motionKey];
  const definition = Array.isArray(definitions) ? definitions[0] : definitions;
  if (!definition || typeof definition !== 'object') {
    throw new Cubism3MotionSamplingError(
      `Motion "${motionKey}" not found in Cubism 3+ model settings`,
      'motion-not-found',
    );
  }
  return definition as MotionDefinition;
}

function resolveFileUrl(target: Cubism3MotionSamplerTarget, motionKey: string): string {
  const definition = resolveDefinition(target, motionKey);
  const file = typeof definition.File === 'string'
    ? definition.File
    : typeof definition.file === 'string'
      ? definition.file
      : '';
  if (!file.trim()) {
    throw new Cubism3MotionSamplingError(
      `Motion "${motionKey}" has no File entry`,
      'motion-file-unavailable',
    );
  }
  const resolver = settingsOf(target).resolveURL;
  return typeof resolver === 'function' ? resolver.call(target.settings, file) : file;
}

export async function loadCubism3Motion(
  target: Cubism3MotionSamplerTarget,
  motionKey: string,
  fetchFile: (url: string) => Promise<ArrayBuffer> = fetchMotionFile,
  options: Pick<Cubism3MotionParserOptions, 'fps'> = {},
): Promise<Cubism3MotionParseResult> {
  const url = resolveFileUrl(target, motionKey);
  let buffer: ArrayBuffer;
  try {
    buffer = await fetchFile(url);
  } catch (error) {
    throw new Cubism3MotionSamplingError(
      `Failed to read Cubism 3+ motion "${url}": ${String(error)}`,
      'motion-file-unavailable',
    );
  }
  try {
    const settings = settingsOf(target);
    const lipSyncIds = settings.getLipSyncParameters?.();
    return parseCubism3MotionBuffer(buffer, {
      ...options, derivedFromKey: motionKey,
      eyeBlinkParameterIds: settings.getEyeBlinkParameters?.(),
      lipSyncParameterIds: lipSyncIds?.length ? lipSyncIds : ['ParamMouthOpenY'],
    });
  } catch (error) {
    throw new Cubism3MotionSamplingError(
      `Failed to parse Cubism 3+ motion "${url}": ${String(error)}`,
      'invalid-motion',
    );
  }
}

export async function resolveCubism3MotionMeta(
  target: Cubism3MotionSamplerTarget,
  motionKey: string,
  fetchFile?: (url: string) => Promise<ArrayBuffer>,
): Promise<Cubism3MotionMeta> {
  const parsed = await loadCubism3Motion(target, motionKey, fetchFile);
  const fadeOutSeconds = parsed.motion.derivedFrom.fadeOutSeconds ?? 0;
  return {
    durationSeconds: parsed.sourceDurationSeconds,
    fadeInSeconds: parsed.motion.fadeInSeconds,
    fadeOutSeconds,
    hasNonParameterCurves: parsed.ignoredCurves.length > 0,
  };
}

async function fetchMotionFile(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}

import { acquireUtSystemLock, releaseUtSystemLock } from '../Live2DConfig';
import type { CustomMotionSamplePoint } from './customMotionConversion';

/**
 * Cubism 2.1 motion curve sampler (pixi-live2d-display runtime).
 *
 * The source motion is loaded into a separate Live2DMotion instance and
 * evaluated through a separate MotionQueueManager. Writes are captured by a
 * proxy model, so conversion never starts or stops motion playback on the
 * visible character and keeps the pre-clamp values written by the motion.
 */

const PARTS_CURVE_PREFIX = 'VISIBLE:';
const LAYOUT_CURVE_PREFIX = 'LAYOUT:';
const PARAMETER_CURVE_TYPE = 0;

export interface Cubism2MotionSamplerTarget {
  /** pixi-live2d-display internalModel (holds coreModel + motionManager). */
  readonly internalModel: any;
  /** pixi-live2d-display motion manager (Cubism2MotionManager). */
  readonly motionManager: any;
}

export interface Cubism2MotionFileOptions {
  /** Injectable `.mtn` binary loader (tests substitute fakes here). */
  readonly fetchFile?: (url: string) => Promise<ArrayBuffer>;
}

export interface Cubism2MotionSamplingOptions extends Cubism2MotionFileOptions {
  /** Scene frame rate for sampling (integer frames only). */
  readonly fps: number;
  /** Source motion duration in seconds; must be finite and > 0. */
  readonly durationSeconds: number;
  /**
   * When true (default), the isolated motion's own fade_in/fade_out are forced
   * to 0 so sampled curves are the pure motion target values (authoring
   * conversion). When false, the loaded motion keeps its source fades and the
   * per-frame samples include the SDK's stateful fade accumulation (used by
   * the runtime curve cache).
   */
  readonly zeroSourceFades?: boolean;
  /**
   * When true, curves whose parameter is absent from the target model are
   * skipped instead of failing the whole sample. Used by the best-effort
   * runtime curve cache; authoring conversion keeps the strict behavior.
   */
  readonly skipMissingParameters?: boolean;
  /** Source motion fade_in in seconds (kept as derivedFrom info). */
  readonly fadeInSeconds?: number;
  /** Source motion fade_out in seconds (kept as derivedFrom info). */
  readonly fadeOutSeconds?: number;
}

export interface Cubism2MotionCurve {
  readonly parameterId: string;
  readonly samples: readonly CustomMotionSamplePoint[];
}

export interface Cubism2MotionMeta {
  readonly durationSeconds: number;
  readonly fadeInSeconds?: number;
  readonly fadeOutSeconds?: number;
  /**
   * True when the source motion also carries parts/layout curves
   * (`VISIBLE:`/`LAYOUT:` ids). The pure parameter evaluator cannot represent
   * part visibility, so the runtime curve cache treats such motions as a
   * permanent miss rather than silently dropping visual curves (parity guard).
   * Absent (undefined) when no such curves are present.
   */
  readonly hasNonParameterCurves?: boolean;
}

/**
 * Detect parts/layout curves on a loaded Cubism 2 motion instance. Both the
 * cached SDK motion and the isolated load expose a `motions` curve list whose
 * ids carry the `VISIBLE:`/`LAYOUT:` prefixes — the same prefixes the parameter
 * enumerator skips during sampling.
 */
export function motionHasNonParameterCurves(motion: any): boolean {
  const entries = motion?.motions;
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    const id = entry?.id ?? entry?._$4P;
    if (typeof id !== 'string') continue;
    if (id.startsWith(PARTS_CURVE_PREFIX) || id.startsWith(LAYOUT_CURVE_PREFIX)) return true;
  }
  return false;
}

export class Cubism2MotionSamplingError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'motion-not-found'
      | 'invalid-duration'
      | 'parameter-missing-in-model'
      | 'non-finite-sample'
      | 'curve-mismatch-across-models'
      | 'queue-evaluation-failed',
  ) {
    super(message);
    this.name = 'Cubism2MotionSamplingError';
  }
}

interface MotionDefinitionLike {
  readonly file?: unknown;
  readonly fade_in?: unknown;
  readonly fade_out?: unknown;
}

interface ResolvedMotionSource {
  readonly definition: MotionDefinitionLike;
  readonly fileUrl: string;
}

interface MotionCurveEntryLike {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly _$4P?: unknown;
  readonly _$RP?: unknown;
}

function resolveMotionSource(
  target: Cubism2MotionSamplerTarget,
  motionKey: string,
): ResolvedMotionSource | null {
  const settings = target.motionManager?.settings;
  const definitions = settings?.motions?.[motionKey];
  if (!Array.isArray(definitions) || definitions.length === 0) {
    console.warn(`[CustomMotionSampler] resolveMotionSource: 动作 "${motionKey}" 未在模型 settings.motions 中找到`, {
      motionKeys: settings?.motions ? Object.keys(settings.motions) : '(settings.motions 不存在)',
    });
    return null;
  }
  const definition = definitions[0] as MotionDefinitionLike | undefined;
  const file = definition?.file;
  if (!definition || typeof file !== 'string' || file.trim() === '') {
    console.warn(`[CustomMotionSampler] resolveMotionSource: 动作 "${motionKey}" 的定义缺少 file 字段`, definition);
    return null;
  }
  const resolveURL = settings?.resolveURL;
  const fileUrl = typeof resolveURL === 'function' ? resolveURL.call(settings, file) : file;
  console.log(`[CustomMotionSampler] resolveMotionSource: "${motionKey}" -> file="${file}" url="${fileUrl}"`, {
    fadeIn: definition.fade_in,
    fadeOut: definition.fade_out,
  });
  return { definition, fileUrl };
}

async function fetchMotionFile(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to read Cubism 2 motion file: ${response.status}`);
  }
  return response.arrayBuffer();
}

async function loadIsolatedMotion(
  source: ResolvedMotionSource,
  options: Cubism2MotionFileOptions & { readonly zeroSourceFades?: boolean },
): Promise<any> {
  const Live2DMotion = (window as any).Live2DMotion;
  console.log(`[CustomMotionSampler] loadIsolatedMotion: window.Live2DMotion 可用=${typeof Live2DMotion?.loadMotion === 'function'}`);
  if (!Live2DMotion || typeof Live2DMotion.loadMotion !== 'function') {
    throw new Cubism2MotionSamplingError('Cubism 2 motion runtime is unavailable', 'queue-evaluation-failed');
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await (options.fetchFile ?? fetchMotionFile)(source.fileUrl);
    console.log(`[CustomMotionSampler] 已读取 motion 文件 "${source.fileUrl}"，${buffer.byteLength} 字节`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[CustomMotionSampler] 读取 motion 文件失败 "${source.fileUrl}":`, error);
    throw new Cubism2MotionSamplingError(
      `Failed to read source motion "${source.fileUrl}": ${message}`,
      'queue-evaluation-failed',
    );
  }

  let motion: any;
  try {
    motion = Live2DMotion.loadMotion(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[CustomMotionSampler] 解析 motion 文件失败 "${source.fileUrl}":`, error);
    throw new Cubism2MotionSamplingError(
      `Failed to parse source motion "${source.fileUrl}": ${message}`,
      'queue-evaluation-failed',
    );
  }
  if (!motion) {
    throw new Cubism2MotionSamplingError(
      `Failed to parse source motion "${source.fileUrl}"`,
      'queue-evaluation-failed',
    );
  }

  if (options.zeroSourceFades !== false) {
    motion.setFadeIn?.(0);
    motion.setFadeOut?.(0);
  }
  console.log(`[CustomMotionSampler] motion 实例已解析: getDurationMSec=${typeof motion.getDurationMSec === 'function' ? motion.getDurationMSec?.() : '(无)'}, curves=${motion.motions?.length ?? '(无 motions 字段)'}`);
  return motion;
}

export async function resolveCubism2MotionMeta(
  target: Cubism2MotionSamplerTarget,
  motionKey: string,
  options: Cubism2MotionFileOptions = {},
): Promise<Cubism2MotionMeta> {
  const motionManager = target.motionManager;
  if (!motionManager || typeof motionManager.loadMotion !== 'function') {
    throw new Cubism2MotionSamplingError('Missing motion manager', 'queue-evaluation-failed');
  }
  const source = resolveMotionSource(target, motionKey);
  if (!source) {
    throw new Cubism2MotionSamplingError(`Motion "${motionKey}" not found in model`, 'motion-not-found');
  }

  let motion: any;
  try {
    motion = await motionManager.loadMotion(motionKey, 0);
  } catch (error) {
    console.warn(`[CustomMotionSampler] motionManager.loadMotion("${motionKey}", 0) 抛错，改用隔离加载:`, error);
    motion = undefined;
  }
  if (!motion || typeof motion.getDurationMSec !== 'function') {
    console.log(`[CustomMotionSampler] 实例无 getDurationMSec（${motion ? '有实例' : '无实例'}），改用隔离加载`);
    motion = await loadIsolatedMotion(source, options);
  }

  const durationMs = Number(motion.getDurationMSec?.());
  console.log(`[CustomMotionSampler] resolveCubism2MotionMeta: "${motionKey}" durationMs=${durationMs}`);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Cubism2MotionSamplingError(
      `Source motion "${motionKey}" has no valid duration`,
      'invalid-duration',
    );
  }

  const fadeInSeconds = readFadeSeconds(source.definition.fade_in);
  const fadeOutSeconds = readFadeSeconds(source.definition.fade_out);
  const hasNonParameterCurves = motionHasNonParameterCurves(motion);
  return {
    durationSeconds: durationMs / 1000,
    ...(hasNonParameterCurves ? { hasNonParameterCurves: true } : {}),
    ...(fadeInSeconds !== undefined ? { fadeInSeconds } : {}),
    ...(fadeOutSeconds !== undefined ? { fadeOutSeconds } : {}),
  };
}

export async function sampleCubism2MotionCurves(
  target: Cubism2MotionSamplerTarget,
  motionKey: string,
  options: Cubism2MotionSamplingOptions,
): Promise<readonly Cubism2MotionCurve[]> {
  const { motionManager, internalModel } = target;
  if (!motionManager || !internalModel) {
    throw new Cubism2MotionSamplingError('Missing motion manager or internal model', 'queue-evaluation-failed');
  }
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0) {
    throw new Cubism2MotionSamplingError('Source motion duration must be finite and positive', 'invalid-duration');
  }
  if (!Number.isFinite(options.fps) || options.fps <= 0) {
    throw new Cubism2MotionSamplingError('Sampling fps must be finite and positive', 'invalid-duration');
  }

  const source = resolveMotionSource(target, motionKey);
  if (!source) {
    throw new Cubism2MotionSamplingError(`Motion "${motionKey}" not found in model`, 'motion-not-found');
  }
  const coreModel = internalModel.coreModel;
  if (!coreModel || typeof coreModel.getParamIndex !== 'function') {
    throw new Cubism2MotionSamplingError('Model parameter index is unavailable', 'parameter-missing-in-model');
  }

  const motion = await loadIsolatedMotion(source, options);
  let parameterIds = enumerateMotionParameterIds(motion);
  console.log(`[CustomMotionSampler] 采样参数列表(${parameterIds.length}): ${parameterIds.join(', ')}`);
  if (parameterIds.length === 0) return [];

  if (options.skipMissingParameters) {
    const missing = parameterIds.filter((parameterId) => coreModel.getParamIndex(parameterId) < 0);
    if (missing.length > 0) {
      console.warn(`[CustomMotionSampler] 跳过 ${missing.length} 个目标模型缺失的参数: ${missing.join(', ')}`);
    }
    parameterIds = parameterIds.filter((parameterId) => coreModel.getParamIndex(parameterId) >= 0);
    if (parameterIds.length === 0) return [];
  } else {
    for (const parameterId of parameterIds) {
      if (coreModel.getParamIndex(parameterId) < 0) {
        console.warn(`[CustomMotionSampler] 参数 "${parameterId}" 在目标模型上不存在 (getParamIndex<0)`);
        throw new Cubism2MotionSamplingError(
          `Source motion curve "${parameterId}" has no matching parameter in the target model`,
          'parameter-missing-in-model',
        );
      }
    }
  }

  const samples = await sampleIsolatedMotion(coreModel, motion, parameterIds, options);
  if (!samples) {
    throw new Cubism2MotionSamplingError('Motion queue evaluation failed while sampling', 'queue-evaluation-failed');
  }

  return parameterIds.map((parameterId) => {
    const values = samples[parameterId];
    if (!values || values.length === 0) {
      throw new Cubism2MotionSamplingError(
        `Motion curve "${parameterId}" produced no samples`,
        'queue-evaluation-failed',
      );
    }
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Cubism2MotionSamplingError(
        `Motion curve "${parameterId}" produced a non-finite sample`,
        'non-finite-sample',
      );
    }
    return {
      parameterId,
      samples: values.map((value, frame) => ({
        time: frame / options.fps,
        value,
      })),
    };
  });
}

function enumerateMotionParameterIds(motion: any): string[] {
  const entries = motion?.motions;
  if (!Array.isArray(entries)) return [];
  const ids: string[] = [];
  for (const entry of entries as MotionCurveEntryLike[]) {
    const id = entry.id ?? entry._$4P;
    if (typeof id !== 'string' || id.trim() === '') continue;
    if (id.startsWith(PARTS_CURVE_PREFIX) || id.startsWith(LAYOUT_CURVE_PREFIX)) continue;
    const type = Number(entry.type ?? entry._$RP);
    if (Number.isFinite(type) && type !== PARAMETER_CURVE_TYPE) continue;
    ids.push(id);
  }
  return Array.from(new Set(ids));
}

function createSamplingModel(coreModel: any, parameterIds: readonly string[]) {
  const idByIndex = new Map<number, string>();
  const currentValues = new Map<string, number>();
  const writtenThisFrame = new Set<string>();
  const everWritten = new Set<string>();
  const modelContext = coreModel.getModelContext?.();

  for (const parameterId of parameterIds) {
    const index = coreModel.getParamIndex(parameterId);
    idByIndex.set(index, parameterId);
    const initial = Number(coreModel.getParamFloat?.(index));
    currentValues.set(parameterId, Number.isFinite(initial) ? initial : 0);
  }

  const resolveId = (idOrIndex: string | number): string | undefined => (
    typeof idOrIndex === 'string' ? idOrIndex : idByIndex.get(idOrIndex)
  );
  const getValue = (idOrIndex: string | number): number => {
    const parameterId = resolveId(idOrIndex);
    return parameterId === undefined ? 0 : currentValues.get(parameterId) ?? 0;
  };

  const proxyContext = {
    getParamMax: (index: number) => Number(modelContext?.getParamMax?.(index)),
    getParamMin: (index: number) => Number(modelContext?.getParamMin?.(index)),
    getParamFloat: (index: number) => getValue(index),
  };
  const model = {
    getParamIndex: (parameterId: string) => coreModel.getParamIndex(parameterId),
    getParamFloat: (idOrIndex: string | number) => getValue(idOrIndex),
    setParamFloat: (idOrIndex: string | number, value: number, weight = 1) => {
      const parameterId = resolveId(idOrIndex);
      if (parameterId === undefined || !currentValues.has(parameterId)) return;
      const current = currentValues.get(parameterId) ?? 0;
      const numericWeight = Number(weight);
      const next = numericWeight === 1 ? Number(value) : current * (1 - numericWeight) + Number(value) * numericWeight;
      currentValues.set(parameterId, next);
      writtenThisFrame.add(parameterId);
      everWritten.add(parameterId);
    },
    getModelContext: () => proxyContext,
  };

  return {
    model,
    beginFrame: () => writtenThisFrame.clear(),
    /**
     * Whether every motion parameter has been written at least once since the
     * sampling started. Legitimate motions may skip a parameter on individual
     * frames (zero-weight fades, conditional curves), so the per-frame check
     * only requires the queue to keep updating; a parameter that is never
     * written means the motion never evaluated its curve at all.
     */
    hasCompleteFrame: () => parameterIds.every((parameterId) => everWritten.has(parameterId)),
    hasWritten: (parameterId: string) => everWritten.has(parameterId),
    read: (parameterId: string) => currentValues.get(parameterId) ?? Number.NaN,
  };
}

async function sampleIsolatedMotion(
  coreModel: any,
  motion: any,
  parameterIds: readonly string[],
  options: Cubism2MotionSamplingOptions,
): Promise<Record<string, number[]> | null> {
  const MotionQueueManager = (window as any).MotionQueueManager;
  const UtSystem = (window as any).UtSystem;
  if (typeof MotionQueueManager !== 'function' || !UtSystem) return null;
  if (typeof UtSystem.getUserTimeMSec !== 'function' || typeof UtSystem.setUserTimeMSec !== 'function') return null;

  await acquireUtSystemLock();
  const utBase = UtSystem.getUserTimeMSec();
  const queue = new MotionQueueManager();
  try {
    const samplingModel = createSamplingModel(coreModel, parameterIds);
    const motionId = queue.startMotion?.(motion);
    if (motionId === undefined || Number(motionId) < 0 || typeof queue.updateParam !== 'function') return null;

    const frameDurationMs = 1000 / options.fps;
    const frameCount = Math.max(2, Math.round(options.durationSeconds * options.fps) + 1);
    const valuesByParameter: Record<string, number[]> = {};
    for (const parameterId of parameterIds) valuesByParameter[parameterId] = [];

    for (let frame = 0; frame < frameCount; frame++) {
      UtSystem.setUserTimeMSec(utBase + frame * frameDurationMs);
      samplingModel.beginFrame();
      let updated = false;
      try {
        updated = queue.updateParam(samplingModel.model) !== false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Cubism2MotionSamplingError(
          `Motion queue evaluation threw while sampling frame ${frame}: ${message}`,
          'queue-evaluation-failed',
        );
      }
      if (!updated) {
        throw new Cubism2MotionSamplingError(
          `Motion queue stopped updating while sampling frame ${frame}`,
          'queue-evaluation-failed',
        );
      }
      if (!samplingModel.hasCompleteFrame()) {
        const missing = parameterIds.filter((parameterId) => !samplingModel.hasWritten(parameterId));
        throw new Cubism2MotionSamplingError(
          `Motion queue never wrote parameter(s): ${missing.join(', ')}`,
          'queue-evaluation-failed',
        );
      }
      for (const parameterId of parameterIds) {
        valuesByParameter[parameterId].push(samplingModel.read(parameterId));
      }
    }

    return valuesByParameter;
  } finally {
    queue.stopAllMotions?.();
    UtSystem.setUserTimeMSec(utBase);
    releaseUtSystemLock();
  }
}

export function mergeCubism2SampledCurves(
  perModelCurves: readonly (readonly Cubism2MotionCurve[])[],
  tolerance = 1e-6,
): readonly Cubism2MotionCurve[] {
  const byParameter = new Map<string, Array<readonly CustomMotionSamplePoint[]>>();
  for (const curves of perModelCurves) {
    for (const curve of curves) {
      let entries = byParameter.get(curve.parameterId);
      if (!entries) {
        entries = [];
        byParameter.set(curve.parameterId, entries);
      }
      entries.push(curve.samples);
    }
  }

  const merged: Cubism2MotionCurve[] = [];
  for (const [parameterId, sampleSets] of byParameter) {
    const reference = sampleSets[0];
    for (const candidate of sampleSets.slice(1)) {
      if (!samplesEqual(reference, candidate, tolerance)) {
        throw new Cubism2MotionSamplingError(
          `Parameter "${parameterId}" curves differ across the combined character models`,
          'curve-mismatch-across-models',
        );
      }
    }
    merged.push({ parameterId, samples: reference });
  }

  merged.sort((a, b) => a.parameterId.localeCompare(b.parameterId));
  return merged;
}

function readFadeSeconds(value: unknown): number | undefined {
  const numeric = Number(value);
  // pixi-live2d-display treats missing, negative, and zero Cubism 2 fades as
  // "use the runtime default" (500ms for non-idle motions). Returning an
  // explicit zero here would make conversion disable a fade that the source
  // resource actually plays with.
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric / 1000;
}

function samplesEqual(
  left: readonly CustomMotionSamplePoint[],
  right: readonly CustomMotionSamplePoint[],
  tolerance: number,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (Math.abs(left[index].time - right[index].time) > tolerance) return false;
    if (Math.abs(left[index].value - right[index].value) > tolerance) return false;
  }
  return true;
}

/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Cubism2MotionSamplingError,
  mergeCubism2SampledCurves,
  resolveCubism2MotionMeta,
  sampleCubism2MotionCurves,
  type Cubism2MotionCurve,
  type Cubism2MotionSamplerTarget,
} from '../engine/live2d/cubism2MotionSampler';

interface FakeParamCurve {
  readonly id: string;
  readonly values: readonly number[];
  readonly type?: number;
}

interface FakeMotionFile {
  readonly fps: number;
  readonly curves: readonly FakeParamCurve[];
  /** Curve id -> frames on which the motion intentionally skips writing. */
  readonly skipCurveFrames?: Readonly<Record<string, readonly number[]>>;
}

function encodeMotionFile(file: FakeMotionFile): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(file)).buffer as ArrayBuffer;
}

function createMotion(file: FakeMotionFile) {
  const durationMs = Math.round(
    Math.max(...file.curves.map((curve) => curve.values.length), 0) * 1000 / file.fps,
  );
  return {
    motions: file.curves.map((curve) => ({
      _$4P: curve.id,
      _$RP: curve.type ?? 0,
    })),
    setFadeIn: vi.fn(),
    setFadeOut: vi.fn(),
    getDurationMSec: () => durationMs,
    evaluate(model: any, elapsedMs: number) {
      const framePosition = elapsedMs * file.fps / 1000;
      const frame = Math.floor(framePosition);
      const ratio = framePosition - frame;
      for (const curve of file.curves) {
        if ((curve.type ?? 0) !== 0) continue;
        if (file.skipCurveFrames?.[curve.id]?.includes(frame)) continue;
        const left = curve.values[Math.min(frame, curve.values.length - 1)];
        const right = curve.values[Math.min(frame + 1, curve.values.length - 1)];
        model.setParamFloat(curve.id, left + (right - left) * ratio);
      }
    },
  };
}

class FakeMotionQueueManager {
  private motion: ReturnType<typeof createMotion> | null = null;
  private startTime: number | null = null;

  startMotion(motion: ReturnType<typeof createMotion>): number {
    this.motion = motion;
    return 1;
  }

  updateParam(model: any): boolean {
    if (!this.motion) return false;
    const now = (window as any).UtSystem.getUserTimeMSec();
    const startTime = this.startTime ?? now;
    this.startTime = startTime;
    this.motion.evaluate(model, now - startTime);
    return true;
  }

  stopAllMotions(): void {
    this.motion = null;
  }
}

function installRuntime() {
  let now = 1000;
  (window as any).UtSystem = {
    getUserTimeMSec: vi.fn(() => now),
    setUserTimeMSec: vi.fn((value: number) => { now = value; }),
  };
  (window as any).Live2DMotion = {
    loadMotion: vi.fn((buffer: ArrayBuffer) => {
      const file = JSON.parse(new TextDecoder().decode(buffer)) as FakeMotionFile;
      return createMotion(file);
    }),
  };
  (window as any).MotionQueueManager = FakeMotionQueueManager;
}

function makeTarget(options: {
  readonly group?: string;
  readonly parameterIds?: readonly string[];
  readonly durationMs?: number;
  readonly fadeIn?: number;
  readonly fadeOut?: number;
}) {
  const group = options.group ?? 'wave';
  const parameterIds = options.parameterIds ?? ['PARAM_ANGLE_X', 'PARAM_EYE_OPEN'];
  const indexes = new Map(parameterIds.map((id, index) => [id, index]));
  const liveValues = parameterIds.map(() => 0);
  const coreModel = {
    getParamIndex: vi.fn((id: string) => indexes.get(id) ?? -1),
    getParamFloat: vi.fn((index: number) => liveValues[index] ?? 0),
    setParamFloat: vi.fn((index: number, value: number) => { liveValues[index] = value; }),
    getModelContext: () => ({
      getParamMax: vi.fn(() => 1),
      getParamMin: vi.fn(() => -1),
    }),
  };
  const cachedMotion = options.durationMs === undefined
    ? undefined
    : { getDurationMSec: () => options.durationMs };
  const motionManager = {
    settings: {
      motions: {
        [group]: [{
          file: `${group}.mtn`,
          fade_in: options.fadeIn,
          fade_out: options.fadeOut,
        }],
      },
      resolveURL: (file: string) => `asset://models/${file}`,
    },
    loadMotion: vi.fn(async (requestedGroup: string, index: number) => (
      requestedGroup === group && index === 0 ? cachedMotion : undefined
    )),
    startMotion: vi.fn(),
    stopAllMotions: vi.fn(),
    update: vi.fn(),
  };
  const target: Cubism2MotionSamplerTarget = {
    internalModel: { coreModel },
    motionManager,
  };
  return { target, coreModel, motionManager };
}

const WAVE_FILE: FakeMotionFile = {
  fps: 2,
  curves: [
    { id: 'PARAM_ANGLE_X', values: [0, 10, 20, 30] },
    { id: 'PARAM_EYE_OPEN', values: [1, 0.5, 0, 1] },
    { id: 'VISIBLE:PART_A', type: 1, values: [1, 0, 1, 0] },
    { id: 'ANCHOR_X', type: 100, values: [0, 1, 2, 3] },
  ],
};

const fetchWaveFile = vi.fn(async (url: string) => {
  if (url !== 'asset://models/wave.mtn') throw new Error(`Unexpected URL: ${url}`);
  return encodeMotionFile(WAVE_FILE);
});

beforeEach(() => {
  vi.clearAllMocks();
  installRuntime();
});

describe('resolveCubism2MotionMeta', () => {
  it('reads duration from the cached SDK motion and fades from model.json', async () => {
    const { target } = makeTarget({ durationMs: 2000, fadeIn: 400, fadeOut: 250 });
    await expect(resolveCubism2MotionMeta(target, 'wave')).resolves.toEqual({
      durationSeconds: 2,
      fadeInSeconds: 0.4,
      fadeOutSeconds: 0.25,
    });
  });

  it('treats zero fades as the Cubism 2 runtime default instead of disabling fade', async () => {
    const { target } = makeTarget({ durationMs: 2000, fadeIn: 0, fadeOut: 0 });
    await expect(resolveCubism2MotionMeta(target, 'wave')).resolves.toEqual({
      durationSeconds: 2,
    });
  });

  it('loads an isolated source motion when cached duration is unavailable', async () => {
    const { target } = makeTarget({});
    await expect(resolveCubism2MotionMeta(target, 'wave', { fetchFile: fetchWaveFile })).resolves.toEqual({
      durationSeconds: 2,
      // WAVE_FILE carries a `VISIBLE:PART_A` curve, so the meta reports it
      // for the parity guard.
      hasNonParameterCurves: true,
    });
    expect((window as any).Live2DMotion.loadMotion).toHaveBeenCalledOnce();
  });

  it('rejects unknown groups and invalid durations', async () => {
    const { target } = makeTarget({ durationMs: 0 });
    await expect(resolveCubism2MotionMeta(target, 'missing')).rejects.toMatchObject({ code: 'motion-not-found' });
    await expect(resolveCubism2MotionMeta(target, 'wave')).rejects.toMatchObject({ code: 'invalid-duration' });
  });

  it('reports source motions that contain parts/layout curves (parity guard input)', async () => {
    // WAVE_FILE carries a `VISIBLE:PART_A` curve (type 1). The pure parameter
    // evaluator cannot animate part visibility, so the cache must treat such
    // motions as a permanent miss instead of silently dropping the curves.
    const { target } = makeTarget({});
    await expect(resolveCubism2MotionMeta(target, 'wave', { fetchFile: fetchWaveFile })).resolves.toEqual({
      durationSeconds: 2,
      hasNonParameterCurves: true,
    });
  });
});

describe('sampleCubism2MotionCurves', () => {
  it('samples through an isolated queue and includes the motion endpoint', async () => {
    const { target } = makeTarget({ durationMs: 2000 });
    const curves = await sampleCubism2MotionCurves(target, 'wave', {
      fps: 2,
      durationSeconds: 2,
      fetchFile: fetchWaveFile,
    });

    expect(curves.map((curve) => curve.parameterId)).toEqual(['PARAM_ANGLE_X', 'PARAM_EYE_OPEN']);
    expect(curves[0].samples).toEqual([
      { time: 0, value: 0 },
      { time: 0.5, value: 10 },
      { time: 1, value: 20 },
      { time: 1.5, value: 30 },
      { time: 2, value: 30 },
    ]);
  });

  it('does not disturb live playback, live parameter values, or the global clock', async () => {
    const { target, coreModel, motionManager } = makeTarget({ durationMs: 2000 });
    await sampleCubism2MotionCurves(target, 'wave', {
      fps: 2,
      durationSeconds: 2,
      fetchFile: fetchWaveFile,
    });

    expect(motionManager.startMotion).not.toHaveBeenCalled();
    expect(motionManager.stopAllMotions).not.toHaveBeenCalled();
    expect(motionManager.update).not.toHaveBeenCalled();
    expect(coreModel.setParamFloat).not.toHaveBeenCalled();
    expect((window as any).UtSystem.getUserTimeMSec()).toBe(1000);
  });

  it('keeps source values before target-model clamping', async () => {
    const { target } = makeTarget({ durationMs: 2000 });
    const curves = await sampleCubism2MotionCurves(target, 'wave', {
      fps: 2,
      durationSeconds: 2,
      fetchFile: fetchWaveFile,
    });
    expect(curves[0].samples.at(-1)?.value).toBe(30);
  });

  it('rejects missing target parameters and invalid sampling options', async () => {
    const { target } = makeTarget({ durationMs: 2000, parameterIds: ['PARAM_ANGLE_X'] });
    await expect(sampleCubism2MotionCurves(target, 'wave', {
      fps: 2,
      durationSeconds: 2,
      fetchFile: fetchWaveFile,
    })).rejects.toMatchObject({ code: 'parameter-missing-in-model' });
    await expect(sampleCubism2MotionCurves(target, 'wave', {
      fps: 0,
      durationSeconds: 2,
      fetchFile: fetchWaveFile,
    })).rejects.toMatchObject({ code: 'invalid-duration' });
  });

  it('skips missing target parameters when skipMissingParameters is true', async () => {
    const { target, motionManager } = makeTarget({ durationMs: 2000, parameterIds: ['PARAM_ANGLE_X'] });
    const curves = await sampleCubism2MotionCurves(target, 'wave', {
      fps: 2,
      durationSeconds: 2,
      fetchFile: fetchWaveFile,
      skipMissingParameters: true,
    });
    expect(curves.map((curve) => curve.parameterId)).toEqual(['PARAM_ANGLE_X']);
    expect(motionManager.startMotion).not.toHaveBeenCalled();
  });

  it('zeroes source fades by default and preserves them when zeroSourceFades=false', async () => {
    const { target } = makeTarget({ durationMs: 2000 });
    const fetchFile = vi.fn(async () => encodeMotionFile(WAVE_FILE));

    await sampleCubism2MotionCurves(target, 'wave', {
      fps: 2,
      durationSeconds: 2,
      fetchFile,
    });
    const motionWithZeroedFades = (window as any).Live2DMotion.loadMotion.mock.results.at(-1)?.value;
    expect(motionWithZeroedFades.setFadeIn).toHaveBeenCalledWith(0);
    expect(motionWithZeroedFades.setFadeOut).toHaveBeenCalledWith(0);

    await sampleCubism2MotionCurves(target, 'wave', {
      fps: 2,
      durationSeconds: 2,
      fetchFile,
      zeroSourceFades: false,
    });
    const motionWithSourceFades = (window as any).Live2DMotion.loadMotion.mock.results.at(-1)?.value;
    expect(motionWithSourceFades.setFadeIn).not.toHaveBeenCalled();
    expect(motionWithSourceFades.setFadeOut).not.toHaveBeenCalled();
  });

  it('fails atomically when the source motion cannot be read', async () => {
    const { target } = makeTarget({ durationMs: 2000 });
    await expect(sampleCubism2MotionCurves(target, 'wave', {
      fps: 2,
      durationSeconds: 2,
      fetchFile: async () => { throw new Error('read failed'); },
    })).rejects.toMatchObject({ code: 'queue-evaluation-failed' });
  });

  it('keeps sampling when a legitimate motion skips a parameter on some frames', async () => {
    const { target } = makeTarget({ durationMs: 2000 });
    const file: FakeMotionFile = {
      fps: 2,
      curves: [
        { id: 'PARAM_ANGLE_X', values: [0, 10, 20, 30] },
        { id: 'PARAM_EYE_OPEN', values: [1, 0.5, 0, 1] },
      ],
      // PARAM_EYE_OPEN is not written on frame 1 (zero-weight fade or a
      // conditional curve): the previous value must be held, not fail.
      skipCurveFrames: { PARAM_EYE_OPEN: [1] },
    };
    const fetchFile = vi.fn(async () => encodeMotionFile(file));
    const curves = await sampleCubism2MotionCurves(target, 'wave', {
      fps: 2,
      durationSeconds: 2,
      fetchFile,
    });
    const eyeOpen = curves.find((curve) => curve.parameterId === 'PARAM_EYE_OPEN');
    expect(eyeOpen?.samples.map((sample) => sample.value)).toEqual([1, 1, 0, 1, 1]);
  });

  it('propagates the underlying queue exception with its message', async () => {
    const { target } = makeTarget({ durationMs: 2000 });
    (window as any).MotionQueueManager = class {
      startMotion(): number { return 1; }
      updateParam(): boolean {
        throw new Error('queue exploded');
      }
      stopAllMotions(): void {}
    };
    await expect(sampleCubism2MotionCurves(target, 'wave', {
      fps: 2,
      durationSeconds: 2,
      fetchFile: fetchWaveFile,
    })).rejects.toThrow(/queue exploded/);
  });
});

describe('mergeCubism2SampledCurves', () => {
  const curveOf = (parameterId: string, values: readonly number[]): Cubism2MotionCurve => ({
    parameterId,
    samples: values.map((value, index) => ({ time: index / 10, value })),
  });

  it('merges matching curves and rejects differences across models', () => {
    const first = [curveOf('PARAM_ANGLE_X', [0, 1, 2])];
    const matching = [curveOf('PARAM_ANGLE_X', [0, 1, 2]), curveOf('PARAM_EYE_OPEN', [1, 1, 1])];
    expect(mergeCubism2SampledCurves([first, matching]).map((curve) => curve.parameterId))
      .toEqual(['PARAM_ANGLE_X', 'PARAM_EYE_OPEN']);

    const different = [curveOf('PARAM_ANGLE_X', [0, 2, 2])];
    expect(() => mergeCubism2SampledCurves([first, different]))
      .toThrowError(Cubism2MotionSamplingError);
  });
});

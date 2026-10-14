import { describe, expect, it, vi } from 'vitest';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import { SCENE_SCHEMA_VERSION, type CharacterPerformanceParams, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { SemanticScenePipeline } from '../services/semantic-scene';
import {
  CUSTOM_MOTION_CONVERSION_DEFAULT_FADE_IN_SECONDS,
  CustomMotionConversionCommand,
  CustomMotionConversionError,
} from '../services/timeline-authoring/CustomMotionConversionCommand';
import type { CustomMotionEditAuthority, HeldCustomMotionLease, LeaseDecision } from '../services/timeline-authoring/CustomMotionEditAuthority';
import type { CustomMotionConversionSampler } from '../services/timeline-authoring/CustomMotionConversionCommand';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { DocumentStore } from '../ui/store/DocumentStore';
import type { SemanticDocumentProjectionRuntimePort } from '../services/document/DocumentProjectionPorts';
import { sceneDocumentCodec } from '../services/semantic-scene';
import type { Live2DMotionSampledCurve, Live2DMotionSamplingResult } from '../engine/runtime/Live2DRuntimeContracts';
import { CubismPixiLive2DAdapter } from '../engine/Live2DRuntimeAdapter';
import { createCubismModelFixture } from './helpers/cubismModelFixture';

function makeRuntime(): SemanticDocumentProjectionRuntimePort {
  return {
    projectPreparedScene: vi.fn(async () => undefined),
  };
}

function makeHarness() {
  const store = new DocumentStore();
  const pipeline = new SemanticScenePipeline({
    resolveAsset: async (source) => `asset://localhost/C:/project/${source}`,
  });
  const coordinator = new SemanticDocumentCoordinator(store, pipeline, makeRuntime());
  const authoring = new SemanticAuthoringApplicationService(store, coordinator);
  return { store, coordinator, authoring };
}

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'semantic-scene',
    meta: {
      title: 'Semantic scene',
      fps: 30,
      durationSeconds: 5,
      characters: [{ id: 'alice', name: 'Alice', model: 'figure/alice.moc' }],
    },
    statements: [
      {
        id: 'perf-1',
        time: 0.5,
        type: 'characterPerformance',
        params: {
          target: 'alice',
          motion: { kind: 'resource', key: 'wave', fadeInSeconds: 0.3 },
          expression: 'smile',
        },
      },
      {
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'alice', text: 'Hi', durationSeconds: 1 },
        companions: [
          {
            id: 'perf-2',
            anchor: 'start',
            offset: 0.2,
            type: 'characterPerformance',
            params: {
              target: 'alice',
              motion: { kind: 'resource', key: 'angry', fadeInSeconds: 0.2 },
            },
          },
        ],
      },
    ],
  };
}

function makeSampler(overrides: Partial<CustomMotionConversionSampler> = {}): CustomMotionConversionSampler {
  const curveOf = (parameterId: string, values: readonly number[]): Live2DMotionSampledCurve => ({
    parameterId,
    samples: values.map((value, index) => ({ time: index / 30, value })),
  });
  return {
    sample: vi.fn(async () => [
      curveOf('PARAM_ANGLE_X', [0, 5, 10, 5, 0]),
      curveOf('PARAM_EYE_OPEN', [1, 1, 1, 1, 1]),
    ]),
    resolveMeta: vi.fn(async () => ({ durationSeconds: 2, fadeInSeconds: 0.4, fadeOutSeconds: 0.2 })),
    ...overrides,
  };
}

function paramsOf(document: CurrentSceneDocument | null, statementId: string): CharacterPerformanceParams {
  const statement = document?.statements.find((candidate) => candidate.id === statementId);
  if (!statement) throw new Error(`Statement missing: ${statementId}`);
  return statement.params as CharacterPerformanceParams;
}

function makeAuthority(granted: boolean) {
  const lease = Object.freeze({}) as HeldCustomMotionLease;
  return {
    lease,
    acquire: vi.fn<CustomMotionEditAuthority['acquire']>(async () => granted
      ? { status: 'granted', lease }
      : { status: 'denied', reason: 'lease-denied' }),
    release: vi.fn<CustomMotionEditAuthority['release']>(async () => {}),
    onLoss: vi.fn<CustomMotionEditAuthority['onLoss']>(() => () => {}),
    dispose: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('CustomMotionConversionCommand', () => {
  it('converts a short Motion3 with inherited source fades and a longer track fade', async () => {
    const { coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const { model } = createCubismModelFixture();
    model.internalModel.settings.motions = { wave: [{ File: 'wave.motion3.json' }] };
    const source = {
      Meta: { Duration: 0.25, FadeInTime: -1, FadeOutTime: -1 },
      Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', FadeInTime: 0.7, Segments: [0, 0, 0, 0.25, 10] }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(source)).buffer })));
    const handle = new CubismPixiLive2DAdapter().createModelHandle('alice', model);
    try {
      const command = new CustomMotionConversionCommand({ authoring,
        sampleMotion: (_id, key, options) => handle.motion.sampleMotion(key, options) });
      const result = await command.convert({ locator: { kind: 'statement', statementId: 'perf-1' }, density: 'standard', origin: 'timeline-editor' });
      expect(result.motion.derivedFrom).toEqual({ key: 'wave', fadeInSeconds: 1, fadeOutSeconds: 1 });
      expect(result.motion.durationSeconds).toBe(0.7);
      expect(result.motion.fadeInSeconds).toBe(0.3);
      expect(result.motion.tracks[0].fadeInSeconds).toBe(0.7);
      expect(result.motion.tracks[0].keyframes.at(-1)?.time).toBe(0.25);
    } finally {
      handle.dispose({ mode: 'destroy' });
      vi.unstubAllGlobals();
    }
  });

  it.each([{ lipSyncIds: ['ParamMouthOpenY'] }, { lipSyncIds: [] }])('converts Motion3 model eye and lip effects with configured lips $lipSyncIds', async ({ lipSyncIds }) => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const { model } = createCubismModelFixture(undefined, ['ParamEyeLOpen', 'ParamEyeROpen']);
    model.internalModel.settings.motions = { wave: [{ File: 'wave.motion3.json' }] };
    model.internalModel.settings.getLipSyncParameters = () => lipSyncIds;
    const source = {
      Meta: { Duration: 1, FadeInTime: 0 },
      Curves: [
        { Target: 'Model', Id: 'EyeBlink', Segments: [0, 1, 0, 1, 0] },
        { Target: 'Model', Id: 'LipSync', Segments: [0, 0.2, 0, 1, 0.6] },
        { Target: 'Parameter', Id: 'ParamEyeLOpen', Segments: [0, 1, 0, 1, 0.5] },
        { Target: 'Parameter', Id: 'ParamMouthOpenY', Segments: [0, 0.1, 0, 1, 0.3] },
        { Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 1, 0.2, 4, 0.7, -2, 1, 8] },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(source)).buffer })));
    const handle = new CubismPixiLive2DAdapter().createModelHandle('alice', model);
    try {
      const command = new CustomMotionConversionCommand({
        authoring, sampleMotion: (_id, key, options) => handle.motion.sampleMotion(key, options),
      });
      const result = await command.convert({
        locator: { kind: 'statement', statementId: 'perf-1' }, density: 'sparse', origin: 'timeline-editor',
      });
      const atHalf = (id: string) => result.motion.tracks.find((track) => track.parameterId === id)?.keyframes.find((point) => point.time === 0.5)?.value;
      expect(atHalf('ParamEyeLOpen')).toBeCloseTo(0.375);
      expect(atHalf('ParamEyeROpen')).toBeCloseTo(0.5);
      expect(atHalf('ParamMouthOpenY')).toBeCloseTo(0.6);
      expect(result.motion.tracks.find((track) => track.parameterId === 'ParamAngleX')?.keyframes[0].segment)
        .toEqual({ type: 'bezier', controlPoints: [{ time: 0.2, value: 4 }, { time: 0.7, value: -2 }] });
      expect(result.motion.tracks.find((track) => track.parameterId === 'ParamEyeLOpen')?.keyframes).toHaveLength(31);
      expect(paramsOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').motion).toEqual(result.motion);
    } finally {
      handle.dispose({ mode: 'destroy' });
      vi.unstubAllGlobals();
    }
  });

  it('preserves native Motion3 segments and track fades without applying the density fit', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const native: Live2DMotionSamplingResult = {
      status: 'sampled', metadata: { durationSeconds: 2, fadeInSeconds: 0.4, fadeOutSeconds: 0.2 },
      motion: {
        kind: 'custom', durationSeconds: 2, fadeInSeconds: 0.4, derivedFrom: { key: 'wave' },
        tracks: [{ parameterId: 'ParamAngleX', fadeInSeconds: 2.5, keyframes: [
          { time: 0, value: 0, segment: { type: 'bezier', controlPoints: [{ time: 0.1, value: 12 }, { time: 0.3, value: -8 }] } },
          { time: 0.425, value: 5, segment: { type: 'stepped' } },
          { time: 1, value: 10, segment: { type: 'inverseStepped' } },
          { time: 2, value: 3 },
        ] }],
      },
    };
    const command = new CustomMotionConversionCommand({ authoring, sampleMotion: async () => native });
    const result = await command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' }, density: 'sparse', origin: 'timeline-editor',
    });
    expect(result.motion.tracks).toEqual(native.motion?.tracks);
    expect(result.motion.fadeInSeconds).toBe(0.3);
    expect(result.motion.durationSeconds).toBe(2.5);
    expect(result.simplifiedTrackIds).toEqual([]);
    expect(paramsOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').expression).toBe('smile');
    expect(sceneDocumentCodec.parseAndValidate(store.getCurrentSceneDocumentSnapshot()).statements[0].params)
      .toMatchObject({ motion: result.motion });
    await authoring.undo();
    expect(paramsOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').motion).toMatchObject({ kind: 'resource' });
  });

  it('converts a resource motion into a codec-valid custom motion preserving sibling outputs', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const sampler = makeSampler();
    const command = new CustomMotionConversionCommand({
      authoring,
      sampler,
    });

    const result = await command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'timeline-editor',
      correlationId: 'convert-1',
    });

    expect(result.motion.kind).toBe('custom');
    expect(result.motion.derivedFrom).toEqual({ key: 'wave', fadeInSeconds: 0.4, fadeOutSeconds: 0.2 });
    expect(result.motion.fadeInSeconds).toBe(0.3);
    expect(result.motion.durationSeconds).toBe(2);
    expect(result.motion.tracks.map((track) => track.parameterId)).toEqual(['PARAM_ANGLE_X', 'PARAM_EYE_OPEN']);
    expect(result.staticTrackIds).toEqual(['PARAM_EYE_OPEN']);
    expect(result.authoring.updatedStatementIds).toEqual(['perf-1']);

    // The committed document must pass the strict codec (round-trip read back).
    const snapshot = store.getCurrentSceneDocumentSnapshot();
    const committedParams = sceneDocumentCodec.parseAndValidate(snapshot).statements[0].params as CharacterPerformanceParams;
    expect(committedParams.motion).toEqual(result.motion);
    const params = paramsOf(snapshot, 'perf-1');
    expect(params.expression).toBe('smile');
    expect(params.target).toBe('alice');
    expect(snapshot!.statements[0].time).toBe(0.5);

    // Undo restores the original resource motion.
    expect(await authoring.undo()).toBe(true);
    expect(paramsOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').motion)
      .toEqual({ kind: 'resource', key: 'wave', fadeInSeconds: 0.3 });
  });

  it('rejects a converted motion violating the canonical contract and commits nothing', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const sampler = makeSampler({
      sample: vi.fn(async () => [
        {
          parameterId: 'PARAM_ANGLE_X',
          samples: [
            { time: 0, value: 0 },
            { time: 1 / 30, value: Number.NaN },
          ],
        },
      ]),
    });
    const command = new CustomMotionConversionCommand({ authoring, sampler });

    // The conversion adapter funnels the produced motion through the
    // canonical contract; a non-finite sampled value surfaces as a
    // structured conversion error instead of being persisted.
    await expect(command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'timeline-editor',
    })).rejects.toMatchObject({
      name: 'CustomMotionConversionError',
      code: 'invalid-conversion-result',
      details: {
        characterId: 'alice',
        motionKey: 'wave',
        contractCode: 'invalid-keyframe',
        contractPath: 'tracks[0].keyframes[1].value',
      },
    });

    // Atomic: the document keeps the original resource motion.
    expect(paramsOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').motion)
      .toEqual({ kind: 'resource', key: 'wave', fadeInSeconds: 0.3 });
  });

  it('regenerates an edited custom motion from its source while preserving the authored outer fade', async () => {
    const { store, coordinator, authoring } = makeHarness();
    const document = makeDocument();
    const editedMotion = {
      kind: 'custom' as const,
      durationSeconds: 3.5,
      fadeInSeconds: 1.4,
      derivedFrom: { key: 'wave', fadeInSeconds: 0.1, fadeOutSeconds: 0.1 },
      tracks: [{
        parameterId: 'MANUALLY_EDITED',
        fadeInSeconds: 0.7,
        keyframes: [
          { time: 0, value: 42, segment: { type: 'linear' as const } },
          { time: 3.5, value: 84 },
        ],
      }],
    };
    (document.statements[0].params as CharacterPerformanceParams).motion = editedMotion;
    await coordinator.applyDocument(document);
    const command = new CustomMotionConversionCommand({
      authoring,
      sampler: makeSampler({
        resolveMeta: vi.fn(async () => ({ durationSeconds: 1, fadeInSeconds: 0.4, fadeOutSeconds: 0.2 })),
      }),
    });

    const result = await command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'timeline-editor',
      correlationId: 'regenerate-1',
    });

    expect(result.motion.fadeInSeconds).toBe(1.4);
    expect(result.motion.durationSeconds).toBe(1.4);
    expect(result.motion.derivedFrom).toEqual({ key: 'wave', fadeInSeconds: 0.4, fadeOutSeconds: 0.2 });
    expect(result.motion.tracks.map((track) => track.parameterId)).toEqual(['PARAM_ANGLE_X', 'PARAM_EYE_OPEN']);
    expect(result.motion.tracks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ parameterId: 'MANUALLY_EDITED' }),
    ]));

    expect(await authoring.undo()).toBe(true);
    expect(paramsOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').motion).toEqual(editedMotion);
  });

  it('falls back to the source fade and the 500ms default in order', async () => {
    const { coordinator, authoring } = makeHarness();
    const document = makeDocument();
    (document.statements[0].params as any).motion = { kind: 'resource', key: 'wave' };
    await coordinator.applyDocument(document);
    const command = new CustomMotionConversionCommand({
      authoring,
      sampler: makeSampler(),
    });

    const result = await command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'fine',
      origin: 'timeline-editor',
    });
    expect(result.motion.fadeInSeconds).toBe(0.4);
    expect(result.motion.durationSeconds).toBe(2);

    const noSourceFade = makeSampler({
      resolveMeta: vi.fn(async () => ({ durationSeconds: 1.5 })),
    });
    // Reset to a fresh resource motion for the default-fade path.
    await coordinator.applyDocument(document);
    const command2 = new CustomMotionConversionCommand({ authoring, sampler: noSourceFade });
    const result2 = await command2.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'timeline-editor',
    });
    expect(result2.motion.fadeInSeconds).toBe(CUSTOM_MOTION_CONVERSION_DEFAULT_FADE_IN_SECONDS);
    expect(result2.motion.durationSeconds).toBe(1.5);
  });

  it('converts a dialogue companion motion in place', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const command = new CustomMotionConversionCommand({ authoring, sampler: makeSampler() });

    const result = await command.convert({
      locator: { kind: 'companion', statementId: 'dialogue-1', companionId: 'perf-2' },
      density: 'perFrame',
      origin: 'timeline-editor',
    });

    expect(result.authoring.updatedCompanionLocators).toEqual([{ statementId: 'dialogue-1', companionId: 'perf-2' }]);
    const companion = store.getCurrentSceneDocumentSnapshot()?.statements[1].companions?.[0];
    const companionParams = companion?.params as CharacterPerformanceParams;
    expect(typeof companionParams.motion === 'object' ? companionParams.motion.kind : undefined).toBe('custom');
    expect(companionParams.motion && 'derivedFrom' in companionParams.motion ? companionParams.motion.derivedFrom.key : undefined)
      .toBe('angry');
  });

  it('refuses when the entity, motion source, or loaded character is unavailable', async () => {
    const { coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const command = new CustomMotionConversionCommand({ authoring, sampler: makeSampler() });

    await expect(command.convert({
      locator: { kind: 'statement', statementId: 'missing' },
      density: 'standard',
      origin: 'timeline-editor',
    })).rejects.toMatchObject({ name: 'CustomMotionConversionError', code: 'entity-not-found' });

    await expect(command.convert({
      locator: { kind: 'statement', statementId: 'dialogue-1' },
      density: 'standard',
      origin: 'timeline-editor',
    })).rejects.toMatchObject({ name: 'CustomMotionConversionError', code: 'not-character-performance' });

    const document = makeDocument();
    delete (document.statements[0].params as any).motion;
    await coordinator.applyDocument(document);
    await expect(command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'timeline-editor',
    })).rejects.toMatchObject({ name: 'CustomMotionConversionError', code: 'motion-source-unavailable' });
  });

  it('refuses when the character is not loaded and keeps the document unchanged', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const command = new CustomMotionConversionCommand({ authoring });
    const before = store.getCurrentSceneDocumentSnapshot();

    await expect(command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'timeline-editor',
    })).rejects.toMatchObject({ name: 'CustomMotionConversionError', code: 'character-not-loaded' });

    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(before);
    expect(paramsOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').motion)
      .toEqual({ kind: 'resource', key: 'wave', fadeInSeconds: 0.3 });
  });

  it('refuses unresolvable source motions and Parts-only motions', async () => {
    const { coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const command = new CustomMotionConversionCommand({
      authoring,
      sampler: makeSampler({
        resolveMeta: vi.fn(async () => {
          throw new Error('mock motion missing');
        }),
      }),
    });

    await expect(command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'timeline-editor',
    })).rejects.toMatchObject({ name: 'CustomMotionConversionError', code: 'sampling-failed' });

    const command2 = new CustomMotionConversionCommand({
      authoring,
      sampler: makeSampler({
        resolveMeta: vi.fn(async () => ({ durationSeconds: 1 })),
        sample: vi.fn(async () => []),
      }),
    });
    await expect(command2.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'timeline-editor',
    })).rejects.toMatchObject({ name: 'CustomMotionConversionError', code: 'no-convertible-parameters' });
  });

  it('propagates sampling failures (motion not found / model mismatch) atomically', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const command = new CustomMotionConversionCommand({
      authoring,
      sampler: makeSampler({
        sample: vi.fn(async () => {
          throw new CustomMotionConversionError('mock motion missing', 'sampling-failed', { code: 'motion-not-found' });
        }),
      }),
    });
    const before = store.getCurrentSceneDocumentSnapshot();

    await expect(command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'timeline-editor',
    })).rejects.toBeInstanceOf(CustomMotionConversionError);
    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(before);
  });

  it('requires the collaboration lease before committing and releases on failure', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());

    const gate = makeAuthority(false);
    const command = new CustomMotionConversionCommand({ authoring, sampler: makeSampler(), authority: gate });
    await expect(command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'collaboration',
    })).rejects.toMatchObject({ name: 'CustomMotionConversionError', code: 'lease-denied' });
    expect(gate.acquire).toHaveBeenCalledWith({ kind: 'statement', statementId: 'perf-1' }, expect.any(AbortSignal));
    expect(gate.release).not.toHaveBeenCalled();
    const deniedMotion = paramsOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').motion;
    expect(typeof deniedMotion === 'object' ? deniedMotion.kind : undefined).toBe('resource');

    const granted = makeAuthority(true);
    const command2 = new CustomMotionConversionCommand({
      authoring,
      sampler: makeSampler(),
      authority: granted,
    });
    const result = await command2.convert({
      locator: { kind: 'companion', statementId: 'dialogue-1', companionId: 'perf-2' },
      density: 'standard',
      origin: 'collaboration',
    });
    expect(result.motion.kind).toBe('custom');
    expect(granted.acquire).toHaveBeenCalledWith({
      kind: 'companion',
      statementId: 'dialogue-1',
      companionId: 'perf-2',
    }, expect.any(AbortSignal));
    expect(granted.release).toHaveBeenCalledExactlyOnceWith(granted.lease);
  });

  it('keeps sampling and pending authority read-only, then commits one undoable conversion', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const before = store.getCurrentSceneDocumentSnapshot();
    const authority = makeAuthority(true);
    const sampleEntered = deferred<void>();
    const finishSampling = deferred<void>();
    const acquireEntered = deferred<void>();
    const decision = deferred<LeaseDecision>();
    const sampler = makeSampler();
    const sample = sampler.sample;
    sampler.sample = vi.fn<CustomMotionConversionSampler['sample']>(async (...args) => {
      sampleEntered.resolve();
      await finishSampling.promise;
      return sample(...args);
    });
    authority.acquire.mockImplementationOnce(async () => {
      acquireEntered.resolve();
      return decision.promise;
    });
    const signal = new AbortController().signal;
    const command = new CustomMotionConversionCommand({ authoring, sampler, authority });
    const pending = command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard', origin: 'timeline-editor', signal,
    });
    await sampleEntered.promise;
    expect(authority.acquire).not.toHaveBeenCalled();
    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(before);
    finishSampling.resolve();
    await acquireEntered.promise;
    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(before);
    expect(await authoring.undo()).toBe(false);
    decision.resolve({ status: 'granted', lease: authority.lease });
    const result = await pending;
    expect(paramsOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').motion).toEqual(result.motion);
    expect(authority.acquire).toHaveBeenCalledExactlyOnceWith({ kind: 'statement', statementId: 'perf-1' }, signal);
    expect(authority.release).toHaveBeenCalledExactlyOnceWith(authority.lease);
    expect(await authoring.undo()).toBe(true);
    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(before);
    expect(await authoring.undo()).toBe(false);
  });

  it.each(['authority loss', 'cancellation'] as const)('drops a queued conversion after %s and releases ownership', async (cause) => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const before = store.getCurrentSceneDocumentSnapshot();
    const authority = makeAuthority(true);
    let notifyLoss: ((reason: string) => void) | undefined;
    const unsubscribe = vi.fn();
    authority.onLoss.mockImplementation((_lease, listener) => {
      notifyLoss = listener;
      return unsubscribe;
    });
    const transactionEntered = deferred<void>();
    const resumeTransaction = deferred<void>();
    const authorTransaction = authoring.authorTransaction.bind(authoring);
    vi.spyOn(authoring, 'authorTransaction').mockImplementationOnce(async (...args) => {
      transactionEntered.resolve();
      await resumeTransaction.promise;
      return authorTransaction(...args);
    });
    const controller = new AbortController();
    const command = new CustomMotionConversionCommand({ authoring, sampler: makeSampler(), authority });
    const pending = command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard', origin: 'timeline-editor', signal: controller.signal,
    });
    await transactionEntered.promise;
    if (cause === 'authority loss') notifyLoss?.('disconnected');
    else controller.abort();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'CustomMotionConversionError', code: 'entity-changed' });
    resumeTransaction.resolve();
    await rejected;
    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(before);
    expect(await authoring.undo()).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(authority.release).toHaveBeenCalledExactlyOnceWith(authority.lease);
  });

  it.each([true, false])('hands committed ownership to the editor without another acquire (accepted: %s)', async (accepted) => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const authority = makeAuthority(true);
    const command = new CustomMotionConversionCommand({ authoring, sampler: makeSampler(), authority });
    const handoff = vi.fn(async (lease: HeldCustomMotionLease) => {
      expect(lease).toBe(authority.lease);
      expect(paramsOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').motion).toMatchObject({ kind: 'custom' });
      return accepted;
    });
    await command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard', origin: 'timeline-editor',
    }, handoff);
    expect(handoff).toHaveBeenCalledExactlyOnceWith(authority.lease);
    expect(authority.acquire).toHaveBeenCalledTimes(1);
    if (accepted) expect(authority.release).not.toHaveBeenCalled();
    else expect(authority.release).toHaveBeenCalledExactlyOnceWith(authority.lease);
  });

  it('grows meta.durationSeconds when the converted motion extends past the scene end', async () => {
    const { store, coordinator, authoring } = makeHarness();
    const document = makeDocument();
    document.meta.durationSeconds = 5;
    (document.statements[0] as { time: number }).time = 4.5;
    await coordinator.applyDocument(document);
    const command = new CustomMotionConversionCommand({ authoring, sampler: makeSampler() });

    await command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'timeline-editor',
    });

    const snapshot = store.getCurrentSceneDocumentSnapshot();
    expect(snapshot?.meta.durationSeconds).toBe(6.5);
    expect(sceneDocumentCodec.parseAndValidate(snapshot).meta.durationSeconds).toBe(6.5);
  });

  it('rebases onto sibling updates that landed while sampling', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const sampler = makeSampler({
      sample: vi.fn(async () => {
        const statement = authoring.getDocumentSnapshot()?.statements[0];
        await authoring.author({
          version: AUTHORING_SCHEMA_VERSION,
          correlationId: 'concurrent-expression',
          origin: 'timeline-editor',
          kind: 'update-statement',
          statementId: 'perf-1',
          patch: { params: { ...(statement!.params as CharacterPerformanceParams), expression: 'wink' } },
        });
        return [
          { parameterId: 'PARAM_ANGLE_X', samples: [0, 1, 2, 3, 4].map((value, index) => ({ time: index / 30, value })) },
          { parameterId: 'PARAM_EYE_OPEN', samples: [1, 1, 1, 1, 1].map((value, index) => ({ time: index / 30, value })) },
        ];
      }),
    });
    const command = new CustomMotionConversionCommand({ authoring, sampler });

    await command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'timeline-editor',
    });

    const snapshot = store.getCurrentSceneDocumentSnapshot();
    const params = paramsOf(snapshot, 'perf-1');
    expect(params.expression).toBe('wink');
    expect(typeof params.motion === 'object' ? params.motion.kind : undefined).toBe('custom');
  });

  it('aborts with entity-changed when the source motion is replaced while sampling', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const sampler = makeSampler({
      sample: vi.fn(async () => {
        const statement = authoring.getDocumentSnapshot()?.statements[0];
        await authoring.author({
          version: AUTHORING_SCHEMA_VERSION,
          correlationId: 'concurrent-motion-swap',
          origin: 'timeline-editor',
          kind: 'update-statement',
          statementId: 'perf-1',
          patch: {
            params: {
              ...(statement!.params as CharacterPerformanceParams),
              motion: { kind: 'resource', key: 'OTHER' },
            },
          },
        });
        return [
          { parameterId: 'PARAM_ANGLE_X', samples: [0, 1, 2, 3, 4].map((value, index) => ({ time: index / 30, value })) },
        ];
      }),
    });
    const command = new CustomMotionConversionCommand({ authoring, sampler });

    await expect(command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'timeline-editor',
    })).rejects.toMatchObject({ name: 'CustomMotionConversionError', code: 'entity-changed' });

    expect(paramsOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').motion)
      .toEqual({ kind: 'resource', key: 'OTHER' });
  });

  it('releases the lease when the commit fails after it was acquired', async () => {
    const { coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const gate = makeAuthority(true);
    const sampler = makeSampler({
      sample: vi.fn(async () => {
        const statement = authoring.getDocumentSnapshot()?.statements[0];
        await authoring.author({
          version: AUTHORING_SCHEMA_VERSION,
          correlationId: 'concurrent-motion-swap-2',
          origin: 'timeline-editor',
          kind: 'update-statement',
          statementId: 'perf-1',
          patch: {
            params: {
              ...(statement!.params as CharacterPerformanceParams),
              motion: { kind: 'resource', key: 'OTHER' },
            },
          },
        });
        return [
          { parameterId: 'PARAM_ANGLE_X', samples: [0, 1, 2, 3, 4].map((value, index) => ({ time: index / 30, value })) },
        ];
      }),
    });
    const command = new CustomMotionConversionCommand({
      authoring,
      sampler,
      authority: gate,
    });

    await expect(command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'collaboration',
    })).rejects.toMatchObject({ name: 'CustomMotionConversionError', code: 'entity-changed' });
    expect(gate.acquire).toHaveBeenCalledWith({ kind: 'statement', statementId: 'perf-1' }, expect.any(AbortSignal));
    expect(gate.release).toHaveBeenCalledExactlyOnceWith(gate.lease);
  });

  it('keeps the original document when the authoring pipeline rejects the result', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const before = store.getCurrentSceneDocumentSnapshot();
    const command = new CustomMotionConversionCommand({
      authoring,
      sampler: makeSampler({
        sample: vi.fn(async () => [{
          parameterId: 'A',
          samples: [{ time: Number.NaN, value: 1 }],
        }]),
      }),
    });

    await expect(command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'timeline-editor',
    })).rejects.toThrow();
    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(before);
  });

  it('exposes the default fade constant for UI copy', () => {
    expect(CUSTOM_MOTION_CONVERSION_DEFAULT_FADE_IN_SECONDS).toBe(0.5);
    expect(AUTHORING_SCHEMA_VERSION).toBe(3);
  });
});

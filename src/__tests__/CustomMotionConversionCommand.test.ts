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
import type { CustomMotionConversionSampler } from '../services/timeline-authoring/CustomMotionConversionCommand';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { DocumentStore } from '../ui/store/DocumentStore';
import type { SemanticDocumentProjectionRuntimePort } from '../services/document/DocumentProjectionPorts';
import { sceneDocumentCodec } from '../services/semantic-scene';
import { Cubism2MotionSamplingError, type Cubism2MotionCurve } from '../engine/live2d/cubism2MotionSampler';

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
  const curveOf = (parameterId: string, values: readonly number[]): Cubism2MotionCurve => ({
    parameterId,
    samples: values.map((value, index) => ({ time: index / 30, value })),
  });
  return {
    sample: vi.fn(async () => [
      curveOf('PARAM_ANGLE_X', [0, 5, 10, 5, 0]),
      curveOf('PARAM_EYE_OPEN', [1, 1, 1, 1, 1]),
    ]),
    merge: vi.fn((perModel) => perModel[0] ?? []),
    resolveMeta: vi.fn(async () => ({ durationSeconds: 2, fadeInSeconds: 0.4, fadeOutSeconds: 0.2 })),
    ...overrides,
  };
}

const samplerTargets = vi.fn((characterId: string) => (
  characterId === 'alice'
    ? [{ internalModel: { coreModel: {} }, motionManager: { loadMotion: vi.fn() } }]
    : []
));

function paramsOf(document: CurrentSceneDocument | null, statementId: string): CharacterPerformanceParams {
  const statement = document?.statements.find((candidate) => candidate.id === statementId);
  if (!statement) throw new Error(`Statement missing: ${statementId}`);
  return statement.params as CharacterPerformanceParams;
}

function makeGate(acquired: boolean) {
  return {
    acquire: vi.fn(async () => acquired),
    release: vi.fn(),
  };
}

describe('CustomMotionConversionCommand', () => {
  it('converts a resource motion into a codec-valid custom motion preserving sibling outputs', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const sampler = makeSampler();
    const command = new CustomMotionConversionCommand({
      authoring,
      samplerTargets,
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
    const command = new CustomMotionConversionCommand({ authoring, samplerTargets, sampler });

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
      samplerTargets,
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
      samplerTargets,
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
    const command2 = new CustomMotionConversionCommand({ authoring, samplerTargets, sampler: noSourceFade });
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
    const command = new CustomMotionConversionCommand({ authoring, samplerTargets, sampler: makeSampler() });

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
    const command = new CustomMotionConversionCommand({ authoring, samplerTargets, sampler: makeSampler() });

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
    const command = new CustomMotionConversionCommand({
      authoring,
      samplerTargets: vi.fn(() => []),
      sampler: makeSampler(),
    });
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
      samplerTargets,
      sampler: makeSampler({
        resolveMeta: vi.fn(async () => {
          throw new Cubism2MotionSamplingError('mock motion missing', 'motion-not-found');
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
      samplerTargets,
      sampler: makeSampler({
        resolveMeta: vi.fn(async () => ({ durationSeconds: 1 })),
        merge: vi.fn(() => []),
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
      samplerTargets,
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

    const gate = makeGate(false);
    const command = new CustomMotionConversionCommand({ authoring, samplerTargets, sampler: makeSampler(), leaseGate: gate });
    await expect(command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'collaboration',
    })).rejects.toMatchObject({ name: 'CustomMotionConversionError', code: 'lease-denied' });
    expect(gate.acquire).toHaveBeenCalledWith({ kind: 'statement', statementId: 'perf-1' });
    expect(gate.release).not.toHaveBeenCalled();
    const deniedMotion = paramsOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').motion;
    expect(typeof deniedMotion === 'object' ? deniedMotion.kind : undefined).toBe('resource');

    const granted = makeGate(true);
    const command2 = new CustomMotionConversionCommand({
      authoring,
      samplerTargets,
      sampler: makeSampler(),
      leaseGate: granted,
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
    });
    expect(granted.release).toHaveBeenCalledWith({
      kind: 'companion',
      statementId: 'dialogue-1',
      companionId: 'perf-2',
    });
  });

  it('grows meta.durationSeconds when the converted motion extends past the scene end', async () => {
    const { store, coordinator, authoring } = makeHarness();
    const document = makeDocument();
    document.meta.durationSeconds = 5;
    (document.statements[0] as { time: number }).time = 4.5;
    await coordinator.applyDocument(document);
    const command = new CustomMotionConversionCommand({ authoring, samplerTargets, sampler: makeSampler() });

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
    const command = new CustomMotionConversionCommand({ authoring, samplerTargets, sampler });

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
    const command = new CustomMotionConversionCommand({ authoring, samplerTargets, sampler });

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
    const gate = makeGate(true);
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
      samplerTargets,
      sampler,
      leaseGate: gate,
    });

    await expect(command.convert({
      locator: { kind: 'statement', statementId: 'perf-1' },
      density: 'standard',
      origin: 'collaboration',
    })).rejects.toMatchObject({ name: 'CustomMotionConversionError', code: 'entity-changed' });
    expect(gate.acquire).toHaveBeenCalledWith({ kind: 'statement', statementId: 'perf-1' });
    expect(gate.release).toHaveBeenCalledWith({ kind: 'statement', statementId: 'perf-1' });
  });

  it('keeps the original document when the authoring pipeline rejects the result', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const before = store.getCurrentSceneDocumentSnapshot();
    const command = new CustomMotionConversionCommand({
      authoring,
      samplerTargets,
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

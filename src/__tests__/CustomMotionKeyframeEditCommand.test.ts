import { describe, expect, it, vi } from 'vitest';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import {
  SCENE_SCHEMA_VERSION,
  type CharacterMotionOutput,
  type CharacterPerformanceParams,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { sceneDocumentCodec, SemanticScenePipeline } from '../services/semantic-scene';
import {
  CustomMotionKeyframeEditCommand,
  CustomMotionKeyframeEditCommandError,
} from '../services/timeline-authoring/CustomMotionKeyframeEditCommand';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { DocumentStore } from '../ui/store/DocumentStore';
import type { SemanticDocumentProjectionRuntimePort } from '../services/document/DocumentProjectionPorts';

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
      fps: 60,
      durationSeconds: 3,
      characters: [{ id: 'alice', name: 'Alice', model: 'figure/alice.moc' }],
    },
    statements: [
      {
        id: 'perf-1',
        time: 0.5,
        type: 'characterPerformance',
        params: {
          target: 'alice',
          motion: {
            kind: 'custom',
            durationSeconds: 2,
            fadeInSeconds: 0.3,
            derivedFrom: { key: 'wave', fadeInSeconds: 0.4, fadeOutSeconds: 0.2 },
            tracks: [
              {
                parameterId: 'PARAM_ANGLE_X',
                keyframes: [
                  { time: 0, value: 0, segment: { type: 'linear' } },
                  { time: 1, value: 10, segment: { type: 'linear' } },
                  { time: 2, value: 5 },
                ],
              },
            ],
          },
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
              motion: {
                kind: 'custom',
                durationSeconds: 1,
                fadeInSeconds: 0.1,
                derivedFrom: { key: 'angry' },
                tracks: [
                  {
                    parameterId: 'PARAM_ANGLE_Z',
                    keyframes: [
                      { time: 0, value: 0, segment: { type: 'linear' } },
                      { time: 1, value: 5 },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  };
}

function makeGate(acquired: boolean) {
  return {
    acquire: vi.fn(async () => acquired),
    release: vi.fn(),
  };
}

function paramsOf(document: CurrentSceneDocument | null, statementId: string): CharacterPerformanceParams {
  const statement = document?.statements.find((candidate) => candidate.id === statementId);
  if (!statement) throw new Error(`Statement missing: ${statementId}`);
  return statement.params as CharacterPerformanceParams;
}

function customMotionOf(document: CurrentSceneDocument | null, statementId: string): Extract<CharacterMotionOutput, { kind: 'custom' }> {
  const motion = paramsOf(document, statementId).motion;
  if (!motion || motion.kind !== 'custom') throw new Error(`Statement "${statementId}" has no custom motion`);
  return motion;
}

describe('CustomMotionKeyframeEditCommand', () => {
  it('commits a multi-point move as one undo and rejects stale snapshots', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const before = customMotionOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1');
    const command = new CustomMotionKeyframeEditCommand({ authoring });
    const result = await command.edit({
      locator: { kind: 'statement', statementId: 'perf-1' }, origin: 'timeline-editor', expectedMotion: before,
      edits: [{ type: 'move-keyframes', keyframes: [{ parameterId: 'PARAM_ANGLE_X', time: 1 }, { parameterId: 'PARAM_ANGLE_X', time: 2 }], deltaTime: -0.5 }],
    });
    expect(result.motion.tracks[0].keyframes[1].time).toBe(0.5);
    await expect(command.edit({
      locator: { kind: 'statement', statementId: 'perf-1' }, origin: 'timeline-editor', expectedMotion: before,
      edits: [{ type: 'remove-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 0.5 }],
    })).rejects.toMatchObject({ code: 'entity-changed' });
    expect(await authoring.undo()).toBe(true);
    expect(customMotionOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1')).toEqual(before);
    expect(await authoring.undo()).toBe(false);
  });

  it('rejects an edit from a replaced scene or a changed frame rate', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const command = new CustomMotionKeyframeEditCommand({ authoring });
    const before = customMotionOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1');
    const request = {
      locator: { kind: 'statement' as const, statementId: 'perf-1' }, origin: 'timeline-editor' as const,
      expectedMotion: before, edits: [{ type: 'remove-keyframe' as const, trackParameterId: 'PARAM_ANGLE_X', time: 1 }],
    };
    await expect(command.edit({ ...request, expectedSceneId: 'other-scene' })).rejects.toMatchObject({ code: 'entity-changed' });
    await expect(command.edit({ ...request, expectedFps: 30 })).rejects.toMatchObject({ code: 'entity-changed' });
    expect(customMotionOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1')).toEqual(before);
    expect(await authoring.undo()).toBe(false);
  });

  it('accepts an equivalent snapshot with a different object field order', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const motion = customMotionOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1');
    const expectedMotion = {
      ...motion,
      tracks: motion.tracks.map((track) => ({ keyframes: track.keyframes, parameterId: track.parameterId })),
    };
    const command = new CustomMotionKeyframeEditCommand({ authoring });
    const result = await command.edit({
      locator: { kind: 'statement', statementId: 'perf-1' }, origin: 'timeline-editor', expectedMotion,
      edits: [{ type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 1, value: 12 }],
    });
    expect(result.motion.tracks[0].keyframes[1].value).toBe(12);
  });

  it('applies a value edit, commits through the codec, and undoes as one record', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const command = new CustomMotionKeyframeEditCommand({ authoring });

    const result = await command.edit({
      locator: { kind: 'statement', statementId: 'perf-1' },
      origin: 'timeline-editor',
      edits: [{ type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 1, value: 12 }],
    });

    expect(result.motion.tracks[0].keyframes[1].value).toBe(12);
    expect(result.authoring.updatedStatementIds).toEqual(['perf-1']);

    const snapshot = store.getCurrentSceneDocumentSnapshot();
    const committed = sceneDocumentCodec.parseAndValidate(snapshot).statements[0].params as CharacterPerformanceParams;
    expect(committed.motion).toEqual(result.motion);
    // Sibling outputs survive.
    expect(paramsOf(snapshot, 'perf-1').expression).toBe('smile');

    expect(await authoring.undo()).toBe(true);
    const restored = customMotionOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1');
    expect(restored.tracks[0].keyframes[1].value).toBe(10);
  });

  it('grows meta.durationSeconds when the motion is extended past the scene end', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const command = new CustomMotionKeyframeEditCommand({ authoring });

    await command.edit({
      locator: { kind: 'statement', statementId: 'perf-1' },
      origin: 'timeline-editor',
      edits: [{ type: 'set-duration', durationSeconds: 4 }],
    });

    const snapshot = store.getCurrentSceneDocumentSnapshot();
    expect(snapshot?.meta.durationSeconds).toBe(4.5);
    // Codec still accepts the extended document (invariant: meta >= last end).
    expect(sceneDocumentCodec.parseAndValidate(snapshot).meta.durationSeconds).toBe(4.5);
  });

  it('edits dialogue companion motions in place', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const command = new CustomMotionKeyframeEditCommand({ authoring });

    const result = await command.edit({
      locator: { kind: 'companion', statementId: 'dialogue-1', companionId: 'perf-2' },
      origin: 'timeline-editor',
      edits: [
        { type: 'insert-keyframe', trackParameterId: 'PARAM_ANGLE_Z', time: 0.5, value: 2.5 },
      ],
    });

    expect(result.authoring.updatedCompanionLocators).toEqual([{ statementId: 'dialogue-1', companionId: 'perf-2' }]);
    const companion = store.getCurrentSceneDocumentSnapshot()?.statements[1].companions?.[0];
    const companionParams = companion?.params as CharacterPerformanceParams;
    expect(typeof companionParams.motion === 'object' ? companionParams.motion.kind : undefined).toBe('custom');
    expect((companionParams.motion as Extract<CharacterMotionOutput, { kind: 'custom' }>).tracks[0].keyframes.map((keyframe) => keyframe.time))
      .toEqual([0, 0.5, 1]);
  });

  it('refuses unknown entities and non-custom motions before authoring', async () => {
    const { coordinator, authoring } = makeHarness();
    const document = makeDocument();
    (document.statements[0].params as any).motion = { kind: 'resource', key: 'wave' };
    await coordinator.applyDocument(document);
    const command = new CustomMotionKeyframeEditCommand({ authoring });

    await expect(command.edit({
      locator: { kind: 'statement', statementId: 'missing' },
      origin: 'timeline-editor',
      edits: [],
    })).rejects.toMatchObject({ name: 'CustomMotionKeyframeEditCommandError', code: 'entity-not-found' });

    await expect(command.edit({
      locator: { kind: 'statement', statementId: 'perf-1' },
      origin: 'timeline-editor',
      edits: [],
    })).rejects.toMatchObject({ name: 'CustomMotionKeyframeEditCommandError', code: 'motion-not-custom' });
  });

  it('rejects F0 deletion and collision edits before the pipeline', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const command = new CustomMotionKeyframeEditCommand({ authoring });
    const before = store.getCurrentSceneDocumentSnapshot();

    await expect(command.edit({
      locator: { kind: 'statement', statementId: 'perf-1' },
      origin: 'timeline-editor',
      edits: [{ type: 'remove-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 0 }],
    })).rejects.toThrowError(/protected/);

    await expect(command.edit({
      locator: { kind: 'statement', statementId: 'perf-1' },
      origin: 'timeline-editor',
      edits: [{ type: 'insert-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 1, value: 1 }],
    })).rejects.toThrowError(/occupied/);

    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(before);
  });

  it('requires the collaboration lease before applying local writes', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());

    const gate = makeGate(false);
    const command = new CustomMotionKeyframeEditCommand({ authoring, leaseGate: gate });
    await expect(command.edit({
      locator: { kind: 'statement', statementId: 'perf-1' },
      origin: 'collaboration',
      edits: [{ type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 1, value: 99 }],
    })).rejects.toBeInstanceOf(CustomMotionKeyframeEditCommandError);
    expect(gate.acquire).toHaveBeenCalledWith({ kind: 'statement', statementId: 'perf-1' });
    expect(customMotionOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').tracks[0].keyframes[1].value).toBe(10);

    const granted = makeGate(true);
    const command2 = new CustomMotionKeyframeEditCommand({ authoring, leaseGate: granted });
    await command2.edit({
      locator: { kind: 'statement', statementId: 'perf-1' },
      origin: 'collaboration',
      edits: [{ type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 1, value: 99 }],
    });
    expect(customMotionOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1').tracks[0].keyframes[1].value).toBe(99);
    expect(granted.release).toHaveBeenCalledWith({ kind: 'statement', statementId: 'perf-1' });
  });

  it('rebases onto updates that landed while the lease was pending', async () => {
    const { store, coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());

    const gate = {
      acquire: vi.fn(async () => {
        // A collaborator updates a different keyframe while this command
        // waits for the lease; the fresh snapshot must keep that change.
        const current = customMotionOf(authoring.getDocumentSnapshot(), 'perf-1');
        await authoring.author({
          version: AUTHORING_SCHEMA_VERSION,
          correlationId: 'remote-edit',
          origin: 'collaboration',
          kind: 'update-custom-motion-keyframes',
          locator: { statementId: 'perf-1' },
          motion: {
            ...current,
            tracks: current.tracks.map((track) => track.parameterId === 'PARAM_ANGLE_X'
              ? {
                  ...track,
                  keyframes: track.keyframes.map((keyframe) =>
                    keyframe.time === 2 ? { ...keyframe, value: 2 } : keyframe,
                  ),
                }
              : track),
          },
        });
        return true;
      }),
      release: vi.fn(),
    };
    const command = new CustomMotionKeyframeEditCommand({ authoring, leaseGate: gate });

    const result = await command.edit({
      locator: { kind: 'statement', statementId: 'perf-1' },
      origin: 'collaboration',
      edits: [{ type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 1, value: 12 }],
    });

    expect(result.motion.tracks[0].keyframes[1].value).toBe(12);
    const motion = customMotionOf(store.getCurrentSceneDocumentSnapshot(), 'perf-1');
    expect(motion.tracks[0].keyframes.find((keyframe) => keyframe.time === 1)?.value).toBe(12);
    expect(motion.tracks[0].keyframes.find((keyframe) => keyframe.time === 2)?.value).toBe(2);
  });

  it('rejects cross-motion intents through the derivedFrom identity guard', async () => {
    const { coordinator, authoring } = makeHarness();
    await coordinator.applyDocument(makeDocument());
    const command = new CustomMotionKeyframeEditCommand({ authoring });

    const result = await command.edit({
      locator: { kind: 'statement', statementId: 'perf-1' },
      origin: 'timeline-editor',
      edits: [{ type: 'update-keyframe', trackParameterId: 'PARAM_ANGLE_X', time: 1, value: 11 }],
    });
    const tampered = {
      ...result.motion,
      derivedFrom: { key: 'OTHER' },
    };

    await expect(authoring.author({
      version: 3,
      correlationId: 'tampered',
      origin: 'timeline-editor',
      kind: 'update-custom-motion-keyframes',
      locator: { statementId: 'perf-1' },
      motion: tampered,
    })).rejects.toThrowError(/derivedFrom/);
  });
});

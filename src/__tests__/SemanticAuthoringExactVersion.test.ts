import { describe, expect, it, vi } from 'vitest';
import type { AgentValidateSceneDiagnostic } from '../api/types/project-agent';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { SemanticDocumentProjectionRuntimePort } from '../services/document/DocumentProjectionPorts';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { DocumentStore } from '../ui/store/DocumentStore';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_exact',
    meta: { title: 'Exact Scene', characters: [{ id: 'tomori', name: 'Tomori' }] },
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'tomori', text: 'First', durationSeconds: 2 },
      },
    ],
  };
}

function makeServices() {
  const store = new DocumentStore();
  const runtime: SemanticDocumentProjectionRuntimePort = {
    projectPreparedScene: vi.fn(async () => undefined),
  };
  const pipeline = new SemanticScenePipeline({
    resolveAsset: async (source) => `asset://test/${source}`,
  });
  const coordinator = new SemanticDocumentCoordinator(store, pipeline, runtime);
  const authoring = new SemanticAuthoringApplicationService(store, coordinator);
  return { store, coordinator, authoring };
}

function gateErrors(errors: readonly string[]): (document: CurrentSceneDocument) => readonly AgentValidateSceneDiagnostic[] {
  return () => errors.map((message) => ({
    gate: 'semantic',
    severity: 'error',
    message,
  }));
}

describe('SemanticAuthoringApplicationService.commitExactVersion (ADR0023)', () => {
  it('clears undo and redo history and notifies history subscribers', async () => {
    const { store, coordinator, authoring } = makeServices();
    await coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    await authoring.replaceDocument({
      ...makeDocument(),
      statements: [
        {
          id: 'dlg_1',
          time: 0,
          type: 'dialogue',
          params: { speakerId: 'tomori', text: 'Updated', durationSeconds: 2 },
        },
      ],
    });
    expect(authoring.canUndo).toBe(true);

    expect(await authoring.undo()).toBe(true);
    expect(authoring.canRedo).toBe(true);

    const listener = vi.fn();
    authoring.subscribeHistory(listener);
    authoring.clearHistory();

    expect(authoring.canUndo).toBe(false);
    expect(authoring.canRedo).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(await authoring.undo()).toBe(false);
    expect(await authoring.redo()).toBe(false);
    expect((store.getCurrentSceneDocumentSnapshot()?.statements[0]?.params as { text?: string })?.text).toBe('First');
  });

  it('commits a candidate only when the current version exactly matches, recording history', async () => {
    const { store, coordinator, authoring } = makeServices();
    await coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    const baseVersion = store.version;
    const candidate: CurrentSceneDocument = {
      ...makeDocument(),
      statements: [
        { id: 'dlg_1', time: 0, type: 'dialogue', params: { speakerId: 'tomori', text: 'Updated', durationSeconds: 2 } },
      ],
    };

    const result = await authoring.commitExactVersion({
      candidate,
      expectedVersion: baseVersion,
      validate: () => [],
    });
    expect(result.version).toBe(baseVersion + 1);
    expect((store.getCurrentSceneDocumentSnapshot()?.statements[0]?.params as { text?: string })?.text).toBe('Updated');
    expect(authoring.canUndo).toBe(true);
  });

  it('rejects with version_conflict when the version changed and commits nothing', async () => {
    const { store, coordinator, authoring } = makeServices();
    await coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    const baseVersion = store.version;
    // A human edit lands after the agent's base read.
    await coordinator.applyDocument({
      ...makeDocument(),
      statements: [
        { id: 'dlg_1', time: 0, type: 'dialogue', params: { speakerId: 'tomori', text: 'Human edit', durationSeconds: 2 } },
      ],
    });

    await expect(authoring.commitExactVersion({
      candidate: makeDocument(),
      expectedVersion: baseVersion,
      validate: () => [],
    })).rejects.toMatchObject({ code: 'version_conflict' });
    expect(store.version).toBe(baseVersion + 1);
    expect((store.getCurrentSceneDocumentSnapshot()?.statements[0]?.params as { text?: string })?.text).toBe('Human edit');
    expect(authoring.canUndo).toBe(false);
  });

  it('blocks commit inside the queue when the authoritative gate reports errors', async () => {
    const { store, coordinator, authoring } = makeServices();
    await coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    const baseVersion = store.version;

    await expect(authoring.commitExactVersion({
      candidate: { ...makeDocument(), statements: [] },
      expectedVersion: baseVersion,
      validate: gateErrors(['Existing scene error must block changed writes']),
    })).rejects.toMatchObject({ code: 'gate_failed' });
    expect(store.version).toBe(baseVersion);
    expect(authoring.canUndo).toBe(false);
  });

  it('keeps queue serialization with human authoring transactions', async () => {
    const { store, coordinator, authoring } = makeServices();
    await coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    const baseVersion = store.version;
    const candidate: CurrentSceneDocument = {
      ...makeDocument(),
      statements: [
        { id: 'dlg_1', time: 0, type: 'dialogue', params: { speakerId: 'tomori', text: 'Agent', durationSeconds: 2 } },
      ],
    };

    const results = await Promise.allSettled([
      authoring.commitExactVersion({ candidate, expectedVersion: baseVersion, validate: () => [] }),
      authoring.author({
        version: 1,
        correlationId: 'human-1',
        intentType: 'update-statement',
        origin: 'editor-test',
        target: { statementId: 'dlg_1' },
        patch: { params: { text: 'Human' } },
      } as never),
    ]);
    // Exactly one of the two transactions may win at the exact base version;
    // the other either bumps into a conflict or serializes after a success.
    const committed = results.filter((result) => result.status === 'fulfilled');
    expect(committed.length).toBeGreaterThanOrEqual(1);
    const text = (store.getCurrentSceneDocumentSnapshot()?.statements[0]?.params as { text?: string })?.text;
    expect(['Human', 'Agent']).toContain(text);
  });
});

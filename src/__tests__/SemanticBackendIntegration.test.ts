import { describe, expect, it, vi } from 'vitest';
import {
  AUTHORING_SCHEMA_VERSION,
  type SemanticAuthorIntent,
} from '../api/types/authoring';
import {
  SCENE_SCHEMA_VERSION,
  SCENE_SCHEMA_VERSION_V4,
  type CurrentSceneDocument,
  type HistoricalSceneDocumentV4,
} from '../api/types/semantic-scene';
import type {
  CollaborativeAssetManifest,
  CollaborativeSceneStateV2,
  CollaborativeSceneStateV3,
} from '../api/types/collaboration';
import type {
  SemanticDocumentProjectionRuntimePort,
} from '../services/document/DocumentProjectionPorts';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { CollaborativeRemoteApplyPipelineV2 } from '../services/collaboration/CollaborativeRemoteApplyPipelineV2';
import {
  createCollaborativeSceneStateV2FromDocument,
} from '../services/collaboration/CollaborativeSceneStateV2';
import {
  createCollaborativeSceneStateV3FromDocument,
  materializeCollaborativeSceneDocumentV5,
} from '../services/collaboration/CollaborativeSceneStateV3';
import { CollaborativeDocumentLayerV2 } from '../services/collaboration/CollaborativeDocumentLayerV2';
import { CollaborativeDocumentLayerV3 } from '../services/collaboration/CollaborativeDocumentLayerV3';
import type { CollaborativeClientPortV2 } from '../services/collaboration/CollaborativeClientPortV2';
import type { CollaborativeClientPortV3 } from '../services/collaboration/CollaborativeClientPortV3';
import {
  getSceneDocumentCanonicalOrder,
  SemanticScenePipeline,
  sceneStatementCompiler,
} from '../services/semantic-scene';
import { preparedSceneToRuntimeTimelineScene } from '../engine/PreparedRuntimeScene';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { SemanticVisualCompositionAuthoringService } from '../services/visual-authoring/SemanticVisualCompositionAuthoringService';
import { SceneFileService } from '../services/io/SceneFileService';
import type { IFileAccess } from '../services/io/IFileAccess';
import {
  parseTemplatePackageManifest,
  templateAuthoringComboToSemanticIntent,
} from '../services/template-package';
import semanticManifest from '../templates/default/manifest.v2.json';
import { DocumentStore } from '../ui/store/DocumentStore';
import type { ResourceAuthoringService } from '../services/resource-authoring';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'semantic-scene',
    meta: {
      title: 'Semantic scene',
      durationSeconds: 5,
      characters: [{ id: 'alice', name: 'Alice', model: 'figure/alice.model3.json' }],
      markers: [{ markerId: 'lens-1', time: 2, label: 'Lens', role: 'lens-boundary' }],
    },
    visual: {
      visualTargets: {
        alice: { targetType: 'character' },
      },
      segments: {
        'segment:lens-1': {
          lensStyleBaseline: {
            grade: { recipeId: 'builtin:cinematic-cold' },
          },
        },
      },
    },
    statements: [
      {
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        params: {
          speakerId: 'alice',
          text: 'Hello',
          durationSeconds: 2,
          voice: 'vocal/hello.ogg',
        },
        companions: [{
          id: 'focus',
          anchor: 'start',
          offset: 0,
          type: 'camera',
          params: { mode: 'focus', target: '$speaker' },
        }],
      },
      {
        id: 'rim-1',
        time: 1,
        type: 'visualStyle',
        params: {
          scope: 'object',
          target: 'alice',
          slot: 'rim-light',
          mode: 'modulate',
          color: '#ffeecc',
          intensity: 0.8,
          thickness: 8,
          durationSeconds: 1,
        },
      },
    ],
  };
}

function makeV4Document(): HistoricalSceneDocumentV4 {
  return {
    ...makeDocument(),
    schemaVersion: SCENE_SCHEMA_VERSION_V4,
  };
}

function makeRuntime(): SemanticDocumentProjectionRuntimePort & {
  projectPreparedScene: ReturnType<typeof vi.fn<(scene: any) => Promise<void>>>;
} {
  return {
    projectPreparedScene: vi.fn(async (_scene: any) => undefined),
  };
}

function makeServices() {
  const store = new DocumentStore();
  const runtime = makeRuntime();
  const pipeline = new SemanticScenePipeline({
    resolveAsset: async (source) => `asset://localhost/C:/project/${source}`,
  });
  const coordinator = new SemanticDocumentCoordinator(store, pipeline, runtime);
  return { store, runtime, coordinator };
}

describe('semantic backend integration', () => {
  it('reads the dialogue flow mode for single writes and transactions', async () => {
    const { store, coordinator } = makeServices();
    const base = makeDocument();
    await coordinator.applyDocument({
      ...base,
      meta: { ...base.meta, durationSeconds: 15 },
      statements: [
        { id: 'first', type: 'dialogue', time: 0, params: { text: 'First', durationSeconds: 1 } },
        { id: 'last', type: 'dialogue', time: 6, params: { text: 'Last', durationSeconds: 1 } },
      ],
    });
    let mode: 'auto' | 'manual' = 'auto';
    const authoring = new SemanticAuthoringApplicationService(
      store, coordinator, undefined, undefined,
      { getDialogueFlowMode: () => mode },
    );
    await authoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'insert-auto', origin: 'timeline-editor', kind: 'insert-statement',
      anchorTime: 3,
      statement: { type: 'dialogue', params: { text: 'New', durationSeconds: 1 } },
    });
    expect(store.getCurrentSceneDocumentSnapshot()?.statements.find((item) => item.id === 'last')?.time).toBe(7.5);

    await authoring.authorTransaction([
      {
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: 'extend-auto', origin: 'timeline-editor', kind: 'update-statement',
        statementId: 'first', patch: { params: { text: 'First', durationSeconds: 2 } },
      },
      {
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: 'delete-auto', origin: 'timeline-editor', kind: 'delete-statements',
        statementIds: ['first'],
      },
    ]);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements.find((item) => item.id === 'last')?.time).toBe(6);

    mode = 'manual';
    await authoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'delete-manual', origin: 'timeline-editor', kind: 'delete-statements',
      statementIds: [store.getCurrentSceneDocumentSnapshot()!.statements.find((item) => item.type === 'dialogue' && item.id !== 'last')!.id],
      flow: true,
    });
    expect(store.getCurrentSceneDocumentSnapshot()?.statements.find((item) => item.id === 'last')?.time).toBe(6);
  });

  it('preserves AI and raw document timing while automatic flow is enabled', async () => {
    const { store, coordinator } = makeServices();
    const base = makeDocument();
    await coordinator.applyDocument({
      ...base,
      meta: { ...base.meta, durationSeconds: 15 },
      statements: [
        { id: 'first', type: 'dialogue', time: 0, params: { text: 'First', durationSeconds: 1 } },
        { id: 'last', type: 'dialogue', time: 6, params: { text: 'Last', durationSeconds: 1 } },
      ],
    });
    const authoring = new SemanticAuthoringApplicationService(
      store, coordinator, undefined, undefined,
      { getDialogueFlowMode: () => 'auto' },
    );
    await authoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'ai-time', origin: 'ai-script-panel', kind: 'insert-script-segment',
      anchorTime: 3,
      statements: [{ type: 'dialogue', params: { text: 'AI', durationSeconds: 1 } }],
    });
    expect(store.getCurrentSceneDocumentSnapshot()?.statements.find((item) => item.id === 'last')?.time).toBe(6);
    const raw = store.getCurrentSceneDocumentSnapshot()!;
    await authoring.replaceDocument({
      ...raw,
      statements: raw.statements.map((statement) => statement.id === 'last'
        ? { ...statement, time: 10 }
        : statement),
    });
    expect(store.getCurrentSceneDocumentSnapshot()?.statements.find((item) => item.id === 'last')?.time).toBe(10);
  });
  it('atomically prepares, projects, and stores a semantic scene bundle', async () => {
    const { store, runtime, coordinator } = makeServices();
    const bundle = await coordinator.applyDocument(makeDocument(), 'project/main.scene.json');

    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(bundle.source);
    expect(store.getPreparedSceneSnapshot()).toBe(bundle.prepared);
    expect(runtime.projectPreparedScene).toHaveBeenCalledWith(bundle.prepared);

    const runtimeScript = preparedSceneToRuntimeTimelineScene(bundle.prepared);
    expect(runtimeScript.sceneId).toBe(bundle.prepared.sceneId);
    expect(runtimeScript.timeline.map((action) => action.action)).toContain('dialogue');
    expect(runtimeScript.timeline.find((action) => action.action === 'dialogue')?.params.voice)
      .toBe('asset://localhost/C:/project/vocal/hello.ogg');

    const version = store.version;
    await expect(coordinator.applyDocument({ ...makeDocument(), schemaVersion: 1 as never })).rejects.toThrow();
    expect(store.version).toBe(version);
    expect(store.getPreparedSceneSnapshot()).toBe(bundle.prepared);
  });

  it('carries materialized collaborative statementOrder through the semantic coordinator', async () => {
    const { store, coordinator } = makeServices();
    const state = createCollaborativeSceneStateV3FromDocument(makeDocument(), {
      collaborationProjectId: 'project_1',
      roomId: 'project_1:main',
    });
    state.statementOrder = ['rim-1', 'dialogue-1'];
    const materialized = materializeCollaborativeSceneDocumentV5(state);

    await coordinator.applyDocument(materialized);

    expect(getSceneDocumentCanonicalOrder(store.getCurrentSceneDocumentSnapshot())).toEqual([
      'rim-1',
      'dialogue-1',
    ]);
  });

  it('loads and saves v2 source through SceneFileService without decompile', async () => {
    const { store, coordinator } = makeServices();
    const writes: Array<{ path: string; data: string }> = [];
    const fileAccess: IFileAccess = {
      readAsset: vi.fn(async () => ({ data: '', path: '' })),
      readFile: vi.fn(async (path: string) => ({ data: '', path })),
      showOpenDialog: vi.fn(async () => null),
      showSaveDialog: vi.fn(async () => null),
      writeFile: vi.fn(async (path: string, data: string) => { writes.push({ path, data }); }),
      ensureDir: vi.fn(async () => undefined),
      copyFile: vi.fn(async () => undefined),
      readDir: vi.fn(async () => []),
      exists: vi.fn(async () => true),
      join: vi.fn(async (...parts: string[]) => parts.join('/')),
      dirname: vi.fn(async () => 'project'),
      basename: vi.fn(async (path: string) => path.split('/').pop() ?? path),
      extname: vi.fn(async () => '.json'),
    };
    const service = new SceneFileService(
      fileAccess,
      store,
      { setFilePath: (path) => store._setFilePath(path) },
      { setSaveStatus: vi.fn() },
      coordinator,
    );
    const loaded = await service.loadCurrentSceneDocumentFromRawJson(
      JSON.stringify(makeDocument()),
      'project/main.scene.json',
    );
    expect(loaded.success).toBe(true);
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);
    await authoring.applyCharacterCommand({
      kind: 'set-character-model',
      origin: 'workspace-tools-panel',
      charId: 'alice',
      model: 'figure/alice-stage.model3.json',
    });
    expect((await service.save()).success).toBe(true);
    const saved = JSON.parse(writes[0].data);
    expect(saved.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
    expect(saved.statements).toHaveLength(2);
    expect(saved.meta.characters[0].model).toBe('figure/alice-stage.model3.json');
    expect(saved.timeline).toBeUndefined();
  });

  it('authors and deletes dialogue companions with semantic undo', async () => {
    const { store, coordinator } = makeServices();
    await coordinator.applyDocument(makeDocument());
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);

    await authoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'update-companion',
      origin: 'raw-script',
      kind: 'update-dialogue-companion',
      locator: { statementId: 'dialogue-1', companionId: 'focus' },
      patch: { offset: 0.5 },
    });
    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].companions?.[0].offset).toBe(0.5);

    const deleteIntent: SemanticAuthorIntent = {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'delete-companion',
      origin: 'raw-script',
      kind: 'delete-dialogue-companions',
      locators: [{ statementId: 'dialogue-1', companionId: 'focus' }],
    };
    const receipt = await authoring.author(deleteIntent);
    expect(receipt.deletedCompanionLocators).toEqual([
      { statementId: 'dialogue-1', companionId: 'focus' },
    ]);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].companions).toEqual([]);
    expect(await authoring.undo()).toBe(true);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].companions?.[0].id).toBe('focus');
  });

  it('rejects a queued document replacement when its expected version becomes stale', async () => {
    const { store, coordinator } = makeServices();
    await coordinator.applyDocument(makeDocument());
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);
    const expectedVersion = store.version;

    const precedingWrite = authoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'queued-update',
      origin: 'timeline-editor',
      kind: 'update-dialogue-companion',
      locator: { statementId: 'dialogue-1', companionId: 'focus' },
      patch: { offset: 0.5 },
    });
    const stalePreview = {
      ...makeDocument(),
      meta: { ...makeDocument().meta, title: 'Stale enhancement preview' },
    };
    const replacement = authoring.replaceDocument(stalePreview, true, expectedVersion);

    await precedingWrite;
    await expect(replacement).rejects.toThrow('version changed');
    expect(store.getCurrentSceneDocumentSnapshot()?.meta.title).toBe('Semantic scene');
    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].companions?.[0].offset).toBe(0.5);
  });

  it('materializes a selected resource and commits its semantic reference as one application operation', async () => {
    const { store, coordinator } = makeServices();
    await coordinator.applyDocument(makeDocument());
    const resourceAuthoring = {
      materializeCandidate: vi.fn(async () => ({
        reference: 'vocal/mygo/alice/hello.ogg',
        receipt: {
          input: 'mygo@alice:hello',
          key: { kind: 'voice', name: 'hello', ownerId: 'alice' },
          namespace: 'mygo',
          sourcePath: '/templates/mygo/assets/vocal/alice/hello.ogg',
          projectPath: 'vocal/mygo/alice/hello.ogg',
          operation: 'copied-template-resource',
          importKind: 'vocal',
        },
      })),
    } as unknown as ResourceAuthoringService;
    const authoring = new SemanticAuthoringApplicationService(
      store,
      coordinator,
      undefined,
      resourceAuthoring,
    );
    const receipt = await authoring.authorResource({
      selection: {
        input: 'mygo@alice:hello',
        candidate: {
          key: { kind: 'voice', name: 'hello', ownerId: 'alice' },
          namespace: 'mygo',
          portablePath: 'vocal/alice/hello.ogg',
          source: 'explicit',
        },
      },
      buildIntent: (reference) => ({
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: 'set-dialogue-voice',
        origin: 'timeline-editor',
        kind: 'update-statement',
        statementId: 'dialogue-1',
        patch: {
          params: {
            speakerId: 'alice',
            text: 'Hello',
            durationSeconds: 2,
            voice: reference,
          },
        },
      }),
    });
    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].params).toMatchObject({
      voice: 'vocal/mygo/alice/hello.ogg',
    });
    expect(receipt.materialization).toMatchObject({ namespace: 'mygo', operation: 'copied-template-resource' });
    expect(receipt.authoring.sideEffects).toContainEqual({
      type: 'resource-import',
      sourcePath: '/templates/mygo/assets/vocal/alice/hello.ogg',
      finalPath: 'vocal/mygo/alice/hello.ogg',
      importKind: 'vocal',
    });
  });

  it('reorders dialogue companions atomically and rejects incomplete orders', async () => {
    const { store, coordinator } = makeServices();
    const document = makeDocument();
    const dialogue = document.statements.find((statement) => statement.id === 'dialogue-1')!;
    dialogue.companions = [
      ...(dialogue.companions ?? []),
      {
        id: 'expression',
        anchor: 'start',
        offset: 0,
        type: 'characterPerformance',
        params: { target: '$speaker', expression: 'smile' },
      },
    ];
    await coordinator.applyDocument(document);
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);

    await authoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'reorder-companions',
      origin: 'timeline-editor',
      kind: 'reorder-dialogue-companions',
      parentStatementId: 'dialogue-1',
      orderedCompanionIds: ['expression', 'focus'],
    });
    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].companions?.map((companion) => companion.id))
      .toEqual(['expression', 'focus']);

    expect(await authoring.undo()).toBe(true);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].companions?.map((companion) => companion.id))
      .toEqual(['focus', 'expression']);

    await expect(authoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'invalid-reorder-companions',
      origin: 'timeline-editor',
      kind: 'reorder-dialogue-companions',
      parentStatementId: 'dialogue-1',
      orderedCompanionIds: ['focus'],
    })).rejects.toThrow('exactly once');
  });

  it('changes an attachable companion family with replacement params atomically', async () => {
    const { store, coordinator } = makeServices();
    await coordinator.applyDocument(makeDocument());
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);

    await authoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'change-companion-family',
      origin: 'timeline-editor',
      kind: 'update-dialogue-companion',
      locator: { statementId: 'dialogue-1', companionId: 'focus' },
      patch: {
        type: 'characterPerformance',
        params: { target: '$speaker', expression: 'smile' },
      },
    });
    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].companions?.[0]).toEqual(expect.objectContaining({
      id: 'focus',
      type: 'characterPerformance',
      params: { target: '$speaker', expression: 'smile' },
    }));
    expect(await authoring.undo()).toBe(true);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].companions?.[0].type).toBe('camera');

    await expect(authoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'invalid-companion-family',
      origin: 'timeline-editor',
      kind: 'update-dialogue-companion',
      locator: { statementId: 'dialogue-1', companionId: 'focus' },
      patch: { type: 'lighting', params: { effect: 'preset', mode: 'set', preset: 'day' } },
    })).rejects.toThrow('not attachable');
  });

  it('deletes a dialogue and its companions as one undoable source mutation', async () => {
    const { store, coordinator } = makeServices();
    await coordinator.applyDocument(makeDocument());
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);

    const receipt = await authoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'delete-dialogue-parent',
      origin: 'timeline-editor',
      kind: 'delete-statements',
      statementIds: ['dialogue-1'],
    });
    expect(receipt.deletedStatementIds).toEqual(['dialogue-1']);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements.some((statement) => statement.id === 'dialogue-1')).toBe(false);

    expect(await authoring.undo()).toBe(true);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements.find((statement) => statement.id === 'dialogue-1')?.companions)
      .toEqual([expect.objectContaining({ id: 'focus' })]);
  });

  it('preserves companion order when materializing collaboration v2 state', async () => {
    const { store, coordinator } = makeServices();
    const document = makeV4Document();
    document.statements[0].companions = [
      { id: 'expression', anchor: 'start', offset: 0, type: 'characterPerformance', params: { target: '$speaker', expression: 'smile' } },
      ...(document.statements[0].companions ?? []),
    ];
    const state = createCollaborativeSceneStateV2FromDocument(document, {
      collaborationProjectId: 'project-1',
      roomId: 'room-1',
    });
    const pipeline = new CollaborativeRemoteApplyPipelineV2({ coordinator });

    await pipeline.applyWithPreparation(state);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].companions?.map((companion) => companion.id))
      .toEqual(['expression', 'focus']);
  });

  it('commits multi-intent authoring as one history transaction', async () => {
    const { store, coordinator } = makeServices();
    await coordinator.applyDocument(makeDocument());
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);

    const receipt = await authoring.authorTransaction([
      {
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: 'transaction-update',
        origin: 'timeline-editor',
        kind: 'update-dialogue-companion',
        locator: { statementId: 'dialogue-1', companionId: 'focus' },
        patch: { offset: 0.75 },
      },
      {
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: 'transaction-insert',
        origin: 'timeline-editor',
        kind: 'insert-statement',
        anchorTime: 3,
        statement: {
          type: 'dialogue',
          params: { speakerId: 'alice', text: 'Next', durationSeconds: 1 },
        },
      },
    ]);

    expect(receipt.historyDescriptor.key).toBe('timeline.author.transaction');
    expect(receipt.createdStatementIds).toHaveLength(1);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements).toHaveLength(3);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].companions?.[0].offset).toBe(0.75);

    expect(await authoring.undo()).toBe(true);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements).toHaveLength(2);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].companions?.[0].offset).toBe(0);
  });

  it('does not partially commit a failed authoring transaction', async () => {
    const { store, coordinator } = makeServices();
    await coordinator.applyDocument(makeDocument());
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);

    await expect(authoring.authorTransaction([
      {
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: 'transaction-valid',
        origin: 'timeline-editor',
        kind: 'update-dialogue-companion',
        locator: { statementId: 'dialogue-1', companionId: 'focus' },
        patch: { offset: 0.75 },
      },
      {
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: 'transaction-invalid',
        origin: 'timeline-editor',
        kind: 'update-dialogue-companion',
        locator: { statementId: 'dialogue-1', companionId: 'missing' },
        patch: { offset: 1 },
      },
    ])).rejects.toThrow('Companion not found');

    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].companions?.[0].offset).toBe(0);
  });

  it('rolls back the scene and history when a composite side effect fails', async () => {
    const { store, coordinator } = makeServices();
    await coordinator.applyDocument(makeDocument());
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);
    const before = store.getCurrentSceneDocumentSnapshot();
    const next = { ...before!, meta: { ...before!.meta, title: 'Should roll back' } };

    await expect(authoring.replaceDocumentWithSideEffect(
      next,
      async () => {
        throw new Error('archive failed');
      },
    )).rejects.toThrow('archive failed');

    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(before);
    expect(authoring.canUndo).toBe(false);
    expect(authoring.canRedo).toBe(false);
  });

  it('lowers semantic rim light statements to the runtime resolver action', () => {
    const compiled = sceneStatementCompiler.compile(makeDocument());
    expect(compiled.actions.find((action) => action.source.statementId === 'rim-1')).toMatchObject({
      action: 'setCharacterRimLight',
      params: {
        id: 'alice',
        mode: 'modulate',
        color: '#ffeecc',
        intensity: 0.8,
        thickness: 8,
      },
      source: { outputKey: 'rim-light' },
    });
  });

  it('applies collaboration v2 state through the semantic pipeline', async () => {
    const { store, coordinator } = makeServices();
    const state = createCollaborativeSceneStateV2FromDocument(makeV4Document(), {
      collaborationProjectId: 'project-1',
      roomId: 'room-1',
    });
    state.meta.title = 'Remote title';
    const pipeline = new CollaborativeRemoteApplyPipelineV2({ coordinator });
    await pipeline.applyWithPreparation(state);
    expect(store.getCurrentSceneDocumentSnapshot()?.meta.title).toBe('Remote title');
  });

  it('applies joined collaboration state to the project default scene path for local saves', async () => {
    const { store, coordinator } = makeServices();
    const state = createCollaborativeSceneStateV2FromDocument(makeV4Document(), {
      collaborationProjectId: 'project-1',
      roomId: 'room-1',
    });
    state.meta.title = 'Joined main scene';
    const writes: Array<{ path: string | undefined; title: string | undefined }> = [];
    const pipeline = new CollaborativeRemoteApplyPipelineV2({
      coordinator,
      getApplyScenePath: () => 'D:/project/project/main.scene.json',
      afterApplyState: async (_state, document, path) => {
        writes.push({ path, title: document.meta.title });
      },
    });

    await pipeline.applyWithPreparation(state);

    expect(store.filePath).toBe('D:/project/project/main.scene.json');
    expect(store.filePath).not.toContain('collaboration-sessions');
    expect(writes).toEqual([{ path: 'D:/project/project/main.scene.json', title: 'Joined main scene' }]);
  });

  it('joins a collaboration v2 layer and applies the initial remote document', async () => {
    const { store, coordinator } = makeServices();
    const state = createCollaborativeSceneStateV2FromDocument(makeV4Document(), {
      collaborationProjectId: 'project-1',
      roomId: 'room-1',
    });
    state.meta.title = 'Joined title';
    const stateListeners = new Set<(next: typeof state | null) => void>();
    const connectionListeners = new Set<(connected: boolean) => void>();
    const prepareLocalState = vi.fn();
    const client: CollaborativeClientPortV2 = {
      join: vi.fn(async () => state),
      seed: vi.fn(async () => undefined),
      getState: vi.fn(() => state),
      publishState: vi.fn(async () => undefined),
      subscribe: (listener) => {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      subscribeRealtimeConnection: (listener) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
      connectRealtime: async () => connectionListeners.forEach((listener) => listener(true)),
      isRealtimeConnected: () => true,
    };
    const layer = new CollaborativeDocumentLayerV2({
      documentStore: store,
      coordinator,
      client,
      collaborationProjectId: 'project-1',
      roomId: 'room-1',
      prepareLocalState,
    });
    await layer.connect();
    expect(layer.getStatus()).toBe('connected');
    expect(store.getCurrentSceneDocumentSnapshot()?.meta.title).toBe('Joined title');
    expect(prepareLocalState).not.toHaveBeenCalled();
    expect(client.publishState).not.toHaveBeenCalled();
    layer.dispose();
  });

  it('does not require server scene agreement for subsequent remote script edits', async () => {
    const { store, coordinator } = makeServices();
    const state = createCollaborativeSceneStateV2FromDocument(makeV4Document(), {
      collaborationProjectId: 'project-1',
      roomId: 'room-1',
    });
    const stateListeners = new Set<(next: typeof state | null) => void>();
    const connectionListeners = new Set<(connected: boolean) => void>();
    const beforeApplyState = vi.fn(async (..._args: unknown[]) => undefined);
    const client: CollaborativeClientPortV2 = {
      join: vi.fn(async () => state),
      seed: vi.fn(async () => undefined),
      getState: vi.fn(() => state),
      publishState: vi.fn(async () => undefined),
      subscribe: (listener) => {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      subscribeRealtimeConnection: (listener) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
      connectRealtime: async () => connectionListeners.forEach((listener) => listener(true)),
      isRealtimeConnected: () => true,
    };
    const layer = new CollaborativeDocumentLayerV2({
      documentStore: store,
      coordinator,
      client,
      collaborationProjectId: 'project-1',
      roomId: 'room-1',
      beforeApplyState,
    });

    await layer.connect();
    state.meta.title = 'Edited dialogue timing';
    stateListeners.forEach((listener) => listener(state));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(beforeApplyState).toHaveBeenCalledTimes(2);
    expect(beforeApplyState.mock.calls[0]?.[1]).toMatchObject({ requireServerSceneAgreement: true });
    expect(beforeApplyState.mock.calls[1]?.[1]).toMatchObject({ requireServerSceneAgreement: false });
    layer.dispose();
  });

  it('seeds collaboration without treating the seed echo as a server scene join', async () => {
    const { store, coordinator } = makeServices();
    const localDocument = makeDocument();
    localDocument.meta.title = 'Local hosted title';
    await coordinator.applyDocument(localDocument);
    const hostedAssets: CollaborativeAssetManifest = {
      'figure/alice.model3.json': {
        assetId: 'asset-alice',
        kind: 'live2d-bundle',
        importKind: 'figure',
        projectRelativePath: 'figure/alice.model3.json',
        entrypointPath: 'figure/alice.model3.json',
        contentHash: 'hash-alice',
        files: [{
          relativePath: 'figure/alice.model3.json',
          contentHash: 'hash-alice',
          sizeBytes: 123,
        }],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };

    let currentState: CollaborativeSceneStateV3 | null = null;
    const stateListeners = new Set<(next: CollaborativeSceneStateV3 | null) => void>();
    const connectionListeners = new Set<(connected: boolean) => void>();
    const beforeApplyState = vi.fn(async (..._args: unknown[]) => undefined);
    const client: CollaborativeClientPortV3 = {
      join: vi.fn(async () => null),
      seed: vi.fn(async (state) => {
        currentState = state;
        stateListeners.forEach((listener) => listener(state));
      }),
      getState: vi.fn(() => currentState),
      publishState: vi.fn(async () => undefined),
      subscribe: (listener) => {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      subscribeRealtimeConnection: (listener) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
      connectRealtime: async () => connectionListeners.forEach((listener) => listener(true)),
      isRealtimeConnected: () => true,
    };
    const layer = new CollaborativeDocumentLayerV3({
      documentStore: store,
      coordinator,
      client,
      collaborationProjectId: 'project-1',
      roomId: 'room-1',
      beforeApplyState,
      prepareSeedState: async (document) => ({ document, assets: hostedAssets }),
    });

    await layer.connect();

    expect(client.seed).toHaveBeenCalledOnce();
    expect(beforeApplyState).toHaveBeenCalledTimes(1);
    const [, seedApplyOptions] = beforeApplyState.mock.calls[0] as unknown as [
      CollaborativeSceneStateV3,
      { prepareAssets: boolean; requireServerSceneAgreement: boolean },
    ];
    expect(seedApplyOptions).toMatchObject({
      prepareAssets: false,
      requireServerSceneAgreement: false,
    });
    expect(store.getCurrentSceneDocumentSnapshot()?.meta.title).toBe('Local hosted title');
    layer.dispose();
  });

  it('joins existing host collaboration instead of force-seeding stale server state', async () => {
    const { store, coordinator } = makeServices();
    const localDocument = makeDocument();
    localDocument.meta.title = 'Explicit host title';
    await coordinator.applyDocument(localDocument);

    const remoteDocument = makeV4Document();
    remoteDocument.meta.title = 'Stale server title';
    const remoteState = createCollaborativeSceneStateV2FromDocument(remoteDocument, {
      collaborationProjectId: 'project-1',
      roomId: 'room-1',
    });
    let currentState: CollaborativeSceneStateV2 | null = remoteState;
    const stateListeners = new Set<(next: CollaborativeSceneStateV2 | null) => void>();
    const connectionListeners = new Set<(connected: boolean) => void>();
    const beforeApplyState = vi.fn(async () => undefined);
    const client: CollaborativeClientPortV2 = {
      join: vi.fn(async () => remoteState),
      seed: vi.fn(async (state) => {
        currentState = state;
        stateListeners.forEach((listener) => listener(state));
      }),
      getState: vi.fn(() => currentState),
      publishState: vi.fn(async () => undefined),
      subscribe: (listener) => {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      subscribeRealtimeConnection: (listener) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
      connectRealtime: async () => connectionListeners.forEach((listener) => listener(true)),
      isRealtimeConnected: () => true,
    };
    const layer = new CollaborativeDocumentLayerV2({
      documentStore: store,
      coordinator,
      client,
      collaborationProjectId: 'project-1',
      roomId: 'room-1',
      beforeApplyState,
    });

    await layer.connect();

    expect(client.join).toHaveBeenCalledOnce();
    expect(client.seed).not.toHaveBeenCalled();
    expect(beforeApplyState).toHaveBeenCalledTimes(1);
    const [, hostApplyOptions] = beforeApplyState.mock.calls[0] as unknown as [
      CollaborativeSceneStateV2,
      { requireServerSceneAgreement: boolean },
    ];
    expect(hostApplyOptions).toMatchObject({ requireServerSceneAgreement: true });
    expect(store.getCurrentSceneDocumentSnapshot()?.meta.title).toBe('Stale server title');

    stateListeners.forEach((listener) => listener(currentState));
    await Promise.resolve();
    await Promise.resolve();

    expect(beforeApplyState).toHaveBeenCalledTimes(1);
    layer.dispose();
  });

  it('materializes visual composition changes as semantic statements', async () => {
    const { store, coordinator } = makeServices();
    await coordinator.applyDocument(makeDocument());
    const application = new SemanticAuthoringApplicationService(store, coordinator);
    const composition = new SemanticVisualCompositionAuthoringService(application);
    const receipt = await composition.removeLensBoundaryMarkerAndRelatedSegments(
      'lens-1',
    );
    expect(receipt.createdStatementIds).toHaveLength(2);
    expect(store.getCurrentSceneDocumentSnapshot()?.meta.markers).toEqual([]);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'filterReset' }),
      expect.objectContaining({
        type: 'filterAdd',
        params: expect.objectContaining({ recipeId: 'builtin:cinematic-cold' }),
      }),
    ]));
  });

  it('loads the builtin v2 template and resolves character scope placeholders', () => {
    const manifest = parseTemplatePackageManifest(semanticManifest);
    const combo = manifest.authoringCombos?.find((candidate) => candidate.id === 'char_one_click_enter');
    const intent = templateAuthoringComboToSemanticIntent(combo!, {
      anchorTime: 1,
      correlationId: 'template-1',
      scope: { kind: 'character', charId: 'alice' },
    });
    expect(intent).toMatchObject({
      version: AUTHORING_SCHEMA_VERSION,
      kind: 'insert-script-segment',
      statements: [
        expect.objectContaining({
          type: 'characterPresence',
          params: expect.objectContaining({ id: 'alice' }),
        }),
        expect.objectContaining({
          type: 'visualStyle',
          params: expect.objectContaining({ slot: 'integration', target: 'alice' }),
        }),
        expect.objectContaining({
          type: 'visualStyle',
          params: expect.objectContaining({ slot: 'rim-light', target: 'alice' }),
        }),
      ],
    });

    const dialogueCombo = manifest.authoringCombos?.find((candidate) => candidate.id === 'dialogue_push');
    const dialogueIntent = templateAuthoringComboToSemanticIntent(dialogueCombo!, {
      anchorTime: 2,
      correlationId: 'template-2',
      scope: { kind: 'inferred-character', charId: 'bob', source: 'blank-menu-track' },
    });
    expect(dialogueIntent).toMatchObject({
      version: AUTHORING_SCHEMA_VERSION,
      kind: 'insert-statement',
      statement: expect.objectContaining({
        type: 'dialogue',
        params: expect.objectContaining({ speakerId: 'bob', speaker: 'bob' }),
        companions: [
          expect.objectContaining({
            type: 'characterPerformance',
            params: expect.objectContaining({ target: 'bob' }),
          }),
        ],
      }),
    });
  });
});

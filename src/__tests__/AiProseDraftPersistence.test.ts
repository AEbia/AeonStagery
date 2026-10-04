import { describe, expect, it, vi } from 'vitest';
import {
  applyDraft,
  createDraft,
  replaceEnhancementState,
  replaceSegmentation,
  setCharacterBindingPlan,
} from '../services/ai-authoring/AiProseDraftSession';
import {
  AiProseDraftPersistence,
  type AiProseDraftFileAccess,
  type AiProseDraftProject,
} from '../services/ai-authoring/AiProseDraftPersistence';
import type { SemanticAuthorReceipt } from '../api/types/authoring';
import type { ElectronCapability } from '../api/interfaces/ElectronCapability';
import { ElectronFileAccess } from '../services/io/ElectronFileAccess';

describe('AiProseDraftPersistence', () => {
  it('saves an explicit checkpoint below the project asset root', async () => {
    const fileAccess: AiProseDraftFileAccess = {
      exists: vi.fn(async () => false),
      readFile: vi.fn(),
      writeFile: vi.fn(async () => undefined),
      replaceFile: vi.fn(async () => undefined),
      ensureDir: vi.fn(async () => undefined),
      join: vi.fn(async (...parts: string[]) => parts.join('/')),
      dirname: vi.fn((path: string) => path.split('/').slice(0, -1).join('/')),
    };
    const project: AiProseDraftProject = {
      projectRoot: '/projects/demo',
      assetRoots: { project: 'project-assets' },
    };
    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'session-1',
      sourceText: '正文',
      anchorMode: 'zero',
    });
    const persistence = new AiProseDraftPersistence(fileAccess);

    await persistence.saveCheckpoint(project, draft);

    expect(fileAccess.join).toHaveBeenCalledWith(
      '/projects/demo',
      'project-assets',
      'ai-authoring',
      'scene-1',
      'session-1.json',
    );
    expect(fileAccess.ensureDir).toHaveBeenCalledWith(
      '/projects/demo/project-assets/ai-authoring/scene-1',
    );
    expect(fileAccess.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/session-1\.json\.tmp-/),
      expect.stringContaining('"schemaVersion": 3'),
    );
    expect(fileAccess.replaceFile).toHaveBeenCalledWith(
      expect.stringMatching(/session-1\.json\.tmp-/),
      '/projects/demo/project-assets/ai-authoring/scene-1/session-1.json',
    );
    expect(fileAccess.writeFile).not.toHaveBeenCalledWith(expect.stringContaining('mount'), expect.anything());
  });

  it('preserves the Electron file access receiver during atomic replacement', async () => {
    const capability = {
      fs: {
        writeTextFile: vi.fn(async () => ({ success: true })),
        replaceFile: vi.fn(async () => ({ success: true })),
        ensureDir: vi.fn(async () => ({ success: true })),
      },
      path: {
        join: vi.fn(async (...parts: string[]) => parts.join('/')),
        dirname: vi.fn(async (path: string) => path.split('/').slice(0, -1).join('/')),
      },
    } as unknown as ElectronCapability;
    const persistence = new AiProseDraftPersistence(new ElectronFileAccess(capability));
    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'electron-context',
      sourceText: '正文',
      anchorMode: 'zero',
    });

    await persistence.saveCheckpoint(projectContext(), draft);

    expect(capability.fs.replaceFile).toHaveBeenCalledWith(
      expect.stringMatching(/electron-context\.json\.tmp-/),
      '/projects/demo/project-assets/ai-authoring/scene-1/electron-context.json',
    );
  });

  it('distinguishes a missing draft without reading or writing it', async () => {
    const fileAccess = createFileAccess(undefined, false);
    const persistence = new AiProseDraftPersistence(fileAccess);

    const result = await persistence.loadResult(projectContext(), 'scene-1', 'missing');

    expect(result.status).toBe('missing');
    expect(result.kind).toBe('missing');
    expect(fileAccess.readFile).not.toHaveBeenCalled();
    expect(fileAccess.writeFile).not.toHaveBeenCalled();
  });

  it('reports corrupt JSON and preserves the original file', async () => {
    const fileAccess = createFileAccess('{"schemaVersion":', true);
    const persistence = new AiProseDraftPersistence(fileAccess);

    const result = await persistence.loadResult(projectContext(), 'scene-1', 'corrupt');

    expect(result.status).toBe('corrupt-json');
    if (result.status === 'loaded') throw new Error('expected corrupt JSON result');
    expect(result.error.code).toBe('corrupt-json');
    expect(fileAccess.writeFile).not.toHaveBeenCalled();
  });

  it('reports invalid structure separately from corrupt JSON', async () => {
    const fileAccess = createFileAccess(JSON.stringify({ schemaVersion: 2 }), true);
    const persistence = new AiProseDraftPersistence(fileAccess);

    const result = await persistence.loadResult(projectContext(), 'scene-1', 'invalid');

    expect(result.status).toBe('invalid-structure');
    if (result.status === 'loaded') throw new Error('expected invalid structure result');
    expect(result.error.code).toBe('invalid-structure');
    expect(fileAccess.writeFile).not.toHaveBeenCalled();
  });

  it('reports future schema files without downgrading or writing them back', async () => {
    const fileAccess = createFileAccess(JSON.stringify({ schemaVersion: 99 }), true);
    const persistence = new AiProseDraftPersistence(fileAccess);

    const result = await persistence.loadResult(projectContext(), 'scene-1', 'future');

    expect(result.status).toBe('future-schema');
    if (result.status === 'loaded') throw new Error('expected future schema result');
    expect(result.error.code).toBe('future-schema');
    expect(fileAccess.writeFile).not.toHaveBeenCalled();
  });

  it('loads migrated drafts with successful stages intact and does not auto-save them', async () => {
    const source = createDraft({
      sceneId: 'scene-1',
      sessionId: 'restored',
      sourceText: '正文',
      anchorMode: 'zero',
    });
    const completed = replaceSegmentation(source, {
      status: 'succeeded',
      planFingerprint: 'legacy-plan',
      targetSegmentCount: 1,
      candidates: [],
      boundaryIds: [],
      segments: [],
    });
    const legacy = {
      ...completed,
      schemaVersion: 0,
      sourceRevision: undefined,
      mainCharacters: [],
      confirmedMainCharacters: undefined,
      characterBindings: undefined,
    };
    const raw = JSON.stringify(legacy, (_key, value) => value === undefined ? undefined : value);
    const fileAccess = createFileAccess(raw, true);
    const persistence = new AiProseDraftPersistence(fileAccess);

    const result = await persistence.loadResult(projectContext(), 'scene-1', 'restored');

    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') throw new Error('expected a loaded draft');
    expect(result.migratedFrom).toBe(0);
    expect(result.draft.schemaVersion).toBe(3);
    expect(result.draft.scriptReadingSpeed).toBe(9);
    expect(result.draft.segmentation.status).toBe('succeeded');
    expect(fileAccess.writeFile).not.toHaveBeenCalled();
  });

  it('round-trips a draft with persisted binding plan and enhancement checkpoint state', async () => {
    const fileAccess: AiProseDraftFileAccess = {
      exists: vi.fn(async () => false),
      readFile: vi.fn(),
      writeFile: vi.fn(async () => undefined),
      replaceFile: vi.fn(async () => undefined),
      ensureDir: vi.fn(async () => undefined),
      join: vi.fn(async (...parts: string[]) => parts.join('/')),
      dirname: vi.fn((path: string) => path.split('/').slice(0, -1).join('/')),
    };
    const project: AiProseDraftProject = {
      projectRoot: '/projects/demo',
      assetRoots: { project: 'project-assets' },
    };
    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'enhance-roundtrip',
      sourceText: '正文',
      anchorMode: 'zero',
    });
    const withPlan = setCharacterBindingPlan(draft, {
      status: 'ready',
      bindings: {
        素世: { name: '素世', speakerId: 'soyo', source: 'existing_unique' },
      },
      preallocatedCharacterIds: [],
    });
    const withEnhancement = replaceEnhancementState(withPlan, {
      version: 1,
      baseFingerprint: 'fp-1',
      performance: {
        stage: 'performance',
        status: 'succeeded',
        units: [{
          key: 'seg-0',
          stage: 'performance',
          status: 'succeeded',
          attemptCount: 2,
          policyVersion: 'performance-stage-policy/v1',
          processorVersion: 'performance-processor/v1',
          inputFingerprint: 'unit-fp',
          patch: { version: 1, operations: [] },
          modelName: 'gpt-4o-mini',
          usage: { inputTokens: 10, outputTokens: 20 },
        }],
      },
    });
    const persistence = new AiProseDraftPersistence(fileAccess);
    await persistence.saveCheckpoint(project, withEnhancement);

    const serialized = vi.mocked(fileAccess.writeFile).mock.calls[0]?.[1];
    expect(serialized).toContain('"characterBindingPlan"');
    expect(serialized).toContain('"enhancement"');
    expect(serialized).toContain('"schemaVersion": 3');

    // Reload through the same seam (memory-backed storage).
    const restoredAccess = {
      ...fileAccess,
      exists: vi.fn(async () => true),
      readFile: vi.fn(async () => ({ data: serialized!, path: 'draft.json' })),
    };
    const persistence2 = new AiProseDraftPersistence(restoredAccess);
    const result = await persistence2.loadResult(project, 'scene-1', 'enhance-roundtrip');
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') throw new Error('expected a loaded draft');
    expect(result.draft.characterBindingPlan).toEqual(withPlan.characterBindingPlan);
    expect(result.draft.enhancement).toEqual(withEnhancement.enhancement);
    expect(result.draft.enhancement?.performance?.units[0]?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
    });
  });

  it('deletes an applied archive explicitly through the file seam', async () => {
    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'archive-del',
      sourceText: '正文',
      anchorMode: 'zero',
    });
    const applied = applyDraft(draft, makeReceipt(), { appliedAt: '2026-08-03T00:00:00.000Z' });
    const fileAccess = createFileAccess(undefined, true, true);
    fileAccess.removeFile = vi.fn(async () => undefined);
    const persistence = new AiProseDraftPersistence(fileAccess);

    await persistence.archiveApplied(projectContext(), applied);
    await persistence.deleteDraft(projectContext(), 'scene-1', 'archive-del');
    expect(fileAccess.removeFile).toHaveBeenCalledTimes(1);
    expect(fileAccess.removeFile).toHaveBeenCalledWith(
      expect.stringContaining('archive-del.json'),
    );
  });

  it('rejects deletion when the file seam lacks removeFile', async () => {
    const persistence = new AiProseDraftPersistence(createFileAccess(undefined, true, true));
    await expect(persistence.deleteDraft(projectContext(), 'scene-1', 'no-seam'))
      .rejects.toMatchObject({ code: 'delete-unavailable' });
  });

  it('rejects deletion of a missing draft file', async () => {
    const fileAccess = createFileAccess(undefined, false, true);
    fileAccess.removeFile = vi.fn(async () => undefined);
    const persistence = new AiProseDraftPersistence(fileAccess);
    await expect(persistence.deleteDraft(projectContext(), 'scene-1', 'ghost'))
      .rejects.toMatchObject({ code: 'missing' });
    expect(fileAccess.removeFile).not.toHaveBeenCalled();
  });

  it('archives applied drafts explicitly and does not allow checkpoint overwrite', async () => {    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'archive',
      sourceText: '正文',
      anchorMode: 'zero',
    });
    const applied = applyDraft(draft, makeReceipt(), { appliedAt: '2026-08-03T00:00:00.000Z' });
    const fileAccess = createFileAccess(undefined, false);
    const persistence = new AiProseDraftPersistence(fileAccess);

    await persistence.archiveApplied(projectContext(), applied);
    expect(fileAccess.writeFile).toHaveBeenCalledTimes(1);
    await expect(persistence.saveCheckpoint(projectContext(), applied)).rejects.toMatchObject({ code: 'read-only' });
  });

  it('fails explicitly instead of overwriting the formal file without an atomic replace seam', async () => {
    const fileAccess = createFileAccess(undefined, false, false);
    const persistence = new AiProseDraftPersistence(fileAccess);
    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'no-atomic',
      sourceText: '正文',
      anchorMode: 'zero',
    });

    await expect(persistence.saveCheckpoint(projectContext(), draft))
      .rejects.toMatchObject({ code: 'atomic-write-unavailable' });
    expect(fileAccess.writeFile).not.toHaveBeenCalled();
  });

  it('rejects traversal and mount-like path segments', async () => {
    const persistence = new AiProseDraftPersistence(createFileAccess(undefined, false));

    await expect(persistence.resolvePath(projectContext(), '../scene', 'session-1')).rejects.toThrow(/safe single path segment/);
    await expect(persistence.resolvePath(projectContext(), 'scene-1', '@mount-1')).rejects.toThrow(/safe single path segment/);
    await expect(persistence.resolvePath({
      projectRoot: '/projects/demo',
      assetRoots: { project: '@mount/library' },
    }, 'scene-1', 'session-1')).rejects.toMatchObject({ code: 'invalid-path' });
  });
});

function projectContext(): AiProseDraftProject {
  return {
    projectRoot: '/projects/demo',
    assetRoots: { project: 'project-assets' },
  };
}

function createFileAccess(
  raw: string | Error | undefined,
  present: boolean,
  atomic = true,
): AiProseDraftFileAccess {
  return {
    exists: vi.fn(async () => present),
    readFile: vi.fn(async () => {
      if (raw instanceof Error) throw raw;
      return { data: raw ?? '', path: '/projects/demo/project-assets/ai-authoring/scene-1/draft.json' };
    }),
    writeFile: vi.fn(async () => undefined),
    ...(atomic ? { replaceFile: vi.fn(async () => undefined) } : {}),
    ensureDir: vi.fn(async () => undefined),
    join: vi.fn(async (...parts: string[]) => parts.join('/')),
    dirname: vi.fn((path: string) => path.split('/').slice(0, -1).join('/')),
  };
}

function makeReceipt(): SemanticAuthorReceipt {
  return {
    version: 3,
    correlationId: 'receipt-1',
    intentType: 'insert-script-segment',
    origin: 'ai-script-panel',
    historyDescriptor: { key: 'ai.prose.applied', args: {}, fallbackLabel: 'AI prose applied' },
    warnings: [],
    resolvedScope: { kind: 'none' },
    createdStatementIds: [],
    updatedStatementIds: [],
    deletedStatementIds: [],
    createdCompanionLocators: [],
    updatedCompanionLocators: [],
    deletedCompanionLocators: [],
    createdMarkerIds: [],
    deletedMarkerIds: [],
    createdMarkers: [],
    deletedMarkers: [],
    sideEffects: [],
  };
}

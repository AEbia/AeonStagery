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
  it('replaces the single scene draft and restores it without a session pointer', async () => {
    const files = new Map<string, string>();
    const fileAccess = memoryDraftFiles(files);
    const persistence = new AiProseDraftPersistence(fileAccess);
    const first = createDraft({ sceneId: 'scene-1', sessionId: 'first', sourceText: '第一份', anchorMode: 'zero' });
    const second = createDraft({ sceneId: 'scene-1', sessionId: 'second', sourceText: '第二份', anchorMode: 'zero' });
    await persistence.saveCheckpoint(projectContext(), first);
    await persistence.saveCheckpoint(projectContext(), second);

    expect([...files.keys()]).toEqual(['/projects/demo/project-assets/ai-authoring/scene-1/current.json']);
    const restored = await persistence.loadResult(projectContext(), 'scene-1');
    expect(restored.status).toBe('loaded');
    if (restored.status === 'loaded') expect(restored.draft).toEqual(second);
  });

  it('migrates the last legacy session and removes superseded drafts after saving it', async () => {
    const folder = '/projects/demo/project-assets/ai-authoring/scene-1';
    const first = createDraft({ sceneId: 'scene-1', sessionId: 'first', sourceText: '第一份', anchorMode: 'zero' });
    const second = createDraft({ sceneId: 'scene-1', sessionId: 'second', sourceText: '第二份', anchorMode: 'zero' });
    const files = new Map([[`${folder}/first.json`, JSON.stringify(first)], [`${folder}/second.json`, JSON.stringify(second)]]);
    const persistence = new AiProseDraftPersistence(memoryDraftFiles(files));

    const restored = await persistence.loadResult(projectContext(), 'scene-1', 'second');

    expect(restored.status).toBe('loaded');
    if (restored.status === 'loaded') expect(restored.draft.sessionId).toBe('second');
    expect([...files.keys()]).toEqual([`${folder}/current.json`]);
  });

  it('cleans up temporary files when atomic replacement fails', async () => {
    const files = new Map<string, string>();
    const fileAccess = memoryDraftFiles(files);
    fileAccess.replaceFile = async () => { throw new Error('disk full'); };
    const persistence = new AiProseDraftPersistence(fileAccess);
    const draft = createDraft({ sceneId: 'scene-1', sourceText: '正文', anchorMode: 'zero' });

    await expect(persistence.saveCheckpoint(projectContext(), draft)).rejects.toThrow();
    expect(files.size).toBe(0);
  });

  it('restores the latest legacy file without a pointer and removes stale temporary files', async () => {
    const folder = '/projects/demo/project-assets/ai-authoring/scene-1';
    const first = createDraft({ sceneId: 'scene-1', sessionId: 'first', sourceText: '旧正文', anchorMode: 'zero', now: '2026-01-01T00:00:00Z' });
    const second = createDraft({ sceneId: 'scene-1', sessionId: 'second', sourceText: '新正文', anchorMode: 'zero', now: '2026-02-01T00:00:00Z' });
    const files = new Map([[`${folder}/first.json`, JSON.stringify(first)], [`${folder}/second.json`, JSON.stringify(second)], [`${folder}/first.json.tmp-abandoned`, '{']]);
    const persistence = new AiProseDraftPersistence(memoryDraftFiles(files));
    const result = await persistence.loadResult(projectContext(), 'scene-1');
    if (result.status !== 'loaded') throw new Error(result.status);
    expect(result.draft).toEqual(second);
    expect([...files.keys()]).toEqual([`${folder}/current.json`]);
  });

  it('preserves every legacy file when promoting the selected draft fails', async () => {
    const folder = '/projects/demo/project-assets/ai-authoring/scene-1';
    const draft = createDraft({ sceneId: 'scene-1', sessionId: 'legacy', sourceText: '正文', anchorMode: 'zero' });
    const files = new Map([[`${folder}/legacy.json`, JSON.stringify(draft)]]);
    const fileAccess = memoryDraftFiles(files);
    fileAccess.replaceFile = async () => { throw new Error('disk full'); };
    const persistence = new AiProseDraftPersistence(fileAccess);
    await expect(persistence.loadResult(projectContext(), 'scene-1', 'legacy')).rejects.toThrow();
    expect([...files.keys()]).toEqual([`${folder}/legacy.json`]);
  });

  it('waits for a pending write before restoring the scene draft', async () => {
    const files = new Map<string, string>();
    const fileAccess = memoryDraftFiles(files);
    const replace = fileAccess.replaceFile!;
    let release: () => void = () => {};
    let markWriting: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { markWriting = resolve; });
    fileAccess.replaceFile = async (...args) => { markWriting(); await gate; await replace(...args); };
    const persistence = new AiProseDraftPersistence(fileAccess);
    const draft = createDraft({ sceneId: 'scene-1', sourceText: '关闭时保存的正文', anchorMode: 'zero' });
    const saving = persistence.saveCheckpoint(projectContext(), draft);
    await writing;
    let loaded = false;
    const loading = persistence.loadResult(projectContext(), 'scene-1').then((result) => { loaded = true; return result; });
    try {
      await Promise.resolve();
      expect(loaded).toBe(false);
    } finally {
      release();
    }
    await saving;
    const result = await loading;
    if (result.status !== 'loaded') throw new Error(result.status);
    expect(result.draft).toEqual(draft);
  });

  it('does not delete legacy drafts when one of the files is corrupt', async () => {
    const folder = '/projects/demo/project-assets/ai-authoring/scene-1';
    const draft = createDraft({ sceneId: 'scene-1', sessionId: 'legacy', sourceText: '正文', anchorMode: 'zero' });
    const files = new Map([[`${folder}/legacy.json`, JSON.stringify(draft)], [`${folder}/broken.json`, '{']]);
    const persistence = new AiProseDraftPersistence(memoryDraftFiles(files));
    const result = await persistence.loadResult(projectContext(), 'scene-1');
    expect(result.status).toBe('corrupt-json');
    expect([...files.keys()]).toEqual([`${folder}/legacy.json`, `${folder}/broken.json`]);
  });

  it('restores leftover running work as interrupted without changing the saved file', async () => {
    const draft = createDraft({ sceneId: 'scene-1', sourceText: '正文', anchorMode: 'zero' });
    draft.segmentation.status = 'running';
    const path = '/projects/demo/project-assets/ai-authoring/scene-1/current.json';
    const original = JSON.stringify(draft);
    const files = new Map([[path, original]]);
    const persistence = new AiProseDraftPersistence(memoryDraftFiles(files));
    const result = await persistence.loadResult(projectContext(), 'scene-1');
    if (result.status !== 'loaded') throw new Error(result.status);
    expect(result.draft.segmentation.status).toBe('failed');
    expect(result.draft.segmentation.error?.code).toBe('interrupted');
    expect(files.get(path)).toBe(original);
  });

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
      'current.json',
    );
    expect(fileAccess.ensureDir).toHaveBeenCalledWith(
      '/projects/demo/project-assets/ai-authoring/scene-1',
    );
    expect(fileAccess.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/current\.json\.tmp-/),
      expect.stringContaining('"schemaVersion": 4'),
    );
    expect(fileAccess.replaceFile).toHaveBeenCalledWith(
      expect.stringMatching(/current\.json\.tmp-/),
      '/projects/demo/project-assets/ai-authoring/scene-1/current.json',
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
      expect.stringMatching(/current\.json\.tmp-/),
      '/projects/demo/project-assets/ai-authoring/scene-1/current.json',
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
    expect(result.draft.schemaVersion).toBe(4);
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
    expect(serialized).toContain('"schemaVersion": 4');

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
      expect.stringContaining('current.json'),
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

function memoryDraftFiles(files: Map<string, string>): AiProseDraftFileAccess {
  return {
    exists: async (path) => files.has(path) || [...files.keys()].some((entry) => entry.startsWith(`${path}/`)),
    readFile: async (path) => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`Missing file: ${path}`);
      return data;
    },
    writeFile: async (path, data) => { files.set(path, data); },
    replaceFile: async (from, to) => {
      const data = files.get(from);
      if (data === undefined) throw new Error(`Missing file: ${from}`);
      files.set(to, data);
      files.delete(from);
    },
    removeFile: async (path) => { files.delete(path); },
    readDir: async (path) => [...files.keys()].filter((entry) => entry.startsWith(`${path}/`)).map((entry) => ({ name: entry.slice(path.length + 1), path: entry, isDirectory: false })),
    ensureDir: async () => {},
    join: (...parts) => parts.join('/'),
    dirname: (path) => path.slice(0, path.lastIndexOf('/')),
  };
}

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

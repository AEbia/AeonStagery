import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SceneFileService } from '../services/io/SceneFileService';
import { SceneMigrationExperience } from '../services/semantic-scene';
import { SCENE_SCHEMA_VERSION, SCENE_SCHEMA_VERSION_V4 } from '../api/types/semantic-scene';
import { DocumentStore } from '../ui/store/DocumentStore';
import { EditorStore } from '../ui/store/EditorStore';
import type { IFileAccess } from '../services/io/IFileAccess';
import type {
  DocumentFilePathPort,
  EditorSaveStatusPort,
} from '../services/document/DocumentProjectionPorts';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { SemanticScenePipeline } from '../services/semantic-scene';


describe('SceneFileService', () => {
  let fileAccessMock: Record<keyof IFileAccess, any>;
  let documentStore: DocumentStore;
  let editorStore: EditorStore;
  let documentFilePath: DocumentFilePathPort;
  let saveStatusPort: EditorSaveStatusPort;
  let service: SceneFileService;

  const exampleScene = {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'test-example',
    meta: { title: 'Test Example', characters: [{ id: 'tomori', name: 'Tomori' }] },
    statements: [
      {
        id: 'line_1',
        type: 'dialogue' as const,
        time: 1,
        params: { speakerId: 'tomori', text: 'Hello', durationSeconds: 2 },
      },
    ],
  };

  beforeEach(() => {
    fileAccessMock = {
      readAsset: vi.fn(),
      readFile: vi.fn(),
      readBinaryFile: vi.fn(),
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
      writeFile: vi.fn(),
      writeBinaryFile: vi.fn(),
      replaceFile: vi.fn(),
      ensureDir: vi.fn(),
      copyFile: vi.fn(),
      readDir: vi.fn(),
      exists: vi.fn(),
      stat: vi.fn(async () => null),
      realpath: vi.fn(async (targetPath: string) => targetPath),
      join: vi.fn(async (...parts: string[]) => parts.join('/')),
      dirname: vi.fn(async (targetPath: string) => targetPath.split('/').slice(0, -1).join('/') || '.'),
      basename: vi.fn(async (targetPath: string) => targetPath.split('/').pop() || targetPath),
      extname: vi.fn(async (targetPath: string) => {
        const fileName = targetPath.split('/').pop() || targetPath;
        const idx = fileName.lastIndexOf('.');
        return idx === -1 ? '' : fileName.slice(idx);
      })
    };

    documentStore = new DocumentStore();
    editorStore = new EditorStore();
    
    documentFilePath = {
      setFilePath: vi.fn((path: string | null) => {
        documentStore._setFilePath(path);
      }),
    };
    saveStatusPort = {
      setSaveStatus: vi.fn((status) => {
        editorStore._setSaveStatus(status);
      }),
    };

    const semanticPipeline = new SemanticScenePipeline({
      resolveAsset: vi.fn(async (source: string) => source),
    });
    const semanticCoordinator = new SemanticDocumentCoordinator(
      documentStore,
      semanticPipeline,
      {
        projectPreparedScene: vi.fn(async () => undefined),
      },
    );

    service = new SceneFileService(
      fileAccessMock as unknown as IFileAccess,
      documentStore,
      documentFilePath,
      saveStatusPort,
      semanticCoordinator,
    );
  });

  describe('loadExample', () => {
    it('successfully loads example start.json and compiles it', async () => {
      fileAccessMock.readAsset.mockResolvedValue({
        data: JSON.stringify(exampleScene),
        path: 'start.json'
      });

      const res = await service.loadExample();
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.path).toBe('start.json');
        expect(res.issues).toBeDefined();
        expect(documentStore.getPreparedSceneSnapshot()?.actions[0]?.action).toBe('dialogue');
        expect(documentStore.getPreparedSceneSnapshot()?.actions[0]?.params.text).toBe('Hello');
        expect(documentStore.getCurrentSceneDocumentSnapshot()?.sceneId).toBe('test-example');
        expect(documentStore.filePath).toBe('start.json');
      }
    });

    it('returns error result when readAsset fails', async () => {
      fileAccessMock.readAsset.mockRejectedValue(new Error('File not found'));

      const res = await service.loadExample();
      expect(res.success).toBe(false);
      if (!res.success) {
        expect((res as any).cancelled).toBeUndefined();
        expect((res as any).error).toContain('File not found');
      }
    });
  });

  describe('loadFile', () => {
    it('returns cancelled: true when user cancels dialog', async () => {
      fileAccessMock.showOpenDialog.mockResolvedValue(null);

      const res = await service.loadFile();
      expect(res.success).toBe(false);
      if (!res.success) {
        expect((res as any).cancelled).toBe(true);
      }
    });

    it('successfully loads a semantic scene from the dialog', async () => {
      fileAccessMock.showOpenDialog.mockResolvedValue({
        data: JSON.stringify(exampleScene),
        path: '/user/my-scene.json'
      });

      const res = await service.loadFile();
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.path).toBe('/user/my-scene.json');
        expect(documentStore.filePath).toBe('/user/my-scene.json');
        expect(documentStore.getCurrentSceneDocumentSnapshot()?.statements[0].id).toBe('line_1');
        expect(documentStore.getCompiledSceneSnapshot()?.actions[0]?.source.statementId).toBe('line_1');
        expect(documentStore.getPreparedSceneSnapshot()?.actions[0]?.params.text).toBe('Hello');
      }
    });
  });

  describe('loadFromRawJson', () => {
    it('loads raw scene json through the controlled service without exposing DocumentAdapter to UI', async () => {
      const res = await service.loadFromRawJson(JSON.stringify(exampleScene), '/inline/raw-scene.json');

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.path).toBe('/inline/raw-scene.json');
        expect(documentStore.filePath).toBe('/inline/raw-scene.json');
        expect(documentStore.getCurrentSceneDocumentSnapshot()?.sceneId).toBe('test-example');
      }
    });

    it('loads a schemaVersion 3 document through migration and reports migration warnings as issues', async () => {
      const rawV3 = {
        schemaVersion: 3,
        sceneId: 'scene_v3_dev',
        meta: {
          title: 'Dev V3',
          characters: [{ id: 'tomori', name: 'Tomori' }],
        },
        statements: [
          {
            id: 'legacy_motion',
            time: 0,
            type: 'characterPerformance',
            params: { target: 'tomori', motion: 'wave', loop: true },
          },
        ],
      };

      const res = await service.loadFromRawJson(JSON.stringify(rawV3), '/inline/raw-v3.json');

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.issues).toEqual([
          { severity: 'warning', message: 'Dropped characterPerformance loop=true on "legacy_motion": v4 motions run once' },
        ]);
        expect(documentStore.getCurrentSceneDocumentSnapshot()?.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
        expect(documentStore.getCurrentSceneDocumentSnapshot()?.statements[0].params).toMatchObject({
          target: 'tomori',
          motion: { kind: 'resource', key: 'wave' },
        });
      }
    });

    it('applies the migrated v4 document instead of the raw schemaVersion 3 input', async () => {
      const applyDocument = vi.spyOn(SemanticDocumentCoordinator.prototype, 'applyDocument');
      const rawV3 = {
        schemaVersion: 3,
        sceneId: 'scene_v3_dev',
        meta: {
          title: 'Dev V3',
          characters: [{ id: 'tomori', name: 'Tomori' }],
        },
        statements: [
          {
            id: 'legacy_motion',
            time: 0,
            type: 'characterPerformance',
            params: { target: 'tomori', motion: 'wave' },
          },
        ],
      };

      const res = await service.loadFromRawJson(JSON.stringify(rawV3), '/inline/raw-v3.json');

      expect(res.success).toBe(true);
      expect(applyDocument).toHaveBeenCalledWith(
        expect.objectContaining({ schemaVersion: SCENE_SCHEMA_VERSION }),
        '/inline/raw-v3.json',
      );
      applyDocument.mockRestore();
    });

    it('returns a structured error when raw json is invalid', async () => {
      const res = await service.loadFromRawJson('{ invalid json', '/inline/raw-scene.json');

      expect(res.success).toBe(false);
      if (!res.success) {
        expect((res as any).path).toBe('/inline/raw-scene.json');
        expect(typeof (res as any).error).toBe('string');
        expect((res as any).error.length).toBeGreaterThan(0);
      }
    });

    it('rejects legacy timeline JSON instead of migrating it through the main load path', async () => {
      const res = await service.loadFromRawJson(
        JSON.stringify({
          sceneId: 'legacy-scene',
          meta: { title: 'Legacy Scene' },
          timeline: [{ action: 'dialogue', time: 1, params: { text: 'Hello', duration: 2 } }],
        }),
        '/inline/legacy-scene.json',
      );

      expect(res.success).toBe(false);
      if (!res.success) {
        expect((res as any).path).toBe('/inline/legacy-scene.json');
        expect((res as any).error).toBe('Only current Scene Document JSON is supported');
      }
      expect(documentStore.getCurrentSceneDocumentSnapshot()).toBeNull();
    });
  });

  describe('scene document v4 detached parsing', () => {
    it('parses and compiles CurrentSceneDocument without replacing the current document', async () => {
      const rawV4 = {
        schemaVersion: SCENE_SCHEMA_VERSION,
        sceneId: 'scene_v4',
        meta: {
          title: 'Scene V4',
          characters: [{ id: 'tomori', name: 'Tomori' }],
        },
        statements: [
          {
            id: 'line',
            time: 1,
            type: 'dialogue',
            params: {
              speakerId: 'tomori',
              text: 'hello',
              durationSeconds: 2,
            },
          },
        ],
      };

      const res = await service.parseCurrentSceneDocumentFromRawJson(
        JSON.stringify(rawV4),
        '/inline/scene-v4.json',
      );

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.path).toBe('/inline/scene-v4.json');
        expect(res.sourceKind).toBe('current-scene-document');
        expect(res.document.statements[0].id).toBe('line');
        expect(res.compiled.actions.map((action) => action.action)).toEqual(['dialogue']);
      }
      expect(documentStore.getCurrentSceneDocumentSnapshot()).toBeNull();
      expect(documentStore.getPreparedSceneSnapshot()).toBeNull();
    });

    it('saves CurrentSceneDocument through the detached v4 codec without replacing the current document', async () => {
      documentStore._replaceCurrentSceneDocumentSnapshot(exampleScene);
      documentStore._setFilePath('/semantic/current.scene.json');
      fileAccessMock.writeFile.mockResolvedValue(undefined);
      const document = {
        schemaVersion: SCENE_SCHEMA_VERSION,
        sceneId: 'save_v4',
        meta: {
          title: 'Save V4',
          characters: [{ id: 'tomori', name: 'Tomori' }],
        },
        statements: [
          {
            id: 'line',
            time: 1,
            type: 'dialogue',
            params: {
              speakerId: 'tomori',
              text: 'hello',
              durationSeconds: 2,
            },
          },
        ],
      };

      const res = await service.saveCurrentSceneDocument(document as any, '/semantic/save.scene.json');

      expect(res).toEqual({ success: true, path: '/semantic/save.scene.json' });
      expect(fileAccessMock.writeFile).toHaveBeenCalledWith('/semantic/save.scene.json', expect.any(String));
      const saved = JSON.parse(fileAccessMock.writeFile.mock.calls[0][1]);
      expect(saved).toEqual(expect.objectContaining({
        schemaVersion: SCENE_SCHEMA_VERSION,
        sceneId: 'save_v4',
        statements: [
          expect.objectContaining({
            id: 'line',
            type: 'dialogue',
          }),
        ],
      }));
      expect(documentStore.filePath).toBe('/semantic/current.scene.json');
      expect(editorStore.saveStatus).toBe('idle');
    });

    it('rejects invalid CurrentSceneDocument before writing detached v4 saves', async () => {
      const document = {
        schemaVersion: SCENE_SCHEMA_VERSION,
        sceneId: 'bad_save_v4',
        meta: {
          title: 'Bad Save V4',
          durationSeconds: 1,
        },
        statements: [
          {
            id: 'line',
            time: 1,
            type: 'dialogue',
            params: {
              text: 'too long',
              durationSeconds: 2,
            },
          },
        ],
      };

      const res = await service.saveCurrentSceneDocument(document as any, '/semantic/bad.scene.json');

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.path).toBe('/semantic/bad.scene.json');
        expect('cancelled' in res).toBe(false);
        if (!('cancelled' in res)) {
          expect(res.error).toContain('meta.durationSeconds');
        }
      }
      expect(fileAccessMock.writeFile).not.toHaveBeenCalled();
      expect(editorStore.saveStatus).toBe('error');
    });
  });

  describe('save', () => {
    it('returns error when no scene is loaded', async () => {
      const res = await service.save();
      expect(res.success).toBe(false);
      if (!res.success) {
        expect((res as any).error).toBe('No semantic scene document loaded');
      }
    });

    it('writes CurrentSceneDocument directly to the current file path', async () => {
      documentStore._replaceCurrentSceneDocumentSnapshot(exampleScene);
      documentStore._setFilePath('/my/save/path.json');
      fileAccessMock.writeFile.mockResolvedValue();

      const res = await service.save();
      expect(res.success).toBe(true);
      expect(fileAccessMock.writeFile).toHaveBeenCalledWith(
        '/my/save/path.json',
        expect.any(String)
      );
      expect(editorStore.saveStatus).toBe('idle');
    });

    it('updates saveStatus inside EditorStore correctly on success/failure', async () => {
      documentStore._replaceCurrentSceneDocumentSnapshot(exampleScene);
      documentStore._setFilePath('/my/save/path.json');
      
      let writingPromiseResolve: () => void = null!;
      const writingPromise = new Promise<void>((resolve) => {
        writingPromiseResolve = resolve;
      });
      fileAccessMock.writeFile.mockReturnValue(writingPromise);

      const savePromise = service.save();
      
      // Verification of saving status
      expect(editorStore.saveStatus).toBe('saving');

      writingPromiseResolve();
      await savePromise;

      // Verification of idle status after success
      expect(editorStore.saveStatus).toBe('idle');
    });

    it('transitions saveStatus to error on write failure', async () => {
      documentStore._replaceCurrentSceneDocumentSnapshot(exampleScene);
      documentStore._setFilePath('/my/save/path.json');
      fileAccessMock.writeFile.mockRejectedValue(new Error('Disk Full'));

      const res = await service.save();
      expect(res.success).toBe(false);
      expect(editorStore.saveStatus).toBe('error');
    });
  });

  describe('saveAs', () => {
    it('returns cancelled: true when dialog is cancelled', async () => {
      documentStore._replaceCurrentSceneDocumentSnapshot(exampleScene);
      documentStore._setFilePath('/old/path.json');
      fileAccessMock.showSaveDialog.mockResolvedValue(null);

      const res = await service.saveAs();
      expect(res.success).toBe(false);
      if (!res.success) {
        expect((res as any).cancelled).toBe(true);
      }
      expect(documentStore.filePath).toBe('/old/path.json'); // unchanged
    });

    it('writes to new dialog path and lightweightly updates documentStore filePath', async () => {
      documentStore._replaceCurrentSceneDocumentSnapshot(exampleScene);
      documentStore._setFilePath('/old/path.json');
      fileAccessMock.showSaveDialog.mockResolvedValue('/new/save-as.json');
      fileAccessMock.writeFile.mockResolvedValue();

      // Setup a mock observer to prove that saving does not replace the semantic scene.
      const originalReplaceSemanticScene = vi.spyOn(documentStore, '_replaceSemanticScene');

      const res = await service.saveAs();
      expect(res.success).toBe(true);
      expect(fileAccessMock.writeFile).toHaveBeenCalledWith(
        '/new/save-as.json',
        expect.any(String)
      );
      expect(documentFilePath.setFilePath).toHaveBeenCalledWith('/new/save-as.json');
      expect(documentStore.filePath).toBe('/new/save-as.json');
      expect(originalReplaceSemanticScene).not.toHaveBeenCalled(); // zero scene replacement
    });
  });

  describe('scene compatibility wiring', () => {
    it('opens a v5 scene containing unknown fields and preserves them on save', async () => {
      const futureScene = {
        schemaVersion: SCENE_SCHEMA_VERSION,
        sceneId: 'future-scene',
        meta: {
          title: 'Future Scene',
          futureHint: 42,
        },
        statements: [
          {
            id: 'line_1',
            time: 0,
            type: 'dialogue',
            params: { text: 'Hello', durationSeconds: 1 },
          },
        ],
      };

      const res = await service.loadFromRawJson(JSON.stringify(futureScene), '/inline/future.json');
      expect(res.success).toBe(true);

      const typed = documentStore.getCurrentSceneDocumentSnapshot();
      expect(typed?.meta).not.toHaveProperty('futureHint');

      const written: Array<[string, string]> = [];
      fileAccessMock.writeFile.mockImplementation(async (path: string, data: string) => {
        written.push([path, data]);
      });
      const saveRes = await service.saveCurrentSceneDocument(typed!, '/inline/future-saved.json');
      expect(saveRes.success).toBe(true);
      expect(written[0][0]).toBe('/inline/future-saved.json');
      const saved = JSON.parse(written[0][1]);
      expect(saved.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
      expect(saved.meta.futureHint).toBe(42);
    });

    it('runs the gated migration through the file service when a SceneMigrationExperience is configured', async () => {
      const v4Scene = {
        schemaVersion: SCENE_SCHEMA_VERSION_V4,
        sceneId: 'legacy-v4',
        meta: { title: 'Legacy V4' },
        statements: [
          {
            id: 'line_1',
            time: 0,
            type: 'dialogue',
            params: { text: 'Hello v4', durationSeconds: 1 },
          },
        ],
      };
      const path = '/user/scenes/main.scene.json';
      fileAccessMock.readFile.mockResolvedValue({
        data: JSON.stringify(v4Scene),
        path,
      });
      const upgraded = new Map<string, string>();
      fileAccessMock.writeFile.mockImplementation(async (targetPath: string, data: string) => {
        upgraded.set(targetPath, data);
      });
      fileAccessMock.exists.mockResolvedValue(true);

      const experience = new SceneMigrationExperience({
        fileAccess: fileAccessMock as any,
        projectResources: { resolveForProjectWrite: (relativePath: string) => `/root/${relativePath}` },
        confirmMigration: async () => true,
      });
      const gatedService = new SceneFileService(
        fileAccessMock as unknown as IFileAccess,
        documentStore,
        documentFilePath,
        saveStatusPort,
        (service as any).semanticCoordinator,
        experience,
      );

      const res = await gatedService.loadFromPath(path);
      expect(res.success).toBe(true);
      expect(JSON.parse(upgraded.get(path)!)).toMatchObject({ schemaVersion: 5 });
      expect(documentStore.getCurrentSceneDocumentSnapshot()?.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
    });
  });
});

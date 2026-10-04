import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ValidationDaemon } from '../engine/daemons/ValidationDaemon';
import { DocumentStore } from '../ui/store/DocumentStore';
import { ValidationStore } from '../ui/store/ValidationStore';
import type { SceneScript } from '../../scripts/migrations/legacy-scene/LegacySceneTypes';
import { ProjectResourceService } from '../services/io/ProjectResourceService';
import { migrateLegacySceneScriptToDocumentV3 } from '../../scripts/migrations/legacy-scene/LegacySceneDocumentMigrator';

function replaceLegacyFixture(documentStore: DocumentStore, script: SceneScript): void {
  const result = migrateLegacySceneScriptToDocumentV3(script);
  if (!result.document) {
    throw new Error(result.issues.map((issue) => issue.message).join('; '));
  }
  documentStore._replaceCurrentSceneDocumentSnapshot(result.document);
}

describe('ValidationDaemon', () => {
  let documentStore: DocumentStore;
  let validationStore: ValidationStore;
  let daemon: ValidationDaemon;
  let mockExists: any;
  let mockReadTextFile: any;
  let projectResourcesMock: Pick<ProjectResourceService, 'getCurrentProject' | 'resolveForRead'>;

  beforeEach(() => {
    // Save original global window or establish mock window
    mockExists = vi.fn().mockResolvedValue(true);
    mockReadTextFile = vi.fn().mockResolvedValue({
      success: true,
      data: JSON.stringify({
        motions: { idle: [{}], wave: [{}] },
        expressions: [{ name: 'smile' }]
      })
    });

    (global as any).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      aeonStageryAPI: {
        fs: {
          exists: mockExists,
          readTextFile: mockReadTextFile
        }
      }
    };

    documentStore = new DocumentStore();
    validationStore = new ValidationStore();
    projectResourcesMock = {
      getCurrentProject: vi.fn(() => null),
      resolveForRead: vi.fn(async (relativePath: string) => `/project/${relativePath}`),
    };
    daemon = new ValidationDaemon(
      documentStore,
      validationStore,
      projectResourcesMock as unknown as ProjectResourceService,
      () => '/base/path'
    );
  });

  afterEach(() => {
    daemon.dispose();
    delete (global as any).window;
  });

  it('runs Stage 1 immediately on document change', async () => {
    daemon.start();

    const script: SceneScript = {
      sceneId: 'test',
      meta: { title: 'Test' },
      timeline: []
    };

    replaceLegacyFixture(documentStore, script);

    // Stage 1 is sync, so it should run immediately
    expect(validationStore.issues.length).toBeGreaterThan(0);
    expect(validationStore.issues[0].message).toContain('未声明角色');
  });

  it('debounces Stage 2 validation', async () => {
    vi.useFakeTimers();
    daemon.start();

    const script: SceneScript = {
      sceneId: 'test',
      meta: {
        title: 'Valid Title',
        characters: [{ id: 'soyo', name: 'Soyo', model: 'soyo.model.json' }]
      },
      timeline: [
        {
          _id: 'a1',
          action: 'addCharacter',
          time: 1.0,
          params: { id: 'soyo' }
        }
      ]
    };

    replaceLegacyFixture(documentStore, script);

    // Stage 2 has a 400ms debounce.
    expect(validationStore.loading).toBe(false);

    // Fast-forward by 400ms
    await vi.runAllTimersAsync();

    // Stage 2 should have completed
    expect(mockExists).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reports broken Live2D model paths declared in meta.characters', async () => {
    vi.useFakeTimers();
    mockExists.mockImplementation(async (path: string) => !String(path).includes('broken-model.json'));
    daemon.start();

    const script: SceneScript = {
      sceneId: 'test',
      meta: {
        title: 'Valid Title',
        characters: [{ id: 'soyo', name: 'Soyo', model: 'figure/soyo/broken-model.json' }]
      },
      timeline: [],
    };

    replaceLegacyFixture(documentStore, script);
    await vi.runAllTimersAsync();

    expect(validationStore.issues.some((issue) => issue.message.includes('Live2D 配置文件不存在'))).toBe(true);
    vi.useRealTimers();
  });

  it('caches asset exists check with 5s TTL', async () => {
    daemon.start();

    // Directly test helper functions to verify cache hits
    const exists1 = (await (daemon as any).probeAsset('audio/music.mp3')).exists;
    expect(exists1).toBe(true);
    expect(mockExists).toHaveBeenCalledTimes(1);

    // Check again, should hit cache
    const exists2 = (await (daemon as any).probeAsset('audio/music.mp3')).exists;
    expect(exists2).toBe(true);
    expect(mockExists).toHaveBeenCalledTimes(1); // not incremented

    // Clear cache, should check again
    daemon.clearAssetCache();
    const exists3 = (await (daemon as any).probeAsset('audio/music.mp3')).exists;
    expect(exists3).toBe(true);
    expect(mockExists).toHaveBeenCalledTimes(2);
  });

  it('correctly resolves and strips validation paths', () => {
    // Relative path
    expect((daemon as any).resolveValidationPath('audio/bgm.mp3')).toBe('/base/path/audio/bgm.mp3');
    
    // Absolute path
    expect((daemon as any).resolveValidationPath('D:/aeonstagery/model.json')).toBe('D:/aeonstagery/model.json');
    expect((daemon as any).resolveValidationPath('/absolute/path/file.mp3')).toBe('/absolute/path/file.mp3');

    // file:// protocol
    expect((daemon as any).resolveValidationPath('file:///D:/aeonstagery/model.json')).toBe('D:/aeonstagery/model.json');
    expect((daemon as any).resolveValidationPath('file://D:/aeonstagery/model.json')).toBe('D:/aeonstagery/model.json');

    // asset:// protocol
    expect((daemon as any).resolveValidationPath('asset://localhost/D:/aeonstagery/model.json')).toBe('D:/aeonstagery/model.json');
    expect((daemon as any).resolveValidationPath('asset://D:/aeonstagery/model.json')).toBe('D:/aeonstagery/model.json');
  });

  it('validates playMotion and setExpression motion keys correctly', async () => {
    vi.useFakeTimers();
    daemon.start();

    const script: SceneScript = {
      sceneId: 'test',
      meta: {
        title: 'Valid Title',
        characters: [{ id: 'soyo', name: 'Soyo', model: 'soyo.model.json' }]
      },
      timeline: [
        {
          _id: 'a1',
          action: 'addCharacter',
          time: 0.0,
          params: { id: 'soyo' }
        },
        {
          _id: 'a2',
          action: 'playMotion',
          time: 1.0,
          params: { id: 'soyo', motion: 'wave' } // Perfect match
        },
        {
          _id: 'a3',
          action: 'playMotion',
          time: 2.0,
          params: { id: 'soyo', motion: 'Wave' } // Case mismatch
        },
        {
          _id: 'a4',
          action: 'playMotion',
          time: 3.0,
          params: { id: 'soyo', motion: 'dance' } // Totally missing
        },
        {
          _id: 'a5',
          action: 'setExpression',
          time: 4.0,
          params: { id: 'soyo', expression: 'Smile' } // Case mismatch
        },
        {
          _id: 'a6',
          action: 'setExpression',
          time: 5.0,
          params: { id: 'soyo', expression: 'sad' } // Totally missing
        }
      ]
    };

    replaceLegacyFixture(documentStore, script);
    await vi.runAllTimersAsync();

    const issues = validationStore.issues;

    // Check case mismatch on 'Wave'
    const waveCaseIssue = issues.find(i => i.actionId === 'a3');
    expect(waveCaseIssue).toBeDefined();
    expect(waveCaseIssue?.severity).toBe('error');
    expect(waveCaseIssue?.message).toContain('大小写不匹配');

    // Check totally missing 'dance'
    const danceMissingIssue = issues.find(i => i.actionId === 'a4');
    expect(danceMissingIssue).toBeDefined();
    expect(danceMissingIssue?.severity).toBe('error');
    expect(danceMissingIssue?.message).toContain('未找到动作名 "dance"');

    // Check case mismatch on 'Smile'
    const smileCaseIssue = issues.find(i => i.actionId === 'a5');
    expect(smileCaseIssue).toBeDefined();
    expect(smileCaseIssue?.severity).toBe('error');
    expect(smileCaseIssue?.message).toContain('大小写不匹配');

    // Check totally missing 'sad'
    const sadMissingIssue = issues.find(i => i.actionId === 'a6');
    expect(sadMissingIssue).toBeDefined();
    expect(sadMissingIssue?.severity).toBe('error');
    expect(sadMissingIssue?.message).toContain('未找到表情名 "sad"');

    // Check perfect match on 'wave' has no issue
    const wavePerfectIssue = issues.find(i => i.actionId === 'a2');
    expect(wavePerfectIssue).toBeUndefined();

    vi.useRealTimers();
  });

  it('correctly resolves composed models (.wmdl) and performs validation', async () => {
    mockReadTextFile.mockImplementation(async (p: string) => {
      const normalized = p.replace(/\\/g, '/');
      if (normalized.endsWith('soyo.wmdl')) {
        return {
          success: true,
          data: JSON.stringify({
            modelRelativePath: 'body/soyo.json'
          })
        };
      }
      if (normalized.endsWith('body/soyo.json')) {
        return {
          success: true,
          data: JSON.stringify({
            motions: { idle: [{}], wave: [{}] },
            expressions: [{ name: 'smile' }]
          })
        };
      }
      return { success: false, error: 'Not found' };
    });

    vi.useFakeTimers();
    daemon.start();

    const script: SceneScript = {
      sceneId: 'test',
      meta: {
        title: 'Valid Title',
        characters: [{ id: 'soyo', name: 'Soyo', model: 'soyo.wmdl' }]
      },
      timeline: [
        {
          _id: 'a1',
          action: 'addCharacter',
          time: 0.0,
          params: { id: 'soyo' }
        },
        {
          _id: 'a2',
          action: 'playMotion',
          time: 1.0,
          params: { id: 'soyo', motion: 'Wave' } // Case mismatch on composed model!
        }
      ]
    };

    replaceLegacyFixture(documentStore, script);
    await vi.runAllTimersAsync();

    const issues = validationStore.issues;
    const waveCaseIssue = issues.find(i => i.actionId === 'a2');
    expect(waveCaseIssue).toBeDefined();
    expect(waveCaseIssue?.severity).toBe('error');
    expect(waveCaseIssue?.message).toContain('大小写不匹配');

    vi.useRealTimers();
  });

  it('correctly merges subModels motions and expressions from composed models (.wmdl)', async () => {
    mockReadTextFile.mockImplementation(async (p: string) => {
      const normalized = p.replace(/\\/g, '/');
      if (normalized.endsWith('soyo.wmdl')) {
        return {
          success: true,
          data: JSON.stringify({
            modelRelativePath: 'body/soyo.json',
            subModels: [
              { modelRelativePath: 'face/soyo_face.json' },
              { modelRelativePath: 'arm/soyo_arm.json' }
            ]
          })
        };
      }
      if (normalized.endsWith('body/soyo.json')) {
        return {
          success: true,
          data: JSON.stringify({
            motions: { idle: [{}], body_wave: [{}] },
            expressions: [{ name: 'smile' }]
          })
        };
      }
      if (normalized.endsWith('face/soyo_face.json')) {
        return {
          success: true,
          data: JSON.stringify({
            expressions: [{ name: 'cry' }, { name: 'blush' }]
          })
        };
      }
      if (normalized.endsWith('arm/soyo_arm.json')) {
        return {
          success: true,
          data: JSON.stringify({
            motions: { wave_hand: [{}] }
          })
        };
      }
      return { success: false, error: 'Not found' };
    });

    vi.useFakeTimers();
    daemon.start();

    const script: SceneScript = {
      sceneId: 'test',
      meta: {
        title: 'Valid Title',
        characters: [{ id: 'soyo', name: 'Soyo', model: 'soyo.wmdl' }]
      },
      timeline: [
        {
          _id: 'a1',
          action: 'addCharacter',
          time: 0.0,
          params: { id: 'soyo' }
        },
        {
          _id: 'a2',
          action: 'playMotion',
          time: 1.0,
          params: { id: 'soyo', motion: 'body_wave' } // Torso motion
        },
        {
          _id: 'a3',
          action: 'playMotion',
          time: 2.0,
          params: { id: 'soyo', motion: 'wave_hand' } // Submodel arm motion
        },
        {
          _id: 'a4',
          action: 'setExpression',
          time: 3.0,
          params: { id: 'soyo', expression: 'blush' } // Submodel face expression
        },
        {
          _id: 'a5',
          action: 'playMotion',
          time: 4.0,
          params: { id: 'soyo', motion: 'non_existent' } // Missing motion
        }
      ]
    };

    replaceLegacyFixture(documentStore, script);
    await vi.runAllTimersAsync();

    const issues = validationStore.issues;

    // Both body_wave, wave_hand and blush should be completely valid (no issues generated)
    expect(issues.find(i => i.actionId === 'a2')).toBeUndefined();
    expect(issues.find(i => i.actionId === 'a3')).toBeUndefined();
    expect(issues.find(i => i.actionId === 'a4' && i.severity === 'error')).toBeUndefined();

    // non_existent should be flagged as error
    const missingIssue = issues.find(i => i.actionId === 'a5');
    expect(missingIssue).toBeDefined();
    expect(missingIssue?.severity).toBe('error');
    expect(missingIssue?.message).toContain('未找到动作名 "non_existent"');

    vi.useRealTimers();
  });

  it('correctly validates motions and expressions against independent character variants (outfits) defined in metadata', async () => {
    mockReadTextFile.mockImplementation(async (p: string) => {
      const normalized = p.replace(/\\/g, '/');
      if (normalized.endsWith('soyo_casual.json')) {
        return {
          success: true,
          data: JSON.stringify({
            motions: { idle: [{}], casual_wave: [{}] },
            expressions: [{ name: 'smile' }]
          })
        };
      }
      if (normalized.endsWith('soyo_uniform.json')) {
        return {
          success: true,
          data: JSON.stringify({
            motions: { idle: [{}] },
            expressions: [{ name: 'blush' }]
          })
        };
      }
      if (normalized.endsWith('soyo_swimsuit.json')) {
        return {
          success: true,
          data: JSON.stringify({
            motions: { swimsuit_wave: [{}] }
          })
        };
      }
      return { success: false, error: 'Not found' };
    });

    vi.useFakeTimers();
    daemon.start();

    const script: SceneScript = {
      sceneId: 'test',
      meta: {
        title: 'Valid Title',
        characters: [
          {
            id: 'soyo',
            name: 'Soyo',
            model: 'soyo_casual.json', // defaults to casual outfit
            variants: [
              { name: '制服副模型', model: 'soyo_uniform.json' },
              { name: '泳装副模型', model: 'soyo_swimsuit.json' }
            ]
          }
        ]
      },
      timeline: [
        {
          _id: 'a1',
          action: 'addCharacter',
          time: 0.0,
          params: { id: 'soyo' } // defaults to soyo_casual.json
        },
        {
          _id: 'a2',
          action: 'playMotion',
          time: 1.0,
          params: { id: 'soyo', motion: 'casual_wave' } // Casual outfit motion - valid
        },
        {
          _id: 'a3',
          action: 'playMotion',
          time: 2.0,
          params: { id: 'soyo', motion: 'swimsuit_wave' } // Swimsuit motion - INVALID here (active is casual outfit!)
        },
        {
          _id: 'a1_swimsuit',
          action: 'addCharacter',
          time: 2.5,
          params: { id: 'soyo', model: 'soyo_swimsuit.json' } // Switch active model to swimsuit outfit
        },
        {
          _id: 'a4',
          action: 'playMotion',
          time: 3.0,
          params: { id: 'soyo', motion: 'swimsuit_wave' } // Swimsuit motion - valid now!
        },
        {
          _id: 'a5',
          action: 'playMotion',
          time: 4.0,
          params: { id: 'soyo', motion: 'casual_wave' } // Casual motion - INVALID here (active is swimsuit!)
        },
        {
          _id: 'a1_uniform',
          action: 'addCharacter',
          time: 4.5,
          params: { id: 'soyo', model: 'soyo_uniform.json' } // Switch active model to school uniform outfit
        },
        {
          _id: 'a6',
          action: 'setExpression',
          time: 5.0,
          params: { id: 'soyo', expression: 'blush' } // Uniform expression - valid now!
        },
        {
          _id: 'a7',
          action: 'playMotion',
          time: 6.0,
          params: { id: 'soyo', motion: 'unknown_motion' } // Non-existent motion - INVALID
        }
      ]
    };

    replaceLegacyFixture(documentStore, script);
    await vi.runAllTimersAsync();

    const issues = validationStore.issues;

    // a2 (casual_wave on casual), a4 (swimsuit_wave on swimsuit) and a6 (blush on uniform) should have no model errors.
    expect(issues.find(i => i.actionId === 'a2')).toBeUndefined();
    expect(issues.find(i => i.actionId === 'a4' && i.severity === 'error')).toBeUndefined();
    expect(issues.find(i => i.actionId === 'a6')).toBeUndefined();

    // a3 (swimsuit_wave played while casual outfit is active) should be flagged as error
    const swimsuitWaveOnCasualIssue = issues.find(i => i.actionId === 'a3' && i.severity === 'error');
    expect(swimsuitWaveOnCasualIssue).toBeDefined();
    expect(swimsuitWaveOnCasualIssue?.severity).toBe('error');
    expect(swimsuitWaveOnCasualIssue?.message).toContain('未找到动作名 "swimsuit_wave"');

    // a5 (casual_wave played while swimsuit is active) should be flagged as error
    const casualWaveOnSwimsuitIssue = issues.find(i => i.actionId === 'a5' && i.severity === 'error');
    expect(casualWaveOnSwimsuitIssue).toBeDefined();
    expect(casualWaveOnSwimsuitIssue?.severity).toBe('error');
    expect(casualWaveOnSwimsuitIssue?.message).toContain('未找到动作名 "casual_wave"');

    // a7 (non-existent motion) should be flagged as error
    const unknownMotionIssue = issues.find(i => i.actionId === 'a7');
    expect(unknownMotionIssue).toBeDefined();
    expect(unknownMotionIssue?.severity).toBe('error');
    expect(unknownMotionIssue?.message).toContain('未找到动作名 "unknown_motion"');

    vi.useRealTimers();
  });

  it('prefers the shared model-data resolver so sub-model validation matches the editor/runtime data source', async () => {
    const sharedResolver = vi.fn(async (modelPath: string) => {
      if (modelPath === 'anon_main.model.json') {
        return {
          motions: ['anon/nf03'],
          expressions: ['anon/shame02']
        };
      }
      if (modelPath === 'anon_variant.model.json') {
        return {
          motions: ['nf03'],
          expressions: ['shame02']
        };
      }
      return { motions: [], expressions: [] };
    });

    mockReadTextFile.mockImplementation(async () => ({
      success: true,
      data: JSON.stringify({
        motions: { 'anon/nf03': [{}] },
        expressions: [{ name: 'anon/shame02' }]
      })
    }));

    daemon.dispose();
    daemon = new ValidationDaemon(
      documentStore,
      validationStore,
      projectResourcesMock as unknown as ProjectResourceService,
      () => '/base/path',
      sharedResolver,
    );

    vi.useFakeTimers();
    daemon.start();

    const script: SceneScript = {
      sceneId: 'test',
      meta: {
        title: 'Valid Title',
        characters: [
          {
            id: 'anon',
            name: 'Anon',
            model: 'anon_main.model.json',
            variants: [
              { name: '副模型1', model: 'anon_variant.model.json' }
            ]
          }
        ]
      },
      timeline: [
        {
          _id: 'a1',
          action: 'addCharacter',
          time: 0.0,
          params: { id: 'anon', model: 'anon_main.model.json' }
        },
        {
          _id: 'a2',
          action: 'playMotion',
          time: 0.1,
          params: { id: 'anon', motion: 'anon/nf03' }
        },
        {
          _id: 'a3',
          action: 'removeCharacter',
          time: 0.5,
          params: { id: 'anon' }
        },
        {
          _id: 'a4',
          action: 'addCharacter',
          time: 1.0,
          params: { id: 'anon', model: 'anon_variant.model.json' }
        },
        {
          _id: 'a5',
          action: 'playMotion',
          time: 1.1,
          params: { id: 'anon', motion: 'nf03' }
        },
        {
          _id: 'a6',
          action: 'setExpression',
          time: 1.2,
          params: { id: 'anon', expression: 'shame02' }
        }
      ]
    };

    replaceLegacyFixture(documentStore, script);
    await vi.runAllTimersAsync();

    expect(sharedResolver).toHaveBeenCalledWith('anon_main.model.json');
    expect(sharedResolver).toHaveBeenCalledWith('anon_variant.model.json');
    expect(validationStore.issues.find(i => i.actionId === 'a2')).toBeUndefined();
    expect(validationStore.issues.find(i => i.actionId === 'a5')).toBeUndefined();
    expect(validationStore.issues.find(i => i.actionId === 'a6')).toBeUndefined();

    vi.useRealTimers();
  });
});

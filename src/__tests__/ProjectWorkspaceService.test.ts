import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectWorkspaceService } from '../services/io/ProjectWorkspaceService';
import type { IFileAccess } from '../services/io/IFileAccess';
import { ProjectResourceService } from '../services/io/ProjectResourceService';
import { ProjectPathResolver } from '../services/io/ProjectPathResolver';
import { ProjectSession } from '../services/io/ProjectSession';
import { createLoadedTemplatePackage } from '../services/template-package';
import { SEMANTIC_BUILTIN_TEMPLATE_PACKAGE } from '../services/template-package/BuiltinTemplatePackage';
import { sceneDocumentCodec } from '../services/semantic-scene';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';

describe('ProjectWorkspaceService', () => {
  let fileAccess: Record<keyof IFileAccess, any>;
  let projectResources: ProjectResourceService;
  let service: ProjectWorkspaceService;
  let setProjectRoot: (path: string) => void;
  let session: ProjectSession;

  beforeEach(() => {
    fileAccess = {
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
      stat: vi.fn(async () => null),
      realpath: vi.fn(async (pathValue: string) => pathValue),
      exists: vi.fn(async () => true),
      join: vi.fn(async (...parts: string[]) => parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/')),
      dirname: vi.fn(async (pathValue: string) => pathValue.split('/').slice(0, -1).join('/') || '.'),
      basename: vi.fn(async (pathValue: string) => pathValue.split('/').pop() || pathValue),
      extname: vi.fn(async (pathValue: string) => {
        const idx = pathValue.lastIndexOf('.');
        return idx === -1 ? '' : pathValue.slice(idx);
      }),
    };

    projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
    );
    session = new ProjectSession();
    setProjectRoot = vi.fn<(path: string) => void>();
    service = new ProjectWorkspaceService(
      fileAccess as unknown as IFileAccess,
      projectResources,
      session,
      setProjectRoot,
    );
  });

  it.each(['pink-nameplate', 'immersive-subtitle'])('materializes builtin dialogue style %s into portable project assets', async (styleId) => {
    projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [],
      () => session.getCurrentProject(),
    );
    service = new ProjectWorkspaceService(
      fileAccess as unknown as IFileAccess,
      projectResources,
      session,
      setProjectRoot,
      () => [SEMANTIC_BUILTIN_TEMPLATE_PACKAGE],
    );
    const result = await service.createProjectAt('D:/projects/demo', 'Demo', {
      templates: {
        enabledTemplateIds: ['aeonstagery.default'],
        defaults: { dialogueStyleId: styleId },
      },
    });
    if (!result.success) throw new Error(result.error);
    const presentation = result.project.metadata.templates?.dialoguePresentation;
    expect(presentation?.styleId).toBe(styleId);
    expect(presentation?.textbox.image).toBe(`images/templates/aeonstagery.default/ui/dialogue/${styleId}/textbox.svg`);
    expect(presentation?.namebox?.image).toBe(`images/templates/aeonstagery.default/ui/dialogue/${styleId}/namebox.svg`);
    expect(presentation?.text.fontFile).toBe('images/templates/aeonstagery.default/fonts/JiangChengYuanTi_500W.ttf');
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      `src/templates/default/assets/ui/dialogue/${styleId}/textbox.svg`,
      `D:/projects/demo/images/templates/aeonstagery.default/ui/dialogue/${styleId}/textbox.svg`,
    );
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'src/templates/default/assets/fonts/JiangChengYuanTi_500W.ttf',
      'D:/projects/demo/images/templates/aeonstagery.default/fonts/JiangChengYuanTi_500W.ttf',
    );
    expect(JSON.stringify(presentation)).not.toMatch(/mygo/i);
  });

  it('creates a project and default scene file without loading the scene', async () => {
    const result = await service.createProjectAt('D:/projects/demo', 'Demo');

    if (!result.success) {
      throw new Error(`createProjectAt failed: ${result.error}`);
    }
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.project.rootPath).toBe('D:/projects/demo');
      expect(result.project.metadata.templates).toEqual({
        enabledTemplateIds: ['aeonstagery.default'],
        defaults: undefined,
        selectedCharacterPresetIds: [],
        characterVariantImportMode: 'primary-only',
      });
      expect(result.scenePath).toBe('D:/projects/demo/project/main.scene.json');
      expect(fileAccess.writeFile).toHaveBeenCalledWith(
        'D:/projects/demo/project.json',
        expect.stringContaining('"enabledTemplateIds": ['),
      );
      expect(fileAccess.writeFile).toHaveBeenCalledWith(
        'D:/projects/demo/project/main.scene.json',
        expect.stringContaining('"title": "Demo"'),
      );
      expect(setProjectRoot).toHaveBeenCalledWith('D:/projects/demo');
    }
  });

  it('enables every available template when creating a project without a template selection', async () => {
    const availableTemplates = ['template.one', 'template.two'].map((id) => createLoadedTemplatePackage({
      template: { id, name: id, version: '1.0.0' },
    }, {
      scope: 'user',
      packageRoot: `/library/template/${id}`,
      manifestPath: `/library/template/${id}/manifest.json`,
    }));
    service = new ProjectWorkspaceService(
      fileAccess as unknown as IFileAccess,
      projectResources,
      session,
      setProjectRoot,
      () => availableTemplates,
    );

    const result = await service.createProjectAt('D:/projects/demo', 'Demo');

    if (!result.success) throw new Error(`createProjectAt failed: ${result.error}`);
    expect(result.project.metadata.templates?.enabledTemplateIds).toEqual(['template.one', 'template.two']);
  });

  it('creates a project with explicit template configuration', async () => {
    const result = await service.createProjectAt('D:/projects/demo', 'Demo', {
      templates: {
        enabledTemplateIds: ['mygo', 'mujica'],
        defaults: {
          dialogueStyleId: 'mujica.glass',
          lightingPresetId: 'stage_night',
          cameraPresetId: 'close_push',
        },
        selectedCharacterPresetIds: ['tomori', 'anon'],
      },
    });

    if (!result.success) {
      throw new Error(`createProjectAt failed: ${result.error}`);
    }
    expect(result.project.metadata.templates).toEqual({
      enabledTemplateIds: ['mygo', 'mujica'],
      defaults: {
        dialogueStyleId: 'mujica.glass',
        lightingPresetId: 'stage_night',
        cameraPresetId: 'close_push',
      },
      selectedCharacterPresetIds: ['tomori', 'anon'],
      characterVariantImportMode: 'primary-only',
    });
    expect(fileAccess.writeFile).toHaveBeenCalledWith(
      'D:/projects/demo/project.json',
      expect.stringContaining('"selectedCharacterPresetIds": ['),
    );
  });

  it('materializes a selected image dialogue style into project-owned UI and font assets', async () => {
    projectResources = new ProjectResourceService(
      fileAccess as unknown as IFileAccess,
      new ProjectPathResolver(null),
      () => [],
      () => session.getCurrentProject(),
    );
    const imageUi = createLoadedTemplatePackage({
      manifestSchemaVersion: 2,
      template: {
        id: 'image-ui',
        name: 'Image UI',
        version: '1.0.0',
        compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
      },
      assets: { root: 'assets' },
      defaults: { dialogueStyleId: 'image-ui.default' },
      dialogueStyles: [{
        id: 'image-ui.default',
        name: 'Image UI Default',
        renderer: 'image-dialogue-v1',
        params: {
          textbox: { image: 'ui/dialogue/textbox.png', nineSlice: [40, 40, 40, 40], x: 120, y: 760, width: 1680, minHeight: 240 },
          namebox: { image: 'ui/dialogue/namebox.png', x: 160, y: 690, width: 320, height: 88 },
          text: { fontFile: 'fonts/dialogue.ttf', fontFamily: 'Image UI Dialogue', x: 190, y: 820, maxWidth: 1500 },
        },
      }],
    }, {
      scope: 'user',
      packageRoot: 'D:/templates/image-ui',
      manifestPath: 'D:/templates/image-ui/manifest.v2.json',
    });
    service = new ProjectWorkspaceService(
      fileAccess as unknown as IFileAccess,
      projectResources,
      session,
      setProjectRoot,
      () => [imageUi],
    );

    const result = await service.createProjectAt('D:/projects/demo', 'Demo', {
      templates: { enabledTemplateIds: ['image-ui'] },
    });

    if (!result.success) throw new Error(result.error);
    expect(result.project.metadata.templates?.dialoguePresentation).toMatchObject({
      renderer: 'image-dialogue-v1',
      styleId: 'image-ui.default',
      textbox: { image: 'images/templates/image-ui/ui/dialogue/textbox.png' },
      namebox: { image: 'images/templates/image-ui/ui/dialogue/namebox.png' },
      text: {
        fontFile: 'images/templates/image-ui/fonts/dialogue.ttf',
        fontFamily: 'Image UI Dialogue',
      },
    });
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'D:/templates/image-ui/assets/ui/dialogue/textbox.png',
      'D:/projects/demo/images/templates/image-ui/ui/dialogue/textbox.png',
    );
    expect(fileAccess.copyFile).toHaveBeenCalledWith(
      'D:/templates/image-ui/assets/fonts/dialogue.ttf',
      'D:/projects/demo/images/templates/image-ui/fonts/dialogue.ttf',
    );
    const prepared = await service.prepareDialogueStyle('image-ui.default');
    expect(prepared.dialoguePresentation).toMatchObject({
      renderer: 'image-dialogue-v1',
      styleId: 'image-ui.default',
      textbox: { image: 'images/templates/image-ui/ui/dialogue/textbox.png' },
    });
  });

  it('initializes the default scene with selected template character presets', async () => {
    const mygo = createLoadedTemplatePackage({
      template: { id: 'mygo', name: 'MyGO', version: '1.0.0' },
      characterPresets: [{
        id: 'lead',
        name: 'MyGO Lead',
        speakerColor: '#8db7ff',
        variants: [
          { id: 'school', name: 'School', model: 'assets/mygo/school.model3.json' },
          { id: 'stage', name: 'Stage', model: 'assets/mygo/stage.model3.json' },
        ],
      }],
    }, {
      scope: 'user',
      packageRoot: '/library/template/mygo',
      manifestPath: '/library/template/mygo/manifest.json',
    });
    const mujica = createLoadedTemplatePackage({
      template: { id: 'mujica', name: 'Mujica', version: '1.0.0' },
      characterPresets: [{
        id: 'lead',
        name: 'Mujica Lead',
        speakerColor: '#d8d0ff',
        variants: [
          { id: 'stage', name: 'Stage', model: 'assets/mujica/stage.model3.json' },
        ],
      }],
    }, {
      scope: 'user',
      packageRoot: '/library/template/mujica',
      manifestPath: '/library/template/mujica/manifest.json',
    });

    service = new ProjectWorkspaceService(
      fileAccess as unknown as IFileAccess,
      projectResources,
      session,
      setProjectRoot,
      () => [mygo, mujica],
      {
        importAssetPath: vi.fn(async (sourcePath: string) =>
          sourcePath.includes('/mujica/')
            ? sourcePath.replace('/library/template/mujica/', '')
            : sourcePath.replace('/library/template/mygo/', ''),
        ),
        importTemplateAssetPath: vi.fn(async (sourcePath: string) =>
          sourcePath.includes('/mujica/')
            ? sourcePath.replace('/library/template/mujica/', '')
            : sourcePath.replace('/library/template/mygo/', ''),
        ),
      },
    );

    const result = await service.createProjectAt('D:/projects/demo', 'Demo', {
      templates: {
        enabledTemplateIds: ['mygo', 'mujica'],
        defaults: { dialogueStyleId: 'glass' },
        selectedCharacterPresetIds: ['lead'],
        characterVariantImportMode: 'all',
      },
    });

    if (!result.success) {
      throw new Error(`createProjectAt failed: ${result.error}`);
    }
    const sceneWrite = fileAccess.writeFile.mock.calls.find((call: any[]) =>
      call[0] === 'D:/projects/demo/project/main.scene.json',
    );
    expect(sceneWrite).toBeTruthy();
    const scene = JSON.parse(sceneWrite[1]);
    expect(scene.meta.characters).toEqual([{
      id: 'lead',
      name: 'Mujica Lead',
      model: 'assets/mujica/stage.model3.json',
      color: '#d8d0ff',
      variants: [
        { name: 'Stage', model: 'assets/mujica/stage.model3.json' },
      ],
    }]);
  });

  it('defaults to copying only the primary template character model', async () => {
    const templatePackage = createLoadedTemplatePackage({
      template: { id: 'mygo', name: 'MyGO', version: '1.0.0' },
      characterPresets: [{
        id: 'soyo',
        name: 'Soyo',
        model: 'game/figure/soyo/school_winter-2023/model.json',
        variants: [
          { id: 'winter', name: 'Winter', model: 'game/figure/soyo/school_winter-2023/model.json' },
          { id: 'casual', name: 'Casual', model: 'game/figure/soyo/casual-2023/model.json' },
        ],
      }],
    }, {
      scope: 'user',
      packageRoot: '/library/template/mygo',
      manifestPath: '/library/template/mygo/manifest.json',
    });
    const importTemplateAssetPath = vi.fn(async (sourcePath: string) =>
      sourcePath.replace('/library/template/mygo/game/', 'game/'),
    );

    service = new ProjectWorkspaceService(
      fileAccess as unknown as IFileAccess,
      projectResources,
      session,
      setProjectRoot,
      () => [templatePackage],
      {
        importAssetPath: vi.fn(),
        importTemplateAssetPath,
      },
    );

    const result = await service.createProjectAt('D:/projects/demo', 'Demo', {
      templates: {
        enabledTemplateIds: ['mygo'],
        defaults: { dialogueStyleId: 'glass' },
        selectedCharacterPresetIds: ['soyo'],
      },
    });

    if (!result.success) {
      throw new Error(`createProjectAt failed: ${result.error}`);
    }
    expect(importTemplateAssetPath).toHaveBeenCalledWith(
      '/library/template/mygo/game/figure/soyo/school_winter-2023/model.json',
      '/library/template/mygo',
      'figure',
    );
    expect(importTemplateAssetPath).not.toHaveBeenCalledWith(
      '/library/template/mygo/game/figure/soyo/casual-2023/model.json',
      '/library/template/mygo',
      'figure',
    );

    const sceneWrite = fileAccess.writeFile.mock.calls.find((call: any[]) =>
      call[0] === 'D:/projects/demo/project/main.scene.json',
    );
    const scene = JSON.parse(sceneWrite[1]);
    expect(scene.meta.characters[0].model).toBe('game/figure/soyo/school_winter-2023/model.json');
    expect(scene.meta.characters[0].variants).toBeUndefined();
  });

  it('opens a project and returns the default scene path without reading scene JSON', async () => {
    fileAccess.readFile.mockResolvedValue({
      path: 'D:/projects/demo/project.json',
      data: JSON.stringify({
        projectId: 'demo',
        name: 'Demo',
        projectVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        defaultSceneId: 'main',
        scenes: [{ id: 'main', name: 'Main', path: 'project/main.scene.json' }],
        assetRoots: {
          figure: 'figure',
          background: 'background',
          bgm: 'bgm',
          vocal: 'vocal',
          images: 'images',
          animation: 'animation',
          project: 'project',
          template: 'template',
        },
      }),
    });

    const result = await service.openProjectAt('D:/projects/demo/project.json');

    if (!result.success) {
      throw new Error(`openProjectAt failed: ${result.error}`);
    }
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.scenePath).toBe('D:/projects/demo/project/main.scene.json');
      expect(result.project.metadata.templates).toEqual({
        enabledTemplateIds: ['aeonstagery.default'],
        defaults: undefined,
        selectedCharacterPresetIds: [],
        characterVariantImportMode: 'primary-only',
      });
      expect(setProjectRoot).toHaveBeenCalledWith('D:/projects/demo');
    }
  });

  it('creates a collaboration project when the selected join directory is empty', async () => {
    fileAccess.exists.mockImplementation(async (pathValue: string) => !pathValue.endsWith('/project.json'));
    fileAccess.readDir.mockResolvedValue([]);

    const result = await service.prepareCollaborationProjectAt('D:/projects/join', 'Join Session');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.project.rootPath).toBe('D:/projects/join');
      expect(result.scenePath).toBe('D:/projects/join/project/main.scene.json');
    }
    expect(fileAccess.readDir).toHaveBeenCalledWith('D:/projects/join');
    expect(fileAccess.writeFile).toHaveBeenCalledWith(
      'D:/projects/join/project/main.scene.json',
      expect.stringContaining('"title": "Join Session"'),
    );
  });

  it('opens an existing project as a collaboration join directory', async () => {
    fileAccess.exists.mockResolvedValue(true);
    fileAccess.readFile.mockResolvedValue({
      path: 'D:/projects/existing/project.json',
      data: JSON.stringify({
        projectId: 'existing',
        name: 'Existing',
        projectVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        defaultSceneId: 'main',
        scenes: [{ id: 'main', name: 'Main', path: 'project/main.scene.json' }],
        assetRoots: {
          figure: 'figure',
          background: 'background',
          bgm: 'bgm',
          vocal: 'vocal',
          images: 'images',
          animation: 'animation',
          project: 'project',
          template: 'template',
        },
      }),
    });

    const result = await service.prepareCollaborationProjectAt('D:/projects/existing', 'Ignored');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.project.metadata.name).toBe('Existing');
      expect(result.scenePath).toBe('D:/projects/existing/project/main.scene.json');
    }
    expect(fileAccess.readDir).not.toHaveBeenCalled();
  });

  it('repairs a collaboration join project that has no default scene metadata', async () => {
    fileAccess.exists.mockResolvedValue(true);
    fileAccess.readFile.mockResolvedValue({
      path: 'D:/projects/existing/project.json',
      data: JSON.stringify({
        projectId: 'existing',
        name: 'Existing',
        projectVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        defaultSceneId: 'missing',
        scenes: [],
        assetRoots: {
          figure: 'figure',
          background: 'background',
          bgm: 'bgm',
          vocal: 'vocal',
          images: 'images',
          animation: 'animation',
          project: 'project',
          template: 'template',
        },
      }),
    });

    const result = await service.prepareCollaborationProjectAt('D:/projects/existing', 'Ignored');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.scenePath).toBe('D:/projects/existing/project/main.scene.json');
      expect(result.project.metadata.defaultSceneId).toBe('main');
      expect(result.project.metadata.scenes).toEqual([
        { id: 'main', name: 'Main Scene', path: 'project/main.scene.json' },
      ]);
    }
  });

  it('keeps the first registered custom scene when the default scene id is invalid', async () => {
    fileAccess.exists.mockResolvedValue(true);
    fileAccess.readFile.mockResolvedValue({
      path: 'D:/projects/custom/project.json',
      data: JSON.stringify({
        projectId: 'custom',
        name: 'Custom',
        projectVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        defaultSceneId: 'missing',
        scenes: [
          { id: 'intro', name: 'Intro', path: 'project/intro.scene.json' },
          { id: 'outro', name: 'Outro', path: 'project/outro.scene.json' },
        ],
        assetRoots: {
          figure: 'figure',
          background: 'background',
          bgm: 'bgm',
          vocal: 'vocal',
          images: 'images',
          animation: 'animation',
          project: 'project',
          template: 'template',
        },
      }),
    });

    const result = await service.prepareCollaborationProjectAt('D:/projects/custom', 'Ignored');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.scenePath).toBe('D:/projects/custom/project/intro.scene.json');
      expect(result.project.metadata.defaultSceneId).toBe('intro');
      expect(result.project.metadata.scenes).toHaveLength(2);
    }
  });

  it('rejects a non-empty collaboration join directory without project metadata', async () => {
    fileAccess.exists.mockImplementation(async (pathValue: string) => !pathValue.endsWith('/project.json'));
    fileAccess.readDir.mockResolvedValue([
      { name: 'notes.txt', isDirectory: false, path: 'D:/projects/bad/notes.txt' },
    ]);

    const result = await service.prepareCollaborationProjectAt('D:/projects/bad', 'Join Session');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/空目录/);
    }
    expect(fileAccess.writeFile).not.toHaveBeenCalled();
    expect(setProjectRoot).not.toHaveBeenCalled();
  });

  it('serializes voice generation metadata saves so the last preset wins', async () => {
    const created = await service.createProjectAt('D:/projects/demo', 'Demo');
    if (!created.success) {
      throw new Error(`createProjectAt failed: ${created.error}`);
    }

    fileAccess.writeFile.mockReset();
    const projectWrites: string[] = [];
    let resolveFirstWrite!: () => void;
    let resolveSecondWrite!: () => void;
    fileAccess.writeFile.mockImplementation(async (pathValue: string, data: string) => {
      if (!pathValue.endsWith('project.json')) return;
      projectWrites.push(data);
      if (projectWrites.length === 1) {
        await new Promise<void>((resolve) => { resolveFirstWrite = resolve; });
      } else if (projectWrites.length === 2) {
        await new Promise<void>((resolve) => { resolveSecondWrite = resolve; });
      }
    });

    const firstSave = service.updateVoiceGenerationConfiguration({
      gptSovits: {
        selectedPresetId: 'first_voice',
        presets: [{
          id: 'first_voice',
          name: 'First Voice',
          gptWeightsPath: 'D:/models/first.ckpt',
          sovitsWeightsPath: 'D:/models/first.pth',
          refAudioPath: 'D:/refs/first.wav',
          promptText: 'first',
          promptLang: 'zh',
          textLang: 'zh',
          speed: 1,
        }],
      },
    });
    const secondSave = service.updateVoiceGenerationConfiguration({
      gptSovits: {
        selectedPresetId: 'second_voice',
        presets: [{
          id: 'second_voice',
          name: 'Second Voice',
          gptWeightsPath: 'D:/models/second.ckpt',
          sovitsWeightsPath: 'D:/models/second.pth',
          refAudioPath: 'D:/refs/second.wav',
          promptText: 'second',
          promptLang: 'zh',
          textLang: 'zh',
          speed: 1,
        }],
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(projectWrites).toHaveLength(1);
    expect(projectWrites[0]).toContain('"selectedPresetId": "first_voice"');

    resolveFirstWrite();
    await firstSave;
    await Promise.resolve();
    expect(projectWrites).toHaveLength(2);
    expect(projectWrites[1]).toContain('"selectedPresetId": "second_voice"');

    resolveSecondWrite();
    const secondResult = await secondSave;
    expect(secondResult.success).toBe(true);
    expect(service.getCurrentProject()?.metadata.voiceGeneration?.gptSovits?.selectedPresetId).toBe('second_voice');
  });

  it('seeds the default scene with a converted WebGAL script when provided', async () => {
    const script = [
      'changeBg:A.png;',
      ':你好。;',
      'changeFigure:soyo/model.json -id=1;',
      'Soyo:晚上好 -figureId=1;',
    ].join('\n');
    const result = await service.createProjectAt('D:/projects/webgal-demo', 'WebGal Demo', {
      webgal: { scriptText: script, mountId: 'webgal-sv' },
    });

    if (!result.success) {
      throw new Error(`createProjectAt failed: ${result.error}`);
    }
    expect(result.success).toBe(true);
    const webgalReport = result.webgalReport;
    expect(webgalReport).toBeDefined();
    if (!webgalReport) return;
    expect(webgalReport.stats.dialogueCount + webgalReport.stats.narrationCount).toBe(2);

    const sceneCall = fileAccess.writeFile.mock.calls.find((call: unknown[]) =>
      String(call[0]).endsWith('project/main.scene.json'));
    expect(sceneCall).toBeDefined();
    const scene = JSON.parse(String((sceneCall as unknown[])[1])) as CurrentSceneDocument;

    expect(scene.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
    expect(scene.meta.title).toBe('WebGal Demo');
    expect(scene.statements.length).toBeGreaterThan(0);
    expect(JSON.stringify(scene)).toContain('@mount/webgal-sv/figure/');

    const dialogue = scene.statements.find((statement) =>
      statement.type === 'dialogue' && 'speakerId' in statement.params);
    const dialogueSpeakerId = (dialogue?.params as unknown as { speakerId?: string } | undefined)?.speakerId;
    expect(dialogueSpeakerId).toBe('soyo');
    const characterIds = (scene.meta.characters ?? []).map((character) => character.id);
    expect(characterIds).toContain('soyo');

    expect(() => sceneDocumentCodec.parseAndValidate(scene)).not.toThrow();
  });

  it('keeps an import receipt and regenerates the scene with a new speed', async () => {
    const script = [
      'changeBg:A.png;',
      ':你好。;',
      'changeFigure:soyo/model.json -id=1;',
      'Soyo:晚上好 -figureId=1;',
    ].join('\n');
    const created = await service.createProjectAt('D:/projects/webgal-reg', 'WebGal Reg', {
      webgal: { scriptText: script, scriptName: 'chapter1.txt', mountId: 'webgal-sv', speed: 1 },
    });
    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(created.project.metadata.webGalImport).toBeDefined();
    expect(created.project.metadata.webGalImport?.scriptName).toBe('chapter1.txt');
    expect(created.project.metadata.webGalImport?.scenePath).toBe('project/main.scene.json');
    expect(created.project.metadata.webGalImport?.report?.stats.dialogueCount).toBe(1);
    expect(created.project.metadata.webGalImport?.report?.characters.some((character) => character.id === 'soyo')).toBe(true);

    const sceneWrites = () => fileAccess.writeFile.mock.calls.filter((call: unknown[]) =>
      String(call[0]).endsWith('main.scene.json'));
    const firstScene = JSON.parse(String(sceneWrites()[0][1])) as CurrentSceneDocument;
    const firstDuration = (firstScene.statements.find((s) => s.type === 'dialogue') as any).params.durationSeconds;

    const regenerated = await service.regenerateWebGalScene({ speed: 2 });
    expect(regenerated.success).toBe(true);
    if (!regenerated.success) return;

    const writes = sceneWrites();
    const secondScene = JSON.parse(String(writes[writes.length - 1][1])) as CurrentSceneDocument;
    const secondDuration = (secondScene.statements.find((s) => s.type === 'dialogue') as any).params.durationSeconds;
    expect(secondDuration).toBeLessThan(firstDuration);
    expect(service.getCurrentProject()?.metadata.webGalImport?.speed).toBe(2);
    expect(service.getCurrentProject()?.metadata.webGalImport?.report?.stats.dialogueCount).toBe(1);
    expect(secondScene.statements.length).toBe(firstScene.statements.length);
  });

  it('regenerateWebGalScene reports when no import receipt exists', async () => {
    await service.createProjectAt('D:/projects/webgal-none', 'WebGal None');
    const result = await service.regenerateWebGalScene();
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('导入凭据');
  });

  it('merges multiple WebGAL scripts into one continuous scene timeline', async () => {
    const script1 = [
      'changeBg:A.png;',
      ':第一话开场。;',
      'changeFigure:soyo/model.json -id=1;',
      'Soyo:晚上好 -figureId=1;',
    ].join('\n');
    const script2 = [
      'changeBg:B.png;',
      ':第二话开场。;',
      'Soyo:欢迎回来 -figureId=1;',
    ].join('\n');
    const result = await service.createProjectAt('D:/projects/webgal-multi', 'WebGal Multi', {
      webgal: {
        scriptText: script1,
        scriptName: '2.txt',
        additionalScripts: [{ scriptText: script2, scriptName: '3.txt' }],
        mountId: 'webgal-sv',
        speed: 1.5,
      },
    });

    if (!result.success) {
      throw new Error(`createProjectAt failed: ${result.error}`);
    }
    const report = result.webgalReport;
    expect(report).toBeDefined();
    if (!report) return;
    expect(report.stats.dialogueCount + report.stats.narrationCount).toBe(4);

    const receipt = result.project.metadata.webGalImport;
    expect(receipt?.scriptName).toBe('2.txt + 3.txt');
    expect(receipt?.scriptNames).toEqual(['2.txt', '3.txt']);
    expect(receipt?.scriptText).toContain('第一话开场');
    expect(receipt?.scriptText).toContain('第二话开场');
    // The boundary between chapters carries the black-screen marker by default.
    expect(receipt?.scriptText).toContain('chapterBreak:black;');

    const sceneCall = fileAccess.writeFile.mock.calls.find((call: unknown[]) =>
      String(call[0]).endsWith('project/main.scene.json'));
    expect(sceneCall).toBeDefined();
    const scene = JSON.parse(String((sceneCall as unknown[])[1])) as CurrentSceneDocument;

    // The boundary exits the character left on stage from chapter 1.
    const boundaryExits = scene.statements.filter((statement) =>
      statement.type === 'characterPresence' && statement.params.mode === 'exit');
    expect(boundaryExits).toHaveLength(1);
    expect((boundaryExits[0].params as { id?: string }).id).toBe('soyo');

    // One continuous timeline: every statement sorted by time across chapters.
    const times = scene.statements.map((statement) => statement.time);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]).toBeGreaterThanOrEqual(times[index - 1]);
    }

    // The second chapter's lines play strictly after the first chapter's lines.
    const dialogueTimes = scene.statements
      .filter((statement) => statement.type === 'dialogue')
      .map((statement) => statement.time);
    expect(dialogueTimes.length).toBe(4);
    expect(dialogueTimes[2]).toBeGreaterThan(dialogueTimes[0]);
    expect(dialogueTimes[2]).toBeGreaterThan(dialogueTimes[1]);

    // The speaker from chapter 1 stays the same character in chapter 2.
    expect((scene.meta.characters ?? []).filter((character) => character.id === 'soyo')).toHaveLength(1);
    expect(scene.meta.title).toBe('WebGal Multi');
  });
});

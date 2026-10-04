import { describe, expect, it } from 'vitest';
import {
  TemplateAssetResolver,
  TemplatePackageDiscovery,
  TemplatePackageLoader,
  buildTemplateAuthoringPreview,
  createLoadedTemplatePackage,
  createTemplatePackageView,
  parseTemplatePackageManifest,
  resolveTemplateDefaults,
  templateAuthoringComboToSemanticIntent,
} from '../services/template-package';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import {
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import { SemanticTimelineAuthoringService } from '../services/timeline-authoring/SemanticTimelineAuthoringService';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_v2',
    meta: {
      title: 'Test',
      characters: [{ id: 'tomori', name: 'Tomori' }],
    },
    statements: [],
  };
}

describe('template package loader', () => {
  it('validates image dialogue styles while keeping package-relative UI and font assets', () => {
    const manifest = parseTemplatePackageManifest({
      manifestSchemaVersion: 2,
      template: {
        id: 'image-dialogue',
        name: 'Image Dialogue',
        version: '1.0.0',
        compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
      },
      assets: { root: 'assets' },
      dialogueStyles: [{
        id: 'image-dialogue.default',
        name: 'Default',
        renderer: 'image-dialogue-v1',
        params: {
          textbox: { image: 'ui/dialogue/textbox.png', nineSlice: [48, 48, 48, 48], x: 120, y: 760, width: 1680, minHeight: 240 },
          namebox: { image: 'ui/dialogue/namebox.png', x: 160, y: 690, width: 320, height: 88 },
          text: { fontFile: 'fonts/dialogue.ttf', fontFamily: 'Template Dialogue', fontSize: 46, x: 190, y: 820, maxWidth: 1500 },
          speaker: { fontFamily: 'Template Dialogue', fontSize: 40, color: '$characterColor' },
        },
      }],
    });

    expect(manifest.dialogueStyles?.[0]).toEqual(expect.objectContaining({
      renderer: 'image-dialogue-v1',
      params: expect.objectContaining({
        textbox: expect.objectContaining({ image: 'ui/dialogue/textbox.png' }),
        text: expect.objectContaining({ fontFile: 'fonts/dialogue.ttf' }),
      }),
    }));
  });

  it('rejects an image dialogue font file without a stable font family', () => {
    expect(() => parseTemplatePackageManifest({
      manifestSchemaVersion: 2,
      template: {
        id: 'bad-image-dialogue',
        name: 'Bad Image Dialogue',
        version: '1.0.0',
        compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
      },
      dialogueStyles: [{
        id: 'bad',
        name: 'Bad',
        renderer: 'image-dialogue-v1',
        params: {
          textbox: { image: 'ui/dialogue/textbox.png', x: 0, y: 700, width: 1920, height: 380 },
          text: { fontFile: 'fonts/dialogue.ttf', x: 100, y: 780, maxWidth: 1720 },
        },
      }],
    })).toThrow(/fontFamily is required/);
  });

  it('loads declarative voice profiles and validates character and asset references', async () => {
    const files = new Map<string, string>([
      ['/templates/voices/manifest.v2.json', JSON.stringify({
        manifestSchemaVersion: 2,
        template: {
          id: 'voices',
          name: 'Voices',
          version: '1.0.0',
          compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
        },
        assets: { index: [{ id: 'tomori-ref', path: 'assets/tomori.wav', kind: 'audio' }] },
        voiceProfiles: [{ id: 'tomori', name: 'Tomori', file: 'profiles/tomori.json' }],
        characterPresets: [{ id: 'tomori-character', name: 'Tomori', model: 'assets/tomori.model3.json', voiceProfileId: 'tomori' }],
      })],
      ['/templates/voices/profiles/tomori.json', JSON.stringify({
        gptModel: { fileName: 'tomori.ckpt', relativePathSuffix: 'Tomori/tomori.ckpt' },
        sovitsModel: { fileName: 'tomori.pth' },
        references: [{ id: 'primary', label: 'Primary', assetId: 'tomori-ref', role: 'primary', promptText: 'Hello', promptLang: 'en' }],
        inferenceDefaults: { textLang: 'en', speed: 1 },
      })],
    ]);
    const loader = new TemplatePackageLoader({
      readFile: async (path: string) => ({ data: files.get(path) ?? '', path }),
      join: async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
      dirname: async (path: string) => path.slice(0, path.lastIndexOf('/')) || '/',
    });

    const loaded = await loader.loadFromPackageRoot('user', '/templates/voices');
    const view = createTemplatePackageView([loaded]);

    expect(view.voiceProfiles[0]).toEqual(expect.objectContaining({
      id: 'tomori',
      gptModel: { fileName: 'tomori.ckpt', relativePathSuffix: 'Tomori/tomori.ckpt' },
      references: [expect.objectContaining({ assetId: 'tomori-ref' })],
      source: expect.objectContaining({ templateId: 'voices' }),
    }));
    expect(view.characterPresets[0].voiceProfileId).toBe('tomori');
  });

  it('builds commit-ready previews for every semantic template payload kind', () => {
    const input = {
      anchorTime: 8,
      correlationId: 'preview_all_payloads',
      scope: { kind: 'character' as const, charId: 'tomori' },
    };
    const statementPreview = buildTemplateAuthoringPreview({ payload: {
      kind: 'statementPreset',
      statement: { type: 'audio', params: { role: 'sfx', mode: 'play', instanceId: 'hit', file: 'audio/hit.wav' } },
    } }, input)!;
    const dialoguePreview = buildTemplateAuthoringPreview({ payload: {
      kind: 'dialoguePreset',
      dialogue: { type: 'dialogue', params: { speakerId: 'tomori', text: 'Hello', durationSeconds: 2 } },
      companions: [{ type: 'camera', anchor: 'start', offset: 0.25, params: { mode: 'focus', target: '$speaker' } }],
    } }, input)!;
    const fragmentPreview = buildTemplateAuthoringPreview({ payload: {
      kind: 'timelineFragment',
      statements: [
        { time: 0, type: 'characterPerformance', params: { target: '$character', expression: 'smile' } },
        { time: 1.5, type: 'filterReset', params: {} },
      ],
    } }, input)!;

    expect(statementPreview).toEqual(expect.objectContaining({ rootCount: 1, companionCount: 0 }));
    expect(dialoguePreview).toEqual(expect.objectContaining({ rootCount: 1, companionCount: 1 }));
    expect(dialoguePreview.summaryLines[0]).toContain('1 companions');
    expect(fragmentPreview).toEqual(expect.objectContaining({ rootCount: 2, companionCount: 0 }));
    expect(fragmentPreview.summaryLines[1]).toContain('+1.5s');
    expect(fragmentPreview.statements[0].params).toEqual(expect.objectContaining({ target: 'tomori' }));

    expect(statementPreview.intent.kind).toBe('insert-statement');
    if (statementPreview.intent.kind === 'insert-statement') {
      expect(statementPreview.statements[0]).toBe(statementPreview.intent.statement);
    }
    expect(fragmentPreview.intent.kind).toBe('insert-script-segment');
    if (fragmentPreview.intent.kind === 'insert-script-segment') {
      expect(fragmentPreview.statements).toBe(fragmentPreview.intent.statements);
    }
  });

  it('rejects legacy manifest content on the normal manifest.v2 loader path', async () => {
    const loader = new TemplatePackageLoader({
      readFile: async (path: string) => ({
        data: JSON.stringify({
          template: { id: 'legacy.template', name: 'Legacy', version: '1.0.0' },
        }),
        path,
      }),
      join: async (...parts: string[]) => parts.join('/'),
      dirname: async (path: string) => path.slice(0, path.lastIndexOf('/')) || '/',
    });

    await expect(loader.loadFromManifestPath('user', '/templates/legacy/manifest.v2.json'))
      .rejects.toThrow('requires manifestSchemaVersion 2');
  });
  it('parses authoring combos from canonical manifest JSON', () => {
    const manifest = parseTemplatePackageManifest({
      template: {
        id: 'template.test',
        name: 'Test Template',
        version: '1.0.0',
      },
      assets: {
        index: [
          {
            id: 'logo',
            path: 'assets/logo.png',
            kind: 'image',
            label: 'Logo',
          },
        ],
      },
      characterPresets: [
        {
          id: 'host',
          name: 'Host',
          variants: [
            {
              id: 'casual',
              name: 'Casual',
              model: 'assets/characters/host/casual.model3.json',
            },
          ],
        },
      ],
      authoringCombos: [
        {
          id: 'combo_1',
          name: 'Combo',
          category: 'dialogue',
          actions: [
            {
              action: 'dialogue',
              delay: 0.2,
              params: { text: 'Hello' },
            },
          ],
        },
      ],
      lightingPresets: [
        {
          id: 'soft_studio',
          name: 'Soft Studio',
          params: { preset: 'normal' },
        },
      ],
    });

    expect(manifest.authoringCombos?.[0]).toEqual(expect.objectContaining({
      id: 'combo_1',
      category: 'dialogue',
    }));
    expect(manifest.assets?.index?.[0]).toEqual(expect.objectContaining({
      id: 'logo',
      label: 'Logo',
    }));
    expect(manifest.characterPresets?.[0].variants?.[0]).toEqual(expect.objectContaining({
      id: 'casual',
      model: 'assets/characters/host/casual.model3.json',
    }));
    expect(manifest.lightingPresets?.[0]).toEqual(expect.objectContaining({
      id: 'soft_studio',
    }));
  });

  it('merges package views by source precedence and keeps source metadata', () => {
    const builtin = createLoadedTemplatePackage({
      template: { id: 'builtin.default', name: 'Builtin', version: '1.0.0' },
      authoringCombos: [{
        id: 'shared_combo',
        name: 'Builtin Combo',
        category: 'dialogue',
        actions: [{ action: 'dialogue', params: { text: 'builtin' }, delay: 0 }],
      }],
    }, {
      scope: 'builtin',
      packageRoot: 'templates/default',
      manifestPath: 'templates/default/manifest.json',
    });
    const project = createLoadedTemplatePackage({
      template: { id: 'project.default', name: 'Project', version: '1.0.0' },
      authoringCombos: [{
        id: 'shared_combo',
        name: 'Project Combo',
        category: 'dialogue',
        actions: [{ action: 'dialogue', params: { text: 'project' }, delay: 0 }],
      }],
    }, {
      scope: 'project',
      packageRoot: '/project/template/default',
      manifestPath: '/project/template/default/manifest.json',
    });

    const view = createTemplatePackageView([builtin, project]);

    expect(view.authoringCombos).toHaveLength(1);
    expect(view.authoringCombos[0]).toEqual(expect.objectContaining({
      id: 'shared_combo',
      name: 'Project Combo',
      source: expect.objectContaining({
        scope: 'project',
        templateId: 'project.default',
      }),
    }));
  });

  it('parses manifest v2 authoring combo payloads for semantic scene templates', () => {
    const manifest = parseTemplatePackageManifest({
      manifestSchemaVersion: 2,
      template: {
        id: 'semantic.template',
        name: 'Semantic Template',
        version: '2.0.0',
        compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
      },
      authoringCombos: [{
        id: 'dialogue_focus',
        name: 'Dialogue Focus',
        category: 'dialogue',
        payload: {
          kind: 'dialoguePreset',
          dialogue: {
            type: 'dialogue',
            params: { text: '', durationSeconds: 3 },
          },
          companions: [{
            type: 'camera',
            anchor: 'start',
            offset: 0,
            params: {
              mode: 'focus',
              target: '$speaker',
            },
          }],
        },
      }],
    });

    expect(manifest.manifestSchemaVersion).toBe(2);
    expect(manifest.authoringCombos?.[0]).toEqual(expect.objectContaining({
      id: 'dialogue_focus',
      payload: expect.objectContaining({
        kind: 'dialoguePreset',
        companions: [expect.objectContaining({ type: 'camera' })],
      }),
    }));
    const view = createTemplatePackageView([
      createLoadedTemplatePackage(manifest, {
        scope: 'builtin',
        packageRoot: '/templates/semantic',
      }),
    ]);

    expect(view.authoringCombos).toEqual([]);
    expect(view.semanticAuthoringCombos).toEqual([
      expect.objectContaining({
        id: 'dialogue_focus',
        payload: expect.objectContaining({ kind: 'dialoguePreset' }),
        source: expect.objectContaining({
          templateId: 'semantic.template',
          packageRoot: '/templates/semantic',
        }),
      }),
    ]);
  });

  it('converts semantic template payloads into v2 statement authoring intents', () => {
    const view = createTemplatePackageView([
      createLoadedTemplatePackage({
        manifestSchemaVersion: 2,
        template: {
          id: 'semantic.template',
          name: 'Semantic Template',
          version: '2.0.0',
          compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
        },
        authoringCombos: [{
          id: 'dialogue_focus',
          name: 'Dialogue Focus',
          category: 'dialogue',
          payload: {
            kind: 'dialoguePreset',
            dialogue: {
              type: 'dialogue',
              params: { speakerId: 'tomori', text: 'hello', durationSeconds: 2 },
            },
            companions: [{
              type: 'camera',
              anchor: 'start',
              offset: 0,
              params: { mode: 'focus', target: '$speaker' },
            }],
          },
        }],
      }, {
        scope: 'builtin',
        packageRoot: '/templates/semantic',
      }),
    ]);
    let statementIndex = 0;
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
    });
    const intent = templateAuthoringComboToSemanticIntent(view.semanticAuthoringCombos[0], {
      anchorTime: 4,
      correlationId: 'intent_template_v2',
      origin: 'template-config',
      scope: { kind: 'character', charId: 'tomori' },
    });

    expect(intent).toEqual(expect.objectContaining({
      version: AUTHORING_SCHEMA_VERSION,
      kind: 'insert-statement',
      anchorTime: 4,
      statement: expect.objectContaining({
        type: 'dialogue',
        companions: [expect.objectContaining({ type: 'camera' })],
      }),
    }));

    const result = service.author(makeDocument(), intent!);

    expect(result.document.statements).toEqual([
      expect.objectContaining({
        id: 'dlg_1',
        type: 'dialogue',
        time: 4,
        companions: [
          expect.objectContaining({
            id: 'cmp_camera_2',
            type: 'camera',
          }),
        ],
      }),
    ]);
    expect(result.receipt).toEqual(expect.objectContaining({
      intentType: 'insert-statement',
      createdStatementIds: ['dlg_1'],
      timeRange: { start: 4, end: 6 },
    }));
    expect(result.receipt).not.toHaveProperty('createdActionIds');
  });

  it('rejects manifest v2 authoring combos that still use legacy action arrays', () => {
    expect(() => parseTemplatePackageManifest({
      manifestSchemaVersion: 2,
      template: {
        id: 'semantic.template',
        name: 'Semantic Template',
        version: '2.0.0',
        compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
      },
      authoringCombos: [{
        id: 'legacy_combo',
        name: 'Legacy Combo',
        category: 'dialogue',
        actions: [{ action: 'dialogue', params: { text: 'legacy' } }],
      }],
    })).toThrow(/must use payload, not legacy actions/);
  });

  it('requires manifest v2 templates to declare scene schema compatibility', () => {
    expect(() => parseTemplatePackageManifest({
      manifestSchemaVersion: 2,
      template: {
        id: 'semantic.template',
        name: 'Semantic Template',
        version: '2.0.0',
      },
    })).toThrow(/sceneSchemaVersion=4/);
  });

  it('loads package-local authoring combo files from manifest references', async () => {
    const files = new Map<string, string>([
      ['/templates/default/manifest.v2.json', JSON.stringify({
        manifestSchemaVersion: 2,
        template: {
          id: 'template.default',
          name: 'Default',
          version: '2.0.0',
          compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
        },
        authoringCombos: [{
          id: 'combo_file',
          name: 'Combo File',
          category: 'camera',
          file: 'combos/camera.json',
        }],
      })],
      ['/templates/default/combos/camera.json', JSON.stringify({
        payload: {
          kind: 'statementPreset',
          statement: {
            type: 'camera',
            params: { mode: 'follow', operation: 'start' },
          },
        },
      })],
    ]);
    const loader = new TemplatePackageLoader({
      readFile: async (path: string) => ({ data: files.get(path) ?? '', path }),
      join: async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
      dirname: async (path: string) => path.slice(0, path.lastIndexOf('/')) || '/',
    });

    const loaded = await loader.loadFromManifestPath('builtin', '/templates/default/manifest.v2.json');
    const view = createTemplatePackageView([loaded]);

    expect(view.semanticAuthoringCombos[0]).toEqual(expect.objectContaining({
      id: 'combo_file',
      payload: expect.objectContaining({ kind: 'statementPreset' }),
    }));
  });

  it('loads manifest v2 authoring combo payloads from package-local files', async () => {
    const files = new Map<string, string>([
      ['/templates/semantic/manifest.v2.json', JSON.stringify({
        manifestSchemaVersion: 2,
        template: {
          id: 'semantic.template',
          name: 'Semantic Template',
          version: '2.0.0',
          compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
        },
        authoringCombos: [{
          id: 'statement_file',
          name: 'Statement File',
          category: 'camera',
          file: 'combos/camera.json',
        }],
      })],
      ['/templates/semantic/combos/camera.json', JSON.stringify({
        payload: {
          kind: 'statementPreset',
          statement: {
            type: 'camera',
            params: {
              mode: 'focus',
              position: [0.5, 0.5],
            },
          },
        },
      })],
    ]);
    const loader = new TemplatePackageLoader({
      readFile: async (path: string) => ({ data: files.get(path) ?? '', path }),
      join: async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
      dirname: async (path: string) => path.slice(0, path.lastIndexOf('/')) || '/',
    });

    const loaded = await loader.loadFromPackageRoot('builtin', '/templates/semantic');

    expect(loaded.manifest.authoringCombos?.[0].payload).toEqual({
      kind: 'statementPreset',
      statement: {
        type: 'camera',
        params: {
          mode: 'focus',
          position: [0.5, 0.5],
        },
      },
    });
  });

  it('uses enabled template order within the same scope for every merged capability', () => {
    const mygo = createLoadedTemplatePackage({
      template: { id: 'mygo', name: 'MyGO', version: '1.0.0' },
      assets: { index: [{ id: 'shared_logo', path: 'assets/mygo-logo.png' }] },
      characterPresets: [{ id: 'lead', name: 'MyGO Lead', model: 'assets/lead.model3.json' }],
      authoringCombos: [{
        id: 'shared_combo',
        name: 'MyGO Combo',
        category: 'dialogue',
        actions: [{ action: 'dialogue', params: { text: 'mygo' }, delay: 0 }],
      }],
      dialogueStyles: [{ id: 'shared_dialogue', name: 'MyGO Dialogue', renderer: 'glass' }],
      cameraPresets: [{ id: 'shared_camera', name: 'MyGO Camera', params: { move: 'push' } }],
    }, {
      scope: 'user',
      packageRoot: '/templates/mygo',
      manifestPath: '/templates/mygo/manifest.json',
    });
    const mujica = createLoadedTemplatePackage({
      template: { id: 'mujica', name: 'Mujica', version: '1.0.0' },
      assets: { index: [{ id: 'shared_logo', path: 'assets/mujica-logo.png' }] },
      characterPresets: [{ id: 'lead', name: 'Mujica Lead', model: 'assets/lead.model3.json' }],
      authoringCombos: [{
        id: 'shared_combo',
        name: 'Mujica Combo',
        category: 'dialogue',
        actions: [{ action: 'dialogue', params: { text: 'mujica' }, delay: 0 }],
      }],
      dialogueStyles: [{ id: 'shared_dialogue', name: 'Mujica Dialogue', renderer: 'glass' }],
      cameraPresets: [{ id: 'shared_camera', name: 'Mujica Camera', params: { move: 'pull' } }],
    }, {
      scope: 'user',
      packageRoot: '/templates/mujica',
      manifestPath: '/templates/mujica/manifest.json',
    });

    const view = createTemplatePackageView([mygo, mujica], {
      enabledTemplateIds: ['mygo', 'mujica'],
    });

    expect(view.assetEntries[0]).toEqual(expect.objectContaining({
      id: 'shared_logo',
      path: 'assets/mujica-logo.png',
      source: expect.objectContaining({ templateId: 'mujica' }),
    }));
    expect(view.characterPresets[0]).toEqual(expect.objectContaining({
      id: 'lead',
      name: 'Mujica Lead',
      source: expect.objectContaining({ templateId: 'mujica' }),
    }));
    expect(view.authoringCombos[0]).toEqual(expect.objectContaining({
      id: 'shared_combo',
      name: 'Mujica Combo',
      source: expect.objectContaining({ templateId: 'mujica' }),
    }));
    expect(view.dialogueStyles[0]).toEqual(expect.objectContaining({
      id: 'shared_dialogue',
      name: 'Mujica Dialogue',
      source: expect.objectContaining({ templateId: 'mujica' }),
    }));
    expect(view.cameraPresets[0]).toEqual(expect.objectContaining({
      id: 'shared_camera',
      name: 'Mujica Camera',
      source: expect.objectContaining({ templateId: 'mujica' }),
    }));
  });

  it('resolves template default suggestions by precedence before user overrides', () => {
    const mygo = createLoadedTemplatePackage({
      template: { id: 'mygo', name: 'MyGO', version: '1.0.0' },
      defaults: { dialogueStyleId: 'mygo.glass' },
      dialogueStyles: [{ id: 'mygo.glass', name: 'MyGO Glass', renderer: 'glass' }],
    }, {
      scope: 'user',
      packageRoot: '/templates/mygo',
      manifestPath: '/templates/mygo/manifest.json',
    });
    const mujica = createLoadedTemplatePackage({
      template: { id: 'mujica', name: 'Mujica', version: '1.0.0' },
      defaults: { dialogueStyleId: 'mujica.classic' },
      dialogueStyles: [{ id: 'mujica.classic', name: 'Mujica Classic', renderer: 'classic' }],
    }, {
      scope: 'user',
      packageRoot: '/templates/mujica',
      manifestPath: '/templates/mujica/manifest.json',
    });

    expect(resolveTemplateDefaults([mygo, mujica], {
      enabledTemplateIds: ['mygo', 'mujica'],
    }).dialogueStyleId).toBe('mujica.classic');

    expect(resolveTemplateDefaults([mygo, mujica], {
      enabledTemplateIds: ['mygo', 'mujica'],
    }, {
      dialogueStyleId: 'classic',
    }).dialogueStyleId).toBe('classic');
  });

  it('excludes discovered packages that are not enabled in the project configuration', () => {
    const enabled = createLoadedTemplatePackage({
      template: { id: 'enabled', name: 'Enabled', version: '1.0.0' },
      defaults: { dialogueStyleId: 'enabled.glass' },
      authoringCombos: [{
        id: 'enabled_combo',
        name: 'Enabled Combo',
        category: 'dialogue',
        actions: [{ action: 'dialogue', params: { text: 'enabled' }, delay: 0 }],
      }],
    }, {
      scope: 'user',
      packageRoot: '/templates/enabled',
    });
    const disabled = createLoadedTemplatePackage({
      template: { id: 'disabled', name: 'Disabled', version: '1.0.0' },
      defaults: { dialogueStyleId: 'disabled.glass' },
      authoringCombos: [{
        id: 'disabled_combo',
        name: 'Disabled Combo',
        category: 'dialogue',
        actions: [{ action: 'dialogue', params: { text: 'disabled' }, delay: 0 }],
      }],
    }, {
      scope: 'user',
      packageRoot: '/templates/disabled',
    });

    const view = createTemplatePackageView([enabled, disabled], {
      enabledTemplateIds: ['enabled'],
    });

    expect(view.packages.map((templatePackage) => templatePackage.manifest.template.id)).toEqual(['enabled']);
    expect(view.defaults.dialogueStyleId).toBe('enabled.glass');
    expect(view.authoringCombos.map((combo) => combo.id)).toEqual(['enabled_combo']);
  });

  it('accepts a previous template id as an alias after a package rename', () => {
    const renamed = createLoadedTemplatePackage({
      template: {
        id: 'aeonstagery.mygo',
        aliases: ['webgal.mygo.v3_1_0.portable'],
        name: 'Aeonstagery MyGO Template',
        version: '1.0.0',
      },
      defaults: { dialogueStyleId: 'mygo.static.v3_1_1' },
    }, {
      scope: 'user',
      packageRoot: '/templates/mygo',
    });

    const view = createTemplatePackageView([renamed], {
      enabledTemplateIds: ['webgal.mygo.v3_1_0.portable'],
    });

    expect(view.packages).toHaveLength(1);
    expect(view.packages[0].manifest.template).toMatchObject({
      id: 'aeonstagery.mygo',
      aliases: ['webgal.mygo.v3_1_0.portable'],
    });
    expect(view.defaults.dialogueStyleId).toBe('mygo.static.v3_1_1');
  });

  it('rejects package-relative paths that escape the template root', async () => {
    const resolver = new TemplateAssetResolver({
      join: async (...parts: string[]) => parts.join('/'),
    });
    const templatePackage = createLoadedTemplatePackage({
      template: { id: 'template.test', name: 'Test Template', version: '1.0.0' },
      assets: { root: 'assets' },
    }, {
      scope: 'user',
      packageRoot: '/templates/test',
      manifestPath: '/templates/test/manifest.json',
    });

    await expect(resolver.resolvePackageRelative(templatePackage, '../outside.png')).rejects.toThrow(
      'Path escapes project root',
    );
  });

  it('discovers project and user template packages from library roots without stopping on bad packages', async () => {
    const files = new Map<string, string>([
      ['/project/template/manifest.v2.json', JSON.stringify({
        manifestSchemaVersion: 2,
        template: {
          id: 'project.root',
          name: 'Project Root',
          version: '1.0.0',
          compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
        },
      })],
      ['/project/template/project-pack/manifest.v2.json', JSON.stringify({
        manifestSchemaVersion: 2,
        template: {
          id: 'project.pack',
          name: 'Project Pack',
          version: '1.0.0',
          compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
        },
      })],
      ['/library/template/user-pack/manifest.v2.json', JSON.stringify({
        manifestSchemaVersion: 2,
        template: {
          id: 'user.pack',
          name: 'User Pack',
          version: '1.0.0',
          compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
        },
      })],
      ['/library/template/bad-pack/manifest.v2.json', JSON.stringify({
        manifestSchemaVersion: 2,
        template: {
          id: 'bad.pack',
          name: 'Bad Pack',
          compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
        },
      })],
      ['/library/template/legacy-pack/manifest.json', JSON.stringify({
        template: { id: 'legacy.pack', name: 'Legacy Pack', version: '1.0.0' },
      })],
    ]);
    const dirs = new Map<string, Array<{ name: string; isDirectory: boolean; path: string }>>([
      ['/project/template', [
        { name: 'project-pack', isDirectory: true, path: '/project/template/project-pack' },
      ]],
      ['/library/template', [
        { name: 'user-pack', isDirectory: true, path: '/library/template/user-pack' },
        { name: 'bad-pack', isDirectory: true, path: '/library/template/bad-pack' },
        { name: 'legacy-pack', isDirectory: true, path: '/library/template/legacy-pack' },
      ]],
    ]);
    const discovery = new TemplatePackageDiscovery({
      readFile: async (path: string) => ({ data: files.get(path) ?? '', path }),
      readAsset: async (path: string) => ({ data: files.get(path) ?? '', path }),
      writeFile: async () => undefined,
      ensureDir: async () => undefined,
      copyFile: async () => undefined,
      readDir: async (path: string) => {
        const entries = dirs.get(path);
        if (!entries) throw new Error(`Missing dir: ${path}`);
        return entries;
      },
      exists: async (path: string) => files.has(path) || dirs.has(path),
      showOpenDialog: async () => null,
      showSaveDialog: async () => null,
      join: async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
      dirname: async (path: string) => path.slice(0, path.lastIndexOf('/')) || '/',
      basename: async (path: string) => path.split('/').pop() || path,
      extname: async (path: string) => {
        const index = path.lastIndexOf('.');
        return index === -1 ? '' : path.slice(index);
      },
    });

    const result = await discovery.discoverFromLibraryRoots({
      libraryRoots: ['/project', '/library'],
      projectRoot: '/project',
    });

    expect(result.packages.map((templatePackage) => ({
      id: templatePackage.manifest.template.id,
      scope: templatePackage.source.scope,
    }))).toEqual([
      { id: 'project.root', scope: 'project' },
      { id: 'project.pack', scope: 'project' },
      { id: 'user.pack', scope: 'user' },
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: '/library/template/bad-pack',
        message: expect.stringContaining('template.version'),
      }),
      expect.objectContaining({
        path: '/library/template/legacy-pack',
        message: expect.stringContaining('manifest.v2.json'),
      }),
    ]);
  });
});

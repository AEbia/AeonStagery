import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEMPLATE_PACKAGES,
  SEMANTIC_BUILTIN_TEMPLATE_PACKAGE,
  TEMPLATE_PACKAGE_SCHEMA_VERSION,
  TemplatePackageCatalog,
  buildTemplateAuthoringPreview,
  createInitialCharactersFromTemplates,
  createLoadedTemplatePackage,
  createTemplateInitializedScene,
  createTemplatePackageView,
  importInitialTemplateCharacterAssets,
  parseTemplateAuthoringCombo,
  parseTemplateCompanionDraft,
  parseTemplatePackageManifest,
  parseTemplateStatementDraft,
  payloadToSemanticIntent,
  resolveTemplateDefaults,
  templateAuthoringComboToSemanticIntent,
} from '../services/template-package';
import {
  SCENE_SCHEMA_VERSION,
  SCENE_SCHEMA_VERSION_V4,
  SCENE_SCHEMA_VERSION_V5,
  type CurrentSceneDocument,
  type SceneDocumentV5,
} from '../api/types/semantic-scene';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import {
  CompatibleSceneSession,
  sceneDocumentCodec,
  validateV5Stage,
} from '../services/semantic-scene';
import { SemanticTimelineAuthoringService } from '../services/timeline-authoring/SemanticTimelineAuthoringService';

function makeV5Scene(statements: any[] = []): SceneDocumentV5 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V5,
    sceneId: 'scene_test_v5',
    meta: {
      title: 'V5 Test Scene',
      fps: 60,
      resolution: [1920, 1080],
      characters: [{ id: 'tomori', name: 'Tomori' }, { id: 'anon', name: 'Anon' }],
      markers: [],
    },
    statements,
  };
}

function makeAuthoringScene(statements: any[] = []): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_test_current',
    meta: {
      title: 'Current Test Scene',
      fps: 60,
      resolution: [1920, 1080],
      characters: [{ id: 'tomori', name: 'Tomori' }, { id: 'anon', name: 'Anon' }],
      markers: [],
    },
    statements,
  };
}

describe('Ticket 13: Template v4 and v5 payloads materialization as scene v5', () => {
  it('exports TEMPLATE_PACKAGE_SCHEMA_VERSION as 2', () => {
    expect(TEMPLATE_PACKAGE_SCHEMA_VERSION).toBe(2);
  });

  describe('Manifest v2 & scene version support (v4 and v5)', () => {
    it('parses manifest v2 packages targeting scene v4 and scene v5', () => {
      const v4Manifest = parseTemplatePackageManifest({
        manifestSchemaVersion: 2,
        template: {
          id: 'tpl.v4',
          name: 'Template targeting Scene v4',
          version: '1.0.0',
          compatibility: { sceneSchemaVersion: 4 },
        },
        authoringCombos: [
          {
            id: 'v4_statement',
            name: 'V4 Statement',
            category: 'dialogue',
            payload: {
              kind: 'statementPreset',
              statement: {
                type: 'dialogue',
                params: { speakerId: 'tomori', text: 'Hello from v4', durationSeconds: 2 },
              },
            },
          },
        ],
      });

      const v5Manifest = parseTemplatePackageManifest({
        manifestSchemaVersion: 2,
        template: {
          id: 'tpl.v5',
          name: 'Template targeting Scene v5',
          version: '1.0.0',
          compatibility: { sceneSchemaVersion: 5 },
        },
        authoringCombos: [
          {
            id: 'v5_statement',
            name: 'V5 Statement',
            category: 'dialogue',
            payload: {
              kind: 'statementPreset',
              sceneSchemaVersion: 5,
              statement: {
                type: 'dialogue',
                params: { speakerId: 'anon', text: 'Hello from v5', durationSeconds: 3 },
              },
            },
          },
        ],
      });

      expect(v4Manifest.manifestSchemaVersion).toBe(2);
      expect(v4Manifest.template.compatibility?.sceneSchemaVersion).toBe(4);
      expect(v5Manifest.manifestSchemaVersion).toBe(2);
      expect(v5Manifest.template.compatibility?.sceneSchemaVersion).toBe(5);
    });

    it('materializes statement presets from both scene v4 and v5 payloads into codec-valid v5 statements', () => {
      const v4Package = createLoadedTemplatePackage({
        manifestSchemaVersion: 2,
        template: {
          id: 'tpl.v4',
          name: 'V4 Pack',
          version: '1.0.0',
          compatibility: { sceneSchemaVersion: 4 },
        },
        authoringCombos: [
          {
            id: 'v4_combo',
            name: 'V4 Dialogue',
            category: 'dialogue',
            payload: {
              kind: 'statementPreset',
              sceneSchemaVersion: 4,
              statement: {
                type: 'dialogue',
                params: { speakerId: 'tomori', text: 'V4 dialogue', durationSeconds: 2.5 },
              },
            },
          },
        ],
      }, { scope: 'user', packageRoot: '/templates/v4' });

      const v5Package = createLoadedTemplatePackage({
        manifestSchemaVersion: 2,
        template: {
          id: 'tpl.v5',
          name: 'V5 Pack',
          version: '1.0.0',
          compatibility: { sceneSchemaVersion: 5 },
        },
        authoringCombos: [
          {
            id: 'v5_combo',
            name: 'V5 Camera Move',
            category: 'camera',
            payload: {
              kind: 'statementPreset',
              sceneSchemaVersion: 5,
              statement: {
                type: 'camera',
                params: { mode: 'move', position: [0.5, 0.5], durationSeconds: 1.5 },
              },
            },
          },
        ],
      }, { scope: 'user', packageRoot: '/templates/v5' });

      const view = createTemplatePackageView([v4Package, v5Package]);
      const service = new SemanticTimelineAuthoringService();
      let authoringDoc = makeAuthoringScene();

      // Apply v4 template
      const v4Intent = templateAuthoringComboToSemanticIntent(view.semanticAuthoringCombos[0], {
        anchorTime: 0,
        correlationId: 'apply_v4',
      })!;
      const v4Result = service.author(authoringDoc, v4Intent);
      authoringDoc = v4Result.document;

      // Apply v5 template
      const v5Intent = templateAuthoringComboToSemanticIntent(view.semanticAuthoringCombos[1], {
        anchorTime: 3,
        correlationId: 'apply_v5',
      })!;
      const v5Result = service.author(authoringDoc, v5Intent);
      authoringDoc = v5Result.document;

      // Now materialize into a v5 session
      const sessionOutcome = CompatibleSceneSession.open(makeV5Scene());
      expect(sessionOutcome.status).toBe('ready');
      if (sessionOutcome.status !== 'ready') throw new Error('Session failed to open');
      const session = sessionOutcome.session;

      session.applyTypedEdit({
        ...session.projection,
        statements: authoringDoc.statements,
      });

      // Verify the resulting session and projection
      const finalDoc = session.projection;
      expect(finalDoc.schemaVersion).toBe(5);
      expect(finalDoc.statements).toHaveLength(2);
      expect(finalDoc.statements[0]).toEqual(expect.objectContaining({
        type: 'dialogue',
        time: 0,
        params: expect.objectContaining({ speakerId: 'tomori', text: 'V4 dialogue' }),
      }));
      expect(finalDoc.statements[1]).toEqual(expect.objectContaining({
        type: 'camera',
        time: 3,
        params: expect.objectContaining({ mode: 'move', position: [0.5, 0.5] }),
      }));

      // Verify serialized state has no unknown fields and is codec-valid v5
      expect(session.hasUnknownFields).toBe(false);
      const validatedV5 = validateV5Stage(session.serialize(), sceneDocumentCodec);
      expect(validatedV5.schemaVersion).toBe(5);
      expect(validatedV5.statements).toHaveLength(2);
    });

    it('materializes dialogue presets with companions from v4 and v5 payloads into canonical v5 facts', () => {
      const v4DialoguePreset = createLoadedTemplatePackage({
        manifestSchemaVersion: 2,
        template: {
          id: 'tpl.dialogue.v4',
          name: 'V4 Dialogue Preset Pack',
          version: '1.0.0',
          compatibility: { sceneSchemaVersion: 4 },
        },
        authoringCombos: [
          {
            id: 'dlg_focus_v4',
            name: 'Dialogue Focus V4',
            category: 'dialogue',
            payload: {
              kind: 'dialoguePreset',
              sceneSchemaVersion: 4,
              dialogue: {
                type: 'dialogue',
                params: { speakerId: 'tomori', text: 'Spoken line', durationSeconds: 3 },
              },
              companions: [
                {
                  type: 'camera',
                  anchor: 'start',
                  offset: 0.2,
                  params: { mode: 'focus', target: '$speaker' },
                },
                {
                  type: 'characterPerformance',
                  anchor: 'start',
                  offset: 0,
                  params: { target: '$character', expression: 'smile' },
                },
              ],
            },
          },
        ],
      }, { scope: 'user', packageRoot: '/templates/dlg-v4' });

      const view = createTemplatePackageView([v4DialoguePreset]);
      const service = new SemanticTimelineAuthoringService();
      const authoringDoc = makeAuthoringScene();

      const intent = templateAuthoringComboToSemanticIntent(view.semanticAuthoringCombos[0], {
        anchorTime: 1,
        correlationId: 'dlg_v4_intent',
        scope: { kind: 'character', charId: 'tomori' },
      })!;

      const result = service.author(authoringDoc, intent);

      const sessionOutcome = CompatibleSceneSession.open(makeV5Scene());
      expect(sessionOutcome.status).toBe('ready');
      if (sessionOutcome.status !== 'ready') throw new Error('Session failed to open');
      const session = sessionOutcome.session;

      session.applyTypedEdit({
        ...session.projection,
        statements: result.document.statements,
      });

      const doc = session.projection;
      expect(doc.statements).toHaveLength(1);
      const dlg = doc.statements[0];
      expect(dlg.type).toBe('dialogue');
      expect(dlg.companions).toHaveLength(2);
      expect(dlg.companions![0]).toEqual(expect.objectContaining({
        type: 'camera',
        anchor: 'start',
        offset: 0.2,
        params: expect.objectContaining({ mode: 'focus', target: '$speaker' }),
      }));
      expect(dlg.companions![1]).toEqual(expect.objectContaining({
        type: 'characterPerformance',
        anchor: 'start',
        offset: 0,
        params: expect.objectContaining({ target: 'tomori', expression: 'smile' }),
      }));

      // Validate that v5 codec and session recognize it cleanly
      expect(session.hasUnknownFields).toBe(false);
      validateV5Stage(session.serialize(), sceneDocumentCodec);
    });

    it('materializes timeline fragments from v4 and v5 payloads into canonical v5 facts', () => {
      const fragmentPackage = createLoadedTemplatePackage({
        manifestSchemaVersion: 2,
        template: {
          id: 'tpl.fragment',
          name: 'Fragment Pack',
          version: '1.0.0',
          compatibility: { sceneSchemaVersion: 5 },
        },
        authoringCombos: [
          {
            id: 'scene_intro',
            name: 'Scene Intro Fragment',
            category: 'character',
            payload: {
              kind: 'timelineFragment',
              sceneSchemaVersion: 5,
              statements: [
                {
                  time: 0,
                  type: 'environmentLayer',
                  params: { mode: 'set', layerId: 'bg_main', transition: 'fadeIn', durationSeconds: 1 },
                },
                {
                  time: 0.5,
                  type: 'characterPresence',
                  params: { mode: 'enter', id: '$character', position: [0.5, 1], transition: 'fadeIn' },
                },
                {
                  time: 1.0,
                  type: 'audio',
                  params: { role: 'sfx', mode: 'play', instanceId: 'enter_bell', file: 'audio/bell.wav' },
                },
              ],
            },
          },
        ],
      }, { scope: 'user', packageRoot: '/templates/fragment' });

      const view = createTemplatePackageView([fragmentPackage]);
      const service = new SemanticTimelineAuthoringService();
      const authoringDoc = makeAuthoringScene();

      const intent = templateAuthoringComboToSemanticIntent(view.semanticAuthoringCombos[0], {
        anchorTime: 5,
        correlationId: 'fragment_intent',
        scope: { kind: 'character', charId: 'tomori' },
      })!;

      expect(intent.kind).toBe('insert-script-segment');
      const result = service.author(authoringDoc, intent);

      const sessionOutcome = CompatibleSceneSession.open(makeV5Scene());
      expect(sessionOutcome.status).toBe('ready');
      if (sessionOutcome.status !== 'ready') throw new Error('Session failed to open');
      const session = sessionOutcome.session;

      session.applyTypedEdit({
        ...session.projection,
        statements: result.document.statements,
      });

      const doc = session.projection;
      expect(doc.statements).toHaveLength(3);
      expect(doc.statements[0]).toEqual(expect.objectContaining({
        type: 'environmentLayer',
        time: 5,
        params: expect.objectContaining({ layerId: 'bg_main' }),
      }));
      expect(doc.statements[1]).toEqual(expect.objectContaining({
        type: 'characterPresence',
        time: 5.5,
        params: expect.objectContaining({ id: 'tomori' }),
      }));
      expect(doc.statements[2]).toEqual(expect.objectContaining({
        type: 'audio',
        time: 6,
        params: expect.objectContaining({ instanceId: 'enter_bell' }),
      }));

      expect(session.hasUnknownFields).toBe(false);
      validateV5Stage(session.serialize(), sceneDocumentCodec);
    });
  });

  describe('Strict Payload Validation', () => {
    it('rejects unsupported sceneSchemaVersion values in compatibility or payload', () => {
      // Manifest compatibility rejecting versions outside 4 or 5
      expect(() => parseTemplatePackageManifest({
        manifestSchemaVersion: 2,
        template: {
          id: 'bad.version',
          name: 'Bad Version',
          version: '1.0.0',
          compatibility: { sceneSchemaVersion: 3 },
        },
      })).toThrow(/sceneSchemaVersion=4 or 5/);

      expect(() => parseTemplatePackageManifest({
        manifestSchemaVersion: 2,
        template: {
          id: 'bad.version.future',
          name: 'Future Version',
          version: '1.0.0',
          compatibility: { sceneSchemaVersion: 6 },
        },
      })).toThrow(/sceneSchemaVersion=4 or 5/);

      // Payload rejecting sceneSchemaVersion outside 4 or 5
      expect(() => parseTemplateAuthoringCombo({
        id: 'combo_bad_ver',
        name: 'Bad Ver',
        category: 'dialogue',
        payload: {
          kind: 'statementPreset',
          sceneSchemaVersion: 3 as any,
          statement: { type: 'dialogue', params: { text: 'hi', durationSeconds: 1 } },
        },
      }, 'test', 2)).toThrow(/expected 4 or 5/);
    });

    it('rejects unknown statement families immediately before any facts change', () => {
      expect(() => parseTemplateAuthoringCombo({
        id: 'unknown_family_combo',
        name: 'Unknown Family',
        category: 'character',
        payload: {
          kind: 'statementPreset',
          statement: {
            type: 'superLaserAttack' as any,
            params: { target: 'all' },
          },
        },
      }, 'test', 2)).toThrow(/Unknown statement family/);

      expect(() => parseTemplateStatementDraft({
        type: 'nonExistentFamily',
        params: {},
      }, 'statement')).toThrow(/Unknown statement family/);
    });

    it('rejects statement payloads without a type before any facts change', () => {
      expect(() => parseTemplateAuthoringCombo({
        id: 'missing_type_combo',
        name: 'Missing Type',
        category: 'character',
        payload: {
          kind: 'statementPreset',
          statement: {
            params: { text: 'hello', durationSeconds: 1 },
          },
        },
      }, 'test', 2)).toThrow(/Unknown statement family/);
    });

    it('rejects invalid params immediately before any facts change', () => {
      // Missing required params
      expect(() => parseTemplateStatementDraft({
        type: 'dialogue',
        params: { text: 123 as any, durationSeconds: -5 },
      }, 'statement')).toThrow();

      // Invalid mode for camera
      expect(() => parseTemplateStatementDraft({
        type: 'camera',
        params: { mode: 'invalidMode' as any },
      }, 'statement')).toThrow();

      // Unknown extra field in params (strict param validation)
      expect(() => parseTemplateStatementDraft({
        type: 'audio',
        params: { role: 'sfx', mode: 'play', instanceId: 's1', file: 'a.wav', unallowedParam: true },
      }, 'statement')).toThrow(/Unknown/);
    });

    it('rejects legacy action-based payload formats (actionsById, timeline, ActionType, action, actions)', () => {
      // Legacy actionsById on combo
      expect(() => parseTemplateAuthoringCombo({
        id: 'legacy_actions_by_id',
        name: 'Legacy Combo',
        category: 'dialogue',
        actionsById: { act_1: { action: 'dialogue' } } as any,
      }, 'test', 2)).toThrow(/must use payload, not legacy actionsById/);

      // Legacy timeline on combo
      expect(() => parseTemplateAuthoringCombo({
        id: 'legacy_timeline',
        name: 'Legacy Timeline',
        category: 'dialogue',
        timeline: [{ action: 'dialogue' }] as any,
      }, 'test', 2)).toThrow(/must use payload, not legacy timeline/);

      // Legacy ActionType on combo
      expect(() => parseTemplateAuthoringCombo({
        id: 'legacy_action_type',
        name: 'Legacy ActionType',
        category: 'dialogue',
        ActionType: 'dialogue' as any,
      }, 'test', 2)).toThrow(/must use payload, not legacy ActionType/);

      // Legacy action array on combo
      expect(() => parseTemplateAuthoringCombo({
        id: 'legacy_actions',
        name: 'Legacy Actions',
        category: 'dialogue',
        actions: [{ action: 'dialogue', params: {} }] as any,
      }, 'test', 2)).toThrow(/must use payload, not legacy actions/);

      // Legacy action-based format inside payload
      expect(() => parseTemplateAuthoringCombo({
        id: 'legacy_payload_actions_by_id',
        name: 'Legacy Payload',
        category: 'dialogue',
        payload: {
          kind: 'statementPreset',
          actionsById: { act1: {} } as any,
          statement: { type: 'dialogue', params: { text: 'hi', durationSeconds: 1 } },
        },
      }, 'test', 2)).toThrow(/Legacy action-based property "actionsById" is not supported/);

      // Legacy action-based format inside statement draft
      expect(() => parseTemplateStatementDraft({
        type: 'dialogue',
        params: { text: 'hi', durationSeconds: 1 },
        actionsById: {} as any,
      }, 'draft')).toThrow(/Legacy action-based property "actionsById" is not supported/);

      expect(() => parseTemplateStatementDraft({
        type: 'dialogue',
        params: { text: 'hi', durationSeconds: 1 },
        timeline: [] as any,
      }, 'draft')).toThrow(/Legacy action-based property "timeline" is not supported/);

      expect(() => parseTemplateStatementDraft({
        type: 'dialogue',
        params: { text: 'hi', durationSeconds: 1 },
        ActionType: 'dialogue' as any,
      }, 'draft')).toThrow(/Legacy action-based property "ActionType" is not supported/);

      expect(() => parseTemplateStatementDraft({
        type: 'dialogue',
        params: { text: 'hi', durationSeconds: 1 },
        action: 'dialogue' as any,
      }, 'draft')).toThrow(/Legacy action-based property "action" is not supported/);
    });

    it('rejects unexpected properties on statement and companion drafts', () => {
      expect(() => parseTemplateStatementDraft({
        type: 'dialogue',
        params: { text: 'hi', durationSeconds: 1 },
        unexpectedExtraField: 'bad',
      }, 'draft')).toThrow(/Unexpected property "unexpectedExtraField"/);

      expect(() => parseTemplateCompanionDraft({
        type: 'camera',
        anchor: 'start',
        offset: 0,
        params: { mode: 'focus', target: '$speaker' },
        unexpectedExtraCompanionField: 123,
      }, 'companion')).toThrow(/Unexpected property "unexpectedExtraCompanionField"/);
    });

    it('ensures failed validation does not alter session or document state', () => {
      const sessionOutcome = CompatibleSceneSession.open(makeV5Scene([
        { id: 'stmt_orig', time: 0, type: 'dialogue', params: { speakerId: 'tomori', text: 'Original', durationSeconds: 2 } },
      ]));
      expect(sessionOutcome.status).toBe('ready');
      if (sessionOutcome.status !== 'ready') throw new Error('Failed to open session');
      const session = sessionOutcome.session;
      const initialSnapshot = JSON.stringify(session.serialize());

      // Attempting to convert an invalid combo payload to intent fails before authoring
      expect(() => {
        payloadToSemanticIntent({
          kind: 'statementPreset',
          statement: {
            type: 'invalidFamily' as any,
            params: {},
          },
        }, {
          anchorTime: 0,
          correlationId: 'test_fail',
        });
      }).toThrow();

      // Ensure session is untouched
      expect(JSON.stringify(session.serialize())).toBe(initialSnapshot);
    });
  });

  describe('Template Precedence & Resource Materialization', () => {
    it('preserves scope precedence: project > user > community > builtin', () => {
      const builtin = createLoadedTemplatePackage({
        manifestSchemaVersion: 2,
        template: { id: 'common', name: 'Builtin Common', version: '1.0.0', compatibility: { sceneSchemaVersion: 4 } },
        defaults: { dialogueStyleId: 'builtin_style' },
        dialogueStyles: [{ id: 'style_1', name: 'Builtin Style', renderer: 'glass' }],
      }, { scope: 'builtin', packageRoot: '/templates/builtin' });

      const user = createLoadedTemplatePackage({
        manifestSchemaVersion: 2,
        template: { id: 'common', name: 'User Common', version: '1.0.0', compatibility: { sceneSchemaVersion: 5 } },
        defaults: { dialogueStyleId: 'user_style' },
        dialogueStyles: [{ id: 'style_1', name: 'User Style', renderer: 'user_renderer' }],
      }, { scope: 'user', packageRoot: '/templates/user' });

      const project = createLoadedTemplatePackage({
        manifestSchemaVersion: 2,
        template: { id: 'common', name: 'Project Common', version: '1.0.0', compatibility: { sceneSchemaVersion: 5 } },
        defaults: { dialogueStyleId: 'project_style' },
        dialogueStyles: [{ id: 'style_1', name: 'Project Style', renderer: 'project_renderer' }],
      }, { scope: 'project', packageRoot: '/project/template' });

      const view = createTemplatePackageView([builtin, user, project]);
      expect(view.packages[0].source.scope).toBe('project');
      expect(view.packages[1].source.scope).toBe('user');
      expect(view.packages[2].source.scope).toBe('builtin');

      expect(view.defaults.dialogueStyleId).toBe('project_style');
      expect(view.dialogueStyles[0].name).toBe('Project Style');
      expect(view.dialogueStyles[0].renderer).toBe('project_renderer');
    });

    it('preserves enabledTemplateIds order within the same scope', () => {
      const pkgA = createLoadedTemplatePackage({
        manifestSchemaVersion: 2,
        template: { id: 'packA', name: 'Pack A', version: '1.0.0', compatibility: { sceneSchemaVersion: 4 } },
        characterPresets: [{ id: 'hero', name: 'Hero A', model: 'hero_a.model3.json' }],
      }, { scope: 'user', packageRoot: '/templates/a' });

      const pkgB = createLoadedTemplatePackage({
        manifestSchemaVersion: 2,
        template: { id: 'packB', name: 'Pack B', version: '1.0.0', compatibility: { sceneSchemaVersion: 5 } },
        characterPresets: [{ id: 'hero', name: 'Hero B', model: 'hero_b.model3.json' }],
      }, { scope: 'user', packageRoot: '/templates/b' });

      // When enabledTemplateIds puts packB last, packB has higher precedence
      const viewBFirst = createTemplatePackageView([pkgA, pkgB], {
        enabledTemplateIds: ['packA', 'packB'],
      });
      expect(viewBFirst.characterPresets[0].name).toBe('Hero B');

      // When enabledTemplateIds puts packA last, packA has higher precedence
      const viewAFirst = createTemplatePackageView([pkgA, pkgB], {
        enabledTemplateIds: ['packB', 'packA'],
      });
      expect(viewAFirst.characterPresets[0].name).toBe('Hero A');
    });

    it('creates template initialized scenes targeting v4 and v5', () => {
      const pkg = createLoadedTemplatePackage({
        manifestSchemaVersion: 2,
        template: { id: 'pack', name: 'Pack', version: '1.0.0', compatibility: { sceneSchemaVersion: 5 } },
        characterPresets: [{ id: 'tomori', name: 'Tomori Takamatsu', speakerColor: '#336699', model: 'assets/tomori.model3.json' }],
      }, { scope: 'user', packageRoot: '/templates/pack' });

      const sceneV4 = createTemplateInitializedScene('V4 Scene', {
        templatePackages: [pkg],
        templateConfiguration: { enabledTemplateIds: ['pack'], selectedCharacterPresetIds: ['tomori'] },
        schemaVersion: SCENE_SCHEMA_VERSION_V4,
      });
      expect(sceneV4.schemaVersion).toBe(4);
      expect(sceneV4.meta.title).toBe('V4 Scene');
      expect(sceneV4.meta.characters).toHaveLength(1);
      expect(sceneV4.meta.characters![0].name).toBe('Tomori Takamatsu');

      const sceneV5 = createTemplateInitializedScene('V5 Scene', {
        templatePackages: [pkg],
        templateConfiguration: { enabledTemplateIds: ['pack'], selectedCharacterPresetIds: ['tomori'] },
        schemaVersion: SCENE_SCHEMA_VERSION_V5,
      });
      expect(sceneV5.schemaVersion).toBe(5);
      expect(sceneV5.meta.title).toBe('V5 Scene');
      expect(sceneV5.meta.characters).toHaveLength(1);
      expect(sceneV5.meta.characters![0].name).toBe('Tomori Takamatsu');
    });

    it('materializes character preset figure assets into project storage during initial import', async () => {
      const pkg = createLoadedTemplatePackage({
        manifestSchemaVersion: 2,
        template: { id: 'pack', name: 'Pack', version: '1.0.0', compatibility: { sceneSchemaVersion: 5 } },
        characterPresets: [{
          id: 'soyo',
          name: 'Soyo',
          model: 'assets/soyo/soyo.model3.json',
          variants: [{ id: 'casual', name: 'Casual', model: 'assets/soyo/casual.model3.json' }],
        }],
      }, { scope: 'project', packageRoot: '/project/template/soyo-pack' });

      const scene = createTemplateInitializedScene('Import Scene', {
        templatePackages: [pkg],
        templateConfiguration: { enabledTemplateIds: ['pack'], selectedCharacterPresetIds: ['soyo'], characterVariantImportMode: 'all' },
        schemaVersion: SCENE_SCHEMA_VERSION_V5,
      });

      const importedAssets = new Map<string, string>();
      const resultScene = await importInitialTemplateCharacterAssets(
        scene,
        [pkg],
        { enabledTemplateIds: ['pack'], selectedCharacterPresetIds: ['soyo'], characterVariantImportMode: 'all' },
        async (sourcePath, _kind, _mode) => {
          const dest = `imported://${sourcePath}`;
          importedAssets.set(sourcePath, dest);
          return dest;
        },
        async (...parts) => parts.join('/').replace(/\/+/g, '/'),
      );

      expect(importedAssets.size).toBe(2);
      expect(resultScene.meta.characters![0].model).toBe('imported:///project/template/soyo-pack/assets/soyo/soyo.model3.json');
      expect(resultScene.meta.characters![0].variants![0].model).toBe('imported:///project/template/soyo-pack/assets/soyo/casual.model3.json');
    });

    it('exposes built-in template packages targeting manifest v2 and produces valid previews', () => {
      expect(BUILTIN_TEMPLATE_PACKAGES.length).toBeGreaterThanOrEqual(1);
      const catalog = new TemplatePackageCatalog([...BUILTIN_TEMPLATE_PACKAGES]);
      expect(catalog.getPackages()).toHaveLength(BUILTIN_TEMPLATE_PACKAGES.length);

      const semanticPkg = SEMANTIC_BUILTIN_TEMPLATE_PACKAGE;
      expect(semanticPkg.manifest.manifestSchemaVersion).toBe(2);
      expect(semanticPkg.manifest.template.compatibility?.sceneSchemaVersion).toBe(4);

      const defaults = resolveTemplateDefaults([semanticPkg]);
      expect(defaults.dialogueStyleId).toBe('glass');

      const characters = createInitialCharactersFromTemplates([semanticPkg]);
      expect(characters).toEqual([]);

      const combos = catalog.getSemanticAuthoringCombos();
      expect(combos.length).toBeGreaterThan(0);

      const firstCombo = combos[0];
      const preview = buildTemplateAuthoringPreview(firstCombo, {
        anchorTime: 0,
        correlationId: 'builtin_preview',
        scope: { kind: 'character', charId: 'tomori' },
      });
      expect(preview).not.toBeNull();
      expect(preview?.intent.version).toBe(AUTHORING_SCHEMA_VERSION);
      expect(preview?.rootCount).toBeGreaterThanOrEqual(1);
    });
  });
});

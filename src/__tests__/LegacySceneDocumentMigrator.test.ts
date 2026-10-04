import { describe, expect, it } from 'vitest';
import type { SceneAction, SceneScript } from '../../scripts/migrations/legacy-scene/LegacySceneTypes';
import {
  sceneStatementCompiler,
  validateSemanticSceneStructure,
} from '../services/semantic-scene';
import { migrateLegacySceneScriptToDocumentV3 } from '../../scripts/migrations/legacy-scene/LegacySceneDocumentMigrator';
import { BLEND_MODES } from '../api/types/blend-mode';

function makeLegacyScene(overrides: Partial<SceneScript> = {}): SceneScript {
  return {
    sceneId: 'legacy_scene',
    meta: {
      title: 'Legacy Scene',
      characters: [
        { id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' },
      ],
    },
    audio: {
      bgm: {
        file: 'bgm/opening.ogg',
        volume: 0.4,
        loop: true,
        fadeIn: 1,
      },
    },
    timeline: [
      {
        _id: 'bg',
        action: 'setBackground',
        time: 0,
        params: {
          image: 'background/classroom.png',
          x: 0.5,
          y: 0.5,
          scale: 1,
          transition: 'crossFade',
          duration: 1,
        },
      },
      {
        _id: 'enter',
        action: 'addCharacter',
        delay: 0.5,
        params: {
          id: 'tomori',
          position: [0.45, 1],
          model: 'figure/tomori/model.json',
          enterDuration: 0.8,
        },
      },
      {
        _id: 'line',
        action: 'dialogue',
        time: 2,
        params: {
          speakerId: 'tomori',
          text: 'I know.',
          duration: 2.5,
          voice: 'vocal/tomori/001.ogg',
        },
      },
      {
        _id: 'motion',
        action: 'playMotion',
        time: 2,
        params: {
          id: 'tomori',
          motion: 'nod',
        },
      },
      {
        _id: 'camera',
        action: 'cameraMove',
        time: 2,
        params: {
          targetCharacter: 'tomori',
          targetPart: 'head',
          zoom: 1.2,
          duration: 0.8,
        },
      },
      {
        _id: 'tail',
        action: 'wait',
        time: 5,
        params: { duration: 1.5 },
      },
    ],
    ...overrides,
  };
}

describe('LegacySceneDocumentMigrator', () => {
  it('migrates legacy SceneScript source facts into a codec-valid SceneDocumentV4', () => {
    const result = migrateLegacySceneScriptToDocumentV3(makeLegacyScene());

    expect(result.issues).toEqual([]);
    expect(result.document).toBeTruthy();
    expect((result.document as any)?.audio).toBeUndefined();
    expect((result.document as any)?.timeline).toBeUndefined();
    expect(result.document?.meta.durationSeconds).toBe(6.5);
    expect(result.document?.statements.map((statement) => [statement.id, statement.type, statement.time])).toEqual([
      ['initial-bgm', 'audio', 0],
      ['bg', 'environmentLayer', 0],
      ['enter', 'characterPresence', 0.5],
      ['line', 'dialogue', 2],
      ['motion', 'characterPerformance', 2],
      ['camera', 'camera', 2],
    ]);

    const compiled = sceneStatementCompiler.compile(result.document!);
    expect(compiled.actions.map((action) => action.action)).toEqual([
      'setBGM',
      'setEnvironmentLayer',
      'addCharacter',
      'dialogue',
      'playMotion',
      'cameraMotion',
    ]);
    expect(compiled.actions.find((action) => action.source.statementId === 'camera')?.params).toMatchObject({
      focus: { character: 'tomori', part: 'head' },
      zoom: 1.2,
    });
  });

  it('preserves the file alias used by legacy template background actions', () => {
    const result = migrateLegacySceneScriptToDocumentV3(makeLegacyScene({
      audio: undefined,
      timeline: [{
        _id: 'template_bg',
        action: 'setBackground',
        time: 0,
        params: { file: 'background/template-room.png', transition: 'crossFade' },
      }],
    }));

    expect(result.issues).toEqual([]);
    expect(result.document?.statements[0]).toMatchObject({
      type: 'environmentLayer',
      params: { image: 'background/template-room.png', transition: 'crossFade' },
    });
    expect(sceneStatementCompiler.compile(result.document!).actions[0].params).toMatchObject({
      image: 'background/template-room.png',
    });
  });

  it('reports intentionally dropped custom actions without failing the whole migration', () => {
    const result = migrateLegacySceneScriptToDocumentV3(makeLegacyScene({
      audio: undefined,
      timeline: [
        {
          _id: 'custom_1',
          action: 'custom',
          time: 0,
          params: { anything: true },
        },
        {
          _id: 'line',
          action: 'dialogue',
          time: 1,
          params: { text: 'still valid', duration: 1 },
        },
      ],
    }));

    expect(result.document?.statements.map((statement) => statement.id)).toEqual(['line']);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'custom-action-dropped',
        actionId: 'custom_1',
      }),
    ]);
  });

  it('drops unknown legacy actions and continues migrating known actions', () => {
    const result = migrateLegacySceneScriptToDocumentV3(makeLegacyScene({
      audio: undefined,
      timeline: [
        {
          _id: 'unknown_1',
          action: 'futureLegacyAction',
          time: 0,
          params: { anything: true },
        } as unknown as SceneAction,
        {
          _id: 'line',
          action: 'dialogue',
          time: 1,
          params: { text: 'still valid', duration: 1 },
        },
      ],
    }));

    expect(result.issues).toEqual([]);
    expect(result.document?.statements.map((statement) => statement.id)).toEqual(['line']);
    expect(result.document?.statements[0]).toMatchObject({
      type: 'dialogue',
      params: { text: 'still valid' },
    });
  });

  it('migrates legacy absolute assets and reports them through semantic diagnostics', () => {
    const result = migrateLegacySceneScriptToDocumentV3(makeLegacyScene({
      audio: undefined,
      timeline: [
        {
          _id: 'line',
          action: 'dialogue',
          time: 0,
          params: {
            text: 'bad asset',
            duration: 1,
            voice: 'C:/voices/tomori.wav',
          },
        },
      ],
    }));

    expect(result.document).not.toBeNull();
    expect(result.issues).toEqual([]);
    expect(validateSemanticSceneStructure(result.document!)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        actionId: 'line',
        message: expect.stringContaining('本机绝对路径'),
      }),
    ]));
  });

  it('reports blockers for legacy collection effects that have no stable object id', () => {
    const result = migrateLegacySceneScriptToDocumentV3(makeLegacyScene({
      audio: undefined,
      timeline: [
        {
          action: 'addPointLight',
          time: 0,
          params: { color: '#fff', intensity: 0.8 },
        },
      ],
    }));

    expect(result.document?.statements).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'missing-id',
        actionType: 'addPointLight',
      }),
    ]);
  });

  it('preserves legacy color overlay blend mode in the typed source contract', () => {
    const result = migrateLegacySceneScriptToDocumentV3(makeLegacyScene({
      audio: undefined,
      timeline: [{
        _id: 'overlay',
        action: 'addColorOverlay',
        time: 0,
        params: { id: 'overlay-main', mode: 'screen', color: '#112233', intensity: 0.4 },
      }],
    }));

    expect(result.issues).toEqual([]);
    expect(result.document?.statements[0]?.params).toMatchObject({
      effect: 'overlay',
      mode: 'set',
      id: 'overlay-main',
      blendMode: 'screen',
    });
    expect(sceneStatementCompiler.compile(result.document!).actions[0]?.params).toMatchObject({
      mode: 'screen',
    });
  });

  it('migrates every common blend mode through object integration and color overlay fields', () => {
    for (const blendMode of BLEND_MODES) {
      const result = migrateLegacySceneScriptToDocumentV3(makeLegacyScene({
        audio: undefined,
        timeline: [
          {
            _id: `composite-${blendMode}`,
            action: 'setCompositeRecipe',
            time: 0,
            params: {
              targetId: 'tomori',
              slot: 'integration',
              recipeId: 'builtin:integration-soft',
              colorBlendMode: blendMode,
            },
          },
          {
            _id: `overlay-${blendMode}`,
            action: 'addColorOverlay',
            time: 1,
            params: { id: `overlay-${blendMode}`, mode: blendMode, color: '#abcdef', intensity: 0.4 },
          },
        ],
      }));

      expect(result.issues).toEqual([]);
      expect(result.document?.statements[0]?.params).toMatchObject({ colorBlendMode: blendMode });
      expect(result.document?.statements[1]?.params).toMatchObject({ blendMode });
    }
  });

  it('migrates every common blend mode used by integrated post overlays', () => {
    for (const overlayBlendMode of BLEND_MODES) {
      const result = migrateLegacySceneScriptToDocumentV3(makeLegacyScene({
        audio: undefined,
        timeline: [{
          _id: `post-${overlayBlendMode}`,
          action: 'setPostProcessing',
          time: 0,
          params: {
            overlayColor: '#abcdef',
            overlayBlendMode,
            overlayIntensity: 0.4,
          },
        }],
      }));

      expect(result.issues).toEqual([]);
      expect(result.document?.statements[0]?.params).toMatchObject({
        overlayColor: '#abcdef',
        overlayBlendMode,
        overlayIntensity: 0.4,
      });
    }
  });

  it('migrates legacy character rim light as a persistent visualStyle set cue', () => {
    const result = migrateLegacySceneScriptToDocumentV3(makeLegacyScene({
      audio: undefined,
      timeline: [{
        _id: 'rim',
        action: 'setCharacterRimLight',
        time: 1,
        params: {
          id: 'tomori',
          color: '#ffaa00',
          intensity: 0.8,
          thickness: 14,
          angle: 30,
          softness: 3,
          duration: 0.25,
        },
      }],
    }));

    expect(result.issues).toEqual([]);
    expect(result.document?.statements[0]).toMatchObject({
      id: 'rim',
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: 'tomori',
        slot: 'rim-light',
        mode: 'set',
        color: '#ffaa00',
        intensity: 0.8,
        thickness: 14,
        angle: 30,
        softness: 3,
        durationSeconds: 0.25,
      },
    });
    expect(sceneStatementCompiler.compile(result.document!).actions[0]).toMatchObject({
      action: 'setCharacterRimLight',
      params: {
        id: 'tomori',
        mode: 'set',
        color: '#ffaa00',
        intensity: 0.8,
        thickness: 14,
        angle: 30,
        softness: 3,
        duration: 0.25,
      },
    });
  });
});

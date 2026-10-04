import { describe, expect, it } from 'vitest';
import {
  SCENE_SCHEMA_VERSION,
  SCENE_SCHEMA_VERSION_V4,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import {
  RuntimeAssetPreparer,
  decodeCompiledActionId,
  encodeCompiledActionId,
  sceneDocumentCodec,
  sceneStatementCompiler,
  sceneStatementDefinitionRegistry,
} from '../services/semantic-scene';
import { unwrapPreparedValue } from '../engine/PreparedRuntimeScene';

function makeDocument(overrides: Partial<CurrentSceneDocument> = {}): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_semantic_v3',
    meta: {
      title: 'Semantic Scene',
      characters: [
        { id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' },
      ],
    },
    statements: [
      {
        id: 'dlg_001',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'I know.',
          durationSeconds: 3,
          voice: 'vocal/tomori/001.ogg',
        },
        companions: [
          {
            id: 'focus-speaker',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: {
              mode: 'focus',
              target: '$speaker',
              targetPart: 'head',
              zoom: { kind: 'delta', value: 0.3 },
              durationSeconds: 0.5,
            },
          },
          {
            id: 'speaker-expression',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: {
              target: '$speaker',
              expression: 'smile',
            },
          },
        ],
      },
      {
        id: 'image_move',
        time: 2,
        type: 'graphicLayer',
        params: {
          kind: 'image',
          mode: 'transform',
          id: 'poster',
          position: [0.45, 0.5],
          scale: 1.1,
          durationSeconds: 0.75,
        },
      },
    ],
    ...overrides,
  };
}

describe('semantic scene v3', () => {
  it('parses and compiles stable source statements with dialogue companions', () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument());
    const compiled = sceneStatementCompiler.compile(document);

    expect(compiled.sourceSchemaVersion).toBe(SCENE_SCHEMA_VERSION);
    expect(compiled.durationSeconds).toBe(4);
    expect(compiled.actions.map((action) => action.action)).toEqual([
      'dialogue',
      'cameraMotion',
      'setExpression',
      'transformImage',
    ]);
    expect(compiled.actions[0].id).toBe(encodeCompiledActionId('dlg_001', undefined, 'primary'));
    expect(compiled.actions[1].id).toBe(encodeCompiledActionId('dlg_001', 'focus-speaker', 'primary'));
    expect(compiled.actions[1].params).toMatchObject({
      focus: { character: 'tomori', part: 'head' },
      zoom: '+=0.3',
    });
    expect(compiled.actions[2].params).toMatchObject({
      id: 'tomori',
      expression: 'smile',
    });
    expect(compiled.actions[3].source).toEqual({
      statementId: 'image_move',
      outputKey: 'primary',
    });

    expect(decodeCompiledActionId(compiled.actions[0].id)).toEqual({
      statementId: 'dlg_001',
      outputKey: 'primary',
    });
    expect(decodeCompiledActionId(compiled.actions[1].id)).toEqual({
      statementId: 'dlg_001',
      companionId: 'focus-speaker',
      outputKey: 'primary',
    });
    expect(decodeCompiledActionId('random-id-without-tag')).toBeNull();
  });

  it('keeps custom motion extent in scene-end derivation', () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument({
      statements: [{
        id: 'late_motion',
        time: 10,
        type: 'characterPerformance',
        params: {
          target: 'tomori',
          motion: {
            kind: 'custom',
            durationSeconds: 5,
            fadeInSeconds: 0.5,
            derivedFrom: { key: 'wave' },
            tracks: [{
              parameterId: 'PARAM_ANGLE_X',
              keyframes: [
                { time: 0, value: 0, segment: { type: 'linear' } },
                { time: 5, value: 10 },
              ],
            }],
          },
        },
      }],
    }));

    const compiled = sceneStatementCompiler.compile(document);

    expect(compiled.durationSeconds).toBe(15);
    expect(compiled.actions[0]).toMatchObject({
      time: 10,
      action: 'playMotion',
      params: { motion: { kind: 'custom', durationSeconds: 5 } },
    });
  });

  it('completes implicit linear segments on legacy v4 custom motions (missing segment on a non-last keyframe)', () => {
    const { document, migrationWarnings } = sceneDocumentCodec.parseAndValidateWithWarnings({
      ...makeDocument({
        statements: [{
          id: 'legacy_motion',
          time: 0,
          type: 'characterPerformance',
          params: {
            target: 'tomori',
            motion: {
              kind: 'custom',
              durationSeconds: 1,
              fadeInSeconds: 0,
              derivedFrom: { key: 'wave' },
              tracks: [{
                parameterId: 'PARAM_ANGLE_X',
                keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }],
              }],
            },
          },
        }],
      }),
      schemaVersion: SCENE_SCHEMA_VERSION_V4,
    });
    const motion = (document.statements[0].params as {
      motion: { tracks: Array<{ keyframes: Array<{ segment?: unknown }> }> };
    }).motion;
    // The pre-CustomMotionContract editor persisted linear as "no segment";
    // the codec boundary completes the legacy shape instead of rejecting it.
    expect(motion.tracks[0].keyframes[0].segment).toEqual({ type: 'linear' });
    expect(motion.tracks[0].keyframes[1]).not.toHaveProperty('segment');
    expect(migrationWarnings).toEqual([
      'Completed 1 implicit linear keyframe segment(s) on custom motion "legacy_motion"',
    ]);
  });

  it('rejects rather than strips a segment on the last custom-motion keyframe', () => {
    expect(() => sceneDocumentCodec.parseAndValidate(makeDocument({
      statements: [{
        id: 'invalid_motion',
        time: 0,
        type: 'characterPerformance',
        params: {
          target: 'tomori',
          motion: {
            kind: 'custom',
            durationSeconds: 1,
            fadeInSeconds: 0,
            derivedFrom: { key: 'wave' },
            tracks: [{
              parameterId: 'PARAM_ANGLE_X',
              keyframes: [
                { time: 0, value: 0, segment: { type: 'linear' } },
                { time: 1, value: 1, segment: { type: 'linear' } },
              ],
            }],
          },
        },
      }],
    }))).toThrow(/scene\.statements\[0\]\.params\.motion\.tracks\[0\]\.keyframes\[1\]\.segment/);
  });

  it('resolves an entering character model from the scene character directory', async () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument({
      statements: [
        {
          id: 'enter_tomori',
          time: 0.7,
          type: 'characterPresence',
          params: {
            mode: 'enter',
            id: 'tomori',
            position: [0.5, 1],
            scale: 1,
            transition: 'fadeIn',
            durationSeconds: 0.6,
          },
        },
      ],
    }));

    const compiled = sceneStatementCompiler.compile(document);
    expect(compiled.actions[0]).toMatchObject({
      action: 'addCharacter',
      params: {
        id: 'tomori',
        model: 'figure/tomori/model.json',
      },
    });

    const prepared = await new RuntimeAssetPreparer(async (source) => `runtime://${source}`).prepare(compiled);
    expect(prepared.actions[0].params.model).toEqual({
      source: 'figure/tomori/model.json',
      runtimeUri: 'runtime://figure/tomori/model.json',
    });
  });

  it('preserves a mounted external-library reference inherited from character metadata', async () => {
    const externalModel = '@mount/webgal-sv/game/figure/anon/casual-2023/model.json';
    const document = sceneDocumentCodec.parseAndValidate(makeDocument({
      meta: {
        title: 'External library character',
        characters: [{ id: '1', name: 'New character', model: externalModel }],
      },
      statements: [
        {
          id: 'enter_external_character',
          time: 0.7,
          type: 'characterPresence',
          params: {
            mode: 'enter',
            id: '1',
            position: [0.5, 1],
            scale: 1,
            transition: 'fadeIn',
            durationSeconds: 0.6,
          },
        },
      ],
    }));

    const compiled = sceneStatementCompiler.compile(document);
    const prepared = await new RuntimeAssetPreparer(async (source) => source).prepare(compiled);

    expect(prepared.actions[0].params.model).toEqual({
      source: externalModel,
      runtimeUri: externalModel,
    });
  });

  it('keeps an explicit character presence model override', () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument({
      statements: [
        {
          id: 'enter_tomori_variant',
          time: 0,
          type: 'characterPresence',
          params: {
            mode: 'enter',
            id: 'tomori',
            model: 'figure/tomori/stage.model.json',
          },
        },
      ],
    }));

    const compiled = sceneStatementCompiler.compile(document);
    expect(compiled.actions[0].params.model).toBe('figure/tomori/stage.model.json');
  });

  it('rejects legacy scene shapes while accepting author-entered resource paths before compilation', () => {
    expect(() => sceneDocumentCodec.parseAndValidate({
      sceneId: 'legacy',
      meta: { title: 'Legacy' },
      timeline: [],
    })).toThrow(/schema version/i);

    expect(() => sceneDocumentCodec.parseAndValidate({
      ...makeDocument(),
      audio: { bgm: { file: 'bgm/theme.ogg' } },
    })).toThrow(/top-level audio/i);

    const document = sceneDocumentCodec.parseAndValidate(makeDocument({
      statements: [
        {
          id: 'bad_voice',
          time: 0,
          type: 'dialogue',
          params: {
            text: 'bad',
            durationSeconds: 1,
            voice: 'C:/voices/bad.ogg',
          },
        },
      ],
    }));

    expect(document.statements[0].params).toMatchObject({
      voice: 'C:/voices/bad.ogg',
    });
  });

  it('rejects invalid companion contracts', () => {
    expect(() => sceneDocumentCodec.parseAndValidate(makeDocument({
      statements: [
        {
          id: 'dlg_001',
          time: 1,
          type: 'dialogue',
          params: {
            speakerId: 'tomori',
            text: 'I know.',
            durationSeconds: 3,
          },
          companions: [
            {
              id: 'enter',
              anchor: 'start',
              offset: 0,
              type: 'characterPresence',
              params: {
                mode: 'enter',
                id: 'tomori',
              },
            },
          ],
        },
      ],
    }))).toThrow(/not attachable/);

    expect(() => sceneDocumentCodec.parseAndValidate(makeDocument({
      statements: [
        {
          id: 'a',
          time: 0,
          type: 'dialogue',
          params: { text: 'a', durationSeconds: 1 },
        },
        {
          id: 'a',
          time: 1,
          type: 'dialogue',
          params: { text: 'b', durationSeconds: 1 },
        },
      ],
    }))).toThrow(/Duplicate statement id/);
  });

  it('rejects camera position writes while follow is active', () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument({
      statements: [
        {
          id: 'follow_start',
          time: 1,
          type: 'camera',
          params: {
            mode: 'follow',
            operation: 'start',
            target: 'tomori',
          },
        },
        {
          id: 'focus_during_follow',
          time: 2,
          type: 'camera',
          params: {
            mode: 'focus',
            target: 'tomori',
            durationSeconds: 0.5,
          },
        },
      ],
    }));

    expect(() => sceneStatementCompiler.compile(document)).toThrow(
      /Camera follow "follow_start" is still active when "focus_during_follow" writes camera position/,
    );
  });

  it('allows zoom-only camera statements while follow is active', () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument({
      statements: [
        {
          id: 'follow_start',
          time: 1,
          type: 'camera',
          params: {
            mode: 'follow',
            operation: 'start',
            target: 'tomori',
          },
        },
        {
          id: 'zoom_only',
          time: 2,
          type: 'camera',
          params: {
            mode: 'move',
            zoom: { kind: 'absolute', value: 1.25 },
            rotation: 2,
            durationSeconds: 0.4,
          },
        },
        {
          id: 'follow_stop',
          time: 3,
          type: 'camera',
          params: {
            mode: 'follow',
            operation: 'stop',
          },
        },
        {
          id: 'focus_after_stop',
          time: 3.5,
          type: 'camera',
          params: {
            mode: 'focus',
            target: 'tomori',
            durationSeconds: 0.5,
          },
        },
      ],
    }));

    const compiled = sceneStatementCompiler.compile(document);

    expect(compiled.actions.map((action) => [action.source.statementId, action.action])).toEqual([
      ['follow_start', 'cameraFollow'],
      ['zoom_only', 'cameraMotion'],
      ['follow_stop', 'cameraUnfollow'],
      ['focus_after_stop', 'cameraMotion'],
    ]);
    expect(compiled.actions[1].params).toEqual({
      move: 'zoom',
      easing: 'smooth',
      duration: 0.4,
      zoom: 1.25,
      angle: 2,
    });
  });

  it('lowers semantic camera zoom intents into runtime-safe zoom values', () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument({
      statements: [
        {
          id: 'push_in',
          time: 0,
          type: 'camera',
          params: {
            mode: 'focus',
            target: 'tomori',
            zoom: { kind: 'delta', value: 0.25 },
            durationSeconds: 0.5,
          },
        },
        {
          id: 'pull_out',
          time: 1,
          type: 'camera',
          params: {
            mode: 'move',
            zoom: { kind: 'delta', value: -0.2 },
            durationSeconds: 0.5,
          },
        },
        {
          id: 'absolute_zoom',
          time: 2,
          type: 'camera',
          params: {
            mode: 'move',
            zoom: { kind: 'absolute', value: 1.4 },
            durationSeconds: 0.5,
          },
        },
      ],
    }));

    const compiled = sceneStatementCompiler.compile(document);

    expect(compiled.actions.map((action) => action.params)).toEqual([
      {
        move: 'push',
        easing: 'smooth',
        duration: 0.5,
        focus: { character: 'tomori', part: 'head' },
        zoom: '+=0.25',
      },
      {
        move: 'pull',
        easing: 'smooth',
        duration: 0.5,
        zoom: '-=0.2',
      },
      {
        move: 'zoom',
        easing: 'smooth',
        duration: 0.5,
        zoom: 1.4,
      },
    ]);
  });

  it('drops legacy camera move start coordinates while preserving the endpoint', () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument({
      statements: [{
        id: 'camera_move_legacy_start',
        time: 0,
        type: 'camera',
        params: {
          mode: 'move',
          from: [0.1, 0.2],
          to: [0.8, 0.7],
          durationSeconds: 1,
        } as any,
      }],
    }));

    expect(document.statements[0].params).not.toHaveProperty('from');
    expect(document.statements[0].params).toMatchObject({ to: [0.8, 0.7] });
    expect(sceneStatementCompiler.compile(document).actions[0].params)
      .toEqual({
        move: 'pan',
        easing: 'smooth',
        duration: 1,
        target: [0.8, 0.7],
      });
  });

  it('prepares runtime asset references without mutating the compiled scene', async () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument());
    const compiled = sceneStatementCompiler.compile(document);
    const preparer = new RuntimeAssetPreparer((source) => `asset://project/${source}`);

    const prepared = await preparer.prepare(compiled);
    const dialogue = prepared.actions[0];
    const voice = dialogue.params.voice;

    expect(prepared.kind).toBe('prepared-compiled-scene');
    expect(voice).toEqual({
      source: 'vocal/tomori/001.ogg',
      runtimeUri: 'asset://project/vocal/tomori/001.ogg',
    });
    expect(compiled.actions[0].params.voice).toBe('vocal/tomori/001.ogg');
    expect(prepared).not.toBe(compiled);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(dialogue.params)).toBe(true);
  });

  it('prepares only registry-declared compiled asset slots instead of guessing field names', async () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument());
    const compiled = sceneStatementCompiler.compile(document);
    const dialogue = compiled.actions[0];
    expect(dialogue.assetSlots).toContainEqual({ path: 'params.voice', kind: 'vocal' });

    const synthetic = {
      ...compiled,
      actions: [{
        ...dialogue,
        params: { file: 'not-an-asset.txt', voice: 'vocal/tomori/001.ogg' },
        assetSlots: [{ path: 'params.voice', kind: 'vocal' as const }],
      }],
    };
    const prepared = await new RuntimeAssetPreparer((source) => `asset://project/${source}`).prepare(synthetic);
    expect(prepared.actions[0].params.file).toBe('not-an-asset.txt');
    expect(prepared.actions[0].params.voice).toEqual({
      source: 'vocal/tomori/001.ogg',
      runtimeUri: 'asset://project/vocal/tomori/001.ogg',
    });
  });

  it('exposes typed source asset slots even before an optional resource is selected', () => {
    expect(sceneStatementDefinitionRegistry.sourceAssetSlots({
      type: 'dialogue',
      params: { speakerId: 'tomori', text: 'Hello', durationSeconds: 1 },
    })).toContainEqual({ path: 'params.voice', kind: 'vocal', resourceKind: 'voice' });
    expect(sceneStatementDefinitionRegistry.sourceAssetSlot({
      type: 'audio',
      params: { role: 'sfx', mode: 'play', instanceId: 'door', file: '' },
    }, 'params.file')).toEqual({ path: 'params.file', kind: 'generic', resourceKind: 'sfx' });
    expect(sceneStatementDefinitionRegistry.sourceAssetSlots({
      type: 'audio',
      params: { role: 'bgm', mode: 'stop' },
    })).toEqual([]);
  });

  it('marks unresolved runtime asset paths unavailable instead of leaking them to runtime', async () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument({
      statements: [
        {
          id: 'bad_voice',
          time: 0,
          type: 'dialogue',
          params: {
            text: 'bad',
            durationSeconds: 1,
            voice: 'C:/voices/bad.ogg',
          },
        },
      ],
    }));
    const compiled = sceneStatementCompiler.compile(document);
    const prepared = await new RuntimeAssetPreparer(() => {
      throw new Error('not resolvable yet');
    }).prepare(compiled);

    expect(prepared.actions[0].params.voice).toEqual({
      source: 'C:/voices/bad.ogg',
      runtimeUri: '',
      unavailable: true,
      unavailableReason: 'not resolvable yet',
    });
    expect(unwrapPreparedValue(prepared.actions[0].params.voice!)).toBe('');
  });
});

describe('legacy motion shape normalization', () => {
  function makeMotionDocument(motion: unknown): CurrentSceneDocument {
    return {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'scene_legacy_motion',
      meta: {
        title: 'Legacy Motion',
        characters: [
          { id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' },
        ],
      },
      statements: [
        {
          id: 'legacy_motion',
          time: 0,
          type: 'characterPerformance',
          params: {
            target: 'tomori',
            motion: motion as never,
          },
        },
      ],
    };
  }

  it('rejects a bare motion key string in favor of the strict resource union', () => {
    expect(() => sceneDocumentCodec.parseAndValidate(makeMotionDocument('wave'))).toThrow();
  });

  it('rejects a kind-less motion record in favor of the strict resource union', () => {
    expect(() => sceneDocumentCodec.parseAndValidate(makeMotionDocument({ key: 'wave', fadeInSeconds: 0.3 }))).toThrow();
  });

  it('rejects persisted legacy motion shapes on parse instead of upgrading them', () => {
    expect(() => sceneDocumentCodec.parseAndValidate(makeMotionDocument('wave'))).toThrow();
  });

  it('still rejects invalid legacy motion shapes', () => {
    expect(() => sceneDocumentCodec.parseAndValidate(makeMotionDocument(42))).toThrow();
    expect(() => sceneDocumentCodec.parseAndValidate(makeMotionDocument({}))).toThrow();
    expect(() => sceneDocumentCodec.parseAndValidate(makeMotionDocument({ kind: 'bogus' }))).toThrow();
    expect(() => sceneDocumentCodec.parseAndValidate(makeMotionDocument({ kind: 'resource' }))).toThrow();
  });

  it('rejects pre-ADR-0029 top-level durationSeconds/loop/priority on characterPerformance', () => {
    expect(() => sceneDocumentCodec.parseAndValidate({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'scene_legacy_perf_duration',
      meta: { title: 'Legacy Perf Duration' },
      statements: [
        {
          id: 'legacy_perf',
          time: 0,
          type: 'characterPerformance',
          params: {
            target: 'tomori',
            motion: 'wave',
            durationSeconds: 1,
            loop: false,
            priority: 3,
          } as never,
        },
      ],
    })).toThrow();
  });

  it('rejects legacy top-level characterPerformance fields on parse instead of upgrading them', () => {
    expect(() => sceneDocumentCodec.parseAndValidate({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'scene_legacy_perf_duration',
      meta: { title: 'Legacy Perf Duration' },
      statements: [
        {
          id: 'legacy_perf',
          time: 0,
          type: 'characterPerformance',
          params: {
            target: 'tomori',
            motion: { key: 'wave', fadeInSeconds: 0.3 },
            durationSeconds: 1,
          } as never,
        },
      ],
    })).toThrow();
  });
});

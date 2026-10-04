import { afterEach, describe, expect, it } from 'vitest';
import type { CompiledScene, CurrentSceneDocument } from '../api/types/semantic-scene';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import {
  buildSemanticCopyBufferForTimelineActions,
  buildSemanticDeleteTimelineIntents,
  buildSemanticDurationUpdateIntent,
  buildSemanticMoveTimelineIntent,
  buildSemanticRetargetTimelineIntents,
  buildSemanticSourceParamUpdateIntent,
  buildSemanticSourceParamsReplaceIntent,
  buildSemanticSplitTimelineIntents,
  buildSemanticTimelineParamUpdateIntent,
  defaultDialogueStatementDraft,
  locatorForTimelineAction,
  shouldRouteTimelineParamPatchToSource,
} from '../ui/timeline/semanticTimelineEditing';
import { DEFAULT_SETTINGS, settingsManager } from '../ui/SettingsStore';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_v2',
    meta: {
      title: 'Test',
      characters: [
        { id: 'tomori', name: '灯' },
        { id: 'anon', name: 'Anon' },
      ],
    },
    statements: [
      {
        id: 'line_1',
        time: 3,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          speaker: '灯',
          text: '听我说。',
          durationSeconds: 2,
        },
        companions: [
          {
            id: 'cmp_motion',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: {
              target: 'tomori',
              motion: {
                kind: 'custom',
                durationSeconds: 2,
                fadeInSeconds: 0.5,
                derivedFrom: { key: 'nod' },
                tracks: [
                  {
                    parameterId: 'PARAM_ANGLE_X',
                    keyframes: [
                      { time: 0, value: 0, segment: { type: 'linear' } },
                      { time: 2, value: 20 },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
      {
        id: 'perf_1',
        time: 6,
        type: 'characterPerformance',
        params: {
          target: 'tomori',
          expression: 'smile',
        },
      },
    ],
  };
}

function makeCompiled(document: CurrentSceneDocument): CompiledScene {
  return {
    sourceSchemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: document.sceneId,
    meta: document.meta,
    durationSeconds: 8,
    actions: [
      {
        id: 'compiled_line',
        time: 3,
        action: 'dialogue',
        params: {},
        source: { statementId: 'line_1', outputKey: 'primary' },
      },
      {
        id: 'compiled_cmp_motion',
        time: 3,
        action: 'playMotion',
        params: {},
        source: { statementId: 'line_1', companionId: 'cmp_motion', outputKey: 'motion' },
      },
      {
        id: 'compiled_perf',
        time: 6,
        action: 'setExpression',
        params: {},
        source: { statementId: 'perf_1', outputKey: 'expression' },
      },
    ],
  };
}

function makeStore(document = makeDocument(), compiled = makeCompiled(document)) {
  return {
    getCurrentSceneDocumentSnapshot: () => document,
    getCompiledSceneSnapshot: () => compiled,
  };
}

describe('semantic timeline editing helpers', () => {
  afterEach(() => {
    settingsManager.set('defaultDialogueDurationSeconds', DEFAULT_SETTINGS.defaultDialogueDurationSeconds);
  });

  it('maps compiled action ids to source locators for timeline moves', () => {
    const intent = buildSemanticMoveTimelineIntent(
      makeStore(),
      [
        { id: 'compiled_line', time: 1.24 },
        { id: 'compiled_cmp_motion', time: 2 },
      ],
      'move-1',
    );

    expect(intent).toEqual(expect.objectContaining({
      correlationId: 'move-1',
      kind: 'move-timeline-locators',
      moves: [
        { locator: { kind: 'statement', statementId: 'line_1' }, time: 1.2 },
        { locator: { kind: 'companion', statementId: 'line_1', companionId: 'cmp_motion' }, time: 2 },
      ],
    }));
  });

  it('updates root and companion source durations from track resize actions', () => {
    expect(buildSemanticDurationUpdateIntent(
      makeStore(),
      'compiled_line',
      3.24,
      'duration-root',
    )).toEqual(expect.objectContaining({
      correlationId: 'duration-root',
      kind: 'update-statement',
      statementId: 'line_1',
      patch: {
        params: expect.objectContaining({ durationSeconds: 3.2 }),
      },
    }));

    expect(buildSemanticDurationUpdateIntent(
      makeStore(),
      'compiled_cmp_motion',
      1.55,
      'duration-companion',
    )).toEqual(expect.objectContaining({
      correlationId: 'duration-companion',
      kind: 'update-dialogue-companion',
      locator: { statementId: 'line_1', companionId: 'cmp_motion' },
      patch: {
        params: expect.objectContaining({
          motion: expect.objectContaining({ kind: 'custom', durationSeconds: 1.6 }),
        }),
      },
    }));
  });

  it('updates lifecycle transition duration fields from track resize actions', () => {
    const baseDocument = makeDocument();
    const document: CurrentSceneDocument = {
      ...baseDocument,
      statements: [
        ...baseDocument.statements,
        {
          id: 'bgm_play',
          time: 0,
          type: 'audio',
          params: {
            role: 'bgm',
            mode: 'play',
            file: 'theme.mp3',
            fadeIn: 1,
          },
        },
        {
          id: 'bgm_stop',
          time: 5,
          type: 'audio',
          params: {
            role: 'bgm',
            mode: 'stop',
            fadeOut: 1,
          },
        },
      ],
    };
    const baseCompiled = makeCompiled(document);
    const compiled: CompiledScene = {
      ...baseCompiled,
      actions: [
        ...baseCompiled.actions,
        {
          id: 'compiled_bgm_play',
          time: 0,
          action: 'setBGM',
          params: {},
          source: { statementId: 'bgm_play', outputKey: 'primary' },
        },
        {
          id: 'compiled_bgm_stop',
          time: 5,
          action: 'stopAudio',
          params: {},
          source: { statementId: 'bgm_stop', outputKey: 'stop' },
        },
      ],
    };
    const store = makeStore(document, compiled);

    const playIntent = buildSemanticDurationUpdateIntent(store, 'compiled_bgm_play', 2.34, 'duration-bgm-play');
    expect(playIntent).toEqual(expect.objectContaining({
      correlationId: 'duration-bgm-play',
      kind: 'update-statement',
      statementId: 'bgm_play',
    }));
    const playParams = playIntent?.kind === 'update-statement'
      ? playIntent.patch.params as Record<string, unknown>
      : undefined;
    expect(playParams).toEqual(expect.objectContaining({ fadeIn: 2.3, file: 'theme.mp3' }));
    expect(playParams).not.toHaveProperty('durationSeconds');

    const stopIntent = buildSemanticDurationUpdateIntent(store, 'compiled_bgm_stop', 1.55, 'duration-bgm-stop');
    expect(stopIntent).toEqual(expect.objectContaining({
      correlationId: 'duration-bgm-stop',
      kind: 'update-statement',
      statementId: 'bgm_stop',
    }));
    const stopParams = stopIntent?.kind === 'update-statement'
      ? stopIntent.patch.params as Record<string, unknown>
      : undefined;
    expect(stopParams).toEqual(expect.objectContaining({ fadeOut: 1.6 }));
    expect(stopParams).not.toHaveProperty('durationSeconds');
  });

  it('maps inspector timeline param edits back to source statement params', () => {
    expect(buildSemanticTimelineParamUpdateIntent(
      makeStore(),
      'compiled_line',
      { text: '新的台词', duration: 4 },
      'param-root',
    )).toEqual(expect.objectContaining({
      correlationId: 'param-root',
      kind: 'update-statement',
      statementId: 'line_1',
      patch: {
        params: expect.objectContaining({
          speakerId: 'tomori',
          text: '新的台词',
          durationSeconds: 4,
        }),
      },
    }));

    expect(buildSemanticTimelineParamUpdateIntent(
      makeStore(),
      'compiled_cmp_motion',
      { id: 'anon' },
      'param-companion',
    )).toEqual(expect.objectContaining({
      correlationId: 'param-companion',
      kind: 'update-dialogue-companion',
      locator: { statementId: 'line_1', companionId: 'cmp_motion' },
      patch: {
        params: expect.objectContaining({
          target: 'anon',
          motion: expect.objectContaining({ kind: 'custom' }),
        }),
      },
    }));
  });

  it('updates source params directly when the inspector uses semantic fields', () => {
    expect(buildSemanticSourceParamUpdateIntent(
      makeStore(),
      'compiled_line',
      { text: '语义字段', durationSeconds: 3.5 },
      'source-param-root',
    )).toEqual(expect.objectContaining({
      correlationId: 'source-param-root',
      kind: 'update-statement',
      statementId: 'line_1',
      patch: {
        params: expect.objectContaining({
          speakerId: 'tomori',
          text: '语义字段',
          durationSeconds: 3.5,
        }),
      },
    }));

    expect(buildSemanticSourceParamUpdateIntent(
      makeStore(),
      'compiled_cmp_motion',
      { target: 'anon' },
      'source-param-companion',
    )).toEqual(expect.objectContaining({
      correlationId: 'source-param-companion',
      kind: 'update-dialogue-companion',
      locator: { statementId: 'line_1', companionId: 'cmp_motion' },
      patch: {
        params: expect.objectContaining({
          target: 'anon',
          motion: expect.objectContaining({ kind: 'custom', derivedFrom: { key: 'nod' } }),
        }),
      },
    }));
  });

  it('normalizes a raw string motion into the resource discriminated union on source param patches', () => {
    expect(buildSemanticSourceParamUpdateIntent(
      makeStore(),
      'compiled_cmp_motion',
      { motion: 'wave.mtn' },
      'source-param-motion-string',
    )).toEqual(expect.objectContaining({
      correlationId: 'source-param-motion-string',
      kind: 'update-dialogue-companion',
      locator: { statementId: 'line_1', companionId: 'cmp_motion' },
      patch: {
        params: expect.objectContaining({
          motion: { kind: 'resource', key: 'wave.mtn' },
        }),
      },
    }));

    expect(buildSemanticSourceParamUpdateIntent(
      makeStore(),
      'compiled_cmp_motion',
      { motion: '' },
      'source-param-motion-empty',
    )).toEqual(expect.objectContaining({
      patch: {
        params: expect.not.objectContaining({ motion: expect.anything() }),
      },
    }));
  });

  it('keeps a raw object motion untouched on source param patches', () => {
    expect(buildSemanticSourceParamUpdateIntent(
      makeStore(),
      'compiled_cmp_motion',
      { motion: { kind: 'resource', key: 'wave.mtn', fadeInSeconds: 0.3 } },
      'source-param-motion-object',
    )).toEqual(expect.objectContaining({
      patch: {
        params: expect.objectContaining({
          motion: { kind: 'resource', key: 'wave.mtn', fadeInSeconds: 0.3 },
        }),
      },
    }));
  });

  it('writes typed lighting fields directly instead of recreating legacy fields', () => {
    const baseDocument = makeDocument();
    const document: CurrentSceneDocument = {
      ...baseDocument,
      statements: [{
        id: 'lighting_post',
        time: 0,
        type: 'lighting',
        params: {
          effect: 'post',
          mode: 'set',
          bloomBloomScale: 0.8,
          adjGamma: 1,
        },
      }],
    };
    const compiled: CompiledScene = {
      ...makeCompiled(document),
      actions: [{
        id: 'compiled_lighting_post',
        time: 0,
        action: 'setPostProcessing',
        params: { bloomBloomScale: 0.8, adjGamma: 1, duration: 0.5 },
        source: { statementId: 'lighting_post', outputKey: 'primary' },
      }],
    };

    const intent = buildSemanticTimelineParamUpdateIntent(
      makeStore(document, compiled),
      'compiled_lighting_post',
      { bloomThreshold: 0.6, adjGamma: 1.15 },
      'lighting-typed-fields',
    );

    expect(intent).toEqual(expect.objectContaining({
      correlationId: 'lighting-typed-fields',
      kind: 'update-statement',
      statementId: 'lighting_post',
      patch: {
        params: {
          effect: 'post',
          mode: 'set',
          bloomBloomScale: 0.8,
          adjGamma: 1.15,
          bloomThreshold: 0.6,
        },
      },
    }));
    expect((intent as any).patch.params.fields).toBeUndefined();
  });

  it('replaces the complete source param object for discriminator transitions', () => {
    expect(buildSemanticSourceParamsReplaceIntent(
      makeStore(),
      'compiled_line',
      { speakerId: 'anon', text: '替换后的对白', durationSeconds: 1 },
      'source-params-replace',
    )).toEqual(expect.objectContaining({
      correlationId: 'source-params-replace',
      kind: 'update-statement',
      statementId: 'line_1',
      patch: {
        params: { speakerId: 'anon', text: '替换后的对白', durationSeconds: 1 },
      },
    }));
  });

  it('updates non-character source params directly without timeline aliases', () => {
    const baseDocument = makeDocument();
    const additionalStatements = [
      {
        id: 'env_1',
        time: 7,
        type: 'environmentLayer',
        params: {
          mode: 'set',
          layerId: 'fog',
          file: 'fog.png',
          durationSeconds: 2,
        },
      },
      {
        id: 'audio_1',
        time: 8,
        type: 'audio',
        params: {
          role: 'sfx',
          mode: 'play',
          instanceId: 'hit',
          file: 'hit.wav',
          volume: 0.5,
        },
      },
      {
        id: 'graphic_1',
        time: 9,
        type: 'graphicLayer',
        params: {
          kind: 'image',
          mode: 'set',
          id: 'poster',
          file: 'poster.png',
          durationSeconds: 1,
        },
      },
      {
        id: 'custom_1',
        time: 10,
        type: 'customAnimation',
        params: {
          target: 'tomori',
          file: 'spark.json',
          durationSeconds: 1,
        },
      },
    ] satisfies CurrentSceneDocument['statements'];
    const document: CurrentSceneDocument = {
      ...baseDocument,
      statements: [...baseDocument.statements, ...additionalStatements],
    };
    const compiledBase = makeCompiled(document);
    const compiled: CompiledScene = {
      ...compiledBase,
      actions: [
        ...compiledBase.actions,
        {
          id: 'compiled_env',
          time: 7,
          action: 'setEnvironmentLayer',
          params: {},
          source: { statementId: 'env_1', outputKey: 'primary' },
        },
        {
          id: 'compiled_audio',
          time: 8,
          action: 'playAudio',
          params: {},
          source: { statementId: 'audio_1', outputKey: 'primary' },
        },
        {
          id: 'compiled_graphic',
          time: 9,
          action: 'addImage',
          params: {},
          source: { statementId: 'graphic_1', outputKey: 'primary' },
        },
        {
          id: 'compiled_custom',
          time: 10,
          action: 'playCustomAnimation',
          params: {},
          source: { statementId: 'custom_1', outputKey: 'primary' },
        },
      ],
    };
    const store = {
      getCurrentSceneDocumentSnapshot: () => document,
      getCompiledSceneSnapshot: () => compiled,
    };

    expect(buildSemanticSourceParamUpdateIntent(
      store,
      'compiled_env',
      { layerId: 'mist', position: [0.25, 0.75], durationSeconds: 3 },
      'source-param-env',
    )).toEqual(expect.objectContaining({
      correlationId: 'source-param-env',
      kind: 'update-statement',
      statementId: 'env_1',
      patch: {
        params: expect.objectContaining({
          mode: 'set',
          layerId: 'mist',
          file: 'fog.png',
          position: [0.25, 0.75],
          durationSeconds: 3,
        }),
      },
    }));

    expect(buildSemanticSourceParamUpdateIntent(
      store,
      'compiled_audio',
      { instanceId: 'hit-2', file: 'hit-2.wav', durationSeconds: 0.75 },
      'source-param-audio',
    )).toEqual(expect.objectContaining({
      correlationId: 'source-param-audio',
      kind: 'update-statement',
      statementId: 'audio_1',
      patch: {
        params: expect.objectContaining({
          role: 'sfx',
          mode: 'play',
          instanceId: 'hit-2',
          file: 'hit-2.wav',
          durationSeconds: 0.75,
        }),
      },
    }));

    expect(buildSemanticSourceParamUpdateIntent(
      store,
      'compiled_graphic',
      { file: 'poster-2.png', durationSeconds: 1.5 },
      'source-param-graphic',
    )).toEqual(expect.objectContaining({
      correlationId: 'source-param-graphic',
      kind: 'update-statement',
      statementId: 'graphic_1',
      patch: {
        params: expect.objectContaining({
          kind: 'image',
          mode: 'set',
          id: 'poster',
          file: 'poster-2.png',
          durationSeconds: 1.5,
        }),
      },
    }));

    expect(buildSemanticSourceParamUpdateIntent(
      store,
      'compiled_custom',
      { target: 'anon', durationSeconds: 2 },
      'source-param-custom',
    )).toEqual(expect.objectContaining({
      correlationId: 'source-param-custom',
      kind: 'update-statement',
      statementId: 'custom_1',
      patch: {
        params: expect.objectContaining({
          target: 'anon',
          file: 'spark.json',
          durationSeconds: 2,
        }),
      },
    }));
  });

  it('updates nested character performance source params directly', () => {
    const baseDocument = makeDocument();
    const additionalStatements = [
      {
        id: 'look_1',
        time: 7,
        type: 'characterPerformance',
        params: {
          target: 'tomori',
          lookAt: {
            point: [0, 0],
            enabled: true,
          },
        },
      },
      {
        id: 'blink_1',
        time: 8,
        type: 'characterPerformance',
        params: {
          target: 'anon',
          blink: {
            enabled: true,
            interval: 4,
          },
        },
      },
    ] satisfies CurrentSceneDocument['statements'];
    const document: CurrentSceneDocument = {
      ...baseDocument,
      statements: [...baseDocument.statements, ...additionalStatements],
    };
    const compiledBase = makeCompiled(document);
    const compiled: CompiledScene = {
      ...compiledBase,
      actions: [
        ...compiledBase.actions,
        {
          id: 'compiled_look',
          time: 7,
          action: 'characterLookAt',
          params: {},
          source: { statementId: 'look_1', outputKey: 'lookAt' },
        },
        {
          id: 'compiled_blink',
          time: 8,
          action: 'characterBlink',
          params: {},
          source: { statementId: 'blink_1', outputKey: 'blink' },
        },
      ],
    };
    const store = {
      getCurrentSceneDocumentSnapshot: () => document,
      getCompiledSceneSnapshot: () => compiled,
    };

    expect(buildSemanticSourceParamUpdateIntent(
      store,
      'compiled_look',
      { lookAt: { target: 'anon', point: [0.2, -0.4], intensity: 0.8, enabled: true } },
      'source-param-look',
    )).toEqual(expect.objectContaining({
      correlationId: 'source-param-look',
      kind: 'update-statement',
      statementId: 'look_1',
      patch: {
        params: expect.objectContaining({
          target: 'tomori',
          lookAt: {
            target: 'anon',
            point: [0.2, -0.4],
            intensity: 0.8,
            enabled: true,
          },
        }),
      },
    }));

    expect(buildSemanticSourceParamUpdateIntent(
      store,
      'compiled_blink',
      { blink: { enabled: false, interval: 2.5 } },
      'source-param-blink',
    )).toEqual(expect.objectContaining({
      correlationId: 'source-param-blink',
      kind: 'update-statement',
      statementId: 'blink_1',
      patch: {
        params: expect.objectContaining({
          target: 'anon',
          blink: {
            enabled: false,
            interval: 2.5,
          },
        }),
      },
    }));
  });

  it('splits a duration-backed root statement with v2 update and insert intents', () => {
    const intents = buildSemanticSplitTimelineIntents(
      makeStore(),
      'compiled_line',
      4,
      'split-root',
    );

    expect(intents).toEqual([
      expect.objectContaining({
        correlationId: 'split-root',
        kind: 'update-statement',
        statementId: 'line_1',
        patch: {
          params: expect.objectContaining({ text: '听我说。', durationSeconds: 1 }),
        },
      }),
      expect.objectContaining({
        correlationId: 'split-root_tail',
        kind: 'insert-statement',
        anchorTime: 4,
        statement: expect.objectContaining({
          type: 'dialogue',
          params: expect.objectContaining({ text: '听我说。', durationSeconds: 1 }),
        }),
      }),
    ]);
  });

  it('retargets source statements and companions without runtime param reverse-compilation', () => {
    const intents = buildSemanticRetargetTimelineIntents(
      makeStore(),
      ['compiled_line', 'compiled_cmp_motion', 'compiled_perf'],
      'anon',
      'Anon',
      'retarget-1',
    );

    expect(intents).toEqual([
      expect.objectContaining({
        correlationId: 'retarget-1_0',
        kind: 'update-statement',
        statementId: 'line_1',
        patch: {
          params: expect.objectContaining({ speakerId: 'anon', speaker: 'Anon' }),
        },
      }),
      expect.objectContaining({
        correlationId: 'retarget-1_1',
        kind: 'update-dialogue-companion',
        locator: { statementId: 'line_1', companionId: 'cmp_motion' },
        patch: {
          params: expect.objectContaining({
            target: 'anon',
            motion: expect.objectContaining({ kind: 'custom', derivedFrom: { key: 'nod' } }),
          }),
        },
      }),
      expect.objectContaining({
        correlationId: 'retarget-1_2',
        kind: 'update-statement',
        statementId: 'perf_1',
        patch: {
          params: expect.objectContaining({ target: 'anon', expression: 'smile' }),
        },
      }),
    ]);
  });

  it('deletes selected root statements before unrelated companions', () => {
    const intents = buildSemanticDeleteTimelineIntents(
      makeStore(),
      ['compiled_line', 'compiled_cmp_motion', 'compiled_perf'],
      'delete-1',
    );

    expect(intents).toEqual([
      expect.objectContaining({
        correlationId: 'delete-1',
        kind: 'delete-statements',
        statementIds: ['line_1', 'perf_1'],
      }),
    ]);
  });

  it('creates unbound dialogue drafts even when the semantic document has characters', () => {
    expect(defaultDialogueStatementDraft(makeDocument())).toEqual({
      type: 'dialogue',
      params: {
        text: '新对白',
        durationSeconds: 2,
      },
    });
  });

  it('uses the configured default duration for quick dialogue drafts', () => {
    settingsManager.set('defaultDialogueDurationSeconds', 6.5);

    expect(defaultDialogueStatementDraft(makeDocument())).toEqual({
      type: 'dialogue',
      params: {
        text: '新对白',
        durationSeconds: 6.5,
      },
    });
  });

  it('resolves uncompiled ADR-0022 placeholder blocks through the read model fallback', () => {
    const document = makeDocument();
    document.statements[0].companions = [
      {
        id: 'cmp_placeholder',
        anchor: 'start',
        offset: 0,
        type: 'characterPerformance',
        params: {
          target: '$speaker',
          motion: '',
        },
      },
    ];
    // No compiled action exists for the placeholder: it lowers to nothing.
    const store = makeStore(document);

    expect(locatorForTimelineAction(store, 'cmp_placeholder')).toEqual({
      kind: 'companion',
      statementId: 'line_1',
      companionId: 'cmp_placeholder',
    });
  });

  it('copies uncompiled companions at their semantic time alongside compiled statements', () => {
    const document = makeDocument();
    document.statements[0].companions = [{
      id: 'cmp_placeholder',
      anchor: 'end',
      offset: 0.5,
      type: 'characterPerformance',
      params: { target: 'tomori', motion: '' },
    }];
    const buffer = buildSemanticCopyBufferForTimelineActions(makeStore(document), [
      'compiled_perf', 'cmp_placeholder', 'cmp_placeholder',
    ]);
    expect(buffer).toEqual([
      { time: 0, type: 'characterPerformance', params: { target: 'tomori', motion: '' } },
      { time: 0.5, type: 'characterPerformance', params: { target: 'tomori', expression: 'smile' } },
    ]);
  });

  it('fills a placeholder motion through the source param update seam', () => {
    const document = makeDocument();
    document.statements[0].companions = [
      {
        id: 'cmp_placeholder',
        anchor: 'start',
        offset: 0,
        type: 'characterPerformance',
        params: {
          target: '$speaker',
          motion: '',
        },
      },
    ];
    const store = makeStore(document);

    expect(buildSemanticSourceParamUpdateIntent(
      store,
      'cmp_placeholder',
      { motion: 'angry01' },
      'placeholder-motion',
    )).toEqual(expect.objectContaining({
      correlationId: 'placeholder-motion',
      kind: 'update-dialogue-companion',
      locator: { statementId: 'line_1', companionId: 'cmp_placeholder' },
      patch: {
        params: expect.objectContaining({
          motion: { kind: 'resource', key: 'angry01' },
          target: '$speaker',
        }),
      },
    }));
  });

  it('deletes an uncompiled placeholder companion through the companion delete seam', () => {
    const document = makeDocument();
    document.statements[0].companions = [
      {
        id: 'cmp_placeholder',
        anchor: 'start',
        offset: 0,
        type: 'characterPerformance',
        params: {
          target: '$speaker',
          motion: '',
        },
      },
    ];
    const store = makeStore(document);

    expect(buildSemanticDeleteTimelineIntents(store, ['cmp_placeholder'], 'placeholder-delete')).toEqual([
      expect.objectContaining({
        correlationId: 'placeholder-delete_companions',
        kind: 'delete-dialogue-companions',
        locators: [{ statementId: 'line_1', companionId: 'cmp_placeholder' }],
      }),
    ]);
  });
});

describe('shouldRouteTimelineParamPatchToSource', () => {
  const PLACEHOLDER_PARAMS = { target: '$speaker', motion: '' };

  it('routes new-key writes (expression) on an uncompiled placeholder to the source seam', () => {
    // An ADR-0022 placeholder lowers to no compiled action; writing a field
    // that is not yet in the source params (expression/lookAt/blink) must go
    // through the source param path. The compiled-action path can never
    // resolve these blocks, so the write would otherwise be dropped and the
    // chosen expression name would never be readable again.
    expect(shouldRouteTimelineParamPatchToSource(
      PLACEHOLDER_PARAMS,
      { expression: 'smile' },
      false,
      'characterPerformance',
    )).toBe(true);
  });

  it('keeps routing pre-existing keys on placeholders to the source seam', () => {
    expect(shouldRouteTimelineParamPatchToSource(
      PLACEHOLDER_PARAMS,
      { motion: { kind: 'resource', key: 'wave' } },
      false,
      'characterPerformance',
    )).toBe(true);
  });

  it('keeps the compiled seam for new keys on actions that have a compiled output', () => {
    expect(shouldRouteTimelineParamPatchToSource(
      { target: '$speaker', motion: { kind: 'resource', key: 'wave' } },
      { expression: 'smile' },
      true,
      'characterPerformance',
    )).toBe(false);
  });

  it('routes all camera/visual/filter/lighting family patches to the source seam', () => {
    expect(shouldRouteTimelineParamPatchToSource(
      { mode: 'move', durationSeconds: 1 },
      { to: [0.5, 0.5] },
      true,
      'camera',
    )).toBe(true);
  });

  it('refuses without source params', () => {
    expect(shouldRouteTimelineParamPatchToSource(
      undefined,
      { expression: 'smile' },
      false,
      'characterPerformance',
    )).toBe(false);
  });
});

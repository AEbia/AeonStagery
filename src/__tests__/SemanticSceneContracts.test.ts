import { describe, expect, it } from 'vitest';
import {
  isCharacterPerformancePlaceholderCompanion,
  isCharacterPerformancePlaceholderParams,
  sceneDocumentCodec,
  sceneStatementCompiler,
  sceneStatementDefinitionRegistry,
  validateSemanticSceneStructure,
} from '../services/semantic-scene';
import {
  DEFAULT_CAMERA_PATH_KEYFRAMES,
  ensureCameraPathKeyframes,
  SCENE_STATEMENT_DEFINITIONS,
} from '../services/semantic-scene/SceneStatementDefinitionRegistry';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';

function makeDocument(statements: unknown[]): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'task2_semantic_contracts',
    meta: {
      title: 'Task 2',
      characters: [{ id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' }],
    },
    statements: statements as CurrentSceneDocument['statements'],
  };
}

describe('Task 2 semantic contracts', () => {
  it('accepts an empty dialogue text placeholder but still requires a string', () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument([{
      id: 'blank-dialogue',
      time: 0,
      type: 'dialogue',
      params: { text: '', durationSeconds: 1 },
    }]));

    expect(document.statements[0]).toMatchObject({
      type: 'dialogue',
      params: { text: '' },
    });
    expect(() => sceneDocumentCodec.parseAndValidate(makeDocument([{
      id: 'invalid-dialogue',
      time: 0,
      type: 'dialogue',
      params: { text: null, durationSeconds: 1 },
    }]))).toThrow(/Expected string/);
  });

  it('maps boolean lipSync to the runtime audio/text/none contract', () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument([
      {
        id: 'audio-sync',
        time: 0,
        type: 'dialogue',
        params: { text: 'voice', durationSeconds: 1, voice: 'vocal/line.ogg', lipSync: true },
      },
      {
        id: 'text-sync',
        time: 1,
        type: 'dialogue',
        params: { text: 'text', durationSeconds: 1, lipSync: true },
      },
      {
        id: 'disabled-sync',
        time: 2,
        type: 'dialogue',
        params: { text: 'off', durationSeconds: 1, voice: 'vocal/off.ogg', lipSync: false },
      },
    ]));

    const actions = sceneStatementCompiler.compile(document).actions;
    expect(actions.map((action) => action.params.lipSync)).toEqual(['audio', 'text', 'none']);
  });

  it('rejects non-boolean source lipSync values', () => {
    expect(() => sceneStatementDefinitionRegistry.parseParams('dialogue', {
      text: 'invalid',
      durationSeconds: 1,
      lipSync: 'audio',
    }, 'statement.invalid.params')).toThrow(/boolean/);
  });

  it('keeps a materialized image dialogue presentation and declares all nested assets', () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument([{
      id: 'image-dialogue',
      time: 0,
      type: 'dialogue',
      params: {
        text: 'Image dialogue',
        durationSeconds: 2,
        presentation: {
          renderer: 'image-dialogue-v1',
          textbox: { image: 'images/templates/demo/ui/dialogue/textbox.png', nineSlice: [32, 32, 32, 32], x: 120, y: 760, width: 1680, minHeight: 240 },
          namebox: { image: 'images/templates/demo/ui/dialogue/namebox.png', x: 160, y: 690, width: 320, height: 88 },
          text: {
            fontFile: 'images/templates/demo/fonts/dialogue.ttf',
            fontFamily: 'Demo Dialogue',
            x: 190,
            y: 820,
            maxWidth: 1500,
            align: 'center',
            dropShadow: true,
            dropShadowColor: '#000000',
            dropShadowAlpha: 0.8,
            dropShadowBlur: 12,
            dropShadowDistance: 4,
          },
        },
      },
    }]));
    const dialogue = sceneStatementCompiler.compile(document).actions[0];

    expect(dialogue.params.presentation).toMatchObject({
      renderer: 'image-dialogue-v1',
      text: { align: 'center', dropShadow: true, dropShadowBlur: 12 },
    });
    expect(dialogue.assetSlots).toEqual(expect.arrayContaining([
      { path: 'params.presentation.textbox.image', kind: 'images' },
      { path: 'params.presentation.namebox.image', kind: 'images' },
      { path: 'params.presentation.text.fontFile', kind: 'images' },
    ]));
  });

  it('keeps the source look-at tuple and lowers without a motion duration', () => {
    const source = {
      id: 'look-at',
      time: 0,
      type: 'characterPerformance' as const,
      params: {
        target: 'tomori',
        lookAt: { point: [0.25, -0.4] as [number, number], enabled: true },
      },
    };
    const document = sceneDocumentCodec.parseAndValidate(makeDocument([source]));
    const compiled = sceneStatementCompiler.compile(document);

    expect(source.params.lookAt.point).toEqual([0.25, -0.4]);
    expect(compiled.actions[0].params).toMatchObject({
      id: 'tomori',
      point: [0.25, -0.4],
      enabled: true,
    });
    expect(compiled.actions[0].params).not.toHaveProperty('duration');
    expect(compiled.actions[0].params).not.toHaveProperty('focusX');
    expect(compiled.actions[0].params).not.toHaveProperty('focusY');
  });

  it('centralizes a two-keyframe camera default and preserves authored keyframes', () => {
    expect(DEFAULT_CAMERA_PATH_KEYFRAMES).toHaveLength(2);
    expect(ensureCameraPathKeyframes(undefined)).toHaveLength(2);

    const authored = [
      { time: 0, position: [0.1, 0.2] as [number, number], zoom: 1.1, rotation: 4, ease: 'power2.in', label: 'start' },
      { time: 2, position: [0.8, 0.7] as [number, number], zoom: 1.5, rotation: -2, ease: 'power2.out', label: 'end' },
    ];
    const normalized = ensureCameraPathKeyframes(authored);
    expect(normalized).toEqual(authored);
    expect(normalized).not.toBe(authored);
    expect(normalized[0]).not.toBe(authored[0]);
  });

  it('adds a cloned endpoint when editing a legacy one-keyframe path', () => {
    const normalized = ensureCameraPathKeyframes([
      {
        time: 3,
        position: [0.2, 0.3] as [number, number],
        zoom: 1.25,
        rotation: 7,
        ease: 'power2.inOut',
        label: 'authored',
      },
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toMatchObject({ time: 3, position: [0.2, 0.3], label: 'authored' });
    expect(normalized[1]).toMatchObject({
      time: 4,
      position: [0.2, 0.3],
      zoom: 1.25,
      rotation: 7,
      ease: 'power2.inOut',
      label: 'authored',
    });
  });

  it('enforces the registry camera path minimum at the schema boundary', () => {
    expect(() => SCENE_STATEMENT_DEFINITIONS.camera.parseParams({
      mode: 'path',
      keyframes: [{ time: 0, position: [0.5, 0.5] }],
    }, 'statement.camera.params')).toThrow(/at least two camera keyframes/);
  });

  it('keeps empty visual targets diagnosable without weakening strict authoring parsing', () => {
    expect(() => sceneStatementDefinitionRegistry.parseParams('lighting', {
      effect: 'overlay',
      mode: 'remove',
    }, 'statement.lighting.params')).toThrow();

    const document = sceneDocumentCodec.parseAndValidate(makeDocument([
      {
        id: 'overlay-missing-id',
        time: 0,
        type: 'lighting',
        params: { effect: 'overlay', mode: 'remove' },
      },
      {
        id: 'point-empty-id',
        time: 1,
        type: 'lighting',
        params: { effect: 'pointLight', mode: 'remove', id: '' },
      },
    ]));

    expect(document.statements[0].params).toMatchObject({ effect: 'overlay', mode: 'remove', id: '' });
    expect(document.statements[1].params).toMatchObject({ effect: 'pointLight', mode: 'remove', id: '' });
  });

  it('inherits a declared default model without inventing a placeholder when none exists', () => {
    const inherited = sceneStatementCompiler.compile(sceneDocumentCodec.parseAndValidate(makeDocument([{
      id: 'enter-default',
      time: 0,
      type: 'characterPresence',
      params: { mode: 'enter', id: 'tomori' },
    }]))).actions[0];
    expect(inherited.params.model).toBe('figure/tomori/model.json');

    const missing = sceneDocumentCodec.parseAndValidate({
      ...makeDocument([{
        id: 'enter-missing',
        time: 0,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'unknown' },
      }]),
      meta: { title: 'Task 2', characters: [] },
    });
    const missingCompiled = sceneStatementCompiler.compile(missing).actions[0];
    expect(missingCompiled.params).not.toHaveProperty('model');
  });

  it('accepts empty resource paths while reporting them as script errors', () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument([
      {
        id: 'environment-empty',
        time: 0,
        type: 'environmentLayer',
        params: { mode: 'set', layerId: 'background', file: '' },
      },
      {
        id: 'audio-empty',
        time: 1,
        type: 'audio',
        params: { role: 'bgm', mode: 'play', file: '' },
      },
      {
        id: 'image-empty',
        time: 2,
        type: 'graphicLayer',
        params: { kind: 'image', mode: 'set', id: 'poster', file: '' },
      },
      {
        id: 'voice-empty',
        time: 3,
        type: 'dialogue',
        params: { text: 'empty voice', durationSeconds: 1, voice: '' },
      },
      {
        id: 'model-empty',
        time: 4,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'hero', model: '', position: [0.5, 1], scale: 1 },
      },
      {
        id: 'animation-empty',
        time: 5,
        type: 'customAnimation',
        params: { target: 'hero', file: '', durationSeconds: 1 },
      },
    ]));

    expect(document.statements).toHaveLength(6);
    expect(validateSemanticSceneStructure(document)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        actionId: 'environment-empty',
        message: '环境画面资源为空，请选择或输入资源路径。',
      }),
      expect.objectContaining({
        severity: 'error',
        actionId: 'audio-empty',
        message: '背景音乐资源为空，请选择或输入资源路径。',
      }),
      expect.objectContaining({
        severity: 'error',
        actionId: 'image-empty',
        message: '图片图层资源为空，请选择或输入资源路径。',
      }),
      expect.objectContaining({
        severity: 'error',
        actionId: 'voice-empty',
        message: '对白语音资源为空，请选择或输入资源路径。',
      }),
      expect.objectContaining({
        severity: 'error',
        actionId: 'model-empty',
        message: '角色模型资源为空，请选择或输入资源路径。',
      }),
      expect.objectContaining({
        severity: 'error',
        actionId: 'animation-empty',
        message: '自定义动画资源为空，请选择或输入资源路径。',
      }),
    ]));
  });

  it('accepts illegal resource strings while reporting them as script errors', () => {
    const document = sceneDocumentCodec.parseAndValidate(makeDocument([
      {
        id: 'environment-absolute',
        time: 0,
        type: 'environmentLayer',
        params: { mode: 'set', layerId: 'background', file: 'D:/unmanaged/background.png' },
      },
      {
        id: 'voice-url',
        time: 1,
        type: 'dialogue',
        params: { text: 'url', durationSeconds: 1, voice: 'https://example.test/voice.ogg' },
      },
      {
        id: 'image-escape',
        time: 2,
        type: 'graphicLayer',
        params: { kind: 'image', mode: 'set', id: 'poster', file: '../outside.png' },
      },
    ]));

    expect(validateSemanticSceneStructure(document)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        actionId: 'environment-absolute',
        message: expect.stringContaining('本机绝对路径'),
      }),
      expect.objectContaining({
        severity: 'error',
        actionId: 'voice-url',
        message: expect.stringContaining('URL/协议路径'),
      }),
      expect.objectContaining({
        severity: 'error',
        actionId: 'image-escape',
        message: expect.stringContaining('逃逸项目资源根目录'),
      }),
    ]));
  });

  it('does not invent empty environment or image paths when source resources are missing', () => {
    const missingEnvironment = sceneDocumentCodec.parseAndValidate(makeDocument([{
      id: 'environment-missing',
      time: 0,
      type: 'environmentLayer',
      params: { mode: 'set', layerId: 'background' },
    }]));
    expect(sceneStatementCompiler.compile(missingEnvironment).actions[0].params)
      .not.toHaveProperty('image');

    const missingImage = sceneDocumentCodec.parseAndValidate(makeDocument([{
      id: 'image-missing',
      time: 0,
      type: 'graphicLayer',
      params: { kind: 'image', mode: 'set', id: 'poster' },
    }]));
    expect(sceneStatementCompiler.compile(missingImage).actions[0].params)
      .not.toHaveProperty('file');
  });

  it('rejects statements carrying the removed locked field', () => {
    expect(() => sceneDocumentCodec.parseAndValidate(makeDocument([
      {
        id: 'locked-legacy',
        time: 0,
        type: 'dialogue',
        params: { text: '遗留字段。', durationSeconds: 1 },
        locked: true,
      },
    ]))).toThrow(/Unknown field at scene\.statements\[0\]\.locked/);
  });
});

describe('ADR-0022 characterPerformance placeholder derivation', () => {
  it('treats only the exact empty-string motion as a placeholder', () => {
    expect(isCharacterPerformancePlaceholderParams({ target: '$speaker', motion: '' })).toBe(true);
    expect(isCharacterPerformancePlaceholderParams({ target: 'alice', motion: 'idle' })).toBe(false);
    expect(isCharacterPerformancePlaceholderParams({ target: 'alice' })).toBe(false);
    expect(isCharacterPerformancePlaceholderParams({ target: 'alice', motion: '  ' })).toBe(false);
  });

  it('detects placeholder companions by family and exact empty motion', () => {
    expect(isCharacterPerformancePlaceholderCompanion({
      type: 'characterPerformance',
      params: { target: '$speaker', motion: '' },
    })).toBe(true);
    expect(isCharacterPerformancePlaceholderCompanion({
      type: 'characterPerformance',
      params: { target: '$speaker', motion: 'idle' },
    })).toBe(false);
    expect(isCharacterPerformancePlaceholderCompanion({
      type: 'camera',
      params: { mode: 'focus', target: 'alice' },
    })).toBe(false);
  });
});

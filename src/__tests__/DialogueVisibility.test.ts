import { describe, expect, it } from 'vitest';
import type { CurrentSceneDocument, StatementFamily } from '../api/types/semantic-scene';
import type { RuntimeTimelineScene } from '../engine/RuntimeTimelineScene';
import { computeSceneStateAtTime } from '../engine/RuntimeSceneState';
import { CompatibleSceneSession } from '../services/semantic-scene/CompatibleSceneSession';
import { SceneDocumentCodec, sceneDocumentCodec } from '../services/semantic-scene/SceneDocumentCodec';
import { SceneStatementDefinitionRegistry } from '../services/semantic-scene/SceneStatementDefinitionRegistry';
import { sceneStatementCompiler } from '../services/semantic-scene/SceneStatementCompiler';
import { sceneStatementFactory } from '../services/semantic-scene/SceneStatementFactory';
import { payloadToSemanticIntent } from '../services/template-package/TemplateSemanticAuthoring';
import { createSemanticStatementDraftForBlock } from '../ui/timeline/semanticStatementBlocks';
import { buildSemanticDurationUpdateIntent, buildSemanticTimelineParamUpdateIntent } from '../ui/timeline/semanticTimelineEditing';

function createDocument(): CurrentSceneDocument {
  return sceneStatementFactory.createDocument({
    meta: { title: 'Visibility', durationSeconds: 10 },
    statements: [
      { id: 'hide', time: 1, type: 'dialogueVisibility', params: { visible: false } },
      { id: 'line', time: 2, type: 'dialogue', params: { text: 'Hello', durationSeconds: 5, voice: 'voice/hello.wav' } },
      { id: 'show', time: 4, type: 'dialogueVisibility', params: { visible: true } },
      { id: 'hide-again', time: 6, type: 'dialogueVisibility', params: { visible: false } },
    ],
  });
}

function runtimeScene(document: CurrentSceneDocument): RuntimeTimelineScene {
  const compiled = sceneStatementCompiler.compile(document);
  return {
    sceneId: compiled.sceneId,
    meta: compiled.meta,
    timeline: compiled.actions.map((action) => ({ ...action, _id: action.id })),
  };
}

describe('dialogue visibility scene contract', () => {
  it('round-trips and compiles an instantaneous visibility statement with stable source identity', () => {
    const document = createDocument();
    expect(sceneDocumentCodec.prepareForSave(document)).toEqual(document);
    const hide = sceneStatementCompiler.compile(document).actions[0];
    expect(hide).toMatchObject({
      time: 1, action: 'setDialogueVisibility', params: { visible: false, duration: 0 },
      source: { statementId: 'hide', outputKey: 'primary' },
      assetSlots: [],
    });
    const onlyVisibility = sceneStatementFactory.createDocument({
      meta: { title: 'Instant' },
      statements: [{ time: 3, type: 'dialogueVisibility', params: { visible: false } }],
    });
    expect(sceneStatementCompiler.compile(onlyVisibility).durationSeconds).toBe(3);
  });

  it.each([undefined, null, 'false', 0, 1])('rejects invalid visible=%s without coercion', (visible) => {
    expect(() => sceneDocumentCodec.parseAndValidate({
      ...createDocument(),
      statements: [{ id: 'bad', time: 0, type: 'dialogueVisibility', params: { visible } }],
    })).toThrow(/boolean/);
  });

  it('reconstructs persistent visibility in either seek direction without dropping dialogue or voice', () => {
    const scene = runtimeScene(createDocument());
    for (const [time, expected] of [[0, true], [1, false], [2, false], [4, true], [6, false], [9, false], [4, true], [3, false], [0, true]] as const) {
      const state = computeSceneStateAtTime(scene, time);
      expect(state.dialogueVisible, `at ${time}s`).toBe(expected);
      if (time >= 2) {
        expect(state.dialogue).toMatchObject({ text: 'Hello', voice: 'voice/hello.wav', startTime: 2, duration: 5 });
      }
    }
  });

  it('round-trips transition duration and includes it in the compiled scene extent', () => {
    const document = sceneStatementFactory.createDocument({
      meta: { title: 'Fade' },
      statements: [{ time: 3, type: 'dialogueVisibility', params: { visible: false, durationSeconds: 2 } }],
    });
    expect(sceneDocumentCodec.prepareForSave(document)).toEqual(document);
    const compiled = sceneStatementCompiler.compile(document);
    expect(compiled.durationSeconds).toBe(5);
    expect(compiled.actions[0].params).toEqual({ visible: false, duration: 2 });
    const store = {
      getCurrentSceneDocumentSnapshot: () => document,
      getCompiledSceneSnapshot: () => compiled,
    };
    expect(buildSemanticTimelineParamUpdateIntent(store, compiled.actions[0].id, { duration: 1 }))
      .toMatchObject({ patch: { params: { visible: false, durationSeconds: 1 } } });
    expect(buildSemanticDurationUpdateIntent(store, compiled.actions[0].id, 0))
      .toMatchObject({ patch: { params: { visible: false, durationSeconds: 0 } } });
  });

  it.each([-1, '1', null, Infinity, NaN])('rejects invalid transition duration %s', (durationSeconds) => {
    expect(() => sceneDocumentCodec.parseAndValidate({
      ...createDocument(),
      statements: [{ id: 'bad', time: 0, type: 'dialogueVisibility', params: { visible: false, durationSeconds } }],
    })).toThrow();
  });

  it('reconstructs interrupted fades from the current opacity in either seek direction', () => {
    const document = sceneStatementFactory.createDocument({
      meta: { title: 'Interrupted fade', durationSeconds: 8 },
      statements: [
        { time: 0, type: 'dialogue', params: { text: 'Hello', durationSeconds: 8, voice: 'voice.wav' } },
        { time: 1, type: 'dialogueVisibility', params: { visible: false, durationSeconds: 4 } },
        { time: 3, type: 'dialogueVisibility', params: { visible: true, durationSeconds: 2 } },
        { time: 6, type: 'dialogueVisibility', params: { visible: false, durationSeconds: 0 } },
      ],
    });
    const scene = runtimeScene(document);
    for (const [time, opacity] of [[0, 1], [1, 1], [2, 0.75], [3, 0.5], [4, 0.75], [5, 1], [6, 0], [7, 0], [4, 0.75], [2, 0.75], [0, 1]]) {
      const state = computeSceneStateAtTime(scene, time);
      expect(state.dialogueOpacity, `at ${time}s`).toBeCloseTo(opacity);
      expect(state.dialogue).toMatchObject({ text: 'Hello', voice: 'voice.wav', duration: 8 });
    }
  });

  it('uses source order for simultaneous visibility statements, independent of dialogue ordering', () => {
    const document = createDocument();
    const simultaneous = { ...document, statements: document.statements.slice(0, 3).map((statement) => ({ ...statement, time: 2 })) };
    expect(computeSceneStateAtTime(runtimeScene(simultaneous), 2).dialogueVisible).toBe(true);
    expect(computeSceneStateAtTime(runtimeScene({ ...simultaneous, statements: [...simultaneous.statements].reverse() }), 2).dialogueVisible).toBe(false);
  });

  it.each([3, 4, 5])('keeps scenes without visibility statements unchanged on loading schema v%s', (schemaVersion) => {
    const document = { schemaVersion, sceneId: 'old', meta: { title: 'Old' }, statements: [
      { id: 'line', time: 0, type: 'dialogue', params: { text: 'Old dialogue', durationSeconds: 2 } },
    ] };
    const projection = sceneDocumentCodec.parseAndValidate(document);
    expect(projection.statements).toEqual(document.statements);
    expect(computeSceneStateAtTime(runtimeScene(projection), 1).dialogueVisible).toBe(true);
    expect(sceneDocumentCodec.prepareForSave(projection)).toEqual({
      ...document, schemaVersion: 5,
      meta: schemaVersion === 3 ? { ...document.meta, durationSeconds: 2 } : document.meta,
    });
  });

  it.each([3, 4])('rejects v5-only statements mislabeled as historical schema v%s', (schemaVersion) => {
    expect(() => sceneDocumentCodec.parseAndValidate({ ...createDocument(), schemaVersion })).toThrow(/requires scene schemaVersion 5/);
  });

  it('preserves unknown visibility fields through edits, undo, redo and save', () => {
    const document = createDocument();
    const original = document.statements[0];
    const outcome = CompatibleSceneSession.open({ ...document, statements: [
      { ...original, futureStatement: 'keep', params: { ...original.params, futureEffect: { amount: 2 } } },
      ...document.statements.slice(1),
    ] });
    if (outcome.status !== 'ready') throw new Error(`Unexpected compatibility status: ${outcome.status}`);
    const session = outcome.session;
    session.applyTypedEdit({ ...session.projection, statements: session.projection.statements.map((statement) =>
      statement.id === 'hide' && statement.type === 'dialogueVisibility'
        ? { ...statement, params: { visible: true } }
        : statement,
    ) });
    const expected = { ...original, futureStatement: 'keep', params: { visible: true, futureEffect: { amount: 2 } } };
    expect(session.serialize()).toMatchObject({ statements: [expected, ...document.statements.slice(1)] });
    expect(session.undo()).toBe(true);
    expect(session.serialize()).toMatchObject({ statements: [{ params: { visible: false, futureEffect: { amount: 2 } } }, {}, {}, {}] });
    expect(session.redo()).toBe(true);
    expect(session.serialize()).toMatchObject({ statements: [expected, ...document.statements.slice(1)] });
  });

  it('makes readers without the new family reject the scene as incompatible', () => {
    class OlderRegistry extends SceneStatementDefinitionRegistry {
      override has(family: string): family is StatementFamily {
        return family !== 'dialogueVisibility' && super.has(family);
      }
    }
    const document = createDocument();
    expect(CompatibleSceneSession.open(document, new SceneDocumentCodec(new OlderRegistry()))).toMatchObject({
      status: 'incompatible', issue: { code: 'unknown_discriminator', path: 'scene.statements[0].type' },
    });
  });

  it('exposes both visibility choices in the statement library and accepts v5 template presets', () => {
    for (const [id, visible] of [['dialogue.hide', false], ['dialogue.show', true]] as const) {
      const draft = createSemanticStatementDraftForBlock(id, {});
      expect(draft).toEqual({ type: 'dialogueVisibility', params: { visible, durationSeconds: 0.3 } });
      const payload = { kind: 'statementPreset' as const, sceneSchemaVersion: 5 as const, statement: { type: 'dialogueVisibility', params: { visible } } };
      expect(payloadToSemanticIntent(payload, { anchorTime: 2, correlationId: id })).toMatchObject({ statement: payload.statement });
      expect(() => payloadToSemanticIntent({ ...payload, sceneSchemaVersion: 4 }, { anchorTime: 2, correlationId: id })).toThrow(/requires scene schemaVersion 5/);
    }
  });

  it('maps timeline visibility edits back to the source statement', () => {
    const document = createDocument();
    const compiled = sceneStatementCompiler.compile(document);
    const store = {
      getCurrentSceneDocumentSnapshot: () => document,
      getCompiledSceneSnapshot: () => compiled,
    };
    expect(buildSemanticTimelineParamUpdateIntent(store, compiled.actions[0].id, { visible: true })).toMatchObject({
      kind: 'update-statement', statementId: 'hide', patch: { params: { visible: true } },
    });
  });
});

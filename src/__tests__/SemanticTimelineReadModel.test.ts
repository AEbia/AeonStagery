import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import {
  sceneDocumentCodec,
  sceneStatementCompiler,
  withSceneDocumentCanonicalOrder,
} from '../services/semantic-scene';
import { buildSemanticTimelineReadModel } from '../ui/timeline/semanticTimelineReadModel';

function makeDocument(): CurrentSceneDocument {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'read-model-scene',
    meta: { title: 'Read model scene' },
    statements: [
      {
        id: 'line_1',
        time: 4,
        type: 'dialogue',
        params: { text: 'Hello', durationSeconds: 2 },
        companions: [
          {
            id: 'focus',
            anchor: 'end',
            offset: 0.5,
            type: 'camera',
            params: { mode: 'focus', position: [0, 0], zoom: { kind: 'delta', value: 0.2 } },
          },
        ],
      },
      {
        id: 'performance_1',
        time: 1,
        type: 'characterPerformance',
        params: { target: 'alice', motion: { kind: 'resource', key: 'wave' }, expression: 'smile' },
      },
    ],
  });
}

describe('semantic timeline read model', () => {
  it('projects one item per source statement and dialogue companion', () => {
    const document = makeDocument();
    const compiled = sceneStatementCompiler.compile(document);
    const items = buildSemanticTimelineReadModel(document, compiled);

    expect(items.map((item) => item.locator)).toEqual([
      { kind: 'statement', statementId: 'performance_1' },
      { kind: 'statement', statementId: 'line_1' },
      { kind: 'companion', statementId: 'line_1', companionId: 'focus' },
    ]);
    expect(items[2].time).toBe(6.5);
    expect(items[2].durationSeconds).toBe(0);
    expect(items[0].displayAction._id).toBeTruthy();
    expect(items[0].displayAction).toMatchObject({
      semanticType: 'characterPerformance',
      semanticCategory: 'character',
      semanticLabel: '角色表演',
      semanticIconKey: 'setExpression',
      sourceParams: expect.objectContaining({ target: 'alice', motion: { kind: 'resource', key: 'wave' }, expression: 'smile' }),
    });
    expect(items[2].displayAction).toMatchObject({
      semanticType: 'camera',
      semanticCategory: 'camera',
      semanticLabel: '镜头聚焦',
      semanticIconKey: 'cameraMotion',
    });
  });

  it('does not require compiled actions to preserve source locators', () => {
    const items = buildSemanticTimelineReadModel(makeDocument(), null);

    expect(items.map((item) => item.id)).toEqual([
      'performance_1',
      'line_1',
      'focus',
    ]);
    expect(items[1].displayAction.action).toBe('dialogue');
    expect(items[1].displayAction.semanticLabel).toBe('对话');
    expect(items[1].displayAction.sourceParams).toEqual(expect.objectContaining({ text: 'Hello', durationSeconds: 2 }));
  });

  it('orders equal-time statements by canonical order and keeps companion order stable', () => {
    const document = withSceneDocumentCanonicalOrder(sceneDocumentCodec.parseAndValidate({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'read-model-canonical-order',
      meta: { title: 'Read model canonical order' },
      statements: [
        {
          id: 'second',
          time: 3,
          type: 'dialogue',
          params: { text: 'Second', durationSeconds: 1 },
          companions: [
            {
              id: 'second-companion',
              anchor: 'start',
              offset: 0,
              type: 'camera',
              params: { mode: 'focus', position: [0, 0] },
            },
          ],
        },
        {
          id: 'first',
          time: 3,
          type: 'dialogue',
          params: { text: 'First', durationSeconds: 1 },
          companions: [
            {
              id: 'first-companion-a',
              anchor: 'start',
              offset: 0,
              type: 'camera',
              params: { mode: 'focus', position: [0, 0] },
            },
            {
              id: 'first-companion-b',
              anchor: 'start',
              offset: 0,
              type: 'camera',
              params: { mode: 'focus', position: [1, 0] },
            },
          ],
        },
      ],
    }), ['first', 'second']);

    const items = buildSemanticTimelineReadModel(document, null);

    expect(items.map((item) => item.locator)).toEqual([
      { kind: 'statement', statementId: 'first' },
      { kind: 'companion', statementId: 'first', companionId: 'first-companion-a' },
      { kind: 'companion', statementId: 'first', companionId: 'first-companion-b' },
      { kind: 'statement', statementId: 'second' },
      { kind: 'companion', statementId: 'second', companionId: 'second-companion' },
    ]);
  });

  it('projects an ADR-0022 placeholder companion as an anchored, uncompiled block', () => {
    const document = sceneDocumentCodec.parseAndValidate({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'read-model-placeholder',
      meta: { title: 'Read model placeholder' },
      statements: [
        {
          id: 'line_1',
          time: 4,
          type: 'dialogue',
          params: { speakerId: 'alice', speaker: 'Alice', text: '你好。', durationSeconds: 2 },
          companions: [
            {
              id: 'cmp_placeholder',
              anchor: 'start',
              offset: 0,
              type: 'characterPerformance',
              params: { target: '$speaker', motion: '' },
            },
          ],
        },
      ],
    });
    const items = buildSemanticTimelineReadModel(document, null);

    const placeholder = items.find((item) => item.companionId === 'cmp_placeholder');
    expect(placeholder).toBeDefined();
    expect(placeholder?.locator).toEqual({
      kind: 'companion',
      statementId: 'line_1',
      companionId: 'cmp_placeholder',
    });
    expect(placeholder?.time).toBe(4);
    expect(placeholder?.durationSeconds).toBe(0);
    expect(placeholder?.displayAction).toMatchObject({
      action: 'characterPerformance',
      semanticType: 'characterPerformance',
      semanticLabel: '角色表演',
      semanticIconKey: 'playMotion',
      sourceParams: { target: '$speaker', motion: '' },
      resolvedSpeakerId: 'alice',
    });
  });

  it('does not stamp resolvedSpeakerId when the placeholder target is not $speaker', () => {
    const document = sceneDocumentCodec.parseAndValidate({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'read-model-placeholder-resolved-target',
      meta: { title: 'Read model placeholder resolved target' },
      statements: [
        {
          id: 'line_1',
          time: 4,
          type: 'dialogue',
          params: { speakerId: 'alice', speaker: 'Alice', text: '你好。', durationSeconds: 2 },
          companions: [
            {
              id: 'cmp_placeholder',
              anchor: 'start',
              offset: 0,
              type: 'characterPerformance',
              params: { target: 'taki', motion: '' },
            },
          ],
        },
      ],
    });
    const items = buildSemanticTimelineReadModel(document, null);

    const placeholder = items.find((item) => item.companionId === 'cmp_placeholder');
    expect(placeholder?.displayAction.resolvedSpeakerId).toBeUndefined();
  });

  it('keeps resolving the parent speaker when the $speaker companion motion is filled', () => {
    // ADR-0022: the performance stage fills the empty motion while the target
    // stays the literal $speaker token. The auto-binding to the parent
    // dialogue speaker must survive the fill — surfaces that read the raw
    // source target (inspector binding field, search, model pickers) would
    // otherwise fall back to the raw token and look unbound.
    const document = sceneDocumentCodec.parseAndValidate({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'read-model-placeholder-filled-motion',
      meta: { title: 'Read model placeholder filled motion' },
      statements: [
        {
          id: 'line_1',
          time: 4,
          type: 'dialogue',
          params: { speakerId: 'alice', speaker: 'Alice', text: '你好。', durationSeconds: 2 },
          companions: [
            {
              id: 'cmp_perf',
              anchor: 'start',
              offset: 0,
              type: 'characterPerformance',
              params: {
                target: '$speaker',
                motion: { kind: 'resource', key: 'wave' },
              },
            },
          ],
        },
      ],
    });
    const items = buildSemanticTimelineReadModel(document, null);

    const performance = items.find((item) => item.companionId === 'cmp_perf');
    expect(performance?.displayAction.resolvedSpeakerId).toBe('alice');
    expect(performance?.displayAction.sourceParams).toMatchObject({
      target: '$speaker',
      motion: { kind: 'resource', key: 'wave' },
    });
  });
});

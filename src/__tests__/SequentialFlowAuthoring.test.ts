import { describe, expect, it } from 'vitest';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import {
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import { PACE_GAP, estimateDialogueDuration } from '../services/pacing/pacing';
import { SemanticTimelineAuthoringService } from '../services/timeline-authoring/SemanticTimelineAuthoringService';
import {
  buildAppendSequentialLinesIntent,
  buildInsertDialogueInChainIntent,
  compileSequentialDialogueDrafts,
  computeTimelineEndSeconds,
} from '../services/sequential-flow/SequentialFlowAuthoring';

function makeDocument(overrides: Partial<CurrentSceneDocument> = {}): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_v2',
    meta: {
      title: 'Test',
      characters: [{ id: 'tomori', name: '灯' }],
    },
    statements: [],
    ...overrides,
  };
}

describe('SequentialDialogueCompiler', () => {
  it('keeps input order and materializes durations with normal pace gaps', () => {
    const lines = ['你好。', '我想把这句话说清楚。', '今天也要一起前进。'];
    const result = compileSequentialDialogueDrafts(lines);

    expect(result.statements.map((statement) => statement.type)).toEqual([
      'dialogue',
      'dialogue',
      'dialogue',
    ]);
    expect(result.statements.map((statement) => statement.time)).toEqual([0, 2.1, 4.8]);
    expect(result.statements.map((statement) => (statement.params as any).text)).toEqual(lines);
    expect(result.statements.map((statement) => (statement.params as any).durationSeconds))
      .toEqual(lines.map((text) => estimateDialogueDuration(text, 'normal')));

    for (let index = 1; index < result.statements.length; index += 1) {
      const previous = result.statements[index - 1];
      const current = result.statements[index];
      expect((current.time ?? 0) - ((previous.time ?? 0) + (previous.params as any).durationSeconds))
        .toBeCloseTo(PACE_GAP.normal, 6);
    }

    const last = result.statements[result.statements.length - 1];
    expect(result.durationSeconds).toBe(
      (last.time ?? 0) + (last.params as any).durationSeconds + PACE_GAP.normal,
    );
  });

  it('skips blank and whitespace-only lines while keeping the rest in order', () => {
    const result = compileSequentialDialogueDrafts(['', '   ', '第一句。', '  ']);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0].time).toBe(0);
    expect((result.statements[0].params as any).text).toBe('第一句。');
  });

  it('trims surrounding whitespace from each line', () => {
    const result = compileSequentialDialogueDrafts(['  你好。  ']);
    expect((result.statements[0].params as any).text).toBe('你好。');
  });

  it('paces with the requested tier including gaps', () => {
    const lines = ['你好。', '我想把这句话说清楚。'];
    const result = compileSequentialDialogueDrafts(lines, 'slow');

    expect(result.statements.map((statement) => (statement.params as any).durationSeconds))
      .toEqual(lines.map((text) => estimateDialogueDuration(text, 'slow')));
    const previous = result.statements[0];
    const current = result.statements[1];
    expect((current.time ?? 0) - ((previous.time ?? 0) + (previous.params as any).durationSeconds))
      .toBeCloseTo(PACE_GAP.slow, 6);
  });

  it('returns no statements and zero duration for empty input', () => {
    const result = compileSequentialDialogueDrafts([]);
    expect(result.statements).toEqual([]);
    expect(result.durationSeconds).toBe(0);
  });

  it('computes the timeline end from statements, companions, and explicit duration', () => {
    const document = makeDocument({
      meta: { title: 'Test', durationSeconds: 5 },
      statements: [
        {
          id: 'dlg_1',
          time: 1,
          type: 'dialogue',
          params: { text: '已有。', durationSeconds: 2, style: 'typewriter' },
          companions: [{
            id: 'sfx_1',
            anchor: 'end',
            offset: 0.5,
            type: 'audio',
            params: { role: 'sfx', mode: 'play', instanceId: 's1', file: 'a.wav', durationSeconds: 1 },
          }],
        },
      ],
    });
    expect(computeTimelineEndSeconds(document)).toBe(5);
  });

  it('computes the timeline end from statements when no explicit duration is set', () => {
    const document = makeDocument({
      statements: [
        {
          id: 'dlg_1',
          time: 1,
          type: 'dialogue',
          params: { text: '已有。', durationSeconds: 2, style: 'typewriter' },
        },
      ],
    });
    expect(computeTimelineEndSeconds(document)).toBe(3);
  });

  it('includes start-anchored companions and rounds the result to tenths', () => {
    const document = makeDocument({
      statements: [
        {
          id: 'dlg_1',
          time: 1.12,
          type: 'dialogue',
          params: { text: '已有。', durationSeconds: 2, style: 'typewriter' },
          companions: [{
            id: 'sfx_1',
            anchor: 'start',
            offset: 4,
            type: 'audio',
            params: { role: 'sfx', mode: 'play', instanceId: 's1', file: 'a.wav', durationSeconds: 2 },
          }],
        },
      ],
    });
    expect(computeTimelineEndSeconds(document)).toBe(7.1);
  });
});

describe('buildAppendSequentialLinesIntent', () => {
  it('builds a v3 append intent with the sequential-flow origin by default', () => {
    const intent = buildAppendSequentialLinesIntent(['你好。'], {
      correlationId: 'intent_seq_1',
    });
    expect(intent).toEqual({
      version: AUTHORING_SCHEMA_VERSION,
      kind: 'append-sequential-lines',
      correlationId: 'intent_seq_1',
      origin: 'sequential-flow',
      lines: ['你好。'],
    });
  });

  it('keeps an explicit pace and origin override', () => {
    const intent = buildAppendSequentialLinesIntent(['你好。'], {
      correlationId: 'intent_seq_2',
      origin: 'timeline-editor',
      pace: 'slow',
    });
    expect(intent).toEqual({
      version: AUTHORING_SCHEMA_VERSION,
      kind: 'append-sequential-lines',
      correlationId: 'intent_seq_2',
      origin: 'timeline-editor',
      pace: 'slow',
      lines: ['你好。'],
    });
  });
});

describe('SemanticTimelineAuthoringService append-sequential-lines', () => {
  it('appends dialogue lines after the current timeline end in input order', () => {
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
    });
    let statementIndex = 1;
    const document = makeDocument({
      statements: [
        {
          id: 'dlg_1',
          time: 1,
          type: 'dialogue',
          params: { text: '已有。', durationSeconds: 2, style: 'typewriter' },
        },
      ],
    });

    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_3',
      origin: 'sequential-flow',
      kind: 'append-sequential-lines',
      lines: ['你好。', '我想把这句话说清楚。'],
    });

    expect(document.statements).toHaveLength(1);
    expect(result.document.statements.map((statement) => [statement.id, statement.type, statement.time]))
      .toEqual([
        ['dlg_1', 'dialogue', 1],
        ['dlg_2', 'dialogue', 3],
        ['dlg_3', 'dialogue', 5.1],
      ]);
    expect(result.document.statements[1].params).toEqual({
      text: '你好。',
      durationSeconds: estimateDialogueDuration('你好。', 'normal'),
      style: 'typewriter',
    });
    const second = result.document.statements[2];
    expect(second.time - (result.document.statements[1].time + (result.document.statements[1].params as any).durationSeconds))
      .toBe(PACE_GAP.normal);
    expect(result.document.meta.durationSeconds).toBe(7.8);

    expect(result.receipt).toEqual(expect.objectContaining({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_3',
      intentType: 'append-sequential-lines',
      origin: 'sequential-flow',
      historyDescriptor: {
        key: 'timeline.author.appendSequentialLines',
        args: { count: 2 },
        fallbackLabel: '顺序铺排',
      },
      createdStatementIds: ['dlg_2', 'dlg_3'],
      timeRange: { start: 3, end: 7.8 },
    }));
  });

  it('appends after the explicit scene duration when it exceeds the statement end', () => {
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
    });
    let statementIndex = 1;
    const document = makeDocument({
      meta: { title: 'Test', durationSeconds: 10 },
      statements: [
        {
          id: 'dlg_1',
          time: 1,
          type: 'dialogue',
          params: { text: '已有。', durationSeconds: 2, style: 'typewriter' },
        },
      ],
    });

    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_4',
      origin: 'sequential-flow',
      kind: 'append-sequential-lines',
      lines: ['你好。'],
    });

    expect(result.document.statements[1].time).toBe(10);
    expect(result.document.meta.durationSeconds).toBe(12.1);
  });

  it('paces appended lines with the requested tier', () => {
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
    });
    let statementIndex = 1;

    const result = service.author(makeDocument(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_5',
      origin: 'sequential-flow',
      kind: 'append-sequential-lines',
      pace: 'slow',
      lines: ['你好。', '我想把这句话说清楚。'],
    });

    const first = result.document.statements[0];
    const second = result.document.statements[1];
    expect((first.params as any).durationSeconds).toBe(estimateDialogueDuration('你好。', 'slow'));
    expect(second.time - (first.time + (first.params as any).durationSeconds)).toBeCloseTo(PACE_GAP.slow, 6);
  });

  it('re-anchors appends at the remaining end after deleting trailing statements', () => {
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
    });
    let statementIndex = 1;
    let document = makeDocument({
      statements: [
        {
          id: 'dlg_1',
          time: 0,
          type: 'dialogue',
          params: { text: '已有。', durationSeconds: 2, style: 'typewriter' },
        },
      ],
    });

    const appended = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_7',
      origin: 'sequential-flow',
      kind: 'append-sequential-lines',
      lines: ['你好。'],
    });
    expect(appended.document.meta.durationSeconds).toBe(4.1);

    const deleted = service.author(appended.document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_8',
      origin: 'timeline-editor',
      kind: 'delete-statements',
      statementIds: ['dlg_2'],
    });
    expect(deleted.document.meta.durationSeconds).toBe(2);

    const reAppended = service.author(deleted.document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_9',
      origin: 'sequential-flow',
      kind: 'append-sequential-lines',
      lines: ['这句话说得再久一些。'],
    });

    expect(reAppended.document.statements.map((statement) => [statement.id, statement.time]))
      .toEqual([
        ['dlg_1', 0],
        ['dlg_3', 2],
      ]);
    expect(reAppended.document.meta.durationSeconds).toBe(4.7);
  });

  it('re-anchors appends after a flow delete of the trailing statement', () => {
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
    });
    let statementIndex = 1;
    const appended = service.author(makeDocument({
      statements: [
        {
          id: 'dlg_1',
          time: 0,
          type: 'dialogue',
          params: { text: '已有。', durationSeconds: 2, style: 'typewriter' },
        },
      ],
    }), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_10',
      origin: 'sequential-flow',
      kind: 'append-sequential-lines',
      lines: ['你好。'],
    });

    const deleted = service.author(appended.document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_11',
      origin: 'timeline-editor',
      kind: 'delete-statements',
      statementIds: ['dlg_2'],
      flow: true,
    });
    expect(deleted.document.meta.durationSeconds).toBe(2);

    const reAppended = service.author(deleted.document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_12',
      origin: 'sequential-flow',
      kind: 'append-sequential-lines',
      lines: ['你好。'],
    });
    expect(reAppended.document.statements[1].time).toBe(2);
  });

  it('restores append anchoring to zero after deleting every statement', () => {
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
    });
    let statementIndex = 1;
    const appended = service.author(makeDocument({
      statements: [
        {
          id: 'dlg_1',
          time: 0,
          type: 'dialogue',
          params: { text: '已有。', durationSeconds: 2, style: 'typewriter' },
        },
      ],
    }), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_13',
      origin: 'sequential-flow',
      kind: 'append-sequential-lines',
      lines: ['你好。'],
    });

    const deleted = service.author(appended.document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_14',
      origin: 'timeline-editor',
      kind: 'delete-statements',
      statementIds: ['dlg_1', 'dlg_2'],
    });
    expect(deleted.document.statements).toEqual([]);
    expect(deleted.document.meta.durationSeconds).toBeUndefined();

    const reAppended = service.author(deleted.document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_15',
      origin: 'sequential-flow',
      kind: 'append-sequential-lines',
      lines: ['你好。'],
    });
    expect(reAppended.document.statements[0].time).toBe(0);
  });

  it('rejects empty line batches without mutating the document', () => {
    const service = new SemanticTimelineAuthoringService();
    const document = makeDocument();

    expect(() => service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_seq_6',
      origin: 'sequential-flow',
      kind: 'append-sequential-lines',
      lines: ['   ', ''],
    })).toThrow('Sequential authoring requires at least one non-empty line');
    expect(document.statements).toEqual([]);
    expect(document.meta.durationSeconds).toBeUndefined();
  });
});

describe('buildInsertDialogueInChainIntent', () => {
  it('builds a v3 insert-dialogue-in-chain intent with an optional beforeStatementId', () => {
    expect(buildInsertDialogueInChainIntent('插入句。', {
      correlationId: 'intent_chain_1',
    }, 'dlg_b')).toEqual({
      version: AUTHORING_SCHEMA_VERSION,
      kind: 'insert-dialogue-in-chain',
      correlationId: 'intent_chain_1',
      origin: 'sequential-flow',
      text: '插入句。',
      beforeStatementId: 'dlg_b',
    });

    expect(buildInsertDialogueInChainIntent('末尾句。', {
      correlationId: 'intent_chain_2',
    })).toEqual({
      version: AUTHORING_SCHEMA_VERSION,
      kind: 'insert-dialogue-in-chain',
      correlationId: 'intent_chain_2',
      origin: 'sequential-flow',
      text: '末尾句。',
    });
  });
});

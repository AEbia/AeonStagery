import { describe, expect, it } from 'vitest';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import {
  SCENE_SCHEMA_VERSION,
  type CharacterMotionOutput,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import { getSceneDocumentCanonicalOrder, sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';
import { SemanticTimelineAuthoringService } from '../services/timeline-authoring/SemanticTimelineAuthoringService';
import { PACE_GAP, estimateDialogueDuration } from '../services/pacing/pacing';

function makeDocument(overrides: Partial<CurrentSceneDocument> = {}): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_v2',
    meta: {
      title: 'Test',
      characters: [
        { id: 'tomori', name: '灯' },
      ],
    },
    statements: [],
    ...overrides,
  };
}

function makeCustomMotion(durationSeconds: number, key = 'wave'): Extract<CharacterMotionOutput, { kind: 'custom' }> {
  return {
    kind: 'custom',
    durationSeconds,
    fadeInSeconds: 0.2,
    derivedFrom: { key },
    tracks: [
      {
        parameterId: 'PARAM_ANGLE_X',
        keyframes: [
          { time: 0, value: 0, segment: { type: 'linear' } },
          { time: durationSeconds, value: 5 },
        ],
      },
    ],
  };
}

describe('SemanticTimelineAuthoringService', () => {
  it.each(['insert-statement', 'insert-dialogue-in-chain', 'append-sequential-lines'] as const)(
    'allows the configured typewriter to finish when creating dialogue through %s', (kind) => {
      const service = new SemanticTimelineAuthoringService({
        getDialogueTypewriterTiming: () => ({ textSpeed: 0.1, entranceAnimation: true }),
      });
      const text = '文'.repeat(100);
      const base = { version: AUTHORING_SCHEMA_VERSION, correlationId: 'insert_typewriter', origin: 'timeline-editor' as const };
      const intent = kind === 'insert-statement'
        ? { ...base, kind, anchorTime: 0, statement: { type: 'dialogue' as const, params: { text, durationSeconds: 2 } } }
        : kind === 'insert-dialogue-in-chain' ? { ...base, kind, text } : { ...base, kind, lines: [text, text] };
      const result = service.author(makeDocument(), intent);
      expect((result.document.statements[0].params as any).durationSeconds).toBe(10.2);
      if (kind === 'append-sequential-lines') {
        expect(result.document.statements[1].time).toBe(10.2 + PACE_GAP.normal);
      }
      expect(sceneDocumentCodec.parseAndValidate(result.document)).toBeDefined();
    },
  );

  it('reads current typewriter settings on text edits, allows manual shortening, and shrinks after shortening text', () => {
    let textSpeed = 0.1;
    const service = new SemanticTimelineAuthoringService({
      getDialogueTypewriterTiming: () => ({ textSpeed, entranceAnimation: true }),
    });
    let document = makeDocument({
      statements: [{ id: 'line_1', time: 0, type: 'dialogue', params: { text: 'Hello', durationSeconds: 2 } }],
    });
    const update = (text: string, durationSeconds: number, style: 'typewriter' | 'instant' = 'typewriter') => {
      document = service.author(document, {
        version: AUTHORING_SCHEMA_VERSION, correlationId: 'update_typewriter', origin: 'timeline-editor',
        kind: 'update-statement', statementId: 'line_1', patch: { params: { text, durationSeconds, style } },
      }).document;
      return (document.statements[0].params as any).durationSeconds;
    };
    expect(update('文'.repeat(100), 2)).toBe(10.2);
    expect(update('文'.repeat(100), 0.3)).toBe(0.3);
    textSpeed = 0.2;
    expect(update('文'.repeat(101), 0.3)).toBe(20.4);
    expect(update('短', 20.4)).toBe(estimateDialogueDuration('短', 'normal'));
    expect(update('文'.repeat(100), 1.6, 'instant')).toBe(estimateDialogueDuration('文'.repeat(100), 'normal'));
    expect(update('手工改文', 0.4)).toBe(0.4);
  });

  it.each(['raw-script', 'ai-script-panel'] as const)('preserves explicit insert timing from %s', (origin) => {
    const service = new SemanticTimelineAuthoringService({
      getDialogueTypewriterTiming: () => ({ textSpeed: 0.1, entranceAnimation: true }),
    });
    const result = service.author(makeDocument(), {
      version: AUTHORING_SCHEMA_VERSION, correlationId: 'authored_insert', origin,
      kind: 'insert-statement', anchorTime: 0,
      statement: { type: 'dialogue', params: { text: '文'.repeat(100), durationSeconds: 0.3 } },
    });
    expect((result.document.statements[0].params as any).durationSeconds).toBe(0.3);
  });

  it('preserves a manually shortened duration when other dialogue properties change', () => {
    const document = makeDocument({
      statements: [{ id: 'line_1', time: 0, type: 'dialogue', params: { text: 'Hello', durationSeconds: 0.3 } }],
    });
    const result = new SemanticTimelineAuthoringService().author(document, {
      version: AUTHORING_SCHEMA_VERSION, correlationId: 'keep_manual_duration', origin: 'timeline-editor',
      kind: 'update-statement', statementId: 'line_1',
      patch: { params: { text: 'Hello', durationSeconds: 0.3, textColor: '#ff0000' } },
    });
    expect((result.document.statements[0].params as any).durationSeconds).toBe(0.3);
  });

  it('extends an explicit scene end when a statement duration grows', () => {
    const document = makeDocument({
      meta: { title: 'Test', characters: [], durationSeconds: 3 },
      statements: [{ id: 'line_1', time: 2, type: 'dialogue', params: { text: 'Hi', durationSeconds: 1 } }],
    });

    const result = new SemanticTimelineAuthoringService().author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'extend_statement_duration',
      origin: 'timeline-editor',
      kind: 'update-statement',
      statementId: 'line_1',
      patch: { params: { text: 'Hi', durationSeconds: 4 } },
    });

    expect(result.document.meta.durationSeconds).toBe(6);
    expect(sceneDocumentCodec.parseAndValidate(result.document)).toBeDefined();
  });

  it('extends an explicit scene end when dialogue text increases its estimated duration', () => {
    const text = '我想把这句话说清楚。';
    const document = makeDocument({
      meta: { title: 'Test', characters: [], durationSeconds: 3 },
      statements: [{ id: 'line_1', time: 2, type: 'dialogue', params: { text: 'Hi', durationSeconds: 1 } }],
    });

    const result = new SemanticTimelineAuthoringService().author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'extend_dialogue_text',
      origin: 'timeline-editor',
      kind: 'update-statement',
      statementId: 'line_1',
      patch: { params: { text, durationSeconds: 1 } },
    });

    const expectedDuration = estimateDialogueDuration(text, 'normal');
    expect(expectedDuration).toBeGreaterThan(1);
    expect(result.document.meta.durationSeconds).toBe(2 + expectedDuration);
  });

  it('extends an explicit scene end when a companion duration grows', () => {
    const document = makeDocument({
      meta: { title: 'Test', characters: [{ id: 'tomori', name: '灯' }], durationSeconds: 4.5 },
      statements: [{
        id: 'line_1', time: 1, type: 'dialogue',
        params: { text: 'Hi', durationSeconds: 2 },
        companions: [{
          id: 'camera_1', anchor: 'end', offset: 0.5, type: 'camera',
          params: { mode: 'focus', target: '$speaker', durationSeconds: 1 },
        }],
      }],
    });

    const result = new SemanticTimelineAuthoringService().author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'extend_companion_duration',
      origin: 'timeline-editor',
      kind: 'update-dialogue-companion',
      locator: { statementId: 'line_1', companionId: 'camera_1' },
      patch: { params: { mode: 'focus', target: '$speaker', durationSeconds: 3 } },
    });

    expect(result.document.meta.durationSeconds).toBe(6.5);
    expect(sceneDocumentCodec.parseAndValidate(result.document)).toBeDefined();
  });

  it('inserts a statement and emits a v2 statement receipt', () => {
    const document = makeDocument();
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_1`,
    });

    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_insert_statement',
      origin: 'timeline-editor',
      kind: 'insert-statement',
      anchorTime: 2,
      statement: {
        type: 'dialogue',
        time: 0.5,
        params: {
          speakerId: 'tomori',
          text: '我在。',
          durationSeconds: 1.5,
        },
      },
    });

    expect(document.statements).toEqual([]);
    expect(result.document.statements).toEqual([
      expect.objectContaining({
        id: 'dlg_1',
        type: 'dialogue',
        time: 2.5,
      }),
    ]);
    expect(result.receipt).toEqual(expect.objectContaining({
      version: AUTHORING_SCHEMA_VERSION,
      intentType: 'insert-statement',
      createdStatementIds: ['dlg_1'],
      createdMarkerIds: [],
      timeRange: { start: 2.5, end: 4 },
    }));
    expect(result.receipt).not.toHaveProperty('createdActionIds');
  });

  it('saves dialogue without a speakerId as narrator dialogue', () => {
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_narrator`,
    });

    const result = service.author(makeDocument(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'insert_narrator_statement',
      origin: 'timeline-editor',
      kind: 'insert-statement',
      anchorTime: 1,
      statement: {
        type: 'dialogue',
        params: { text: '这是旁白。', durationSeconds: 2 },
      },
    });

    expect(result.document.statements[0]).toMatchObject({
      id: 'dlg_narrator',
      type: 'dialogue',
      params: { text: '这是旁白。', durationSeconds: 2 },
    });
    expect(result.document.statements[0].params).not.toHaveProperty('speakerId');
  });

  it('deletes parent statements with companion locators in the receipt', () => {
    const document = makeDocument({
      statements: [
        {
          id: 'line_1',
          time: 3,
          type: 'dialogue',
          params: {
            speakerId: 'tomori',
            text: '听我说。',
            durationSeconds: 2,
          },
          companions: [
            {
              id: 'cmp_focus',
              anchor: 'start',
              offset: 0,
              type: 'camera',
              params: {
                mode: 'focus',
                target: '$speaker',
              },
            },
          ],
        },
      ],
    });
    const service = new SemanticTimelineAuthoringService();

    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_delete_statement',
      origin: 'timeline-editor',
      kind: 'delete-statements',
      statementIds: ['line_1'],
    });

    expect(result.document.statements).toEqual([]);
    expect(result.receipt.deletedStatementIds).toEqual(['line_1']);
    expect(result.receipt.deletedCompanionLocators).toEqual([
      { statementId: 'line_1', companionId: 'cmp_focus' },
    ]);
  });

  it('moves root statements through v2 timeline locators', () => {
    const document = makeDocument({
      statements: [
        {
          id: 'line_1',
          time: 3,
          type: 'dialogue',
          params: {
            speakerId: 'tomori',
            text: '听我说。',
            durationSeconds: 2,
          },
        },
      ],
    });
    const service = new SemanticTimelineAuthoringService();

    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_move_statement',
      origin: 'timeline-editor',
      kind: 'move-timeline-locators',
      moves: [
        {
          locator: { kind: 'statement', statementId: 'line_1' },
          time: 7.24,
        },
      ],
    });

    expect(document.statements[0].time).toBe(3);
    expect(result.document.statements[0].time).toBe(7.2);
    expect(result.receipt).toEqual(expect.objectContaining({
      intentType: 'move-timeline-locators',
      updatedStatementIds: ['line_1'],
      updatedCompanionLocators: [],
      timeRange: { start: 7.2, end: 9.2 },
    }));
  });

  it('extends the scene when moving a custom motion past its previous end', () => {
    const document = makeDocument({
      meta: {
        title: 'Test',
        durationSeconds: 3,
        characters: [{ id: 'tomori', name: '灯' }],
      },
      statements: [
        {
          id: 'motion_1',
          time: 2,
          type: 'characterPerformance',
          params: {
            target: 'tomori',
            motion: makeCustomMotion(1),
          },
        },
      ],
    });
    const service = new SemanticTimelineAuthoringService();

    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_move_custom_motion',
      origin: 'timeline-editor',
      kind: 'move-timeline-locators',
      moves: [
        {
          locator: { kind: 'statement', statementId: 'motion_1' },
          time: 2.1,
        },
      ],
    });

    expect(result.document.statements[0].time).toBe(2.1);
    expect(result.document.meta.durationSeconds).toBe(3.1);
    expect(sceneDocumentCodec.parseAndValidate(result.document)).toBeDefined();
  });

  it('moves companions by rewriting their source offset relative to the moved parent', () => {
    const document = makeDocument({
      statements: [
        {
          id: 'line_1',
          time: 3,
          type: 'dialogue',
          params: {
            speakerId: 'tomori',
            text: '听我说。',
            durationSeconds: 2,
          },
          companions: [
            {
              id: 'cmp_focus',
              anchor: 'end',
              offset: 0.5,
              type: 'camera',
              params: {
                mode: 'focus',
                target: '$speaker',
              },
            },
          ],
        },
      ],
    });
    const service = new SemanticTimelineAuthoringService();

    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_move_companion',
      origin: 'timeline-editor',
      kind: 'move-timeline-locators',
      moves: [
        {
          locator: { kind: 'statement', statementId: 'line_1' },
          time: 4,
        },
        {
          locator: { kind: 'companion', statementId: 'line_1', companionId: 'cmp_focus' },
          time: 6.5,
        },
      ],
    });

    const movedLine = result.document.statements[0];
    expect(movedLine.time).toBe(4);
    expect(movedLine.companions?.[0].offset).toBe(0.5);
    expect(result.receipt.updatedStatementIds).toEqual(['line_1']);
    expect(result.receipt.updatedCompanionLocators).toEqual([
      { statementId: 'line_1', companionId: 'cmp_focus' },
    ]);
  });

  it('inserts semantic script segments and preserves tail duration in receipt timeRange', () => {
    let statementIndex = 0;
    let markerIndex = 0;
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
      markerIdGenerator: (prefix) => `${prefix}_${++markerIndex}`,
    });

    const result = service.author(makeDocument(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_ai_segment_v2',
      origin: 'ai-script-panel',
      kind: 'insert-script-segment',
      anchorTime: 3,
      statements: [
        {
          type: 'dialogue',
          params: {
            speakerId: 'tomori',
            text: '等一下。',
            durationSeconds: 1.6,
          },
        },
      ],
      markers: [
        { offset: 2.1, label: 'Pause beat', role: 'beat' },
      ],
      durationSeconds: 4.1,
    });

    expect(result.document.statements.map((statement) => [statement.id, statement.type, statement.time])).toEqual([
      ['dlg_1', 'dialogue', 3],
    ]);
    expect(result.document.meta.markers).toEqual([
      { markerId: 'marker_1', time: 5.1, label: 'Pause beat', role: 'beat' },
    ]);
    expect(result.document.meta.durationSeconds).toBe(7.1);
    expect(result.receipt).toEqual(expect.objectContaining({
      intentType: 'insert-script-segment',
      createdStatementIds: ['dlg_1'],
      createdMarkerIds: ['marker_1'],
      timeRange: { start: 3, end: 7.1 },
    }));
  });

  it('rounds the extended scene duration up so motion ends never exceed it', () => {
    const service = new SemanticTimelineAuthoringService();
    const document = makeDocument({
      meta: { title: 'Test', durationSeconds: 1.7, characters: [{ id: 'tomori', name: '灯' }] },
      statements: [
        {
          id: 'perf-1',
          time: 0.5,
          type: 'characterPerformance',
          params: { target: 'tomori', motion: makeCustomMotion(1.2) },
        },
      ],
    });

    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_extend_motion',
      origin: 'timeline-editor',
      kind: 'update-custom-motion-keyframes',
      locator: { statementId: 'perf-1' },
      motion: makeCustomMotion(1.234),
    });

    // 1.234s motion at 0.5s ends at 1.734s; the stored duration must round UP
    // (1.8), never down to 1.7 or the codec would reject the document.
    expect(result.document.meta.durationSeconds).toBe(1.8);
    expect(sceneDocumentCodec.parseAndValidate(result.document).meta.durationSeconds).toBe(1.8);
  });

  it('never writes a scene duration below the computed scene end when meta.durationSeconds is absent', () => {
    const service = new SemanticTimelineAuthoringService();
    const document = makeDocument({
      statements: [
        {
          id: 'line-1',
          time: 0,
          type: 'dialogue',
          params: { speakerId: 'tomori', text: 'Hi', durationSeconds: 3 },
        },
        {
          id: 'perf-1',
          time: 0.5,
          type: 'characterPerformance',
          params: { target: 'tomori', motion: makeCustomMotion(1.2) },
        },
      ],
    });

    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_extend_motion_2',
      origin: 'timeline-editor',
      kind: 'update-custom-motion-keyframes',
      locator: { statementId: 'perf-1' },
      motion: makeCustomMotion(2),
    });

    // The dialogue still ends at 3.0s, so the scene duration must not be
    // shrunk to the motion end (2.5s); keeping it implicit is safe.
    expect(result.document.meta.durationSeconds).toBeUndefined();
    expect(sceneDocumentCodec.parseAndValidate(result.document).statements[1].time).toBe(0.5);
  });

  it('accepts a resource-motion source (conversion) and extends the scene duration', () => {
    const service = new SemanticTimelineAuthoringService();
    const document = makeDocument({
      meta: { title: 'Test', durationSeconds: 4, characters: [{ id: 'tomori', name: '灯' }] },
      statements: [
        {
          id: 'perf-1',
          time: 3,
          type: 'characterPerformance',
          params: { target: 'tomori', motion: { kind: 'resource', key: 'wave' } },
        },
      ],
    });

    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_convert_motion',
      origin: 'timeline-editor',
      kind: 'update-custom-motion-keyframes',
      locator: { statementId: 'perf-1' },
      motion: makeCustomMotion(1.4, 'wave'),
    });

    // Converted motion ends at 3 + 1.4 = 4.4s, past meta.durationSeconds (4).
    expect(result.document.meta.durationSeconds).toBe(4.4);
    expect((result.document.statements[0].params as { motion: CharacterMotionOutput }).motion)
      .toMatchObject({ kind: 'custom', derivedFrom: { key: 'wave' } });
    expect(sceneDocumentCodec.parseAndValidate(result.document)).toBeDefined();
  });

  it('rejects conversion whose derivedFrom.key does not match the resource source', () => {
    const service = new SemanticTimelineAuthoringService();
    const document = makeDocument({
      meta: { title: 'Test', durationSeconds: 4, characters: [{ id: 'tomori', name: '灯' }] },
      statements: [
        {
          id: 'perf-1',
          time: 3,
          type: 'characterPerformance',
          params: { target: 'tomori', motion: { kind: 'resource', key: 'wave' } },
        },
      ],
    });

    expect(() => service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_convert_motion_other',
      origin: 'timeline-editor',
      kind: 'update-custom-motion-keyframes',
      locator: { statementId: 'perf-1' },
      motion: makeCustomMotion(1.4, 'OTHER'),
    })).toThrowError(/source motion key mismatch/);
  });
});

describe('SemanticTimelineAuthoringService insert-dialogue-in-chain', () => {
  const service = new SemanticTimelineAuthoringService({
    statementIdGenerator: (prefix) => `${prefix}_chain`,
  });

  const documentWithChain = (): CurrentSceneDocument => makeDocument({
    statements: [
      {
        id: 'dlg_a',
        time: 0,
        type: 'dialogue',
        params: { text: '你好。', durationSeconds: 1.5, style: 'typewriter' },
      },
      {
        id: 'dlg_b',
        time: 6,
        type: 'dialogue',
        params: { text: '继续。', durationSeconds: 2, style: 'typewriter' },
      },
    ],
  });

  it('inserts at the natural slot and cascades downstream when flow is on', () => {
    const result = service.author(documentWithChain(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'chain_1',
      origin: 'sequential-flow',
      kind: 'insert-dialogue-in-chain',
      text: '插入句。',
      beforeStatementId: 'dlg_b',
      flow: true,
    });

    const statements = result.document.statements;
    expect(statements.map((statement) => statement.id)).toEqual(['dlg_a', 'dlg_chain', 'dlg_b']);
    expect(statements[1].time).toBe(2);
    expect((statements[1].params as any).durationSeconds)
      .toBe(estimateDialogueDuration('插入句。', 'normal'));
    expect(statements[2].time)
      .toBe(6 + estimateDialogueDuration('插入句。', 'normal') + PACE_GAP.normal);
    expect(result.receipt).toEqual(expect.objectContaining({
      intentType: 'insert-dialogue-in-chain',
      createdStatementIds: ['dlg_chain'],
      updatedStatementIds: ['dlg_b'],
      historyDescriptor: expect.objectContaining({ key: 'timeline.author.insertDialogueInChain' }),
    }));
  });

  it('materializes the project image dialogue presentation on a chain insertion', () => {
    const presentation = {
      renderer: 'image-dialogue-v1' as const,
      styleId: 'cinematic.v1.1.0',
      textbox: { image: 'images/templates/cinematic/textbox.svg', x: 0, y: 780, width: 1920, height: 300 },
      namebox: { image: 'images/templates/cinematic/namebox.svg', x: 788, y: 621, width: 344, height: 84 },
      text: { x: 200, y: 850, maxWidth: 1520 },
    };
    const result = service.author(documentWithChain(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'chain_image_style',
      origin: 'sequential-flow',
      kind: 'insert-dialogue-in-chain',
      text: '',
      beforeStatementId: 'dlg_b',
      presentation,
    });

    expect(result.document.statements[1].params).toMatchObject({
      text: '',
      style: 'typewriter',
      presentation,
    });
  });

  it('inserts a dialogue at the beginning and cascades non-dialogue statements downstream', () => {
    const document = makeDocument({
      statements: [
        {
          id: 'dlg_a',
          time: 0,
          type: 'dialogue',
          params: { text: '已有开头。', durationSeconds: 1.5, style: 'typewriter' },
        },
        {
          id: 'cam_1',
          time: 3,
          type: 'camera',
          params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
        },
        {
          id: 'dlg_b',
          time: 6,
          type: 'dialogue',
          params: { text: '已有结尾。', durationSeconds: 2, style: 'typewriter' },
        },
      ],
    });
    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'chain-head-flow',
      origin: 'sequential-flow',
      kind: 'insert-dialogue-in-chain',
      text: '开头插入。',
      beforeStatementId: 'dlg_a',
      flow: true,
    });

    const insertedDuration = estimateDialogueDuration('开头插入。', 'normal');
    const insertedSpan = insertedDuration + PACE_GAP.normal;
    expect(result.document.statements.map((statement) => statement.type)).toEqual([
      'dialogue', 'dialogue', 'camera', 'dialogue',
    ]);
    expect(result.document.statements.map((statement) => statement.time)).toEqual([
      0, insertedSpan, 3 + insertedSpan, 6 + insertedSpan,
    ]);
    expect(result.receipt.createdStatementIds).toEqual(['dlg_chain']);
    expect(result.receipt.updatedStatementIds).toEqual(['dlg_a', 'cam_1', 'dlg_b']);
  });

  it('inserts a dialogue at the end after the final non-dialogue statement in auto mode', () => {
    const result = service.author(makeDocument({
      statements: [
        {
          id: 'dlg_a',
          time: 0,
          type: 'dialogue',
          params: { text: '对白。', durationSeconds: 1.5, style: 'typewriter' },
        },
        {
          id: 'cam_tail',
          time: 3,
          type: 'camera',
          params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
        },
      ],
    }), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'chain-tail-flow',
      origin: 'sequential-flow',
      kind: 'insert-dialogue-in-chain',
      text: '结尾插入。',
      flow: true,
    });

    expect(result.document.statements.map((statement) => statement.time)).toEqual([
      0, 3, 3.5,
    ]);
    expect(result.document.statements[2].type).toBe('dialogue');
    expect(result.receipt.updatedStatementIds).toEqual([]);
  });

  it('does not shift downstream when flow is off', () => {
    const result = service.author(documentWithChain(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'chain_2',
      origin: 'sequential-flow',
      kind: 'insert-dialogue-in-chain',
      text: '插入句。',
      beforeStatementId: 'dlg_b',
    });

    const statements = result.document.statements;
    expect(statements.map((statement) => statement.id)).toEqual(['dlg_a', 'dlg_chain', 'dlg_b']);
    expect(statements[1].time).toBe(2);
    expect(statements[2].time).toBe(6);
    expect(result.receipt.updatedStatementIds).toEqual([]);
  });

  it('appends at the chain end when no beforeStatementId is given', () => {
    const result = service.author(documentWithChain(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'chain_3',
      origin: 'sequential-flow',
      kind: 'insert-dialogue-in-chain',
      text: '末尾句。',
    });

    const statements = result.document.statements;
    expect(statements[2].id).toBe('dlg_chain');
    expect(statements[2].time).toBe(8.5);
    expect(result.receipt.updatedStatementIds).toEqual([]);
  });

  it('creates a blank dialogue for detail-first insertion', () => {
    const result = service.author(documentWithChain(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'chain_4',
      origin: 'sequential-flow',
      kind: 'insert-dialogue-in-chain',
      text: '   ',
      beforeStatementId: 'dlg_b',
    });

    expect(result.document.statements.map((statement) => statement.id)).toEqual(['dlg_a', 'dlg_chain', 'dlg_b']);
    expect(result.document.statements[1]).toMatchObject({
      time: 2,
      type: 'dialogue',
      params: {
        text: '',
        durationSeconds: estimateDialogueDuration('', 'normal'),
      },
    });
    expect(result.document.statements[2].time).toBe(6);
  });
});

describe('SemanticTimelineAuthoringService generic insertion positions', () => {
  it.each([
    { position: 'beginning', anchorTime: 0, expectedIds: ['created', 'dlg_a', 'dlg_b'] },
    { position: 'middle', anchorTime: 5, expectedIds: ['dlg_a', 'created', 'dlg_b'] },
    { position: 'end', anchorTime: 10, expectedIds: ['dlg_a', 'dlg_b', 'created'] },
  ])(
    'inserts a non-dialogue statement at the $position without reflowing existing statements',
    ({ anchorTime, expectedIds }) => {
      const document = makeDocument({
        statements: [
          {
            id: 'dlg_a',
            time: 2,
            type: 'dialogue',
            params: { text: '第一句。', durationSeconds: 1, style: 'typewriter' },
          },
          {
            id: 'dlg_b',
            time: 8,
            type: 'dialogue',
            params: { text: '第二句。', durationSeconds: 1, style: 'typewriter' },
          },
        ],
      });
      const result = new SemanticTimelineAuthoringService({
        statementIdGenerator: () => 'created',
      }).author(document, {
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: `generic-${anchorTime}`,
        origin: 'timeline-editor',
        kind: 'insert-statement',
        anchorTime,
        statement: {
          type: 'camera',
          params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
        },
      });

      expect(result.document.statements.map((statement) => statement.id)).toEqual(expectedIds);
      expect(result.document.statements.map((statement) => statement.time)).toEqual(
        expectedIds.map((id) => id === 'created' ? anchorTime : id === 'dlg_a' ? 2 : 8),
      );
      expect(result.document.statements.find((statement) => statement.id === 'created')?.type)
        .toBe('camera');
      expect(result.receipt.updatedStatementIds).toEqual([]);
    },
  );
});

describe('SemanticTimelineAuthoringService update-statement flow cascade', () => {
  const service = new SemanticTimelineAuthoringService({
    statementIdGenerator: (prefix) => `${prefix}_flow`,
  });

  const documentWithFlowChain = (): CurrentSceneDocument => makeDocument({
    statements: [
      {
        id: 'dlg_a',
        time: 0,
        type: 'dialogue',
        params: { text: '你好。', durationSeconds: 1.5, style: 'typewriter' },
      },
      {
        id: 'cam_1',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      {
        id: 'dlg_b',
        time: 6,
        type: 'dialogue',
        params: { text: '继续。', durationSeconds: 2, style: 'typewriter' },
      },
    ],
  });

  it('cascades the duration delta downstream when a dialogue text changes with flow on', () => {
    const document = documentWithFlowChain();
    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'flow_1',
      origin: 'timeline-editor',
      kind: 'update-statement',
      statementId: 'dlg_a',
      patch: { params: { text: '我想把这句话说清楚。', durationSeconds: 1.5, style: 'typewriter' } },
      flow: true,
    });

    const delta = estimateDialogueDuration('我想把这句话说清楚。', 'normal') - 1.5;
    const statements = result.document.statements;
    expect(statements[0].time).toBe(0);
    expect(statements[1].time).toBe(3 + delta);
    expect(statements[2].time).toBe(6 + delta);
    expect(result.receipt.updatedStatementIds).toEqual(['dlg_a', 'cam_1', 'dlg_b']);
  });

  it('does not cascade when the edited statement is not dialogue', () => {
    const result = service.author(documentWithFlowChain(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'flow_2',
      origin: 'timeline-editor',
      kind: 'update-statement',
      statementId: 'cam_1',
      patch: { params: { mode: 'focus', target: 'tomori', durationSeconds: 1 } },
      flow: true,
    });

    const statements = result.document.statements;
    expect(statements[0].time).toBe(0);
    expect(statements[1].time).toBe(3);
    expect(statements[2].time).toBe(6);
    expect(result.receipt.updatedStatementIds).toEqual(['cam_1']);
  });

  it('leaves downstream untouched without the flow flag', () => {
    const result = service.author(documentWithFlowChain(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'flow_3',
      origin: 'timeline-editor',
      kind: 'update-statement',
      statementId: 'dlg_a',
      patch: { params: { text: '我想把这句话说清楚。', durationSeconds: 1.5, style: 'typewriter' } },
    });

    const statements = result.document.statements;
    expect(statements[0].time).toBe(0);
    expect(statements[1].time).toBe(3);
    expect(statements[2].time).toBe(6);
    expect(result.receipt.updatedStatementIds).toEqual(['dlg_a']);
  });

  const positionedFlowDocument = (): CurrentSceneDocument => makeDocument({
    statements: [
      {
        id: 'dlg_a',
        time: 0,
        type: 'dialogue',
        params: { text: '开头。', durationSeconds: 1.5, style: 'typewriter' },
      },
      {
        id: 'cam_a',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      {
        id: 'dlg_b',
        time: 6,
        type: 'dialogue',
        params: { text: '中间。', durationSeconds: 2, style: 'typewriter' },
      },
      {
        id: 'cam_b',
        time: 9,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      {
        id: 'dlg_c',
        time: 12,
        type: 'dialogue',
        params: { text: '结尾。', durationSeconds: 1, style: 'typewriter' },
      },
    ],
  });

  it.each([
    {
      position: 'beginning',
      statementId: 'dlg_a',
      durationSeconds: 2.5,
      expectedTimes: [0, 4, 7, 10, 13],
      updatedIds: ['dlg_a', 'cam_a', 'dlg_b', 'cam_b', 'dlg_c'],
    },
    {
      position: 'middle',
      statementId: 'dlg_b',
      durationSeconds: 3,
      expectedTimes: [0, 3, 6, 10, 13],
      updatedIds: ['dlg_b', 'cam_b', 'dlg_c'],
    },
    {
      position: 'end',
      statementId: 'dlg_c',
      durationSeconds: 2,
      expectedTimes: [0, 3, 6, 9, 12],
      updatedIds: ['dlg_c'],
    },
  ])(
    'cascades a dialogue duration change at the $position of the script',
    ({ statementId, durationSeconds, expectedTimes, updatedIds }) => {
      const document = positionedFlowDocument();
      const source = document.statements.find((statement) => statement.id === statementId);
      if (!source || source.type !== 'dialogue') throw new Error(`Missing dialogue ${statementId}`);

      const result = service.author(document, {
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: `flow-duration-${statementId}`,
        origin: 'timeline-editor',
        kind: 'update-statement',
        statementId,
        patch: {
          params: { ...source.params, durationSeconds },
        },
        flow: true,
      });

      expect(result.document.statements.map((statement) => statement.time)).toEqual(expectedTimes);
      expect(result.document.statements.find((statement) => statement.id === statementId)?.params)
        .toEqual(expect.objectContaining({ durationSeconds }));
      expect(result.receipt.updatedStatementIds).toEqual(updatedIds);
    },
  );

  it('cascades downstream statements backward when a middle dialogue duration shortens', () => {
    const document = positionedFlowDocument();
    const source = document.statements.find((statement) => statement.id === 'dlg_b');
    if (!source || source.type !== 'dialogue') throw new Error('Missing middle dialogue');

    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'flow-duration-shorten-middle',
      origin: 'timeline-editor',
      kind: 'update-statement',
      statementId: 'dlg_b',
      patch: {
        params: { ...source.params, durationSeconds: 1 },
      },
      flow: true,
    });

    expect(result.document.statements.map((statement) => statement.time)).toEqual([0, 3, 6, 8, 11]);
    expect(result.receipt.updatedStatementIds).toEqual(['dlg_b', 'cam_b', 'dlg_c']);
  });

  it.each([
    {
      position: 'beginning',
      statementId: 'dlg_a',
      time: 1,
      expectedTimes: [1, 4, 7, 10, 13],
      updatedIds: ['dlg_a', 'cam_a', 'dlg_b', 'cam_b', 'dlg_c'],
    },
    {
      position: 'middle',
      statementId: 'dlg_b',
      time: 4,
      expectedTimes: [0, 3, 4, 7, 10],
      updatedIds: ['dlg_b', 'cam_b', 'dlg_c'],
    },
    {
      position: 'end',
      statementId: 'dlg_c',
      time: 10,
      expectedTimes: [0, 3, 6, 9, 10],
      updatedIds: ['dlg_c'],
    },
  ])(
    'cascades a dialogue time move at the $position of the script',
    ({ statementId, time, expectedTimes, updatedIds }) => {
      const result = service.author(positionedFlowDocument(), {
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: `flow-time-${statementId}`,
        origin: 'timeline-editor',
        kind: 'update-statement',
        statementId,
        patch: { time },
        flow: true,
      });

      expect(result.document.statements.map((statement) => statement.time)).toEqual(expectedTimes);
      expect(result.receipt.updatedStatementIds).toEqual(updatedIds);
    },
  );

  it('shrinks a previously materialized scene duration when flow shortens the trailing dialogue', () => {
    const document = positionedFlowDocument();
    const withDuration = {
      ...document,
      meta: { ...document.meta, durationSeconds: 13 },
    };
    const result = service.author(withDuration, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'flow-duration-shrink',
      origin: 'timeline-editor',
      kind: 'update-statement',
      statementId: 'dlg_c',
      patch: {
        params: {
          ...(withDuration.statements.find((statement) => statement.id === 'dlg_c')!.params as any),
          durationSeconds: 0.5,
        },
      },
      flow: true,
    });

    expect(result.document.meta.durationSeconds).toBe(12.5);
    expect(result.document.statements.map((statement) => statement.time)).toEqual([0, 3, 6, 9, 12]);
  });

  it.each([
    { position: 'beginning', statementId: 'cam_a', time: 1 },
    { position: 'middle', statementId: 'cam_b', time: 7 },
    { position: 'end', statementId: 'cam_c', time: 8 },
  ])(
    'does not cascade a non-dialogue time move at the $position of the script',
    ({ statementId, time }) => {
      const document = makeDocument({
        statements: [
          {
            id: 'cam_a',
            time: 0,
            type: 'camera',
            params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
          },
          {
            id: 'dlg_a',
            time: 2,
            type: 'dialogue',
            params: { text: '对白。', durationSeconds: 1, style: 'typewriter' },
          },
          {
            id: 'cam_b',
            time: 5,
            type: 'camera',
            params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
          },
          {
            id: 'dlg_b',
            time: 7,
            type: 'dialogue',
            params: { text: '对白二。', durationSeconds: 1, style: 'typewriter' },
          },
          {
            id: 'cam_c',
            time: 10,
            type: 'camera',
            params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
          },
        ],
      });
      const result = service.author(document, {
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: `flow-nondialogue-${statementId}`,
        origin: 'timeline-editor',
        kind: 'update-statement',
        statementId,
        patch: { time },
        flow: true,
      });

      expect(result.document.statements.map((statement) => [statement.id, statement.time])).toEqual([
        ['cam_a', statementId === 'cam_a' ? 1 : 0],
        ['dlg_a', 2],
        ['cam_b', statementId === 'cam_b' ? 7 : 5],
        ['dlg_b', 7],
        ['cam_c', statementId === 'cam_c' ? 8 : 10],
      ]);
      expect(result.receipt.updatedStatementIds).toEqual([statementId]);
    },
  );

  it.each([
    { position: 'beginning', statementId: 'cam_a' },
    { position: 'middle', statementId: 'cam_b' },
    { position: 'end', statementId: 'cam_c' },
  ])(
    'does not cascade a non-dialogue duration change at the $position of the script',
    ({ statementId }) => {
      const document = makeDocument({
        statements: [
          {
            id: 'cam_a',
            time: 0,
            type: 'camera',
            params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
          },
          {
            id: 'dlg_a',
            time: 2,
            type: 'dialogue',
            params: { text: '对白。', durationSeconds: 1, style: 'typewriter' },
          },
          {
            id: 'cam_b',
            time: 5,
            type: 'camera',
            params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
          },
          {
            id: 'dlg_b',
            time: 7,
            type: 'dialogue',
            params: { text: '对白二。', durationSeconds: 1, style: 'typewriter' },
          },
          {
            id: 'cam_c',
            time: 10,
            type: 'camera',
            params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
          },
        ],
      });
      const result = service.author(document, {
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: `flow-nondialogue-duration-${statementId}`,
        origin: 'timeline-editor',
        kind: 'update-statement',
        statementId,
        patch: {
          params: { mode: 'focus', target: 'tomori', durationSeconds: 1.5 },
        },
        flow: true,
      });

      expect(result.document.statements.map((statement) => [statement.id, statement.time])).toEqual([
        ['cam_a', 0],
        ['dlg_a', 2],
        ['cam_b', 5],
        ['dlg_b', 7],
        ['cam_c', 10],
      ]);
      expect(result.document.statements.find((statement) => statement.id === statementId)?.params)
        .toEqual(expect.objectContaining({ durationSeconds: 1.5 }));
      expect(result.receipt.updatedStatementIds).toEqual([statementId]);
    },
  );
});

describe('SemanticTimelineAuthoringService reorder-dialogue-chain flow', () => {
  const service = new SemanticTimelineAuthoringService({
    statementIdGenerator: (prefix) => `${prefix}_reorder`,
  });

  const documentToReorder = (): CurrentSceneDocument => makeDocument({
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: { text: '你好。', durationSeconds: 1.5, style: 'typewriter' },
      },
      {
        id: 'cam_1',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      {
        id: 'dlg_2',
        time: 6,
        type: 'dialogue',
        params: { text: '第二句。', durationSeconds: 2, style: 'typewriter' },
      },
      {
        id: 'dlg_3',
        time: 11,
        type: 'dialogue',
        params: { text: '第三句。', durationSeconds: 1, style: 'typewriter' },
      },
    ],
  });

  it('cascades the two-slot deltas across all downstream statements with flow on', () => {
    const result = service.author(documentToReorder(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'reorder_1',
      origin: 'sequential-flow',
      kind: 'reorder-dialogue-chain',
      orderedDialogueIds: ['dlg_3', 'dlg_1', 'dlg_2'],
      movedStatementId: 'dlg_3',
      flow: true,
    });

    const statements = result.document.statements;
    expect(statements.map((statement) => statement.id)).toEqual([
      'dlg_3', 'dlg_1', 'cam_1', 'dlg_2',
    ]);
    expect(getSceneDocumentCanonicalOrder(result.document)).toEqual([
      'dlg_3', 'dlg_1', 'cam_1', 'dlg_2',
    ]);
    expect(statements.map((statement) => statement.time)).toEqual([0, 1.5, 4.5, 7.5]);
    expect(result.receipt.updatedStatementIds).toEqual(['dlg_3', 'dlg_1', 'cam_1', 'dlg_2']);
  });

  it('moves only the dragged dialogue to the neighbour midpoint without flow', () => {
    const result = service.author(documentToReorder(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'reorder_2',
      origin: 'sequential-flow',
      kind: 'reorder-dialogue-chain',
      orderedDialogueIds: ['dlg_1', 'dlg_3', 'dlg_2'],
      movedStatementId: 'dlg_3',
    });

    const statements = result.document.statements;
    expect(statements.map((statement) => statement.id)).toEqual([
      'dlg_1', 'dlg_3', 'cam_1', 'dlg_2',
    ]);
    expect(getSceneDocumentCanonicalOrder(result.document)).toEqual([
      'dlg_1', 'dlg_3', 'cam_1', 'dlg_2',
    ]);
    expect(statements[1].time).toBe((2 + 3) / 2);
    expect(statements[0].time).toBe(0);
    expect(statements[2].time).toBe(3);
    expect(statements[3].time).toBe(6);
    expect(result.receipt.updatedStatementIds).toEqual(['dlg_3']);
  });

  it('requires movedStatementId when flow is on', () => {
    expect(() => service.author(documentToReorder(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'reorder_3',
      origin: 'sequential-flow',
      kind: 'reorder-dialogue-chain',
      orderedDialogueIds: ['dlg_3', 'dlg_1', 'dlg_2'],
      flow: true,
    })).toThrow(/movedStatementId/);
  });

  it.each([
    { movedStatementId: 'dlg_2', beforeStatementId: 'cam_1', ids: ['dlg_1', 'dlg_2', 'cam_1', 'dlg_3'], times: [0, 2, 5.5, 11] },
    { movedStatementId: 'dlg_1', beforeStatementId: 'dlg_2', ids: ['cam_1', 'dlg_1', 'dlg_2', 'dlg_3'], times: [1, 1.5, 6, 11] },
  ])('honours an exact root anchor $beforeStatementId even when dialogue order is unchanged', ({ movedStatementId, beforeStatementId, ids, times }) => {
    const result = service.author(documentToReorder(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'reorder_root_anchor',
      origin: 'sequential-flow',
      kind: 'reorder-dialogue-chain',
      orderedDialogueIds: ['dlg_1', 'dlg_2', 'dlg_3'],
      movedStatementId,
      flow: true,
      beforeStatementId,
    });

    expect(result.document.statements.map((statement) => statement.id)).toEqual(ids);
    expect(result.document.statements.map((statement) => statement.time)).toEqual(times);
    expect(getSceneDocumentCanonicalOrder(result.document)).toEqual(ids);
  });

  it.each([
    { name: 'before a simultaneous camera', cameraTime: 0, dialogueTime: 0, cameraFirst: true, beforeStatementId: 'camera', ids: ['dialogue', 'camera'], times: [0, 1.5] },
    { name: 'after a simultaneous camera', cameraTime: 0, dialogueTime: 0, cameraFirst: false, beforeStatementId: null, ids: ['camera', 'dialogue'], times: [0, 0.5] },
    { name: 'after a camera inside the old dialogue slot', cameraTime: 0.2, dialogueTime: 0, cameraFirst: false, beforeStatementId: null, ids: ['camera', 'dialogue'], times: [0, 0.5] },
  ])('keeps root and compiled timing valid $name', ({ cameraTime, dialogueTime, cameraFirst, beforeStatementId, ids, times }) => {
    const camera = {
      id: 'camera', time: cameraTime, type: 'camera' as const,
      params: { mode: 'focus' as const, position: [0, 0] as [number, number], durationSeconds: 0.5 },
    };
    const dialogue = {
      id: 'dialogue', time: dialogueTime, type: 'dialogue' as const,
      params: { text: 'Line', durationSeconds: 1 },
      companions: [{
        id: 'companion', anchor: 'end' as const, offset: 0.2, type: 'camera' as const,
        params: { mode: 'focus' as const, position: [1, 1] as [number, number], durationSeconds: 0.5 },
      }],
    };
    const document = makeDocument({ statements: cameraFirst ? [camera, dialogue] : [dialogue, camera] });
    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION, correlationId: 'reorder_overlap', origin: 'sequential-flow',
      kind: 'reorder-dialogue-chain', orderedDialogueIds: ['dialogue'], movedStatementId: 'dialogue',
      beforeStatementId, flow: true,
    });

    expect(result.document.statements.map((statement) => statement.id)).toEqual(ids);
    expect(result.document.statements.map((statement) => statement.time)).toEqual(times);
    expect(getSceneDocumentCanonicalOrder(result.document)).toEqual(ids);
    const moved = result.document.statements.find((statement) => statement.id === 'dialogue')!;
    expect(moved.companions).toEqual(dialogue.companions);
    const compiled = sceneStatementCompiler.compile(result.document);
    expect(compiled.actions.filter((action) => !action.source.companionId).map((action) => action.source.statementId)).toEqual(ids);
    expect(compiled.actions.find((action) => action.source.companionId === 'companion')?.time).toBeCloseTo(moved.time + 1.2);
    expect(result.document.meta.durationSeconds).toBeCloseTo(Math.max(cameraFirst ? 2 : 0.5, moved.time + 1.7));
  });

  it('opens enough room at a root anchor inside an overlapping preceding dialogue', () => {
    const document = makeDocument({ statements: [
      { id: 'previous', time: 0, type: 'dialogue', params: { text: 'Long line', durationSeconds: 5 } },
      { id: 'camera', time: 1, type: 'camera', params: { mode: 'focus', position: [0, 0], durationSeconds: 0.5 } },
      { id: 'moved', time: 3, type: 'dialogue', params: { text: 'Moved line', durationSeconds: 1 } },
    ] });
    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION, correlationId: 'reorder_overlap_anchor', origin: 'sequential-flow',
      kind: 'reorder-dialogue-chain', orderedDialogueIds: ['previous', 'moved'], movedStatementId: 'moved',
      beforeStatementId: 'camera', flow: true,
    });
    expect(result.document.statements.map((statement) => [statement.id, statement.time])).toEqual([
      ['previous', 0], ['moved', 5.5], ['camera', 7],
    ]);
    expect(sceneStatementCompiler.compile(result.document).actions.map((action) => action.source.statementId))
      .toEqual(['previous', 'moved', 'camera']);
  });

  it.each(['dlg_3', 'missing', 'dlg_2'])(
    'does not change timing for an unchanged or invalid root anchor %s', (beforeStatementId) => {
      const document = documentToReorder();
      const result = service.author(document, {
        version: AUTHORING_SCHEMA_VERSION, correlationId: 'reorder_no_change', origin: 'sequential-flow',
        kind: 'reorder-dialogue-chain', orderedDialogueIds: ['dlg_1', 'dlg_2', 'dlg_3'], movedStatementId: 'dlg_2',
        beforeStatementId, flow: true,
      });
      expect(result.document).toBe(document);
      expect(result.receipt.updatedStatementIds).toEqual([]);
    },
  );
});

describe('SemanticTimelineAuthoringService delete-statements flow', () => {
  const service = new SemanticTimelineAuthoringService({
    statementIdGenerator: (prefix) => `${prefix}_delete`,
  });

  const documentToDeleteFrom = (): CurrentSceneDocument => makeDocument({
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: { text: '你好。', durationSeconds: 1.5, style: 'typewriter' },
      },
      {
        id: 'cam_1',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      {
        id: 'dlg_2',
        time: 6,
        type: 'dialogue',
        params: { text: '第二句。', durationSeconds: 2, style: 'typewriter' },
      },
    ],
  });

  it('shifts downstream statements back when deleting a dialogue with flow on', () => {
    const result = service.author(documentToDeleteFrom(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'delete_1',
      origin: 'timeline-editor',
      kind: 'delete-statements',
      statementIds: ['dlg_1'],
      flow: true,
    });

    const statements = result.document.statements;
    expect(statements.map((statement) => statement.id)).toEqual(['cam_1', 'dlg_2']);
    expect(statements.map((statement) => statement.time)).toEqual([1, 4]);
    expect(result.receipt.deletedStatementIds).toEqual(['dlg_1']);
  });

  it('does not cascade when deleting a non-dialogue statement with flow on', () => {
    const result = service.author(documentToDeleteFrom(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'delete_2',
      origin: 'timeline-editor',
      kind: 'delete-statements',
      statementIds: ['cam_1'],
      flow: true,
    });

    const statements = result.document.statements;
    expect(statements.map((statement) => statement.id)).toEqual(['dlg_1', 'dlg_2']);
    expect(statements.map((statement) => statement.time)).toEqual([0, 6]);
  });

  it('leaves downstream untouched without the flow flag', () => {
    const result = service.author(documentToDeleteFrom(), {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'delete_3',
      origin: 'timeline-editor',
      kind: 'delete-statements',
      statementIds: ['dlg_1'],
    });

    const statements = result.document.statements;
    expect(statements.map((statement) => statement.id)).toEqual(['cam_1', 'dlg_2']);
    expect(statements.map((statement) => statement.time)).toEqual([3, 6]);
  });
});

describe('ADR-0022 placeholder expression fill through the authoring seam', () => {
  it('persists a new expression field on an empty-motion placeholder companion', () => {
    const document = makeDocument({
      statements: [
        {
          id: 'line_1',
          time: 0,
          type: 'dialogue',
          params: {
            speakerId: 'tomori',
            speaker: '灯',
            text: '你好。',
            durationSeconds: 2,
          },
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
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_1`,
    });

    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'fill_placeholder_expression',
      origin: 'timeline-editor',
      kind: 'update-dialogue-companion',
      locator: { statementId: 'line_1', companionId: 'cmp_placeholder' },
      patch: {
        params: {
          target: '$speaker',
          motion: '',
          expression: 'smile',
        },
      },
    });

    const companion = result.document.statements
      .find((statement) => statement.id === 'line_1')
      ?.companions?.[0];
    expect(companion).toMatchObject({
      type: 'characterPerformance',
      params: { target: '$speaker', motion: '', expression: 'smile' },
    });
    // The filled expression compiles to a runtime setExpression output and the
    // placeholder stays resolvable to its parent speaker.
    const compiled = sceneStatementCompiler.compile(result.document);
    expect(compiled.actions.some((action) => (
      action.action === 'setExpression'
      && action.params.id === 'tomori'
      && action.params.expression === 'smile'
    ))).toBe(true);
    sceneDocumentCodec.parseAndValidate(result.document);
  });
});

describe('automatic dialogue flow through semantic intents', () => {
  let generated = 0;
  const service = new SemanticTimelineAuthoringService({
    statementIdGenerator: (prefix) => `${prefix}_auto_${++generated}`,
  });
  const base = (): CurrentSceneDocument => makeDocument({
    meta: { title: 'Test', durationSeconds: 15, characters: [{ id: 'tomori', name: '灯' }] },
    statements: [
      {
        id: 'first', time: 0, type: 'dialogue',
        params: { text: 'First', durationSeconds: 1 },
        companions: [{ id: 'companion', anchor: 'start', offset: 0.5, type: 'camera', params: { mode: 'focus', target: 'tomori' } }],
      },
      { id: 'camera', time: 3, type: 'camera', params: { mode: 'focus', target: 'tomori' } },
      { id: 'last', time: 7, type: 'dialogue', params: { text: 'Last', durationSeconds: 1 } },
    ],
  });

  it('preserves pasted dialogue offsets and shifts downstream statements by fragment span', () => {
    const intent = {
      version: AUTHORING_SCHEMA_VERSION, correlationId: 'paste-auto', origin: 'timeline-editor' as const,
      kind: 'insert-script-segment' as const, anchorTime: 2,
      statements: [
        { type: 'dialogue' as const, time: 0, params: { text: 'A', durationSeconds: 1 } },
        { type: 'dialogue' as const, time: 2, params: { text: 'B', durationSeconds: 1 } },
      ],
    };
    const result = service.author(base(), intent, 'auto');
    const created = result.receipt.createdStatementIds.map((id) => result.document.statements.find((item) => item.id === id)!);
    expect(created.map((item) => item.time)).toEqual([2, 4]);
    expect(result.document.statements.find((item) => item.id === 'camera')?.time).toBe(6.5);
    expect(result.document.statements.find((item) => item.id === 'last')?.time).toBe(10.5);
    expect(result.receipt.updatedStatementIds).toEqual(['camera', 'last']);
    const manual = service.author(base(), intent);
    expect(manual.document.statements.find((item) => item.id === 'camera')?.time).toBe(3);
    expect(manual.document.statements.find((item) => item.id === 'last')?.time).toBe(7);
  });

  it('copies a multi-dialogue selection as one fragment', () => {
    const result = service.author(base(), {
      version: AUTHORING_SCHEMA_VERSION, correlationId: 'copy-auto', origin: 'timeline-editor',
      kind: 'duplicate-statements', statementIds: ['first', 'last'],
    }, 'auto');
    const created = result.receipt.createdStatementIds.map((id) => result.document.statements.find((item) => item.id === id)!);
    expect(created.map((item) => item.time)).toEqual([1, 8]);
    expect(result.document.statements.find((item) => item.id === 'last')?.time).toBe(15.5);
    expect(result.document.statements.find((item) => item.id === 'camera')?.time).toBe(11.5);
  });

  it('moves every downstream statement by the dialogue delta across consecutive moves', () => {
    const firstMove = service.author(base(), {
      version: AUTHORING_SCHEMA_VERSION, correlationId: 'move-later-once', origin: 'timeline-editor',
      kind: 'move-timeline-locators', moves: [
        { locator: { kind: 'statement', statementId: 'first' }, time: 6 },
      ],
    }, 'auto');
    expect(firstMove.document.statements.map((item) => [item.id, item.time])).toEqual([
      ['first', 6], ['camera', 9], ['last', 13],
    ]);

    const secondMove = service.author(firstMove.document, {
      version: AUTHORING_SCHEMA_VERSION, correlationId: 'move-later-twice', origin: 'timeline-editor',
      kind: 'move-timeline-locators', moves: [
        { locator: { kind: 'statement', statementId: 'first' }, time: 8 },
      ],
    }, 'auto');
    expect(secondMove.document.statements.map((item) => [item.id, item.time])).toEqual([
      ['first', 8], ['camera', 11], ['last', 15],
    ]);
  });

  it('moves selected dialogue roots together and leaves companion-only moves independent', () => {
    const document = base();
    document.statements = [
      document.statements[0],
      { ...document.statements[2], time: 3 },
      { ...document.statements[1], time: 8 },
    ];
    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION, correlationId: 'move-auto', origin: 'timeline-editor',
      kind: 'move-timeline-locators', moves: [
        { locator: { kind: 'statement', statementId: 'first' }, time: 6 },
        { locator: { kind: 'statement', statementId: 'last' }, time: 9 },
      ],
    }, 'auto');
    expect(result.document.statements.map((item) => [item.id, item.time])).toEqual([
      ['first', 6], ['last', 9], ['camera', 14],
    ]);
    expect(result.document.statements.find((item) => item.id === 'first')?.companions?.[0].offset).toBe(0.5);

    const companion = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION, correlationId: 'move-companion', origin: 'timeline-editor',
      kind: 'move-timeline-locators', moves: [
        { locator: { kind: 'companion', statementId: 'first', companionId: 'companion' }, time: 2 },
      ],
    }, 'auto');
    expect(companion.document.statements.find((item) => item.id === 'last')?.time).toBe(3);
    expect(companion.document.statements.find((item) => item.id === 'first')?.companions?.[0].offset).toBe(2);
  });
});

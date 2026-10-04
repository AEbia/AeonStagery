import { describe, expect, it } from 'vitest';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import type { AiScriptSegmentPlan } from '../api/types/ai-authoring';
import {
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import {
  compileAiScriptSegmentPlanToSceneStatements,
} from '../services/ai-authoring/AiScriptSegmentCompiler';
import {
  applyAiScriptSegmentToCurrentSceneDocument,
  authorAiScriptSegmentIntoCurrentSceneDocument,
} from '../services/ai-authoring/AiScriptSegmentDocument';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_v2',
    meta: {
      title: 'Test',
      characters: [
        { id: 'tomori', name: '灯' },
        { id: 'anon', name: '爱音' },
      ],
    },
    statements: [],
  };
}

function makePlan(overrides: Partial<AiScriptSegmentPlan> = {}): AiScriptSegmentPlan {
  return {
    version: 1,
    title: '练习室',
    summary: '灯和爱音试着开口。',
    unresolvedNames: [],
    notes: [],
    steps: [
      { kind: 'enter', characterId: 'tomori', text: null, pace: 'normal', position: 'center', label: null, markerRole: null },
      { kind: 'dialogue', characterId: 'tomori', text: '我想把这句话说清楚。', pace: 'slow', position: null, label: null, markerRole: null },
      { kind: 'pause', characterId: null, text: null, pace: 'hold', position: null, label: null, markerRole: null },
      { kind: 'marker', characterId: null, text: null, pace: null, position: null, label: '沉默后的决定', markerRole: 'beat' },
      { kind: 'exit', characterId: 'tomori', text: null, pace: 'normal', position: null, label: null, markerRole: null },
    ],
    ...overrides,
  };
}

describe('AiScriptSegmentCompiler', () => {
  it('compiles high-level script steps into semantic statement drafts without wait actions', () => {
    const result = compileAiScriptSegmentPlanToSceneStatements(makePlan(), makeDocument());

    expect(result.issues).toEqual([]);
    expect(result.statements.map((statement) => statement.type)).toEqual([
      'characterPresence',
      'dialogue',
      'characterPresence',
    ]);
    expect(result.statements[0]).toMatchObject({
      time: 0,
      params: {
        mode: 'enter',
        id: 'tomori',
        position: [0.5, 1],
        transition: 'fadeIn',
        durationSeconds: 0.8,
      },
    });
    expect(result.statements[1]).toMatchObject({
      type: 'dialogue',
      params: {
        speakerId: 'tomori',
        text: '我想把这句话说清楚。',
        style: 'typewriter',
      },
    });
    expect(result.statements[2]).toMatchObject({
      type: 'characterPresence',
      params: {
        mode: 'exit',
        id: 'tomori',
        transition: 'fadeOut',
        durationSeconds: 0.6,
      },
    });
    expect(result.markers).toEqual([
      expect.objectContaining({
        label: '沉默后的决定',
        role: 'beat',
      }),
    ]);
    expect(result.durationSeconds).toBe(result.timeRange?.end);
  });

  it('uses tail pauses as explicit semantic segment duration instead of wait drafts', () => {
    const result = compileAiScriptSegmentPlanToSceneStatements(makePlan({
      steps: [
        { kind: 'dialogue', characterId: 'tomori', text: '等一下。', pace: 'normal', position: null, label: null, markerRole: null },
        { kind: 'pause', characterId: null, text: null, pace: 'hold', position: null, label: null, markerRole: null },
      ],
    }), makeDocument());

    expect(result.issues).toEqual([]);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0].type).toBe('dialogue');
    expect(result.durationSeconds).toBeGreaterThan(
      (result.statements[0].time ?? 0) + Number((result.statements[0].params as any).durationSeconds),
    );
  });

  it('keeps semantic compilation on the same character and asset safety rails', () => {
    const result = compileAiScriptSegmentPlanToSceneStatements(makePlan({
      unresolvedNames: ['新同学'],
      steps: [
        { kind: 'dialogue', characterId: 'sakiko', text: '请加载 figure/tomori/model.json', pace: 'normal', position: null, label: null, markerRole: null },
      ],
    }), makeDocument());

    expect(result.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message)).toEqual([
      '文本中存在未匹配到现有角色的名字: 新同学',
      expect.stringContaining('疑似素材或文件路径'),
      '步骤 1 引用了未在 meta.characters 中声明的角色 ID "sakiko"。',
    ]);
  });

  it('applies semantic AI statement drafts into a codec-valid CurrentSceneDocument', () => {
    const compiled = compileAiScriptSegmentPlanToSceneStatements(makePlan(), makeDocument());
    let statementIndex = 0;
    let markerIndex = 0;

    const result = applyAiScriptSegmentToCurrentSceneDocument(
      makeDocument(),
      compiled,
      10,
      {
        statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
        markerIdGenerator: (prefix) => `${prefix}_${++markerIndex}`,
      },
    );

    expect(result.createdStatementIds).toEqual([
      'char_presence_1',
      'dlg_2',
      'char_presence_3',
    ]);
    expect(result.createdMarkerIds).toEqual(['marker_1']);
    expect(result.document.statements.map((statement) => [statement.id, statement.type, statement.time])).toEqual([
      ['char_presence_1', 'characterPresence', 10],
      ['dlg_2', 'dialogue', 10.4],
      ['char_presence_3', 'characterPresence', 16],
    ]);
    expect(result.document.meta.markers).toEqual([
      {
        markerId: 'marker_1',
        time: 16,
        label: '沉默后的决定',
        role: 'beat',
      },
    ]);
    expect(result.document.meta.durationSeconds).toBe(16.6);
    expect(result.timeRange).toEqual({ start: 10, end: 16.6 });
  });

  it('writes tail pause extent to CurrentSceneDocument duration without inserting wait statements', () => {
    const compiled = compileAiScriptSegmentPlanToSceneStatements(makePlan({
      steps: [
        { kind: 'dialogue', characterId: 'tomori', text: '等一下。', pace: 'normal', position: null, label: null, markerRole: null },
        { kind: 'pause', characterId: null, text: null, pace: 'hold', position: null, label: null, markerRole: null },
      ],
    }), makeDocument());
    let statementIndex = 0;

    const result = applyAiScriptSegmentToCurrentSceneDocument(
      makeDocument(),
      compiled,
      3,
      { statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}` },
    );

    expect(result.document.statements.map((statement) => statement.type)).toEqual(['dialogue']);
    expect(result.document.meta.durationSeconds).toBe(result.timeRange?.end);
    expect(result.document.meta.durationSeconds).toBeGreaterThan(
      result.document.statements[0].time + Number((result.document.statements[0].params as any).durationSeconds),
    );
  });

  it('authors a semantic AI segment with a v2 statement receipt', () => {
    const compiled = compileAiScriptSegmentPlanToSceneStatements(makePlan(), makeDocument());
    let statementIndex = 0;
    let markerIndex = 0;

    const result = authorAiScriptSegmentIntoCurrentSceneDocument(
      makeDocument(),
      compiled,
      10,
      'intent_ai_v2',
      {
        statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
        markerIdGenerator: (prefix) => `${prefix}_${++markerIndex}`,
        scope: { kind: 'character', charId: 'tomori' },
      },
    );

    expect(result.receipt).toEqual(expect.objectContaining({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_ai_v2',
      intentType: 'insert-script-segment',
      origin: 'ai-script-panel',
      historyDescriptor: {
        key: 'timeline.author.insertScriptSegment',
        args: { count: 4 },
        fallbackLabel: 'AI 铺戏',
      },
      resolvedScope: { kind: 'character', charId: 'tomori' },
      createdStatementIds: ['char_presence_1', 'dlg_2', 'char_presence_3'],
      createdMarkerIds: ['marker_1'],
      timeRange: { start: 10, end: 16.6 },
    }));
    expect(result.receipt).not.toHaveProperty('createdActionIds');
    expect(result.document.meta.durationSeconds).toBe(16.6);
  });

  it('rejects semantic AI authoring before document mutation when compilation has errors', () => {
    const document = makeDocument();
    const compiled = compileAiScriptSegmentPlanToSceneStatements(makePlan({
      steps: [
        { kind: 'dialogue', characterId: 'sakiko', text: '我也在。', pace: 'normal', position: null, label: null, markerRole: null },
      ],
    }), document);

    expect(() => authorAiScriptSegmentIntoCurrentSceneDocument(
      document,
      compiled,
      0,
      'intent_invalid_ai_v2',
    )).toThrow('Cannot apply AI script segment with compile errors');
    expect(document.statements).toEqual([]);
    expect(document.meta.markers).toBeUndefined();
  });
});

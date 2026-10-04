import { describe, expect, it } from 'vitest';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import {
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import { sceneDocumentCodec } from '../services/semantic-scene';
import { PACE_GAP, estimateDialogueDuration } from '../services/pacing/pacing';
import { SemanticTimelineAuthoringService } from '../services/timeline-authoring/SemanticTimelineAuthoringService';
import {
  buildUpdateScenePaceTierIntent,
  compileSequentialDialogueDrafts,
} from '../services/sequential-flow/SequentialFlowAuthoring';

function makeDocument(overrides: Partial<CurrentSceneDocument> = {}): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_pace_1',
    meta: {
      title: 'Test',
      characters: [{ id: 'tomori', name: '灯' }],
    },
    statements: [],
    ...overrides,
  };
}

function dialogue(id: string, time: number, text: string, durationSeconds: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    time,
    type: 'dialogue' as const,
    params: { text, durationSeconds, style: 'typewriter' },
    ...overrides,
  };
}

describe('SequentialDialogueCompiler scene tiers', () => {
  it('scales auto durations by the tier: snap < normal < slow', () => {
    const text = '我想把这句话说清楚。';
    const durations = (['snap', 'normal', 'slow'] as const).map((tier) => {
      const result = compileSequentialDialogueDrafts([text], tier);
      return (result.statements[0].params as any).durationSeconds;
    });
    expect(durations[0]).toBe(estimateDialogueDuration(text, 'snap'));
    expect(durations[1]).toBe(estimateDialogueDuration(text, 'normal'));
    expect(durations[2]).toBe(estimateDialogueDuration(text, 'slow'));
    expect(durations[0]).toBeLessThan(durations[1]);
    expect(durations[1]).toBeLessThan(durations[2]);
  });

  it('paces gaps with the requested scene tier', () => {
    const result = compileSequentialDialogueDrafts(['你好。', '今天也要一起前进。'], 'slow');
    const first = result.statements[0];
    const second = result.statements[1];
    expect((second.time ?? 0) - ((first.time ?? 0) + (first.params as any).durationSeconds))
      .toBeCloseTo(PACE_GAP.slow, 6);
  });
});

describe('SceneDocumentCodec pace tier round trip', () => {
  it('preserves meta.paceTier across parse and save', () => {
    const document = makeDocument({
      meta: { title: 'Test', paceTier: 'slow' },
      statements: [
        dialogue('dlg_1', 1, '已有。', 2),
        dialogue('dlg_2', 4, '未锁。', 2),
      ],
    });
    const parsed = sceneDocumentCodec.parseAndValidate(document);
    expect(parsed.meta.paceTier).toBe('slow');

    const saved = sceneDocumentCodec.prepareForSave(parsed);
    expect(saved.meta.paceTier).toBe('slow');
  });

  it('accepts v3 documents without a pace tier', () => {
    const document = makeDocument({
      statements: [dialogue('dlg_1', 1, '已有。', 2)],
    });
    const parsed = sceneDocumentCodec.parseAndValidate(document);
    expect(parsed.meta.paceTier).toBeUndefined();
  });

  it('rejects non-scene pace tier values', () => {
    expect(() => sceneDocumentCodec.parseAndValidate(makeDocument({
      meta: { title: 'Test', paceTier: 'hold' as any },
    }))).toThrow(/paceTier/);
  });
});

describe('SemanticTimelineAuthoringService update-statement text pacing', () => {
  it('recomputes duration from the new text at the scene tier', () => {
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
    });
    let statementIndex = 1;
    const document = makeDocument({
      meta: { title: 'Test', paceTier: 'slow' },
      statements: [dialogue('dlg_1', 0, '你好。', 1)],
    });
    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'lock_3',
      origin: 'timeline-editor',
      kind: 'update-statement',
      statementId: 'dlg_1',
      patch: { params: { text: '我想把这句话说清楚。', durationSeconds: 1, style: 'typewriter' } },
    });
    const updated = result.document.statements[0];
    expect(updated.time).toBe(0);
    expect((updated.params as any).durationSeconds)
      .toBe(estimateDialogueDuration('我想把这句话说清楚。', 'slow'));
  });
});

describe('SemanticTimelineAuthoringService update-scene-pace-tier', () => {
  it('records the tier without re-timing existing statements', () => {
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
    });
    let statementIndex = 1;
    const document = makeDocument({
      meta: { title: 'Test', durationSeconds: 20 },
      statements: [
        dialogue('dlg_1', 0, '你好。', 1),
        dialogue('dlg_2', 3, '我想把这句话说清楚。', 1),
      ],
    });
    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'tier_1',
      origin: 'sequential-flow',
      kind: 'update-scene-pace-tier',
      tier: 'slow',
    });

    expect(result.document.meta.paceTier).toBe('slow');
    expect(result.document.statements[0].time).toBe(0);
    expect((result.document.statements[0].params as any).durationSeconds).toBe(1);
    expect(result.document.statements[1].time).toBe(3);
    expect((result.document.statements[1].params as any).durationSeconds).toBe(1);
    expect(result.document.meta.durationSeconds).toBe(20);
    expect(result.receipt.updatedStatementIds).toEqual([]);
    expect(result.receipt.historyDescriptor.key).toBe('timeline.author.updateScenePaceTier');
  });

  it('is a no-op when the tier is unchanged', () => {
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
    });
    let statementIndex = 1;
    const document = makeDocument({
      meta: { title: 'Test', paceTier: 'slow' },
      statements: [dialogue('dlg_1', 0, '你好。', 1)],
    });
    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'tier_3',
      origin: 'sequential-flow',
      kind: 'update-scene-pace-tier',
      tier: 'slow',
    });
    expect(result.receipt.updatedStatementIds).toEqual([]);
    expect(result.document.statements[0].time).toBe(0);
  });

  it('appends lines with the scene tier when no pace is given', () => {
    const service = new SemanticTimelineAuthoringService({
      statementIdGenerator: (prefix) => `${prefix}_${++statementIndex}`,
    });
    let statementIndex = 1;
    const document = makeDocument({
      meta: { title: 'Test', paceTier: 'slow' },
    });
    const result = service.author(document, {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'tier_4',
      origin: 'sequential-flow',
      kind: 'append-sequential-lines',
      lines: ['你好。', '我想把这句话说清楚。'],
    });

    const first = result.document.statements[0];
    const second = result.document.statements[1];
    expect((first.params as any).durationSeconds).toBe(estimateDialogueDuration('你好。', 'slow'));
    expect(second.time - (first.time + (first.params as any).durationSeconds))
      .toBeCloseTo(PACE_GAP.slow, 6);
  });
});

describe('buildUpdateScenePaceTierIntent', () => {
  it('builds a v3 update-scene-pace-tier intent with the sequential-flow origin', () => {
    const intent = buildUpdateScenePaceTierIntent('slow', {
      correlationId: 'intent_tier_1',
    });
    expect(intent).toEqual({
      version: AUTHORING_SCHEMA_VERSION,
      kind: 'update-scene-pace-tier',
      correlationId: 'intent_tier_1',
      origin: 'sequential-flow',
      tier: 'slow',
    });
  });
});

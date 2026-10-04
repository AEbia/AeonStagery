import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { SemanticScenePatchV1 } from '../api/types/semantic-scene-patch';
import {
  beginFormalEnhancementRun,
  buildFormalStatementGroups,
  buildSingleSegmentSegmentation,
  parseFormalTimepointLines,
  previewFormalSegmentation,
  resolveFormalUserTimepoints,
  summarizeSemanticScenePatch,
} from '../services/ai-authoring/FormalSceneEnhancementHost';

function makeDocument(statements: CurrentSceneDocument['statements']): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-test',
    meta: {
      title: 'Test',
      characters: [],
    },
    statements,
  };
}

describe('FormalSceneEnhancementHost', () => {
  it('groups roots by identical start time', () => {
    const document = makeDocument([
      {
        id: 'a',
        time: 0,
        type: 'dialogue',
        params: { text: '你好世界。', durationSeconds: 2 },
      },
      {
        id: 'b',
        time: 0,
        type: 'characterTransform',
        params: {
          id: '1',
          position: [0, 0],
          durationSeconds: 1,
        },
      },
      {
        id: 'c',
        time: 3,
        type: 'dialogue',
        params: { text: '第二句。', durationSeconds: 2 },
      },
    ]);

    const groups = buildFormalStatementGroups(document);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ time: 0, rootCount: 2, hasSpeakerText: true });
    expect(groups[1]).toMatchObject({ time: 3, rootCount: 1, hasSpeakerText: true });
  });

  it('computes requested vs effective segment targets', () => {
    const document = makeDocument([
      {
        id: 'a',
        time: 0,
        type: 'dialogue',
        params: { text: 'a'.repeat(100), durationSeconds: 2 },
      },
      {
        id: 'b',
        time: 2,
        type: 'dialogue',
        params: { text: 'b'.repeat(100), durationSeconds: 2 },
      },
      {
        id: 'c',
        time: 4,
        type: 'dialogue',
        params: { text: 'c'.repeat(100), durationSeconds: 2 },
      },
    ]);

    const preview = previewFormalSegmentation(document, 150);
    expect(preview.candidateBoundaryCount).toBe(2);
    expect(preview.requestedTarget).toBe(2);
    expect(preview.effectiveTarget).toBe(2);
  });

  it('resolves user timepoints to actual group starts', () => {
    const groups = [
      { index: 0, time: 0, rootCount: 1, hasSpeakerText: true, visibleChars: 10 },
      { index: 1, time: 5, rootCount: 1, hasSpeakerText: true, visibleChars: 10 },
      { index: 2, time: 12, rootCount: 1, hasSpeakerText: true, visibleChars: 10 },
    ];

    const resolved = resolveFormalUserTimepoints(groups, [4.2, 10]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.resolvedStarts).toEqual([
      { timepoint: 4.2, groupIndex: 1, groupTime: 5 },
      { timepoint: 10, groupIndex: 2, groupTime: 12 },
    ]);
    expect(resolved.segmentation.narrativeBoundaries).toEqual([
      { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 1 },
      { key: 'seg-1', startGroupIndex: 1, endGroupIndexExclusive: 2 },
      { key: 'seg-2', startGroupIndex: 2, endGroupIndexExclusive: 3 },
    ]);
  });

  it('rejects non-increasing timepoint mappings', () => {
    const groups = [
      { index: 0, time: 0, rootCount: 1, hasSpeakerText: true, visibleChars: 1 },
      { index: 1, time: 5, rootCount: 1, hasSpeakerText: true, visibleChars: 1 },
    ];
    const resolved = resolveFormalUserTimepoints(groups, [1, 1]);
    expect(resolved.ok).toBe(false);
  });

  it('parses mixed timepoint formats', () => {
    expect(parseFormalTimepointLines('12.5\n01:05, 90')).toEqual([12.5, 65, 90]);
  });

  it('begins empty-scene no_changes snapshot', () => {
    const document = makeDocument([]);
    const snapshot = beginFormalEnhancementRun({
      binding: { sceneSessionEpoch: 1, documentVersion: 3 },
      document,
      segmentation: buildSingleSegmentSegmentation([]),
    });
    expect(snapshot.phase).toBe('no_changes');
  });

  it('summarizes patch by operation and family', () => {
    const patch: SemanticScenePatchV1 = {
      version: 1,
      operations: [
        {
          kind: 'insertCompanion',
          parentLine: 1,
          companion: {
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: { target: '$speaker', motion: 'idle' },
          },
        },
        {
          kind: 'insertStatement',
          time: 1,
          statement: {
            type: 'camera',
            params: {
              mode: 'reset',
              durationSeconds: 1,
            },
          },
        },
        {
          kind: 'deleteLine',
          line: 4,
        },
      ],
    };

    const summary = summarizeSemanticScenePatch(patch);
    expect(summary.operationCount).toBe(3);
    expect(summary.counts.inserted).toBe(2);
    expect(summary.counts.updated).toBe(0);
    expect(summary.counts.deleted).toBe(1);
    expect(summary.byFamily.map((item) => item.family)).toEqual(
      expect.arrayContaining(['characterPerformance', 'camera', 'line']),
    );
  });
});

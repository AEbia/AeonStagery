import { describe, expect, it } from 'vitest';
import { createDraft } from '../services/ai-authoring/AiProseDraftSession';
import { buildAiProseDeterministicPreview } from '../services/ai-authoring/AiProseDeterministicCompiler';
import { countBlocksByKind, estimateReadingSeconds, formatTime, groupNormalizationBlocks, resolveSpeakerColors, summarizeTiming } from '../ui/ai-prose/workbenchPresentation';

describe('AI prose workbench presentation', () => {
  it('keeps successful blocks and failed groups in source order with exclusive offset line ranges', () => {
    const sourceText = '第一段。\n第二段。';
    const draft = createDraft({ sceneId: 'scene', sourceText, anchorMode: 'zero' });
    draft.segmentation.segments = [
      { index: 0, startOffset: 0, endOffset: 5, sourceText: '第一段。\n' },
      { index: 1, startOffset: 5, endOffset: sourceText.length, sourceText: '第二段。' },
    ];
    draft.normalization = [
      { segmentIndex: 1, status: 'failed', statements: [], error: { code: 'timeout', message: '请求超时' } },
      { segmentIndex: 0, status: 'succeeded', statements: [{ speaker: '林夏', text: '第一段。' }] },
    ];
    const groups = groupNormalizationBlocks(draft);
    expect(groups.map((group) => group.segmentIndex)).toEqual([0, 1]);
    expect(groups[0].blocks).toMatchObject([{ speaker: '林夏', text: '第一段。' }]);
    expect(groups[0].lineRange).toEqual([1, 1]);
    expect(groups[1]).toMatchObject({ status: 'failed', blocks: [], lineRange: [2, 2], error: { code: 'timeout' } });
    expect(draft.normalization[0].segmentIndex).toBe(1);
  });

  it('handles missing segments and empty successful tasks without throwing', () => {
    const draft = createDraft({ sceneId: 'scene', sourceText: '', anchorMode: 'zero' });
    expect(groupNormalizationBlocks(draft)).toEqual([]);
    draft.normalization = [{ segmentIndex: 3, status: 'succeeded', statements: [] }];
    expect(groupNormalizationBlocks(draft)).toEqual([{ segmentIndex: 3, status: 'succeeded', error: undefined, blocks: [], lineRange: null }]);
  });

  it('prefers scene colors, cycles by unique speaker order, and leaves narration unassigned', () => {
    const speakers = ['', '林夏', '周衡', '阿雅', '店员', '广播', '路人', '林夏'];
    const colors = resolveSpeakerColors(speakers, [{ id: 'lin', name: '林夏', color: '#123456' }]);
    expect(colors.has('')).toBe(false);
    expect(colors.size).toBe(6);
    expect(colors.get('林夏')).toBe('#123456');
    expect(colors.get('周衡')).toBe('var(--color-camera)');
    expect(colors.get('广播')).toBe('var(--color-dialogue)');
    expect(colors.get('路人')).toBe('var(--color-character)');
    expect(resolveSpeakerColors(speakers, undefined).get('林夏')).toBe('var(--color-character)');
  });

  it('counts kinds and summarizes actual statement durations excluding gaps', () => {
    const preview = buildAiProseDeterministicPreview([{ segmentIndex: 0, status: 'succeeded', statements: [
      { speaker: '林夏', text: '你好。' }, { speaker: '', text: '她走进房间。' },
    ] }]);
    const durations = preview.statements.map((statement) => statement.durationSeconds);
    expect(countBlocksByKind(preview.statements)).toEqual({ all: 2, dialogue: 1, narration: 1 });
    expect(summarizeTiming(preview)).toEqual({ dialogueCount: 1, narrationCount: 1,
      averageDuration: (durations[0] + durations[1]) / 2, longestDuration: Math.max(...durations) });
    expect(summarizeTiming({ statements: [], anchorTime: 12, durationSeconds: 0 })).toEqual({
      dialogueCount: 0, narrationCount: 0, averageDuration: 0, longestDuration: 0,
    });
  });

  it('estimates pure reading time and handles invalid counts and speeds', () => {
    expect(estimateReadingSeconds(980, 5)).toBe(196);
    expect(formatTime(estimateReadingSeconds(980, 5), 0)).toBe('03:16');
    for (const speed of [0, -1, NaN, Infinity]) expect(estimateReadingSeconds(980, speed)).toBe(0);
    for (const count of [0, -1, NaN, Infinity]) expect(estimateReadingSeconds(count, 5)).toBe(0);
    expect(formatTime(59.99, 0)).toBe('01:00');
  });
});

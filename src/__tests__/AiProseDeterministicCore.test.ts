import { describe, expect, it } from 'vitest';
import type { AiProseNormalizationTask } from '../api/types/ai-prose-authoring';
import {
  parseAiProseCharacterExtractionResponse,
  parseAiProseNormalizationResponse,
  parseAiProseSegmentationResponse,
} from '../services/ai-authoring/AiProseContracts';
import { buildAiProseDeterministicPreview } from '../services/ai-authoring/AiProseDeterministicCompiler';
import {
  estimateAiProseDuration,
  internalPunctuationPause,
  segmentAiProseGraphemes,
  spokenCharacterCount,
  splitAiProseStatementText,
  visibleCharacterCount,
} from '../services/ai-authoring/AiProseTextMetrics';
import {
  createAiProseSegmentationPlan,
  validateAiProseBoundarySelection,
} from '../services/ai-authoring/AiProseSegmentation';

describe('ADR-0022 deterministic prose core', () => {
  it('counts grapheme clusters without normalizing source text or counting controls', () => {
    const text = '你 好\n\t😀e\u0301';

    expect(visibleCharacterCount(text)).toBe(5);
    expect(spokenCharacterCount(text)).toBe(4);
  });

  it('uses a real grapheme fallback for combining marks, ZWJ emoji, and flags', () => {
    const intlWithSegmenter = Intl as typeof Intl & { Segmenter?: unknown };
    const originalSegmenter = intlWithSegmenter.Segmenter;
    Object.defineProperty(intlWithSegmenter, 'Segmenter', {
      configurable: true,
      value: undefined,
    });
    try {
      expect(segmentAiProseGraphemes('e\u0301')).toHaveLength(1);
      expect(segmentAiProseGraphemes('👩‍❤️‍💋‍👩')).toHaveLength(1);
      expect(segmentAiProseGraphemes('🇨🇳🇺🇸')).toHaveLength(2);
      expect(visibleCharacterCount('e\u0301👩‍❤️‍💋‍👩🇨🇳')).toBe(3);
    } finally {
      Object.defineProperty(intlWithSegmenter, 'Segmenter', {
        configurable: true,
        value: originalSegmenter,
      });
    }
  });

  it('splits long text at the latest eligible sentence punctuation', () => {
    const text = `${'甲'.repeat(80)}。${'乙'.repeat(20)}。`;
    const chunks = splitAiProseStatementText(text);

    expect(chunks).toEqual([
      `${'甲'.repeat(80)}。`,
      `${'乙'.repeat(20)}。`,
    ]);
    expect(chunks.join('')).toBe(text);
  });

  it('falls back to secondary punctuation and never hard-splits punctuation-free text', () => {
    const secondary = `${'甲'.repeat(60)}，${'乙'.repeat(40)}`;
    expect(splitAiProseStatementText(secondary)).toEqual([
      `${'甲'.repeat(60)}，`,
      '乙'.repeat(40),
    ]);

    const punctuationFree = '甲'.repeat(120);
    expect(splitAiProseStatementText(punctuationFree)).toEqual([punctuationFree]);
  });

  it('rejects non-finite visible-character capacities', () => {
    expect(() => splitAiProseStatementText('甲'.repeat(100), Number.NaN)).toThrow(
      'targetVisibleCharacters must be a positive finite number',
    );
    expect(() => splitAiProseStatementText('甲'.repeat(100), Number.POSITIVE_INFINITY)).toThrow(
      'targetVisibleCharacters must be a positive finite number',
    );
  });

  it('rejects whitespace-only normalized content while allowing an empty narration speaker', () => {
    expect(parseAiProseNormalizationResponse(JSON.stringify({
      statements: [{ speaker: '', text: '旁白。' }],
    }))).toEqual({ statements: [{ speaker: '', text: '旁白。' }] });
    expect(() => parseAiProseNormalizationResponse(JSON.stringify({
      statements: [{ speaker: '', text: '   ' }],
    }))).toThrow();
    expect(() => parseAiProseNormalizationResponse(JSON.stringify({
      statements: [{ speaker: '  ', text: '对白。' }],
    }))).toThrow();
    expect(() => parseAiProseCharacterExtractionResponse(JSON.stringify({
      mainCharacters: ['\t'],
    }))).toThrow();
  });

  it('uses spoken characters and internal punctuation pauses without a duration cap', () => {
    expect(internalPunctuationPause('甲；乙，丙。')).toBeCloseTo(0.4);
    expect(estimateAiProseDuration('甲；乙，丙。')).toBe(1.1);
    expect(estimateAiProseDuration('甲'.repeat(100))).toBeGreaterThan(7);
  });

  it('uses line boundaries by default and preserves exact source slices', () => {
    const source = '第一行。\n第二行。\n第三行。';
    const plan = createAiProseSegmentationPlan(source, 5);

    expect(plan.targetSegmentCount).toBe(2);
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(['L0001', 'L0002']);

    const result = validateAiProseBoundarySelection(plan, parseAiProseSegmentationResponse(
      JSON.stringify({ boundaryIds: ['L0001', 'L0002'] }),
    ));
    expect(result.segments.map((segment) => segment.sourceText)).toEqual([
      '第一行。\n',
      '第二行。\n',
      '第三行。',
    ]);
  });

  it('does not expose repeated blank lines as semantic segmentation candidates', () => {
    const plan = createAiProseSegmentationPlan('第一行。\n\n\n第二行。\n\n第三行。', 5);

    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(['L0001', 'L0004']);
    expect(plan.numberedSource).toContain('L0002 | [空行]');
    expect(plan.numberedSource).toContain('L0003 | [空行]');
  });

  it('validates the requested segment range using boundary count minus one', () => {
    const plan = createAiProseSegmentationPlan('aaaa\nbbbb\ncccc\ndddd', 8);

    expect(plan.targetSegmentCount).toBe(2);
    expect(validateAiProseBoundarySelection(plan, { boundaryIds: [] }).segments).toHaveLength(1);
    expect(validateAiProseBoundarySelection(plan, {
      boundaryIds: ['L0001', 'L0002'],
    }).segments).toHaveLength(3);
    expect(() => validateAiProseBoundarySelection(plan, {
      boundaryIds: ['L0001', 'L0002', 'L0003'],
    })).toThrow('边界数量 3 不在允许范围 [0, 2] 内');
  });

  it('exposes sentence candidates only when long-line fallback is needed', () => {
    const source = '甲甲甲甲甲。乙乙乙乙乙。丙丙丙丙丙。';
    const plan = createAiProseSegmentationPlan(source, 10);

    expect(plan.candidates.map((candidate) => candidate.id)).toEqual([
      'L0001-S0001',
      'L0001-S0002',
    ]);
    expect(() => validateAiProseBoundarySelection(plan, { boundaryIds: ['L9999'] })).toThrow(
      '不在候选集合中',
    );
  });

  it('builds a serial baseline and applies only bounded rhythm gaps', () => {
    const normalization: AiProseNormalizationTask[] = [{
      segmentIndex: 0,
      status: 'succeeded',
      statements: [
        { speaker: '林夏', text: '第一句。' },
        { speaker: '', text: '第二句。' },
      ],
    }];
    const preview = buildAiProseDeterministicPreview(normalization, [{
      segmentIndex: 0,
      status: 'succeeded',
      gapSeconds: [0.9],
    }], 3.2);

    expect(preview.statements.map((statement) => statement.time)).toEqual([3.2, 4.9]);
    expect(preview.statements[0].gapSecondsToNext).toBe(0.75);
    expect(preview.durationSeconds).toBe(2.6);
  });
});

import { describe, expect, it } from 'vitest';
import { createAiProseSegmentationPlan } from '../services/ai-authoring/AiProseSegmentation';
import type { AiProseStorySegment } from '../api/types/ai-prose-authoring';
import {
  AI_PROSE_JSON_CONTRACTS,
  buildAiProseCharacterExtractionPrompt,
  buildAiProseNormalizationPrompt,
  buildAiProseRhythmPrompt,
  buildAiProseSegmentationPrompt,
} from '../services/ai-authoring/AiProsePrompts';
import { parseSemanticScenePatch } from '../services/semantic-scene/SemanticScenePatch';

describe('ADR-0022 prose prompt contracts', () => {
  it('declares the segmentation JSON contract with numbered source and candidates', () => {
    const plan = createAiProseSegmentationPlan('第一行。\n第二行。', 4);
    const prompt = buildAiProseSegmentationPrompt(plan);

    expect(AI_PROSE_JSON_CONTRACTS.segmentation).toContain('boundaryIds');
    expect(prompt.systemPrompt).toContain(AI_PROSE_JSON_CONTRACTS.segmentation);
    expect(prompt.userPrompt).toContain(plan.numberedSource);
    expect(prompt.userPrompt).toContain('L0001');
    expect(prompt.userPrompt).toContain('只能从候选边界 ID 中选择');
  });

  it('keeps each stage contract explicit even when JSON output is available', () => {
    const segment: AiProseStorySegment = {
      index: 0,
      startOffset: 0,
      endOffset: 5,
      sourceText: '本段正文。',
    };
    const blocks = [{
      segmentIndex: 0,
      sourceStatementIndex: 0,
      blockIndex: 0,
      speaker: '林夏',
      text: '本段正文。',
    }];

    expect(buildAiProseCharacterExtractionPrompt('全文正文').systemPrompt)
      .toContain(AI_PROSE_JSON_CONTRACTS.characterExtraction);
    expect(buildAiProseNormalizationPrompt(segment, ['林夏']).systemPrompt)
      .toContain(AI_PROSE_JSON_CONTRACTS.normalization);
    expect(buildAiProseNormalizationPrompt(segment, ['林夏']).userPrompt)
      .toContain('本段正文。');
    expect(buildAiProseRhythmPrompt(0, blocks).systemPrompt)
      .toContain(AI_PROSE_JSON_CONTRACTS.rhythm);
    expect(buildAiProseRhythmPrompt(0, blocks).userPrompt).toContain('恰好 0 个');
    expect(buildAiProseCharacterExtractionPrompt('全文正文').systemPrompt)
      .toContain('无论 JSON Output 能力是否启用');
  });

  it('embeds a concrete parseable operation example in the acting and cinematic contracts', () => {
    for (const stage of ['acting', 'cinematic'] as const) {
      const contract = AI_PROSE_JSON_CONTRACTS[stage];
      const example = contract.match(/契约: (\{\S+\})/);
      expect(example, `acting/cinematic contract should embed an operation example`).not.toBeNull();
      expect(() => parseSemanticScenePatch(JSON.parse(example![1])))
        .not.toThrow();
      expect(contract).toContain('判别字段');
      expect(contract).toContain('patch');
    }
  });

  it('teaches the current characterPerformance motion shape in the acting contract', () => {
    const contract = AI_PROSE_JSON_CONTRACTS.acting;
    expect(contract).toContain('"kind":"resource"');
    expect(contract).not.toContain('"motion":"anon/kandou01"');
    expect(contract).toContain('没有 params.durationSeconds、params.loop 或 params.priority');
  });

  it('addresses rhythm windows with global block indexes and treats embedded line breaks as opaque text', () => {
    const blocks = [0, 1, 2].map((index) => ({
      segmentIndex: 0,
      sourceStatementIndex: index,
      blockIndex: 0,
      speaker: '',
      text: index === 1 ? '中间块\n仍是同一个块。' : `块${index}。`,
    }));

    const prompt = buildAiProseRhythmPrompt(0, blocks, 40);
    const payload = JSON.parse(prompt.userPrompt.split('\n')[1]) as Array<{ index: number; text: string }>;

    expect(payload.map((block) => block.index)).toEqual([40, 41, 42]);
    expect(payload[1].text).toContain('\n');
    expect(prompt.userPrompt).toContain('全局块索引 40–42');
    expect(prompt.userPrompt).toContain('恰好 2 个');
    expect(prompt.systemPrompt).toContain('换行');
  });
});

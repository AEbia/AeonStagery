import type {
  AiProseStage,
  AiProseStorySegment,
} from '../../api/types/ai-prose-authoring';
import type { AiProseValidationFailure } from './AiProseContracts';
import type { AiProseSegmentationPlan } from './AiProseSegmentation';
import type { AiProseStatementBlock } from './AiProseDeterministicCompiler';

export interface AiProsePrompt {
  systemPrompt: string;
  userPrompt: string;
}

export const AI_PROSE_JSON_CONTRACTS: Readonly<Record<AiProseStage, string>> = Object.freeze({
  segmentation: [
    '只输出一个 JSON 对象，且只能包含字段 boundaryIds。',
    '契约: {"boundaryIds":["L0042","L0087-S0003"]}',
    'boundaryIds 必须是有序、不重复、来自候选集合的稳定边界 ID；不要输出正文、offset、行号或其他字段。',
  ].join(' '),
  characterExtraction: [
    '只输出一个 JSON 对象，且只能包含字段 mainCharacters。',
    '契约: {"mainCharacters":["林夏","周衡"]}',
    'mainCharacters 必须是去重后的非空人物名字字符串数组；不要输出描述、别名、总结、正文、speakerId 或其他字段。',
  ].join(' '),
  normalization: [
    '只输出一个 JSON 对象，且只能包含字段 statements。',
    '契约: {"statements":[{"speaker":"A","text":"xxx"},{"speaker":"","text":"旁白"}]}',
    '每个 statement 只能包含 speaker 和 text；两者都是字符串，text 非空；空 speaker 合法且表示旁白，非空 speaker 必须是具体说话人名字；不要输出 kind、speakerId、时间、duration、gap 或其他字段。',
  ].join(' '),
  rhythm: [
    '只输出一个 JSON 对象，且只能包含字段 gapSeconds。',
    '契约: {"gapSeconds":[0.35,0.25,0.6]}',
    'gapSeconds[i] 只对应 JSON 语句块 i 到 i+1 的一个边界；每个 gapSeconds 必须是 0.25 到 0.75 秒之间的正有限数值，一般以 0.35 秒为基准，并可根据语气、情绪、动作衔接和演出效果在此范围内调整。块内标点、换行、空行、字符数和正文句子数量都不能新增边界；不要输出文本、语句 ID、跨段间隔或其他字段。',
  ].join(' '),
  acting: [
    '只输出一个 JSON 对象，且只能包含字段 version 与 operations。',
    '契约: {"version":1,"operations":[{"kind":"updateCompanion","line":9,"patch":{"params":{"motion":{"kind":"resource","key":"anon/kandou01"},"expression":"anon/happy01"}}}]}',
    'operations 必须是 SemanticScenePatchV1 数组；只允许表演阶段白名单的 characterPerformance / characterTransform 操作；不要输出整份 scene、内部 UUID 或解释性 prose。',
    '每个 operation 必须带且只能带一个判别字段 kind（或 op/operation）；更新已有行一律把改动包进 patch，顶层没有 params 字段；同一行的多个表演字段合并进同一次 operation 的 patch.params。',
    'characterPerformance 的 motion 只能是空字符串占位或 {"kind":"resource","key":"..."} 对象；当前 Scene Document 契约没有 params.durationSeconds、params.loop 或 params.priority。',
  ].join(' '),
  cinematic: [
    '只输出一个 JSON 对象，且只能包含字段 version 与 operations。',
    '契约: {"version":1,"operations":[{"kind":"updateStatement","line":5,"patch":{"params":{"mode":"push","zoom":1.4}}}]}',
    'operations 必须是 SemanticScenePatchV1 数组；只允许电影感白名单的 camera / lighting / visual / filter 操作；不要输出整份 scene、内部 UUID 或解释性 prose。',
    '每个 operation 必须带且只能带一个判别字段 kind（或 op/operation）；更新已有行一律把改动包进 patch，顶层没有 params 字段；同一行的多个电影感字段合并进同一次 operation 的 patch.params。',
  ].join(' '),
});

function withContract(stage: AiProseStage, instruction: string): string {
  return [
    `你是 ${stage} 阶段模型。`,
    instruction,
    AI_PROSE_JSON_CONTRACTS[stage],
    '无论 JSON Output 能力是否启用，都必须遵守上述完整契约。',
  ].join('\n');
}

export function buildAiProseSegmentationPrompt(
  plan: AiProseSegmentationPlan,
): AiProsePrompt {
  const candidates = plan.candidates.map((candidate) => ({
    id: candidate.id,
    kind: candidate.kind,
    lineNumber: candidate.lineNumber,
    position: candidate.position,
  }));
  return {
    systemPrompt: withContract(
      'segmentation',
      '按故事结构从候选边界中选择分界点，不要重写或回传源正文。',
    ),
    userPrompt: [
      '编号源正文（编号仅供寻址，不属于源正文）：',
      plan.numberedSource,
      '',
      '候选边界（只能从候选边界 ID 中选择）：',
      JSON.stringify(candidates),
      '',
      `目标处理段数约为 ${plan.targetSegmentCount}，可返回约 ${Math.max(0, plan.targetSegmentCount - 1)} 个分界点。`,
    ].join('\n'),
  };
}

export function buildAiProseCharacterExtractionPrompt(sourceText: string): AiProsePrompt {
  return {
    systemPrompt: withContract(
      'characterExtraction',
      '通读完整源正文，只提取主要人物的显示名字并去重。',
    ),
    userPrompt: `完整源正文：\n${sourceText}`,
  };
}

export function buildAiProseNormalizationPrompt(
  segment: AiProseStorySegment,
  confirmedMainCharacters: readonly string[],
): AiProsePrompt {
  return {
    systemPrompt: withContract(
      'normalization',
      '只把提供的故事段按原文顺序转换为旁白或角色对白；不得补写、删减、合并、换序或改写。',
    ),
    userPrompt: [
      `故事段 ${segment.index + 1}（只允许使用这一段的局部语境）：`,
      segment.sourceText,
      '',
      '用户确认的主要人物名字（仅用于识别说话人）：',
      JSON.stringify([...confirmedMainCharacters]),
    ].join('\n'),
  };
}

export function buildAiProseRhythmPrompt(
  segmentIndex: number,
  blocks: readonly AiProseStatementBlock[],
  blockOffset = 0,
): AiProsePrompt {
  const blockPayload = blocks.map((block, index) => ({
    index: blockOffset + index,
    speaker: block.speaker,
    text: block.text,
  }));
  const expectedGapCount = Math.max(0, blocks.length - 1);
  const lastBlockIndex = blockOffset + Math.max(0, blocks.length - 1);
  return {
    systemPrompt: withContract(
      'rhythm',
      '只为当前故事段最终语句块的段内相邻边界规划停顿，不修改任何正文或说话人。',
    ),
    userPrompt: [
      `故事段 ${segmentIndex + 1} 的最终语句块窗口（全局块索引 ${blockOffset}–${lastBlockIndex}，共 ${blocks.length} 块）：`,
      JSON.stringify(blockPayload),
      `本窗口共包含 N = ${blocks.length} 个 JSON 语句块，因此只有 N-1 = ${expectedGapCount} 个相邻块边界。数组当前位置依次对应全局块 ${blockOffset} 到 ${blockOffset + 1}、${blockOffset + 1} 到 ${blockOffset + 2}，依此类推；请只返回恰好 ${expectedGapCount} 个（即 N-1 个）段内 gapSeconds。gapSeconds 一般为 0.35 秒，可根据演出效果在 0.25–0.75 秒范围内调整。`,
    ].join('\n'),
  };
}

export interface AiProseCorrectionPromptOptions {
  stage: AiProseStage;
  originalUserPrompt: string;
  invalidResponse: string;
  failures: readonly AiProseValidationFailure[];
  includeInvalidResponse?: boolean;
}

export function buildAiProseCorrectionPrompt(
  options: AiProseCorrectionPromptOptions,
): AiProsePrompt {
  const errors = options.failures.map((failure) => ({
    code: failure.code,
    path: failure.path,
    message: failure.message,
  }));
  const includeInvalidResponse = options.includeInvalidResponse !== false;
  return {
    systemPrompt: withContract(
      options.stage,
      '这是一次且仅一次纠错请求。只修正校验错误，不能猜测缺失内容或改变原任务范围。',
    ),
    userPrompt: [
      '原始任务输入：',
      options.originalUserPrompt,
      '',
      '原始任务契约：',
      AI_PROSE_JSON_CONTRACTS[options.stage],
      '',
      '具体校验错误：',
      JSON.stringify(errors),
      ...(includeInvalidResponse
        ? ['', '上一次无效响应：', options.invalidResponse]
        : ['', '上一次无效响应已省略；请根据原始任务和具体校验错误重新生成完整 JSON。']),
      '',
      '请只返回完整修正版 JSON。',
    ].join('\n'),
  };
}

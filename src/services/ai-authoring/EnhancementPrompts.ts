import type { AiProseStage } from '../../api/types/ai-prose-authoring';
import type { SemanticSceneLineViewV1 } from '../../api/types/semantic-scene-patch';
import type { PerformanceCapabilityCatalogV1 } from './performance/PerformanceProfileTypes';
import type { CinematicCapabilityCatalogV1 } from './CinematicCapabilityCatalog';
import { AI_PROSE_JSON_CONTRACTS, type AiProsePrompt } from './AiProsePrompts';

function withContract(stage: AiProseStage, instruction: string): string {
  return [
    `你是 ${stage} 阶段模型。`,
    instruction,
    AI_PROSE_JSON_CONTRACTS[stage],
    '无论 JSON Output 能力是否启用，都必须遵守上述完整契约。',
  ].join('\n');
}

const PERFORMANCE_SYSTEM_RULES = [
  '你是表演指导处理器：只补全表演，不改文案、duration、进退场、camera、lighting、visual、背景、audio 或 graphic。',
  '只修改 access=writable 的核心行；只能在当前故事段核心时间范围内插入。',
  '优先补全对白已有的 $speaker characterPerformance 占位（空 motion 可填）。',
  '已有非空表演字段是约束，不能覆盖或删除；只能填缺失/空字符串字段。',
  '听者反应必须有叙事动机，不机械全覆盖；无对白归属的独立动作才用 root characterPerformance。',
  'characterTransform 只能作为 root；characterPerformance 可作为 root 或 dialogue companion。',
  '禁止 delete/move/reorder 与 family replacement。',
  'motion/expression 只能使用能力目录中的实际 keys；未配置模型时可补 lookAt/blink/transform，不能编造 motion/expression。',
].join('\n');

const CINEMATIC_SYSTEM_RULES = [
  '你是电影感处理器：只修改 camera、lighting、visualStyle。',
  '可覆盖、删除或移动已有电影感内容；不要修改文案、表演、进退场、背景、audio 或 graphic。',
  '只修改 access=writable 的核心行；插入与 move 的时间必须落在核心区间。',
  'dialogue companion 仅允许 camera 与 visualStyle；lighting 只能是 root。',
  '禁止 family replacement 与 reorderCompanions。',
  '只使用能力目录中的合法 targets、presets、recipe 与枚举；避免相邻段重复运镜或遗漏 reset。',
  '禁止新建 filterAdd/filterChange/filterReset（镜头滤镜已废弃，仅保留历史兼容）。',
  '运镜安全原则：背景按舞台铺满（scale≈1）时，zoom 不放大（≈1）的位置平移（move/path/focus 的 position 位移）会露出背景范围外的黑边；zoom=1 时不要做位置平移，需要平移必须配合放大 zoom（focus/push 优先）或依赖更大的背景覆盖。',
].join('\n');

export function buildPerformanceEnhancementPrompt(input: {
  readonly storyText: string;
  readonly lineView: SemanticSceneLineViewV1;
  readonly catalog: PerformanceCapabilityCatalogV1;
  readonly unitKey: string;
}): AiProsePrompt {
  return {
    systemPrompt: withContract('acting', PERFORMANCE_SYSTEM_RULES),
    userPrompt: [
      `处理单元：${input.unitKey}`,
      '',
      '故事段文本（含 [Line:n] 标签，与行视图 line 对应）：',
      input.storyText,
      '',
      '精简行视图（寻址与现有约束；长正文可能已省略）：',
      JSON.stringify(input.lineView),
      '',
      '表演能力目录（按角色去重，只发一次）：',
      JSON.stringify(input.catalog),
    ].join('\n'),
  };
}

export function buildCinematicEnhancementPrompt(input: {
  readonly storyText: string;
  readonly lineView: SemanticSceneLineViewV1;
  readonly catalog: CinematicCapabilityCatalogV1;
  readonly unitKey: string;
}): AiProsePrompt {
  return {
    systemPrompt: withContract('cinematic', CINEMATIC_SYSTEM_RULES),
    userPrompt: [
      `处理单元：${input.unitKey}`,
      '',
      '故事段文本（含 [Line:n] 标签，与行视图 line 对应）：',
      input.storyText,
      '',
      '精简电影感行视图：',
      JSON.stringify(input.lineView),
      '',
      '电影感能力目录与段首状态：',
      JSON.stringify(input.catalog),
    ].join('\n'),
  };
}

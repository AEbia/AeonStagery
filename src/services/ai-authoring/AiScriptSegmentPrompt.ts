import type { CurrentSceneDocument, SceneStatement } from '../../api/types/semantic-scene';

export interface AiScriptSegmentPromptContext {
  scene: CurrentSceneDocument;
  currentTime: number;
  selectedStatementIds: string[];
}

function summarizeStatement(statement: SceneStatement): Record<string, unknown> {
  return {
    id: statement.id,
    time: statement.time,
    type: statement.type,
    params: statement.params,
  };
}

function collectNearbyStatements(scene: CurrentSceneDocument, currentTime: number): SceneStatement[] {
  return scene.statements
    .filter((statement) => Math.abs(statement.time - currentTime) <= 12)
    .slice(0, 30);
}

export function buildAiScriptSegmentSystemPrompt(): string {
  return [
    '你是 AeonStagery 的 AI 铺戏助手。',
    '你的任务是把用户提供的小说/剧本文本转成一段可插入当前时间线的结构+节奏草稿。',
    '只使用现有角色表中的 characterId；不要发明角色 ID。如果文本中有人名无法匹配，写入 unresolvedNames。',
    '不要输出素材路径、模型路径、图片、音频、背景、表演动作、运镜、灯光或任意底层参数。',
    '不要追求像素级或帧级精修；只决定登场、对白、停顿、退场、beat marker 和节奏 pace。',
    'position 只在 enter 步骤使用；dialogue 可以没有 characterId，此时表示旁白。',
    'pace 使用 snap/normal/slow/hold。snap 表示快节奏，hold 表示明显停顿或情绪凝住。',
    'marker 只用于关键节拍，不要给每句对白都加 marker。',
  ].join('\n');
}

export function buildAiScriptSegmentUserPrompt(
  sourceText: string,
  context: AiScriptSegmentPromptContext,
): string {
  const characters = (context.scene.meta.characters || []).map((character) => ({
    id: character.id,
    name: character.name,
    color: character.color,
    hasModel: !!character.model,
    variants: character.variants?.map((variant) => variant.name) || [],
  }));
  const selected = context.scene.statements
    .filter((statement) => context.selectedStatementIds.includes(statement.id))
    .map(summarizeStatement);
  const nearby = collectNearbyStatements(context.scene, context.currentTime).map(summarizeStatement);

  return JSON.stringify({
    task: '把 sourceText 铺成插入当前播放头的一段结构+节奏草稿。',
    currentTime: context.currentTime,
    availableCharacters: characters,
    selectedStatements: selected,
    nearbyStatements: nearby,
    sourceText,
  }, null, 2);
}

import type { AiRhythmPace } from '../../api/types/ai-authoring';
import {
  AUTHORING_SCHEMA_VERSION,
  type AppendSequentialLinesAuthorIntent,
  type AuthoringOrigin,
  type InsertDialogueInChainAuthorIntent,
  type UpdateScenePaceTierAuthorIntent,
} from '../../api/types/authoring';
import type {
  CurrentSceneDocument,
  ScenePaceTier,
  SceneStatementDraft,
} from '../../api/types/semantic-scene';
import { sceneStatementFactory } from '../semantic-scene';
import { PACE_GAP, resolveDialogueDuration, type DialogueTypewriterTiming } from '../pacing/pacing';

/**
 * 顺序语句流:WebGAL 式逐句对白追加。
 * 输入只是文本行;每条语句的时长与间隔由本地节奏模块自动算出并实体化,
 * 时间线位置(append anchor)由文档当前末尾计算得出,用户无需输入任何数字。
 */

export interface SequentialDialogueCompileResult {
  statements: SceneStatementDraft[];
  /** 全部语句 + 末尾间隔的累计时长(秒)。 */
  durationSeconds: number;
}

export interface SequentialFlowAuthoringInput {
  correlationId: string;
  origin?: AuthoringOrigin;
  pace?: AiRhythmPace;
}

const DEFAULT_SEQUENTIAL_PACE: AiRhythmPace = 'normal';

function roundTime(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 把文本行编译为按输入顺序排列的对白语句草稿:
 * 每行一句,时长为按字符估算(正常档),句间间隔取节奏档位。
 * 空行与纯空白行被跳过;末尾保留一句间隔作为尾部停顿。
 */
export function compileSequentialDialogueDrafts(
  lines: readonly string[],
  pace: AiRhythmPace = DEFAULT_SEQUENTIAL_PACE,
  typewriter?: DialogueTypewriterTiming,
): SequentialDialogueCompileResult {
  const statements: SceneStatementDraft[] = [];
  let cursor = 0;
  for (const rawLine of lines) {
    const text = rawLine.trim();
    if (!text) continue;
    const duration = resolveDialogueDuration({
      context: 'pace-tier',
      text,
      pace,
      typewriter,
    });
    statements.push({
      time: roundTime(cursor),
      type: 'dialogue',
      params: {
        text,
        durationSeconds: duration,
        style: 'typewriter',
      },
    });
    cursor = roundTime(cursor + duration + PACE_GAP[pace]);
  }
  return { statements, durationSeconds: cursor };
}

/** 当前时间线末尾(秒):语句 + 伴随语句的实际末尾与显式场景时长中的较大者。 */
export function computeTimelineEndSeconds(document: CurrentSceneDocument): number {
  const statementsEnd = sceneStatementFactory.computeSceneEnd(document);
  return roundTime(Math.max(document.meta.durationSeconds ?? 0, statementsEnd));
}

/** 构建 v3 追加意图:anchor 由 authoring 服务在提交时计算,调用方不传任何时间。 */
export function buildAppendSequentialLinesIntent(
  lines: readonly string[],
  input: SequentialFlowAuthoringInput,
): AppendSequentialLinesAuthorIntent {
  return {
    version: AUTHORING_SCHEMA_VERSION,
    kind: 'append-sequential-lines',
    correlationId: input.correlationId,
    origin: input.origin ?? 'sequential-flow',
    lines: [...lines],
    ...(input.pace ? { pace: input.pace } : {}),
  };
}

/** 构建 v3 行间插入对白意图:位置语义(beforeStatementId),时间由 authoring 服务计算。 */
export function buildInsertDialogueInChainIntent(
  text: string,
  input: SequentialFlowAuthoringInput,
  beforeStatementId?: string,
): InsertDialogueInChainAuthorIntent {
  return {
    version: AUTHORING_SCHEMA_VERSION,
    kind: 'insert-dialogue-in-chain',
    correlationId: input.correlationId,
    origin: input.origin ?? 'sequential-flow',
    text,
    ...(beforeStatementId ? { beforeStatementId } : {}),
  };
}

/** 构建 v3 场景节奏档位切换意图:档位只影响后续插入的语句。 */
export function buildUpdateScenePaceTierIntent(
  tier: ScenePaceTier,
  input: SequentialFlowAuthoringInput,
): UpdateScenePaceTierAuthorIntent {
  return {
    version: AUTHORING_SCHEMA_VERSION,
    kind: 'update-scene-pace-tier',
    correlationId: input.correlationId,
    origin: input.origin ?? 'sequential-flow',
    tier,
  };
}

/** 场景文档当前的节奏档位;缺省为 normal。 */
export function scenePaceTierOf(document: CurrentSceneDocument): ScenePaceTier {
  return document.meta.paceTier ?? 'normal';
}

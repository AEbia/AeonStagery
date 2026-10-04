import type {
  CurrentSceneDocument,
  ScenePaceTier,
  SceneStatement,
} from '../../api/types/semantic-scene';
import { sceneStatementDefinitionRegistry } from '../semantic-scene';
import { withSceneDocumentCanonicalOrder } from '../semantic-scene/SceneDocumentCanonicalOrder';
import { PACE_GAP } from '../pacing/pacing';
import { scenePaceTierOf } from './SequentialFlowAuthoring';

/**
 * 全自动重排(flow)级联纯函数。
 * 对白语句变更后,以其流槽位终点(时间 + 时长 + 档位间隔)的 delta
 * 平移其后的所有语句(含非对白),保持相对间距不变。
 * 仅对白触发级联;非对白语句的变更不触发。
 */

function roundTime(value: number): number {
  return Math.round(value * 10) / 10;
}

function inTimelineOrder(document: CurrentSceneDocument): CurrentSceneDocument {
  const statements = document.statements
    .map((statement, index) => ({ statement, index }))
    .sort((a, b) => a.statement.time - b.statement.time || a.index - b.index)
    .map(({ statement }) => statement);
  return withSceneDocumentCanonicalOrder(
    { ...document, statements },
    statements.map((statement) => statement.id),
  );
}

/** 对白语句的流槽位跨度(秒):durationSeconds + 档位句后间隔。 */
export function dialogueSlotSpan(statement: SceneStatement, tier: ScenePaceTier): number {
  const durationSeconds = (statement.params as { durationSeconds?: number }).durationSeconds ?? 0;
  return durationSeconds + PACE_GAP[tier];
}

/** 对白语句的流槽位终点(秒):time + 跨度。 */
export function dialogueSlotEnd(statement: SceneStatement, tier: ScenePaceTier): number {
  return statement.time + dialogueSlotSpan(statement, tier);
}

/** 任意语句的流槽位终点(秒):对白含句后间隔,非对白按其时间线时长。 */
export function flowSlotEnd(statement: SceneStatement, tier: ScenePaceTier): number {
  if (statement.type === 'dialogue') return dialogueSlotEnd(statement, tier);
  return statement.time + sceneStatementDefinitionRegistry.temporalExtent(statement);
}

/**
 * 应用一次对白语句变更并级联下游:
 * 用 nextStatement 替换 statementId 处的语句(仅限对白),
 * 并按新旧槽位终点的差平移其后的所有语句。
 * 槽位终点不变时只替换、不平移;目标非对白或 id 未知时原样返回。
 */
export function applyDialogueFlowShift(
  document: CurrentSceneDocument,
  statementId: string,
  nextStatement: SceneStatement,
  tier: ScenePaceTier,
): CurrentSceneDocument {
  const index = document.statements.findIndex((statement) => statement.id === statementId);
  if (index < 0) return document;
  const current = document.statements[index];
  if (current.type !== 'dialogue' || nextStatement.type !== 'dialogue') return document;
  const delta = roundTime(dialogueSlotEnd(nextStatement, tier) - dialogueSlotEnd(current, tier));
  const statements = document.statements.map((statement, statementIndex) => {
    if (statementIndex === index) return nextStatement;
    if (statementIndex > index && delta !== 0) {
      return { ...statement, time: roundTime(statement.time + delta) };
    }
    return statement;
  });
  return { ...document, statements };
}

/**
 * 把一条对白插入对白链(行间插入):
 * 插在 beforeStatementId 之前(缺省为链尾),新句时间 = 前一句的流槽位终点
 * (插在首位则锚定流起点 = 原第一条语句的时间)。
 * flow 开启时其后所有语句平移新句跨度;关闭时其余语句不动。
 * 仅接受对白;beforeStatementId 未知时按追加处理。
 */
export function insertDialogueInChain(
  document: CurrentSceneDocument,
  statement: SceneStatement,
  beforeStatementId: string | undefined,
  tier: ScenePaceTier,
  flow: boolean = true,
): CurrentSceneDocument {
  if (statement.type !== 'dialogue') return document;
  const insertIndex = beforeStatementId === undefined
    ? document.statements.length
    : document.statements.findIndex((candidate) => candidate.id === beforeStatementId);
  const effectiveIndex = insertIndex < 0 ? document.statements.length : insertIndex;
  const anchorTime = effectiveIndex === 0
    ? document.statements[0]?.time ?? 0
    : flowSlotEnd(document.statements[effectiveIndex - 1], tier);
  const delta = flow ? dialogueSlotSpan(statement, tier) : 0;
  const statements = [
    ...document.statements.slice(0, effectiveIndex),
    { ...statement, time: roundTime(anchorTime) },
    ...document.statements.slice(effectiveIndex).map((candidate) => (
      delta === 0
        ? candidate
        : { ...candidate, time: roundTime(candidate.time + delta) }
    )),
  ];
  return { ...document, statements };
}

/**
 * 删除对白并级联下游:
 * 移除全部对白语句(非对白/未知 id 忽略),其后的所有语句按被删对白跨度之和回移。
 */
export function deleteDialogueFlow(
  document: CurrentSceneDocument,
  statementIds: readonly string[],
  tier: ScenePaceTier,
): CurrentSceneDocument {
  const removedById = new Map(
    document.statements
      .filter((statement) =>
        statement.type === 'dialogue' && statementIds.includes(statement.id))
      .map((statement) => [statement.id, statement]),
  );
  if (removedById.size === 0) return document;
  let removedBefore = 0;
  const statements = document.statements.flatMap((statement) => {
    if (removedById.has(statement.id)) {
      removedBefore += dialogueSlotSpan(statement, tier);
      return [];
    }
    if (removedBefore === 0) return [statement];
    return [{ ...statement, time: roundTime(statement.time - removedBefore) }];
  });
  return { ...document, statements };
}

/** Insert a authored fragment as one slot. Its internal offsets stay intact. */
export function insertDialogueFragmentFlow(
  before: CurrentSceneDocument,
  inserted: CurrentSceneDocument,
  insertedIds: readonly string[],
  tier: ScenePaceTier,
  beforeStatementId?: string,
): CurrentSceneDocument {
  const ids = new Set(insertedIds);
  const fragment = inserted.statements.filter((statement) => ids.has(statement.id));
  if (!fragment.some((statement) => statement.type === 'dialogue')) return inserted;
  const start = Math.min(...fragment.map((statement) => statement.time));
  const span = roundTime(Math.max(...fragment.map((statement) => flowSlotEnd(statement, tier))) - start);
  if (span <= 0) return inserted;
  const beforeIndex = beforeStatementId === undefined
    ? -1
    : before.statements.findIndex((statement) => statement.id === beforeStatementId);
  const downstreamIds = new Set(before.statements
    .filter((statement, index) => beforeIndex < 0 ? statement.time >= start : index >= beforeIndex)
    .map((statement) => statement.id));
  return inTimelineOrder({
    ...inserted,
    statements: inserted.statements.map((statement) => downstreamIds.has(statement.id)
      ? { ...statement, time: roundTime(statement.time + span) }
      : statement),
  });
}

/** Move a selected dialogue fragment and cascade the same delta through its downstream suffix. */
export function moveDialogueFragmentFlow(
  document: CurrentSceneDocument,
  statementIds: readonly string[],
  targetTime: number,
  _tier: ScenePaceTier,
): CurrentSceneDocument {
  const ids = new Set(statementIds);
  const selected = document.statements.filter((statement) => ids.has(statement.id));
  if (!selected.some((statement) => statement.type === 'dialogue')) return document;
  const start = Math.min(...selected.map((statement) => statement.time));
  const delta = roundTime(targetTime - start);
  if (delta === 0) return document;
  const firstSelectedIndex = document.statements.findIndex((statement) => ids.has(statement.id));
  return inTimelineOrder({
    ...document,
    statements: document.statements.map((statement, index) => index < firstSelectedIndex
      ? statement
      : { ...statement, time: roundTime(statement.time + delta) }),
  });
}

/**
 * 按给定顺序重排对白链(拖拽重排,flow 语义):
 * 把 movedStatementId 从旧槽位移到新槽位——旧槽位之后的语句回移其跨度,
 * 新槽位之后的语句前移其跨度;被拖对白落在新槽位前一句的流槽位终点
 * (移到首位则锚定流起点 = 原第一条语句的时间)。
 */
export function reorderDialogueFlow(
  document: CurrentSceneDocument,
  orderedDialogueIds: readonly string[],
  movedStatementId: string,
  tier: ScenePaceTier,
): CurrentSceneDocument {
  const dialogueIds = document.statements
    .filter((statement) => statement.type === 'dialogue')
    .map((statement) => statement.id);
  const dialogueSet = new Set(dialogueIds);
  if (
    orderedDialogueIds.length !== dialogueIds.length
    || new Set(orderedDialogueIds).size !== dialogueIds.length
    || orderedDialogueIds.some((id) => !dialogueSet.has(id))
    || !dialogueSet.has(movedStatementId)
  ) {
    return document;
  }
  if (orderedDialogueIds.every((id, index) => id === dialogueIds[index])) return document;

  const byId = new Map(document.statements.map((statement) => [statement.id, statement]));
  const moved = byId.get(movedStatementId)!;
  const oldIndex = document.statements.findIndex((statement) => statement.id === movedStatementId);
  const delta = dialogueSlotSpan(moved, tier);
  const oldIndexById = (id: string): number => document.statements.findIndex((s) => s.id === id);

  // Remove the moved slot first. The preceding dialogue in the requested order
  // defines the new slot boundary; non-dialogue statements retain their order.
  const shifted = document.statements
    .filter((statement) => statement.id !== movedStatementId)
    .map((statement) => {
      if (oldIndexById(statement.id) <= oldIndex) return statement;
      return { ...statement, time: roundTime(statement.time - delta) };
    });
  const movedOrderIndex = orderedDialogueIds.indexOf(movedStatementId);
  const previousDialogueId = orderedDialogueIds[movedOrderIndex - 1];
  const previousIndex = previousDialogueId === undefined
    ? -1
    : shifted.findIndex((statement) => statement.id === previousDialogueId);
  const anchorTime = previousIndex < 0
    ? document.statements[0]?.time ?? 0
    : flowSlotEnd(shifted[previousIndex], tier);
  const firstAfterAnchorIndex = previousIndex < 0
    ? -1
    : shifted.findIndex((statement, index) => index > previousIndex && statement.time >= anchorTime);
  const insertionIndex = previousIndex < 0 || firstAfterAnchorIndex < 0
    ? previousIndex < 0 ? 0 : shifted.length
    : firstAfterAnchorIndex;
  const shiftedWithGap = shifted.map((statement, index) => {
    if (index < insertionIndex) return statement;
    return { ...statement, time: roundTime(statement.time + delta) };
  });

  shiftedWithGap.splice(insertionIndex, 0, { ...moved, time: roundTime(anchorTime) });
  return withSceneDocumentCanonicalOrder(
    { ...document, statements: shiftedWithGap },
    shiftedWithGap.map((statement) => statement.id),
  );
}

/**
 * 不自动重排(manual)的对白重排:
 * 只把被拖对白移到新槽位(时间 = 新邻居的中点),其余语句时间不动。
 * 数组顺序按 orderedDialogueIds 重排。
 */
export function reorderDialogueManual(
  document: CurrentSceneDocument,
  orderedDialogueIds: readonly string[],
  movedStatementId: string,
): CurrentSceneDocument {
  const dialogueIds = document.statements
    .filter((statement) => statement.type === 'dialogue')
    .map((statement) => statement.id);
  const dialogueSet = new Set(dialogueIds);
  if (
    orderedDialogueIds.length !== dialogueIds.length
    || new Set(orderedDialogueIds).size !== dialogueIds.length
    || orderedDialogueIds.some((id) => !dialogueSet.has(id))
  ) {
    return document;
  }
  const byId = new Map(document.statements.map((statement) => [statement.id, statement]));
  const moved = dialogueSet.has(movedStatementId) ? byId.get(movedStatementId)! : undefined;
  if (moved === undefined) return document;
  if (orderedDialogueIds.every((id, index) => id === dialogueIds[index])) return document;

  const reordered = document.statements.filter((statement) => statement.id !== movedStatementId);
  const movedOrderIndex = orderedDialogueIds.indexOf(movedStatementId);
  const previousDialogueId = orderedDialogueIds[movedOrderIndex - 1];
  const previousIndex = previousDialogueId === undefined
    ? -1
    : reordered.findIndex((statement) => statement.id === previousDialogueId);
  const previous = previousIndex < 0 ? undefined : reordered[previousIndex];
  const anchorTime = previous === undefined
    ? document.statements[0]?.time ?? 0
    : flowSlotEnd(previous, scenePaceTierOf(document));
  const followingIndex = previousIndex < 0
    ? 0
    : reordered.findIndex((statement, index) => index > previousIndex && statement.time >= anchorTime);
  const insertionIndex = followingIndex < 0 ? reordered.length : followingIndex;
  const following = reordered[insertionIndex];
  const time = previous === undefined
    ? anchorTime
    : following === undefined
      ? anchorTime
      : (anchorTime + following.time) / 2;
  reordered.splice(insertionIndex, 0, { ...moved, time: roundTime(time) });
  return withSceneDocumentCanonicalOrder(
    { ...document, statements: reordered },
    reordered.map((statement) => statement.id),
  );
}

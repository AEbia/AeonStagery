import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type {
  SemanticSceneOperationV1,
  SemanticScenePatchCountsV1,
  SemanticScenePatchV1,
} from '../../api/types/semantic-scene-patch';
import {
  SceneEnhancementSnapshotStore,
  bindEnhancementSegmentation,
  createEmptySceneNoChangesSnapshot,
  createSceneEnhancementSnapshot,
  isEmptySceneDocument,
  withSceneEnhancementPhase,
  type ResolvedEnhancementSegmentationV1,
  type SceneEnhancementSnapshotV1,
  type SceneEnhancementVersionBindingV1,
} from './SceneEnhancementSnapshot';
import { visibleCharacterCount } from './AiProseTextMetrics';

/** Renderer-memory store for the formal enhancement panel (not process-persistent). */
export const formalSceneEnhancementStore = new SceneEnhancementSnapshotStore();

export interface FormalStatementGroupV1 {
  readonly index: number;
  readonly time: number;
  readonly rootCount: number;
  readonly hasSpeakerText: boolean;
  readonly visibleChars: number;
}

export interface FormalSegmentationPreviewV1 {
  readonly groups: readonly FormalStatementGroupV1[];
  readonly speakerTextVisibleChars: number;
  readonly requestedTarget: number;
  readonly candidateBoundaryCount: number;
  readonly effectiveTarget: number;
}

export type FormalTimepointResolveResultV1 =
  | {
      readonly ok: true;
      readonly resolvedStarts: readonly { readonly timepoint: number; readonly groupIndex: number; readonly groupTime: number }[];
      readonly segmentation: Omit<ResolvedEnhancementSegmentationV1, 'binding'>;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

export interface FormalPatchFamilySummaryV1 {
  readonly family: string;
  readonly count: number;
  readonly operations: readonly string[];
}

export interface FormalPatchSummaryV1 {
  readonly operationCount: number;
  readonly counts: SemanticScenePatchCountsV1;
  readonly byOperation: Readonly<Record<string, number>>;
  readonly byFamily: readonly FormalPatchFamilySummaryV1[];
}

function operationName(operation: SemanticSceneOperationV1): string {
  return (operation.kind ?? operation.op ?? operation.operation)!;
}

function familyFromOperation(operation: SemanticSceneOperationV1): string | undefined {
  const name = operationName(operation);
  if (name === 'insertStatement' && 'statement' in operation) {
    return operation.statement.type;
  }
  if (name === 'insertCompanion' && 'companion' in operation) {
    return operation.companion.type;
  }
  if ((name === 'updateStatement' || name === 'updateCompanion') && 'patch' in operation) {
    const type = operation.patch.type;
    return typeof type === 'string' ? type : undefined;
  }
  return undefined;
}

/**
 * Group consecutive root statements that share the same start time.
 * Companions are not separate groups (they attach to roots).
 */
export function buildFormalStatementGroups(document: CurrentSceneDocument): FormalStatementGroupV1[] {
  const groups: FormalStatementGroupV1[] = [];
  let current: {
    time: number;
    rootCount: number;
    hasSpeakerText: boolean;
    visibleChars: number;
  } | null = null;

  for (const statement of document.statements) {
    const hasSpeakerText = statement.type === 'dialogue';
    const text = hasSpeakerText && typeof (statement.params as { text?: unknown }).text === 'string'
      ? (statement.params as { text: string }).text
      : '';
    const chars = text ? visibleCharacterCount(text) : 0;

    if (!current || current.time !== statement.time) {
      if (current) {
        groups.push({
          index: groups.length,
          time: current.time,
          rootCount: current.rootCount,
          hasSpeakerText: current.hasSpeakerText,
          visibleChars: current.visibleChars,
        });
      }
      current = {
        time: statement.time,
        rootCount: 1,
        hasSpeakerText,
        visibleChars: chars,
      };
      continue;
    }

    current.rootCount += 1;
    current.hasSpeakerText = current.hasSpeakerText || hasSpeakerText;
    current.visibleChars += chars;
  }

  if (current) {
    groups.push({
      index: groups.length,
      time: current.time,
      rootCount: current.rootCount,
      hasSpeakerText: current.hasSpeakerText,
      visibleChars: current.visibleChars,
    });
  }

  return groups;
}

export function previewFormalSegmentation(
  document: CurrentSceneDocument,
  targetBatchSize: number,
): FormalSegmentationPreviewV1 {
  const groups = buildFormalStatementGroups(document);
  const speakerTextVisibleChars = groups.reduce(
    (sum, group) => sum + (group.hasSpeakerText ? group.visibleChars : 0),
    0,
  );
  const candidateBoundaryCount = Math.max(0, groups.length - 1);
  const requestedTarget = Math.max(1, Math.round(speakerTextVisibleChars / Math.max(1, targetBatchSize)));
  const effectiveTarget = Math.min(requestedTarget, candidateBoundaryCount + 1);

  return {
    groups,
    speakerTextVisibleChars,
    requestedTarget,
    candidateBoundaryCount,
    effectiveTarget: groups.length === 0 ? 0 : effectiveTarget,
  };
}

/**
 * Map strictly increasing user timepoints to the first group with time >= t.
 * Returns resolved display starts and narrative boundaries between groups.
 */
export function resolveFormalUserTimepoints(
  groups: readonly FormalStatementGroupV1[],
  timepoints: readonly number[],
): FormalTimepointResolveResultV1 {
  if (groups.length === 0) {
    return { ok: false, message: '当前 scene 没有 root statement，无法按时间点分段。' };
  }
  if (timepoints.length === 0) {
    return { ok: false, message: '请至少输入一个时间点。' };
  }

  const resolvedStarts: { timepoint: number; groupIndex: number; groupTime: number }[] = [];
  let previousGroupIndex = -1;

  for (const raw of timepoints) {
    if (!Number.isFinite(raw) || raw < 0) {
      return { ok: false, message: `时间点必须是非负有限数：${String(raw)}` };
    }
    const groupIndex = groups.findIndex((group) => group.time >= raw);
    if (groupIndex <= 0) {
      return {
        ok: false,
        message: `时间点 ${raw.toFixed(2)}s 无法解析到后续 statement group（不能产生首段空段）。`,
      };
    }
    if (groupIndex <= previousGroupIndex) {
      return {
        ok: false,
        message: `时间点必须映射到严格递增的 group 边界（冲突于 group ${groupIndex}）。`,
      };
    }
    previousGroupIndex = groupIndex;
    resolvedStarts.push({
      timepoint: raw,
      groupIndex,
      groupTime: groups[groupIndex]!.time,
    });
  }

  if (previousGroupIndex >= groups.length) {
    return { ok: false, message: '时间点产生了尾段空段。' };
  }

  const cuts = [0, ...resolvedStarts.map((item) => item.groupIndex), groups.length];
  const narrativeBoundaries = [];
  const segmentKeys = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const startGroupIndex = cuts[i]!;
    const endGroupIndexExclusive = cuts[i + 1]!;
    if (startGroupIndex >= endGroupIndexExclusive) {
      return { ok: false, message: '时间点产生了空段。' };
    }
    const key = `seg-${i}`;
    segmentKeys.push(key);
    narrativeBoundaries.push({ key, startGroupIndex, endGroupIndexExclusive });
  }

  return {
    ok: true,
    resolvedStarts,
    segmentation: {
      segmentKeys,
      narrativeBoundaries,
      source: 'user_timepoints',
    },
  };
}

export function buildSingleSegmentSegmentation(
  groups: readonly FormalStatementGroupV1[],
): Omit<ResolvedEnhancementSegmentationV1, 'binding'> {
  if (groups.length === 0) {
    return {
      segmentKeys: [],
      narrativeBoundaries: [],
      source: 'empty_scene',
    };
  }
  return {
    segmentKeys: ['seg-0'],
    narrativeBoundaries: [{
      key: 'seg-0',
      startGroupIndex: 0,
      endGroupIndexExclusive: groups.length,
    }],
    source: 'single_segment',
  };
}

export function beginFormalEnhancementRun(input: {
  readonly binding: SceneEnhancementVersionBindingV1;
  readonly document: CurrentSceneDocument;
  readonly segmentation: Omit<ResolvedEnhancementSegmentationV1, 'binding'>;
  readonly nowMs?: number;
}): SceneEnhancementSnapshotV1 {
  if (isEmptySceneDocument(input.document)) {
    return createEmptySceneNoChangesSnapshot({
      sceneSessionEpoch: input.binding.sceneSessionEpoch,
      documentVersion: input.binding.documentVersion,
      nowMs: input.nowMs,
    });
  }

  const base = createSceneEnhancementSnapshot({
    sceneSessionEpoch: input.binding.sceneSessionEpoch,
    documentVersion: input.binding.documentVersion,
    phase: 'idle',
    nowMs: input.nowMs,
  });

  return {
    ...withSceneEnhancementPhase(base, 'idle', input.nowMs),
    segmentation: bindEnhancementSegmentation({
      binding: input.binding,
      segmentKeys: input.segmentation.segmentKeys,
      narrativeBoundaries: input.segmentation.narrativeBoundaries,
      source: input.segmentation.source,
    }),
  };
}

export function summarizeSemanticScenePatch(patch: SemanticScenePatchV1): FormalPatchSummaryV1 {
  const byOperation: Record<string, number> = {};
  const familyBuckets = new Map<string, { count: number; operations: Set<string> }>();

  let insertedStatements = 0;
  let insertedCompanions = 0;
  let updatedStatements = 0;
  let updatedCompanions = 0;
  let deletedLines = 0;
  let movedLines = 0;
  let reorderedCompanionGroups = 0;

  for (const operation of patch.operations) {
    const name = operationName(operation);
    byOperation[name] = (byOperation[name] ?? 0) + 1;

    if (name === 'insertStatement') insertedStatements += 1;
    else if (name === 'insertCompanion') insertedCompanions += 1;
    else if (name === 'updateStatement') updatedStatements += 1;
    else if (name === 'updateCompanion') updatedCompanions += 1;
    else if (name === 'deleteLine') deletedLines += 1;
    else if (name === 'moveLine') movedLines += 1;
    else if (name === 'reorderCompanions') reorderedCompanionGroups += 1;

    const family = familyFromOperation(operation) ?? (name === 'deleteLine' || name === 'moveLine'
      ? 'line'
      : name === 'reorderCompanions'
        ? 'companions'
        : 'unknown');
    const bucket = familyBuckets.get(family) ?? { count: 0, operations: new Set<string>() };
    bucket.count += 1;
    bucket.operations.add(name);
    familyBuckets.set(family, bucket);
  }

  const inserted = insertedStatements + insertedCompanions;
  const updated = updatedStatements + updatedCompanions;

  return {
    operationCount: patch.operations.length,
    counts: {
      insertedStatements,
      insertedCompanions,
      updatedStatements,
      updatedCompanions,
      deletedLines,
      movedLines,
      reorderedCompanionGroups,
      inserted,
      updated,
      deleted: deletedLines,
      moved: movedLines,
    },
    byOperation,
    byFamily: [...familyBuckets.entries()]
      .map(([family, bucket]) => ({
        family,
        count: bucket.count,
        operations: [...bucket.operations].sort(),
      }))
      .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family)),
  };
}

export function formatFormalTime(value: number): string {
  if (!Number.isFinite(value)) return '00:00.0';
  const safe = Math.max(0, value);
  const minutes = Math.floor(safe / 60).toString().padStart(2, '0');
  const seconds = (safe % 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${seconds}`;
}

export function parseFormalTimepointLines(raw: string): number[] {
  return raw
    .split(/[\n,，;；\s]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => {
      if (token.includes(':')) {
        const [minutes, seconds] = token.split(':');
        return (Number(minutes) || 0) * 60 + (Number(seconds) || 0);
      }
      return Number(token);
    });
}

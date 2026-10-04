import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type {
  SemanticSceneOperationV1,
  SemanticScenePatchIssueV1,
  SemanticScenePatchV1,
} from '../../api/types/semantic-scene-patch';
import type { FormalStatementGroupV1 } from './FormalSceneEnhancementHost';
import type { ResolvedEnhancementSegmentationV1 } from './SceneEnhancementSnapshot';
import {
  SemanticSceneLineView,
  type SemanticSceneResolvedLine,
} from '../semantic-scene/SemanticSceneLineView';
import {
  sceneStatementDefinitionRegistry,
} from '../semantic-scene/SceneStatementDefinitionRegistry';

export interface EnhancementNarrativeBoundaryV1 {
  readonly key: string;
  readonly startGroupIndex: number;
  readonly endGroupIndexExclusive: number;
}

/**
 * Single source of truth for the safe per-unit story/line-view budget.
 * The processor runner default, the restore replay plan rebuild and the
 * line-view context budget all derive from this constant so fingerprints
 * stay comparable across runtime and restore paths.
 */
export const DEFAULT_MAX_VISIBLE_CHARS_PER_UNIT = 6000;

export interface EnhancementStageScopeV1 {
  readonly unitKey: string;
  readonly startGroupIndex: number;
  readonly endGroupIndexExclusive: number;
  /** Inclusive start time of the first core group. */
  readonly coreStartTime: number;
  /**
   * Exclusive end for non-last units (next unit first group.time).
   * Last unit: inclusive upper bound at the deterministic scene end computed
   * by computeSceneEndSeconds(document) — times <= scene end are in core.
   */
  readonly coreEndTimeExclusive: number;
  readonly isLastUnit: boolean;
  readonly writableRootLines: ReadonlySet<number>;
  readonly writableCompanionLines: ReadonlySet<number>;
  readonly writableLines: ReadonlySet<number>;
  /** Root statement ids belonging to core groups (host-only). */
  readonly coreRootStatementIds: ReadonlySet<string>;
}

export type TechnicalSplitUnitKindV1 = 'narrative' | 'technical_capacity';

export interface TechnicalSplitUnitV1 {
  readonly key: string;
  readonly kind: TechnicalSplitUnitKindV1;
  readonly narrativeKey: string;
  readonly startGroupIndex: number;
  readonly endGroupIndexExclusive: number;
  readonly visibleChars: number;
}

export type TechnicalSplitPlanV1 =
  | {
      readonly status: 'ok';
      readonly units: readonly TechnicalSplitUnitV1[];
    }
  | {
      readonly status: 'processing_unit_too_large';
      readonly groupIndex: number;
      readonly visibleChars: number;
      readonly maxVisibleCharsPerUnit: number;
      readonly message: string;
    };

export interface BuildEnhancementStageScopeInput {
  readonly document: CurrentSceneDocument;
  readonly groups: readonly FormalStatementGroupV1[];
  readonly boundary: EnhancementNarrativeBoundaryV1;
  readonly isLastUnit: boolean;
  /** Required when isLastUnit is false. */
  readonly nextUnitStartTime?: number;
  readonly unitKey?: string;
  readonly lineView?: SemanticSceneLineView;
}

export function buildEnhancementStageScope(
  input: BuildEnhancementStageScopeInput,
): EnhancementStageScopeV1 {
  const { groups, boundary } = input;
  if (boundary.startGroupIndex < 0
    || boundary.endGroupIndexExclusive > groups.length
    || boundary.startGroupIndex >= boundary.endGroupIndexExclusive) {
    throw new Error(`Invalid enhancement boundary: ${boundary.key}`);
  }

  const firstGroup = groups[boundary.startGroupIndex]!;
  const coreStartTime = firstGroup.time;
  let coreEndTimeExclusive: number;
  if (input.isLastUnit) {
    coreEndTimeExclusive = computeSceneEndSeconds(input.document);
  } else {
    if (typeof input.nextUnitStartTime !== 'number' || !Number.isFinite(input.nextUnitStartTime)) {
      throw new Error('nextUnitStartTime is required for non-last enhancement units');
    }
    coreEndTimeExclusive = input.nextUnitStartTime;
  }

  const lineView = input.lineView ?? new SemanticSceneLineView(input.document);
  const coreRootStatementIds = new Set<string>();
  const writableRootLines = new Set<number>();
  const writableCompanionLines = new Set<number>();

  // Map group indices → root statement indices by walking document in source order.
  const rootGroupIndexByStatementIndex = mapRootStatementGroupIndices(input.document, groups);

  for (const resolved of lineView.internalLines()) {
    const groupIndex = rootGroupIndexByStatementIndex.get(resolved.statementIndex);
    if (groupIndex === undefined) continue;
    if (groupIndex < boundary.startGroupIndex || groupIndex >= boundary.endGroupIndexExclusive) {
      continue;
    }
    coreRootStatementIds.add(resolved.statementId);
    if (resolved.kind === 'statement') {
      writableRootLines.add(resolved.line);
    } else {
      writableCompanionLines.add(resolved.line);
    }
  }

  const writableLines = new Set<number>([...writableRootLines, ...writableCompanionLines]);

  return {
    unitKey: input.unitKey ?? boundary.key,
    startGroupIndex: boundary.startGroupIndex,
    endGroupIndexExclusive: boundary.endGroupIndexExclusive,
    coreStartTime,
    coreEndTimeExclusive,
    isLastUnit: input.isLastUnit,
    writableRootLines,
    writableCompanionLines,
    writableLines,
    coreRootStatementIds,
  };
}

export function planTechnicalSplits(input: {
  readonly groups: readonly FormalStatementGroupV1[];
  readonly boundary: EnhancementNarrativeBoundaryV1;
  readonly maxVisibleCharsPerUnit: number;
}): TechnicalSplitPlanV1 {
  const maxChars = input.maxVisibleCharsPerUnit;
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error('maxVisibleCharsPerUnit must be a positive finite number');
  }

  const slice = input.groups.slice(
    input.boundary.startGroupIndex,
    input.boundary.endGroupIndexExclusive,
  );
  if (slice.length === 0) {
    return { status: 'ok', units: [] };
  }

  for (const group of slice) {
    if (group.visibleChars > maxChars) {
      return {
        status: 'processing_unit_too_large',
        groupIndex: group.index,
        visibleChars: group.visibleChars,
        maxVisibleCharsPerUnit: maxChars,
        message: `Statement group ${group.index} (${group.visibleChars} chars) exceeds safe request budget ${maxChars}`,
      };
    }
  }

  const totalChars = slice.reduce((sum, group) => sum + group.visibleChars, 0);
  if (totalChars <= maxChars) {
    return {
      status: 'ok',
      units: [{
        key: input.boundary.key,
        kind: 'narrative',
        narrativeKey: input.boundary.key,
        startGroupIndex: input.boundary.startGroupIndex,
        endGroupIndexExclusive: input.boundary.endGroupIndexExclusive,
        visibleChars: totalChars,
      }],
    };
  }

  const units: TechnicalSplitUnitV1[] = [];
  let cursor = input.boundary.startGroupIndex;
  let unitOrdinal = 0;
  while (cursor < input.boundary.endGroupIndexExclusive) {
    let end = cursor;
    let chars = 0;
    while (end < input.boundary.endGroupIndexExclusive) {
      const group = input.groups[end]!;
      if (chars > 0 && chars + group.visibleChars > maxChars) break;
      chars += group.visibleChars;
      end += 1;
    }
    units.push({
      key: `${input.boundary.key}#t${unitOrdinal}`,
      kind: 'technical_capacity',
      narrativeKey: input.boundary.key,
      startGroupIndex: cursor,
      endGroupIndexExclusive: end,
      visibleChars: chars,
    });
    unitOrdinal += 1;
    cursor = end;
  }

  return { status: 'ok', units };
}

/**
 * Expand narrative segmentation into ordered processing units with optional technical splits.
 */
export function expandSegmentationToProcessingUnits(input: {
  readonly groups: readonly FormalStatementGroupV1[];
  readonly segmentation: Pick<ResolvedEnhancementSegmentationV1, 'narrativeBoundaries'>;
  readonly maxVisibleCharsPerUnit: number;
}): TechnicalSplitPlanV1 {
  const units: TechnicalSplitUnitV1[] = [];
  for (const boundary of input.segmentation.narrativeBoundaries) {
    const plan = planTechnicalSplits({
      groups: input.groups,
      boundary,
      maxVisibleCharsPerUnit: input.maxVisibleCharsPerUnit,
    });
    if (plan.status !== 'ok') return plan;
    units.push(...plan.units);
  }
  return { status: 'ok', units };
}

export function assertEnhancementStageScope(input: {
  readonly patch: SemanticScenePatchV1;
  readonly scope: EnhancementStageScopeV1;
  readonly lineView: SemanticSceneLineView;
}): { ok: true } | { ok: false; issues: readonly SemanticScenePatchIssueV1[] } {
  const issues: SemanticScenePatchIssueV1[] = [];
  const resolvedByLine = new Map(
    input.lineView.internalLines().map((line) => [line.line, line] as const),
  );

  input.patch.operations.forEach((operation, index) => {
    const name = operationName(operation);
    if (name === 'insertStatement') {
      const time = 'time' in operation ? operation.time : undefined;
      if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
        issues.push(scopeIssue(index, 'insertStatement.time must be a non-negative finite number'));
        return;
      }
      if (!isTimeInCore(time, input.scope)) {
        issues.push(scopeIssue(index, `insertStatement.time ${time} is outside core stage scope`));
      }
      if ('beforeLine' in operation && operation.beforeLine !== undefined) {
        assertWritableLine(
          operation.beforeLine,
          index,
          input.scope,
          resolvedByLine,
          issues,
          'beforeLine',
        );
      }
      return;
    }

    if (name === 'insertCompanion') {
      const parentLine = 'parentLine' in operation ? operation.parentLine : undefined;
      if (typeof parentLine !== 'number') {
        issues.push(scopeIssue(index, 'insertCompanion.parentLine is required'));
        return;
      }
      const parent = resolvedByLine.get(parentLine);
      if (!parent || parent.kind !== 'statement') {
        issues.push(scopeIssue(index, `insertCompanion.parentLine ${parentLine} is not a root statement`));
        return;
      }
      if (!input.scope.writableRootLines.has(parentLine)) {
        issues.push(scopeIssue(index, `insertCompanion.parentLine ${parentLine} is outside core writable roots`));
      }
      if ('beforeLine' in operation && operation.beforeLine !== undefined) {
        assertWritableLine(
          operation.beforeLine,
          index,
          input.scope,
          resolvedByLine,
          issues,
          'beforeLine',
        );
      }
      return;
    }

    if (name === 'updateStatement' || name === 'updateCompanion' || name === 'deleteLine') {
      const line = 'line' in operation ? operation.line : undefined;
      if (typeof line !== 'number') {
        issues.push(scopeIssue(index, `${name}.line is required`));
        return;
      }
      assertWritableLine(line, index, input.scope, resolvedByLine, issues, 'line');
      return;
    }

    if (name === 'moveLine') {
      const line = 'line' in operation ? operation.line : undefined;
      const time = 'time' in operation ? operation.time : undefined;
      if (typeof line !== 'number') {
        issues.push(scopeIssue(index, 'moveLine.line is required'));
        return;
      }
      assertWritableLine(line, index, input.scope, resolvedByLine, issues, 'line');
      if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
        issues.push(scopeIssue(index, 'moveLine.time must be a non-negative finite number'));
        return;
      }
      if (!isTimeInCore(time, input.scope)) {
        issues.push(scopeIssue(index, `moveLine.time ${time} is outside core stage scope`));
      }
      return;
    }

    if (name === 'reorderCompanions') {
      const parentLine = 'parentLine' in operation ? operation.parentLine : undefined;
      if (typeof parentLine !== 'number') {
        issues.push(scopeIssue(index, 'reorderCompanions.parentLine is required'));
        return;
      }
      if (!input.scope.writableRootLines.has(parentLine)) {
        issues.push(scopeIssue(index, `reorderCompanions.parentLine ${parentLine} is outside core writable roots`));
      }
    }
  });

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** Deterministic scene end from registry temporal extents (for last-unit inclusive bound display). */
export function computeSceneEndSeconds(document: CurrentSceneDocument): number {
  let end = 0;
  for (const statement of document.statements) {
    const extent = sceneStatementDefinitionRegistry.temporalExtent(statement);
    end = Math.max(end, statement.time + extent);
  }
  return end;
}

function mapRootStatementGroupIndices(
  document: CurrentSceneDocument,
  groups: readonly FormalStatementGroupV1[],
): Map<number, number> {
  const map = new Map<number, number>();
  let groupIndex = 0;
  let rootsInGroup = 0;
  let currentTime: number | null = null;

  document.statements.forEach((statement, statementIndex) => {
    if (currentTime === null || statement.time !== currentTime) {
      if (currentTime !== null) groupIndex += 1;
      currentTime = statement.time;
      rootsInGroup = 0;
    }
    const group = groups[groupIndex];
    if (!group || group.time !== statement.time) {
      // Fall back: find by time
      const found = groups.findIndex((candidate) => candidate.time === statement.time);
      if (found >= 0) {
        map.set(statementIndex, found);
      }
      return;
    }
    map.set(statementIndex, groupIndex);
    rootsInGroup += 1;
    void rootsInGroup;
  });

  return map;
}

/** Tolerance for the inclusive last-unit scene end bound (matches roundTime-style 1e-9 usage). */
const SCENE_END_EPSILON = 1e-9;

function isTimeInCore(time: number, scope: EnhancementStageScopeV1): boolean {
  if (time < scope.coreStartTime) return false;
  if (scope.isLastUnit) {
    return time <= scope.coreEndTimeExclusive + SCENE_END_EPSILON;
  }
  return time < scope.coreEndTimeExclusive;
}

function assertWritableLine(
  line: number,
  operationIndex: number,
  scope: EnhancementStageScopeV1,
  resolvedByLine: ReadonlyMap<number, SemanticSceneResolvedLine>,
  issues: SemanticScenePatchIssueV1[],
  field: string,
): void {
  if (!scope.writableLines.has(line)) {
    issues.push(scopeIssue(
      operationIndex,
      `${field} ${line} is outside core stage scope`,
    ));
    return;
  }
  if (!resolvedByLine.has(line)) {
    issues.push(scopeIssue(operationIndex, `${field} ${line} does not exist in the fixed line view`));
  }
}

function operationName(operation: SemanticSceneOperationV1): string {
  return (operation.kind ?? operation.op ?? operation.operation) as string;
}

function scopeIssue(operationIndex: number, message: string): SemanticScenePatchIssueV1 {
  return {
    code: 'stage_scope_violation',
    message,
    path: `operations[${operationIndex}]`,
  };
}

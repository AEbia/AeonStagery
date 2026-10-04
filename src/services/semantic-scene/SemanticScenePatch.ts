import type {
  DialogueCompanion,
  CurrentSceneDocument,
  SceneStatement,
  StatementFamily,
} from '../../api/types/semantic-scene';
import {
  SEMANTIC_SCENE_OPERATION_NAMES,
  SEMANTIC_SCENE_PATCH_VERSION,
  type SemanticSceneCompanionDraftV1,
  type SemanticSceneCompanionPatchV1,
  type SemanticSceneJsonMergePatch,
  type SemanticSceneJsonMergePatchValue,
  type SemanticSceneLineMapInvalidationReasonV1,
  type SemanticSceneLineMapStateV1,
  type SemanticSceneOperationNameV1,
  type SemanticSceneOperationV1,
  type SemanticScenePatchApplyResultV1,
  type SemanticScenePatchCountsV1,
  type SemanticScenePatchErrorCodeV1,
  type SemanticScenePatchIssueV1,
  type SemanticScenePatchV1,
  type SemanticSceneInsertedIdentityV1,
  type SemanticSceneStatementDraftV1,
  type SemanticSceneStatementPatchV1,
} from '../../api/types/semantic-scene-patch';
import { SceneDocumentCodec } from './SceneDocumentCodec';
import {
  SceneStatementDefinitionRegistry,
  sceneStatementDefinitionRegistry,
} from './SceneStatementDefinitionRegistry';
import {
  SceneStatementFactory,
  sceneStatementFactory,
  type SceneStatementIdGenerator,
} from './SceneStatementFactory';
import {
  SemanticSceneLineView,
  type SemanticSceneResolvedLine,
} from './SemanticSceneLineView';

export class SemanticScenePatchError extends Error {
  readonly code: SemanticScenePatchErrorCodeV1;
  readonly issues: readonly SemanticScenePatchIssueV1[];

  constructor(issues: readonly SemanticScenePatchIssueV1[], message?: string) {
    const primary = issues[0];
    super(message ?? primary?.message ?? 'Semantic scene patch failed');
    this.name = 'SemanticScenePatchError';
    this.code = primary?.code ?? 'invalid_arguments';
    this.issues = issues;
  }
}

/**
 * Data-driven stage policy seam. Later enhancement stages (performance /
 * cinematic) supply concrete allow-lists; the project Agent may leave this open.
 */
export interface SemanticSceneStagePolicyV1 {
  readonly allowedOperations?: readonly SemanticSceneOperationNameV1[];
  readonly allowedFamilies?: readonly StatementFamily[];
  /** Families allowed for dialogue companions. When unset, companion families are unrestricted. */
  readonly allowedCompanionFamilies?: readonly StatementFamily[];
  /** Absolute patch paths (e.g. `params.text`, `anchor`) that remain writable. */
  readonly allowedPaths?: readonly string[];
  /** Absolute patch paths that are always rejected for this stage. */
  readonly forbiddenPaths?: readonly string[];
}

export interface ApplySemanticScenePatchOptions {
  readonly registry?: SceneStatementDefinitionRegistry;
  readonly factory?: SceneStatementFactory;
  readonly policy?: SemanticSceneStagePolicyV1;
  readonly idGenerator?: SceneStatementIdGenerator;
  /**
   * When false, skip final codec validation (used by pure unit tests that
   * intentionally leave companion families unconstrained). Defaults to true.
   */
  readonly validateCandidate?: boolean;
}

interface NormalizedOperation {
  readonly index: number;
  readonly name: SemanticSceneOperationNameV1;
  readonly raw: SemanticSceneOperationV1;
  readonly resolvedLine?: SemanticSceneResolvedLine;
  readonly resolvedParent?: SemanticSceneResolvedLine;
  readonly resolvedBefore?: SemanticSceneResolvedLine;
  readonly orderedResolved?: readonly SemanticSceneResolvedLine[];
}

interface FieldWrite {
  readonly operationIndex: number;
  readonly targetKey: string;
  readonly field: string;
}

const EMPTY_COUNTS: SemanticScenePatchCountsV1 = Object.freeze({
  insertedStatements: 0,
  insertedCompanions: 0,
  updatedStatements: 0,
  updatedCompanions: 0,
  deletedLines: 0,
  movedLines: 0,
  reorderedCompanionGroups: 0,
  inserted: 0,
  updated: 0,
  deleted: 0,
  moved: 0,
});

export function parseSemanticScenePatch(input: unknown): SemanticScenePatchV1 {
  if (!isRecord(input)) {
    throw new SemanticScenePatchError([{
      code: 'invalid_arguments',
      message: 'SemanticScenePatchV1 must be an object',
    }]);
  }
  if (input.version !== SEMANTIC_SCENE_PATCH_VERSION) {
    throw new SemanticScenePatchError([{
      code: 'invalid_arguments',
      message: `Unsupported semantic scene patch version: expected ${SEMANTIC_SCENE_PATCH_VERSION}`,
      path: 'version',
    }]);
  }
  if (!Array.isArray(input.operations)) {
    throw new SemanticScenePatchError([{
      code: 'invalid_arguments',
      message: 'SemanticScenePatchV1.operations must be an array',
      path: 'operations',
    }]);
  }

  const operations = input.operations.map((operation, index) =>
    normalizeOperation(operation, index),
  );
  return {
    version: SEMANTIC_SCENE_PATCH_VERSION,
    operations,
  };
}

/**
 * Apply a versioned semantic scene patch against a fixed document snapshot.
 * All line locators are resolved against the pre-mutation line view.
 */
export function applySemanticScenePatch(
  document: CurrentSceneDocument,
  patchInput: SemanticScenePatchV1 | unknown,
  options: ApplySemanticScenePatchOptions = {},
): SemanticScenePatchApplyResultV1 {
  const registry = options.registry ?? sceneStatementDefinitionRegistry;
  const factory = options.factory ?? (
    options.idGenerator
      ? new SceneStatementFactory({ idGenerator: options.idGenerator, registry })
      : sceneStatementFactory
  );
  const patch = parseSemanticScenePatch(patchInput);
  const lineView = new SemanticSceneLineView(document, { registry });

  if (patch.operations.length === 0) {
    return {
      status: 'no_change',
      candidate: document,
      document,
      lineView: lineView.toJSON(),
      lineMap: {
        validThroughLine: lineView.totalLines,
        refreshRequired: false,
        reason: 'none',
      },
      counts: EMPTY_COUNTS,
      warnings: [],
      insertedIdentities: [],
    };
  }

  const normalized = patch.operations.map((operation, index) =>
    resolveOperation(operation, index, lineView, document),
  );

  assertStagePolicy(normalized, options.policy, document);
  assertNoConflicts(normalized, document);

  const working = cloneJson(document) as CurrentSceneDocument;
  const counts = createMutableCounts();
  const insertedIdentities: SemanticSceneInsertedIdentityV1[] = [];
  let lineMap = emptyLineMap(lineView.totalLines);

  // Root moves first so companion moves see final parent times.
  for (const operation of normalized) {
    if (operation.name === 'moveLine' && operation.resolvedLine?.kind === 'statement') {
      applyRootMove(working, operation);
      counts.movedLines += 1;
      counts.moved += 1;
    }
  }

  for (const operation of normalized) {
    switch (operation.name) {
      case 'insertStatement': {
        const beforeIds = new Set(working.statements.map((statement) => statement.id));
        applyInsertStatement(working, operation, factory, registry);
        const inserted = working.statements.find((statement) => !beforeIds.has(statement.id));
        if (inserted) {
          insertedIdentities.push({
            operationIndex: operation.index,
            statementId: inserted.id,
          });
          for (const companion of inserted.companions ?? []) {
            insertedIdentities.push({
              operationIndex: operation.index,
              statementId: inserted.id,
              companionId: companion.id,
            });
          }
        }
        counts.insertedStatements += 1;
        counts.inserted += 1;
        lineMap = mergeLineMap(lineMap, structuralInvalidation(
          'insert',
          resolveInsertStatementInvalidationLine(operation, lineView, document),
          lineView.totalLines,
        ));
        break;
      }
      case 'insertCompanion': {
        const parentId = operation.resolvedParent!.statementId;
        const parent = working.statements.find((statement) => statement.id === parentId);
        const beforeIds = new Set((parent?.companions ?? []).map((companion) => companion.id));
        applyInsertCompanion(working, operation, factory, registry);
        const nextParent = working.statements.find((statement) => statement.id === parentId);
        const inserted = (nextParent?.companions ?? [])
          .find((companion) => !beforeIds.has(companion.id));
        if (inserted) {
          insertedIdentities.push({
            operationIndex: operation.index,
            statementId: parentId,
            companionId: inserted.id,
          });
        }
        counts.insertedCompanions += 1;
        counts.inserted += 1;
        {
          const insertCompanion = operation.raw as Extract<
            SemanticSceneOperationV1,
            { parentLine: number; companion: unknown }
          >;
          lineMap = mergeLineMap(lineMap, structuralInvalidation(
            'insert',
            insertCompanion.beforeLine ?? ((operation.resolvedParent?.line ?? 0) + 1
              + companionCount(document, operation.resolvedParent!.statementId)),
            lineView.totalLines,
          ));
        }
        break;
      }
      case 'updateStatement': {
        const replacement = applyUpdateStatement(working, operation, registry);
        counts.updatedStatements += 1;
        counts.updated += 1;
        if (replacement) {
          lineMap = mergeLineMap(lineMap, structuralInvalidation(
            'family-replacement',
            operation.resolvedLine!.line,
            lineView.totalLines,
          ));
        }
        break;
      }
      case 'updateCompanion':
        applyUpdateCompanion(working, operation, registry);
        counts.updatedCompanions += 1;
        counts.updated += 1;
        break;
      case 'deleteLine':
        applyDeleteLine(working, operation);
        counts.deletedLines += 1;
        counts.deleted += 1;
        lineMap = mergeLineMap(lineMap, structuralInvalidation(
          'delete',
          operation.resolvedLine!.line,
          lineView.totalLines,
        ));
        break;
      case 'moveLine':
        if (operation.resolvedLine?.kind === 'companion') {
          applyCompanionMove(working, operation, registry);
          counts.movedLines += 1;
          counts.moved += 1;
        }
        break;
      case 'reorderCompanions':
        applyReorderCompanions(working, operation);
        counts.reorderedCompanionGroups += 1;
        lineMap = mergeLineMap(lineMap, structuralInvalidation(
          'reorder',
          (operation.resolvedParent?.line ?? 0) + 1,
          lineView.totalLines,
        ));
        break;
    }
  }

  const extended = extendExplicitDuration(normalizeAuthoringMotionInputs(working), registry);
  const candidate = options.validateCandidate === false
    ? extended
    : revalidate(extended, registry);

  const nextView = new SemanticSceneLineView(candidate, { registry });
  return {
    status: 'changed',
    candidate,
    document: candidate,
    lineView: nextView.toJSON(),
    lineMap,
    counts: freezeCounts(counts),
    warnings: [],
    insertedIdentities,
  };
}

function normalizeAuthoringMotionInputs(document: CurrentSceneDocument): CurrentSceneDocument {
  for (const statement of document.statements) {
    normalizePerformanceMotion(statement);
    for (const companion of statement.companions ?? []) {
      normalizePerformanceMotion(companion);
    }
  }
  return document;
}

function normalizePerformanceMotion(entity: SceneStatement | DialogueCompanion): void {
  if (entity.type !== 'characterPerformance') return;
  const params = entity.params as unknown as { motion?: unknown };
  if (typeof params.motion === 'string' && params.motion !== '') {
    params.motion = { kind: 'resource', key: params.motion };
  }
}

export function applySemanticSceneJsonMergePatch(
  target: unknown,
  patch: SemanticSceneJsonMergePatch,
): unknown {
  return jsonMergePatch(target, patch);
}

export function isSemanticScenePatchError(error: unknown): error is SemanticScenePatchError {
  return error instanceof SemanticScenePatchError;
}

function revalidate(
  document: CurrentSceneDocument,
  registry: SceneStatementDefinitionRegistry,
): CurrentSceneDocument {
  try {
    return new SceneDocumentCodec(registry).parseAndValidate(document);
  } catch (error) {
    throw new SemanticScenePatchError([{
      code: 'schema_validation_failed',
      message: error instanceof Error ? error.message : String(error),
    }]);
  }
}

function extendExplicitDuration(
  document: CurrentSceneDocument,
  registry: SceneStatementDefinitionRegistry,
): CurrentSceneDocument {
  const duration = document.meta.durationSeconds;
  if (duration === undefined) return document;
  try {
    const end = new SceneStatementFactory({ registry }).computeSceneEnd(document);
    if (Number.isFinite(end) && end > duration) {
      return { ...document, meta: { ...document.meta, durationSeconds: end } };
    }
  } catch {
    // The delegated validation gate must still receive malformed candidates.
  }
  return document;
}

function normalizeOperation(input: unknown, index: number): SemanticSceneOperationV1 {
  if (!isRecord(input)) {
    throw issueAt(index, 'invalid_arguments', 'Operation must be an object');
  }
  const name = readOperationName(input, index);
  switch (name) {
    case 'insertStatement':
      return normalizeInsertStatement(input, index);
    case 'insertCompanion':
      return normalizeInsertCompanion(input, index);
    case 'updateStatement':
      return normalizeUpdateStatement(input, index);
    case 'updateCompanion':
      return normalizeUpdateCompanion(input, index);
    case 'deleteLine':
      return {
        kind: 'deleteLine',
        line: expectPositiveLine(input.line, index, 'line'),
      };
    case 'moveLine':
      return {
        kind: 'moveLine',
        line: expectPositiveLine(input.line, index, 'line'),
        time: expectNonNegativeFinite(input.time, index, 'time'),
      };
    case 'reorderCompanions':
      return {
        kind: 'reorderCompanions',
        parentLine: expectPositiveLine(input.parentLine, index, 'parentLine'),
        orderedLines: expectPositiveLineArray(input.orderedLines, index, 'orderedLines'),
      };
  }
}

function readOperationName(
  input: Record<string, unknown>,
  index: number,
): SemanticSceneOperationNameV1 {
  const present = (['kind', 'op', 'operation'] as const)
    .filter((key) => input[key] !== undefined)
    .map((key) => [key, input[key]] as const);
  if (present.length !== 1) {
    throw issueAt(
      index,
      'invalid_arguments',
      'Operation requires exactly one of kind, op, or operation',
      'kind',
    );
  }
  const [, value] = present[0];
  if (typeof value !== 'string' || !SEMANTIC_SCENE_OPERATION_NAMES.includes(value as SemanticSceneOperationNameV1)) {
    throw issueAt(index, 'invalid_arguments', `Unknown operation "${String(value)}"`, present[0][0]);
  }
  return value as SemanticSceneOperationNameV1;
}

function normalizeInsertStatement(
  input: Record<string, unknown>,
  index: number,
): SemanticSceneOperationV1 {
  if ('afterLine' in input && input.afterLine !== undefined) {
    throw issueAt(index, 'invalid_arguments', 'insertStatement does not support afterLine', 'afterLine');
  }
  const time = expectNonNegativeFinite(input.time, index, 'time');
  const statement = normalizeStatementDraft(input.statement, index, 'statement');
  const operation: SemanticSceneOperationV1 = {
    kind: 'insertStatement',
    time,
    statement,
  };
  if (input.beforeLine !== undefined) {
    return {
      ...operation,
      beforeLine: expectPositiveLine(input.beforeLine, index, 'beforeLine'),
    };
  }
  return operation;
}

function normalizeInsertCompanion(
  input: Record<string, unknown>,
  index: number,
): SemanticSceneOperationV1 {
  const companion = normalizeCompanionDraft(input.companion, index, 'companion');
  const operation: SemanticSceneOperationV1 = {
    kind: 'insertCompanion',
    parentLine: expectPositiveLine(input.parentLine, index, 'parentLine'),
    companion,
  };
  if (input.beforeLine !== undefined) {
    return {
      ...operation,
      beforeLine: expectPositiveLine(input.beforeLine, index, 'beforeLine'),
    };
  }
  return operation;
}

function normalizeUpdateStatement(
  input: Record<string, unknown>,
  index: number,
): SemanticSceneOperationV1 {
  const patch = expectMergePatch(input.patch, index, 'patch');
  assertNonEmptyPatch(patch, index, 'patch');
  for (const forbidden of ['id', 'time', 'companions'] as const) {
    if (Object.prototype.hasOwnProperty.call(patch, forbidden)) {
      throw issueAt(
        index,
        'invalid_arguments',
        `updateStatement cannot patch "${forbidden}"`,
        `patch.${forbidden}`,
      );
    }
  }
  return {
    kind: 'updateStatement',
    line: expectPositiveLine(input.line, index, 'line'),
    patch: patch as SemanticSceneStatementPatchV1,
  };
}

function normalizeUpdateCompanion(
  input: Record<string, unknown>,
  index: number,
): SemanticSceneOperationV1 {
  const patch = expectMergePatch(input.patch, index, 'patch');
  assertNonEmptyPatch(patch, index, 'patch');
  for (const forbidden of ['id', 'parent', 'parentLine'] as const) {
    if (Object.prototype.hasOwnProperty.call(patch, forbidden)) {
      throw issueAt(
        index,
        'invalid_arguments',
        `updateCompanion cannot patch "${forbidden}"`,
        `patch.${forbidden}`,
      );
    }
  }
  return {
    kind: 'updateCompanion',
    line: expectPositiveLine(input.line, index, 'line'),
    patch: patch as SemanticSceneCompanionPatchV1,
  };
}

function normalizeStatementDraft(
  input: unknown,
  index: number,
  path: string,
): SemanticSceneStatementDraftV1 {
  if (!isRecord(input)) {
    throw issueAt(index, 'invalid_arguments', 'Statement draft must be an object', path);
  }
  if (input.id !== undefined) {
    throw issueAt(index, 'invalid_arguments', 'Statement draft must not include id', `${path}.id`);
  }
  if (input.time !== undefined) {
    throw issueAt(index, 'invalid_arguments', 'Statement draft must not include time', `${path}.time`);
  }
  const type = expectFamilyName(input.type, index, `${path}.type`);
  if (input.params === undefined || !isRecord(input.params)) {
    throw issueAt(index, 'invalid_arguments', 'Statement draft requires params object', `${path}.params`);
  }
  if (input.companions !== undefined) {
    if (type !== 'dialogue') {
      throw issueAt(
        index,
        'invalid_arguments',
        'Only dialogue statement drafts may include companions',
        `${path}.companions`,
      );
    }
    if (!Array.isArray(input.companions)) {
      throw issueAt(index, 'invalid_arguments', 'companions must be an array', `${path}.companions`);
    }
    return {
      type,
      params: normalizeDraftPerformanceMotion(type, input.params) as SemanticSceneStatementDraftV1['params'],
      companions: input.companions.map((companion, companionIndex) =>
        normalizeCompanionDraft(companion, index, `${path}.companions[${companionIndex}]`),
      ),
    } as SemanticSceneStatementDraftV1;
  }
  return {
    type,
    params: normalizeDraftPerformanceMotion(type, input.params) as SemanticSceneStatementDraftV1['params'],
  } as SemanticSceneStatementDraftV1;
}

function normalizeCompanionDraft(
  input: unknown,
  index: number,
  path: string,
): SemanticSceneCompanionDraftV1 {
  if (!isRecord(input)) {
    throw issueAt(index, 'invalid_arguments', 'Companion draft must be an object', path);
  }
  if (input.id !== undefined) {
    throw issueAt(index, 'invalid_arguments', 'Companion draft must not include id', `${path}.id`);
  }
  const anchor = input.anchor;
  if (anchor !== 'start' && anchor !== 'end') {
    throw issueAt(index, 'invalid_arguments', 'Companion draft requires anchor start|end', `${path}.anchor`);
  }
  const offset = expectFiniteNumber(input.offset, index, `${path}.offset`);
  const type = expectFamilyName(input.type, index, `${path}.type`);
  if (input.params === undefined || !isRecord(input.params)) {
    throw issueAt(index, 'invalid_arguments', 'Companion draft requires params object', `${path}.params`);
  }
  return {
    anchor,
    offset,
    type,
    params: normalizeDraftPerformanceMotion(type, input.params) as SemanticSceneCompanionDraftV1['params'],
  } as SemanticSceneCompanionDraftV1;
}

function normalizeDraftPerformanceMotion(
  type: StatementFamily,
  params: Record<string, unknown>,
): Record<string, unknown> {
  return normalizePerformanceParamsInput(type, params) as Record<string, unknown>;
}

function normalizePerformanceParamsInput(type: StatementFamily, params: unknown): unknown {
  if (
    type !== 'characterPerformance'
    || !isRecord(params)
    || typeof params.motion !== 'string'
    || params.motion === ''
  ) {
    return params;
  }
  return { ...params, motion: { kind: 'resource', key: params.motion } };
}

function resolveOperation(
  operation: SemanticSceneOperationV1,
  index: number,
  lineView: SemanticSceneLineView,
  document: CurrentSceneDocument,
): NormalizedOperation {
  const name = operationName(operation);
  switch (name) {
    case 'insertStatement': {
      const op = operation as Extract<SemanticSceneOperationV1, { time: number; statement: unknown }>;
      let resolvedBefore: SemanticSceneResolvedLine | undefined;
      if (op.beforeLine !== undefined) {
        resolvedBefore = requireResolved(lineView, op.beforeLine, index, 'beforeLine');
        if (resolvedBefore.kind !== 'statement') {
          throw issueAt(index, 'wrong_line_kind', 'beforeLine must address a root statement', 'beforeLine', op.beforeLine);
        }
        const beforeStatement = document.statements[resolvedBefore.statementIndex];
        if (beforeStatement.time !== op.time) {
          throw issueAt(
            index,
            'invalid_arguments',
            'beforeLine must address a root statement at the same time',
            'beforeLine',
            op.beforeLine,
          );
        }
      }
      return { index, name, raw: operation, resolvedBefore };
    }
    case 'insertCompanion': {
      const op = operation as Extract<SemanticSceneOperationV1, { parentLine: number; companion: unknown }>;
      const resolvedParent = requireResolved(lineView, op.parentLine, index, 'parentLine');
      if (resolvedParent.kind !== 'statement') {
        throw issueAt(index, 'wrong_line_kind', 'parentLine must address a dialogue root', 'parentLine', op.parentLine);
      }
      const parent = document.statements[resolvedParent.statementIndex];
      if (parent.type !== 'dialogue') {
        throw issueAt(index, 'wrong_line_kind', 'parentLine must address a dialogue root', 'parentLine', op.parentLine);
      }
      let resolvedBefore: SemanticSceneResolvedLine | undefined;
      if (op.beforeLine !== undefined) {
        resolvedBefore = requireResolved(lineView, op.beforeLine, index, 'beforeLine');
        if (
          resolvedBefore.kind !== 'companion'
          || resolvedBefore.parentStatementId !== resolvedParent.statementId
        ) {
          throw issueAt(
            index,
            'wrong_line_kind',
            'beforeLine must address an existing companion of the same parent',
            'beforeLine',
            op.beforeLine,
          );
        }
      }
      return { index, name, raw: operation, resolvedParent, resolvedBefore };
    }
    case 'updateStatement': {
      const op = operation as Extract<SemanticSceneOperationV1, { line: number; patch: SemanticSceneStatementPatchV1 }>;
      const resolvedLine = requireResolved(lineView, op.line, index, 'line');
      if (resolvedLine.kind !== 'statement') {
        throw issueAt(index, 'wrong_line_kind', 'updateStatement requires a root statement line', 'line', op.line);
      }
      return { index, name, raw: operation, resolvedLine };
    }
    case 'updateCompanion': {
      const op = operation as Extract<SemanticSceneOperationV1, { line: number; patch: SemanticSceneCompanionPatchV1 }>;
      const resolvedLine = requireResolved(lineView, op.line, index, 'line');
      if (resolvedLine.kind !== 'companion') {
        throw issueAt(index, 'wrong_line_kind', 'updateCompanion requires a companion line', 'line', op.line);
      }
      return { index, name, raw: operation, resolvedLine };
    }
    case 'deleteLine':
    case 'moveLine': {
      const op = operation as Extract<SemanticSceneOperationV1, { line: number }>;
      const resolvedLine = requireResolved(lineView, op.line, index, 'line');
      return { index, name, raw: operation, resolvedLine };
    }
    case 'reorderCompanions': {
      const op = operation as Extract<SemanticSceneOperationV1, { parentLine: number; orderedLines: readonly number[] }>;
      const resolvedParent = requireResolved(lineView, op.parentLine, index, 'parentLine');
      if (resolvedParent.kind !== 'statement') {
        throw issueAt(index, 'wrong_line_kind', 'parentLine must address a dialogue root', 'parentLine', op.parentLine);
      }
      const parent = document.statements[resolvedParent.statementIndex];
      if (parent.type !== 'dialogue') {
        throw issueAt(index, 'wrong_line_kind', 'parentLine must address a dialogue root', 'parentLine', op.parentLine);
      }
      const companions = parent.companions ?? [];
      const orderedResolved = op.orderedLines.map((line, orderedIndex) => {
        const resolved = requireResolved(lineView, line, index, `orderedLines[${orderedIndex}]`);
        if (
          resolved.kind !== 'companion'
          || resolved.parentStatementId !== resolvedParent.statementId
        ) {
          throw issueAt(
            index,
            'wrong_line_kind',
            'orderedLines must list companions of the parent',
            `orderedLines[${orderedIndex}]`,
            line,
          );
        }
        return resolved;
      });
      const currentIds = companions.map((companion) => companion.id);
      const orderedIds = orderedResolved.map((resolved) => resolved.companionId!);
      if (
        orderedIds.length !== currentIds.length
        || new Set(orderedIds).size !== orderedIds.length
        || currentIds.some((id) => !orderedIds.includes(id))
      ) {
        throw issueAt(
          index,
          'invalid_arguments',
          'orderedLines must be an exact permutation of the parent companions',
          'orderedLines',
        );
      }
      return { index, name, raw: operation, resolvedParent, orderedResolved };
    }
  }
}

function assertStagePolicy(
  operations: readonly NormalizedOperation[],
  policy: SemanticSceneStagePolicyV1 | undefined,
  document: CurrentSceneDocument,
): void {
  if (!policy) return;
  const allowedOperations = policy.allowedOperations
    ? new Set(policy.allowedOperations)
    : undefined;
  const allowedFamilies = policy.allowedFamilies
    ? new Set(policy.allowedFamilies)
    : undefined;
  const allowedCompanionFamilies = policy.allowedCompanionFamilies
    ? new Set(policy.allowedCompanionFamilies)
    : undefined;
  const allowedPaths = policy.allowedPaths ? new Set(policy.allowedPaths) : undefined;
  const forbiddenPaths = policy.forbiddenPaths ? new Set(policy.forbiddenPaths) : undefined;

  for (const operation of operations) {
    if (allowedOperations && !allowedOperations.has(operation.name)) {
      throw issueAt(
        operation.index,
        'forbidden_operation',
        `Operation "${operation.name}" is not allowed by stage policy`,
      );
    }

    if (allowedFamilies) {
      for (const family of operationFamilies(operation, document)) {
        if (!allowedFamilies.has(family)) {
          throw issueAt(
            operation.index,
            'forbidden_family',
            `Statement family "${family}" is not allowed by stage policy`,
          );
        }
      }
    }

    if (allowedCompanionFamilies) {
      for (const family of operationCompanionFamilies(operation, document)) {
        if (!allowedCompanionFamilies.has(family)) {
          throw issueAt(
            operation.index,
            'forbidden_family',
            `Companion family "${family}" is not allowed by stage policy`,
          );
        }
      }
    }

    if (
      (operation.name === 'updateStatement' || operation.name === 'updateCompanion')
      && (allowedPaths || forbiddenPaths)
    ) {
      const paths = collectPatchPaths(
        (operation.raw as { patch: SemanticSceneJsonMergePatch }).patch,
      );
      for (const path of paths) {
        if (forbiddenPaths?.has(path)) {
          throw issueAt(operation.index, 'forbidden_path', `Patch path "${path}" is forbidden`, path);
        }
        if (allowedPaths && !pathAllowed(path, allowedPaths)) {
          throw issueAt(operation.index, 'forbidden_path', `Patch path "${path}" is not allowed`, path);
        }
      }
    }
  }
}

/**
 * Families touched by an operation for stage policy: insert draft type,
 * update/delete/move target type, and both sides of family replacement.
 */
function operationFamilies(
  operation: NormalizedOperation,
  document: CurrentSceneDocument,
): readonly StatementFamily[] {
  switch (operation.name) {
    case 'insertStatement':
      return [(operation.raw as { statement: { type: StatementFamily } }).statement.type];
    case 'insertCompanion':
      return [(operation.raw as { companion: { type: StatementFamily } }).companion.type];
    case 'updateStatement': {
      const source = document.statements[operation.resolvedLine!.statementIndex];
      const patchType = (operation.raw as { patch: { type?: StatementFamily } }).patch.type;
      if (patchType !== undefined && patchType !== source.type) {
        return [source.type, patchType];
      }
      return [source.type];
    }
    case 'updateCompanion': {
      const parent = document.statements[operation.resolvedLine!.statementIndex];
      const source = parent.companions![operation.resolvedLine!.companionIndex!];
      const patchType = (operation.raw as { patch: { type?: StatementFamily } }).patch.type;
      if (patchType !== undefined && patchType !== source.type) {
        return [source.type, patchType];
      }
      return [source.type];
    }
    case 'deleteLine':
    case 'moveLine': {
      const resolved = operation.resolvedLine!;
      if (resolved.kind === 'statement') {
        return [document.statements[resolved.statementIndex].type];
      }
      const parent = document.statements[resolved.statementIndex];
      return [parent.companions![resolved.companionIndex!].type];
    }
    default:
      return [];
  }
}

/**
 * Companion families touched by an operation for the stage companion whitelist:
 * companion insert draft type, companion update target (both sides of family
 * replacement), companion delete/move target, and the companions listed by a
 * reorder. Root-only operations (insertStatement, updateStatement, root
 * delete/move) touch no companion family.
 */
function operationCompanionFamilies(
  operation: NormalizedOperation,
  document: CurrentSceneDocument,
): readonly StatementFamily[] {
  switch (operation.name) {
    case 'insertCompanion':
      return [(operation.raw as { companion: { type: StatementFamily } }).companion.type];
    case 'updateCompanion': {
      const parent = document.statements[operation.resolvedLine!.statementIndex];
      const source = parent.companions![operation.resolvedLine!.companionIndex!];
      const patchType = (operation.raw as { patch: { type?: StatementFamily } }).patch.type;
      if (patchType !== undefined && patchType !== source.type) {
        return [source.type, patchType];
      }
      return [source.type];
    }
    case 'deleteLine':
    case 'moveLine': {
      const resolved = operation.resolvedLine!;
      if (resolved.kind === 'statement') return [];
      const parent = document.statements[resolved.statementIndex];
      return [parent.companions![resolved.companionIndex!].type];
    }
    case 'reorderCompanions': {
      const parent = document.statements[operation.resolvedParent!.statementIndex];
      const byId = new Map(
        (parent.companions ?? []).map((companion) => [companion.id, companion] as const),
      );
      const ordered = operation.orderedResolved!.map((resolved) => byId.get(resolved.companionId!)!);
      return ordered.map((companion) => companion.type);
    }
    default:
      return [];
  }
}

function pathAllowed(path: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(path)) return true;
  for (const candidate of allowed) {
    if (path.startsWith(`${candidate}.`) || path.startsWith(`${candidate}[`)) return true;
  }
  return false;
}

function assertNoConflicts(
  operations: readonly NormalizedOperation[],
  document: CurrentSceneDocument,
): void {
  const issues: SemanticScenePatchIssueV1[] = [];
  const fieldWrites: FieldWrite[] = [];
  const deletedTargets = new Map<string, number>();
  const deletedParents = new Map<string, number>();
  const typeReplacements = new Map<string, number>();
  const parentStructural = new Map<string, { insert?: number; delete?: number; reorder?: number }>();

  const recordWrite = (operationIndex: number, targetKey: string, field: string) => {
    fieldWrites.push({ operationIndex, targetKey, field });
  };

  for (const operation of operations) {
    switch (operation.name) {
      case 'updateStatement': {
        const key = targetKey(operation.resolvedLine!);
        const patch = (operation.raw as { patch: SemanticSceneStatementPatchV1 }).patch;
        if (patch.type !== undefined) {
          const source = document.statements[operation.resolvedLine!.statementIndex];
          if (patch.type !== source.type) {
            typeReplacements.set(key, operation.index);
            recordWrite(operation.index, key, 'type');
            recordWrite(operation.index, key, 'params');
          }
        }
        for (const path of collectPatchPaths(patch)) {
          recordWrite(operation.index, key, path);
        }
        break;
      }
      case 'updateCompanion': {
        const key = targetKey(operation.resolvedLine!);
        const patch = (operation.raw as { patch: SemanticSceneCompanionPatchV1 }).patch;
        if (patch.type !== undefined) {
          const parent = document.statements[operation.resolvedLine!.statementIndex];
          const source = parent.companions?.[operation.resolvedLine!.companionIndex!];
          if (source && patch.type !== source.type) {
            typeReplacements.set(key, operation.index);
            recordWrite(operation.index, key, 'type');
            recordWrite(operation.index, key, 'params');
          }
        }
        for (const path of collectPatchPaths(patch)) {
          recordWrite(operation.index, key, path);
        }
        break;
      }
      case 'deleteLine': {
        const resolved = operation.resolvedLine!;
        const key = targetKey(resolved);
        deletedTargets.set(key, operation.index);
        if (resolved.kind === 'statement') {
          deletedParents.set(resolved.statementId, operation.index);
        } else {
          const parentEntry = parentStructural.get(resolved.statementId) ?? {};
          parentEntry.delete = operation.index;
          parentStructural.set(resolved.statementId, parentEntry);
        }
        break;
      }
      case 'moveLine': {
        const key = targetKey(operation.resolvedLine!);
        recordWrite(operation.index, key, 'time');
        break;
      }
      case 'insertCompanion': {
        const parentId = operation.resolvedParent!.statementId;
        const parentEntry = parentStructural.get(parentId) ?? {};
        parentEntry.insert = operation.index;
        parentStructural.set(parentId, parentEntry);
        break;
      }
      case 'reorderCompanions': {
        const parentId = operation.resolvedParent!.statementId;
        const parentEntry = parentStructural.get(parentId) ?? {};
        parentEntry.reorder = operation.index;
        parentStructural.set(parentId, parentEntry);
        break;
      }
      default:
        break;
    }
  }

  // Same leaf (or ancestor/descendant path) written by different operations.
  // Sibling leaves under a shared parent (params.text vs params.durationSeconds) do not conflict.
  const seenFieldWrites: FieldWrite[] = [];
  for (const write of fieldWrites) {
    const conflict = seenFieldWrites.find((previous) =>
      previous.targetKey === write.targetKey
      && previous.operationIndex !== write.operationIndex
      && fieldPathsOverlap(previous.field, write.field),
    );
    if (conflict) {
      issues.push({
        code: 'conflicting_operations',
        message: `Conflicting writes to "${write.field}" on the same target`,
        path: write.field,
        operationIndex: write.operationIndex,
      });
    } else {
      seenFieldWrites.push(write);
    }
  }

  // update/move after delete of same target.
  for (const write of fieldWrites) {
    const deletedAt = deletedTargets.get(write.targetKey);
    if (deletedAt !== undefined) {
      issues.push({
        code: 'conflicting_operations',
        message: 'Cannot update or move a line that is deleted in the same transaction',
        operationIndex: write.operationIndex,
      });
    }
  }

  // Delete parent then touch companion.
  for (const operation of operations) {
    if (
      (operation.name === 'updateCompanion'
        || operation.name === 'moveLine'
        || operation.name === 'deleteLine'
        || operation.name === 'reorderCompanions')
      && operation.resolvedLine?.kind === 'companion'
    ) {
      const parentDeleted = deletedParents.get(operation.resolvedLine.statementId);
      if (parentDeleted !== undefined && parentDeleted !== operation.index) {
        issues.push({
          code: 'conflicting_operations',
          message: 'Cannot touch a companion of a statement deleted in the same transaction',
          operationIndex: operation.index,
          line: operation.resolvedLine.line,
        });
      }
    }
    if (operation.name === 'insertCompanion') {
      const parentDeleted = deletedParents.get(operation.resolvedParent!.statementId);
      if (parentDeleted !== undefined) {
        issues.push({
          code: 'conflicting_operations',
          message: 'Cannot insert a companion on a statement deleted in the same transaction',
          operationIndex: operation.index,
        });
      }
    }
  }

  // Type replacement + old-type field patch (any second write on params leaf of same target).
  for (const [key, replacementIndex] of typeReplacements) {
    const other = fieldWrites.find((write) =>
      write.targetKey === key
      && write.operationIndex !== replacementIndex
      && (write.field === 'params' || write.field.startsWith('params.') || write.field === 'type'),
    );
    if (other) {
      issues.push({
        code: 'conflicting_operations',
        message: 'Type replacement cannot combine with other field patches on the same target',
        operationIndex: other.operationIndex,
      });
    }
  }

  // move + update same effective time field already covered by field write on `time`
  // for moveLine and any patch that includes time (statement updates forbid time).
  // Companion move + update of anchor/offset:
  for (const operation of operations) {
    if (operation.name !== 'moveLine' || operation.resolvedLine?.kind !== 'companion') continue;
    const key = targetKey(operation.resolvedLine);
    const conflicting = fieldWrites.find((write) =>
      write.targetKey === key
      && write.operationIndex !== operation.index
      && (write.field === 'anchor' || write.field === 'offset' || write.field === 'time'),
    );
    if (conflicting) {
      issues.push({
        code: 'conflicting_operations',
        message: 'Companion move conflicts with anchor/offset update on the same line',
        operationIndex: operation.index,
        line: operation.resolvedLine.line,
      });
    }
  }

  // reorder + insert/delete same parent.
  for (const [parentId, entry] of parentStructural) {
    if (entry.reorder !== undefined && (entry.insert !== undefined || entry.delete !== undefined)) {
      issues.push({
        code: 'conflicting_operations',
        message: `reorderCompanions cannot mix with companion insert/delete on parent ${parentId}`,
        operationIndex: entry.reorder,
      });
    }
  }

  if (issues.length > 0) {
    throw new SemanticScenePatchError(issues);
  }
}

function applyInsertStatement(
  document: CurrentSceneDocument,
  operation: NormalizedOperation,
  factory: SceneStatementFactory,
  registry: SceneStatementDefinitionRegistry,
): void {
  const raw = operation.raw as Extract<SemanticSceneOperationV1, { kind?: 'insertStatement' }>;
  const usedIds = new Set(document.statements.map((statement) => statement.id));
  let statement: SceneStatement;
  try {
    statement = factory.createStatement({
      type: raw.statement.type,
      time: raw.time,
      params: raw.statement.params,
      ...(raw.statement.type === 'dialogue' && raw.statement.companions
        ? { companions: raw.statement.companions }
        : {}),
    } as Parameters<SceneStatementFactory['createStatement']>[0], usedIds);
  } catch (error) {
    throw new SemanticScenePatchError([{
      code: 'schema_validation_failed',
      message: error instanceof Error ? error.message : String(error),
      operationIndex: operation.index,
    }]);
  }

  try {
    statement = {
      ...statement,
      params: registry.parseParams(statement.type, statement.params, 'statement.params'),
    } as SceneStatement;
    if (statement.companions) {
      statement = {
        ...statement,
        companions: statement.companions.map((companion, companionIndex) => ({
          ...companion,
          params: registry.parseParams(
            companion.type,
            companion.params,
            `statement.companions[${companionIndex}].params`,
          ),
        })),
      } as SceneStatement;
    }
  } catch (error) {
    throw new SemanticScenePatchError([{
      code: 'schema_validation_failed',
      message: error instanceof Error ? error.message : String(error),
      operationIndex: operation.index,
    }]);
  }

  let insertIndex: number;
  if (operation.resolvedBefore) {
    insertIndex = requireStatementIndex(document, operation.resolvedBefore.statementId, operation.index);
  } else {
    // After all existing roots at the same time (source order), then before later times.
    // Only consider statements that existed in the fixed snapshot or were inserted earlier
    // in this transaction at the same time — source order among equal times.
    let lastSame = -1;
    for (let i = 0; i < document.statements.length; i += 1) {
      if (document.statements[i].time === raw.time) lastSame = i;
    }
    if (lastSame >= 0) {
      insertIndex = lastSame + 1;
    } else {
      const firstLater = document.statements.findIndex((candidate) => candidate.time > raw.time);
      insertIndex = firstLater === -1 ? document.statements.length : firstLater;
    }
  }
  document.statements.splice(insertIndex, 0, statement);
}

function applyInsertCompanion(
  document: CurrentSceneDocument,
  operation: NormalizedOperation,
  factory: SceneStatementFactory,
  registry: SceneStatementDefinitionRegistry,
): void {
  const raw = operation.raw as Extract<SemanticSceneOperationV1, { kind?: 'insertCompanion' }>;
  const parentIndex = requireStatementIndex(
    document,
    operation.resolvedParent!.statementId,
    operation.index,
  );
  const parent = document.statements[parentIndex];
  if (parent.type !== 'dialogue') {
    throw issueAt(operation.index, 'wrong_line_kind', 'parentLine must address a dialogue root');
  }

  const usedStatementIds = new Set(document.statements.map((statement) => statement.id));
  const usedCompanionIds = new Set((parent.companions ?? []).map((companion) => companion.id));
  let materialized: DialogueCompanion;
  try {
    const shell = factory.createStatement({
      type: 'dialogue',
      time: 0,
      params: { text: '_', durationSeconds: 0.1 },
      companions: [raw.companion as DialogueCompanion],
    }, usedStatementIds);
    materialized = shell.companions![0];
    if (usedCompanionIds.has(materialized.id)) {
      throw new Error(`Duplicate companion id "${materialized.id}"`);
    }
    materialized = {
      ...materialized,
      params: registry.parseParams(materialized.type, materialized.params, 'companion.params'),
    } as DialogueCompanion;
  } catch (error) {
    throw new SemanticScenePatchError([{
      code: 'schema_validation_failed',
      message: error instanceof Error ? error.message : String(error),
      operationIndex: operation.index,
    }]);
  }

  const companions = [...(parent.companions ?? [])];
  if (operation.resolvedBefore) {
    const beforeIndex = companions.findIndex(
      (companion) => companion.id === operation.resolvedBefore!.companionId,
    );
    if (beforeIndex < 0) {
      throw issueAt(operation.index, 'stale_line_map', 'beforeLine companion is missing');
    }
    companions.splice(beforeIndex, 0, materialized);
  } else {
    companions.push(materialized);
  }
  document.statements[parentIndex] = { ...parent, companions } as SceneStatement;
}

function applyUpdateStatement(
  document: CurrentSceneDocument,
  operation: NormalizedOperation,
  registry: SceneStatementDefinitionRegistry,
): boolean {
  const raw = operation.raw as Extract<SemanticSceneOperationV1, { kind?: 'updateStatement' }>;
  const index = requireStatementIndex(document, operation.resolvedLine!.statementId, operation.index);
  const source = document.statements[index];
  const patch = raw.patch;
  const isReplacement = patch.type !== undefined && patch.type !== source.type;

  if (isReplacement) {
    if (patch.params === undefined || patch.params === null || !isRecord(patch.params)) {
      throw issueAt(
        operation.index,
        'invalid_arguments',
        'Family replacement requires complete params',
        'patch.params',
      );
    }
    const nextType = patch.type as StatementFamily;
    let params: SceneStatement['params'];
    try {
      params = registry.parseParams(
        nextType,
        normalizePerformanceParamsInput(nextType, patch.params),
        'patch.params',
      ) as SceneStatement['params'];
    } catch (error) {
      throw new SemanticScenePatchError([{
        code: 'schema_validation_failed',
        message: error instanceof Error ? error.message : String(error),
        operationIndex: operation.index,
      }]);
    }
    document.statements[index] = {
      id: source.id,
      time: source.time,
      type: nextType,
      params,
    } as SceneStatement;
    return true;
  }

  const mergeTarget: Record<string, unknown> = {
    type: source.type,
    params: cloneJson(source.params),
  };
  const merged = jsonMergePatch(mergeTarget, patch) as {
    type: StatementFamily;
    params: unknown;
  };
  let params: SceneStatement['params'];
  try {
    params = registry.parseParams(
      source.type,
      normalizePerformanceParamsInput(source.type, merged.params),
      'patch.params',
    ) as SceneStatement['params'];
  } catch (error) {
    throw new SemanticScenePatchError([{
      code: 'schema_validation_failed',
      message: error instanceof Error ? error.message : String(error),
      operationIndex: operation.index,
    }]);
  }
  document.statements[index] = {
    ...source,
    type: source.type,
    params,
    ...(source.companions ? { companions: source.companions } : {}),
  } as SceneStatement;
  return false;
}

function applyUpdateCompanion(
  document: CurrentSceneDocument,
  operation: NormalizedOperation,
  registry: SceneStatementDefinitionRegistry,
): void {
  const raw = operation.raw as Extract<SemanticSceneOperationV1, { kind?: 'updateCompanion' }>;
  const parentIndex = requireStatementIndex(
    document,
    operation.resolvedLine!.statementId,
    operation.index,
  );
  const parent = document.statements[parentIndex];
  const companionIndex = (parent.companions ?? []).findIndex(
    (companion) => companion.id === operation.resolvedLine!.companionId,
  );
  if (companionIndex < 0) {
    throw issueAt(operation.index, 'stale_line_map', 'Companion target is missing', 'line', operation.resolvedLine!.line);
  }
  const source = parent.companions![companionIndex];
  const patch = raw.patch;
  const isReplacement = patch.type !== undefined && patch.type !== source.type;

  let next: DialogueCompanion;
  if (isReplacement) {
    if (patch.params === undefined || patch.params === null || !isRecord(patch.params)) {
      throw issueAt(
        operation.index,
        'invalid_arguments',
        'Family replacement requires complete params',
        'patch.params',
      );
    }
    const nextType = patch.type as StatementFamily;
    const anchor = patch.anchor ?? source.anchor;
    const offset = patch.offset ?? source.offset;
    let params: DialogueCompanion['params'];
    try {
      params = registry.parseParams(
        nextType,
        normalizePerformanceParamsInput(nextType, patch.params),
        'patch.params',
      ) as DialogueCompanion['params'];
    } catch (error) {
      throw new SemanticScenePatchError([{
        code: 'schema_validation_failed',
        message: error instanceof Error ? error.message : String(error),
        operationIndex: operation.index,
      }]);
    }
    next = {
      id: source.id,
      anchor,
      offset,
      type: nextType,
      params,
    } as DialogueCompanion;
  } else {
    const mergeTarget: Record<string, unknown> = {
      anchor: source.anchor,
      offset: source.offset,
      type: source.type,
      params: cloneJson(source.params),
    };
    const merged = jsonMergePatch(mergeTarget, patch) as {
      anchor: 'start' | 'end';
      offset: number;
      type: StatementFamily;
      params: unknown;
    };
    if (merged.anchor !== 'start' && merged.anchor !== 'end') {
      throw issueAt(operation.index, 'invalid_arguments', 'Companion anchor must be start|end', 'patch.anchor');
    }
    if (typeof merged.offset !== 'number' || !Number.isFinite(merged.offset)) {
      throw issueAt(operation.index, 'invalid_arguments', 'Companion offset must be finite', 'patch.offset');
    }
    let params: DialogueCompanion['params'];
    try {
      params = registry.parseParams(
        source.type,
        normalizePerformanceParamsInput(source.type, merged.params),
        'patch.params',
      ) as DialogueCompanion['params'];
    } catch (error) {
      throw new SemanticScenePatchError([{
        code: 'schema_validation_failed',
        message: error instanceof Error ? error.message : String(error),
        operationIndex: operation.index,
      }]);
    }
    next = {
      id: source.id,
      anchor: merged.anchor,
      offset: merged.offset,
      type: source.type,
      params,
    } as DialogueCompanion;
  }

  const companions = parent.companions!.map((companion, index) =>
    index === companionIndex ? next : companion,
  );
  document.statements[parentIndex] = { ...parent, companions } as SceneStatement;
}

function applyDeleteLine(document: CurrentSceneDocument, operation: NormalizedOperation): void {
  const resolved = operation.resolvedLine!;
  if (resolved.kind === 'statement') {
    const index = requireStatementIndex(document, resolved.statementId, operation.index);
    document.statements.splice(index, 1);
    return;
  }
  const parentIndex = requireStatementIndex(document, resolved.statementId, operation.index);
  const parent = document.statements[parentIndex];
  const companions = [...(parent.companions ?? [])].filter(
    (companion) => companion.id !== resolved.companionId,
  );
  const next = { ...parent } as SceneStatement;
  if (companions.length > 0) {
    next.companions = companions;
  } else {
    delete (next as { companions?: unknown }).companions;
  }
  document.statements[parentIndex] = next;
}

function applyRootMove(document: CurrentSceneDocument, operation: NormalizedOperation): void {
  const raw = operation.raw as Extract<SemanticSceneOperationV1, { kind?: 'moveLine' }>;
  const index = requireStatementIndex(document, operation.resolvedLine!.statementId, operation.index);
  const source = document.statements[index];
  document.statements[index] = { ...source, time: raw.time } as SceneStatement;
}

function applyCompanionMove(
  document: CurrentSceneDocument,
  operation: NormalizedOperation,
  registry: SceneStatementDefinitionRegistry,
): void {
  const raw = operation.raw as Extract<SemanticSceneOperationV1, { kind?: 'moveLine' }>;
  const parentIndex = requireStatementIndex(
    document,
    operation.resolvedLine!.statementId,
    operation.index,
  );
  const parent = document.statements[parentIndex];
  const companionIndex = (parent.companions ?? []).findIndex(
    (companion) => companion.id === operation.resolvedLine!.companionId,
  );
  if (companionIndex < 0) {
    throw issueAt(operation.index, 'stale_line_map', 'Companion target is missing', 'line', operation.resolvedLine!.line);
  }
  const companion = parent.companions![companionIndex];
  const baseTime = parent.time
    + (companion.anchor === 'end' ? registry.temporalExtent(parent) : 0);
  const offset = roundTime(raw.time - baseTime);
  const nextCompanion = { ...companion, offset } as DialogueCompanion;
  const companions = parent.companions!.map((candidate, index) =>
    index === companionIndex ? nextCompanion : candidate,
  );
  document.statements[parentIndex] = { ...parent, companions } as SceneStatement;
}

function applyReorderCompanions(
  document: CurrentSceneDocument,
  operation: NormalizedOperation,
): void {
  const parentIndex = requireStatementIndex(
    document,
    operation.resolvedParent!.statementId,
    operation.index,
  );
  const parent = document.statements[parentIndex];
  const byId = new Map((parent.companions ?? []).map((companion) => [companion.id, companion]));
  const reordered = operation.orderedResolved!.map((resolved) => byId.get(resolved.companionId!)!);
  document.statements[parentIndex] = { ...parent, companions: reordered } as SceneStatement;
}

function requireStatementIndex(
  document: CurrentSceneDocument,
  statementId: string,
  operationIndex: number,
): number {
  const index = document.statements.findIndex((statement) => statement.id === statementId);
  if (index < 0) {
    throw issueAt(operationIndex, 'stale_line_map', `Statement "${statementId}" is missing`);
  }
  return index;
}

function jsonMergePatch(target: unknown, patch: SemanticSceneJsonMergePatch): unknown {
  if (!isRecord(patch)) return patch;
  const result: Record<string, unknown> = isRecord(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    if (isRecord(value) && !Array.isArray(value)) {
      const current = result[key];
      result[key] = jsonMergePatch(
        isRecord(current) && !Array.isArray(current) ? current : {},
        value as SemanticSceneJsonMergePatch,
      );
      continue;
    }
    // Arrays and scalars replace atomically.
    result[key] = cloneJson(value as SemanticSceneJsonMergePatchValue);
  }
  return result;
}

/**
 * Collect write paths for stage policy and conflict detection.
 * Only leaf writes are recorded so sibling leaves under the same parent
 * (e.g. `params.text` vs `params.durationSeconds`) can merge without false
 * conflicts on the parent path.
 */
function collectPatchPaths(
  patch: SemanticSceneJsonMergePatch,
  prefix = '',
): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value) && value !== null) {
      const nested = collectPatchPaths(value as SemanticSceneJsonMergePatch, path);
      if (nested.length > 0) {
        paths.push(...nested);
        continue;
      }
    }
    // Scalars, arrays, null, and empty objects are leaf writes.
    paths.push(path);
  }
  return paths;
}

function fieldPathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

function operationName(operation: SemanticSceneOperationV1): SemanticSceneOperationNameV1 {
  return (operation.kind ?? operation.op ?? operation.operation)!;
}

function requireResolved(
  lineView: SemanticSceneLineView,
  line: number,
  operationIndex: number,
  path: string,
): SemanticSceneResolvedLine {
  const resolved = lineView.resolveInternal(line);
  if (!resolved) {
    throw issueAt(
      operationIndex,
      'stale_line_map',
      `Line ${line} is not present in the fixed snapshot`,
      path,
      line,
    );
  }
  return resolved;
}

function targetKey(resolved: SemanticSceneResolvedLine): string {
  return resolved.kind === 'statement'
    ? `statement:${resolved.statementId}`
    : `companion:${resolved.statementId}/${resolved.companionId}`;
}

function companionCount(document: CurrentSceneDocument, statementId: string): number {
  return document.statements.find((statement) => statement.id === statementId)?.companions?.length ?? 0;
}

/**
 * First existing source-order line that will shift when the statement is
 * inserted without beforeLine (after last same-time root, else before first
 * later-time root). When insertion is truly at end, returns totalLines + 1
 * so all old lines remain valid.
 */
function resolveInsertStatementInvalidationLine(
  operation: NormalizedOperation,
  lineView: SemanticSceneLineView,
  document: CurrentSceneDocument,
): number {
  if (operation.resolvedBefore) return operation.resolvedBefore.line;

  const raw = operation.raw as Extract<SemanticSceneOperationV1, { time: number; statement: unknown }>;
  const statements = document.statements;

  let lastSameIndex = -1;
  for (let i = 0; i < statements.length; i += 1) {
    if (statements[i].time === raw.time) lastSameIndex = i;
  }

  let insertIndex: number;
  if (lastSameIndex >= 0) {
    insertIndex = lastSameIndex + 1;
  } else {
    const firstLater = statements.findIndex((candidate) => candidate.time > raw.time);
    insertIndex = firstLater === -1 ? statements.length : firstLater;
  }

  if (insertIndex >= statements.length) {
    return lineView.totalLines + 1;
  }

  const shiftedStatementId = statements[insertIndex].id;
  const shifted = lineView.internalLines().find(
    (resolved) => resolved.kind === 'statement' && resolved.statementId === shiftedStatementId,
  );
  return shifted?.line ?? lineView.totalLines + 1;
}

function emptyLineMap(totalLines: number): SemanticSceneLineMapStateV1 {
  return {
    validThroughLine: totalLines,
    refreshRequired: false,
    reason: 'none',
  };
}

function structuralInvalidation(
  reason: SemanticSceneLineMapInvalidationReasonV1,
  fromLine: number,
  totalLines: number,
): SemanticSceneLineMapStateV1 {
  const validThroughLine = Math.max(0, Math.min(totalLines, fromLine - 1));
  return {
    validThroughLine,
    refreshRequired: true,
    invalidatedFromLine: Math.max(1, fromLine),
    reason,
  };
}

function mergeLineMap(
  current: SemanticSceneLineMapStateV1,
  next: SemanticSceneLineMapStateV1,
): SemanticSceneLineMapStateV1 {
  if (!next.refreshRequired) return current;
  if (!current.refreshRequired) return next;
  const validThroughLine = Math.min(current.validThroughLine, next.validThroughLine);
  const invalidatedFromLine = Math.min(
    current.invalidatedFromLine ?? Number.POSITIVE_INFINITY,
    next.invalidatedFromLine ?? Number.POSITIVE_INFINITY,
  );
  const reasonPriority: Record<SemanticSceneLineMapInvalidationReasonV1, number> = {
    none: 0,
    insert: 1,
    delete: 2,
    reorder: 3,
    'family-replacement': 4,
  };
  const reason = reasonPriority[current.reason] >= reasonPriority[next.reason]
    ? current.reason
    : next.reason;
  return {
    validThroughLine,
    refreshRequired: true,
    invalidatedFromLine: Number.isFinite(invalidatedFromLine) ? invalidatedFromLine : undefined,
    reason,
  };
}

function createMutableCounts(): {
  -readonly [K in keyof SemanticScenePatchCountsV1]: number;
} {
  return {
    insertedStatements: 0,
    insertedCompanions: 0,
    updatedStatements: 0,
    updatedCompanions: 0,
    deletedLines: 0,
    movedLines: 0,
    reorderedCompanionGroups: 0,
    inserted: 0,
    updated: 0,
    deleted: 0,
    moved: 0,
  };
}

function freezeCounts(counts: SemanticScenePatchCountsV1): SemanticScenePatchCountsV1 {
  return Object.freeze({ ...counts });
}

function expectPositiveLine(value: unknown, index: number, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw issueAt(index, 'invalid_arguments', `Expected positive integer line at ${path}`, path);
  }
  return value;
}

function expectPositiveLineArray(value: unknown, index: number, path: string): number[] {
  if (!Array.isArray(value)) {
    throw issueAt(index, 'invalid_arguments', `Expected line array at ${path}`, path);
  }
  return value.map((item, itemIndex) =>
    expectPositiveLine(item, index, `${path}[${itemIndex}]`),
  );
}

function expectNonNegativeFinite(value: unknown, index: number, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw issueAt(index, 'invalid_arguments', `Expected non-negative finite number at ${path}`, path);
  }
  return value;
}

function expectFiniteNumber(value: unknown, index: number, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw issueAt(index, 'invalid_arguments', `Expected finite number at ${path}`, path);
  }
  return value;
}

function expectFamilyName(value: unknown, index: number, path: string): StatementFamily {
  if (typeof value !== 'string' || !sceneStatementDefinitionRegistry.has(value)) {
    throw issueAt(index, 'invalid_arguments', `Unknown statement family at ${path}`, path);
  }
  return value;
}

function expectMergePatch(
  value: unknown,
  index: number,
  path: string,
): SemanticSceneJsonMergePatch {
  if (!isRecord(value) || Array.isArray(value)) {
    throw issueAt(index, 'invalid_arguments', `Expected merge patch object at ${path}`, path);
  }
  return value as SemanticSceneJsonMergePatch;
}

function assertNonEmptyPatch(
  patch: SemanticSceneJsonMergePatch,
  index: number,
  path: string,
): void {
  if (Object.keys(patch).length === 0) {
    throw issueAt(index, 'invalid_arguments', 'Empty patch is not allowed; use empty operations', path);
  }
}

function issueAt(
  operationIndex: number,
  code: SemanticScenePatchErrorCodeV1,
  message: string,
  path?: string,
  line?: number,
): never {
  throw new SemanticScenePatchError([{
    code,
    message,
    operationIndex,
    ...(path ? { path } : {}),
    ...(line !== undefined ? { line } : {}),
  }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

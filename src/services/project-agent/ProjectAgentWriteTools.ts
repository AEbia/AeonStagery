import type {
  AgentApplyAuthoringTransactionArgs,
  AgentDeleteSourceItemArgs,
  AgentInsertCompanionArgs,
  AgentInsertStatementArgs,
  AgentMoveSourceItemArgs,
  AgentReorderCompanionsArgs,
  AgentSourceAuthoringOperation,
  AgentToolDiagnostic,
  AgentToolError,
  AgentToolErrorCode,
  AgentToolResult,
  AgentUpdateCompanionArgs,
  AgentUpdateStatementArgs,
  AgentValidateSceneDiagnostic,
  AgentWriteOutcome,
  AgentWriteReceipt,
  ProjectAgentHostChangedObject,
  ProjectAgentHostWriteReceipt,
  ProjectAgentToolResultByName,
} from '../../api/types/project-agent';
import {
  SEMANTIC_SCENE_PATCH_VERSION,
  type SemanticSceneCompanionPatchV1,
  type SemanticSceneInsertedIdentityV1,
  type SemanticSceneOperationV1,
  type SemanticScenePatchCountsV1,
  type SemanticScenePatchIssueV1,
  type SemanticSceneStatementPatchV1,
} from '../../api/types/semantic-scene-patch';
import type { DialogueCompanion, CurrentSceneDocument, SceneStatement } from '../../api/types/semantic-scene';
import {
  applySemanticScenePatch,
  isSemanticScenePatchError,
  parseSemanticScenePatch,
  SemanticScenePatchError,
} from '../semantic-scene/SemanticScenePatch';
import { sceneStatementDefinitionRegistry } from '../semantic-scene/SceneStatementDefinitionRegistry';
import { SemanticSceneLineView } from '../semantic-scene/SemanticSceneLineView';
import { ProjectAgentSourceIdentityFacade } from './ProjectAgentSourceIdentity';
import type { ProjectAgentWritePorts } from './ProjectAgentPorts';
import { toolFail, toolOk } from './ProjectAgentPathRules';
import type { ProjectAgentTaskState } from './ProjectAgentTaskState';
import type { SemanticAuthoringGateError } from '../timeline-authoring/SemanticAuthoringApplicationService';

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

export interface ProjectAgentWriteToolsOptions {
  readonly ports: ProjectAgentWritePorts;
  readonly taskState: ProjectAgentTaskState;
}

/**
 * Host cancellation of a write before the authoritative-commit boundary
 * (ADR0023): preflight and the mutation-queue wait are cancellable; a write
 * that already started its authoritative commit settles atomically instead.
 */
export class ProjectAgentWriteCancelledError extends Error {
  readonly code = 'write_cancelled' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ProjectAgentWriteCancelledError';
  }
}

export function isWriteCancelledError(error: unknown): error is ProjectAgentWriteCancelledError {
  return error instanceof ProjectAgentWriteCancelledError;
}

function writeCancelledResult(): AgentToolResult<never> {
  return toolFail({
    code: 'cancelled',
    message: 'Write cancelled by the host before the authoritative commit',
    retryable: false,
  });
}

export class ProjectAgentWriteTools {
  private readonly ports: ProjectAgentWritePorts;
  private readonly taskState: ProjectAgentTaskState;
  private lastHostReceipt: ProjectAgentHostWriteReceipt | null = null;

  constructor(options: ProjectAgentWriteToolsOptions) {
    this.ports = options.ports;
    this.taskState = options.taskState;
  }

  takeLastHostReceipt(): ProjectAgentHostWriteReceipt | null {
    const receipt = this.lastHostReceipt;
    this.lastHostReceipt = null;
    return receipt;
  }

  insertStatement(
    args: AgentInsertStatementArgs,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['insertStatement']>> {
    return this.runSourceSingle('insertStatement', args, {
      kind: 'insertStatement',
      time: args.time,
      statement: args.statement,
      ...(args.beforeStatementId !== undefined ? { beforeStatementId: args.beforeStatementId } : {}),
    }, signal);
  }

  insertCompanion(
    args: AgentInsertCompanionArgs,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['insertCompanion']>> {
    return this.runSourceSingle('insertCompanion', args, {
      kind: 'insertCompanion', statementId: args.statementId, companion: args.companion,
      ...(args.beforeCompanionId !== undefined ? { beforeCompanionId: args.beforeCompanionId } : {}),
    }, signal);
  }

  updateStatement(
    args: AgentUpdateStatementArgs,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['updateStatement']>> {
    return this.runSourceSingle('updateStatement', args, {
      kind: 'updateStatement',
      statementId: args.statementId,
      patch: args.patch,
    }, signal);
  }

  updateCompanion(
    args: AgentUpdateCompanionArgs,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['updateCompanion']>> {
    return this.runSourceSingle('updateCompanion', args, {
      kind: 'updateCompanion', statementId: args.statementId, companionId: args.companionId, patch: args.patch,
    }, signal);
  }

  deleteSourceItem(
    args: AgentDeleteSourceItemArgs,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['deleteSourceItem']>> {
    return this.runSourceSingle('deleteSourceItem', args, {
      kind: 'deleteSourceItem',
      statementId: args.statementId,
      ...(args.companionId !== undefined ? { companionId: args.companionId } : {}),
    }, signal);
  }

  moveSourceItem(
    args: AgentMoveSourceItemArgs,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['moveSourceItem']>> {
    return this.runSourceSingle('moveSourceItem', args, {
      kind: 'moveSourceItem',
      statementId: args.statementId,
      ...(args.time !== undefined ? { time: args.time } : {}),
      ...(args.companionId !== undefined ? { companionId: args.companionId } : {}),
      ...(args.anchor !== undefined ? { anchor: args.anchor } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
    } as never, signal);
  }

  reorderCompanions(
    args: AgentReorderCompanionsArgs,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['reorderCompanions']>> {
    return this.runSourceSingle('reorderCompanions', args, {
      kind: 'reorderCompanions', statementId: args.statementId, orderedCompanionIds: args.orderedCompanionIds,
    }, signal);
  }

  async applyAuthoringTransaction(
    args: AgentApplyAuthoringTransactionArgs,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['applyAuthoringTransaction']>> {
    if (!args || typeof args !== 'object') {
      return toolFail(invalidArgs('applyAuthoringTransaction requires a versioned operations envelope'));
    }
    if (args.version !== SEMANTIC_SCENE_PATCH_VERSION && args.version !== 1) {
      return toolFail(invalidArgs(`Unsupported patch version: ${String(args.version)}`));
    }
    if (!Array.isArray(args.operations)) {
      return toolFail(invalidArgs('operations must be an array'));
    }

    // Empty operations: ok true / no_change — no mutation, history, or version bump.
    if (args.operations.length === 0) {
      this.lastHostReceipt = null;
      return toolOk({
        status: 'no_change',
        counts: EMPTY_COUNTS,
        warnings: [],
        outcomes: [],
      });
    }

    return this.commitSourceOperations(args.operations, signal);
  }

  private async runSourceSingle(
    name: string,
    args: unknown,
    operation: AgentApplyAuthoringTransactionArgs['operations'][number],
    signal?: AbortSignal,
  ): Promise<AgentToolResult<AgentWriteReceipt>> {
    if (!args || typeof args !== 'object') {
      return toolFail(invalidArgs(`${name} requires operation arguments`));
    }
    return this.commitSourceOperations([operation], signal);
  }

  private async commitSourceOperations(
    operations: readonly AgentApplyAuthoringTransactionArgs['operations'][number][],
    signal?: AbortSignal,
  ): Promise<AgentToolResult<AgentWriteReceipt>> {
    // No host receipt exists unless commitOperations actually commits.
    this.lastHostReceipt = null;
    if (signal?.aborted) return writeCancelledResult();
    const binding = this.taskState.getSceneBinding();
    if (!binding) {
      return toolFail({
        code: 'scene_not_read',
        message: 'A successful scene read is required before writes',
        retryable: true,
        suggestedAction: 'reread_scene',
      });
    }

    const resolved = new ProjectAgentSourceIdentityFacade(binding.document)
      .resolveRootOperations(operations);
    if (!resolved.ok) {
      return toolFail({
        code: resolved.diagnostic.code === 'source_identity_not_found'
          ? 'source_identity_not_found'
          : resolved.diagnostic.code === 'wrong_source_kind'
            ? 'wrong_source_kind'
            : 'invalid_arguments',
        message: resolved.diagnostic.message,
        retryable: resolved.diagnostic.code === 'source_identity_not_found',
        ...(resolved.diagnostic.code === 'source_identity_not_found'
          ? { suggestedAction: 'call_readScene' as const }
          : { suggestedAction: 'fix_arguments' as const }),
        diagnostics: [resolved.diagnostic],
      });
    }
    return this.commitOperations(resolved.operations, signal, operations);
  }

  private async commitOperations(
    operations: readonly SemanticSceneOperationV1[],
    signal?: AbortSignal,
    sourceOperations?: readonly AgentSourceAuthoringOperation[],
  ): Promise<AgentToolResult<AgentWriteReceipt>> {
    this.lastHostReceipt = null;
    if (signal?.aborted) {
      return writeCancelledResult();
    }
    const binding = this.taskState.getSceneBinding();
    if (!binding) {
      return toolFail({
        code: 'scene_not_read',
        message: 'A successful scene read is required before writes',
        retryable: true,
        suggestedAction: 'reread_scene',
      });
    }

    let parsed;
    try {
      parsed = parseSemanticScenePatch({
        version: SEMANTIC_SCENE_PATCH_VERSION,
        operations,
      });
    } catch (error) {
      return toolFail(mapPatchError(error));
    }

    let applyResult;
    try {
      // Candidate codec gate is delegated to the injected validation port
      // (schema/semantic/compiler/resource). Keep patch algebra pure here.
      applyResult = applySemanticScenePatch(binding.document, parsed, {
        validateCandidate: false,
      });
    } catch (error) {
      return toolFail(mapPatchError(error));
    }

    const facts = buildOutcomeFacts(
      // Sole caller passes the resolved source operations; an empty list
      // would make the all-no-op guard below vacuously true, so this must
      // never be called without them.
      sourceOperations ?? [],
      binding.document,
      applyResult.candidate,
      applyResult.insertedIdentities,
    );
    const patchWarnings = mapWarnings(applyResult.warnings);
    if (facts.outcomes.every((outcome) => outcome.kind === 'no_change')) {
      // All-no-op transaction: no history entry, no version bump, and the
      // honest counts are zero because nothing actually changed (ADR0024).
      return toolOk({
        status: 'no_change',
        counts: EMPTY_COUNTS,
        warnings: patchWarnings,
        outcomes: facts.outcomes,
      });
    }

    // Gate ordering: schema/semantic/compiler/resource via injected validation port.
    const diagnostics = await this.ports.validation.validate(applyResult.candidate);
    // The preflight phase is cancellable (ADR0023): the host may abort the
    // write while the optimistic gate runs, before any durable pending record.
    if (signal?.aborted) {
      return writeCancelledResult();
    }
    const hardErrors = diagnostics.filter((item) => item.severity === 'error');
    if (hardErrors.length > 0) {
      const gate = hardErrors[0]?.gate ?? 'semantic';
      const code = gateErrorCode(gate);
      return toolFail({
        code,
        message: hardErrors[0]?.message ?? 'Validation failed',
        retryable: false,
        diagnostics: hardErrors.map((item) => ({
          code: item.code,
          message: item.message,
          severity: item.severity,
          ...(item.path !== undefined ? { path: item.path } : {}),
          ...(item.source !== undefined ? { source: item.source } : {}),
        })),
      });
    }
    const warnings = [
      ...patchWarnings,
      ...diagnostics.filter((item) => item.severity === 'warning').map(mapValidationWarning),
    ];

    const resolvedOperationLocators = resolveOperationLocatorNotes(binding.document, parsed.operations);
    let commit;
    try {
      commit = await this.ports.authoring.commit({
        baseVersion: binding.version,
        baseDocument: binding.document,
        candidate: applyResult.candidate,
        // Host-private write-ahead facts (ADR0023): resolved internal locators
        // never enter params/receipts/diagnostics/model context, only the
        // durable pending record; fingerprints are opaque, never replayed.
        resolvedOperationsNotes: JSON.stringify(resolvedOperationLocators),
        opsFingerprint: stableFingerprint({
          version: SEMANTIC_SCENE_PATCH_VERSION,
          locators: resolvedOperationLocators,
        }),
        expectedChangeFingerprint: stableFingerprint(applyResult.candidate),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (isWriteCancelledError(error)) {
        return writeCancelledResult();
      }
      if (isVersionConflict(error)) {
        return toolFail({
          code: 'version_conflict',
          message: error instanceof Error ? error.message : 'Document version conflict',
          retryable: true,
          suggestedAction: 'reread_scene',
        });
      }
      if (isAuthoringGateError(error)) {
        const primary = error.diagnostics[0];
        return toolFail({
          code: primary?.gate ? gateErrorCode(primary.gate) : 'semantic_validation_failed',
          message: primary?.message ?? 'Authoring gate rejected the candidate',
          retryable: false,
          diagnostics: error.diagnostics.map((item) => ({
            code: item.code,
            message: item.message,
            severity: item.severity,
            ...(item.path !== undefined ? { path: item.path } : {}),
            ...(item.source !== undefined ? { source: item.source } : {}),
          })),
        });
      }
      if (isHostPersistError(error)) {
        return toolFail({
          code: 'journal_persist_failed',
          message: error instanceof Error ? error.message : 'Failed to persist the durable pending transaction',
          retryable: true,
          suggestedAction: 'reread_scene',
        });
      }
      return toolFail({
        code: 'semantic_validation_failed',
        message: error instanceof Error ? error.message : 'Authoring commit failed',
        retryable: false,
      });
    }

    if (commit.version === binding.version) {
      // Defensive: commit must bump version on change.
      return toolFail({
        code: 'version_conflict',
        message: 'Authoring commit did not advance document version',
        retryable: true,
        suggestedAction: 'reread_scene',
      });
    }

    this.taskState.advanceAfterContentWrite(applyResult.candidate, commit.version);
    this.lastHostReceipt = {
      status: 'committed',
      version: commit.version,
      counts: facts.counts,
      warnings,
      outcomes: facts.outcomes,
      changedObjects: facts.changedObjects,
      ...(facts.timeRange ? { timeRange: facts.timeRange } : {}),
    };

    return toolOk({
      status: 'committed',
      counts: facts.counts,
      warnings,
      outcomes: facts.outcomes,
    });
  }
}

function mapValidationWarning(item: AgentValidateSceneDiagnostic): AgentToolDiagnostic {
  return {
    ...(item.code !== undefined ? { code: item.code } : {}),
    message: item.message,
    severity: 'warning',
    ...(item.path !== undefined ? { path: item.path } : {}),
    ...(item.source !== undefined ? { source: item.source } : {}),
  };
}

interface ProjectAgentOutcomeFacts {
  readonly outcomes: readonly AgentWriteOutcome[];
  readonly changedObjects: readonly ProjectAgentHostChangedObject[];
  /** Actual change counts derived from changedObjects, not patch-op counts. */
  readonly counts: SemanticScenePatchCountsV1;
  readonly timeRange?: { readonly start: number; readonly end: number };
}

function buildOutcomeFacts(
  operations: readonly AgentSourceAuthoringOperation[],
  before: CurrentSceneDocument,
  candidate: CurrentSceneDocument,
  insertedIdentities: readonly SemanticSceneInsertedIdentityV1[],
): ProjectAgentOutcomeFacts {
  // Generated identities are tagged with their source operation index, so a
  // mixed transaction pairs each insert op with exactly its own objects —
  // never by candidate order and never by kind-filtered positions.
  const identitiesByOperation = new Map<number, SemanticSceneInsertedIdentityV1[]>();
  for (const identity of insertedIdentities) {
    const list = identitiesByOperation.get(identity.operationIndex) ?? [];
    list.push(identity);
    identitiesByOperation.set(identity.operationIndex, list);
  }

  const outcomes: AgentWriteOutcome[] = [];
  const changedObjects: ProjectAgentHostChangedObject[] = [];
  const affectedTimes: number[] = [];

  const pushChanged = (changed: ProjectAgentHostChangedObject, times: readonly number[]): void => {
    changedObjects.push(changed);
    affectedTimes.push(...times);
  };

  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    const operation = operations[operationIndex]!;
    switch (operation.kind) {
      case 'insertStatement': {
        const identities = identitiesByOperation.get(operationIndex) ?? [];
        const statementIdentity = identities.find((identity) => identity.companionId === undefined);
        if (!statementIdentity) {
          outcomes.push({ kind: 'no_change' });
          break;
        }
        const companionIds = identities
          .filter((identity) => identity.companionId !== undefined)
          .map((identity) => identity.companionId!);
        outcomes.push({
          kind: 'inserted',
          statementId: statementIdentity.statementId,
          ...(companionIds.length > 0 ? { insertedCompanionIds: companionIds } : {}),
        });
        pushChanged(
          { statementId: statementIdentity.statementId, kind: 'inserted' },
          [objectEffectiveTime(candidate, statementIdentity.statementId)],
        );
        for (const companionId of companionIds) {
          pushChanged(
            { statementId: statementIdentity.statementId, companionId, kind: 'inserted' },
            [objectEffectiveTime(candidate, statementIdentity.statementId, companionId)],
          );
        }
        break;
      }
      case 'insertCompanion': {
        const identities = identitiesByOperation.get(operationIndex) ?? [];
        const companionIdentity = identities.find((identity) => identity.companionId !== undefined);
        if (!companionIdentity) {
          outcomes.push({ kind: 'no_change' });
          break;
        }
        outcomes.push({
          kind: 'inserted',
          statementId: companionIdentity.statementId,
          companionId: companionIdentity.companionId,
        });
        pushChanged(
          {
            statementId: companionIdentity.statementId,
            companionId: companionIdentity.companionId,
            kind: 'inserted',
          },
          [
            objectEffectiveTime(
              candidate,
              companionIdentity.statementId,
              companionIdentity.companionId,
            ),
          ],
        );
        break;
      }
      case 'updateStatement': {
        const original = before.statements.find((statement) => statement.id === operation.statementId);
        const updated = candidate.statements.find((statement) => statement.id === operation.statementId);
        if (!original || !updated || sameJson(original, updated)) {
          outcomes.push({ kind: 'no_change' });
          break;
        }
        const deletedCompanions = (original.companions ?? [])
          .filter((companion) => !(updated.companions ?? []).some((next) => next.id === companion.id))
          .map((companion) => ({ statementId: operation.statementId, companionId: companion.id }));
        const normalized = normalizedStatementPatch(operation.patch, updated);
        outcomes.push({
          kind: 'updated',
          ...(deletedCompanions.length > 0 ? { deletedCompanions } : {}),
          ...(normalized ? { normalized } : {}),
        });
        pushChanged(
          { statementId: operation.statementId, kind: 'updated' },
          [
            objectEffectiveTime(before, operation.statementId),
            objectEffectiveTime(candidate, operation.statementId),
          ],
        );
        for (const companion of deletedCompanions) {
          pushChanged(
            { ...companion, kind: 'deleted' },
            [objectEffectiveTime(before, companion.statementId, companion.companionId)],
          );
        }
        break;
      }
      case 'updateCompanion': {
        const original = findCompanion(before, operation.statementId, operation.companionId);
        const updated = findCompanion(candidate, operation.statementId, operation.companionId);
        if (!original || !updated || sameJson(original, updated)) {
          outcomes.push({ kind: 'no_change' });
          break;
        }
        const normalized = normalizedCompanionPatch(operation.patch, updated);
        outcomes.push({ kind: 'updated', ...(normalized ? { normalized } : {}) });
        pushChanged(
          { statementId: operation.statementId, companionId: operation.companionId, kind: 'updated' },
          [
            objectEffectiveTime(before, operation.statementId, operation.companionId),
            objectEffectiveTime(candidate, operation.statementId, operation.companionId),
          ],
        );
        break;
      }
      case 'deleteSourceItem': {
        const companionId = 'companionId' in operation ? operation.companionId : undefined;
        const original = companionId === undefined
          ? before.statements.some((statement) => statement.id === operation.statementId)
          : findCompanion(before, operation.statementId, companionId) !== undefined;
        const remains = companionId === undefined
          ? candidate.statements.some((statement) => statement.id === operation.statementId)
          : findCompanion(candidate, operation.statementId, companionId) !== undefined;
        if (!original || remains) {
          outcomes.push({ kind: 'no_change' });
          break;
        }
        outcomes.push({ kind: 'deleted' });
        if (companionId === undefined) {
          // A root delete removes its whole subtree; every former companion
          // identity ends, so each is represented as a deleted object.
          pushChanged(
            { statementId: operation.statementId, kind: 'deleted' },
            [objectEffectiveTime(before, operation.statementId)],
          );
          for (const companion of (before.statements
            .find((statement) => statement.id === operation.statementId)?.companions ?? [])) {
            pushChanged(
              { statementId: operation.statementId, companionId: companion.id, kind: 'deleted' },
              [objectEffectiveTime(before, operation.statementId, companion.id)],
            );
          }
        } else {
          pushChanged(
            { statementId: operation.statementId, companionId, kind: 'deleted' },
            [objectEffectiveTime(before, operation.statementId, companionId)],
          );
        }
        break;
      }
      case 'moveSourceItem': {
        const original = operation.companionId === undefined
          ? before.statements.find((statement) => statement.id === operation.statementId)
          : findCompanion(before, operation.statementId, operation.companionId);
        const moved = operation.companionId === undefined
          ? candidate.statements.find((statement) => statement.id === operation.statementId)
          : findCompanion(candidate, operation.statementId, operation.companionId);
        if (!original || !moved || sameJson(original, moved)) {
          outcomes.push({ kind: 'no_change' });
          break;
        }
        outcomes.push({ kind: 'moved' });
        pushChanged(
          operation.companionId === undefined
            ? { statementId: operation.statementId, kind: 'moved' }
            : { statementId: operation.statementId, companionId: operation.companionId, kind: 'moved' },
          [
            objectEffectiveTime(before, operation.statementId, operation.companionId),
            objectEffectiveTime(candidate, operation.statementId, operation.companionId),
          ],
        );
        break;
      }
      case 'reorderCompanions': {
        const original = before.statements.find((statement) => statement.id === operation.statementId)?.companions ?? [];
        const reordered = candidate.statements.find((statement) => statement.id === operation.statementId)?.companions ?? [];
        if (original.map((companion) => companion.id).join('\u0000') === reordered.map((companion) => companion.id).join('\u0000')) {
          outcomes.push({ kind: 'no_change' });
          break;
        }
        outcomes.push({ kind: 'reordered' });
        pushChanged(
          { statementId: operation.statementId, kind: 'reordered' },
          [objectEffectiveTime(before, operation.statementId)],
        );
        break;
      }
    }
  }

  const timeRange = affectedTimes.length > 0
    ? { start: Math.min(...affectedTimes), end: Math.max(...affectedTimes) }
    : undefined;
  const counts = countChangedObjects(changedObjects);
  return { outcomes, changedObjects, counts, timeRange };
}

/** Trusted change counts: one per actually-changed source object. */
function countChangedObjects(
  changedObjects: readonly ProjectAgentHostChangedObject[],
): SemanticScenePatchCountsV1 {
  let insertedStatements = 0;
  let insertedCompanions = 0;
  let updatedStatements = 0;
  let updatedCompanions = 0;
  let deleted = 0;
  let moved = 0;
  let reordered = 0;
  for (const changed of changedObjects) {
    const isCompanion = changed.companionId !== undefined;
    if (changed.kind === 'inserted') {
      if (isCompanion) insertedCompanions += 1;
      else insertedStatements += 1;
    } else if (changed.kind === 'updated') {
      if (isCompanion) updatedCompanions += 1;
      else updatedStatements += 1;
    } else if (changed.kind === 'deleted') {
      deleted += 1;
    } else if (changed.kind === 'moved') {
      moved += 1;
    } else {
      reordered += 1;
    }
  }
  return {
    insertedStatements,
    insertedCompanions,
    updatedStatements,
    updatedCompanions,
    deletedLines: deleted,
    movedLines: moved,
    reorderedCompanionGroups: reordered,
    inserted: insertedStatements + insertedCompanions,
    updated: updatedStatements + updatedCompanions,
    deleted,
    moved,
  };
}

function findCompanion(document: CurrentSceneDocument, statementId: string, companionId: string) {
  return document.statements.find((statement) => statement.id === statementId)
    ?.companions?.find((companion) => companion.id === companionId);
}

/** Scene time of a source object; companions resolve through their parent. */
function objectEffectiveTime(
  document: CurrentSceneDocument,
  statementId: string,
  companionId?: string,
): number {
  const statement = document.statements.find((item) => item.id === statementId);
  if (!statement) return 0;
  if (companionId === undefined) return statement.time;
  const companion = (statement.companions ?? []).find((item) => item.id === companionId);
  if (!companion) return statement.time;
  return statement.time
    + (companion.anchor === 'end' ? sceneStatementDefinitionRegistry.temporalExtent(statement) : 0)
    + companion.offset;
}

/** Only actual saved-versus-requested differences become a normalized patch. */
function normalizedStatementPatch(
  requested: SemanticSceneStatementPatchV1,
  saved: SceneStatement,
): SemanticSceneStatementPatchV1 | undefined {
  const normalized: Record<string, unknown> = {};
  if (requested.type !== undefined && requested.type !== saved.type) {
    normalized.type = saved.type;
  }
  if (requested.params !== undefined && requested.params !== null && isRecord(requested.params)) {
    const params: Record<string, unknown> = {};
    for (const [key, requestedValue] of Object.entries(requested.params)) {
      const savedValue = (saved.params as Record<string, unknown>)[key];
      if (!sameJson(requestedValue, savedValue)) {
        params[key] = savedValue;
      }
    }
    if (Object.keys(params).length > 0) normalized.params = params;
  }
  return Object.keys(normalized).length > 0
    ? (normalized as SemanticSceneStatementPatchV1)
    : undefined;
}

function normalizedCompanionPatch(
  requested: SemanticSceneCompanionPatchV1,
  saved: DialogueCompanion,
): SemanticSceneCompanionPatchV1 | undefined {
  const normalized: Record<string, unknown> = {};
  if (requested.type !== undefined && requested.type !== saved.type) {
    normalized.type = saved.type;
  }
  if (requested.anchor !== undefined && requested.anchor !== saved.anchor) {
    normalized.anchor = saved.anchor;
  }
  if (requested.offset !== undefined && requested.offset !== saved.offset) {
    normalized.offset = saved.offset;
  }
  if (requested.params !== undefined && requested.params !== null && isRecord(requested.params)) {
    const params: Record<string, unknown> = {};
    for (const [key, requestedValue] of Object.entries(requested.params)) {
      const savedValue = (saved.params as Record<string, unknown>)[key];
      if (!sameJson(requestedValue, savedValue)) {
        params[key] = savedValue;
      }
    }
    if (Object.keys(params).length > 0) normalized.params = params;
  }
  return Object.keys(normalized).length > 0
    ? (normalized as SemanticSceneCompanionPatchV1)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invalidArgs(message: string): AgentToolError {
  return {
    code: 'invalid_arguments',
    message,
    retryable: false,
    suggestedAction: 'fix_arguments',
  };
}

function mapPatchError(error: unknown): AgentToolError {
  if (isSemanticScenePatchError(error) || error instanceof SemanticScenePatchError) {
    const primary = error.issues[0];
    const baseMessage = primary?.message ?? error.message;
    return {
      code: mapPatchCode(primary?.code ?? error.code),
      message: primary?.code === 'schema_validation_failed'
        ? `${baseMessage} Consult the statement authoring reference in the system prompt for allowed fields.`
        : baseMessage,
      retryable: false,
      suggestedAction: 'fix_arguments' as const,
      diagnostics: error.issues.map((issue) => mapIssue(issue)),
    };
  }
  return {
    code: 'invalid_arguments',
    message: error instanceof Error ? error.message : 'Patch failed',
    retryable: false,
    suggestedAction: 'fix_arguments',
  };
}

function mapPatchCode(code: string): AgentToolErrorCode {
  switch (code) {
    case 'wrong_line_kind':
      // Shared patch algebra keeps its line-era code name; the Agent-facing
      // code speaks source identities (ADR0024).
      return 'wrong_source_kind';
    case 'conflicting_operations':
    case 'invalid_arguments':
    case 'forbidden_path':
    case 'schema_validation_failed':
    case 'semantic_validation_failed':
    case 'compiler_validation_failed':
      return code;
    case 'forbidden_operation':
    case 'forbidden_family':
    case 'stage_scope_violation':
      return 'forbidden_operation';
    default:
      return 'invalid_arguments';
  }
}

function mapIssue(issue: SemanticScenePatchIssueV1): AgentToolDiagnostic {
  return {
    code: issue.code,
    message: issue.message,
    severity: 'error',
    ...(issue.path !== undefined ? { path: issue.path } : {}),
    ...(issue.operationIndex !== undefined ? { operationIndex: issue.operationIndex } : {}),
  };
}

function mapWarnings(issues: readonly SemanticScenePatchIssueV1[]): AgentToolDiagnostic[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    severity: 'warning' as const,
    ...(issue.path !== undefined ? { path: issue.path } : {}),
    ...(issue.operationIndex !== undefined ? { operationIndex: issue.operationIndex } : {}),
  }));
}

function gateErrorCode(
  gate: 'schema' | 'semantic' | 'compiler' | 'resource',
): AgentToolErrorCode {
  switch (gate) {
    case 'schema':
      return 'schema_validation_failed';
    case 'compiler':
      return 'compiler_validation_failed';
    case 'resource':
      return 'resource_validation_failed';
    default:
      return 'semantic_validation_failed';
  }
}

function isVersionConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  return code === 'version_conflict' || code === 'VERSION_CONFLICT';
}

/**
 * Host-private line resolution (ADR0023): parse every Agent line reference to
 * an internal locator at transaction start. The result only feeds the durable
 * pending record and opaque fingerprints — internal UUIDs never reach params,
 * receipts, diagnostics or model context.
 */
function resolveOperationLocatorNotes(
  document: CurrentSceneDocument,
  operations: readonly SemanticSceneOperationV1[],
): readonly {
  index: number;
  locators: readonly {
    line: number;
    kind: string;
    statementId: string;
    companionId?: string;
  }[];
}[] {
  const view = new SemanticSceneLineView(document);
  const notes: {
    index: number;
    locators: readonly {
      line: number;
      kind: string;
      statementId: string;
      companionId?: string;
    }[];
  }[] = [];
  operations.forEach((operation, index) => {
    const referencedLines: number[] = [];
    if ('line' in operation && typeof operation.line === 'number') referencedLines.push(operation.line);
    if ('parentLine' in operation && typeof operation.parentLine === 'number') {
      referencedLines.push(operation.parentLine);
    }
    if ('beforeLine' in operation && typeof operation.beforeLine === 'number') {
      referencedLines.push(operation.beforeLine);
    }
    if ('orderedLines' in operation && Array.isArray(operation.orderedLines)) {
      referencedLines.push(...operation.orderedLines);
    }
    const locators = referencedLines
      .map((line) => view.resolveInternal(line))
      .filter((resolved): resolved is NonNullable<typeof resolved> => !!resolved)
      .map((resolved) => ({
        line: resolved.line,
        kind: resolved.kind,
        statementId: resolved.statementId,
        ...(resolved.companionId !== undefined ? { companionId: resolved.companionId } : {}),
      }));
    notes.push({ index, locators });
  });
  return notes;
}

/** Deterministic opaque fingerprint; never used to replay a patch. */
function stableFingerprint(value: unknown): string {
  return JSON.stringify(stableJson(value));
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj).sort().reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = stableJson(obj[key]);
      return acc;
    }, {});
  }
  return value;
}

function isAuthoringGateError(error: unknown): error is SemanticAuthoringGateError {
  return !!error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'gate_failed'
    && Array.isArray((error as { diagnostics?: unknown }).diagnostics);
}

/** Journal/pending persistence failures block the commit BEFORE it starts. */
function isHostPersistError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  return code === 'journal_persist_failed' || code === 'pending_persist_failed';
}

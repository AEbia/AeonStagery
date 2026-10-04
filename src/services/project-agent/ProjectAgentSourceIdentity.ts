import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type {
  AgentSourceAuthoringOperation,
  AgentToolDiagnostic,
} from '../../api/types/project-agent';
import type { SemanticSceneOperationV1 } from '../../api/types/semantic-scene-patch';
import { SemanticSceneLineView } from '../semantic-scene/SemanticSceneLineView';

export type ProjectAgentSourceTarget =
  | { readonly statementId: string; readonly companionId?: never }
  | { readonly statementId: string; readonly companionId: string };

export interface ProjectAgentSourceLine {
  readonly line: number;
  readonly parentLine?: number;
  readonly statementId: string;
  readonly companionId?: string;
}

export type ProjectAgentSourceResolution =
  | { readonly ok: true; readonly line: number; readonly parentLine?: number; readonly statementId: string; readonly companionId?: string }
  | { readonly ok: false; readonly code: 'source_identity_not_found' };

export type ProjectAgentSourceOperationResolution =
  | { readonly ok: true; readonly operations: readonly SemanticSceneOperationV1[] }
  | {
      readonly ok: false;
      readonly diagnostic: AgentToolDiagnostic;
    };

/**
 * Snapshot-local identity facade. It derives directly from formal source and
 * intentionally stores no agent locator map, cache, alias or tombstone.
 */
export class ProjectAgentSourceIdentityFacade {
  private readonly document: CurrentSceneDocument;
  private readonly lines: readonly ProjectAgentSourceLine[];

  constructor(document: CurrentSceneDocument) {
    this.document = document;
    const view = new SemanticSceneLineView(document);
    const parentLines = new Map<string, number>();
    for (const item of view.internalLines()) {
      if (item.kind === 'statement') parentLines.set(item.statementId, item.line);
    }
    this.lines = view.internalLines().map((item) => ({
      line: item.line,
      ...(item.kind === 'companion' ? { parentLine: parentLines.get(item.statementId) } : {}),
      statementId: item.statementId,
      ...(item.companionId === undefined ? {} : { companionId: item.companionId }),
    }));
  }

  project(): readonly ProjectAgentSourceLine[] {
    return this.lines;
  }

  resolve(target: ProjectAgentSourceTarget): ProjectAgentSourceResolution {
    const match = this.lines.find((line) => line.statementId === target.statementId
      && ('companionId' in target
        ? line.companionId === target.companionId
        : line.companionId === undefined));
    return match
      ? { ok: true, ...match }
      : { ok: false, code: 'source_identity_not_found' };
  }

  resolveStatement(statementId: string): ProjectAgentSourceResolution {
    return this.resolve({ statementId });
  }

  resolveCompanion(statementId: string, companionId: string): ProjectAgentSourceResolution {
    return this.resolve({ statementId, companionId });
  }

  /**
   * Resolves every external source locator against this one snapshot before
   * semantic patch parsing. Inserted source objects deliberately have no
   * alias, so a later operation in the same transaction cannot target one.
   */
  resolveRootOperations(
    operations: readonly AgentSourceAuthoringOperation[],
  ): ProjectAgentSourceOperationResolution {
    const resolved: SemanticSceneOperationV1[] = [];
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]!;
      // Contract guard (ADR0024): line-era locators are unreachable in the
      // source-identity toolset, including the explicit transaction path.
      const raw = operation as unknown as Record<string, unknown>;
      for (const forbidden of [
        'line',
        'parentLine',
        'beforeLine',
        'orderedLines',
        'validThroughLine',
        'invalidatedFromLine',
        'refreshRequired',
        'stale_line_map',
      ] as const) {
        if (Object.prototype.hasOwnProperty.call(raw, forbidden)) {
          return invalidOperation(
            index,
            `${operation.kind} cannot use line locators; address source objects by their identities`,
          );
        }
      }
      switch (operation.kind) {
        case 'insertStatement': {
          let beforeLine: number | undefined;
          if (operation.beforeStatementId !== undefined) {
            const before = this.resolveStatement(operation.beforeStatementId);
            if (!before.ok) return missingIdentity(index, operation.beforeStatementId);
            beforeLine = before.line;
          }
          resolved.push({
            kind: 'insertStatement',
            time: operation.time,
            statement: operation.statement,
            ...(beforeLine === undefined ? {} : { beforeLine }),
          });
          break;
        }
        case 'updateStatement': {
          const target = this.resolveStatement(operation.statementId);
          if (!target.ok) return missingIdentity(index, operation.statementId);
          resolved.push({ kind: 'updateStatement', line: target.line, patch: operation.patch });
          break;
        }
        case 'insertCompanion': {
          const parent = this.resolveStatement(operation.statementId);
          if (!parent.ok) return missingIdentity(index, operation.statementId);
          if (parent.companionId !== undefined || this.statement(parent.statementId)?.type !== 'dialogue') {
            return wrongParent(index, operation.statementId);
          }
          let beforeLine: number | undefined;
          if (operation.beforeCompanionId !== undefined) {
            const before = this.resolveCompanion(operation.statementId, operation.beforeCompanionId);
            if (!before.ok) return missingIdentity(index, operation.beforeCompanionId, 'beforeCompanionId');
            beforeLine = before.line;
          }
          resolved.push({
            kind: 'insertCompanion',
            parentLine: parent.line,
            companion: operation.companion,
            ...(beforeLine === undefined ? {} : { beforeLine }),
          });
          break;
        }
        case 'updateCompanion': {
          if (operation.patch.anchor !== undefined || operation.patch.offset !== undefined) {
            return invalidOperation(index, 'updateCompanion cannot modify anchor or offset; use moveSourceItem');
          }
          const target = this.resolveCompanion(operation.statementId, operation.companionId);
          if (!target.ok) return missingIdentity(index, operation.companionId, 'companionId');
          resolved.push({ kind: 'updateCompanion', line: target.line, patch: operation.patch });
          break;
        }
        case 'deleteSourceItem': {
          const isCompanion = 'companionId' in operation;
          const target = isCompanion
            ? this.resolveCompanion(operation.statementId, operation.companionId)
            : this.resolveStatement(operation.statementId);
          if (!target.ok) return missingIdentity(index, isCompanion ? operation.companionId : operation.statementId, isCompanion ? 'companionId' : 'statementId');
          resolved.push({ kind: 'deleteLine', line: target.line });
          break;
        }
        case 'moveSourceItem': {
          if (operation.companionId !== undefined) {
            const target = this.resolveCompanion(operation.statementId, operation.companionId);
            if (!target.ok) return missingIdentity(index, operation.companionId, 'companionId');
            if (operation.anchor === undefined || operation.offset === undefined) {
              return invalidOperation(index, 'Companion move requires anchor and offset');
            }
            resolved.push({
              kind: 'updateCompanion',
              line: target.line,
              patch: { anchor: operation.anchor, offset: operation.offset },
            });
          } else {
            const target = this.resolveStatement(operation.statementId);
            if (!target.ok) return missingIdentity(index, operation.statementId);
            if (operation.time === undefined) return invalidOperation(index, 'Root move requires time');
            resolved.push({ kind: 'moveLine', line: target.line, time: operation.time });
          }
          break;
        }
        case 'reorderCompanions': {
          const parent = this.resolveStatement(operation.statementId);
          if (!parent.ok) return missingIdentity(index, operation.statementId);
          if (parent.companionId !== undefined || this.statement(parent.statementId)?.type !== 'dialogue') {
            return wrongParent(index, operation.statementId);
          }
          const orderedLines: number[] = [];
          for (const companionId of operation.orderedCompanionIds) {
            const companion = this.resolveCompanion(operation.statementId, companionId);
            if (!companion.ok) return missingIdentity(index, companionId, 'orderedCompanionIds');
            orderedLines.push(companion.line);
          }
          resolved.push({ kind: 'reorderCompanions', parentLine: parent.line, orderedLines });
          break;
        }
      }
    }
    return { ok: true, operations: resolved };
  }

  private statement(statementId: string) {
    return this.document.statements.find((statement) => statement.id === statementId);
  }
}

function missingIdentity(operationIndex: number, identity: string, path = 'statementId'): ProjectAgentSourceOperationResolution {
  return {
    ok: false,
    diagnostic: {
      code: 'source_identity_not_found',
      message: `Source identity was not found: ${identity}`,
      severity: 'error',
      path,
      operationIndex,
    },
  };
}

function wrongParent(operationIndex: number, statementId: string): ProjectAgentSourceOperationResolution {
  return {
    ok: false,
    diagnostic: {
      code: 'wrong_source_kind',
      message: `Source identity is not a root dialogue parent: ${statementId}`,
      severity: 'error',
      path: 'statementId',
      operationIndex,
      source: { statementId },
    },
  };
}

function invalidOperation(operationIndex: number, message: string): ProjectAgentSourceOperationResolution {
  return {
    ok: false,
    diagnostic: { code: 'invalid_arguments', message, severity: 'error', operationIndex },
  };
}

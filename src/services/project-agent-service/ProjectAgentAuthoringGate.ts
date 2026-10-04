import type {
  AgentInspectResourceResult,
  AgentValidateSceneDiagnostic,
} from '../../api/types/project-agent';
import type { CurrentSceneDocument, SceneStatement } from '../../api/types/semantic-scene';
import { sceneStatementDefinitionRegistry } from '../semantic-scene/SceneStatementDefinitionRegistry';

export interface ProjectAgentAuthoringGateOptions {
  /**
   * Source schema + complete semantic validation + compiler + syntactic
   * strict-resource structure checks (no RuntimeAssetPreparer loose path).
   */
  readonly validateStructure: (document: CurrentSceneDocument) => readonly AgentValidateSceneDiagnostic[];
  /** Per-transaction resource inspection: existence, bindability, actual kind. */
  readonly inspectResource: (
    reference: string,
  ) => Promise<AgentInspectResourceResult> | AgentInspectResourceResult;
}

/**
 * The strict agent authoring gate (ADR0023): every transaction revalidates
 * the COMPLETE final candidate — source schema, semantic validation,
 * compiler and strict resource references. Earlier inspect results are never
 * treated as authorization; resource existence/bindability/kind are checked
 * again for every reference on every transaction, and the runtime loose
 * degradation path is never used.
 */
export function createProjectAgentAuthoringGate(
  options: ProjectAgentAuthoringGateOptions,
): (document: CurrentSceneDocument) => Promise<readonly AgentValidateSceneDiagnostic[]> {
  return async (document) => {
    const structure = options.validateStructure(document);
    // Line maps are only well-defined for schema-valid documents; schema
    // errors short-circuit before resource inspection anyway.
    if (structure.some((item) => item.gate === 'schema' && item.severity === 'error')) {
      return structure;
    }
    const resource = await inspectStrictResources(document, options);
    return [...structure, ...resource];
  };
}

async function inspectStrictResources(
  document: CurrentSceneDocument,
  options: ProjectAgentAuthoringGateOptions,
): Promise<readonly AgentValidateSceneDiagnostic[]> {
  const diagnostics: AgentValidateSceneDiagnostic[] = [];
  for (const statement of document.statements) {
    await inspectStatementReferences(statement, { statementId: statement.id }, diagnostics, options);
    for (const companion of statement.companions ?? []) {
      await inspectStatementReferences(
        {
          id: companion.id,
          time: statement.time,
          type: companion.type,
          params: companion.params,
        } as SceneStatement,
        { statementId: statement.id, companionId: companion.id },
        diagnostics,
        options,
      );
    }
  }
  return diagnostics;
}

async function inspectStatementReferences(
  statement: SceneStatement,
  source: { readonly statementId: string; readonly companionId?: string },
  diagnostics: AgentValidateSceneDiagnostic[],
  options: ProjectAgentAuthoringGateOptions,
): Promise<void> {
  for (const reference of sceneStatementDefinitionRegistry.collectAssetReferences(statement)) {
    if (typeof reference.value !== 'string' || reference.value.trim() === '') continue;
    let inspected: AgentInspectResourceResult | null;
    try {
      inspected = await options.inspectResource(reference.value);
    } catch {
      inspected = null;
    }
    if (!inspected) {
      diagnostics.push({
        gate: 'resource',
        severity: 'error',
        message: `${statement.type} 资源 ${reference.value} 无法检查，不能作为写入授权。`,
        source,
        ...(typeof reference.path === 'string' ? { path: reference.path } : {}),
      });
      continue;
    }
    if (!inspected.exists) {
      diagnostics.push({
        gate: 'resource',
        severity: 'error',
        message: `${statement.type} 资源 ${reference.value} 不存在于项目资源。`,
        source,
        ...(typeof reference.path === 'string' ? { path: reference.path } : {}),
      });
      continue;
    }
    if (!inspected.bindable || inspected.materializationRequired) {
      diagnostics.push({
        gate: 'resource',
        severity: 'error',
        message: `${statement.type} 资源 ${reference.value} 不可绑定，需要先物化或采用。`,
        source,
        ...(typeof reference.path === 'string' ? { path: reference.path } : {}),
      });
      continue;
    }
    if (inspected.kind !== undefined && inspected.kind !== reference.resourceKind) {
      diagnostics.push({
        gate: 'resource',
        severity: 'error',
        message: `${statement.type} 资源 ${reference.value} 实际种类为 ${inspected.kind}，期望 ${reference.resourceKind}。`,
        source,
        ...(typeof reference.path === 'string' ? { path: reference.path } : {}),
      });
    }
  }
}

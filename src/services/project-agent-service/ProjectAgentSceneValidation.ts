import type { AgentValidateSceneDiagnostic } from '../../api/types/project-agent';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import {
  sceneDocumentCodec,
  sceneStatementCompiler,
  sceneStatementDefinitionRegistry,
  validateSemanticSceneStructure,
} from '../semantic-scene';

/**
 * Real scene validation port for the project Agent (ADR0023/0024): runs the
 * source schema, complete semantic validation, compiler and strict resource
 * gates over one document and addresses diagnostics by formal source
 * identity — never by Agent line numbers. Existence checks are deferred to
 * the editor resource layer; the strict resource gate here rejects absolute
 * paths, data URIs, protocol URLs and root escapes that would fail the
 * authoritative write gate.
 */
export function runProjectAgentSceneValidation(
  document: CurrentSceneDocument,
): readonly AgentValidateSceneDiagnostic[] {
  const diagnostics: AgentValidateSceneDiagnostic[] = [];

  runSchemaGate(document, diagnostics);
  if (diagnostics.some((item) => item.gate === 'schema' && item.severity === 'error')) {
    return diagnostics;
  }

  for (const issue of validateSemanticSceneStructure(document)) {
    diagnostics.push({
      gate: 'semantic',
      severity: issue.severity === 'warning' ? 'warning' : 'error',
      message: issue.message,
      ...(issue.code ? { code: issue.code } : {}),
      ...(issue.actionId ? { source: { statementId: issue.actionId } } : {}),
    });
  }

  runCompilerGate(document, diagnostics);
  runStrictResourceGate(document, diagnostics);
  return diagnostics;
}

function runSchemaGate(
  document: CurrentSceneDocument,
  diagnostics: AgentValidateSceneDiagnostic[],
): void {
  try {
    sceneDocumentCodec.parseAndValidate(document);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scene source schema validation failed';
    const statementIndex = indexFromSchemaPath(message);
    diagnostics.push({
      gate: 'schema',
      severity: 'error',
      message,
      // Best-effort source identity: the codec error path usually names the
      // offending statement slot; a schema-invalid document may lack ids.
      ...(statementIndex !== undefined && document.statements[statementIndex]?.id !== undefined
        ? { source: { statementId: document.statements[statementIndex]!.id } }
        : {}),
    });
  }
}

function runCompilerGate(
  document: CurrentSceneDocument,
  diagnostics: AgentValidateSceneDiagnostic[],
): void {
  try {
    sceneStatementCompiler.compile(document);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scene compile failed';
    const id = firstQuotedIdentifier(message);
    diagnostics.push({
      gate: 'compiler',
      severity: 'error',
      message,
      ...(id !== undefined && document.statements.some((statement) => statement.id === id)
        ? { source: { statementId: id } }
        : {}),
    });
  }
}

function runStrictResourceGate(
  document: CurrentSceneDocument,
  diagnostics: AgentValidateSceneDiagnostic[],
): void {
  document.statements.forEach((statement) => {
    for (const reference of sceneStatementDefinitionRegistry.collectAssetReferences(statement)) {
      const problem = strictResourceProblem(reference.value);
      if (!problem) continue;
      diagnostics.push({
        gate: 'resource',
        severity: 'error',
        message: `${statement.type} 资源 ${reference.value ?? '(empty)'} ${problem}`,
        ...(statement.id !== undefined ? { source: { statementId: statement.id } } : {}),
        ...(typeof reference.path === 'string' ? { path: reference.path } : {}),
      });
    }
  });
}

function strictResourceProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return '为空，无法解析为项目内资源引用。';
  }
  const normalized = value.replace(/\\/g, '/').trim();
  if (/^data:/i.test(normalized)) return '使用 data URI，不能作为剧本资源路径。';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized) || normalized.startsWith('//')) {
    return '使用 URL/协议路径，不能作为剧本资源路径。';
  }
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) {
    return '使用本机绝对路径，需导入项目或改为 @mount/ 引用。';
  }
  if (normalized.startsWith('@mount/')) {
    const [, mountId, ...segments] = normalized.split('/');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(mountId ?? '') || segments.join('/').trim() === '') {
      return '引用无效的挂载资源标识。';
    }
  }
  if (containsEscape(normalized.split('/'))) return '逃逸了项目资源根目录。';
  return null;
}

function containsEscape(segments: readonly string[]): boolean {
  let depth = 0;
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) return true;
      continue;
    }
    depth += 1;
  }
  return false;
}

/** Extract `scene.statements[N]` from codec error paths. */
function indexFromSchemaPath(message: string): number | undefined {
  const match = message.match(/scene\.statements\[(\d+)\]/);
  if (!match) return undefined;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/** Best-effort statement id lookup from compiler error text (`"id"`). */
function firstQuotedIdentifier(message: string): string | undefined {
  const match = message.match(/"([^"]+)"/);
  return match?.[1];
}

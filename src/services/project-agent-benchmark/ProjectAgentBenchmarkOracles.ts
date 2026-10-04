import type { CurrentSceneDocument, SceneStatement } from '../../api/types/semantic-scene';
import {
  PROJECT_AGENT_BENCHMARK_TASKS,
  type ProjectAgentBenchmarkTaskId,
} from './ProjectAgentBenchmarkFixture';

export interface ProjectAgentBenchmarkOracleInput {
  readonly taskId: ProjectAgentBenchmarkTaskId;
  readonly baseline: CurrentSceneDocument;
  readonly actual: CurrentSceneDocument;
  readonly documentVersionIncrease: number;
}

export interface ProjectAgentBenchmarkOracleResult {
  readonly passed: boolean;
  readonly reason?: string;
}

export function judgeProjectAgentBenchmarkScene(
  input: ProjectAgentBenchmarkOracleInput,
): ProjectAgentBenchmarkOracleResult {
  const expected = applyExpectedMutation(input.baseline, input.taskId);
  if (!documentsEqualIgnoringIdentityOfNewInserts(expected, input.actual, input.taskId)) {
    return { passed: false, reason: 'final source does not match the requested mutation only' };
  }
  if (input.taskId === 'atomicBatch' && input.documentVersionIncrease !== 1) {
    return { passed: false, reason: 'batch task must increase document version exactly once' };
  }
  return { passed: true };
}

function applyExpectedMutation(baseline: CurrentSceneDocument, taskId: ProjectAgentBenchmarkTaskId): CurrentSceneDocument {
  const next: CurrentSceneDocument = {
    ...baseline,
    meta: { ...baseline.meta, characters: [...(baseline.meta.characters ?? [])] },
    statements: baseline.statements.map(cloneStatement),
  };
  if (taskId === 'singleUpdate') {
    patchDialogueText(next, PROJECT_AGENT_BENCHMARK_TASKS.singleUpdate.statementId, PROJECT_AGENT_BENCHMARK_TASKS.singleUpdate.expectedText);
    return next;
  }
  if (taskId === 'insertThenUpdate') {
    next.statements.push({
      id: 'dlg_inserted',
      time: PROJECT_AGENT_BENCHMARK_TASKS.insertThenUpdate.time,
      type: 'dialogue',
      params: {
        speakerId: 'tomori',
        text: PROJECT_AGENT_BENCHMARK_TASKS.insertThenUpdate.expectedText,
        durationSeconds: 2,
      },
    });
    return next;
  }
  if (taskId === 'deleteThenUpdateDownstream') {
    next.statements = next.statements.filter(
      (statement) => statement.id !== PROJECT_AGENT_BENCHMARK_TASKS.deleteThenUpdateDownstream.deleteStatementId,
    );
    patchDialogueText(
      next,
      PROJECT_AGENT_BENCHMARK_TASKS.deleteThenUpdateDownstream.downstreamStatementId,
      PROJECT_AGENT_BENCHMARK_TASKS.deleteThenUpdateDownstream.expectedText,
    );
    return next;
  }
  patchDialogueText(next, PROJECT_AGENT_BENCHMARK_TASKS.atomicBatch.dialogueStatementId, PROJECT_AGENT_BENCHMARK_TASKS.atomicBatch.expectedText);
  const camera = next.statements.find((statement) => statement.id === PROJECT_AGENT_BENCHMARK_TASKS.atomicBatch.cameraStatementId);
  if (camera) camera.time = PROJECT_AGENT_BENCHMARK_TASKS.atomicBatch.expectedCameraTime;
  return next;
}

function documentsEqualIgnoringIdentityOfNewInserts(
  expected: CurrentSceneDocument,
  actual: CurrentSceneDocument,
  taskId: ProjectAgentBenchmarkTaskId,
): boolean {
  if (expected.schemaVersion !== actual.schemaVersion || expected.sceneId !== actual.sceneId) return false;
  if (!deepEqualIgnoringKeyOrder(expected.meta, actual.meta)) return false;

  // The insert-then-update task may legitimately place the new statement
  // anywhere: the model chooses an ordering anchor (beforeStatementId), so the
  // saved array position is not part of the requested mutation. Locate the
  // inserted statement by content (its id is host-generated) and compare the
  // remaining statements positionally.
  let expectedStatements = expected.statements;
  let actualStatements = actual.statements;
  if (taskId === 'insertThenUpdate') {
    const inserted = expectedStatements.find((statement) => statement.id === 'dlg_inserted');
    if (!inserted) return false;
    const insertedIndex = actualStatements.findIndex(
      (statement) => statementsEqualExceptId(inserted, statement),
    );
    if (insertedIndex === -1) return false;
    expectedStatements = expectedStatements.filter((statement) => statement.id !== 'dlg_inserted');
    actualStatements = actualStatements.filter((_, index) => index !== insertedIndex);
  }

  if (expectedStatements.length !== actualStatements.length) return false;
  return expectedStatements.every((statement, index) => {
    const other = actualStatements[index];
    if (!other) return false;
    return deepEqualIgnoringKeyOrder(statement, other);
  });
}

function statementsEqualExceptId(left: SceneStatement, right: SceneStatement): boolean {
  const { id: _leftId, ...leftRest } = left;
  const { id: _rightId, ...rightRest } = right;
  return deepEqualIgnoringKeyOrder(leftRest, rightRest);
}

/**
 * Structural equality that treats object key order as non-semantic. Engine
 * persistence (scene codec parse/prepare-for-save) is free to reorder keys,
 * so serialized-order comparison would reject identical documents.
 */
function deepEqualIgnoringKeyOrder(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    const leftArray = left as unknown[];
    const rightArray = right as unknown[];
    if (leftArray.length !== rightArray.length) return false;
    return leftArray.every((item, index) => deepEqualIgnoringKeyOrder(item, rightArray[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
      && deepEqualIgnoringKeyOrder(leftRecord[key], rightRecord[key]),
  );
}

function patchDialogueText(document: CurrentSceneDocument, statementId: string, text: string): void {
  const statement = document.statements.find((item) => item.id === statementId);
  if (!statement || statement.type !== 'dialogue') return;
  statement.params = { ...statement.params, text };
}

function cloneStatement(statement: SceneStatement): SceneStatement {
  return structuredClone(statement);
}

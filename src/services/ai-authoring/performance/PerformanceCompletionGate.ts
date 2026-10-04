import type { CurrentSceneDocument } from '../../../api/types/semantic-scene';

/**
 * Monotonic performance completion gate (ADR-0022).
 * Host-enforced: missing/empty-string leaf fields may be filled; non-empty values cannot be
 * overwritten, cleared, or replaced. target / character id are always immutable.
 */

export type PerformanceCompletionViolationCode =
  | 'overwrite_nonempty'
  | 'clear_nonempty'
  | 'immutable_identity'
  | 'delete_performance_statement';

export interface PerformanceCompletionViolation {
  readonly code: PerformanceCompletionViolationCode;
  readonly path: string;
  readonly message: string;
}

const IMMUTABLE_IDENTITY_PATHS = new Set([
  'target',
  'params.target',
  'id',
  'params.id',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Empty string and undefined/null are fillable placeholders; whitespace-only is not empty. */
export function isPerformanceFillableValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value === '') return true;
  return false;
}

function isNonEmptyScalar(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  return false;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => valuesEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => valuesEqual(left[key], right[key]));
  }
  return false;
}

/**
 * Compare base params against candidate params for monotonic fill-only updates.
 * Arrays and object leaves already present as non-empty cannot be replaced.
 */
export function assertMonotonicPerformanceParams(
  baseParams: Readonly<Record<string, unknown>>,
  candidateParams: Readonly<Record<string, unknown>>,
  pathPrefix = 'params',
): readonly PerformanceCompletionViolation[] {
  const violations: PerformanceCompletionViolation[] = [];
  compareObject(baseParams, candidateParams, pathPrefix, violations);
  return violations;
}

function compareObject(
  base: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
  path: string,
  violations: PerformanceCompletionViolation[],
): void {
  const keys = new Set([...Object.keys(base), ...Object.keys(candidate)]);
  for (const key of keys) {
    const fieldPath = `${path}.${key}`;
    const baseValue = base[key];
    const candidateValue = candidate[key];
    const identityPath = key === 'target' || key === 'id'
      ? key
      : fieldPath.endsWith('.target') || fieldPath.endsWith('.id')
        ? key
        : null;

    if (
      identityPath !== null
      && IMMUTABLE_IDENTITY_PATHS.has(identityPath)
      && baseValue !== undefined
      && !valuesEqual(baseValue, candidateValue)
    ) {
      violations.push({
        code: 'immutable_identity',
        path: fieldPath,
        message: `Performance identity field "${fieldPath}" cannot change`,
      });
      continue;
    }

    if (isPerformanceFillableValue(baseValue)) {
      continue;
    }

    if (candidateValue === undefined || candidateValue === null) {
      violations.push({
        code: 'clear_nonempty',
        path: fieldPath,
        message: `Non-empty performance field "${fieldPath}" cannot be cleared`,
      });
      continue;
    }

    if (Array.isArray(baseValue)) {
      if (!valuesEqual(baseValue, candidateValue)) {
        violations.push({
          code: 'overwrite_nonempty',
          path: fieldPath,
          message: `Non-empty performance array "${fieldPath}" cannot be replaced`,
        });
      }
      continue;
    }

    if (isPlainObject(baseValue)) {
      if (!isPlainObject(candidateValue)) {
        violations.push({
          code: 'overwrite_nonempty',
          path: fieldPath,
          message: `Non-empty performance object "${fieldPath}" cannot be replaced`,
        });
        continue;
      }
      compareObject(baseValue, candidateValue, fieldPath, violations);
      continue;
    }

    if (isNonEmptyScalar(baseValue) && !valuesEqual(baseValue, candidateValue)) {
      violations.push({
        code: 'overwrite_nonempty',
        path: fieldPath,
        message: `Non-empty performance field "${fieldPath}" cannot be overwritten`,
      });
    }
  }
}

export interface PerformanceStatementSnapshot {
  readonly kind: 'statement' | 'companion';
  readonly type: string;
  readonly line?: number;
  readonly id?: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export function collectPerformanceStatementSnapshots(
  document: CurrentSceneDocument,
): PerformanceStatementSnapshot[] {
  const snapshots: PerformanceStatementSnapshot[] = [];
  for (const statement of document.statements) {
    if (statement.type === 'characterPerformance' || statement.type === 'characterTransform') {
      snapshots.push({
        kind: 'statement',
        type: statement.type,
        id: statement.id,
        params: statement.params as unknown as Readonly<Record<string, unknown>>,
      });
    }
    if (statement.type === 'dialogue' && statement.companions) {
      for (const companion of statement.companions) {
        if (companion.type === 'characterPerformance' || companion.type === 'characterTransform') {
          snapshots.push({
            kind: 'companion',
            type: companion.type,
            id: companion.id,
            params: companion.params as unknown as Readonly<Record<string, unknown>>,
          });
        }
      }
    }
  }
  return snapshots;
}

/**
 * Gate a set of base performance/transform statements against candidates after a patch merge.
 * Detects forbidden deletes of existing performance statements and non-monotonic param changes
 * for shared identities (by line when available, else by stable id).
 */
export function assertMonotonicPerformanceCompletion(input: {
  readonly base: readonly PerformanceStatementSnapshot[];
  readonly candidate: readonly PerformanceStatementSnapshot[];
}): readonly PerformanceCompletionViolation[] {
  const violations: PerformanceCompletionViolation[] = [];
  const candidateByKey = new Map<string, PerformanceStatementSnapshot>();

  for (const item of input.candidate) {
    candidateByKey.set(snapshotKey(item), item);
  }

  for (const baseItem of input.base) {
    if (
      baseItem.type !== 'characterPerformance'
      && baseItem.type !== 'characterTransform'
    ) {
      continue;
    }
    const key = snapshotKey(baseItem);
    const candidateItem = candidateByKey.get(key);
    if (!candidateItem) {
      violations.push({
        code: 'delete_performance_statement',
        path: key,
        message: `Existing ${baseItem.type} statement cannot be deleted by performance stage`,
      });
      continue;
    }
    violations.push(
      ...assertMonotonicPerformanceParams(baseItem.params, candidateItem.params, `${key}.params`),
    );
  }

  return violations;
}

function snapshotKey(item: PerformanceStatementSnapshot): string {
  if (item.line !== undefined) return `line:${item.line}`;
  if (item.id !== undefined) return `id:${item.id}`;
  const target = typeof item.params.target === 'string'
    ? item.params.target
    : typeof item.params.id === 'string'
      ? item.params.id
      : '?';
  return `${item.kind}:${item.type}:${target}`;
}

export function isMonotonicPerformanceCompletion(input: {
  readonly base: readonly PerformanceStatementSnapshot[];
  readonly candidate: readonly PerformanceStatementSnapshot[];
}): boolean {
  return assertMonotonicPerformanceCompletion(input).length === 0;
}

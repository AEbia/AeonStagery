import {
  PROJECT_SCHEMA_VERSION_V2,
  type ProjectMetadataV2,
} from '../../api/types/project';
import { ProjectMetadataCodec, projectMetadataCodec } from './ProjectMetadataCodec';
import {
  migrateProjectMetadataV1ToV2,
  validateProjectMetadataV2Stage,
} from './ProjectMetadataMigration';

import type {
  CompatibilityIssue,
  CompatibilityOutcome,
  MigrationPlan,
  MigrationPlanResult,
} from '../compatibility/types';

export type ProjectCompatibilityIssueCode =
  | 'unsupported_schema_epoch'
  | 'malformed_metadata';

export interface ProjectCompatibilityIssue extends CompatibilityIssue {
  readonly code: ProjectCompatibilityIssueCode;
  readonly message: string;
  readonly path?: string;
}

export interface ProjectMigrationPlanResult extends MigrationPlanResult<CompatibleProjectSession> {
  readonly document: unknown;
  readonly session: CompatibleProjectSession;
  readonly warnings: readonly string[];
}

export interface ProjectMigrationPlan extends MigrationPlan<CompatibleProjectSession> {
  readonly sourceEpoch: number;
  readonly targetEpoch: typeof PROJECT_SCHEMA_VERSION_V2;
  readonly warnings: readonly string[];
  readonly migrate: () => ProjectMigrationPlanResult;
}

export type CompatibleProjectOutcome = CompatibilityOutcome<CompatibleProjectSession>;

interface CompatibleProjectState {
  readonly source: unknown;
  readonly projection: ProjectMetadataV2;
}

export class CompatibleProjectSession {
  private readonly codec: ProjectMetadataCodec;
  private currentState: CompatibleProjectState;
  private readonly undoStack: CompatibleProjectState[] = [];
  private readonly redoStack: CompatibleProjectState[] = [];

  constructor(source: unknown, projection: ProjectMetadataV2, codec: ProjectMetadataCodec = projectMetadataCodec) {
    this.codec = codec;
    this.currentState = {
      source: reconcileKnownProjection(source, projection, projection),
      projection,
    };
  }

  static open(
    input: unknown,
    codec: ProjectMetadataCodec = projectMetadataCodec,
  ): CompatibleProjectOutcome {
    let source: unknown;
    try {
      source = cloneJson(input);
    } catch (error) {
      return invalidOutcome(error);
    }

    if (!isRecord(source)) {
      return invalidOutcome(new Error('Expected object at project metadata'));
    }

    if (source.projectVersion === undefined || !('projectVersion' in source)) {
      if (!isRecognizedLegacyProjectShape(source)) {
        return invalidOutcome(
          new Error('Project metadata is missing projectVersion and does not match a recognized legacy project shape'),
        );
      }

      try {
        const dryRun = migrateProjectMetadataV1ToV2(source, codec);
        validateProjectMetadataV2Stage(dryRun.document, codec);
        return {
          status: 'migration_required',
          plan: {
            sourceEpoch: 1,
            targetEpoch: PROJECT_SCHEMA_VERSION_V2,
            warnings: dryRun.warnings,
            migrate: () => {
              const migrated = migrateProjectMetadataV1ToV2(source, codec);
              const proj = validateProjectMetadataV2Stage(migrated.document, codec);
              return {
                document: migrated.document,
                session: new CompatibleProjectSession(migrated.document, proj, codec),
                warnings: migrated.warnings,
              };
            },
          },
        };
      } catch (error) {
        return invalidOutcome(error);
      }
    }

    if (!isSchemaEpoch(source.projectVersion)) {
      return invalidOutcome(new Error('Expected a positive integer at project.projectVersion'));
    }

    if (source.projectVersion > PROJECT_SCHEMA_VERSION_V2) {
      return {
        status: 'incompatible',
        issue: {
          code: 'unsupported_schema_epoch',
          path: 'project.projectVersion',
          message: `Unsupported project schema epoch ${source.projectVersion}; expected ${PROJECT_SCHEMA_VERSION_V2}`,
        },
      };
    }

    if (source.projectVersion === 1) {
      try {
        const dryRun = migrateProjectMetadataV1ToV2(source, codec);
        validateProjectMetadataV2Stage(dryRun.document, codec);
        return {
          status: 'migration_required',
          plan: {
            sourceEpoch: 1,
            targetEpoch: PROJECT_SCHEMA_VERSION_V2,
            warnings: dryRun.warnings,
            migrate: () => {
              const migrated = migrateProjectMetadataV1ToV2(source, codec);
              const proj = validateProjectMetadataV2Stage(migrated.document, codec);
              return {
                document: migrated.document,
                session: new CompatibleProjectSession(migrated.document, proj, codec),
                warnings: migrated.warnings,
              };
            },
          },
        };
      } catch (error) {
        return invalidOutcome(error);
      }
    }

    try {
      const projection = codec.parseKnownProjection(source);
      return {
        status: 'ready',
        session: new CompatibleProjectSession(source, projection, codec),
      };
    } catch (error) {
      return invalidOutcome(error);
    }
  }

  get projection(): ProjectMetadataV2 {
    return this.currentState.projection;
  }

  applyTypedEdit(nextProjection: ProjectMetadataV2): ProjectMetadataV2 {
    if (nextProjection.projectVersion !== PROJECT_SCHEMA_VERSION_V2) {
      throw new Error(`Typed project edit must use schema version ${PROJECT_SCHEMA_VERSION_V2}`);
    }
    const projection = this.codec.parseKnownProjection(nextProjection);
    const source = reconcileKnownProjection(
      this.currentState.source,
      this.currentState.projection,
      projection,
    );
    this.commit({ source, projection });
    return this.currentState.projection;
  }

  /** Replace the complete Compatibility Source. */
  replaceSource(input: unknown): CompatibleProjectOutcome {
    const outcome = CompatibleProjectSession.open(input, this.codec);
    if (outcome.status !== 'ready') return outcome;
    this.commit(outcome.session.currentState);
    return { status: 'ready', session: this };
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.redoStack.push(this.currentState);
    this.currentState = previous;
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.currentState);
    this.currentState = next;
    return true;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  serialize(): unknown {
    return cloneJson(this.currentState.source);
  }

  private commit(next: CompatibleProjectState): void {
    this.undoStack.push(this.currentState);
    this.redoStack.length = 0;
    this.currentState = next;
  }
}

function reconcileKnownProjection(
  source: unknown,
  previous: unknown,
  next: unknown,
): unknown {
  if (next === undefined) return undefined;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous) || !Array.isArray(source)) return cloneJson(next);
    const usedPreviousIndexes = new Set<number>();
    return next.map((nextItem, nextIndex) => {
      const previousIndex = findPreviousArrayIndex(
        previous,
        nextItem,
        nextIndex,
        next.length,
        usedPreviousIndexes,
      );
      if (previousIndex < 0) return cloneJson(nextItem);
      usedPreviousIndexes.add(previousIndex);
      return reconcileKnownProjection(source[previousIndex], previous[previousIndex], nextItem);
    });
  }

  if (isRecord(next)) {
    if (!isRecord(previous) || !isRecord(source)) return cloneJson(next);
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(source)) {
      if (!Object.prototype.hasOwnProperty.call(previous, key)
        && !Object.prototype.hasOwnProperty.call(next, key)) {
        result[key] = cloneJson(value);
      }
    }
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) continue;
      result[key] = Object.prototype.hasOwnProperty.call(previous, key)
        ? reconcileKnownProjection(source[key], previous[key], value)
        : cloneJson(value);
    }
    return result;
  }

  return cloneJson(next);
}

function findPreviousArrayIndex(
  previous: readonly unknown[],
  nextItem: unknown,
  fallbackIndex: number,
  nextLength: number,
  usedPreviousIndexes: ReadonlySet<number>,
): number {
  const identity = stableIdentity(nextItem);
  if (identity) {
    const match = previous.findIndex((item, index) => (
      !usedPreviousIndexes.has(index) && stableIdentity(item) === identity
    ));
    if (match >= 0) return match;
    return -1;
  }

  const exactMatch = previous.findIndex((item, index) => (
    !usedPreviousIndexes.has(index) && equalJson(item, nextItem)
  ));
  if (exactMatch >= 0) return exactMatch;

  const hasStructuralChange = previous.length !== nextLength;
  return !hasStructuralChange
    && fallbackIndex < previous.length
    && !usedPreviousIndexes.has(fallbackIndex)
    ? fallbackIndex
    : -1;
}

function stableIdentity(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['id', 'presetId'] as const) {
    if (typeof value[key] === 'string') return `${key}:${value[key]}`;
  }
  return undefined;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecognizedLegacyProjectShape(value: Record<string, unknown>): boolean {
  if (value.projectVersion !== undefined) return false;
  const hasName = typeof value.name === 'string' && value.name.trim().length > 0;
  const hasProjectId = typeof value.projectId === 'string' && value.projectId.trim().length > 0;
  const hasId = typeof value.id === 'string' && value.id.trim().length > 0;
  const hasScenes = Array.isArray(value.scenes);
  const hasAssetRoots = isRecord(value.assetRoots);
  const hasDefaultSceneId = typeof value.defaultSceneId === 'string' && value.defaultSceneId.trim().length > 0;

  if (hasName && (hasProjectId || hasId || hasScenes || hasAssetRoots || hasDefaultSceneId)) {
    return true;
  }
  if ((hasProjectId || hasId) && (hasScenes || hasAssetRoots || hasDefaultSceneId)) {
    return true;
  }
  return false;
}

function invalidOutcome(error: unknown): Extract<CompatibleProjectOutcome, { status: 'invalid' }> {
  return {
    status: 'invalid',
    issue: {
      code: 'malformed_metadata',
      message: error instanceof Error ? error.message : 'Malformed project metadata',
    },
  };
}

function isSchemaEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return undefined as unknown as T;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return undefined as unknown as T;
  return JSON.parse(serialized) as T;
}

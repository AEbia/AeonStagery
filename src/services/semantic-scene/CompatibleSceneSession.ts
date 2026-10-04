import {
  SCENE_SCHEMA_VERSION,
  SCENE_SCHEMA_VERSION_V5,
  type SceneDocumentV5,
} from '../../api/types/semantic-scene';
import { SceneDocumentCodec, sceneDocumentCodec } from './SceneDocumentCodec';
import {
  UnknownSceneDiscriminatorError,
  UnknownSceneFieldError,
} from './SceneDocumentContractErrors';
import {
  migrateSceneV3ToV5,
  migrateSceneV4ToV5,
  validateV5Stage,
} from './SceneV4ToV5Migration';

import type {
  CompatibilityIssue,
  CompatibilityOutcome,
  MigrationPlan,
  MigrationPlanResult,
} from '../compatibility/types';

export type SceneCompatibilityIssueCode =
  | 'unsupported_schema_epoch'
  | 'unknown_discriminator'
  | 'malformed_scene';

export interface SceneCompatibilityIssue extends CompatibilityIssue {
  readonly code: SceneCompatibilityIssueCode;
  readonly message: string;
  readonly path?: string;
}

export type SceneMigrationStage = 'v3_to_v4' | 'v4_to_v5';

export interface SceneMigrationPlanResult extends MigrationPlanResult<CompatibleSceneSession> {
  readonly document: unknown;
  readonly session: CompatibleSceneSession;
  readonly warnings: readonly string[];
}

export interface SceneMigrationPlan extends MigrationPlan<CompatibleSceneSession> {
  readonly sourceEpoch: number;
  readonly targetEpoch: typeof SCENE_SCHEMA_VERSION_V5;
  readonly stages: readonly SceneMigrationStage[];
  readonly warnings: readonly string[];
  readonly migrate: () => SceneMigrationPlanResult;
}

export type CompatibleSceneOutcome = CompatibilityOutcome<CompatibleSceneSession>;

export interface CompatibleSceneTypedEditOptions {
  /** Duplicate id -> source id, resolved within the same owning collection. */
  readonly duplicateSources?: Readonly<Record<string, string>>;
}

interface CompatibleSceneState {
  readonly source: unknown;
  readonly projection: SceneDocumentV5;
}

export class CompatibleSceneSession {
  private readonly codec: SceneDocumentCodec;
  private currentState: CompatibleSceneState;
  private readonly undoStack: CompatibleSceneState[] = [];
  private readonly redoStack: CompatibleSceneState[] = [];

  private constructor(source: unknown, projection: SceneDocumentV5, codec: SceneDocumentCodec) {
    this.codec = codec;
    this.currentState = {
      source: reconcileKnownProjection(source, projection, projection),
      projection,
    };
  }

  static open(
    input: unknown,
    codec: SceneDocumentCodec = sceneDocumentCodec,
  ): CompatibleSceneOutcome {
    let source: unknown;
    try {
      source = cloneJson(input);
    } catch (error) {
      return invalidOutcome(error);
    }

    if (!isRecord(source)) {
      return invalidOutcome(new Error('Expected object at scene'));
    }

    if (source.schemaVersion === undefined || !('schemaVersion' in source)) {
      return invalidOutcome(
        new Error(
          'Scene document is missing schemaVersion; unversioned or legacy scenes require offline migration (scripts/migrate-scene-v2.ts)',
        ),
      );
    }

    if (source.schemaVersion === 1 || source.schemaVersion === 2) {
      return {
        status: 'incompatible',
        issue: {
          code: 'unsupported_schema_epoch',
          path: 'scene.schemaVersion',
          message: `Scene schema version ${source.schemaVersion} requires offline migration (scripts/migrate-scene-v2.ts) before opening in v5`,
        },
      };
    }

    if (!isSchemaEpoch(source.schemaVersion)) {
      return invalidOutcome(new Error('Expected a positive integer at scene.schemaVersion'));
    }

    if (source.schemaVersion > SCENE_SCHEMA_VERSION_V5) {
      return {
        status: 'incompatible',
        issue: {
          code: 'unsupported_schema_epoch',
          path: 'scene.schemaVersion',
          message: `Unsupported scene schema epoch ${source.schemaVersion}; expected ${SCENE_SCHEMA_VERSION_V5}`,
        },
      };
    }

    if (source.schemaVersion === 4) {
      try {
        const dryRun = migrateSceneV4ToV5(source, codec);
        validateV5Stage(dryRun.document, codec);
        return {
          status: 'migration_required',
          plan: {
            sourceEpoch: 4,
            targetEpoch: SCENE_SCHEMA_VERSION_V5,
            stages: ['v4_to_v5'],
            warnings: dryRun.warnings,
            migrate: () => {
              const migrated = migrateSceneV4ToV5(source, codec);
              const proj = validateV5Stage(migrated.document, codec);
              return {
                document: migrated.document,
                session: new CompatibleSceneSession(migrated.document, proj, codec),
                warnings: migrated.warnings,
              };
            },
          },
        };
      } catch (error) {
        if (error instanceof UnknownSceneDiscriminatorError) {
          return {
            status: 'incompatible',
            issue: {
              code: 'unknown_discriminator',
              path: error.path,
              message: error.message,
            },
          };
        }
        return invalidOutcome(error);
      }
    }

    if (source.schemaVersion === 3) {
      try {
        const dryRun = migrateSceneV3ToV5(source, codec);
        validateV5Stage(dryRun.document, codec);
        return {
          status: 'migration_required',
          plan: {
            sourceEpoch: 3,
            targetEpoch: SCENE_SCHEMA_VERSION_V5,
            stages: ['v3_to_v4', 'v4_to_v5'],
            warnings: dryRun.warnings,
            migrate: () => {
              const migrated = migrateSceneV3ToV5(source, codec);
              const proj = validateV5Stage(migrated.document, codec);
              return {
                document: migrated.document,
                session: new CompatibleSceneSession(migrated.document, proj, codec),
                warnings: migrated.warnings,
              };
            },
          },
        };
      } catch (error) {
        if (error instanceof UnknownSceneDiscriminatorError) {
          return {
            status: 'incompatible',
            issue: {
              code: 'unknown_discriminator',
              path: error.path,
              message: error.message,
            },
          };
        }
        return invalidOutcome(error);
      }
    }

    try {
      const projection = parseV5Projection(source, codec);
      return {
        status: 'ready',
        session: new CompatibleSceneSession(source, projection, codec),
      };
    } catch (error) {
      if (error instanceof UnknownSceneDiscriminatorError) {
        return {
          status: 'incompatible',
          issue: {
            code: 'unknown_discriminator',
            path: error.path,
            message: error.message,
          },
        };
      }
      return invalidOutcome(error);
    }
  }

  get projection(): SceneDocumentV5 {
    return this.currentState.projection;
  }

  applyTypedEdit(
    nextProjection: SceneDocumentV5,
    options: CompatibleSceneTypedEditOptions = {},
  ): SceneDocumentV5 {
    if (nextProjection.schemaVersion !== SCENE_SCHEMA_VERSION_V5) {
      throw new Error(`Typed scene edit must use schema version ${SCENE_SCHEMA_VERSION_V5}`);
    }
    const projection = parseV5Projection(nextProjection, this.codec);
    const source = reconcileKnownProjection(
      this.currentState.source,
      this.currentState.projection,
      projection,
      options,
    );
    this.commit({ source, projection });
    return this.currentState.projection;
  }

  /**
   * Reconcile a typed document produced by the authoring pipeline back into
   * the retained Compatibility Source and return the serialized source. Used
   * by persistence on save: known edits are merged while unknown fields that
   * the current reader does not model survive the round-trip. Unlike
   * `applyTypedEdit`, it does not touch the session undo/redo stacks.
   */
  reconcileForSave(nextProjection: SceneDocumentV5): unknown {
    if (nextProjection.schemaVersion !== SCENE_SCHEMA_VERSION_V5) {
      throw new Error(`Typed scene edit must use schema version ${SCENE_SCHEMA_VERSION_V5}`);
    }
    const projection = parseV5Projection(nextProjection, this.codec);
    const source = reconcileKnownProjection(
      this.currentState.source,
      this.currentState.projection,
      projection,
    );
    this.currentState = { source, projection };
    return cloneJson(this.currentState.source);
  }

  /** Replace the complete Compatibility Source, as the Raw Script editor does. */
  replaceSource(input: unknown): CompatibleSceneOutcome {
    const outcome = CompatibleSceneSession.open(input, this.codec);
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

  get hasUnknownFields(): boolean {
    return CompatibleSceneSession.detectUnknownFields(this.currentState.source, this.codec);
  }

  static detectUnknownFields(
    input: unknown,
    codec: SceneDocumentCodec = sceneDocumentCodec,
  ): boolean {
    if (!input || typeof input !== 'object') return false;
    if (input instanceof CompatibleSceneSession) {
      return input.hasUnknownFields;
    }

    let source: unknown;
    try {
      source = cloneJson(input);
    } catch {
      return false;
    }

    if (!isRecord(source)) return false;

    if (source.schemaVersion === SCENE_SCHEMA_VERSION_V5) {
      try {
        const currentShape = cloneJson(source);
        (currentShape as any).schemaVersion = SCENE_SCHEMA_VERSION;
        const result = codec.parseKnownProjectionWithDiagnostics(currentShape);
        return result.hasUnknownFields;
      } catch {
        return false;
      }
    }

    if (source.schemaVersion === SCENE_SCHEMA_VERSION) {
      try {
        codec.parseAndValidate(source);
        return false;
      } catch (err) {
        if (err instanceof UnknownSceneFieldError) return true;
        return false;
      }
    }

    return false;
  }

  serialize(): unknown {
    return cloneJson(this.currentState.source);
  }

  private commit(next: CompatibleSceneState): void {
    this.undoStack.push(this.currentState);
    this.redoStack.length = 0;
    this.currentState = next;
  }
}

function parseV5Projection(input: unknown, codec: SceneDocumentCodec): SceneDocumentV5 {
  const currentShape = cloneJson(input);
  if (!isRecord(currentShape)) throw new Error('Expected object at scene');
  currentShape.schemaVersion = SCENE_SCHEMA_VERSION;
  const projection = codec.parseKnownProjection(currentShape);
  return Object.freeze({
    ...projection,
    schemaVersion: SCENE_SCHEMA_VERSION_V5,
  });
}

function reconcileKnownProjection(
  source: unknown,
  previous: unknown,
  next: unknown,
  options: CompatibleSceneTypedEditOptions = {},
): unknown {
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
        options,
      );
      if (previousIndex < 0) return cloneJson(nextItem);
      usedPreviousIndexes.add(previousIndex);
      return reconcileKnownProjection(source[previousIndex], previous[previousIndex], nextItem, options);
    });
  }

  if (isRecord(next)) {
    if (!isRecord(previous) || !isRecord(source)) return cloneJson(next);
    if (changedEntityShape(previous, next)) return cloneJson(next);
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(source)) {
      if (!Object.prototype.hasOwnProperty.call(previous, key)
        && !Object.prototype.hasOwnProperty.call(next, key)) {
        result[key] = cloneJson(value);
      }
    }
    for (const [key, value] of Object.entries(next)) {
      result[key] = Object.prototype.hasOwnProperty.call(previous, key)
        ? reconcileKnownProjection(source[key], previous[key], value, options)
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
  options: CompatibleSceneTypedEditOptions,
): number {
  const identity = stableIdentity(nextItem);
  if (identity) {
    const match = previous.findIndex((item, index) => (
      !usedPreviousIndexes.has(index) && stableIdentity(item) === identity
    ));
    if (match >= 0) return match;
    const duplicateSource = options.duplicateSources?.[identityValue(identity)];
    if (duplicateSource !== undefined) {
      const sourceMatch = previous.findIndex((item) => {
        const candidate = stableIdentity(item);
        return candidate !== undefined
          && identityKey(candidate) === identityKey(identity)
          && identityValue(candidate) === duplicateSource;
      });
      if (sourceMatch >= 0) return sourceMatch;
    }
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

function changedEntityShape(previous: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const shapeDiscriminators = [
    'type',
    'kind',
    'mode',
    'effect',
    'role',
    'scope',
    'stack',
    'slot',
    'targetType',
    'operation',
  ] as const;
  return shapeDiscriminators.some((key) => (
    typeof previous[key] === 'string'
      && typeof next[key] === 'string'
      && previous[key] !== next[key]
  ));
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stableIdentity(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['id', 'markerId', 'parameterId'] as const) {
    if (typeof value[key] === 'string') return `${key}:${value[key]}`;
  }
  return undefined;
}

function identityKey(identity: string): string {
  return identity.slice(0, identity.indexOf(':'));
}

function identityValue(identity: string): string {
  return identity.slice(identity.indexOf(':') + 1);
}

function invalidOutcome(error: unknown): Extract<CompatibleSceneOutcome, { status: 'invalid' }> {
  return {
    status: 'invalid',
    issue: {
      code: 'malformed_scene',
      message: error instanceof Error ? error.message : 'Malformed scene document',
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
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Expected a JSON value');
  return JSON.parse(serialized) as T;
}

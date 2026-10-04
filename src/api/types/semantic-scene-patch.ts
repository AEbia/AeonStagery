import type {
  CharacterPerformanceParams,
  DialogueCompanion,
  CurrentSceneDocument,
  StatementCategory,
  StatementFamily,
  StatementParamsByFamily,
} from './semantic-scene';

type SemanticScenePatchParamsByFamily = {
  [Family in StatementFamily]: Family extends 'characterPerformance'
    ? Omit<CharacterPerformanceParams, 'motion'> & {
        /** Authoring providers submit a motion key; application normalizes it to a v4 resource output. */
        readonly motion?: CharacterPerformanceParams['motion'] | string;
      }
    : StatementParamsByFamily[Family];
};

/** The only patch envelope version currently accepted by semantic authoring. */
export const SEMANTIC_SCENE_PATCH_VERSION = 1 as const;

export type SemanticScenePatchVersion = typeof SEMANTIC_SCENE_PATCH_VERSION;

export type SemanticSceneOperationNameV1 =
  | 'insertStatement'
  | 'insertCompanion'
  | 'updateStatement'
  | 'updateCompanion'
  | 'deleteLine'
  | 'moveLine'
  | 'reorderCompanions';

/** The fixed operation algebra for the semantic scene patch seam (ADR0022/0023). */
export const SEMANTIC_SCENE_OPERATION_NAMES: readonly SemanticSceneOperationNameV1[] = [
  'insertStatement',
  'insertCompanion',
  'updateStatement',
  'updateCompanion',
  'deleteLine',
  'moveLine',
  'reorderCompanions',
] as const;

export type SemanticSceneJsonMergePatchValue =
  | string
  | number
  | boolean
  | null
  | readonly SemanticSceneJsonMergePatchValue[]
  | { readonly [key: string]: SemanticSceneJsonMergePatchValue };

/** JSON Merge Patch is object-shaped at an operation boundary. */
export type SemanticSceneJsonMergePatch = {
  readonly [key: string]: SemanticSceneJsonMergePatchValue;
};

export type SemanticSceneCompanionDraftV1 = {
  [Family in StatementFamily]: {
    readonly anchor: 'start' | 'end';
    readonly offset: number;
    readonly type: Family;
    readonly params: SemanticScenePatchParamsByFamily[Family];
  };
}[StatementFamily];

export type SemanticSceneStatementDraftV1 = {
  [Family in StatementFamily]: {
    readonly type: Family;
    readonly params: SemanticScenePatchParamsByFamily[Family];
    readonly companions?: Family extends 'dialogue'
      ? readonly SemanticSceneCompanionDraftV1[]
      : never;
  };
}[StatementFamily];

/**
 * `kind` is the normal TypeScript-facing discriminator. `op` and
 * `operation` are accepted aliases at the boundary for callers that model
 * the same algebra as JSON-Patch or a tool operation. The runtime requires
 * exactly one matching discriminator.
 */
interface SemanticSceneOperationDiscriminatorV1<Name extends SemanticSceneOperationNameV1> {
  readonly kind?: Name;
  readonly op?: Name;
  readonly operation?: Name;
}

export type SemanticSceneStatementPatchV1 = SemanticSceneJsonMergePatch & {
  readonly type?: StatementFamily;
  readonly params?: SemanticSceneJsonMergePatch | null;
};

export type SemanticSceneCompanionPatchV1 = SemanticSceneJsonMergePatch & {
  readonly anchor?: 'start' | 'end';
  readonly offset?: number;
  readonly type?: StatementFamily;
  readonly params?: SemanticSceneJsonMergePatch | null;
};

export interface SemanticSceneInsertStatementOperationV1
  extends SemanticSceneOperationDiscriminatorV1<'insertStatement'> {
  readonly time: number;
  readonly statement: SemanticSceneStatementDraftV1;
  readonly beforeLine?: number;
}

export interface SemanticSceneInsertCompanionOperationV1
  extends SemanticSceneOperationDiscriminatorV1<'insertCompanion'> {
  readonly parentLine: number;
  readonly companion: SemanticSceneCompanionDraftV1;
  readonly beforeLine?: number;
}

export interface SemanticSceneUpdateStatementOperationV1
  extends SemanticSceneOperationDiscriminatorV1<'updateStatement'> {
  readonly line: number;
  readonly patch: SemanticSceneStatementPatchV1;
}

export interface SemanticSceneUpdateCompanionOperationV1
  extends SemanticSceneOperationDiscriminatorV1<'updateCompanion'> {
  readonly line: number;
  readonly patch: SemanticSceneCompanionPatchV1;
}

export interface SemanticSceneDeleteLineOperationV1
  extends SemanticSceneOperationDiscriminatorV1<'deleteLine'> {
  readonly line: number;
}

export interface SemanticSceneMoveLineOperationV1
  extends SemanticSceneOperationDiscriminatorV1<'moveLine'> {
  readonly line: number;
  /** Absolute scene time, never a delta. */
  readonly time: number;
}

export interface SemanticSceneReorderCompanionsOperationV1
  extends SemanticSceneOperationDiscriminatorV1<'reorderCompanions'> {
  readonly parentLine: number;
  readonly orderedLines: readonly number[];
}

export type SemanticSceneOperationV1 =
  | SemanticSceneInsertStatementOperationV1
  | SemanticSceneInsertCompanionOperationV1
  | SemanticSceneUpdateStatementOperationV1
  | SemanticSceneUpdateCompanionOperationV1
  | SemanticSceneDeleteLineOperationV1
  | SemanticSceneMoveLineOperationV1
  | SemanticSceneReorderCompanionsOperationV1;

export interface SemanticScenePatchV1 {
  readonly version: SemanticScenePatchVersion;
  readonly operations: readonly SemanticSceneOperationV1[];
}

export type SemanticSceneLineKindV1 = 'statement' | 'companion';
export type SemanticSceneLineAccessV1 = 'writable' | 'read-only';

/**
 * A model-facing line never carries the source statement/companion UUID.
 * `durationSeconds`, `category`, `label` and `iconKey` are optional because
 * the compact processor projection omits them (UI/agent presentation layers
 * keep populating them via the full line view).
 */
export interface SemanticSceneLineV1 {
  readonly line: number;
  readonly parentLine?: number;
  readonly kind: SemanticSceneLineKindV1;
  readonly time: number;
  readonly durationSeconds?: number;
  readonly type: StatementFamily;
  readonly category?: StatementCategory;
  readonly label?: string;
  readonly iconKey?: string;
  readonly access: SemanticSceneLineAccessV1;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface SemanticSceneLineViewV1 {
  readonly lines: readonly SemanticSceneLineV1[];
  readonly totalLines: number;
}

export type SemanticSceneLineMapInvalidationReasonV1 =
  | 'none'
  | 'insert'
  | 'delete'
  | 'reorder'
  | 'family-replacement';

export interface SemanticSceneLineMapStateV1 {
  /** The greatest old line that remains safe to address without a refresh. */
  readonly validThroughLine: number;
  readonly refreshRequired: boolean;
  readonly invalidatedFromLine?: number;
  readonly reason: SemanticSceneLineMapInvalidationReasonV1;
}

export interface SemanticScenePatchCountsV1 {
  readonly insertedStatements: number;
  readonly insertedCompanions: number;
  readonly updatedStatements: number;
  readonly updatedCompanions: number;
  readonly deletedLines: number;
  readonly movedLines: number;
  readonly reorderedCompanionGroups: number;
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
  readonly moved: number;
}

export type SemanticScenePatchErrorCodeV1 =
  | 'invalid_arguments'
  | 'wrong_line_kind'
  | 'stale_line_map'
  | 'conflicting_operations'
  | 'forbidden_operation'
  | 'forbidden_family'
  | 'forbidden_path'
  | 'stage_scope_violation'
  | 'schema_validation_failed'
  | 'semantic_validation_failed'
  | 'compiler_validation_failed';

export interface SemanticScenePatchIssueV1 {
  readonly code: SemanticScenePatchErrorCodeV1;
  readonly message: string;
  readonly path?: string;
  readonly operationIndex?: number;
  readonly line?: number;
}

/**
 * A source identity generated for one insert operation, tagged with the
 * source operation index. One insertStatement with bundled draft companions
 * produces one entry per generated object, all sharing the operation index.
 */
export interface SemanticSceneInsertedIdentityV1 {
  readonly operationIndex: number;
  readonly statementId: string;
  readonly companionId?: string;
}

export interface SemanticScenePatchApplyResultV1 {
  readonly status: 'changed' | 'no_change';
  readonly candidate: CurrentSceneDocument;
  /** Alias retained for callers that use “document” for the candidate. */
  readonly document: CurrentSceneDocument;
  readonly lineView: SemanticSceneLineViewV1;
  readonly lineMap: SemanticSceneLineMapStateV1;
  readonly counts: SemanticScenePatchCountsV1;
  readonly warnings: readonly SemanticScenePatchIssueV1[];
  /**
   * Host-generated identities for insert operations, grouped by source
   * operation index and ordered by it (ADR0024). An insertStatement with
   * bundled draft companions yields its statement entry first, then one
   * entry per bundled companion in draft order, all sharing the operation
   * index. Insert results expose these identities to the model; pairing
   * never depends on final document order.
   */
  readonly insertedIdentities: readonly SemanticSceneInsertedIdentityV1[];
}

/** Internal-only helper type for code that needs a companion after parsing. */
export type SemanticSceneMaterializedCompanionV1 = DialogueCompanion;

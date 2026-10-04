import type { ResourceKind } from './project';
import type { CurrentSceneMeta, StatementFamily } from './semantic-scene';
import type {
  SemanticSceneCompanionDraftV1,
  SemanticSceneCompanionPatchV1,
  SemanticSceneLineV1,
  SemanticScenePatchCountsV1,
  SemanticSceneStatementDraftV1,
  SemanticSceneStatementPatchV1,
  SEMANTIC_SCENE_PATCH_VERSION,
} from './semantic-scene-patch';

export const PROJECT_AGENT_TOOLSET_VERSION = 5 as const;

/**
 * Standard conversations receive the bounded project/scene tool surface.
 * Full-access conversations additionally receive a host-mediated terminal
 * tool that runs with the desktop application's OS permissions.
 */
export type ProjectAgentAccessMode = 'standard' | 'full_access';

export type AgentSuggestedAction = 'reread_scene' | 'call_readScene' | 'retry_from_offset_zero' | 'fix_arguments';

export type AgentToolErrorCode =
  | 'scene_not_read'
  | 'source_identity_not_found'
  | 'pagination_changed'
  | 'invalid_arguments'
  | 'wrong_source_kind'
  | 'conflicting_operations'
  | 'schema_validation_failed'
  | 'semantic_validation_failed'
  | 'compiler_validation_failed'
  | 'resource_validation_failed'
  | 'materialization_required'
  | 'version_conflict'
  | 'journal_persist_failed'
  | 'forbidden_path'
  | 'result_too_large'
  | 'vision_unavailable'
  | 'target_scene_unavailable'
  | 'not_found'
  | 'forbidden_operation'
  | 'image_too_large'
  | 'image_mime_mismatch'
  | 'unsupported_image_format'
  | 'image_decode_limit_exceeded'
  | 'terminal_unavailable'
  | 'cancelled';

export interface AgentToolDiagnostic {
  readonly code?: string;
  readonly message: string;
  readonly severity?: 'error' | 'warning' | 'info';
  readonly path?: string;
  readonly operationIndex?: number;
  /** Formal source identity when a write diagnostic can address an object. */
  readonly source?: {
    readonly statementId: string;
    readonly companionId?: string;
  };
}

export interface AgentToolError {
  readonly code: AgentToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly suggestedAction?: AgentSuggestedAction;
  readonly diagnostics?: readonly AgentToolDiagnostic[];
}

export type AgentToolResult<T> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly truncated?: boolean;
      readonly hasMore?: boolean;
      readonly nextOffset?: number;
      readonly nextStartLine?: number;
    }
  | {
      readonly ok: false;
      readonly error: AgentToolError;
    };

export interface AgentPaginationMeta {
  readonly hasMore: boolean;
  /**
   * Always present on list/search results: the offset for the next page,
   * even when hasMore is false (callers can rely on the field existing).
   */
  readonly nextOffset: number;
  readonly truncated?: boolean;
  readonly total?: number;
}

export interface AgentLineRangeMeta {
  readonly hasMore: boolean;
  /**
   * Always present on line-range results: the first line of the next page,
   * even when hasMore is false (callers can rely on the field existing).
   */
  readonly nextStartLine: number;
  readonly truncated?: boolean;
  readonly totalLines?: number;
}

export interface AgentProjectSceneSummary {
  readonly name: string;
  readonly relativePath: string;
}

export interface AgentProjectOverview {
  readonly name: string;
  readonly projectVersion: number;
  readonly activeScene?: AgentProjectSceneSummary;
  readonly scenes: readonly AgentProjectSceneSummary[];
  readonly assetRoots: Readonly<Record<string, string>>;
  readonly templates?: {
    readonly enabledTemplateIds: readonly string[];
    readonly defaults?: Readonly<Record<string, string>>;
  };
}

export interface AgentProjectFileEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly sizeBytes?: number;
  readonly mimeType?: string;
  readonly binary?: boolean;
}

export interface AgentListProjectFilesResult extends AgentPaginationMeta {
  readonly entries: readonly AgentProjectFileEntry[];
  /**
   * Number of project entries filtered out as forbidden/protected paths.
   * Lets callers distinguish an empty project from an all-forbidden view.
   */
  readonly excludedCount: number;
}

export interface AgentReadProjectTextResult extends AgentLineRangeMeta {
  readonly path: string;
  readonly lines: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
  readonly binary?: boolean;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
}

export interface AgentProjectTextHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface AgentSearchProjectTextResult extends AgentPaginationMeta {
  readonly hits: readonly AgentProjectTextHit[];
}

export type AgentResourceScope = 'project' | 'mount' | 'template';

interface AgentResourceCandidateBase {
  readonly displayName: string;
  readonly scope: AgentResourceScope;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly ownerId?: string;
  readonly outfitId?: string;
  readonly namespace?: string;
}

/** A bindable resource file, or a template resource awaiting materialization. */
export interface AgentResourceFileCandidate extends AgentResourceCandidateBase {
  readonly kind: ResourceKind;
  /** Project-relative or `@mount/<id>/...` when directly writable. */
  readonly reference?: string;
  readonly materializationRequired?: true;
}

/**
 * A navigation-only directory returned by `searchResources({ pathPrefix })`.
 * It is deliberately not a resource reference and can never be bound into a
 * scene; pass pathPrefix back to searchResources to browse it.
 */
export interface AgentResourceDirectoryCandidate extends AgentResourceCandidateBase {
  readonly kind: 'directory';
  readonly pathPrefix: string;
  readonly reference?: never;
  readonly materializationRequired?: never;
}

export type AgentResourceCandidate = AgentResourceFileCandidate | AgentResourceDirectoryCandidate;

export interface AgentSearchResourcesResult extends AgentPaginationMeta {
  /** Uniform list key shared with listProjectFiles (was `candidates`). */
  readonly entries: readonly AgentResourceCandidate[];
}

export interface AgentInspectResourceResult {
  readonly exists: boolean;
  readonly reference: string;
  readonly scope: AgentResourceScope;
  readonly kind?: ResourceKind;
  readonly bindable: boolean;
  readonly materializationRequired?: true;
  readonly media?: Readonly<Record<string, unknown>>;
  readonly live2d?: {
    readonly motions?: readonly string[];
    readonly expressions?: readonly string[];
    readonly capabilities?: Readonly<Record<string, unknown>>;
  };
}

export type AgentImageDetail = 'auto' | 'low' | 'high';

/**
 * JSON-safe delivery spec of a readImage payload. Bytes are NEVER part of the
 * tool result: the renderer transport projection re-reads verified bytes for
 * the current model request, so the task journal only ever persists this
 * descriptor (ADR0023: image bytes stay in live memory / current context).
 */
export interface AgentReadImagePayloadSpec {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly detail: AgentImageDetail;
}

export interface AgentReadImageResult {
  readonly reference: string;
  readonly mimeType: string;
  readonly detail: AgentImageDetail;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly deliveredWidth: number;
  readonly deliveredHeight: number;
  readonly scaled: boolean;
  readonly contentFingerprint: string;
  /** Transport projection descriptor; bytes are resolved per request. */
  readonly imagePayload: AgentReadImagePayloadSpec;
  /** True when the source is an animated image delivered as its first frame. */
  readonly animated?: boolean;
  readonly frame?: 'first';
}

export interface AgentCharacterDirectoryEntry {
  readonly id: string;
  readonly name: string;
  readonly model?: string;
  readonly color?: string;
}

/** Formal source identities are opaque but stable for the object's lifetime. */
export interface AgentSceneSourceLine extends SemanticSceneLineV1 {
  readonly statementId: string;
  readonly companionId?: string;
}

export interface AgentReadSceneResult extends AgentLineRangeMeta {
  readonly lines: readonly AgentSceneSourceLine[];
  readonly totalLines: number;
  readonly meta: {
    readonly title: string;
    readonly author?: string;
    readonly durationSeconds?: number;
    readonly resolution?: readonly [number, number];
    readonly fps?: number;
  };
  readonly characters: readonly AgentCharacterDirectoryEntry[];
  readonly startLine: number;
  readonly endLine: number;
}

export interface AgentSceneSearchHit {
  readonly line: AgentSceneSourceLine;
  readonly contextBefore?: readonly AgentSceneSourceLine[];
  readonly contextAfter?: readonly AgentSceneSourceLine[];
}

export interface AgentSearchSceneResult extends AgentPaginationMeta {
  readonly hits: readonly AgentSceneSearchHit[];
}

export type AgentValidationGate =
  | 'schema'
  | 'semantic'
  | 'compiler'
  | 'resource';

export interface AgentValidateSceneDiagnostic {
  readonly gate: AgentValidationGate;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly code?: string;
  readonly path?: string;
  /** Formal source identity when the diagnostic can address a scene object. */
  readonly source?: {
    readonly statementId: string;
    readonly companionId?: string;
  };
}

export interface AgentValidateSceneResult {
  readonly ok: boolean;
  readonly diagnostics: readonly AgentValidateSceneDiagnostic[];
}

export type AgentWriteOutcome =
  | {
      readonly kind: 'inserted';
      readonly statementId: string;
      /**
       * Set for insertCompanion outcomes; mutually exclusive with
       * `insertedCompanionIds` (an insertStatement outcome never carries it).
       */
      readonly companionId?: string;
      /**
       * Generated identities for companions bundled in an insertStatement
       * draft; mutually exclusive with `companionId`.
       */
      readonly insertedCompanionIds?: readonly string[];
    }
  | {
      readonly kind: 'updated';
      /** Only values normalized by the authoritative save are returned. */
      readonly normalized?: SemanticSceneStatementPatchV1 | SemanticSceneCompanionPatchV1;
      /** A root family replacement can remove its former companion identities. */
      readonly deletedCompanions?: readonly {
        readonly statementId: string;
        readonly companionId: string;
      }[];
    }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'moved' }
  | { readonly kind: 'reordered' }
  | { readonly kind: 'no_change' };

export type AgentWriteStatus = 'committed' | 'no_change';

/**
 * Model-visible result for every Project Agent write tool (ADR0024): an
 * ordered outcome per requested operation plus the trusted change counts and
 * warnings. No line locator, line map, refresh flag, or document version ever
 * appears here.
 */
export interface AgentWriteReceipt {
  readonly status: AgentWriteStatus;
  readonly counts: SemanticScenePatchCountsV1;
  readonly warnings: readonly AgentToolDiagnostic[];
  /** Exactly one ordered outcome per requested operation. */
  readonly outcomes: readonly AgentWriteOutcome[];
}

/** Host-only object identity plus change category (ADR0024 UI projection). */
export interface ProjectAgentHostChangedObject {
  readonly statementId: string;
  readonly companionId?: string;
  readonly kind: 'inserted' | 'updated' | 'deleted' | 'moved' | 'reordered';
}

/**
 * Host-only commit facts. They are persisted for recovery/UI activity
 * projection, but must never be serialized into an Agent tool result.
 */
export interface ProjectAgentHostWriteReceipt {
  readonly status: AgentWriteStatus;
  readonly version: number;
  readonly counts: SemanticScenePatchCountsV1;
  readonly warnings: readonly AgentToolDiagnostic[];
  readonly outcomes: readonly AgentWriteOutcome[];
  /** Every source object actually changed by this write, in operation order. */
  readonly changedObjects: readonly ProjectAgentHostChangedObject[];
  /** Affected scene time range [start, end] in scene seconds, when any object changed. */
  readonly timeRange?: { readonly start: number; readonly end: number };
}

export interface AgentReadProjectOverviewArgs {
  readonly _?: never;
}

export interface AgentListProjectFilesArgs {
  readonly offset?: number;
  readonly limit?: number;
  readonly prefix?: string;
}

export interface AgentReadProjectTextArgs {
  /** Project-relative or stable `@mount/<id>/...` text-file reference. */
  readonly path: string;
  readonly startLine?: number;
  readonly lineCount?: number;
}

export interface AgentSearchProjectTextArgs {
  readonly query: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly prefix?: string;
}

export interface AgentSearchResourcesArgs {
  readonly kind?: ResourceKind;
  readonly text?: string;
  readonly ownerId?: string;
  readonly outfitId?: string;
  readonly namespace?: string;
  /** Browse immediate children; with ownerId/outfitId, search recursively below this path. Empty selects the root. */
  readonly pathPrefix?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface AgentInspectResourceArgs {
  readonly reference: string;
}

export interface AgentReadImageArgs {
  readonly reference: string;
  readonly detail?: AgentImageDetail;
}

export type AgentTerminalShell = 'default' | 'powershell';

/**
 * Full-access-only terminal request. `cwd` is intentionally unrestricted:
 * this mode is an explicit opt-in for arbitrary commands under the desktop
 * user's OS permissions.
 */
export interface AgentRunTerminalCommandArgs {
  readonly command: string;
  readonly shell?: AgentTerminalShell;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
}

export interface AgentRunTerminalCommandResult {
  readonly shell: AgentTerminalShell;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

export interface AgentReadSceneArgs {
  readonly startLine?: number;
  readonly lineCount?: number;
}

export interface AgentSearchSceneArgs {
  readonly text?: string;
  readonly family?: StatementFamily;
  readonly timeFrom?: number;
  readonly timeTo?: number;
  readonly offset?: number;
  readonly limit?: number;
  readonly contextLines?: number;
}

export interface AgentValidateSceneArgs {
  readonly _?: never;
}

export interface AgentInsertStatementArgs {
  readonly time: number;
  readonly statement: SemanticSceneStatementDraftV1;
  readonly beforeStatementId?: string;
}

export interface AgentInsertCompanionArgs {
  readonly statementId: string;
  readonly companion: SemanticSceneCompanionDraftV1;
  readonly beforeCompanionId?: string;
}

export interface AgentUpdateStatementArgs {
  readonly statementId: string;
  readonly patch: SemanticSceneStatementPatchV1;
}

export interface AgentUpdateCompanionArgs {
  readonly statementId: string;
  readonly companionId: string;
  readonly patch: SemanticSceneCompanionPatchV1;
}

/** Root targets use statementId; companion targets add parent-local companionId. */
export interface AgentDeleteSourceItemArgs {
  readonly statementId: string;
  readonly companionId?: string;
}

export interface AgentMoveSourceItemArgs {
  readonly statementId: string;
  readonly companionId?: string;
  /** Root moves use absolute scene time, never a delta. */
  readonly time?: number;
  /** Companion moves preserve source-native timing semantics. */
  readonly anchor?: 'start' | 'end';
  readonly offset?: number;
}

export interface AgentSourceInsertStatementOperation {
  readonly kind: 'insertStatement';
  readonly time: number;
  readonly statement: SemanticSceneStatementDraftV1;
  readonly beforeStatementId?: string;
}

export interface AgentSourceUpdateStatementOperation {
  readonly kind: 'updateStatement';
  readonly statementId: string;
  readonly patch: SemanticSceneStatementPatchV1;
}

export interface AgentSourceDeleteStatementOperation {
  readonly kind: 'deleteSourceItem';
  readonly statementId: string;
}

export interface AgentSourceMoveStatementOperation {
  readonly kind: 'moveSourceItem';
  readonly statementId: string;
  readonly companionId?: never;
  readonly time: number;
}

export interface AgentSourceInsertCompanionOperation {
  readonly kind: 'insertCompanion';
  readonly statementId: string;
  readonly companion: SemanticSceneCompanionDraftV1;
  readonly beforeCompanionId?: string;
}

export interface AgentSourceUpdateCompanionOperation {
  readonly kind: 'updateCompanion';
  readonly statementId: string;
  readonly companionId: string;
  readonly patch: SemanticSceneCompanionPatchV1;
}

export interface AgentSourceDeleteCompanionOperation {
  readonly kind: 'deleteSourceItem';
  readonly statementId: string;
  readonly companionId: string;
}

export interface AgentSourceMoveCompanionOperation {
  readonly kind: 'moveSourceItem';
  readonly statementId: string;
  readonly companionId: string;
  readonly anchor: 'start' | 'end';
  readonly offset: number;
}

export interface AgentSourceReorderCompanionsOperation {
  readonly kind: 'reorderCompanions';
  readonly statementId: string;
  readonly orderedCompanionIds: readonly string[];
}

/** The fixed source-identity operation algebra for Project Agent authoring. */
export type AgentSourceAuthoringOperation =
  | AgentSourceInsertStatementOperation
  | AgentSourceInsertCompanionOperation
  | AgentSourceUpdateStatementOperation
  | AgentSourceUpdateCompanionOperation
  | AgentSourceDeleteStatementOperation
  | AgentSourceDeleteCompanionOperation
  | AgentSourceMoveStatementOperation
  | AgentSourceMoveCompanionOperation
  | AgentSourceReorderCompanionsOperation;

export interface AgentReorderCompanionsArgs {
  readonly statementId: string;
  readonly orderedCompanionIds: readonly string[];
}

export interface AgentApplyAuthoringTransactionArgs {
  readonly version: typeof SEMANTIC_SCENE_PATCH_VERSION | 1;
  readonly operations: readonly AgentSourceAuthoringOperation[];
}

export type ProjectAgentToolName =
  | 'readProjectOverview'
  | 'listProjectFiles'
  | 'readProjectText'
  | 'searchProjectText'
  | 'searchResources'
  | 'inspectResource'
  | 'readImage'
  | 'runTerminalCommand'
  | 'readScene'
  | 'searchScene'
  | 'validateScene'
  | 'insertStatement'
  | 'insertCompanion'
  | 'updateStatement'
  | 'updateCompanion'
  | 'deleteSourceItem'
  | 'moveSourceItem'
  | 'reorderCompanions'
  | 'applyAuthoringTransaction';

export type ProjectAgentToolArgsByName = {
  readProjectOverview: AgentReadProjectOverviewArgs | Record<string, never> | undefined;
  listProjectFiles: AgentListProjectFilesArgs;
  readProjectText: AgentReadProjectTextArgs;
  searchProjectText: AgentSearchProjectTextArgs;
  searchResources: AgentSearchResourcesArgs;
  inspectResource: AgentInspectResourceArgs;
  readImage: AgentReadImageArgs;
  runTerminalCommand: AgentRunTerminalCommandArgs;
  readScene: AgentReadSceneArgs;
  searchScene: AgentSearchSceneArgs;
  validateScene: AgentValidateSceneArgs | Record<string, never> | undefined;
  insertStatement: AgentInsertStatementArgs;
  insertCompanion: AgentInsertCompanionArgs;
  updateStatement: AgentUpdateStatementArgs;
  updateCompanion: AgentUpdateCompanionArgs;
  deleteSourceItem: AgentDeleteSourceItemArgs;
  moveSourceItem: AgentMoveSourceItemArgs;
  reorderCompanions: AgentReorderCompanionsArgs;
  applyAuthoringTransaction: AgentApplyAuthoringTransactionArgs;
};

export type ProjectAgentToolResultByName = {
  readProjectOverview: AgentProjectOverview;
  listProjectFiles: AgentListProjectFilesResult;
  readProjectText: AgentReadProjectTextResult;
  searchProjectText: AgentSearchProjectTextResult;
  searchResources: AgentSearchResourcesResult;
  inspectResource: AgentInspectResourceResult;
  readImage: AgentReadImageResult;
  runTerminalCommand: AgentRunTerminalCommandResult;
  readScene: AgentReadSceneResult;
  searchScene: AgentSearchSceneResult;
  validateScene: AgentValidateSceneResult;
  insertStatement: AgentWriteReceipt;
  insertCompanion: AgentWriteReceipt;
  updateStatement: AgentWriteReceipt;
  updateCompanion: AgentWriteReceipt;
  deleteSourceItem: AgentWriteReceipt;
  moveSourceItem: AgentWriteReceipt;
  reorderCompanions: AgentWriteReceipt;
  applyAuthoringTransaction: AgentWriteReceipt;
};

/** Re-export scene meta shape for overview cleaning helpers. */
export type AgentSceneMetaProjection = Pick<
  CurrentSceneMeta,
  'title' | 'author' | 'resolution' | 'fps' | 'durationSeconds'
>;

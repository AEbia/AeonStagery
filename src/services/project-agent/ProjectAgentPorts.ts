import type { ResourceKind } from '../../api/types/project';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type {
  AgentRunTerminalCommandArgs,
  AgentRunTerminalCommandResult,
  AgentImageDetail,
  AgentInspectResourceResult,
  AgentProjectFileEntry,
  AgentProjectOverview,
  AgentProjectTextHit,
  AgentResourceCandidate,
  AgentValidateSceneDiagnostic,
} from '../../api/types/project-agent';

export interface ProjectAgentOverviewPort {
  getOverview(): Promise<AgentProjectOverview> | AgentProjectOverview;
}

/** Plain-array form is kept for legacy fakes; production ports attach a revision. */
export type ProjectAgentFileListResult =
  | readonly AgentProjectFileEntry[]
  | {
      readonly entries: readonly AgentProjectFileEntry[];
      /** Stable scan revision (mtime/size derived) for pagination change detection. */
      readonly revision: string;
      /**
       * Number of protected/forbidden entries skipped during the scan (files
       * plus whole skipped directories), so callers can tell an empty project
       * apart from an all-forbidden view. Legacy plain-array results omit it.
       */
      readonly excludedCount: number;
    };

export interface ProjectAgentFileListPort {
  listFiles(options: {
    prefix?: string;
  }): Promise<ProjectAgentFileListResult> | ProjectAgentFileListResult;
}

export interface ProjectAgentTextReadPort {
  readText(path: string): Promise<{
    lines: readonly string[];
    binary: boolean;
    mimeType?: string;
    sizeBytes?: number;
    /** File exceeds the safe read capacity; must surface as result_too_large. */
    tooLarge?: true;
  }> | {
    lines: readonly string[];
    binary: boolean;
    mimeType?: string;
    sizeBytes?: number;
    tooLarge?: true;
  };
  /**
   * Optional stat-only existence probe (no content read). Used by the tool
   * layer to distinguish `not_found` (missing file) from `forbidden_path`
   * (exists but policy-forbidden). Absent in legacy fakes: the tool layer
   * treats an absent probe as "exists" (forbidden) — the pre-probe default.
   */
  exists?(path: string): Promise<boolean> | boolean;
}

export type ProjectAgentTextSearchResult =
  | readonly AgentProjectTextHit[]
  | {
      readonly hits: readonly AgentProjectTextHit[];
      /** Stable scan revision (content/mtime derived) for pagination change detection. */
      readonly revision: string;
    };

export interface ProjectAgentTextSearchPort {
  searchText(options: {
    query: string;
    prefix?: string;
  }): Promise<ProjectAgentTextSearchResult> | ProjectAgentTextSearchResult;
}

/** Plain-array form is kept for legacy fakes; production ports attach a revision. */
export type ProjectAgentResourceSearchResult =
  | readonly AgentResourceCandidate[]
  | {
      readonly entries: readonly AgentResourceCandidate[];
      /** Stable scan revision (mtime/size derived) for pagination change detection. */
      readonly revision: string;
    };

export interface ProjectAgentResourceSearchPort {
  searchResources(options: {
    kind?: ResourceKind;
    text?: string;
    ownerId?: string;
    outfitId?: string;
    namespace?: string;
    pathPrefix?: string;
  }): Promise<ProjectAgentResourceSearchResult> | ProjectAgentResourceSearchResult;
}

export interface ProjectAgentResourceInspectPort {
  inspectResource(reference: string): Promise<AgentInspectResourceResult> | AgentInspectResourceResult;
  /**
   * Optional stat-only existence probe (no metadata read). Used by the tool
   * layer to distinguish `not_found` from `forbidden_path` on policy-forbidden
   * references. Absent in legacy fakes: treated as "exists" (forbidden).
   */
  exists?(reference: string): Promise<boolean> | boolean;
}

export interface ProjectAgentImageReadPort {
  readImage(options: {
    reference: string;
    detail: AgentImageDetail;
  }): Promise<{
    mimeType: string;
    bytes: Uint8Array;
    originalWidth: number;
    originalHeight: number;
    deliveredWidth: number;
    deliveredHeight: number;
    scaled: boolean;
    contentFingerprint: string;
    /** True when the source is an animated image delivered as its first frame. */
    animated?: boolean;
    frame?: 'first';
  }> | {
    mimeType: string;
    bytes: Uint8Array;
    originalWidth: number;
    originalHeight: number;
    deliveredWidth: number;
    deliveredHeight: number;
    scaled: boolean;
    contentFingerprint: string;
    animated?: boolean;
    frame?: 'first';
  };
  /**
   * Optional stat-only existence probe (no image read). Used by the tool
   * layer to distinguish `not_found` from `forbidden_path` on policy-forbidden
   * references. Absent in legacy fakes: treated as "exists" (forbidden).
   */
  exists?(reference: string): Promise<boolean> | boolean;
}

/**
 * Host-only terminal seam for an explicitly full-access Conversation. The
 * renderer never receives Node process access; its adapter delegates to main.
 */
export interface ProjectAgentTerminalPort {
  runTerminalCommand(
    options: AgentRunTerminalCommandArgs,
    signal?: AbortSignal,
  ): Promise<AgentRunTerminalCommandResult> | AgentRunTerminalCommandResult;
}

export interface ProjectAgentSceneSnapshot {
  readonly document: CurrentSceneDocument;
  readonly version: number;
}

export interface ProjectAgentSceneSnapshotPort {
  getSnapshot(): Promise<ProjectAgentSceneSnapshot | null> | ProjectAgentSceneSnapshot | null;
}

export interface ProjectAgentSceneValidationPort {
  validate(document: CurrentSceneDocument): Promise<readonly AgentValidateSceneDiagnostic[]>
    | readonly AgentValidateSceneDiagnostic[];
}

export interface ProjectAgentAuthoringCommitRequest {
  readonly baseVersion: number;
  readonly baseDocument: CurrentSceneDocument;
  readonly candidate: CurrentSceneDocument;
  /** Host-private resolved locator notes (internal UUIDs; never model-visible). */
  readonly resolvedOperationsNotes?: string;
  /** Opaque fingerprint of the resolved operation data (never replayed). */
  readonly opsFingerprint?: string;
  /** Expected change fingerprint for the durable pending record. */
  readonly expectedChangeFingerprint?: string;
  /**
   * Host cancellation signal (ADR0023): preflight and the mutation-queue wait
   * are cancellable. Once the durable pending record is written AND the
   * authoritative commit has started, the transaction must settle atomically;
   * the signal only gates the phases before that boundary.
   */
  readonly signal?: AbortSignal;
}

export interface ProjectAgentAuthoringCommitResult {
  readonly version: number;
}

export interface ProjectAgentAuthoringPort {
  commit(request: ProjectAgentAuthoringCommitRequest): Promise<ProjectAgentAuthoringCommitResult>
    | ProjectAgentAuthoringCommitResult;
}

export interface ProjectAgentReadPorts {
  readonly overview: ProjectAgentOverviewPort;
  readonly files: ProjectAgentFileListPort;
  readonly text: ProjectAgentTextReadPort;
  readonly textSearch: ProjectAgentTextSearchPort;
  readonly resources: ProjectAgentResourceSearchPort;
  readonly resourceInspect: ProjectAgentResourceInspectPort;
  readonly image?: ProjectAgentImageReadPort;
  readonly scene: ProjectAgentSceneSnapshotPort;
  readonly validation: ProjectAgentSceneValidationPort;
}

export interface ProjectAgentWritePorts {
  readonly scene: ProjectAgentSceneSnapshotPort;
  readonly validation: ProjectAgentSceneValidationPort;
  readonly authoring: ProjectAgentAuthoringPort;
}

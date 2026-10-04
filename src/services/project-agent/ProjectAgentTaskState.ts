import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import { sceneDocumentCodec } from '../semantic-scene/SceneDocumentCodec';
import { SemanticSceneLineView } from '../semantic-scene/SemanticSceneLineView';
import type { ProjectAgentSceneSnapshot } from './ProjectAgentPorts';

export const PROJECT_AGENT_SCENE_BINDING_BLOB_VERSION = 1 as const;

/** JSON-safe scene binding retained for recovery between execution rounds. */
export interface ProjectAgentSceneBindingBlob {
  readonly bindingVersion: typeof PROJECT_AGENT_SCENE_BINDING_BLOB_VERSION;
  readonly document: CurrentSceneDocument;
  readonly version: number;
  readonly readAt: number;
}

export interface ProjectAgentSceneBinding {
  readonly document: CurrentSceneDocument;
  readonly version: number;
  readonly lineView: SemanticSceneLineView;
  readonly readAt: number;
}

export interface PaginationCursorState {
  readonly revision: string;
  readonly queryKey: string;
}

/**
 * Host-owned task execution state kept outside the model context.
 * Snapshot + line map + pagination revisions for a single project Agent task.
 */
export class ProjectAgentTaskState {
  private sceneBinding: ProjectAgentSceneBinding | null = null;
  /** Binding from the last completed tool round, safe to recover after a pause. */
  private durableSceneBinding: ProjectAgentSceneBinding | null = null;
  private readonly pagination = new Map<string, PaginationCursorState>();
  /**
   * One snapshot captured at the start of a parallel read group (ADR0023):
   * every scene tool in the group reads this exact document + version, so
   * concurrent calls cannot disagree even when the source mutates mid-group.
   */
  private groupSceneSnapshot: ProjectAgentSceneSnapshot | null = null;

  getSceneBinding(): ProjectAgentSceneBinding | null {
    return this.sceneBinding;
  }

  hasSceneRead(): boolean {
    return this.sceneBinding !== null;
  }

  /** Binding that was last promoted from a completed tool round. */
  getDurableSceneBinding(): ProjectAgentSceneBinding | null {
    return this.durableSceneBinding;
  }

  getGroupSceneSnapshot(): ProjectAgentSceneSnapshot | null {
    return this.groupSceneSnapshot;
  }

  setGroupSceneSnapshot(snapshot: ProjectAgentSceneSnapshot | null): void {
    this.groupSceneSnapshot = snapshot;
  }

  clearGroupSceneSnapshot(): void {
    this.groupSceneSnapshot = null;
  }

  bindSceneRead(document: CurrentSceneDocument, version: number, now = Date.now()): ProjectAgentSceneBinding {
    const lineView = new SemanticSceneLineView(document);
    const binding: ProjectAgentSceneBinding = {
      document,
      version,
      lineView,
      readAt: now,
    };
    this.sceneBinding = binding;
    return binding;
  }

  advanceAfterContentWrite(
    document: CurrentSceneDocument,
    version: number,
  ): ProjectAgentSceneBinding {
    const lineView = new SemanticSceneLineView(document);
    const binding: ProjectAgentSceneBinding = {
      document,
      version,
      lineView,
      readAt: this.sceneBinding?.readAt ?? Date.now(),
    };
    this.sceneBinding = binding;
    return binding;
  }

  /**
   * Promote the current binding after the whole assistant tool round has been
   * persisted. Reads from a partially discarded round must never be promoted.
   */
  markSceneBindingDurable(): void {
    if (this.sceneBinding) this.durableSceneBinding = this.sceneBinding;
  }

  /** Restore the last completed-round binding into the active execution state. */
  restoreDurableSceneBinding(): boolean {
    if (!this.durableSceneBinding) return false;
    this.sceneBinding = this.durableSceneBinding;
    return true;
  }

  /** Serialize only the host-owned facts needed to rebuild the line map. */
  getDurableSceneBindingBlob(): ProjectAgentSceneBindingBlob | undefined {
    const binding = this.durableSceneBinding;
    if (!binding) return undefined;
    return {
      bindingVersion: PROJECT_AGENT_SCENE_BINDING_BLOB_VERSION,
      document: structuredClone(binding.document),
      version: binding.version,
      readAt: binding.readAt,
    };
  }

  /**
   * Validate and restore a journal binding. Invalid/corrupt recovery data is
   * ignored rather than becoming an authorization to write an unknown scene.
   */
  restoreSceneBinding(value: unknown): boolean {
    if (!isSceneBindingBlob(value)) return false;
    try {
      const document = sceneDocumentCodec.parseAndValidate(value.document);
      const binding: ProjectAgentSceneBinding = {
        document,
        version: value.version,
        lineView: new SemanticSceneLineView(document),
        readAt: value.readAt,
      };
      this.sceneBinding = binding;
      this.durableSceneBinding = binding;
      return true;
    } catch {
      return false;
    }
  }

  clearSceneBinding(): void {
    this.sceneBinding = null;
  }

  /**
   * Returns true when the revision matches the stored one (or first page).
   * On mismatch, caller should return pagination_changed.
   */
  checkPaginationRevision(queryKey: string, revision: string, offset: number): 'ok' | 'changed' {
    const existing = this.pagination.get(queryKey);
    if (!existing) {
      this.pagination.set(queryKey, { revision, queryKey });
      return 'ok';
    }
    if (existing.revision !== revision) {
      if (offset === 0) {
        this.pagination.set(queryKey, { revision, queryKey });
        return 'ok';
      }
      return 'changed';
    }
    return 'ok';
  }

  setPaginationRevision(queryKey: string, revision: string): void {
    this.pagination.set(queryKey, { revision, queryKey });
  }

  clearPagination(): void {
    this.pagination.clear();
  }

  clear(): void {
    this.sceneBinding = null;
    this.durableSceneBinding = null;
    this.pagination.clear();
    this.groupSceneSnapshot = null;
  }

  /** End an execution boundary while retaining the last completed read. */
  clearRuntimeState(): void {
    this.sceneBinding = null;
    this.pagination.clear();
    this.groupSceneSnapshot = null;
  }
}

function isSceneBindingBlob(value: unknown): value is ProjectAgentSceneBindingBlob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.bindingVersion === PROJECT_AGENT_SCENE_BINDING_BLOB_VERSION
    && Number.isSafeInteger(candidate.version)
    && (candidate.version as number) >= 0
    && typeof candidate.readAt === 'number'
    && Number.isFinite(candidate.readAt)
    && candidate.document !== undefined;
}

/**
 * Stable diagnostic codes. Codes are part of the diagnostics contract: UI and
 * tests branch on them, messages stay free-form for humans.
 */
export type ValidationIssueCode =
  | 'resource.mount.unbound'
  | 'resource.mount.root-missing'
  | 'resource.missing'
  | 'resource.reference.invalid'
  | 'resource.unreadable'
  | 'scene.unreadable';

/**
 * Structured detail attached to aggregated external-library diagnostics: one
 * entry per mount id, carrying counts across the whole project so the UI can
 * offer a single bind/replace action instead of per-reference noise.
 */
export interface ValidationMountDetail {
  mountId: string;
  /** Aggregated availability state for this mount in the current project. */
  status: 'mount-unbound' | 'mount-root-missing' | 'asset-missing';
  /** Distinct @mount references using this mount across all scanned scenes. */
  referenceCount: number;
  /** Distinct scenes that reference this mount. */
  sceneCount: number;
  /** Machine-local binding path currently configured for this project/mount. */
  bindingPath?: string;
  /** Stale bound root when status is mount-root-missing. */
  staleRoot?: string;
  /** A few representative missing/attempted relative paths (bounded). */
  sampleReferences: string[];
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  actionIndex?: number;
  actionType?: string;
  actionId?: string;
  /** Stable machine-readable code (see ValidationIssueCode). */
  code?: ValidationIssueCode | string;
  /** Document location for editor highlighting/jump-to. */
  location?: string;
  /** Scene id for project-wide dependency diagnostics. */
  sceneId?: string;
  /** Present on aggregated external-library issues (code resource.mount.*). */
  mount?: ValidationMountDetail;
}

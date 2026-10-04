export interface CompatibilityIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface MigrationPlanResult<TSession> {
  readonly document: unknown;
  readonly session: TSession;
  readonly warnings: readonly string[];
}

export interface MigrationPlan<TSession> {
  readonly sourceEpoch: number;
  readonly targetEpoch: number;
  readonly stages?: readonly string[];
  readonly warnings: readonly string[];
  readonly migrate: () => MigrationPlanResult<TSession>;
}

export type CompatibilityOutcome<TSession> =
  | { readonly status: 'ready'; readonly session: TSession }
  | { readonly status: 'migration_required'; readonly plan: MigrationPlan<TSession> }
  | { readonly status: 'incompatible'; readonly issue: CompatibilityIssue }
  | { readonly status: 'invalid'; readonly issue: CompatibilityIssue };

export type ArtifactMigrationPolicy = 'gated' | 'automatic';

export interface ArtifactCompatibilityAdapter<
  TSource = unknown,
  TProjection = unknown,
  TSession = unknown,
> {
  readonly artifactKind: string;
  readonly migrationPolicy: ArtifactMigrationPolicy;
  inspect(input: unknown): CompatibilityOutcome<TSession>;
  serialize(session: TSession): unknown;
  parseProjection?(source: TSource): TProjection;
  resolveBackupRelativePath?(artifactPath: string, now: Date, basename: string): string;
  createInvalidIssue?(message: string): CompatibilityIssue;
}

export interface MigrationConfirmationRequest {
  readonly artifactPath?: string;
  readonly scenePath?: string;
  readonly backupPath: string;
  readonly sourceEpoch: number;
  readonly targetEpoch: number;
  readonly stages: readonly string[];
  readonly warnings: readonly string[];
  readonly artifactKind?: string;
}

export interface MigrationConfirmationPresenter {
  show(request: MigrationConfirmationRequest): void;
  clear(): void;
}

export interface CoordinatorFileAccessPort {
  readFile(path: string): Promise<{ data: string }>;
  writeFile(path: string, content: string): Promise<void>;
  copyFile?(sourcePath: string, destPath: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  dirname(path: string): Promise<string> | string;
  basename(path: string): Promise<string> | string;
}

export interface CoordinatorBackupResolverPort {
  resolveForProjectWrite(relativePath: string): Promise<string> | string;
}

export type AdmissionOutcome<TSession> =
  | {
      readonly status: 'ready';
      readonly session: TSession;
      readonly migrated: false;
      readonly path: string;
    }
  | {
      readonly status: 'migrated';
      readonly session: TSession;
      readonly migrated: true;
      readonly path: string;
      readonly backupPath?: string;
      readonly stages?: readonly string[];
      readonly warnings: readonly string[];
      readonly sourceEpoch: number;
      readonly targetEpoch: number;
    }
  | {
      readonly status: 'cancelled';
      readonly path: string;
      readonly reason: 'declined' | 'user_cancelled';
    }
  | {
      readonly status: 'incompatible';
      readonly path: string;
      readonly issue: CompatibilityIssue;
    }
  | {
      readonly status: 'invalid';
      readonly path: string;
      readonly issue: CompatibilityIssue;
    };

export interface CompatibilityCoordinatorOptions {
  readonly fileAccess: CoordinatorFileAccessPort;
  readonly backupResolver?: CoordinatorBackupResolverPort;
  readonly confirmationPresenter?: MigrationConfirmationPresenter;
  readonly confirmMigration?: (request: MigrationConfirmationRequest) => Promise<boolean>;
  readonly now?: () => Date;
}

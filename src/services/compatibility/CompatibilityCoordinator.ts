import type {
  AdmissionOutcome,
  ArtifactCompatibilityAdapter,
  CompatibilityCoordinatorOptions,
  CompatibilityOutcome,
  CoordinatorBackupResolverPort,
  CoordinatorFileAccessPort,
  MigrationConfirmationRequest,
} from './types';
import { MigrationConfirmationAdapter } from './MigrationConfirmationAdapter';

export class CompatibilityCoordinator {
  private readonly fileAccess: CoordinatorFileAccessPort;
  private readonly backupResolver?: CoordinatorBackupResolverPort;
  private readonly confirmationAdapter?: MigrationConfirmationAdapter;
  private readonly confirmMigrationCallback?: (request: MigrationConfirmationRequest) => Promise<boolean>;
  private readonly now: () => Date;

  constructor(options: CompatibilityCoordinatorOptions) {
    this.fileAccess = options.fileAccess;
    this.backupResolver = options.backupResolver;
    if (options.confirmationPresenter) {
      this.confirmationAdapter = new MigrationConfirmationAdapter(options.confirmationPresenter);
    }
    this.confirmMigrationCallback = options.confirmMigration;
    this.now = options.now ?? (() => new Date());
  }

  get confirmation(): MigrationConfirmationAdapter | undefined {
    return this.confirmationAdapter;
  }

  inspect<TSource, TProjection, TSession>(
    input: unknown,
    adapter: ArtifactCompatibilityAdapter<TSource, TProjection, TSession>,
  ): CompatibilityOutcome<TSession> {
    return adapter.inspect(input);
  }

  async admit<TSource, TProjection, TSession>(
    artifactPath: string,
    adapter: ArtifactCompatibilityAdapter<TSource, TProjection, TSession>,
  ): Promise<AdmissionOutcome<TSession>> {
    let data: string;

    if (this.fileAccess.exists) {
      const fileExists = await this.fileAccess.exists(artifactPath);
      if (!fileExists) {
        try {
          const result = await this.fileAccess.readFile(artifactPath);
          data = result.data;
        } catch {
          return {
            status: 'invalid',
            path: artifactPath,
            issue: adapter.createInvalidIssue
              ? adapter.createInvalidIssue(`File does not exist at ${artifactPath}`)
              : {
                  code: 'file_not_found',
                  message: `Artifact file does not exist at ${artifactPath}`,
                },
          };
        }
      } else {
        try {
          const result = await this.fileAccess.readFile(artifactPath);
          data = result.data;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to read file';
          return {
            status: 'invalid',
            path: artifactPath,
            issue: adapter.createInvalidIssue
              ? adapter.createInvalidIssue(message)
              : {
                  code: 'read_error',
                  message,
                },
          };
        }
      }
    } else {
      try {
        const result = await this.fileAccess.readFile(artifactPath);
        data = result.data;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to read file';
        return {
          status: 'invalid',
          path: artifactPath,
          issue: adapter.createInvalidIssue
            ? adapter.createInvalidIssue(message)
            : {
                code: 'read_error',
                message,
              },
        };
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid JSON file';
      return {
        status: 'invalid',
        path: artifactPath,
        issue: adapter.createInvalidIssue
          ? adapter.createInvalidIssue(message.toLowerCase().includes('json') ? 'invalid JSON' : message)
          : {
              code: 'malformed_json',
              message,
            },
      };
    }

    const outcome = adapter.inspect(parsed);
    if (outcome.status === 'ready') {
      return {
        status: 'ready',
        session: outcome.session,
        migrated: false,
        path: artifactPath,
      };
    }

    if (outcome.status === 'incompatible') {
      return {
        status: 'incompatible',
        path: artifactPath,
        issue: outcome.issue,
      };
    }

    if (outcome.status === 'invalid') {
      return {
        status: 'invalid',
        path: artifactPath,
        issue: outcome.issue,
      };
    }

    // outcome.status === 'migration_required'
    // Execute detached migration stage in memory first
    let migrationResult: ReturnType<typeof outcome.plan.migrate>;
    try {
      migrationResult = outcome.plan.migrate();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Migration failed';
      return {
        status: 'invalid',
        path: artifactPath,
        issue: adapter.createInvalidIssue
          ? adapter.createInvalidIssue(message)
          : { code: 'migration_failed', message },
      };
    }

    if (adapter.migrationPolicy === 'gated') {
      const timestamp = timestampPathPart(this.now());
      const rawBasename = await this.fileAccess.basename(artifactPath);
      const basename = sanitizePathPart(rawBasename);
      const backupRelativePath = adapter.resolveBackupRelativePath
        ? adapter.resolveBackupRelativePath(artifactPath, this.now(), basename)
        : `.aeonstagery/backups/${timestamp}/${basename}`;

      const backupPath = this.backupResolver
        ? await this.backupResolver.resolveForProjectWrite(backupRelativePath)
        : await this.resolveFallbackBackupPath(artifactPath, backupRelativePath);

      // Create backup of the original file
      await this.fileAccess.ensureDir(await this.fileAccess.dirname(backupPath));
      if (this.fileAccess.copyFile && (await this.fileAccess.exists(artifactPath))) {
        await this.fileAccess.copyFile(artifactPath, backupPath);
      } else {
        await this.fileAccess.writeFile(backupPath, data);
      }

      // Prompt user for confirmation
      const request: MigrationConfirmationRequest = {
        artifactPath,
        scenePath: artifactPath,
        backupPath,
        sourceEpoch: outcome.plan.sourceEpoch,
        targetEpoch: outcome.plan.targetEpoch,
        stages: outcome.plan.stages ?? [],
        warnings: outcome.plan.warnings,
        artifactKind: adapter.artifactKind,
      };

      let confirmed = false;
      if (this.confirmMigrationCallback) {
        confirmed = await this.confirmMigrationCallback(request);
      } else if (this.confirmationAdapter) {
        confirmed = await this.confirmationAdapter.request(request);
      } else {
        confirmed = false;
      }

      if (!confirmed) {
        return {
          status: 'cancelled',
          path: artifactPath,
          reason: 'declined',
        };
      }

      // On user confirmation: write upgraded document in-place
      const serialized = adapter.serialize(migrationResult.session);
      await this.fileAccess.writeFile(
        artifactPath,
        JSON.stringify(serialized !== undefined ? serialized : migrationResult.document, null, 2),
      );

      return {
        status: 'migrated',
        session: migrationResult.session,
        migrated: true,
        path: artifactPath,
        backupPath,
        stages: outcome.plan.stages,
        warnings: migrationResult.warnings,
        sourceEpoch: outcome.plan.sourceEpoch,
        targetEpoch: outcome.plan.targetEpoch,
      };
    }

    // Automatic migration policy: overwrite immediately without backup or prompt
    const serialized = adapter.serialize(migrationResult.session);
    await this.fileAccess.writeFile(
      artifactPath,
      JSON.stringify(serialized !== undefined ? serialized : migrationResult.document, null, 2),
    );

    return {
      status: 'migrated',
      session: migrationResult.session,
      migrated: true,
      path: artifactPath,
      stages: outcome.plan.stages,
      warnings: migrationResult.warnings,
      sourceEpoch: outcome.plan.sourceEpoch,
      targetEpoch: outcome.plan.targetEpoch,
    };
  }

  openArtifact<TSource, TProjection, TSession>(
    artifactPath: string,
    adapter: ArtifactCompatibilityAdapter<TSource, TProjection, TSession>,
  ): Promise<AdmissionOutcome<TSession>> {
    return this.admit(artifactPath, adapter);
  }

  private async resolveFallbackBackupPath(artifactPath: string, relativeBackup: string): Promise<string> {
    const dir = await this.fileAccess.dirname(artifactPath);
    const separator = artifactPath.includes('\\') ? '\\' : '/';
    const normalizedRelative = relativeBackup.replace(/\//g, separator);
    return `${dir}${separator}${normalizedRelative}`;
  }
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact.json';
}

function timestampPathPart(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

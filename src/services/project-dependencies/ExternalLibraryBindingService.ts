import { normalizeMountId } from '../../api/types/project';
import type { ProjectExternalLibraryBindings } from '../../api/types/project';
import type {
  ProjectDependencyReport,
  ProjectDependencyScanner,
  ProjectMountDependency,
} from './ProjectDependencyScanner';
import type { ProjectResourceService } from '../io/ProjectResourceService';

export interface BindDirectoryResult {
  ok: boolean;
  /** Machine-readable failure reason for user-facing toasts. */
  reason?: 'no-project' | 'unknown-mount' | 'no-expected-files' | 'none-matched';
  message?: string;
  report?: ProjectDependencyReport | null;
}

export interface ExternalLibraryBindingPorts {
  getBindings(): ProjectExternalLibraryBindings;
  setBindings(next: ProjectExternalLibraryBindings): void;
  /** Absolute-path join + existence probe against the chosen directory. */
  fileExistsInDirectory(directory: string, relativePath: string): Promise<boolean>;
  /** Drop resolution caches (project resources, validation daemon, scans). */
  invalidateCaches(): void;
  /** Re-run the project dependency scan and refresh diagnostics. */
  rescan(): Promise<ProjectDependencyReport | null>;
  /** Re-project the current scene so newly bound resources appear at once. */
  reprojectCurrentScene(): Promise<void>;
}

/**
 * Machine-local project ↔ external-library binding management. Bindings are
 * stored per project in local settings only; scene documents keep referencing
 * stable `@mount/<id>/...` identities untouched.
 */
export class ExternalLibraryBindingService {
  constructor(
    private projectResources: ProjectResourceService,
    private scanner: ProjectDependencyScanner,
    private ports: ExternalLibraryBindingPorts,
  ) {}

  /** Every mount id observed by the last scan for the active project. */
  listProjectMounts(): ProjectMountDependency[] {
    return this.scanner.getLastReport()?.allMounts ?? [];
  }

  getBinding(mountId: string): string | undefined {
    const project = this.projectResources.getCurrentProject();
    const normalizedMountId = normalizeMountId(mountId);
    if (!project || !normalizedMountId) return undefined;
    return this.ports.getBindings()[project.metadata.projectId]?.[normalizedMountId];
  }

  /**
   * Bind (or rebind) a mount to a local directory. The directory is accepted
   * only when it actually contains at least one of the files the project
   * expects under that mount — a wrong folder pick must not silently shadow
   * other resolution tiers.
   */
  async bindMountDirectory(mountId: string, rawDirectory: string): Promise<BindDirectoryResult> {
    const project = this.projectResources.getCurrentProject();
    if (!project) return { ok: false, reason: 'no-project' };

    const normalizedMountId = normalizeMountId(mountId);
    if (!normalizedMountId) return { ok: false, reason: 'unknown-mount' };
    const directory = normalizeBoundDirectory(rawDirectory);
    if (!directory) return { ok: false, reason: 'none-matched' };

    const report = this.scanner.getLastReport() ?? await this.scanner.scan();
    if (!report) return { ok: false, reason: 'no-project' };
    const mount = report.allMounts.find((candidate) => candidate.mountId === normalizedMountId);
    if (!mount) return { ok: false, reason: 'unknown-mount' };
    if (mount.references.length === 0) return { ok: false, reason: 'no-expected-files' };

    const expected = mount.references;
    let matched = false;
    for (const relativePath of expected) {
      if (await this.ports.fileExistsInDirectory(directory, relativePath)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return {
        ok: false,
        reason: 'none-matched',
        message: `所选目录中找不到该资源库预期的任何文件（例如 "${expected[0]}"）`,
      };
    }

    this.writeBinding(project.metadata.projectId, normalizedMountId, directory);
    return this.afterBindingChange();
  }

  /** Remove the project binding; resolution falls back to embedded/global. */
  async unbindMount(mountId: string): Promise<BindDirectoryResult> {
    const project = this.projectResources.getCurrentProject();
    if (!project) return { ok: false, reason: 'no-project' };
    const normalizedMountId = normalizeMountId(mountId);
    if (!normalizedMountId) return { ok: false, reason: 'unknown-mount' };
    this.writeBinding(project.metadata.projectId, normalizedMountId, null);
    return this.afterBindingChange();
  }

  private async afterBindingChange(): Promise<BindDirectoryResult> {
    this.ports.invalidateCaches();
    this.scanner.invalidateLastReport();
    const report = await this.ports.rescan();
    // A failed reprojection must not report the binding as failed — the
    // binding is already persisted and the next reload picks it up.
    try {
      await this.ports.reprojectCurrentScene();
    } catch (error) {
      console.error('[ExternalLibraryBinding] Failed to reproject the current scene:', error);
    }
    return { ok: true, report };
  }

  private writeBinding(projectId: string, mountId: string, directory: string | null): void {
    const next: ProjectExternalLibraryBindings = {};
    for (const [id, mounts] of Object.entries(this.ports.getBindings())) {
      next[id] = { ...mounts };
    }
    const mounts = next[projectId] ?? (next[projectId] = {});
    if (directory === null) {
      delete mounts[mountId];
      if (Object.keys(mounts).length === 0) delete next[projectId];
    } else {
      mounts[mountId] = normalizeBoundDirectory(directory);
    }
    this.ports.setBindings(next);
  }
}

/** Trim first, then drop trailing separators: " D:/lib/ " → "D:/lib". */
function normalizeBoundDirectory(directory: string): string {
  return directory.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

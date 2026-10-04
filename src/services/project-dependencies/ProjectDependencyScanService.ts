import type { ProjectOpenDependencySnapshot } from '../../api/interfaces/IProjectOpenWorkflow';
import type { ValidationIssue } from '../../api/types/validation';
import { toMountDetail } from './ProjectDependencyScanner';
import type { ProjectDependencyReport } from './ProjectDependencyScanner';
import type { ProjectDependencyScanner } from './ProjectDependencyScanner';

/**
 * Sink for the `project-dependencies` validation slice. Keeping it a port lets
 * the scanner stay independent of the UI store.
 */
export interface ProjectDependencyIssueSink {
  setProjectDependencyIssues(issues: ValidationIssue[]): void;
}

/**
 * Bridges {@link ProjectDependencyScanner} to its two consumers: the open
 * workflow receives a compact snapshot, the validation store receives the
 * per-mount diagnostics slice. Both share one scan so a degraded open never
 * scans the project twice.
 */
export class ProjectDependencyScanService {
  constructor(
    private scanner: ProjectDependencyScanner,
    private issueSink: ProjectDependencyIssueSink,
  ) {}

  /** Run a scan and publish its diagnostics. Never throws for degraded assets. */
  async scan(): Promise<ProjectDependencyReport | null> {
    const report = await this.scanner.scan();
    this.issueSink.setProjectDependencyIssues(report?.issues ?? []);
    return report;
  }

  async scanProjectDependencies(): Promise<ProjectOpenDependencySnapshot | null> {
    const report = await this.scan();
    if (!report) return null;
    return {
      scenesScanned: report.scenesScanned,
      degraded: report.degraded,
      degradedMounts: report.mounts.map(toMountDetail),
    };
  }
}

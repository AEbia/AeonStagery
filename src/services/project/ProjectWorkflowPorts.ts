import type { RecentProjectEntry } from '../../ui/SettingsStore';

export interface ProjectRecentsPort {
  upsertRecentProject(entry: RecentProjectEntry): void;
}

export interface ProjectWorkflowSettingsPort {
  setAssetsPath(path: string): void;
}

import type { ProjectState } from '../../api/types/project';

export class ProjectSession {
  private currentProject: ProjectState | null = null;
  private listeners = new Set<() => void>();

  getCurrentProject(): ProjectState | null {
    return this.currentProject;
  }

  setCurrentProject(project: ProjectState | null): void {
    this.currentProject = project;
    this.listeners.forEach((listener) => listener());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

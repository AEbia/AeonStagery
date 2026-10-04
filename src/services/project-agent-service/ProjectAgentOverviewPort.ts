import type {
  AgentProjectOverview,
  AgentProjectSceneSummary,
} from '../../api/types/project-agent';
import { normalizeProjectRelativePath } from '../project-agent/ProjectAgentPathRules';
import type { ProjectAgentOverviewPort } from '../project-agent/ProjectAgentPorts';

export interface ProjectAgentOverviewSceneEntry {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface ProjectAgentOverviewSource {
  readonly name: string;
  readonly projectVersion: number;
  readonly activeScene?: {
    readonly name: string;
    readonly path: string;
  };
  readonly scenes: readonly ProjectAgentOverviewSceneEntry[];
  readonly assetRoots?: Readonly<Record<string, unknown>>;
  readonly templates?: {
    readonly enabledTemplateIds: readonly string[];
    readonly defaults?: Readonly<Record<string, unknown>>;
  };
}

function cleanProjectName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function sceneSummary(scene: {
  readonly name: string;
  readonly path: string;
}): AgentProjectSceneSummary | null {
  // Only clean project-relative scene paths may reach the Agent; absolute
  // paths and traversal are dropped (fail closed).
  const path = normalizeProjectRelativePath(scene.path);
  if (!path.ok) return null;
  return {
    name: scene.name.trim(),
    relativePath: path.path,
  };
}

function cleanAssetRoots(assetRoots: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(assetRoots ?? {})) {
    if (typeof value !== 'string') continue;
    const root = normalizeProjectRelativePath(value);
    if (!root.ok) continue;
    cleaned[key] = root.path;
  }
  return cleaned;
}

/**
 * ADR0023 readProjectOverview sanitizer: cleaned project name, project
 * version, active scene name/relative path, scene list, asset roots and
 * template info. Never returns projectId, defaultSceneId, scene entry IDs,
 * local absolute paths or voice preset paths.
 */
export function sanitizeProjectAgentOverview(
  source: ProjectAgentOverviewSource,
): AgentProjectOverview {
  const assetRoots = cleanAssetRoots(source.assetRoots);
  const scenes = source.scenes
    .map(sceneSummary)
    .filter((scene): scene is AgentProjectSceneSummary => scene !== null);
  const overview: AgentProjectOverview = {
    name: cleanProjectName(source.name),
    projectVersion: source.projectVersion,
    scenes,
    assetRoots,
  };
  if (source.activeScene) {
    const active = sceneSummary(source.activeScene);
    if (active) {
      (overview as { activeScene?: AgentProjectSceneSummary }).activeScene = active;
    }
  }
  if (source.templates) {
    const defaults: Record<string, string> = {};
    for (const [key, value] of Object.entries(source.templates.defaults ?? {})) {
      if (typeof value === 'string') defaults[key] = value;
    }
    (overview as { templates?: AgentProjectOverview['templates'] }).templates = {
      enabledTemplateIds: [...source.templates.enabledTemplateIds],
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    };
  }
  return overview;
}

export function createProjectAgentOverviewPort(options: {
  getSource(): ProjectAgentOverviewSource;
}): ProjectAgentOverviewPort {
  return {
    getOverview: () => sanitizeProjectAgentOverview(options.getSource()),
  };
}

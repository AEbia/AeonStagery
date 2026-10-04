import type { CurrentSceneDocument, SceneStatement } from '../../api/types/semantic-scene';
import type { ProjectExternalLibraryBindings, ResourceResolution } from '../../api/types/project';
import { getProjectExternalLibraryBinding } from '../../api/types/project';
import type { ValidationIssue, ValidationMountDetail } from '../../api/types/validation';
import type { ProjectSceneEntry } from '../../api/types/project';
import type { ProjectResourceService } from '../io/ProjectResourceService';
import { sceneStatementDefinitionRegistry } from '../semantic-scene';
import { MOUNT_ID_SOURCE } from '../../api/types/project';

const SAMPLE_LIMIT = 6;
const REFERENCE_LIST_LIMIT = 200;

/** Availability tiers that make a mount degraded (everything but `ready`). */
export type DegradedMountStatus = Exclude<ProjectMountDependency['status'], 'ready'>;

export function isDegradedMount(
  mount: ProjectMountDependency,
): mount is ProjectMountDependency & { status: DegradedMountStatus } {
  return mount.status !== 'ready';
}

/** Aggregated availability of one stable mount identity across the project. */
export interface ProjectMountDependency {
  mountId: string;
  /** Worst availability tier observed for this mount in any scene. */
  status: 'ready' | 'mount-unbound' | 'mount-root-missing' | 'asset-missing';
  /** Distinct references (deduped by normalized mount path) using this mount. */
  referenceCount: number;
  /** Scene ids that reference this mount. */
  sceneIds: string[];
  /** Local directory currently bound for this project + mount, if any. */
  bindingPath?: string;
  /** The stale bound root when status is mount-root-missing. */
  staleRoot?: string;
  /** Representative mount-relative references (bounded by SAMPLE_LIMIT). */
  sampleReferences: string[];
  /** All deduplicated mount-relative references (bounded, for bind checks). */
  references: string[];
  /** Missing file details for asset-missing (deduped per scene + reference). */
  missing: Array<{ sceneId: string; relativePath: string }>;
}

export interface ProjectDependencyReport {
  scannedAt: number;
  projectId: string;
  /** Change-detection signature over mount statuses and bindings. */
  signature: string;
  scenesScanned: number;
  /** Degraded mounts only (drives the aggregated warnings). */
  mounts: Array<ProjectMountDependency & { status: DegradedMountStatus }>;
  /** Every mount observed in the project, bound and ready included. */
  allMounts: ProjectMountDependency[];
  issues: ValidationIssue[];
  /** Whether any project dependency could not be resolved on this machine. */
  degraded: boolean;
}

interface SceneReader {
  readSceneDocument(scene: ProjectSceneEntry): Promise<CurrentSceneDocument | null>;
}

/**
 * Scans every scene registered in project.json (with the active unsaved
 * document overlaid) and aggregates all `@mount` dependencies per stable
 * mount id. Produces the project-level diagnostics slice and the open-flow
 * dependency snapshot; never throws for degraded resources.
 */
export class ProjectDependencyScanner {
  private lastReport: ProjectDependencyReport | null = null;

  constructor(
    private projectResources: ProjectResourceService,
    private sceneReader: SceneReader,
    private getBindings: () => ProjectExternalLibraryBindings = () => ({}),
    private getUnsavedDocument: () => { path: string; document: CurrentSceneDocument } | null = () => null,
  ) {}

  getLastReport(): ProjectDependencyReport | null {
    return this.lastReport;
  }

  invalidateLastReport(): void {
    this.lastReport = null;
  }

  async scan(): Promise<ProjectDependencyReport | null> {
    const project = this.projectResources.getCurrentProject();
    if (!project) return null;

    const scenes = project.metadata.scenes ?? [];
    const unsaved = this.getUnsavedDocument();
    const perReference = new Map<string, {
      mountId: string;
      relativePath: string;
      scenes: Set<string>;
      resolution?: ResourceResolution;
    }>();

    let scenesScanned = 0;
    const unreadableIssues: ValidationIssue[] = [];

    for (const scene of scenes) {
      let document: CurrentSceneDocument | null = null;
      if (unsaved && unsaved.path === scene.path) {
        // Current editing state wins over the on-disk copy.
        document = unsaved.document;
      } else {
        try {
          document = await this.sceneReader.readSceneDocument(scene);
        } catch {
          document = null;
        }
      }
      scenesScanned += 1;
      if (!document) {
        unreadableIssues.push({
          severity: 'error',
          code: 'scene.unreadable',
          message: `场景 "${scene.name}"（${scene.path}）无法读取，依赖扫描已跳过该场景`,
          sceneId: scene.id,
        });
        continue;
      }
      for (const reference of collectSceneAssetReferences(document)) {
        if (!reference.startsWith('@mount/')) continue;
        const parsed = parseMountReference(reference);
        if (!parsed) continue;
        const existing = perReference.get(reference);
        if (existing) {
          existing.scenes.add(scene.id);
          continue;
        }
        perReference.set(reference, {
          mountId: parsed.mountId,
          relativePath: parsed.relativePath,
          scenes: new Set([scene.id]),
        });
      }
    }

    const resolutions = new Map<string, ResourceResolution>();
    const probeFailures: ValidationIssue[] = [];
    const referencesByMount = new Map<string, string[]>();
    for (const [reference, entry] of perReference) {
      const references = referencesByMount.get(entry.mountId) ?? [];
      references.push(reference);
      referencesByMount.set(entry.mountId, references);
    }

    // Mounts are probed in parallel; inside one mount a missing library makes
    // every remaining reference fail identically, so probing stops there.
    await Promise.all(Array.from(referencesByMount.values()).map(async (references) => {
      for (let index = 0; index < references.length; index += 1) {
        const reference = references[index];
        let resolution: ResourceResolution;
        try {
          resolution = await this.projectResources.resolveStatus(reference);
        } catch (error) {
          // A filesystem failure is not a broken reference, and it hits the
          // whole mount: report it once instead of per reference.
          probeFailures.push({
            severity: 'error',
            code: 'resource.unreadable',
            message: `外部资源库 "${perReference.get(reference)?.mountId ?? reference}" 无法读取：${error instanceof Error ? error.message : String(error)}`,
          });
          break;
        }
        resolutions.set(reference, resolution);
        if (resolution.status === 'mount-unbound' || resolution.status === 'mount-root-missing') {
          const terminal = resolution;
          for (let cursor = index + 1; cursor < references.length; cursor += 1) {
            const nextReference = references[cursor];
            resolutions.set(nextReference, {
              ...terminal,
              reference: nextReference,
              relativePath: perReference.get(nextReference)?.relativePath ?? terminal.relativePath,
            });
          }
          break;
        }
      }
    }));

    const byMount = new Map<string, ProjectMountDependency>();
    const issues: ValidationIssue[] = [...unreadableIssues, ...probeFailures];

    const ensureAggregate = (mountId: string): ProjectMountDependency => {
      let aggregate = byMount.get(mountId);
      if (!aggregate) {
        aggregate = {
          mountId,
          status: 'ready',
          referenceCount: 0,
          sceneIds: [],
          sampleReferences: [],
          references: [],
          missing: [],
        };
        byMount.set(mountId, aggregate);
      }
      return aggregate;
    };

    for (const [reference, entry] of perReference) {
      const resolution = resolutions.get(reference);
      if (!resolution) continue;
      if (resolution.status === 'invalid-reference') {
        issues.push({
          severity: 'error',
          code: 'resource.reference.invalid',
          message: `资源引用无效: ${reference}（${resolution.reason}）`,
        });
        continue;
      }
      // This scan is restricted to @mount references; a project-relative
      // missing asset is reported by the scene validation path instead.
      if (resolution.status === 'project-asset-missing') continue;
      const mountId = entry.mountId;
      const relativePath = resolution.relativePath;
      const aggregate = ensureAggregate(mountId);
      aggregate.referenceCount += 1;
      const sceneIds = new Set([...aggregate.sceneIds, ...entry.scenes]);
      aggregate.sceneIds = Array.from(sceneIds).sort();
      if (aggregate.sampleReferences.length < SAMPLE_LIMIT) aggregate.sampleReferences.push(relativePath);
      if (aggregate.references.length < REFERENCE_LIST_LIMIT) aggregate.references.push(relativePath);
      aggregate.bindingPath = getProjectExternalLibraryBinding(this.getBindings(), project.metadata.projectId, mountId);
      if (resolution.status === 'ready') continue;

      // Worst-tier promotion: unbound > root missing > asset missing.
      const rank: Record<'ready' | 'asset-missing' | 'mount-root-missing' | 'mount-unbound', number> = {
        ready: -1,
        'asset-missing': 0,
        'mount-root-missing': 1,
        'mount-unbound': 2,
      };
      if (rank[resolution.status] > rank[aggregate.status]) aggregate.status = resolution.status;
      if (resolution.status === 'asset-missing') {
        for (const sceneId of entry.scenes) {
          aggregate.missing.push({ sceneId, relativePath });
        }
      }
      if (resolution.status === 'mount-root-missing') {
        aggregate.staleRoot = resolution.root;
        aggregate.bindingPath = resolution.root;
      }
    }

    const mounts = Array.from(byMount.values())
      .filter(isDegradedMount)
      .sort((a, b) => a.mountId.localeCompare(b.mountId));
    const allMounts = Array.from(byMount.values()).sort((a, b) => a.mountId.localeCompare(b.mountId));
    for (const mount of mounts) {
      if (mount.status === 'mount-unbound' || mount.status === 'mount-root-missing') {
        issues.push({
          severity: 'warning',
          code: mount.status === 'mount-unbound' ? 'resource.mount.unbound' : 'resource.mount.root-missing',
          message: mount.status === 'mount-unbound'
            ? `外部资源库 "${mount.mountId}" 未在本机配置：${mount.sceneIds.length} 个场景共 ${mount.referenceCount} 处引用（相关资源已跳过）`
            : `外部资源库 "${mount.mountId}" 绑定的目录不存在（${mount.staleRoot ?? mount.bindingPath ?? '?'}）：共 ${mount.referenceCount} 处引用（相关资源已跳过）`,
          mount: toMountDetail(mount),
        });
      } else {
        for (const missing of mount.missing) {
          issues.push({
            severity: 'error',
            code: 'resource.missing',
            message: `外部资源库 "${mount.mountId}" 中缺少资源: ${missing.relativePath}`,
            sceneId: missing.sceneId,
            location: `scene["${missing.sceneId}"].assets["${missing.relativePath}"]`,
          });
        }
      }
    }

    const signature = allMounts
      .map((mount) => `${mount.mountId}:${mount.status}:${mount.bindingPath ?? ''}:${mount.referenceCount}`)
      .join('|');

    const report: ProjectDependencyReport = {
      scannedAt: Date.now(),
      projectId: project.metadata.projectId,
      signature,
      scenesScanned,
      mounts,
      allMounts,
      issues,
      degraded: mounts.length > 0 || unreadableIssues.length > 0 || probeFailures.length > 0,
    };
    this.lastReport = report;
    return report;
  }
}

/** Structured mount detail shared by the validation slice and the open snapshot. */
export function toMountDetail(
  mount: ProjectMountDependency & { status: DegradedMountStatus },
): ValidationMountDetail {
  return {
    mountId: mount.mountId,
    status: mount.status,
    referenceCount: mount.referenceCount,
    sceneCount: mount.sceneIds.length,
    ...(mount.bindingPath !== undefined ? { bindingPath: mount.bindingPath } : {}),
    ...(mount.staleRoot !== undefined ? { staleRoot: mount.staleRoot } : {}),
    sampleReferences: [...mount.sampleReferences],
  };
}

const MOUNT_SEGMENT = new RegExp(`^@mount/(${MOUNT_ID_SOURCE})/(.+)$`);

function parseMountReference(reference: string): { mountId: string; relativePath: string } | null {
  const match = MOUNT_SEGMENT.exec(reference.replace(/\\/g, '/').trim());
  if (!match) return null;
  const relative = match[2].replace(/^\/+/, '');
  if (!relative || relative.split('/').some((segment) => segment === '..' || segment === '.' || !segment)) return null;
  return { mountId: match[1], relativePath: relative };
}

/**
 * Every asset-bearing string a scene document depends on: character default
 * models and outfit variants, all statement and companion asset references,
 * and the declared source asset slots.
 */
export function collectSceneAssetReferences(document: CurrentSceneDocument): string[] {
  const refs = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) refs.add(value.trim());
  };

  for (const character of document.meta.characters ?? []) {
    add(character.model);
    for (const variant of character.variants ?? []) add(variant.model);
  }

  const visit = (statement: SceneStatement) => {
    for (const asset of sceneStatementDefinitionRegistry.collectAssetReferences(statement)) add(asset.value);
    for (const slot of sceneStatementDefinitionRegistry.sourceAssetSlots(statement)) {
      const value = readSlotValue(statement.params, slot.path);
      add(value);
    }
  };
  for (const statement of document.statements) {
    visit(statement);
    for (const companion of statement.companions ?? []) {
      visit({
        id: companion.id,
        time: statement.time,
        type: companion.type,
        params: companion.params,
      } as SceneStatement);
    }
  }
  return Array.from(refs);
}

function readSlotValue(params: unknown, slotPath: string): unknown {
  // Slot paths are of the form `params.<field>[.<nested>]`.
  if (!slotPath.startsWith('params.')) return undefined;
  let cursor: unknown = params;
  for (const segment of slotPath.slice('params.'.length).split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

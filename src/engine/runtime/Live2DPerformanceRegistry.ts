import type { PreparedAssetRef } from '../../api/types/semantic-scene';
import type {
  Live2DPerformanceModelBinding,
  Live2DPerformanceResource,
  PerformanceCompatibility,
  PreparedPerformance,
} from './Live2DRuntimeContracts';

export interface Live2DPerformanceRegistryOptions {
  resolveModel?: (modelId: string) => Live2DPerformanceModelBinding | null | Promise<Live2DPerformanceModelBinding | null>;
}
type ModelResolver = NonNullable<Live2DPerformanceRegistryOptions['resolveModel']>;

const incompatible = (diagnostic: string): PerformanceCompatibility => ({
  status: 'incompatible',
  missingParameterIds: [],
  ignoredParameterIds: [],
  diagnostics: [diagnostic],
});

function mergeCompatibility(
  first: PerformanceCompatibility,
  second: PerformanceCompatibility,
): PerformanceCompatibility {
  const status = first.status === 'incompatible' || second.status === 'incompatible'
    ? 'incompatible'
    : first.status === 'partial' || second.status === 'partial'
      ? 'partial'
      : 'compatible';
  return {
    status,
    missingParameterIds: Array.from(new Set([...first.missingParameterIds, ...second.missingParameterIds])),
    ignoredParameterIds: Array.from(new Set([...first.ignoredParameterIds, ...second.ignoredParameterIds])),
    diagnostics: [...first.diagnostics, ...second.diagnostics],
  };
}

function validatePreparedAsset(asset: PreparedAssetRef): PerformanceCompatibility {
  if (asset.unavailable || !asset.runtimeUri.trim()) {
    return incompatible(`Prepared performance asset "${asset.source}" is unavailable.`);
  }
  return { status: 'compatible', missingParameterIds: [], ignoredParameterIds: [], diagnostics: [] };
}

export class Live2DPerformanceRegistry {
  private readonly resources = new Map<string, Live2DPerformanceResource>();
  private readonly models = new Map<string, Live2DPerformanceModelBinding>();
  private readonly registeredByModel = new Map<string, Set<string>>();
  private readonly modelGenerations = new Map<string, number>();
  private readonly resolveModel?: ModelResolver;

  constructor(options: Live2DPerformanceRegistryOptions | ModelResolver = {}) {
    if (typeof options === 'function') {
      this.resolveModel = options;
      return;
    }
    this.resolveModel = options.resolveModel;
  }

  /** Register or replace a project prepared resource by its stable runtime key. */
  async register(resource: Live2DPerformanceResource): Promise<void> {
    if (!resource.runtimeKey.trim()) throw new Error('Live2D performance runtimeKey must not be empty.');
    const previous = this.resources.get(resource.runtimeKey);
    if (previous && previous.kind !== resource.kind) {
      throw new Error(`Live2D performance key "${resource.runtimeKey}" is already registered as ${previous.kind}.`);
    }
    if (previous) {
      for (const [modelId, keys] of this.registeredByModel) {
        if (!keys.has(resource.runtimeKey)) continue;
        const binding = this.models.get(modelId);
        if (binding) {
          binding.handle.externalPerformances.unregister(resource.runtimeKey);
        }
        keys.delete(resource.runtimeKey);
      }
    }
    this.resources.set(resource.runtimeKey, resource);
  }

  /** Bind a loaded model instance to this registry before preparing resources. */
  bindModel(modelId: string, binding: Live2DPerformanceModelBinding): void {
    if (!modelId.trim()) throw new Error('Live2D performance modelId must not be empty.');
    this.models.set(modelId, binding);
    this.modelGenerations.set(modelId, (this.modelGenerations.get(modelId) ?? 0) + 1);
  }

  async prepare(modelId: string, resource: Live2DPerformanceResource): Promise<PreparedPerformance> {
    await this.register(resource);
    const binding = await this.resolveBinding(modelId);
    if (!binding) {
      return { resource, compatibility: incompatible(`Live2D model "${modelId}" is not bound.`), registered: false };
    }
    const generation = this.modelGenerations.get(modelId) ?? 0;

    let compatibility = validatePreparedAsset(resource.asset);
    const familyCompatible = binding.runtimeFamily === resource.runtimeFamily
      || (binding.runtimeFamily === 'wmdl' && resource.runtimeFamily === 'cubism2');
    if (!familyCompatible) {
      compatibility = mergeCompatibility(compatibility, incompatible(
        `Live2D performance runtime family "${resource.runtimeFamily}" is incompatible with model family "${binding.runtimeFamily}".`,
      ));
    }

    compatibility = mergeCompatibility(compatibility, this.checkRequiredParameters(binding.handle, resource));
    if (compatibility.status === 'incompatible') {
      return { resource, compatibility, registered: false };
    }

    try {
      const report = await binding.handle.externalPerformances.register(resource);
      compatibility = mergeCompatibility(compatibility, report);
      const required = resource.metadata?.requiredParameterIds ?? [];
      const partialRequired = report.missingParameterIds.some((id) => required.includes(id));
      if (partialRequired && resource.metadata?.allowPartial !== true) {
        compatibility = mergeCompatibility(compatibility, incompatible(
          `Live2D performance "${resource.runtimeKey}" reported missing required parameters without allowPartial.`,
        ));
      }
    } catch (error) {
      compatibility = mergeCompatibility(compatibility, incompatible(
        `Failed to register Live2D performance "${resource.runtimeKey}": ${String(error)}`,
      ));
    }

    if ((this.modelGenerations.get(modelId) ?? 0) !== generation || this.models.get(modelId)?.handle !== binding.handle) {
      binding.handle.externalPerformances.unregister(resource.runtimeKey);
      return {
        resource,
        compatibility: incompatible(`Live2D model "${modelId}" was released during performance preparation.`),
        registered: false,
      };
    }

    const registered = compatibility.status !== 'incompatible';
    if (registered) {
      let keys = this.registeredByModel.get(modelId);
      if (!keys) {
        keys = new Set<string>();
        this.registeredByModel.set(modelId, keys);
      }
      keys.add(resource.runtimeKey);
    }
    return { resource, compatibility, registered };
  }

  releaseModel(modelId: string): void {
    const binding = this.models.get(modelId);
    const keys = this.registeredByModel.get(modelId);
    if (binding && keys) {
      for (const key of keys) binding.handle.externalPerformances.unregister(key);
    }
    this.registeredByModel.delete(modelId);
    this.models.delete(modelId);
    this.modelGenerations.set(modelId, (this.modelGenerations.get(modelId) ?? 0) + 1);
  }

  private async resolveBinding(modelId: string): Promise<Live2DPerformanceModelBinding | null> {
    const bound = this.models.get(modelId);
    if (bound) return bound;
    if (!this.resolveModel) return null;
    const resolved = await this.resolveModel(modelId);
    if (resolved) this.models.set(modelId, resolved);
    return resolved;
  }

  private checkRequiredParameters(
    handle: Live2DPerformanceModelBinding['handle'],
    resource: Live2DPerformanceResource,
  ): PerformanceCompatibility {
    const required = resource.metadata?.requiredParameterIds ?? [];
    if (required.length === 0) return { status: 'compatible', missingParameterIds: [], ignoredParameterIds: [], diagnostics: [] };

    const metadata = handle.parameters.getParameterMetadata();
    const inspected = handle.inspectParameters();
    const available = new Set((metadata ?? inspected ?? []).map(parameter => parameter.id));
    if (available.size === 0) {
      const allowPartial = resource.metadata?.allowPartial === true;
      return {
        status: allowPartial ? 'partial' : 'incompatible',
        missingParameterIds: required,
        ignoredParameterIds: [],
        diagnostics: [allowPartial
          ? 'Target parameter ids could not be inspected; continuing because partial registration was explicitly allowed.'
          : 'Target parameter ids could not be inspected; required parameters cannot be verified.'],
      };
    }

    const missing = required.filter((id) => !available.has(id));
    if (missing.length === 0) return { status: 'compatible', missingParameterIds: [], ignoredParameterIds: [], diagnostics: [] };
    const allowPartial = resource.metadata?.allowPartial === true;
    return {
      status: allowPartial ? 'partial' : 'incompatible',
      missingParameterIds: missing,
      ignoredParameterIds: [],
      diagnostics: [allowPartial
        ? `Required Live2D parameters missing; continuing with partial registration: ${missing.join(', ')}.`
        : `Required Live2D parameters are missing: ${missing.join(', ')}.`],
    };
  }
}

import type {
  CompiledAction,
  CompiledScene,
  PreparedAssetRef,
  PreparedCompiledAction,
  PreparedCompiledScene,
  PreparedRuntimeActionParams,
  PreparedRuntimeValue,
} from '../../api/types/semantic-scene';

export type RuntimeAssetResolver = (
  source: string,
  context: {
    readonly action: CompiledAction;
    readonly paramPath: string;
  },
) => string | Promise<string>;

export interface RuntimeAssetPreparerOptions {
  readonly resolveAsset: RuntimeAssetResolver;
}

export class RuntimeAssetPreparer {
  private readonly resolveAsset: RuntimeAssetResolver;

  constructor(options: RuntimeAssetResolver | RuntimeAssetPreparerOptions) {
    if (typeof options === 'function') {
      this.resolveAsset = options;
    } else {
      this.resolveAsset = options.resolveAsset;
    }
  }

  async prepare(compiled: CompiledScene): Promise<PreparedCompiledScene> {
    const actions = await Promise.all(
      compiled.actions.map(async (action) => prepareAction(action, this.resolveAsset)),
    );
    return deepFreeze({
      kind: 'prepared-compiled-scene',
      sourceSchemaVersion: compiled.sourceSchemaVersion,
      sceneId: compiled.sceneId,
      meta: cloneJson(compiled.meta),
      ...(compiled.visual ? { visual: cloneJson(compiled.visual) } : {}),
      durationSeconds: compiled.durationSeconds,
      actions,
    });
  }
}

async function prepareAction(
  action: CompiledAction,
  resolveAsset: RuntimeAssetResolver,
): Promise<PreparedCompiledAction> {
  const assetPaths = new Set((action.assetSlots ?? []).map((slot) => slot.path));
  return deepFreeze({
    ...cloneJson(action),
    params: await prepareParams(action.params, action, resolveAsset, 'params', assetPaths),
  });
}

async function prepareParams(
  params: Record<string, unknown>,
  action: CompiledAction,
  resolveAsset: RuntimeAssetResolver,
  path: string,
  assetPaths: ReadonlySet<string>,
): Promise<PreparedRuntimeActionParams> {
  const next: PreparedRuntimeActionParams = {};
  for (const [key, value] of Object.entries(params)) {
    const valuePath = `${path}.${key}`;
    next[key] = await prepareValue(value, action, resolveAsset, valuePath, assetPaths);
  }
  return next;
}

async function prepareValue(
  value: unknown,
  action: CompiledAction,
  resolveAsset: RuntimeAssetResolver,
  path: string,
  assetPaths: ReadonlySet<string>,
): Promise<PreparedRuntimeValue> {
  if (assetPaths.has(path) && typeof value === 'string') {
    if (value.trim() === '') return value;
    try {
      const runtimeUri = await resolveAsset(value, { action, paramPath: path });
      if (typeof runtimeUri !== 'string' || runtimeUri.trim() === '') {
        throw new Error('Asset resolver returned an empty runtime URI');
      }
      return deepFreeze({
        source: value,
        runtimeUri,
      } satisfies PreparedAssetRef);
    } catch (error) {
      return deepFreeze({
        source: value,
        runtimeUri: '',
        unavailable: true,
        unavailableReason: error instanceof Error ? error.message : String(error),
      } satisfies PreparedAssetRef);
    }
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item, index) => prepareValue(item, action, resolveAsset, `${path}[${index}]`, assetPaths)));
  }
  if (value && typeof value === 'object') {
    const next: Record<string, PreparedRuntimeValue> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const nestedPath = `${path}.${key}`;
      next[key] = await prepareValue(nested, action, resolveAsset, nestedPath, assetPaths);
    }
    return next;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  throw new Error(`Unsupported runtime param value at ${path}`);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}

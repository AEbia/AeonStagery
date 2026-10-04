import type {
  PreparedAssetRef,
  PreparedCompiledScene,
  PreparedRuntimeValue,
} from '../api/types/semantic-scene';
import type { RuntimeTimelineAction, RuntimeTimelineScene } from './RuntimeTimelineScene';

export function preparedSceneToRuntimeTimelineScene(scene: PreparedCompiledScene): RuntimeTimelineScene {
  return {
    sceneId: scene.sceneId,
    meta: cloneJson(scene.meta),
    ...(scene.visual ? { visual: cloneJson(scene.visual) } : {}),
    timeline: scene.actions.map((action, index): RuntimeTimelineAction => ({
      _id: action.id,
      _seq: index + 1,
      time: action.time,
      action: action.action,
      params: unwrapPreparedValue(action.params) as Record<string, unknown>,
    })),
  };
}

export function unwrapPreparedValue(value: PreparedRuntimeValue): unknown {
  if (isPreparedAssetRef(value)) return value.unavailable ? '' : value.runtimeUri;
  if (Array.isArray(value)) return value.map((item) => unwrapPreparedValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, unwrapPreparedValue(nested)]),
    );
  }
  return value;
}

export function isPreparedAssetRef(value: unknown): value is PreparedAssetRef {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as PreparedAssetRef).source === 'string'
    && typeof (value as PreparedAssetRef).runtimeUri === 'string';
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

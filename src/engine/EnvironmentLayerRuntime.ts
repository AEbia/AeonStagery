import type { RuntimeTimelineAction, RuntimeTimelineScene } from './RuntimeTimelineScene';
import {
  BACKGROUND_LAYER_ID,
  createEnvironmentState,
  getDefaultEnvironmentTransform,
  isEnvironmentAction,
  type EnvironmentLayerState,
  type EnvironmentLayerRenderState,
  type EnvironmentLayerRenderImage,
} from './environmentLayerModel';

export interface EnvironmentLayerTimelineDiagnostic {
  layerId: string;
  kind: 'overlapping-transition';
  actionIds: string[];
  timeRange: [number, number];
  message: string;
}

export interface EnvironmentLayerRenderPlanEntry extends EnvironmentLayerRenderState {
  active: boolean;
}

export interface EnvironmentLayerRenderPlan {
  entries: EnvironmentLayerRenderPlanEntry[];
}

export interface EnvironmentLayerRuntimeSnapshot {
  background: EnvironmentLayerRenderState | null;
  environmentLayers: Map<string, EnvironmentLayerRenderState>;
  layerOrder?: Map<string, number>;
}

type TimedEnvironmentAction = RuntimeTimelineAction & {
  _originalIndex: number;
  time: number;
  params: Record<string, any>;
};

export interface EnvironmentLayerCompileState {
  layersById: Record<string, EnvironmentLayerState | undefined>;
}

function cloneRenderState(state: EnvironmentLayerRenderState): EnvironmentLayerRenderState {
  return {
    ...state,
    images: state.images.map((entry) => ({ ...entry })),
  };
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function applyInterpolatedTransform(
  entry: EnvironmentLayerRenderState,
  source: EnvironmentLayerRenderState,
  target: Record<string, any>,
  progress: number,
): void {
  if (target.x !== undefined && source.x !== undefined) {
    entry.x = source.x + (target.x - source.x) * progress;
  }
  if (target.y !== undefined && source.y !== undefined) {
    entry.y = source.y + (target.y - source.y) * progress;
  }
  if (target.scale !== undefined && source.scale !== undefined) {
    entry.scale = source.scale + (target.scale - source.scale) * progress;
  }
  if (target.rotation !== undefined && source.rotation !== undefined) {
    entry.rotation = source.rotation + (target.rotation - source.rotation) * progress;
  }
  if (target.opacity !== undefined && source.opacity !== undefined) {
    entry.opacity = source.opacity + (target.opacity - source.opacity) * progress;
  }
  if (target.z !== undefined && source.z !== undefined) {
    entry.z = source.z + (target.z - source.z) * progress;
  }
}

function getLayerId(action: RuntimeTimelineAction): string {
  return String(action.params?.layerId || BACKGROUND_LAYER_ID);
}

function inheritDefinedParams(
  target: Record<string, any>,
  source: EnvironmentLayerState,
  keys: Array<keyof EnvironmentLayerState>,
): void {
  for (const key of keys) {
    if (target[key] === undefined && source[key] !== undefined) {
      target[key] = source[key];
    }
  }
}

function getTransitionDuration(action: RuntimeTimelineAction): number {
  const duration = action.params?.duration;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    ? duration
    : 0;
}

function isTransitionAction(action: RuntimeTimelineAction): boolean {
  if (!isEnvironmentAction(action)) return false;
  if (action.action === 'removeEnvironmentLayer') {
    return (action.params?.transition ?? 'fadeOut') !== 'none';
  }
  return getTransitionDuration(action) > 0;
}

function normalizeTimedEnvironmentActions(script: RuntimeTimelineScene): TimedEnvironmentAction[] {
  return script.timeline
    .map((action, index) => ({
      ...action,
      _originalIndex: index,
      time: action.time ?? 0,
      params: action.params || {},
    }))
    .filter((action): action is TimedEnvironmentAction => isEnvironmentAction(action))
    .sort((a, b) => a.time - b.time);
}

export function createEnvironmentLayerCompileState(): EnvironmentLayerCompileState {
  return { layersById: {} };
}

export function applyEnvironmentActionCompileDefaults(
  action: RuntimeTimelineAction,
  compiledParams: Record<string, any>,
  state: EnvironmentLayerCompileState,
): void {
  if (!isEnvironmentAction(action)) return;

  const layerId = String(compiledParams.layerId || BACKGROUND_LAYER_ID);
  const lastLayer = state.layersById[layerId] || createEnvironmentState({ layerId });

  if (action.action === 'setEnvironmentLayer') {
    inheritDefinedParams(compiledParams, lastLayer, [
      'image',
      'label',
      'layoutMode',
      'tileScaleX',
      'tileScaleY',
      'tileOffsetX',
      'tileOffsetY',
      'x',
      'y',
      'scale',
      'rotation',
      'opacity',
      'z',
    ]);
    state.layersById[layerId] = { ...lastLayer, ...compiledParams, layerId };
  } else if (action.action === 'transformEnvironmentLayer') {
    inheritDefinedParams(compiledParams, lastLayer, [
      'x',
      'y',
      'scale',
      'rotation',
      'opacity',
      'z',
    ]);
    state.layersById[layerId] = { ...lastLayer, ...compiledParams, layerId };
  } else if (action.action === 'removeEnvironmentLayer') {
    state.layersById[layerId] = undefined;
  }
}

export function reconstructEnvironmentAtTime(
  script: RuntimeTimelineScene,
  time: number,
): EnvironmentLayerRuntimeSnapshot {
  const environmentLayers = new Map<string, EnvironmentLayerRenderState>();
  const layerOrder = new Map<string, number>();
  let nextLayerOrder = 0;

  for (const action of normalizeTimedEnvironmentActions(script)) {
    if (action.time > time) break;

    const p = action.params;
    const layerId = getLayerId(action);
    switch (action.action) {
      case 'setEnvironmentLayer': {
        const startTime = action.time;
        const duration = p.duration ?? 1;
        const prev = environmentLayers.get(layerId);
        if (!prev && !layerOrder.has(layerId)) {
          layerOrder.set(layerId, nextLayerOrder);
          nextLayerOrder++;
        }
        const sourceState = prev
          ? cloneRenderState(prev)
          : {
              ...createEnvironmentState({
                layerId,
                ...getDefaultEnvironmentTransform(),
              }),
              images: [] as Array<{ image: string; weight: number }>,
            };
        const nextBase = {
          ...(
            prev || {
              ...createEnvironmentState({
                layerId,
                ...getDefaultEnvironmentTransform(),
              }),
              images: [],
            }
          ),
          ...createEnvironmentState({ ...p, layerId }),
        };
        const nextImage = nextBase.image;
        const prevImage = prev?.image;
        const progress = duration > 0 ? clampProgress((time - startTime) / duration) : 1;
        let images: EnvironmentLayerRenderImage[] = nextImage ? [{ image: nextImage, weight: 1 }] : [];

        if (
          p.transition === 'crossFade' &&
          nextImage &&
          (!prevImage || prevImage !== nextImage) &&
          time < startTime + duration
        ) {
          images = prevImage
            ? [
                { image: prevImage, weight: 1 - progress, transform: createEnvironmentState(sourceState) },
                { image: nextImage, weight: progress },
              ]
            : [{ image: nextImage, weight: progress }];
        } else if (
          p.transition === 'fadeIn' &&
          nextImage &&
          time < startTime + duration
        ) {
          images = [{ image: nextImage, weight: progress }];
        }

        const renderState: EnvironmentLayerRenderState = {
          ...nextBase,
          images,
        };
        if (time < startTime + duration && duration > 0) {
          applyInterpolatedTransform(renderState, sourceState, p, progress);
        }
        environmentLayers.set(layerId, renderState);
        break;
      }
      case 'transformEnvironmentLayer': {
        const entry = environmentLayers.get(layerId);
        if (!entry) break;
        const startTime = action.time;
        const duration = p.duration ?? 1;
        const source = cloneRenderState(entry);
        if (time >= startTime + duration || duration <= 0) {
          applyInterpolatedTransform(entry, source, p, 1);
        } else if (time > startTime) {
          applyInterpolatedTransform(entry, source, p, clampProgress((time - startTime) / duration));
        }
        break;
      }
      case 'removeEnvironmentLayer': {
        const entry = environmentLayers.get(layerId);
        if (!entry) break;
        const startTime = action.time;
        const duration = p.duration ?? 1;
        if ((p.transition ?? 'fadeOut') === 'none' || duration <= 0) {
          environmentLayers.delete(layerId);
          break;
        }
        if (time >= startTime + duration) {
          environmentLayers.delete(layerId);
          break;
        }
        if (time >= startTime) {
          entry.opacityMultiplier = 1 - clampProgress((time - startTime) / duration);
        }
        break;
      }
    }
  }

  return {
    background: environmentLayers.get(BACKGROUND_LAYER_ID) ?? null,
    environmentLayers,
    layerOrder,
  };
}

export function validateEnvironmentTimeline(script: RuntimeTimelineScene): EnvironmentLayerTimelineDiagnostic[] {
  const diagnostics: EnvironmentLayerTimelineDiagnostic[] = [];
  const intervalsByLayer = new Map<
    string,
    Array<{ start: number; end: number; actionId: string; actionIndex: number }>
  >();

  for (const action of normalizeTimedEnvironmentActions(script)) {
    if (!isTransitionAction(action)) continue;
    const duration = getTransitionDuration(action);
    if (duration <= 0) continue;
    const layerId = getLayerId(action);
    const intervals = intervalsByLayer.get(layerId) || [];
    intervals.push({
      start: action.time,
      end: action.time + duration,
      actionId: action._id || `${action.action}:${action._originalIndex ?? intervals.length}`,
      actionIndex: action._originalIndex ?? 0,
    });
    intervalsByLayer.set(layerId, intervals);
  }

  for (const [layerId, intervals] of intervalsByLayer) {
    const sorted = intervals.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      const overlapStart = Math.max(previous.start, current.start);
      const overlapEnd = Math.min(previous.end, current.end);
      if (overlapEnd > overlapStart + 0.01) {
        diagnostics.push({
          layerId,
          kind: 'overlapping-transition',
          actionIds: [previous.actionId, current.actionId],
          timeRange: [overlapStart, overlapEnd],
          message: `Environment Layer "${layerId}" 在 ${overlapStart.toFixed(2)}s ~ ${overlapEnd.toFixed(2)}s 存在重叠 transition，seek/scrub 时可能出现非预期中间态。`,
        });
      }
    }
  }

  return diagnostics;
}

export function toEnvironmentRenderPlan(
  snapshot: EnvironmentLayerRuntimeSnapshot,
): EnvironmentLayerRenderPlan {
  const entries = [...snapshot.environmentLayers.values()]
    .filter((entry) => entry.images.length > 0 && (entry.opacityMultiplier ?? 1) > 0)
    .map((entry, index) => ({
      ...cloneRenderState(entry),
      active: true,
      renderOrder: snapshot.layerOrder?.get(entry.layerId) ?? index,
    }));

  return {
    entries: entries
      .sort((a, b) => {
        const zDelta = (a.z ?? 0) - (b.z ?? 0);
        if (zDelta !== 0) return zDelta;
        return a.renderOrder - b.renderOrder;
      })
      .map(({ renderOrder, ...entry }) => entry),
  };
}

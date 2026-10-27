/**
 * Shared types for action scheduler handlers.
 */
import type { RuntimeTimelineAction } from '../RuntimeTimelineScene';
import type { RuntimeActionType } from '../../api/types/semantic-scene';
import type { SceneMeta } from '../../api/types/scene-common';
import type { RimLightStyleState } from '../../api/types/visual';
import type { RuntimeActionContract } from './contracts';

export interface TransformationProxy { x: number; y: number; scale: number; rotation: number; opacity: number; z: number; }

export interface SchedulerContext {
  tl: gsap.core.Timeline;
  resolvePath: (p: string) => string;
  resolvePathAsync?: (p: string) => Promise<string>;
  transformationProxies: Map<string, TransformationProxy>;
  environmentLayerProxies: Map<string, TransformationProxy>;
  backgroundProxy: TransformationProxy;
  isReconstructing: () => boolean;
  /** The engine reconciles environment artwork from absolute scene time. */
  environmentStateDriven?: boolean;
  /** Formal camera values come from scene-time evaluation, not GSAP writes. */
  cameraStateDriven?: boolean;
  audioElements: Map<string, { audio: HTMLAudioElement; startTime: number; duration: number }>;
  takeSnapshot: (time: number) => void;
  getCurrentTime: () => number;
  getCharacterMeta: (id: string) => NonNullable<SceneMeta['characters']>[number] | undefined;
  getRimLightBaseline?: (id: string) => RimLightStyleState | undefined;
}

export type ActionScheduler = (ctx: SchedulerContext, action: RuntimeTimelineAction) => void;

/**
 * Keep raw timeline dispatch compatible while giving each handler the domain
 * payload it consumes. The compiler owns payload shape; this adapter is the
 * single place that narrows its open runtime record by the action discriminator.
 */
export function bindActionScheduler<Action extends RuntimeActionType>(
  actionType: Action,
  scheduler: (ctx: SchedulerContext, action: RuntimeActionContract<Action>) => void,
): ActionScheduler {
  return (ctx, action) => {
    if (action.action !== actionType) return;
    scheduler(ctx, action as unknown as RuntimeActionContract<Action>);
  };
}

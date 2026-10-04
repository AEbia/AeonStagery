/**
 * Shared types for action scheduler handlers.
 */
import type { RuntimeTimelineAction } from '../RuntimeTimelineScene';
import type { RimLightStyleState } from '../../api/types/visual';

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
  audioElements: Map<string, { audio: HTMLAudioElement; startTime: number; duration: number }>;
  takeSnapshot: (time: number) => void;
  getCurrentTime: () => number;
  getCharacterMeta: (id: string) => any;
  getRimLightBaseline?: (id: string) => RimLightStyleState | undefined;
}

export type ActionScheduler = (ctx: SchedulerContext, action: RuntimeTimelineAction) => void;

import type { Vec2 } from './common';
import type { Live2DAdapterId } from '../../engine/Live2DRuntimeResolver';
import type { Live2DDeterminismCapabilities } from '../../engine/runtime/Live2DRuntimeContracts';

/** Reload inputs detached from the mutable stage entry. */
export interface CharacterInfo {
  readonly id: string;
  readonly modelPath: string;
  readonly adapterId: Live2DAdapterId;
  readonly config: CharacterConfig;
  readonly determinism: Live2DDeterminismCapabilities;
}

export interface CharacterConfig {
  position?: Vec2;
  scale?: number;
  rotation?: number;
  opacity?: number;
  z?: number;
  enterAnimation?: string;
  enterDuration?: number;
  /** Flip the model horizontally */
  flipX?: boolean;
  /** Z-index for layering */
  zIndex?: number;
  /** User-friendly name for this character instance */
  alias?: string;
}

export interface CharacterTransformConfig {
  position?: Vec2;
  scale?: number;
  rotation?: number;
  opacity?: number;
  z?: number;
  duration: number;
  ease?: string;
}

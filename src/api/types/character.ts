import type { Vec2 } from './common';

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

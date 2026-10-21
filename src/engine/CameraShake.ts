import type { CameraShakeConfig } from '../api/types/camera';
import type { RuntimeTimelineAction } from './RuntimeTimelineScene';

export interface CameraShakeOffset {
  readonly x: number;
  readonly y: number;
}

/** A repeatable sample in stage pixels, independent of playback history. */
export function sampleCameraShake(config: CameraShakeConfig, elapsed: number, seed = 0): CameraShakeOffset {
  const duration = config.duration ?? 0.5;
  const frequency = config.frequency ?? 15;
  const intensity = config.intensity ?? 0.5;
  if (!(duration > 0) || !(frequency > 0) || !(intensity > 0) || elapsed <= 0 || elapsed >= duration) {
    return { x: 0, y: 0 };
  }
  const phase = elapsed * frequency;
  const step = Math.floor(phase);
  const mix = phase - step;
  const noise = (index: number, axis: number): number => {
    if (index === 0) return 0;
    const value = Math.sin(index * 127.1 + axis * 311.7 + seed * 74.7) * 43758.5453;
    return (value - Math.floor(value)) * 2 - 1;
  };
  const amplitude = intensity * 30 * (config.decay === false ? 1 : 1 - elapsed / duration);
  // Settle within the authored interval even when decay is disabled.
  const settle = Math.min(1, (duration - elapsed) * frequency);
  const offset = (axis: number) => (noise(step, axis) * (1 - mix) + noise(step + 1, axis) * mix) * amplitude * settle;
  return {
    x: config.direction === 'vertical' ? 0 : offset(0),
    y: config.direction === 'horizontal' ? 0 : offset(1),
  };
}

/** Finite additive envelopes; resets release all earlier envelopes in source order. */
export function computeCameraShakeAtTime(timeline: readonly RuntimeTimelineAction[], time: number): CameraShakeOffset {
  const offset = { x: 0, y: 0 };
  const events = timeline.map((action, index) => ({ action, index }))
    .filter(({ action }) => (action.action === 'cameraShake' || action.action === 'cameraReset') && (action.time ?? 0) <= time)
    .sort((a, b) => (a.action.time ?? 0) - (b.action.time ?? 0) || a.index - b.index);
  for (const { action, index } of events) {
    if (action.action === 'cameraReset') {
      offset.x = 0;
      offset.y = 0;
      continue;
    }
    if (action.action !== 'cameraShake') continue;
    let seed = action._id ? 0 : index;
    for (const character of action._id ?? '') seed = (seed * 31 + character.charCodeAt(0)) | 0;
    const config: CameraShakeConfig = action.params;
    const sample = sampleCameraShake(config, time - (action.time ?? 0), seed);
    offset.x += sample.x;
    offset.y += sample.y;
  }
  return offset;
}

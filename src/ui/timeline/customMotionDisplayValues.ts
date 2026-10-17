import type { CustomMotionTrack } from '../../api/types/semantic-scene';
import { evaluateCustomMotionTrack } from '../../engine/live2d/customMotion';

export const F0_EPSILON = 0.001;

export function isTrackAnimated(track: CustomMotionTrack): boolean {
  if (track.keyframes.length <= 1) return false;
  const firstValue = track.keyframes[0].value;
  return track.keyframes.some((kf) => Math.abs(kf.value - firstValue) > 1e-5);
}

export function samplePlayheadTrackValue(
  track: CustomMotionTrack,
  playheadTime: number,
  blockTime: number,
  duration: number,
): number {
  return evaluateCustomMotionTrack(
    track,
    clampValue(playheadTime - blockTime, 0, duration),
  ) ?? track.keyframes[0]?.value ?? 0;
}

export function formatTime(t: number): string {
  return `${Math.max(0, t).toFixed(2)}s`;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function formatFrame(time: number, fps: number): string {
  return String(Math.round(time * fps * 1000) / 1000);
}

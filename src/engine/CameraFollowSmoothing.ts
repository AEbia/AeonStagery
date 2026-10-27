export const FOLLOW_DEFAULT_SMOOTHING = 0.85;

/** Smoothing maps linearly to 0–2 seconds to close 90% of a fixed-target gap. */
export function cameraFollowRate(smoothing: number): number {
  const value = Number.isFinite(smoothing) ? Math.max(0, Math.min(1, smoothing)) : FOLLOW_DEFAULT_SMOOTHING;
  return value === 0 ? Infinity : Math.LN10 / (2 * value);
}

/** Remaining gap after elapsed seconds; maximum smoothing still pursues. */
export function cameraFollowWeight(smoothing: number, elapsedSeconds: number): number {
  const rate = cameraFollowRate(smoothing);
  return rate === Infinity ? 0 : Math.exp(-rate * Math.max(0, elapsedSeconds));
}

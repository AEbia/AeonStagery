export interface BlinkControlState {
  enabled: boolean;
  intervalMs: number;
  intervalRangeMs?: number;
  startTimeSeconds: number;
  sceneTimeSeconds: number;
}

const DEFAULT_INTERVAL_MS = 4000;
const CLOSING_SECONDS = 0.1;
const CLOSED_SECONDS = 0.05;
const OPENING_SECONDS = 0.15;
const BLINK_DURATION_SECONDS = CLOSING_SECONDS + CLOSED_SECONDS + OPENING_SECONDS;

export function createBlinkControlState(
  enabled = false,
  intervalMs = DEFAULT_INTERVAL_MS,
  sceneTimeSeconds = 0,
  startTimeSeconds = sceneTimeSeconds,
  intervalRangeMs = 0,
): BlinkControlState {
  return {
    enabled,
    intervalMs: normalizeBlinkIntervalMs(intervalMs),
    intervalRangeMs: normalizeBlinkIntervalRangeMs(intervalRangeMs),
    startTimeSeconds: Number.isFinite(startTimeSeconds) ? startTimeSeconds : sceneTimeSeconds,
    sceneTimeSeconds: Number.isFinite(sceneTimeSeconds) ? sceneTimeSeconds : 0,
  };
}

export function normalizeBlinkIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) return DEFAULT_INTERVAL_MS;
  return Math.max(0, intervalMs);
}

export function normalizeBlinkIntervalRangeMs(intervalRangeMs: number | undefined): number {
  if (typeof intervalRangeMs !== 'number' || !Number.isFinite(intervalRangeMs)) return 0;
  return Math.max(0, intervalRangeMs);
}

/**
 * Deterministic hash returning a pseudo-random float in [0, 1) for a given cycle index.
 */
function hashFloat01(index: number): number {
  let t = (index + 0x6D2B79F5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function computeCycleIntervalSeconds(
  cycleIndex: number,
  baseIntervalSeconds: number,
  rangeSeconds: number,
): number {
  if (rangeSeconds <= 0) return baseIntervalSeconds;
  const randVal = hashFloat01(cycleIndex);
  const offset = (2 * randVal - 1) * rangeSeconds;
  return Math.max(BLINK_DURATION_SECONDS, baseIntervalSeconds + offset);
}

/**
 * Resolve a deterministic eye-open multiplier from absolute scene time.
 * Keeping this pure makes playback, seek and bake use the same blink pose.
 */
export function evaluateBlinkMultiplier(
  sceneTimeSeconds: number,
  state: BlinkControlState,
): number {
  if (!state.enabled || !Number.isFinite(sceneTimeSeconds)) return 1;

  const elapsed = Math.max(0, sceneTimeSeconds - state.startTimeSeconds);
  const baseIntervalSeconds = Math.max(BLINK_DURATION_SECONDS, state.intervalMs / 1000);
  const rangeSeconds = normalizeBlinkIntervalRangeMs(state.intervalRangeMs) / 1000;

  let phase: number;
  let intervalSeconds: number;

  if (rangeSeconds <= 0) {
    intervalSeconds = baseIntervalSeconds;
    phase = elapsed % intervalSeconds;
  } else {
    // Determine the deterministic cycle index and offset containing `elapsed`
    let k = 0;
    let cycleStartTime = 0;
    while (true) {
      const cycleInterval = computeCycleIntervalSeconds(k, baseIntervalSeconds, rangeSeconds);
      if (cycleStartTime + cycleInterval > elapsed) {
        phase = elapsed - cycleStartTime;
        intervalSeconds = cycleInterval;
        break;
      }
      cycleStartTime += cycleInterval;
      k++;
    }
  }

  const blinkStart = intervalSeconds - BLINK_DURATION_SECONDS;
  if (phase < blinkStart) return 1;

  const blinkElapsed = phase - blinkStart;
  if (blinkElapsed < CLOSING_SECONDS) {
    return 1 - blinkElapsed / CLOSING_SECONDS;
  }
  if (blinkElapsed < CLOSING_SECONDS + CLOSED_SECONDS) return 0;

  return Math.min(
    1,
    (blinkElapsed - CLOSING_SECONDS - CLOSED_SECONDS) / OPENING_SECONDS,
  );
}

// src/engine/MotionRepeatDetector.ts

export interface RepeatWarning {
  indexA: number;
  indexB: number;
  charId: string;
  motionKey: string;
  gapSeconds: number;
}

function resolveMotionKey(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const candidate = value as { kind?: unknown; key?: unknown };
    if (candidate.kind === 'resource' && typeof candidate.key === 'string') return candidate.key;
    return '';
  }
  return '';
}

/**
 * Scan a timeline for duplicate playMotion actions within a time window
 * for the same character. Returns a list of repeat warnings sorted by gap
 * (closest repeats first).
 *
 * @param timeline — array of SceneAction
 * @param minGapSeconds — minimum gap between identical motions to flag (default 30)
 * @returns RepeatWarning[] — each entry describes a pair of repeated motions
 */
export function detectMotionRepeats(
  timeline: Array<{ action: string; time?: number; params: Record<string, any> }>,
  minGapSeconds: number = 30,
): RepeatWarning[] {
  // Collect all playMotion actions grouped by character
  const motionsByChar = new Map<string, Array<{ index: number; time: number; motion: string; charId: string }>>();

  timeline.forEach((item, index) => {
    if (item.action !== 'playMotion') return;
    const charId = item.params.id;
    const motion = resolveMotionKey(item.params.motion);
    if (typeof charId !== 'string' || !motion) return;
    const time = item.time ?? 0;

    const key = `${charId}:${motion}`;
    let entries = motionsByChar.get(key);
    if (!entries) {
      entries = [];
      motionsByChar.set(key, entries);
    }
    entries.push({ index, time, motion, charId });
  });

  const warnings: RepeatWarning[] = [];

  motionsByChar.forEach((entries, _key) => {
    if (entries.length < 2) return;
    const charId = entries[0].charId;
    const motionKey = entries[0].motion;

    // Sort by time
    entries.sort((a, b) => a.time - b.time);

    // Check adjacent pairs
    for (let i = 1; i < entries.length; i++) {
      const gap = entries[i].time - entries[i - 1].time;
      if (gap < minGapSeconds) {
        warnings.push({
          indexA: entries[i - 1].index,
          indexB: entries[i].index,
          charId,
          motionKey,
          gapSeconds: Math.round(gap * 10) / 10,
        });
      }
    }
  });

  // Sort by gap ascending (closest repeats first)
  warnings.sort((a, b) => a.gapSeconds - b.gapSeconds);
  return warnings;
}

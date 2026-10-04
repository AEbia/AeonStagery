export interface TimelineSnapInput {
  initialValue: number;
  rawDelta: number;
  gridStep: number;
  thresholdPx: number;
  pixelsPerUnit?: number;
  targets?: readonly number[];
}

export interface TimelineSnapResult {
  delta: number;
  value: number;
  kind: 'magnetic' | 'grid' | 'none';
}

export function resolveTimelineSnap(input: TimelineSnapInput): TimelineSnapResult {
  const pixelsPerUnit = input.pixelsPerUnit ?? 50;
  const thresholdValue = input.thresholdPx / pixelsPerUnit;
  const rawValue = input.initialValue + input.rawDelta;
  let bestDistance = Infinity;
  let snappedDelta = input.rawDelta;

  for (const target of input.targets ?? []) {
    const distance = Math.abs(rawValue - target);
    if (distance < bestDistance && distance < thresholdValue) {
      bestDistance = distance;
      snappedDelta = target - input.initialValue;
    }
  }

  if (bestDistance !== Infinity) {
    return {
      delta: snappedDelta,
      value: input.initialValue + snappedDelta,
      kind: 'magnetic',
    };
  }

  if (input.gridStep > 0) {
    const snappedValue = Math.round(rawValue / input.gridStep) * input.gridStep;
    return {
      delta: snappedValue - input.initialValue,
      value: snappedValue,
      kind: 'grid',
    };
  }

  return {
    delta: input.rawDelta,
    value: rawValue,
    kind: 'none',
  };
}

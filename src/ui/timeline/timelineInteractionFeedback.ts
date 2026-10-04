import { eventBus } from '../../api/events';

export type TimelineInteractionFeedbackKind = 'drag' | 'batch-drag' | 'resize' | 'transition-resize';

export interface TimelineInteractionFeedbackPayload {
  kind: TimelineInteractionFeedbackKind;
  phase: 'start' | 'update' | 'end';
  pointerX?: number;
  pointerY?: number;
  time?: number;
  duration?: number;
  endTime?: number;
  deltaTime?: number;
  count?: number;
  snapTime?: number | null;
  initialDuration?: number;
  boundary?: 'start' | 'end';
}

export function formatFeedbackSeconds(value: number): string {
  return `${value.toFixed(value >= 10 ? 1 : 2)}s`;
}

export function formatTimelineFeedbackLabel(payload: TimelineInteractionFeedbackPayload): string {
  const snapLabel = typeof payload.snapTime === 'number'
    ? ` · 吸附 ${formatFeedbackSeconds(payload.snapTime)}`
    : '';

  if (payload.kind === 'resize') {
    const duration = typeof payload.duration === 'number'
      ? formatFeedbackSeconds(payload.duration)
      : '--';
    const end = typeof payload.endTime === 'number'
      ? formatFeedbackSeconds(payload.endTime)
      : '--';
    return `缩放 · 时长 ${duration} · 终点 ${end}${snapLabel}`;
  }

  if (payload.kind === 'transition-resize') {
    const boundary = payload.boundary === 'end' ? '结束' : '开始';
    const initialDuration = typeof payload.initialDuration === 'number'
      ? formatFeedbackSeconds(payload.initialDuration)
      : '--';
    const duration = typeof payload.duration === 'number'
      ? formatFeedbackSeconds(payload.duration)
      : '--';
    return `${boundary}过渡时长 · ${initialDuration} → ${duration}${snapLabel}`;
  }

  const verb = payload.kind === 'batch-drag'
    ? `批量移动 ${payload.count || 0} 个`
    : '移动';
  const time = typeof payload.time === 'number'
    ? formatFeedbackSeconds(payload.time)
    : '--';
  const delta = typeof payload.deltaTime === 'number'
    ? ` · Δ${payload.deltaTime >= 0 ? '+' : ''}${formatFeedbackSeconds(payload.deltaTime)}`
    : '';
  return `${verb} · 起点 ${time}${delta}${snapLabel}`;
}

export function findMagneticSnapTarget(
  value: number,
  targets: number[],
  thresholdPx: number,
  pixelsPerSecond: number,
): number | null {
  const threshold = thresholdPx / Math.max(1, pixelsPerSecond);
  let bestTarget: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const target of targets) {
    const distance = Math.abs(target - value);
    if (distance <= threshold && distance < bestDistance) {
      bestTarget = target;
      bestDistance = distance;
    }
  }

  return bestTarget;
}

export function emitTimelineInteractionFeedback(payload: TimelineInteractionFeedbackPayload | null): void {
  void eventBus.emit('timeline:interaction-feedback', payload);
}

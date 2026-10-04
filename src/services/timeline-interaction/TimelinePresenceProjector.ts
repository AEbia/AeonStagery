export interface TimelinePointerProjectionInput {
  clientX: number;
  clientY: number;
  areaLeft: number;
  pixelsPerSecond: number;
  maxTime: number;
  tracks: ReadonlyArray<{ id: string; top: number; bottom: number }>;
}

export interface TimelinePointerPresenceProjection {
  pointer: {
    surface: 'timeline';
    time: number;
    trackId?: string;
  };
}

export function projectTimelinePointerPresence(
  input: TimelinePointerProjectionInput,
): TimelinePointerPresenceProjection | null {
  if (input.pixelsPerSecond <= 0) return null;

  const rawTime = (input.clientX - input.areaLeft - 100) / input.pixelsPerSecond;
  const time = Math.max(0, Math.min(input.maxTime, rawTime));
  const track = input.tracks.find((candidate) => (
    input.clientY >= candidate.top && input.clientY <= candidate.bottom
  ));

  return {
    pointer: {
      surface: 'timeline',
      time,
      ...(track ? { trackId: track.id } : {}),
    },
  };
}

export function shouldPublishTimelinePointer(input: {
  previous: { time: number; trackId?: string; sentAt: number } | null;
  next: { time: number; trackId?: string };
  now: number;
  minTimeDelta?: number;
  throttleMs?: number;
}): boolean {
  if (!input.previous) return true;
  const minTimeDelta = input.minTimeDelta ?? 0.05;
  const throttleMs = input.throttleMs ?? 120;
  return !(
    input.previous.trackId === input.next.trackId &&
    Math.abs(input.previous.time - input.next.time) < minTimeDelta &&
    input.now - input.previous.sentAt < throttleMs
  );
}

import type { TimelineAction } from './semanticTimelineTypes';

export const COMPACT_PPS_THRESHOLD = 12;
export const COMPACT_VISIBLE_ACTION_THRESHOLD = 180;
export const ABSOLUTE_VISIBLE_ACTION_LIMIT = 520;
export const DENSITY_BUCKET_WIDTH_PX = 24;
export const SUMMARY_ENTER_PPS = 14;
export const SUMMARY_EXIT_PPS = 18;
export const SUMMARY_ENTER_VISIBLE_ACTION_THRESHOLD = 40;
export const SUMMARY_EXIT_VISIBLE_ACTION_THRESHOLD = 80;
export const SUMMARY_EXIT_SAFE_ACTION_THRESHOLD = 100;
export const SUMMARY_HARD_VISIBLE_ACTION_THRESHOLD = 140;
export const PLAYHEAD_SPOTLIGHT_BUCKET_SECONDS = 0.5;
export const PLAYHEAD_SPOTLIGHT_RADIUS_SECONDS = 1.5;

export interface TrackActionItem {
  action: TimelineAction;
  id: string;
}

export interface TrackActionIndexItem extends TrackActionItem {
  start: number;
  end: number;
}

export interface TrackActionIndex {
  items: TrackActionIndexItem[];
  maxEndPrefix: number[];
}

export interface TimeBucket {
  index: number;
  start: number;
  end: number;
  items: TrackActionIndexItem[];
}

export interface TimeBucketIndex {
  bucketSeconds: number;
  buckets: Map<number, TimeBucket>;
}

const TIME_BUCKET_LEVELS = [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];

/**
 * Resolve the author-facing duration used by timeline geometry.
 *
 * Custom character performance statements keep their duration on the motion
 * output (`params.motion.durationSeconds`) rather than on the compiled
 * runtime action's `duration` field. Every other action keeps the historical
 * top-level duration lookup. Keeping this in one place prevents a custom
 * motion from being rendered as a one-second block while the semantic model
 * treats it as a longer statement.
 */
export function getTimelineActionDuration(action: TimelineAction): number {
  const authoringParams = action.sourceParams ?? action.params;
  if (action.semanticType === 'characterPerformance') {
    const motion = authoringParams.motion ?? action.params.motion;
    if (motion && typeof motion === 'object' && !Array.isArray(motion)) {
      const customDuration = (motion as { kind?: unknown; durationSeconds?: unknown }).kind === 'custom'
        ? (motion as { durationSeconds?: unknown }).durationSeconds
        : undefined;
      if (typeof customDuration === 'number' && Number.isFinite(customDuration)) {
        return customDuration;
      }
    }
  }

  const authoringDuration = authoringParams.durationSeconds;
  if (typeof authoringDuration === 'number' && Number.isFinite(authoringDuration)) {
    return authoringDuration;
  }
  const runtimeDuration = action.params.duration;
  return typeof runtimeDuration === 'number' && Number.isFinite(runtimeDuration)
    ? runtimeDuration
    : 1;
}

export function pickTimeBucketSeconds(pps: number, targetBucketPx = DENSITY_BUCKET_WIDTH_PX): number {
  const desiredSeconds = targetBucketPx / Math.max(pps, 0.1);
  return TIME_BUCKET_LEVELS.find(level => level >= desiredSeconds) ?? TIME_BUCKET_LEVELS[TIME_BUCKET_LEVELS.length - 1];
}

export interface TimelineViewWindow {
  start: number;
  end: number;
}

export interface DensitySegment {
  id: string;
  start: number;
  end: number;
  count: number;
}

export type TrackLodMode = 'detail' | 'summary';
export type LodTransitionReason = 'init' | 'zoom' | 'data';

export interface SummaryTypeCount {
  type: string;
  count: number;
  label?: string;
  iconKey?: string;
  category?: string;
}

export interface SummarySegment {
  id: string;
  start: number;
  end: number;
  count: number;
  bucketIndex: number;
  dominantActionType: string;
  dominantActionLabel?: string;
  dominantIconKey?: string;
  dominantCategory?: string;
  topTypes: SummaryTypeCount[];
  hasValidationIssue: boolean;
  hasRepeatWarning: boolean;
  issueSeverity: 'error' | 'warning' | null;
  representativeActionId?: string;
}

export function getActionRange(action: TimelineAction): { start: number; end: number } {
  const start = action.time || 0;
  const duration = getTimelineActionDuration(action);
  return { start, end: start + duration };
}

export function buildTrackActionIndex(actions: TrackActionItem[]): TrackActionIndex {
  const items = actions.map(({ action, id }) => {
    const { start, end } = getActionRange(action);
    return { action, id, start, end };
  });
  items.sort((a, b) => a.start - b.start || a.end - b.end);
  const maxEndPrefix: number[] = [];
  let maxEnd = -Infinity;
  for (let i = 0; i < items.length; i++) {
    maxEnd = Math.max(maxEnd, items[i].end);
    maxEndPrefix[i] = maxEnd;
  }
  return { items, maxEndPrefix };
}

function lowerBoundByStart(items: TrackActionIndexItem[], targetStart: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].start < targetStart) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBoundByPrefixEnd(prefix: number[], targetEnd: number): number {
  let lo = 0;
  let hi = prefix.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid] < targetEnd) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function queryVisibleTrackActions(
  index: TrackActionIndex,
  viewWindow: TimelineViewWindow | undefined,
  paddingSeconds = 1,
): TrackActionItem[] {
  if (!viewWindow) return index.items.map(({ action, id }) => ({ action, id }));
  const minStart = viewWindow.start - paddingSeconds;
  const maxEnd = viewWindow.end + paddingSeconds;
  const items = index.items;
  const firstPotentialOverlap = lowerBoundByPrefixEnd(index.maxEndPrefix, minStart);
  const firstAfterView = lowerBoundByStart(items, maxEnd);
  const endIdx = Math.min(items.length, firstAfterView + 1);
  const result: TrackActionItem[] = [];

  for (let i = firstPotentialOverlap; i < endIdx; i++) {
    const item = items[i];
    if (item.start > maxEnd) break;
    if (item.end >= minStart) {
      result.push({ action: item.action, id: item.id });
    }
  }

  return result;
}

export function buildTimeBucketIndex(actions: TrackActionItem[], bucketSeconds: number): TimeBucketIndex {
  const buckets = new Map<number, TimeBucket>();

  for (const { action, id } of actions) {
    const { start, end } = getActionRange(action);
    const item = { action, id, start, end };
    const firstBucket = Math.floor(start / bucketSeconds);
    const lastBucket = Math.floor(Math.max(start, end) / bucketSeconds);

    for (let bucketIndex = firstBucket; bucketIndex <= lastBucket; bucketIndex++) {
      let bucket = buckets.get(bucketIndex);
      if (!bucket) {
        const bucketStart = bucketIndex * bucketSeconds;
        bucket = {
          index: bucketIndex,
          start: bucketStart,
          end: bucketStart + bucketSeconds,
          items: [],
        };
        buckets.set(bucketIndex, bucket);
      }
      bucket.items.push(item);
    }
  }

  return { bucketSeconds, buckets };
}

export function queryVisibleBuckets(
  index: TimeBucketIndex,
  viewWindow: TimelineViewWindow | undefined,
  paddingSeconds = 1,
): TimeBucket[] {
  if (!viewWindow) {
    return [...index.buckets.values()].sort((a, b) => a.index - b.index);
  }

  const firstBucket = Math.floor((viewWindow.start - paddingSeconds) / index.bucketSeconds);
  const lastBucket = Math.floor((viewWindow.end + paddingSeconds) / index.bucketSeconds);
  const buckets: TimeBucket[] = [];

  for (let bucketIndex = firstBucket; bucketIndex <= lastBucket; bucketIndex++) {
    const bucket = index.buckets.get(bucketIndex);
    if (bucket) buckets.push(bucket);
  }

  return buckets;
}

export function queryVisibleBucketActions(
  index: TimeBucketIndex,
  viewWindow: TimelineViewWindow | undefined,
  paddingSeconds = 1,
): TrackActionItem[] {
  const buckets = queryVisibleBuckets(index, viewWindow, paddingSeconds);
  if (!viewWindow) {
    const seen = new Set<string>();
    const result: TrackActionItem[] = [];
    for (const bucket of buckets) {
      for (const item of bucket.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        result.push({ action: item.action, id: item.id });
      }
    }
    return result;
  }

  const minStart = viewWindow.start - paddingSeconds;
  const maxEnd = viewWindow.end + paddingSeconds;
  const seen = new Set<string>();
  const result: TrackActionItem[] = [];

  for (const bucket of buckets) {
    for (const item of bucket.items) {
      if (seen.has(item.id)) continue;
      if (item.end < minStart || item.start > maxEnd) continue;
      seen.add(item.id);
      result.push({ action: item.action, id: item.id });
    }
  }

  return result;
}

export function buildDensitySegmentsFromBuckets(
  buckets: TimeBucket[],
  selectedIds: Record<string, boolean>,
): DensitySegment[] {
  const segments: DensitySegment[] = [];

  for (const bucket of buckets) {
    let count = 0;
    let end = bucket.end;
    for (const item of bucket.items) {
      if (selectedIds[item.id]) continue;
      count += 1;
      end = Math.max(end, item.end);
    }
    if (count === 0) continue;
    segments.push({
      id: `density-${bucket.index}`,
      start: bucket.start,
      end,
      count,
    });
  }

  return segments;
}

export function isActionInView(action: TimelineAction, viewWindow?: TimelineViewWindow, paddingSeconds = 1): boolean {
  if (!viewWindow) return true;
  const { start, end } = getActionRange(action);
  return end >= viewWindow.start - paddingSeconds && start <= viewWindow.end + paddingSeconds;
}

export function shouldUseCompactTimelineView(
  pps: number,
  visibleActionCount: number,
): boolean {
  if (visibleActionCount >= ABSOLUTE_VISIBLE_ACTION_LIMIT) return true;
  return pps <= COMPACT_PPS_THRESHOLD && visibleActionCount >= COMPACT_VISIBLE_ACTION_THRESHOLD;
}

export function calculateNextLOD(
  currentMode: TrackLodMode,
  visibleActionCount: number,
  pps: number,
  reason: LodTransitionReason = 'zoom',
): TrackLodMode {
  if (visibleActionCount >= ABSOLUTE_VISIBLE_ACTION_LIMIT) return 'summary';

  const shouldEnterSummary =
    visibleActionCount >= SUMMARY_HARD_VISIBLE_ACTION_THRESHOLD ||
    (visibleActionCount >= SUMMARY_ENTER_VISIBLE_ACTION_THRESHOLD && pps <= SUMMARY_ENTER_PPS);

  if (currentMode === 'detail') {
    return shouldEnterSummary ? 'summary' : 'detail';
  }

  if (reason === 'data' && visibleActionCount < SUMMARY_EXIT_VISIBLE_ACTION_THRESHOLD) {
    return 'detail';
  }

  if (pps >= SUMMARY_EXIT_PPS && visibleActionCount < SUMMARY_EXIT_SAFE_ACTION_THRESHOLD) {
    return 'detail';
  }

  return shouldEnterSummary || currentMode === 'summary' ? 'summary' : 'detail';
}

export function quantizeTimeToBucket(time: number, bucketSeconds = PLAYHEAD_SPOTLIGHT_BUCKET_SECONDS): number {
  if (bucketSeconds <= 0) return time;
  return Math.floor(time / bucketSeconds) * bucketSeconds;
}

export function getPlayheadSpotlightRange(
  time: number,
  radiusSeconds = PLAYHEAD_SPOTLIGHT_RADIUS_SECONDS,
  bucketSeconds = PLAYHEAD_SPOTLIGHT_BUCKET_SECONDS,
): TimelineViewWindow {
  const center = quantizeTimeToBucket(time, bucketSeconds);
  return {
    start: Math.max(0, center - radiusSeconds),
    end: center + radiusSeconds,
  };
}

interface SummarySegmentOptions {
  anchorIds?: Set<string>;
  getValidationSeverity?: (id: string) => 'error' | 'warning' | null;
  hasValidationIssue?: (id: string) => boolean;
  hasRepeatWarning?: (id: string) => boolean;
}

export function buildSummarySegmentsFromBuckets(
  buckets: TimeBucket[],
  options: SummarySegmentOptions = {},
): SummarySegment[] {
  const {
    anchorIds = new Set<string>(),
    getValidationSeverity = () => null,
    hasValidationIssue = () => false,
    hasRepeatWarning = () => false,
  } = options;

  const segments: SummarySegment[] = [];

  for (const bucket of buckets) {
    const typeCounts = new Map<string, number>();
    const typeMetadata = new Map<string, Omit<SummaryTypeCount, 'type' | 'count'>>();
    let count = 0;
    let end = bucket.end;
    let representativeActionId: string | undefined;
    let hasIssue = false;
    let hasRepeat = false;
    let issueSeverity: 'error' | 'warning' | null = null;

    for (const item of bucket.items) {
      if (item.start < bucket.start || item.start >= bucket.end) {
        continue;
      }
      const severity = getValidationSeverity(item.id) ?? (hasValidationIssue(item.id) ? 'warning' : null);
      hasIssue = hasIssue || severity !== null;
      if (severity === 'error') {
        issueSeverity = 'error';
      } else if (severity === 'warning' && issueSeverity !== 'error') {
        issueSeverity = 'warning';
      }
      hasRepeat = hasRepeat || hasRepeatWarning(item.id);
      if (anchorIds.has(item.id)) continue;

      count += 1;
      end = Math.max(end, item.end);
      representativeActionId ??= item.id;
      const typeKey = item.action.semanticType ?? item.action.action;
      typeCounts.set(typeKey, (typeCounts.get(typeKey) ?? 0) + 1);
      if (!typeMetadata.has(typeKey)) {
        typeMetadata.set(typeKey, {
          label: item.action.semanticLabel,
          iconKey: item.action.semanticIconKey,
          category: item.action.semanticCategory,
        });
      }
    }

    if (count === 0) continue;

    const topTypes = [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([type, typeCount]) => ({ type, count: typeCount, ...typeMetadata.get(type) }));
    const dominantType = topTypes[0];

    segments.push({
      id: `summary-${bucket.index}`,
      start: bucket.start,
      end,
      count,
      bucketIndex: bucket.index,
      dominantActionType: dominantType?.type ?? 'unknown',
      ...(dominantType?.label ? { dominantActionLabel: dominantType.label } : {}),
      ...(dominantType?.iconKey ? { dominantIconKey: dominantType.iconKey } : {}),
      ...(dominantType?.category ? { dominantCategory: dominantType.category } : {}),
      topTypes,
      hasValidationIssue: hasIssue,
      hasRepeatWarning: hasRepeat,
      issueSeverity,
      representativeActionId,
    });
  }

  return segments;
}

export function buildDensitySegments(
  actions: TrackActionItem[],
  viewWindow: TimelineViewWindow | undefined,
  pps: number,
  selectedIds: Record<string, boolean>,
): DensitySegment[] {
  const bucketSeconds = Math.max(0.25, DENSITY_BUCKET_WIDTH_PX / Math.max(pps, 0.1));
  const buckets = new Map<number, DensitySegment>();

  for (const item of actions) {
    if (selectedIds[item.id]) continue;
    if (!isActionInView(item.action, viewWindow, 1)) continue;

    const { start, end } = getActionRange(item.action);
    const bucketIndex = Math.floor(start / bucketSeconds);
    const bucketStart = bucketIndex * bucketSeconds;
    const existing = buckets.get(bucketIndex);

    if (existing) {
      existing.end = Math.max(existing.end, end, bucketStart + bucketSeconds);
      existing.count += 1;
    } else {
      buckets.set(bucketIndex, {
        id: `density-${bucketIndex}`,
        start: bucketStart,
        end: Math.max(end, bucketStart + bucketSeconds),
        count: 1,
      });
    }
  }

  return [...buckets.values()].sort((a, b) => a.start - b.start);
}

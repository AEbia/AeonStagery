import { decodeCompiledActionId } from '../../services/semantic-scene';
import type { TimelineAction } from './semanticTimelineTypes';

export function resolveMatchingTimelineAction(
  timeline: readonly TimelineAction[] | null | undefined,
  selectedId: string,
): TimelineAction | undefined {
  if (!timeline || !selectedId) return undefined;

  // 1. Direct _id match
  const directMatch = timeline.find((action) => action._id === selectedId);
  if (directMatch) return directMatch;

  // 2. Decoded compiled action match (statementId + optional companionId)
  const decoded = decodeCompiledActionId(selectedId);
  if (decoded) {
    const semanticMatch = timeline.find((action) => (
      action.statementId === decoded.statementId
      && action.companionId === decoded.companionId
    ));
    if (semanticMatch) return semanticMatch;
  }

  // 3. Fallback for uncompiled source IDs (statement.id or companion.id)
  const sourceMatch = timeline.find((action) => (
    (action.statementId === selectedId && !action.companionId)
    || action.companionId === selectedId
  ));
  if (sourceMatch) return sourceMatch;

  return undefined;
}

export function pruneSelectedActionIdsForTimeline(
  selectedActionIds: Record<string, boolean>,
  timeline: readonly TimelineAction[] | null | undefined,
): { selectedActionIds: Record<string, boolean>; changed: boolean } {
  const selectedIds = Object.keys(selectedActionIds).filter((id) => selectedActionIds[id]);
  if (selectedIds.length === 0 || !timeline) {
    return { selectedActionIds, changed: false };
  }

  const actionIds = new Set(timeline.map((action) => action._id).filter((id): id is string => !!id));
  const next: Record<string, boolean> = {};
  let changed = false;

  for (const id of selectedIds) {
    if (actionIds.has(id)) {
      next[id] = true;
    } else {
      const matched = resolveMatchingTimelineAction(timeline, id);
      if (matched?._id) {
        next[matched._id] = true;
      }
      changed = true;
    }
  }

  return changed ? { selectedActionIds: next, changed } : { selectedActionIds, changed: false };
}

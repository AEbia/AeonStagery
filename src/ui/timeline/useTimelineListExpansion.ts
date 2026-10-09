import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import type { TimelineAction } from './semanticTimelineTypes';
import { useVirtualTimelineRows } from './useVirtualTimelineRows';

/** Owns manual expansion, selection reveal and measured row layout as one state lifecycle. */
export function useTimelineListExpansion(
  filteredActions: TimelineAction[],
  selectedActionIds: Record<string, boolean>,
  allowInlineExpand: boolean,
) {
  const listContainerRef = useRef<HTMLDivElement>(null);
  const [manuallyExpandedActionIds, setManuallyExpandedActionIds] = useState<Record<string, boolean>>({});
  const [automaticallyExpandedActionId, setAutomaticallyExpandedActionId] = useState<string | null>(null);
  const expandedActionIds = useMemo(() => automaticallyExpandedActionId
    ? { ...manuallyExpandedActionIds, [automaticallyExpandedActionId]: true }
    : manuallyExpandedActionIds, [automaticallyExpandedActionId, manuallyExpandedActionIds]);
  const [revealedActionId, setRevealedActionId] = useState<string | null>(null);
  const toggleExpand = useCallback((id: string) => {
    const expandedBySelection = automaticallyExpandedActionId === id;
    setManuallyExpandedActionIds((prev) => ({ ...prev, [id]: !(prev[id] || expandedBySelection) }));
    setAutomaticallyExpandedActionId((current) => current === id ? null : current);
  }, [automaticallyExpandedActionId]);

  const selectedIdsList = useMemo(() => Object.keys(selectedActionIds), [selectedActionIds]);
  const selectedSingleId = selectedIdsList.length === 1 ? selectedIdsList[0] : undefined;
  useEffect(() => {
    if (!revealedActionId) return;
    const timeout = window.setTimeout(() => setRevealedActionId(null), 250);
    return () => window.clearTimeout(timeout);
  }, [revealedActionId, selectedSingleId]);
  useEffect(() => {
    setAutomaticallyExpandedActionId(allowInlineExpand && selectedSingleId ? selectedSingleId : null);
  }, [allowInlineExpand, selectedSingleId]);
  const virtualRowSizes = useMemo(() => filteredActions.map((action, index) => {
    const id = action._id ?? `timeline-item:${index}`;
    const expanded = allowInlineExpand && !!expandedActionIds[id];
    return {
      id,
      measurementKey: `${id}:${allowInlineExpand}:${expanded}`,
      estimatedHeight: expanded ? 700 : allowInlineExpand ? 160 : 52,
    };
  }), [filteredActions, allowInlineExpand, expandedActionIds]);
  const virtualRows = useVirtualTimelineRows(listContainerRef, virtualRowSizes);
  const lastRevealedSelectionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selectedSingleId) {
      virtualRows.cancelReveal();
      lastRevealedSelectionRef.current = undefined;
      setRevealedActionId(null);
      return;
    }
    if (lastRevealedSelectionRef.current === selectedSingleId) return;
    virtualRows.cancelReveal();
    // Expand first so the scroll range includes the inline inspector's height.
    if (allowInlineExpand && !expandedActionIds[selectedSingleId]) return;
    if (virtualRows.revealRow(selectedSingleId)) {
      lastRevealedSelectionRef.current = selectedSingleId;
      setRevealedActionId(selectedSingleId);
    }
  }, [allowInlineExpand, expandedActionIds, selectedSingleId, virtualRows.revealRow, virtualRows.cancelReveal]);

  const handleExpandAll = useCallback(() => {
    virtualRows.cancelReveal();
    const next: Record<string, boolean> = {};
    filteredActions.forEach((action) => {
      if (action._id) next[action._id] = true;
    });
    setManuallyExpandedActionIds(next);
    setAutomaticallyExpandedActionId(null);
  }, [filteredActions, virtualRows.cancelReveal]);

  const handleCollapseAll = useCallback(() => {
    virtualRows.cancelReveal();
    setManuallyExpandedActionIds({});
    setAutomaticallyExpandedActionId(null);
  }, [virtualRows.cancelReveal]);

  return {
    listContainerRef, selectedIdsList, expandedActionIds, automaticallyExpandedActionId,
    manuallyExpandedActionIds, revealedActionId, toggleExpand, handleExpandAll, handleCollapseAll,
    virtualRowSizes, virtualRows,
  };
}

export type TimelineListExpansion = ReturnType<typeof useTimelineListExpansion>;

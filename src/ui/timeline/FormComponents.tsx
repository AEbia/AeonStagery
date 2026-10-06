import React, { useState, useEffect, useRef, useId, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { IconChevronDown, IconCaretLeft, IconCaretRight } from '../icons';
import { InlineFilePicker } from '../InlineFilePicker';
import { FormSelect } from '../FormSelect';
import { ColorPickerInput } from '../ColorPickerInput';
import type { ResourceImportKind } from '../../api/types/project';
import { useOutsidePointerDown } from '../hooks/useOutsidePointerDown';
import './Inspector.css';

function normalizeStringDraftValue(value: string | null | undefined): string {
  return value || '';
}

// Tracks the most recent native mousedown target so the draft hook can tell
// a real user click (mousedown precedes focusin) from an ambient/native
// refocus (e.g. Chromium restoring focus after a blur while an async
// authoring commit settles). Only inspected inside focus events.
let draftMouseDownTarget: Element | null = null;
let draftMouseDownTargetListenerAttached = false;
if (typeof document !== 'undefined' && !draftMouseDownTargetListenerAttached) {
  draftMouseDownTargetListenerAttached = true;
  document.addEventListener('mousedown', (event) => {
    draftMouseDownTarget = event.target as Element | null;
  }, true);
}

function useRemoteAwareStringDraft(value: string, onChange: (val: string) => void) {
  const incomingValue = normalizeStringDraftValue(value);
  const [localValue, setLocalValue] = useState(incomingValue);
  const [isFocused, setIsFocused] = useState(false);
  const [hasLocalEdit, setHasLocalEdit] = useState(false);
  const [remoteValueDuringEdit, setRemoteValueDuringEdit] = useState<string | null>(null);
  const focusBaseValueRef = useRef(incomingValue);
  const lastCommittedValueRef = useRef(incomingValue);
  const pendingCommitValueRef = useRef<string | null>(null);
  const skipNextCommitRef = useRef(false);

  useEffect(() => {
    const nextValue = normalizeStringDraftValue(value);
    if (isFocused) {
      // Authoring commits land asynchronously: the prop may still carry the
      // old value when the user re-focuses and starts a follow-up edit, and
      // the just-committed value arrives a tick later. That local echo is the
      // user's own edit, not a remote update — never flag it as one.
      const isOwnEcho = nextValue === lastCommittedValueRef.current;
      setRemoteValueDuringEdit(!isOwnEcho && nextValue !== focusBaseValueRef.current ? nextValue : null);
      return;
    }

    // Our own async commit is still in flight: the prop is stale (it still
    // carries the pre-commit value) until the echo lands. Syncing localValue
    // to it now would visually revert the just-committed text.
    const pending = pendingCommitValueRef.current;
    if (pending !== null) {
      if (nextValue === pending) {
        // The commit echo landed — settle the field on the committed value.
        pendingCommitValueRef.current = null;
        if (localValue !== nextValue) {
          setLocalValue(nextValue);
        }
        focusBaseValueRef.current = nextValue;
      }
      return;
    }

    setRemoteValueDuringEdit(null);
    setHasLocalEdit(false);
    focusBaseValueRef.current = nextValue;
    if (nextValue !== localValue) {
      setLocalValue(nextValue);
    }
  }, [value, isFocused, localValue]);

  const beginEditing = (event?: React.FocusEvent<HTMLElement>) => {
    // Reject ambient/native refocus: after the user blurs, Chromium may
    // restore focus to the just-edited field while our async commit settles,
    // with no user interaction at all (focusin relatedTarget is null and no
    // mousedown preceded it). A real user click always focuses via a mousedown
    // on the field itself or on its associated label.
    if (event) {
      const target = event.currentTarget;
      const related = event.relatedTarget;
      const lastDown = draftMouseDownTarget;
      const labelTargeted = lastDown instanceof HTMLLabelElement
        && !!target.id
        && lastDown.htmlFor === target.id;
      const isUserFocus = (
        related instanceof Node
        || lastDown === target
        || labelTargeted
      );
      if (!isUserFocus) {
        // Blur the field without letting this synthetic blur commit anything:
        // commitEditing no-ops while isFocused is false.
        event.currentTarget.blur();
        return false;
      }
    }
    const nextValue = normalizeStringDraftValue(value);
    focusBaseValueRef.current = nextValue;
    setRemoteValueDuringEdit(null);
    setHasLocalEdit(false);
    setIsFocused(true);
    return true;
  };

  const commitEditing = () => {
    const currentRemoteValue = normalizeStringDraftValue(value);
    if (skipNextCommitRef.current) {
      skipNextCommitRef.current = false;
      pendingCommitValueRef.current = null;
      focusBaseValueRef.current = currentRemoteValue;
      lastCommittedValueRef.current = currentRemoteValue;
      setRemoteValueDuringEdit(null);
      setHasLocalEdit(false);
      setIsFocused(false);
      return;
    }
    if (!isFocused) {
      // Synthetic blur from an ambient-refocus rejection — nothing to commit.
      return;
    }
    if (hasLocalEdit && localValue !== currentRemoteValue) {
      pendingCommitValueRef.current = localValue;
      onChange(localValue);
    } else if (!hasLocalEdit && localValue !== currentRemoteValue) {
      pendingCommitValueRef.current = null;
      setLocalValue(currentRemoteValue);
    }
    const committedValue = hasLocalEdit ? localValue : currentRemoteValue;
    focusBaseValueRef.current = committedValue;
    lastCommittedValueRef.current = committedValue;
    setRemoteValueDuringEdit(null);
    setHasLocalEdit(false);
    setIsFocused(false);
  };

  const commitValue = (nextValue: string, keepEditing = false) => {
    const normalizedNextValue = normalizeStringDraftValue(nextValue);
    const currentRemoteValue = normalizeStringDraftValue(value);
    setLocalValue(normalizedNextValue);
    if (normalizedNextValue !== currentRemoteValue) {
      pendingCommitValueRef.current = normalizedNextValue;
      onChange(normalizedNextValue);
    }
    focusBaseValueRef.current = normalizedNextValue;
    lastCommittedValueRef.current = normalizedNextValue;
    setRemoteValueDuringEdit(null);
    setHasLocalEdit(false);
    setIsFocused(keepEditing);
  };

  const cancelEditing = (keepEditing = false) => {
    const currentRemoteValue = normalizeStringDraftValue(value);
    skipNextCommitRef.current = !keepEditing;
    pendingCommitValueRef.current = null;
    setLocalValue(currentRemoteValue);
    focusBaseValueRef.current = currentRemoteValue;
    lastCommittedValueRef.current = currentRemoteValue;
    setRemoteValueDuringEdit(null);
    setHasLocalEdit(false);
    setIsFocused(keepEditing);
  };

  const setDraftValue = (nextValue: string) => {
    setLocalValue(nextValue);
    setHasLocalEdit(true);
  };

  return {
    localValue,
    setLocalValue: setDraftValue,
    beginEditing,
    commitEditing,
    commitValue,
    cancelEditing,
    hasRemoteUpdate: remoteValueDuringEdit !== null && remoteValueDuringEdit !== localValue,
  };
}

function CollaborativeDraftNotice({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="collaborative-draft-notice" role="status">
      远端已更新；当前输入已暂时保留
    </div>
  );
}

function getNextSuggestionIndex(key: string, currentIndex: number, optionCount: number): number | null {
  if (optionCount === 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return optionCount - 1;
  if (key === 'ArrowDown') return (currentIndex + 1 + optionCount) % optionCount;
  if (key === 'ArrowUp') return (currentIndex - 1 + optionCount) % optionCount;
  return null;
}

export interface NumericInputProps {
  label: string;
  value: number;
  onChange: (val: number, isTransient?: boolean) => void;
  step?: string;
  min?: string;
  max?: string;
  popoverMin?: string;
  popoverMax?: string;
  dataTestId?: string;
}

export interface InlineNumericInputProps {
  value: number;
  onChange: (val: number, isTransient?: boolean) => void;
  step?: string;
  min?: string;
  max?: string;
  /** Default X/Y bounds to [0, 1] when min/max are omitted. */
  inferNormalizedBounds?: boolean;
  popoverMin?: string;
  popoverMax?: string;
  style?: React.CSSProperties;
  className?: string;
  dragLabel?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  dataTestId?: string;
}

function getTickInterval(span: number): number {
  if (span <= 0) return 1;
  const rawInterval = span / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawInterval)));
  const normalized = rawInterval / magnitude;
  let nice = 1;
  if (normalized >= 5) nice = 5;
  else if (normalized >= 2.5) nice = 2.5;
  else if (normalized >= 2) nice = 2;
  else nice = 1;
  return nice * magnitude;
}

export const InlineNumericInput = React.memo(({ value, onChange, step = "0.1", min, max, inferNormalizedBounds = true, popoverMin, popoverMax, style, className, dragLabel, ariaLabel, ariaLabelledBy, dataTestId }: InlineNumericInputProps) => {
  const safeValue = value ?? 0;
  const [localValue, setLocalValue] = useState(safeValue.toString());
  const [isEditing, setIsEditing] = useState(false);
  const [isDraggingState, setIsDraggingState] = useState(false);

  const isNormalizedAxis = inferNormalizedBounds && (dragLabel === 'X' || dragLabel === 'Y');
  const resolvedMin = min ?? (isNormalizedAxis ? '0' : undefined);
  const resolvedMax = max ?? (isNormalizedAxis ? '1' : undefined);

  const parsedStep = parseFloat(step) || 0.1;
  const hasMin = resolvedMin !== undefined && !isNaN(parseFloat(resolvedMin));
  const hasMax = resolvedMax !== undefined && !isNaN(parseFloat(resolvedMax));
  const minVal = hasMin ? parseFloat(resolvedMin!) : -Infinity;
  const maxVal = hasMax ? parseFloat(resolvedMax!) : Infinity;

  const isUnboundedLeft = !hasMin;
  const isUnboundedRight = !hasMax;
  const isFullyBounded = hasMin && hasMax;

  const popoverMinValue = popoverMin !== undefined ? parseFloat(popoverMin) : minVal;
  const popoverMaxValue = popoverMax !== undefined ? parseFloat(popoverMax) : maxVal;
  const hasPopoverMin = (popoverMin !== undefined && !isNaN(popoverMinValue)) || hasMin;
  const hasPopoverMax = (popoverMax !== undefined && !isNaN(popoverMaxValue)) || hasMax;

  let defaultWindowMin: number;
  let defaultWindowMax: number;

  if (isFullyBounded) {
    defaultWindowMin = hasPopoverMin && Number.isFinite(popoverMinValue) ? popoverMinValue : minVal;
    defaultWindowMax = hasPopoverMax && Number.isFinite(popoverMaxValue) ? popoverMaxValue : maxVal;
  } else if (hasMin && !hasMax) {
    defaultWindowMin = hasPopoverMin && Number.isFinite(popoverMinValue) ? popoverMinValue : minVal;
    const baseSpan = (popoverMax !== undefined && !isNaN(parseFloat(popoverMax)) && parseFloat(popoverMax) > defaultWindowMin)
      ? parseFloat(popoverMax) - defaultWindowMin
      : Math.max(parsedStep * 50, 10);
    defaultWindowMax = defaultWindowMin + baseSpan;
  } else if (!hasMin && hasMax) {
    defaultWindowMax = hasPopoverMax && Number.isFinite(popoverMaxValue) ? popoverMaxValue : maxVal;
    const baseSpan = (popoverMin !== undefined && !isNaN(parseFloat(popoverMin)) && parseFloat(popoverMin) < defaultWindowMax)
      ? defaultWindowMax - parseFloat(popoverMin)
      : Math.max(parsedStep * 50, 10);
    defaultWindowMin = defaultWindowMax - baseSpan;
  } else {
    const baseSpan = (popoverMin !== undefined && popoverMax !== undefined && !isNaN(parseFloat(popoverMin)) && !isNaN(parseFloat(popoverMax)) && parseFloat(popoverMax) > parseFloat(popoverMin))
      ? parseFloat(popoverMax) - parseFloat(popoverMin)
      : Math.max(parsedStep * 50, 10);
    const center = (popoverMin !== undefined && popoverMax !== undefined && !isNaN(parseFloat(popoverMin)) && !isNaN(parseFloat(popoverMax)))
      ? (parseFloat(popoverMin) + parseFloat(popoverMax)) / 2
      : safeValue;
    defaultWindowMin = center - baseSpan / 2;
    defaultWindowMax = center + baseSpan / 2;
  }

  const [windowRange, setWindowRange] = useState<{ min: number; max: number }>({
    min: defaultWindowMin,
    max: defaultWindowMax,
  });
  const windowRangeRef = useRef(windowRange);
  windowRangeRef.current = windowRange;

  useEffect(() => {
    if (isFullyBounded) {
      setWindowRange({ min: defaultWindowMin, max: defaultWindowMax });
    }
  }, [isFullyBounded, defaultWindowMin, defaultWindowMax]);

  const hasPopoverRange = windowRange.max > windowRange.min;

  const hasExplicitPopoverRange = hasPopoverMin && hasPopoverMax && popoverMaxValue > popoverMinValue;
  let pixelsPerStep = 1;
  if (hasExplicitPopoverRange) {
    const TARGET_SWEEP_PIXELS = 360;
    pixelsPerStep = Math.max(0.5, Math.min(20, (TARGET_SWEEP_PIXELS * parsedStep) / (popoverMaxValue - popoverMinValue)));
  } else {
    if (parsedStep >= 10) {
      pixelsPerStep = 4;
    } else if (parsedStep >= 5) {
      pixelsPerStep = 2;
    } else {
      pixelsPerStep = 1;
    }
  }

  const [showPopover, setShowPopover] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left: number;
    arrowLeft: number;
    placement: 'top' | 'bottom';
  } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const badgeRef = useRef<HTMLDivElement>(null);
  const badgeValueRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const [scrollDirection, setScrollDirection] = useState<'left' | 'right' | null>(null);
  const [isSnappedState, setIsSnappedState] = useState(false);
  const scrollAnimRef = useRef<number | null>(null);
  const hoverScrollAnimRef = useRef<number | null>(null);
  const hoverEdgeDwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverEdgeTargetDirRef = useRef<'left' | 'right' | null>(null);
  const isPointerDraggingTrackRef = useRef(false);
  const pointerClientXRef = useRef(0);
  const renderedTicksRef = useRef<Array<{ percent: number; isMajor: boolean; isCenter: boolean; value: number }>>([]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
      if (hoverEdgeDwellTimerRef.current) clearTimeout(hoverEdgeDwellTimerRef.current);
      if (scrollAnimRef.current !== null) cancelAnimationFrame(scrollAnimRef.current);
      if (hoverScrollAnimRef.current !== null) cancelAnimationFrame(hoverScrollAnimRef.current);
    };
  }, []);

  const calculatePopoverPosition = useCallback(() => {
    const badgeEl = badgeRef.current;
    if (!badgeEl) return null;

    const rect = badgeEl.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    // Dismiss popover if trigger is scrolled completely out of visible viewport
    if (rect.bottom < 0 || rect.top > viewportHeight || rect.right < 0 || rect.left > viewportWidth) {
      return null;
    }

    const POPOVER_WIDTH = 204;
    const POPOVER_HEIGHT = 74;
    const GAP = 7;
    const VIEWPORT_PADDING = 8;

    const spaceAbove = rect.top - GAP - VIEWPORT_PADDING;
    const spaceBelow = viewportHeight - rect.bottom - GAP - VIEWPORT_PADDING;
    const placement: 'top' | 'bottom' = spaceAbove >= POPOVER_HEIGHT || spaceAbove >= spaceBelow ? 'top' : 'bottom';

    let top = placement === 'top' ? rect.top - POPOVER_HEIGHT - GAP : rect.bottom + GAP;
    top = Math.max(VIEWPORT_PADDING, Math.min(top, Math.max(VIEWPORT_PADDING, viewportHeight - POPOVER_HEIGHT - VIEWPORT_PADDING)));

    const badgeValueRect = badgeValueRef.current?.getBoundingClientRect();
    const badgeCenter = rect.left + rect.width / 2;
    const arrowAnchorX = badgeValueRect
      ? badgeValueRect.left + badgeValueRect.width / 2
      : badgeCenter;
    let left = badgeCenter - POPOVER_WIDTH / 2;
    left = Math.max(VIEWPORT_PADDING, Math.min(left, Math.max(VIEWPORT_PADDING, viewportWidth - POPOVER_WIDTH - VIEWPORT_PADDING)));

    const arrowLeft = Math.max(12, Math.min(POPOVER_WIDTH - 12, arrowAnchorX - left));

    return { top, left, arrowLeft, placement };
  }, []);

  const openPopover = useCallback(() => {
    const nextPos = calculatePopoverPosition();
    if (nextPos) {
      const cur = parseFloat(localValue) || safeValue;
      let nextMin = defaultWindowMin;
      let nextMax = defaultWindowMax;
      const baseSpan = Math.max(nextMax - nextMin, parsedStep * 10, 1);

      if (!isFullyBounded) {
        if (cur > nextMax && isUnboundedRight) {
          const shift = cur - (nextMin + baseSpan * 0.75);
          nextMin += shift;
          nextMax += shift;
          if (hasMin && nextMin < minVal) {
            nextMin = minVal;
            nextMax = nextMin + baseSpan;
          }
        } else if (cur < nextMin && isUnboundedLeft) {
          const shift = (nextMin + baseSpan * 0.25) - cur;
          nextMin -= shift;
          nextMax -= shift;
          if (hasMax && nextMax > maxVal) {
            nextMax = maxVal;
            nextMin = nextMax - baseSpan;
          }
        }
      }
      setWindowRange({ min: nextMin, max: nextMax });
      setPopoverPos(nextPos);
      setShowPopover(true);
    }
  }, [calculatePopoverPosition, defaultWindowMin, defaultWindowMax, parsedStep, isFullyBounded, localValue, safeValue, isUnboundedRight, isUnboundedLeft, hasMin, minVal, hasMax, maxVal]);

  useEffect(() => {
    if (!showPopover) return;

    const handleScrollOrResize = () => {
      const nextPos = calculatePopoverPosition();
      if (nextPos) {
        setPopoverPos(nextPos);
      } else {
        setShowPopover(false);
      }
    };

    window.addEventListener('resize', handleScrollOrResize);
    window.addEventListener('scroll', handleScrollOrResize, true);

    return () => {
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('scroll', handleScrollOrResize, true);
    };
  }, [showPopover, calculatePopoverPosition]);

  const handleMouseEnter = () => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    if (!isEditing && !dragRef.current.isDragging && hasPopoverRange) {
      hoverTimerRef.current = setTimeout(openPopover, 250);
    }
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    leaveTimerRef.current = setTimeout(() => {
      setShowPopover(false);
    }, 200);
  };

  const handlePopoverMouseEnter = () => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  };

  const handlePopoverMouseLeave = () => {
    leaveTimerRef.current = setTimeout(() => {
      setShowPopover(false);
    }, 200);
  };

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const trackEl = trackRef.current;
    if (!trackEl || !hasPopoverRange) return;

    if (hoverEdgeDwellTimerRef.current !== null) {
      clearTimeout(hoverEdgeDwellTimerRef.current);
      hoverEdgeDwellTimerRef.current = null;
    }
    hoverEdgeTargetDirRef.current = null;
    if (hoverScrollAnimRef.current !== null) {
      cancelAnimationFrame(hoverScrollAnimRef.current);
      hoverScrollAnimRef.current = null;
    }
    setScrollDirection(null);

    const target = e.currentTarget;
    try {
      target.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }

    isPointerDraggingTrackRef.current = true;
    pointerClientXRef.current = e.clientX;

    const updateFromPointer = (
      clientX: number,
      isTransient: boolean,
      isAltKey: boolean = false,
      isAutoScroll: boolean = false,
    ) => {
      const rect = trackEl.getBoundingClientRect();
      if (!Number.isFinite(rect.width) || rect.width <= 0) return;

      const currentSpan = windowRangeRef.current.max - windowRangeRef.current.min;

      const stepStr = step.toString();
      const decIndex = stepStr.indexOf('.');
      const basePrecision = decIndex >= 0 ? stepStr.length - decIndex - 1 : 0;
      const factor = Math.pow(10, Math.min(basePrecision, 6));

      // Magnetic snap to rendered ticks
      let nearestTick: { percent: number; isMajor: boolean; isCenter: boolean; value: number } | null = null;
      let minTickDist = Infinity;

      if (renderedTicksRef.current && renderedTicksRef.current.length > 0) {
        for (const tick of renderedTicksRef.current) {
          const tickPx = rect.left + (tick.percent / 100) * rect.width;
          const dist = Math.abs(clientX - tickPx);
          if (dist < minTickDist) {
            minTickDist = dist;
            nearestTick = tick;
          }
        }
      }

      const SNAP_THRESHOLD_PX = 4.5;
      const shouldSnap = !isAltKey && !isAutoScroll && nearestTick !== null && minTickDist <= SNAP_THRESHOLD_PX;

      let rounded: number;
      if (shouldSnap && nearestTick) {
        let val = nearestTick.value;
        if (hasMin) val = Math.max(minVal, val);
        if (hasMax) val = Math.min(maxVal, val);
        const tickPrecision = Math.max(basePrecision, 2);
        rounded = Number(val.toFixed(Math.min(tickPrecision, 6)));
        setIsSnappedState(true);
      } else {
        setIsSnappedState(false);
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const nextVal = windowRangeRef.current.min + ratio * currentSpan;
        const stepOrigin = hasMin ? minVal : windowRangeRef.current.min;
        const steps = Math.round((nextVal - stepOrigin) / parsedStep);
        let snappedVal = stepOrigin + steps * parsedStep;
        if (hasMin) snappedVal = Math.max(minVal, snappedVal);
        if (hasMax) snappedVal = Math.min(maxVal, snappedVal);
        rounded = Math.round(snappedVal * factor) / factor;
      }

      if (!Number.isFinite(rounded)) return;

      setLocalValue(rounded.toString());
      onChange(rounded, isTransient);
    };

    updateFromPointer(e.clientX, true, e.altKey);

    const EDGE_DRAG_THRESHOLD = 0.075;

    const startAutoScrollIfNeeded = () => {
      if (scrollAnimRef.current !== null) return;
      let lastTime = performance.now();

      const loop = (now: number) => {
        if (!isPointerDraggingTrackRef.current) return;
        const rect = trackEl.getBoundingClientRect();
        if (rect.width <= 0) return;

        const dt = Math.min(Math.max((now - lastTime) / 1000, 0.001), 0.05);
        lastTime = now;

        const rawRatio = (pointerClientXRef.current - rect.left) / rect.width;
        let dir: 'left' | 'right' | null = null;
        let speed = 0;

        const currentSpan = windowRangeRef.current.max - windowRangeRef.current.min;
        const minSpeed = Math.max(parsedStep * 3, currentSpan * 0.12);
        const maxSpeed = Math.max(parsedStep * 10, currentSpan * 0.45);

        if (rawRatio > 1 - EDGE_DRAG_THRESHOLD && isUnboundedRight) {
          dir = 'right';
          const excess = Math.max(0, (rawRatio - (1 - EDGE_DRAG_THRESHOLD)) / 0.18);
          const t = Math.min(excess, 2);
          const factor = 0.15 + 0.85 * (t / 2);
          speed = minSpeed + (maxSpeed - minSpeed) * factor;
        } else if (rawRatio < EDGE_DRAG_THRESHOLD && (isUnboundedLeft || windowRangeRef.current.min > minVal)) {
          dir = 'left';
          const excess = Math.max(0, (EDGE_DRAG_THRESHOLD - rawRatio) / 0.18);
          const t = Math.min(excess, 2);
          const factor = 0.15 + 0.85 * (t / 2);
          speed = -(minSpeed + (maxSpeed - minSpeed) * factor);
        }

        setScrollDirection(dir);
        let delta = speed * dt;

        if (hasMin && speed < 0 && windowRangeRef.current.min + delta < minVal) {
          delta = minVal - windowRangeRef.current.min;
        }

        if (Math.abs(delta) > 0.00001) {
          const nextMin = windowRangeRef.current.min + delta;
          const nextMax = windowRangeRef.current.max + delta;
          windowRangeRef.current = { min: nextMin, max: nextMax };
          setWindowRange({ min: nextMin, max: nextMax });
          updateFromPointer(pointerClientXRef.current, true, false, true);
        }

        scrollAnimRef.current = requestAnimationFrame(loop);
      };

      scrollAnimRef.current = requestAnimationFrame(loop);
    };

    startAutoScrollIfNeeded();

    const onPointerMove = (moveEvt: PointerEvent) => {
      pointerClientXRef.current = moveEvt.clientX;
      updateFromPointer(moveEvt.clientX, true, moveEvt.altKey);
    };

    const onPointerUp = (upEvt: PointerEvent) => {
      isPointerDraggingTrackRef.current = false;
      if (scrollAnimRef.current !== null) {
        cancelAnimationFrame(scrollAnimRef.current);
        scrollAnimRef.current = null;
      }
      setScrollDirection(null);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', onPointerUp);
      target.removeEventListener('pointercancel', onPointerUp);
      try {
        target.releasePointerCapture?.(upEvt.pointerId);
      } catch {
        // ignore
      }
      updateFromPointer(upEvt.clientX, false, upEvt.altKey);
      setIsSnappedState(false);
    };

    target.addEventListener('pointermove', onPointerMove);
    target.addEventListener('pointerup', onPointerUp);
    target.addEventListener('pointercancel', onPointerUp);
  };

  const handleTrackMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isPointerDraggingTrackRef.current) return;
    const trackEl = trackRef.current;
    if (!trackEl) return;
    const rect = trackEl.getBoundingClientRect();
    if (rect.width <= 0) return;

    const rawRatio = (e.clientX - rect.left) / rect.width;
    const HOVER_EDGE_THRESHOLD = 0.08;

    let targetDir: 'left' | 'right' | null = null;
    if (rawRatio > 1 - HOVER_EDGE_THRESHOLD && isUnboundedRight) {
      targetDir = 'right';
    } else if (rawRatio < HOVER_EDGE_THRESHOLD && (isUnboundedLeft || windowRangeRef.current.min > minVal)) {
      targetDir = 'left';
    }

    if (targetDir === null) {
      if (hoverEdgeDwellTimerRef.current !== null) {
        clearTimeout(hoverEdgeDwellTimerRef.current);
        hoverEdgeDwellTimerRef.current = null;
      }
      hoverEdgeTargetDirRef.current = null;
      if (hoverScrollAnimRef.current !== null) {
        cancelAnimationFrame(hoverScrollAnimRef.current);
        hoverScrollAnimRef.current = null;
      }
      setScrollDirection(null);
      return;
    }

    if (hoverEdgeTargetDirRef.current === targetDir) {
      return;
    }

    if (hoverEdgeDwellTimerRef.current !== null) {
      clearTimeout(hoverEdgeDwellTimerRef.current);
      hoverEdgeDwellTimerRef.current = null;
    }
    if (hoverScrollAnimRef.current !== null) {
      cancelAnimationFrame(hoverScrollAnimRef.current);
      hoverScrollAnimRef.current = null;
    }
    setScrollDirection(null);

    hoverEdgeTargetDirRef.current = targetDir;
    hoverEdgeDwellTimerRef.current = setTimeout(() => {
      hoverEdgeDwellTimerRef.current = null;
      if (isPointerDraggingTrackRef.current) return;
      setScrollDirection(targetDir);

      let lastTime = performance.now();
      const loop = (now: number) => {
        if (isPointerDraggingTrackRef.current) return;
        const dt = Math.min(Math.max((now - lastTime) / 1000, 0.001), 0.05);
        lastTime = now;

        const currentSpan = windowRangeRef.current.max - windowRangeRef.current.min;
        const speed = Math.max(parsedStep * 2.5, currentSpan * 0.09);
        let delta = targetDir === 'right' ? speed * dt : -speed * dt;

        if (targetDir === 'left' && hasMin && windowRangeRef.current.min + delta < minVal) {
          delta = minVal - windowRangeRef.current.min;
        }

        if (Math.abs(delta) > 0.00001) {
          const nextMin = windowRangeRef.current.min + delta;
          const nextMax = windowRangeRef.current.max + delta;
          windowRangeRef.current = { min: nextMin, max: nextMax };
          setWindowRange({ min: nextMin, max: nextMax });
          hoverScrollAnimRef.current = requestAnimationFrame(loop);
        } else {
          if (hoverScrollAnimRef.current !== null) {
            cancelAnimationFrame(hoverScrollAnimRef.current);
            hoverScrollAnimRef.current = null;
          }
          setScrollDirection(null);
        }
      };
      hoverScrollAnimRef.current = requestAnimationFrame(loop);
    }, 120);
  };

  const handleTrackMouseLeave = () => {
    if (hoverEdgeDwellTimerRef.current !== null) {
      clearTimeout(hoverEdgeDwellTimerRef.current);
      hoverEdgeDwellTimerRef.current = null;
    }
    hoverEdgeTargetDirRef.current = null;
    if (hoverScrollAnimRef.current !== null) {
      cancelAnimationFrame(hoverScrollAnimRef.current);
      hoverScrollAnimRef.current = null;
    }
    setScrollDirection(null);
  };

  const dragRef = React.useRef<{
    isDragging: boolean;
    startX: number;
    startY: number;
    lastClientX: number;
    startValue: number;
    currentValue: number;
    accumulatedDeltaX: number;
    pixelsPerStep: number;
    parsedStep: number;
    hasMin: boolean;
    minVal: number;
    hasMax: boolean;
    maxVal: number;
  }>({
    isDragging: false,
    startX: 0,
    startY: 0,
    lastClientX: 0,
    startValue: 0,
    currentValue: 0,
    accumulatedDeltaX: 0,
    pixelsPerStep,
    parsedStep,
    hasMin,
    minVal,
    hasMax,
    maxVal,
  });

  const lastPropValueRef = useRef(safeValue);
  useEffect(() => {
    if (lastPropValueRef.current !== safeValue) {
      lastPropValueRef.current = safeValue;
      if (!isEditing && !dragRef.current.isDragging) {
        setLocalValue(safeValue.toString());
      }
    }
  }, [safeValue, isEditing]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (isEditing) return;
    e.preventDefault();
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    setShowPopover(false);

    const startX = e.clientX;
    const startY = e.clientY;
    const startValue = parseFloat(localValue) || 0;
    let hasMoved = false;

    if (document.body.requestPointerLock) document.body.requestPointerLock();
    
    dragRef.current = {
      isDragging: false,
      startX,
      startY,
      lastClientX: startX,
      startValue,
      currentValue: startValue,
      accumulatedDeltaX: 0,
      pixelsPerStep,
      parsedStep,
      hasMin,
      minVal,
      hasMax,
      maxVal,
    };

    const handleMouseMove = (me: MouseEvent) => {
      let stepDeltaX = 0;
      if (document.pointerLockElement === document.body) {
        stepDeltaX = me.movementX;
      } else {
        stepDeltaX = me.clientX - dragRef.current.lastClientX;
        dragRef.current.lastClientX = me.clientX;
      }
      dragRef.current.accumulatedDeltaX += stepDeltaX;

      if (!dragRef.current.isDragging) {
        if (Math.abs(dragRef.current.accumulatedDeltaX) >= 2) {
          dragRef.current.isDragging = true;
          hasMoved = true;
          setIsDraggingState(true);
        } else {
          return;
        }
      }
      
      const speed = me.shiftKey ? 5 : me.altKey ? 0.2 : 1;
      const valueIncrement = (stepDeltaX / dragRef.current.pixelsPerStep) * dragRef.current.parsedStep * speed;
      let nextValue = dragRef.current.currentValue + valueIncrement;
      
      if (dragRef.current.hasMin) nextValue = Math.max(dragRef.current.minVal, nextValue);
      if (dragRef.current.hasMax) nextValue = Math.min(dragRef.current.maxVal, nextValue);
      dragRef.current.currentValue = nextValue;

      const stepStr = step.toString();
      const decIndex = stepStr.indexOf('.');
      const basePrecision = decIndex >= 0 ? stepStr.length - decIndex - 1 : 0;
      const precision = me.altKey ? basePrecision + 1 : basePrecision;
      const factor = Math.pow(10, Math.min(precision, 6));
      const rounded = Math.round(nextValue * factor) / factor;

      setLocalValue(rounded.toString());
      onChange(rounded, true); // transient
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (document.pointerLockElement === document.body) {
        document.exitPointerLock();
      }
      setIsDraggingState(false);
      const wasDragging = dragRef.current.isDragging;
      dragRef.current.isDragging = false;

      if (!wasDragging && !hasMoved) {
        setIsEditing(true);
      } else {
        let finalValue = dragRef.current.currentValue;
        if (dragRef.current.hasMin) finalValue = Math.max(dragRef.current.minVal, finalValue);
        if (dragRef.current.hasMax) finalValue = Math.min(dragRef.current.maxVal, finalValue);
        const stepStr = step.toString();
        const decIndex = stepStr.indexOf('.');
        const basePrecision = decIndex >= 0 ? stepStr.length - decIndex - 1 : 0;
        const factor = Math.pow(10, Math.min(basePrecision, 6));
        const rounded = Math.round(finalValue * factor) / factor;
        setLocalValue(rounded.toString());
        onChange(rounded, false); // final
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleKeyboardAdjustment = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setIsEditing(true);
      return;
    }
    if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;

    event.preventDefault();
    const speed = event.shiftKey ? 5 : event.altKey ? 0.2 : 1;
    const baseStep = parsedStep * speed;
    let nextValue = parseFloat(localValue) || 0;
    if (event.key === 'Home' && hasMin) nextValue = minVal;
    else if (event.key === 'End' && hasMax) nextValue = maxVal;
    else if (event.key === 'PageUp') nextValue += baseStep * 10;
    else if (event.key === 'PageDown') nextValue -= baseStep * 10;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowRight') nextValue += baseStep;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') nextValue -= baseStep;

    if (hasMin) nextValue = Math.max(minVal, nextValue);
    if (hasMax) nextValue = Math.min(maxVal, nextValue);

    const stepStr = step.toString();
    const decIndex = stepStr.indexOf('.');
    const basePrecision = decIndex >= 0 ? stepStr.length - decIndex - 1 : 0;
    const precision = event.altKey ? basePrecision + 1 : basePrecision;
    const factor = Math.pow(10, Math.min(precision, 6));
    nextValue = Math.round(nextValue * factor) / factor;

    setLocalValue(nextValue.toString());
    onChange(nextValue, false);
  };

  const curNum = parseFloat(localValue) || 0;
  const currentSpan = Math.max(0.0001, windowRange.max - windowRange.min);
  const percent = hasPopoverRange ? Math.max(0, Math.min(100, ((curNum - windowRange.min) / currentSpan) * 100)) : 0;

  const formatBoundValue = (val: number) => {
    if (!Number.isFinite(val)) return '';
    const stepStr = step.toString();
    const decIndex = stepStr.indexOf('.');
    const precision = decIndex >= 0 ? stepStr.length - decIndex - 1 : 0;
    if (precision === 0) {
      return Math.round(val).toString();
    }
    return Number(val.toFixed(Math.min(precision, 3))).toString();
  };

  const renderedTicks = useMemo(() => {
    if (isFullyBounded) {
      const span = windowRange.max - windowRange.min;
      const getVal = (fraction: number) => {
        const raw = windowRange.min + span * fraction;
        return Number(raw.toFixed(6));
      };
      return [
        { percent: 0, isMajor: true, isCenter: false, value: getVal(0) },
        { percent: 25, isMajor: false, isCenter: false, value: getVal(0.25) },
        { percent: 50, isMajor: false, isCenter: true, value: getVal(0.5) },
        { percent: 75, isMajor: false, isCenter: false, value: getVal(0.75) },
        { percent: 100, isMajor: true, isCenter: false, value: getVal(1) },
      ];
    }
    const span = windowRange.max - windowRange.min;
    if (span <= 0) return [];
    const tickInterval = getTickInterval(span);
    const startTick = Math.floor(windowRange.min / tickInterval) * tickInterval;
    const result: { percent: number; isMajor: boolean; isCenter: boolean; value: number }[] = [];
    for (let v = startTick; v <= windowRange.max + tickInterval * 0.5; v += tickInterval) {
      const p = ((v - windowRange.min) / span) * 100;
      if (p >= -2 && p <= 102) {
        const isCenter = Math.abs(v) < 1e-6 || Math.abs(p - 50) < 1;
        const isMajor = Math.abs(v % (tickInterval * 2)) < 1e-6 || Math.abs(p) < 1 || Math.abs(p - 100) < 1;
        const cleanVal = Number(v.toFixed(6));
        result.push({ percent: Math.round(p * 10) / 10, isMajor, isCenter, value: cleanVal });
      }
    }
    return result;
  }, [isFullyBounded, windowRange.min, windowRange.max]);

  renderedTicksRef.current = renderedTicks;

  if (isEditing) {
    return (
      <input
        type="number"
        className={`scrubbable-input-mode ${className || ''}`}
        step={step}
        min={hasMin ? minVal : undefined}
        max={hasMax ? maxVal : undefined}
        value={localValue}
        style={style}
        data-testid={dataTestId}
        aria-label={ariaLabel ?? (ariaLabelledBy ? undefined : dragLabel ?? '数值')}
        aria-labelledby={ariaLabelledBy}
        autoFocus
        onFocus={(e) => {
          e.currentTarget.select();
        }}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={() => {
          setIsEditing(false);
          const parsed = parseFloat(localValue);
          if (!isNaN(parsed)) {
            let clamped = parsed;
            if (hasMin) clamped = Math.max(minVal, clamped);
            if (hasMax) clamped = Math.min(maxVal, clamped);
            const stepStr = step.toString();
            const decIndex = stepStr.indexOf('.');
            const basePrecision = decIndex >= 0 ? stepStr.length - decIndex - 1 : 0;
            const factor = Math.pow(10, Math.min(basePrecision, 6));
            const rounded = Math.round(clamped * factor) / factor;
            if (rounded !== safeValue) {
              setLocalValue(rounded.toString());
              onChange(rounded, false);
              return;
            }
          }
          setLocalValue(safeValue.toString());
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setLocalValue(safeValue.toString());
            setIsEditing(false);
          }
        }}
      />
    );
  }

  const popoverElement = showPopover && popoverPos && hasPopoverRange && !isDraggingState && !isEditing && typeof document !== 'undefined' ? createPortal(
    <div
      className={`scrubbable-popover scrubbable-popover--${popoverPos.placement}`}
      data-testid="scrubbable-popover"
      style={{
        top: `${popoverPos.top}px`,
        left: `${popoverPos.left}px`,
        ['--popover-arrow-x' as string]: `${popoverPos.arrowLeft}px`,
      }}
      onMouseEnter={handlePopoverMouseEnter}
      onMouseLeave={handlePopoverMouseLeave}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="scrubbable-popover__arrow"
        style={{ left: `${popoverPos.arrowLeft}px` }}
      />
      <div className="scrubbable-popover__header">
        <span className="scrubbable-popover__tag">{dragLabel || (isFullyBounded ? '范围' : '数值')}</span>
        <div className="scrubbable-popover__val-display">
          <span className="scrubbable-popover__val-num">{localValue}</span>
          <span className="scrubbable-popover__pct">{Math.round(percent)}%</span>
        </div>
      </div>
      <div
        className={`scrubbable-popover__track-container ${isUnboundedLeft ? 'is-unbounded-left' : ''} ${isUnboundedRight ? 'is-unbounded-right' : ''} ${scrollDirection === 'left' ? 'is-scrolling-left' : ''} ${scrollDirection === 'right' ? 'is-scrolling-right' : ''}`}
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
        onMouseMove={handleTrackMouseMove}
        onMouseLeave={handleTrackMouseLeave}
        data-testid="scrubbable-popover-track"
      >
        {isUnboundedLeft && (
          <span className="scrubbable-popover__edge-hint scrubbable-popover__edge-hint--left" title="无界刻度">
            <IconCaretLeft width={10} height={10} />
          </span>
        )}
        {isUnboundedRight && (
          <span className="scrubbable-popover__edge-hint scrubbable-popover__edge-hint--right" title="无界刻度">
            <IconCaretRight width={10} height={10} />
          </span>
        )}
        <div className="scrubbable-popover__track">
          <div
            className="scrubbable-popover__fill"
            style={{ width: `${percent}%` }}
          />
          <div
            className={`scrubbable-popover__thumb ${isSnappedState ? 'is-snapped' : ''}`}
            style={{ left: `${percent}%` }}
          >
            <span className="scrubbable-popover__thumb-dot" />
          </div>
        </div>
        <div className="scrubbable-popover__ticks">
          {renderedTicks.map((t, idx) => {
            const isTickActive = Math.abs(curNum - t.value) < Math.max(parsedStep * 0.45, 1e-4);
            return (
              <span
                key={idx}
                className={`scrubbable-popover__tick ${t.isMajor ? 'scrubbable-popover__tick--major' : ''} ${t.isCenter ? 'scrubbable-popover__tick--center' : ''} ${isTickActive ? 'scrubbable-popover__tick--active' : ''}`}
                style={{ left: `${t.percent}%` }}
              />
            );
          })}
        </div>
        <div className="scrubbable-popover__ruler-labels">
          <span className="scrubbable-popover__bound">{formatBoundValue(windowRange.min)}</span>
          <span className="scrubbable-popover__mid-bound">
            {formatBoundValue((windowRange.min + windowRange.max) / 2)}
          </span>
          <span className="scrubbable-popover__bound">{formatBoundValue(windowRange.max)}</span>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <div
        ref={badgeRef}
        className={`scrubbable-badge ${isDraggingState ? 'is-dragging' : ''} ${className || ''}`}
        role="spinbutton"
        tabIndex={0}
        aria-label={ariaLabel ?? (ariaLabelledBy ? undefined : dragLabel ?? '数值')}
        aria-labelledby={ariaLabelledBy}
        aria-valuenow={safeValue}
        aria-valuemin={hasMin ? minVal : undefined}
        aria-valuemax={hasMax ? maxVal : undefined}
        data-testid={dataTestId}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyboardAdjustment}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={style}
      >
        {dragLabel && <span className="scrubbable-badge-label">{dragLabel}</span>}
        <span ref={badgeValueRef} className="scrubbable-badge-value">{localValue}</span>
      </div>
      {popoverElement}
    </>
  );
});

export const TextInput = React.memo(({ label, value, onChange, dataTestId }: { label: string; value: string; onChange: (val: string) => void; dataTestId?: string }) => {
  const draft = useRemoteAwareStringDraft(value, onChange);
  const inputId = useId();

  return (
    <div className="inspector-row">
      <label className="inspector-label" htmlFor={inputId}>{label}</label>
      <div className="form-field-stack">
        <input
          type="text"
          id={inputId}
          className={`form-input ${draft.hasRemoteUpdate ? 'form-input--remote-updated' : ''}`}
          data-testid={dataTestId}
          value={draft.localValue}
          onChange={(e) => draft.setLocalValue(e.target.value)}
          onFocus={draft.beginEditing}
          onBlur={draft.commitEditing}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              draft.cancelEditing();
              e.currentTarget.blur();
            }
          }}
        />
        <CollaborativeDraftNotice visible={draft.hasRemoteUpdate} />
      </div>
    </div>
  );
});

export const EnvironmentLayerNameInput = React.memo(({
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  placeholder?: string;
  onChange: (val: string) => void;
}) => {
  const draft = useRemoteAwareStringDraft(value || '', onChange);
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputId = useId();
  const listboxId = `${inputId}-options`;
  useOutsidePointerDown(containerRef, () => setShowDropdown(false));

  const filteredOptions = options.filter((option) =>
    option.toLocaleLowerCase().includes(draft.localValue.toLocaleLowerCase()),
  );

  useEffect(() => {
    setActiveOptionIndex((currentIndex) => Math.min(currentIndex, Math.max(0, filteredOptions.length - 1)));
  }, [filteredOptions.length]);

  const commitValue = (nextValue: string) => {
    const trimmedValue = nextValue.trim();
    draft.commitValue(trimmedValue || value || '');
    setShowDropdown(false);
  };

  return (
    <div className="inspector-row" ref={containerRef} style={{ position: 'relative' }}>
      <label className="inspector-label" htmlFor={inputId}>{label}</label>
      <div className="form-field-stack">
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            id={inputId}
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={showDropdown && filteredOptions.length > 0}
            aria-controls={showDropdown && filteredOptions.length > 0 ? listboxId : undefined}
            aria-activedescendant={showDropdown && filteredOptions[activeOptionIndex] ? `${listboxId}-option-${activeOptionIndex}` : undefined}
            aria-autocomplete="list"
            className={`form-input ${draft.hasRemoteUpdate ? 'form-input--remote-updated' : ''}`}
            value={draft.localValue}
            autoComplete="off"
            placeholder={placeholder}
            onChange={(e) => {
              draft.setLocalValue(e.target.value);
              setActiveOptionIndex(0);
              setShowDropdown(true);
            }}
            onFocus={(event) => {
              if (!draft.beginEditing(event)) return;
              const selectedIndex = filteredOptions.findIndex((option) => option === value);
              setActiveOptionIndex(selectedIndex >= 0 ? selectedIndex : 0);
              setShowDropdown(true);
            }}
            onBlur={() => commitValue(draft.localValue)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              const activeOption = filteredOptions[activeOptionIndex];
              const nextIndex = showDropdown
                ? getNextSuggestionIndex(e.key, activeOptionIndex, filteredOptions.length)
                : null;
              if (nextIndex !== null) {
                e.preventDefault();
                setActiveOptionIndex(nextIndex);
                return;
              }
              if (e.key === 'Enter' && showDropdown && activeOption) {
                e.preventDefault();
                draft.commitValue(activeOption, true);
                setShowDropdown(false);
                return;
              }
              if (e.key === 'Enter') {
                e.currentTarget.blur();
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                draft.cancelEditing(true);
                setShowDropdown(false);
              }
            }}
            style={{ width: '100%', paddingRight: '30px' }}
          />
          <IconChevronDown
            width={14}
            height={14}
            style={{
              position: 'absolute',
              right: '10px',
              top: '50%',
              transform: 'translateY(-50%)',
              opacity: 0.5,
              pointerEvents: 'none',
            }}
          />
        </div>
        <CollaborativeDraftNotice visible={draft.hasRemoteUpdate} />
      </div>

      {showDropdown && filteredOptions.length > 0 && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={`${label}建议`}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 100,
            marginTop: '4px',
            background: 'var(--bg-elevated)',
            backdropFilter: 'var(--blur-md)',
            border: '1px solid var(--border-highlight)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            maxHeight: '200px',
            overflowY: 'auto',
          }}
        >
          {filteredOptions.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={option === value}
              aria-posinset={index + 1}
              aria-setsize={filteredOptions.length}
              id={`${listboxId}-option-${index}`}
              tabIndex={-1}
              className="environment-layer-option"
              key={option}
              onClick={() => {
                draft.commitValue(option, true);
                setShowDropdown(false);
              }}
              onMouseDown={(e) => e.preventDefault()}
              style={{
                display: 'block', width: '100%', border: 0, color: 'inherit', background: activeOptionIndex === index ? 'var(--bg-hover)' : 'transparent', textAlign: 'left',
                padding: '8px 12px',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 600,
                transition: 'background 0.2s',
              }}
              onMouseEnter={() => setActiveOptionIndex(index)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export const TextArea = React.memo(({ label, value, onChange, dataTestId }: { label: string; value: string; onChange: (val: string) => void; dataTestId?: string }) => {
  const draft = useRemoteAwareStringDraft(value, onChange);
  const inputId = useId();

  return (
    <div className="inspector-row stacked">
      <label className="inspector-label" htmlFor={inputId}>{label}</label>
      <textarea
        id={inputId}
        className={`form-input ${draft.hasRemoteUpdate ? 'form-input--remote-updated' : ''}`}
        data-testid={dataTestId}
        style={{ resize: 'vertical', wordBreak: 'break-all' }}
        value={draft.localValue}
        rows={4}
        onChange={(e) => draft.setLocalValue(e.target.value)}
        onFocus={draft.beginEditing}
        onBlur={draft.commitEditing}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            draft.cancelEditing();
            e.currentTarget.blur();
          }
        }}
      />
      <CollaborativeDraftNotice visible={draft.hasRemoteUpdate} />
    </div>
  );
});

export interface FileInputProps {
  label: string;
  value: string;
  onChange: (val: string) => void;
  filters?: Array<{ name: string; extensions: string[] }>;
  placeholder?: string;
  importKind?: ResourceImportKind;
  initialDir?: string;
}

export const FileInput = React.memo(({
  label,
  value,
  onChange,
  filters,
  placeholder,
  importKind,
  initialDir,
}: FileInputProps) => {
  const inputId = useId();
  return (
    <div className="inspector-row">
      {label && <label className="inspector-label" htmlFor={inputId}>{label}</label>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <InlineFilePicker
          value={value || ''}
          onChange={onChange}
          filters={filters}
          placeholder={placeholder}
          importKindOverride={importKind}
          inputId={inputId}
          initialDirOverride={initialDir}
        />
      </div>
    </div>
  );
});

export const NumericInput = React.memo(({ label, value, onChange, step = "0.1", min, max, popoverMin, popoverMax, dataTestId }: NumericInputProps) => {
  const labelId = useId();
  if (!label) {
    return <InlineNumericInput value={value} onChange={onChange} step={step} min={min} max={max} popoverMin={popoverMin} popoverMax={popoverMax} dataTestId={dataTestId} />;
  }

  return (
    <div className="inspector-row">
      <span id={labelId} className="inspector-label">{label}</span>
      <InlineNumericInput value={value} onChange={onChange} step={step} min={min} max={max} popoverMin={popoverMin} popoverMax={popoverMax} ariaLabelledBy={labelId} dataTestId={dataTestId} />
    </div>
  );
});

export const SelectInput = React.memo(({ label, value, onChange, options }: { label: string; value: string; onChange: (val: string) => void; options: { value: string; label: string }[] }) => {
  const inputId = useId();
  return (
    <div className="inspector-row">
      <label className="inspector-label" htmlFor={inputId}>{label}</label>
      <FormSelect id={inputId} value={value || ''} onChange={onChange} options={options} />
    </div>
  );
});

export const EASE_OPTIONS = [
  // 线性与多项式缓动 (Polynomial)
  { value: 'linear', label: '匀速' },
  { value: 'none', label: '无缓动' },
  { value: 'power1.in', label: '二次缓入' },
  { value: 'power1.out', label: '二次缓出' },
  { value: 'power2.in', label: '三次缓入' },
  { value: 'power2.out', label: '三次缓出' },
  { value: 'power2.inOut', label: '三次缓入缓出' },
  { value: 'power3.out', label: '四次缓出' },
  { value: 'power3.inOut', label: '四次缓入缓出' },
  { value: 'sine.inOut', label: '正弦缓入缓出' },
  { value: 'circ.out', label: '圆弧缓出' },
  { value: 'expo.out', label: '指数缓出' },
  { value: 'back.out', label: '回弹过冲' },
  { value: 'elastic.out', label: '弹性阻尼' },
  { value: 'bounce.out', label: '物理弹跳' },
];

export function normalizeEaseOptionValue(value: string): string {
  return value === 'smooth' ? 'power2.inOut' : value;
}

export const EaseSelect = React.memo(({ label = '缓动 (Ease)', value, onChange }: { label?: string; value: string; onChange: (val: string) => void }) => (
  <SelectInput label={label} value={normalizeEaseOptionValue(value)} onChange={onChange} options={EASE_OPTIONS} />
));

const LIGHTING_PRESET_LABELS: Record<string, string> = {
  normal: '自然',
  sunset: '夕阳',
  night: '夜景',
  dawn: '黎明',
  spotlight: '聚光',
  dramatic: '戏剧',
  sepia: '复古棕调',
  cold: '冷调',
  warm: '暖调',
  dim: '低照度',
};

const LIGHTING_PRESETS = ['normal', 'sunset', 'night', 'dawn', 'spotlight', 'dramatic', 'sepia', 'cold', 'warm', 'dim']
  .map(v => ({ value: v, label: LIGHTING_PRESET_LABELS[v] || v }));

export const LightingPresetSelect = React.memo(({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
  <SelectInput label="光照预设" value={value} onChange={onChange} options={LIGHTING_PRESETS} />
));

const DIRECTION_OPTIONS = [
  { value: 'both', label: '双向 (Both)' },
  { value: 'horizontal', label: '水平 (Horizontal)' },
  { value: 'vertical', label: '垂直 (Vertical)' }
];

export const DirectionSelect = React.memo(({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
  <SelectInput label="震动方向 (Direction)" value={value} onChange={onChange} options={DIRECTION_OPTIONS} />
));

const LAYER_OPTIONS = [
  { value: 'background', label: '背景 (Background)' },
  { value: 'characters', label: '角色 (Characters)' },
  { value: 'effects', label: '特效 (Effects)' },
  { value: 'customAnimation', label: '自定义动画 (Custom Anim)' },
  { value: 'subtitle', label: '字幕 (Subtitle)' },
  { value: 'overlay', label: '叠加层 (Overlay)' }
];

export const LayerSelect = React.memo(({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
  <SelectInput label="目标层 (Layer)" value={value} onChange={onChange} options={LAYER_OPTIONS} />
));

const TRANSITION_OPTIONS = [
  { value: 'none', label: '无过渡' },
  { value: 'fadeIn', label: '淡入' },
  { value: 'crossFade', label: '交叉淡化' },
  { value: 'fadeOut', label: '淡出' },
];

export const TransitionSelect = React.memo(({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
  <SelectInput label="过渡方式" value={value} onChange={onChange} options={TRANSITION_OPTIONS} />
));

const DIALOGUE_STYLE_OPTIONS = [
  { value: 'typewriter', label: '打字机' },
  { value: 'fadeIn', label: '淡入' },
  { value: 'cinematic', label: '电影式' },
  { value: 'instant', label: '即时' }
];

export const DialogueStyleSelect = React.memo(({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
  <SelectInput label="字幕样式" value={value} onChange={onChange} options={DIALOGUE_STYLE_OPTIONS} />
));

const LIPSYNC_OPTIONS = [
  { value: 'text', label: '文本驱动' },
  { value: 'audio', label: '音频驱动' },
  { value: 'none', label: '无' }
];

export const LipSyncSelect = React.memo(({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
  <SelectInput label="口型同步" value={value} onChange={onChange} options={LIPSYNC_OPTIONS} />
));

const EXIT_ANIM_OPTIONS = [
  { value: 'none', label: '无 (立即移除)' },
  { value: 'fadeOut', label: '淡出 (Fade Out)' },
  { value: 'slideToLeft', label: '左滑出 (Slide Left)' },
  { value: 'slideToRight', label: '右滑出 (Slide Right)' },
  { value: 'slideToTop', label: '上滑出 (Slide Top)' },
  { value: 'flyUp', label: '飞升 (Fly Up)' },
  { value: 'dissolve', label: '溶解 (Dissolve)' },
  { value: 'zoomOut', label: '缩小出 (Zoom Out)' }
];

export const ExitAnimationSelect = React.memo(({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
  <SelectInput label="退场动画 (Exit)" value={value} onChange={onChange} options={EXIT_ANIM_OPTIONS} />
));

const ENTER_ANIM_OPTIONS = [
  { value: 'none', label: '无 (立即出现)' },
  { value: 'fadeIn', label: '淡入' },
  { value: 'slideFromLeft', label: '左滑入 (Slide Left)' },
  { value: 'slideFromRight', label: '右滑入 (Slide Right)' },
  { value: 'slideFromBottom', label: '底部滑入 (Slide Bottom)' },
  { value: 'zoomIn', label: '放大入 (Zoom In)' },
  { value: 'dropIn', label: '掉落入 (Drop In)' }
];

export const EnterAnimationSelect = React.memo(({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
  <SelectInput label="入场动画 (Enter)" value={value} onChange={onChange} options={ENTER_ANIM_OPTIONS} />
));

const DIALOGUE_POS_OPTIONS = [
  { value: 'bottom', label: '底部' },
  { value: 'top', label: '顶部' },
  { value: 'center', label: '中间' }
];

export const DialoguePositionSelect = React.memo(({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
  <SelectInput label="字幕位置" value={value} onChange={onChange} options={DIALOGUE_POS_OPTIONS} />
));

const DIALOGUE_TEMPLATE_OPTIONS = [
  { value: 'glass', label: '玻璃' },
  { value: 'minimal', label: '极简' },
  { value: 'classic', label: '经典' }
];

export const DialogueTemplateSelect = React.memo(({
  value,
  onChange,
  customOptions = [],
}: {
  value: string;
  onChange: (val: string) => void;
  customOptions?: Array<{ value: string; label: string; disabled?: boolean }>;
}) => (
  <SelectInput
    label="对话框样式"
    value={value || 'glass'}
    onChange={onChange}
    options={[...DIALOGUE_TEMPLATE_OPTIONS, ...customOptions]}
  />
));

const FONT_FAMILY_OPTIONS = [
  { value: "'Outfit', 'Inter', 'Noto Sans SC', sans-serif", label: 'Outfit (推荐)' },
  { value: "'Inter', 'Noto Sans SC', sans-serif", label: 'Inter (现代无衬线)' },
  { value: "'Noto Sans SC', sans-serif", label: '思源黑体 (Noto Sans)' },
  { value: "'Noto Serif SC', serif", label: '思源宋体 (Noto Serif)' },
  { value: "'Microsoft YaHei', sans-serif", label: '微软雅黑 (YaHei)' },
  { value: "'Courier New', monospace", label: '等宽代码 (Courier)' },
  { value: "sans-serif", label: '系统默认 (System)' }
];

export const FontFamilySelect = React.memo(({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
  <SelectInput label="字体 (Font)" value={value || "'Outfit', 'Inter', 'Noto Sans SC', sans-serif"} onChange={onChange} options={FONT_FAMILY_OPTIONS} />
));

const BLUR_TARGET_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'global', label: '全画面' },
  { value: 'background', label: '仅背景' },
  { value: 'characters', label: '仅角色' }
];

export const BlurTargetSelect = React.memo(({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
  <SelectInput label="模糊范围" value={value || 'global'} onChange={onChange} options={BLUR_TARGET_OPTIONS} />
));

const ENV_LAYOUT_OPTIONS = [
  { value: 'cover', label: '铺满舞台' },
  { value: 'tile', label: '静态平铺' },
];

export const EnvironmentLayoutSelect = React.memo(({ value, onChange }: { value: string; onChange: (val: string) => void }) => (
  <SelectInput label="画面铺法" value={value || 'cover'} onChange={onChange} options={ENV_LAYOUT_OPTIONS} />
));

export interface ColorPickerRowProps {
  label: string;
  value: string;
  onChange: (color: string) => void;
  dataTestId?: string;
}

export const ColorPickerRow = React.memo(({ label, value, onChange, dataTestId }: ColorPickerRowProps) => {
  const id = useId();
  const safeColor = /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff';
  return (
    <div className="inspector-row" style={{ alignItems: 'center' }}>
      <label className="inspector-label" htmlFor={id}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ColorPickerInput
          id={id}
          aria-label={label}
          value={safeColor}
          data-testid={dataTestId ? `${dataTestId}-color` : undefined}
          onChange={onChange}
          style={{
            width: 28,
            height: 24,
            padding: 0,
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            background: 'none',
          }}
        />
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
          {value || '#ffffff'}
        </span>
      </div>
    </div>
  );
});

import { useState, useRef, useCallback, useEffect } from 'react';

export interface ResizableLayoutOptions {
  initialLeftPanelWidth?: number;
  initialPanelWidth?: number;
  initialDetailWidth?: number;
  initialContextWidth?: number;
  initialTimelineHeight?: number;
  onPanelWidthCommit?: (width: number) => void;
  onLeftPanelWidthCommit?: (width: number) => void;
  onDetailWidthCommit?: (width: number) => void;
  onContextWidthCommit?: (width: number) => void;
  onTimelineHeightCommit?: (height: number) => void;
}

export const WORKBENCH_PANEL_WIDTH = { min: 280, max: 640, defaultValue: 380 };
export const WORKBENCH_LEFT_PANEL_WIDTH = { min: 320, max: 420, defaultValue: 340 };
export const WORKBENCH_DETAIL_WIDTH = { min: 320, max: 480, defaultValue: 360 };
export const WORKBENCH_CONTEXT_WIDTH = { min: 320, max: 620, defaultValue: 400 };
export const WORKBENCH_TIMELINE_HEIGHT = { min: 180, max: 560, defaultValue: 300 };

export function clampWorkbenchValue(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function useResizableLayout(options: ResizableLayoutOptions = {}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [leftPanelWidth, setLeftPanelWidthState] = useState(() => clampWorkbenchValue(
    options.initialLeftPanelWidth,
    WORKBENCH_LEFT_PANEL_WIDTH.min,
    WORKBENCH_LEFT_PANEL_WIDTH.max,
    WORKBENCH_LEFT_PANEL_WIDTH.defaultValue,
  ));
  const leftPanelWidthRef = useRef(leftPanelWidth);
  const leftDragRef = useRef<{ x: number; width: number } | null>(null);
  const setLeftPanelWidth = useCallback((value: number) => {
    const next = clampWorkbenchValue(value, WORKBENCH_LEFT_PANEL_WIDTH.min,
      WORKBENCH_LEFT_PANEL_WIDTH.max, WORKBENCH_LEFT_PANEL_WIDTH.defaultValue);
    leftPanelWidthRef.current = next;
    setLeftPanelWidthState(next);
  }, []);
  const handleLeftResizeMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    leftDragRef.current = { x: event.clientX, width: leftPanelWidthRef.current };
    document.body.style.cursor = 'col-resize';
    document.body.setAttribute('data-resizing', 'true');
  }, []);
  const handleLeftResizeKeyDown = useCallback((event: React.KeyboardEvent) => {
    let next = leftPanelWidthRef.current;
    if (event.key === 'ArrowLeft') next -= 10;
    else if (event.key === 'ArrowRight') next += 10;
    else if (event.key === 'Home') next = WORKBENCH_LEFT_PANEL_WIDTH.min;
    else if (event.key === 'End') next = WORKBENCH_LEFT_PANEL_WIDTH.max;
    else return;
    event.preventDefault();
    setLeftPanelWidth(next);
    options.onLeftPanelWidthCommit?.(leftPanelWidthRef.current);
  }, [options.onLeftPanelWidthCommit, setLeftPanelWidth]);
  const [panelWidth, setPanelWidthState] = useState(() => clampWorkbenchValue(
    options.initialPanelWidth,
    WORKBENCH_PANEL_WIDTH.min,
    WORKBENCH_PANEL_WIDTH.max,
    WORKBENCH_PANEL_WIDTH.defaultValue,
  ));
  const [detailWidth, setDetailWidthState] = useState(() => clampWorkbenchValue(
    options.initialDetailWidth,
    WORKBENCH_DETAIL_WIDTH.min,
    WORKBENCH_DETAIL_WIDTH.max,
    WORKBENCH_DETAIL_WIDTH.defaultValue,
  ));
  const [contextWidth, setContextWidthState] = useState(() => clampWorkbenchValue(
    options.initialContextWidth,
    WORKBENCH_CONTEXT_WIDTH.min,
    WORKBENCH_CONTEXT_WIDTH.max,
    WORKBENCH_CONTEXT_WIDTH.defaultValue,
  ));
  const [timelineHeight, setTimelineHeightState] = useState(() => clampWorkbenchValue(
    options.initialTimelineHeight,
    WORKBENCH_TIMELINE_HEIGHT.min,
    WORKBENCH_TIMELINE_HEIGHT.max,
    WORKBENCH_TIMELINE_HEIGHT.defaultValue,
  ));
  const isDraggingRef = useRef(false);
  const isDraggingDetailRef = useRef(false);
  const isDraggingContextRef = useRef(false);
  const isDraggingHeightRef = useRef(false);

  const startXRef = useRef(0);
  const startWRef = useRef(0);
  const startDetailXRef = useRef(0);
  const startDetailWRef = useRef(0);
  const startContextXRef = useRef(0);
  const startContextWRef = useRef(0);
  const startYRef = useRef(0);
  const startHRef = useRef(0);
  
  const panelWidthRef = useRef(panelWidth);
  const detailWidthRef = useRef(detailWidth);
  const contextWidthRef = useRef(contextWidth);
  const timelineHeightRef = useRef(timelineHeight);

  useEffect(() => { panelWidthRef.current = panelWidth; }, [panelWidth]);
  useEffect(() => { detailWidthRef.current = detailWidth; }, [detailWidth]);
  useEffect(() => { contextWidthRef.current = contextWidth; }, [contextWidth]);
  useEffect(() => { timelineHeightRef.current = timelineHeight; }, [timelineHeight]);

  const setPanelWidth = useCallback((value: number) => {
    const next = clampWorkbenchValue(value, WORKBENCH_PANEL_WIDTH.min, WORKBENCH_PANEL_WIDTH.max, WORKBENCH_PANEL_WIDTH.defaultValue);
    panelWidthRef.current = next;
    setPanelWidthState(next);
  }, []);

  const setDetailWidth = useCallback((value: number) => {
    const next = clampWorkbenchValue(value, WORKBENCH_DETAIL_WIDTH.min, WORKBENCH_DETAIL_WIDTH.max, WORKBENCH_DETAIL_WIDTH.defaultValue);
    detailWidthRef.current = next;
    setDetailWidthState(next);
  }, []);

  const setContextWidth = useCallback((value: number) => {
    const next = clampWorkbenchValue(value, WORKBENCH_CONTEXT_WIDTH.min, WORKBENCH_CONTEXT_WIDTH.max, WORKBENCH_CONTEXT_WIDTH.defaultValue);
    contextWidthRef.current = next;
    setContextWidthState(next);
  }, []);

  const setTimelineHeight = useCallback((value: number) => {
    const next = clampWorkbenchValue(value, WORKBENCH_TIMELINE_HEIGHT.min, WORKBENCH_TIMELINE_HEIGHT.max, WORKBENCH_TIMELINE_HEIGHT.defaultValue);
    timelineHeightRef.current = next;
    setTimelineHeightState(next);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDraggingRef.current = true;
    startXRef.current = e.clientX;
    startWRef.current = panelWidthRef.current;
    document.body.style.cursor = 'col-resize';
    document.body.setAttribute('data-resizing', 'true');
  }, []);

  const handleContextMouseDown = useCallback((e: React.MouseEvent) => {
    isDraggingContextRef.current = true;
    startContextXRef.current = e.clientX;
    startContextWRef.current = contextWidthRef.current;
    document.body.style.cursor = 'col-resize';
    document.body.setAttribute('data-resizing', 'true');
  }, []);

  const handleDetailMouseDown = useCallback((e: React.MouseEvent) => {
    isDraggingDetailRef.current = true;
    startDetailXRef.current = e.clientX;
    startDetailWRef.current = detailWidthRef.current;
    document.body.style.cursor = 'col-resize';
    document.body.setAttribute('data-resizing', 'true');
  }, []);

  const handleDetailKeyDown = useCallback((e: React.KeyboardEvent) => {
    let next = detailWidthRef.current;
    if (e.key === 'ArrowLeft') next -= 10;
    else if (e.key === 'ArrowRight') next += 10;
    else if (e.key === 'Home') next = WORKBENCH_DETAIL_WIDTH.min;
    else if (e.key === 'End') next = WORKBENCH_DETAIL_WIDTH.max;
    else return;

    e.preventDefault();
    setDetailWidth(next);
    options.onDetailWidthCommit?.(detailWidthRef.current);
  }, [options, setDetailWidth]);

  const handleHeightMouseDown = useCallback((e: React.MouseEvent) => {
    isDraggingHeightRef.current = true;
    startYRef.current = e.clientY;
    startHRef.current = timelineHeightRef.current;
    document.body.style.cursor = 'row-resize';
    document.body.setAttribute('data-resizing', 'true');
  }, []);

  useEffect(() => {
    const handleGlobalMove = (e: MouseEvent) => {
      if (leftDragRef.current) {
        setLeftPanelWidth(leftDragRef.current.width + e.clientX - leftDragRef.current.x);
      }
      if (isDraggingRef.current) {
        const delta = startXRef.current - e.clientX;
        const newWidth = startWRef.current + delta;
        setPanelWidth(newWidth);
      }
      if (isDraggingDetailRef.current) {
        const delta = e.clientX - startDetailXRef.current;
        setDetailWidth(startDetailWRef.current + delta);
      }
      if (isDraggingContextRef.current) {
        const delta = e.clientX - startContextXRef.current;
        const newWidth = startContextWRef.current + delta;
        setContextWidth(newWidth);
      }
      if (isDraggingHeightRef.current) {
        const delta = startYRef.current - e.clientY;
        const newHeight = startHRef.current + delta;
        setTimelineHeight(newHeight);
      }
    };
    const handleGlobalUp = () => {
      if (leftDragRef.current) {
        optionsRef.current.onLeftPanelWidthCommit?.(leftPanelWidthRef.current);
        leftDragRef.current = null;
      }
      if (isDraggingRef.current) {
        optionsRef.current.onPanelWidthCommit?.(panelWidthRef.current);
      }
      if (isDraggingDetailRef.current) {
        optionsRef.current.onDetailWidthCommit?.(detailWidthRef.current);
      }
      if (isDraggingContextRef.current) {
        optionsRef.current.onContextWidthCommit?.(contextWidthRef.current);
      }
      if (isDraggingHeightRef.current) {
        optionsRef.current.onTimelineHeightCommit?.(timelineHeightRef.current);
      }
      isDraggingRef.current = false;
      isDraggingDetailRef.current = false;
      isDraggingContextRef.current = false;
      isDraggingHeightRef.current = false;
      document.body.style.cursor = 'default';
      document.body.removeAttribute('data-resizing');
    };
    window.addEventListener('mousemove', handleGlobalMove);
    window.addEventListener('mouseup', handleGlobalUp);
    return () => {
      document.body.style.cursor = 'default';
      document.body.removeAttribute('data-resizing');
      window.removeEventListener('mousemove', handleGlobalMove);
      window.removeEventListener('mouseup', handleGlobalUp);
    };
  }, [setContextWidth, setDetailWidth, setPanelWidth, setTimelineHeight, setLeftPanelWidth]);

  return {
    leftPanelWidth,
    handleLeftResizeMouseDown,
    handleLeftResizeKeyDown,
    panelWidth,
    setPanelWidth,
    detailWidth,
    contextWidth,
    timelineHeight,
    handleMouseDown,
    handleDetailMouseDown,
    handleDetailKeyDown,
    handleContextMouseDown,
    handleHeightMouseDown,
  };
}

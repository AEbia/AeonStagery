import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject, PointerEvent as ReactPointerEvent } from 'react';
import type { CharacterMotionOutput, CustomMotionTrack } from '../../api/types/semantic-scene';
import { applyCustomMotionKeyframeEdits, customMotionFingerprint, type CustomMotionKeyframeEdit, type CustomMotionKeyframeRef } from '../../services/timeline-authoring/customMotionKeyframeEdits';
import { createGroupMoveResolver, edgeScrollSpeed, keyframeKey, keyframesInRect, selectionRect, type SelectionRect } from './customMotionSelection';

type Motion = Extract<CharacterMotionOutput, { kind: 'custom' }>;
interface Options {
  motion: Motion;
  view: string;
  fps: number;
  blockTime: number;
  pps: number;
  root: RefObject<HTMLDivElement | null>;
  scrollContainer?: HTMLElement | null;
  busy: boolean;
  commit: (edits: readonly CustomMotionKeyframeEdit[]) => Promise<void>;
  pause: () => void;
  selectParam: (id: string) => void;
  range: (track: CustomMotionTrack) => { min: number; max: number; bounded?: boolean };
  onError: (message: string) => void;
}
interface Gesture {
  pointerId: number;
  kind: 'marquee' | 'move';
  motion: Motion;
  canvas: SVGSVGElement;
  tracks: readonly CustomMotionTrack[];
  graph: boolean;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  baseline: readonly CustomMotionKeyframeRef[];
  refs: readonly CustomMotionKeyframeRef[];
  moved: boolean;
  dirty?: boolean;
  deselectOnClick: boolean;
  resolve?: (frames: number) => number;
  range?: { min: number; max: number; bounded?: boolean };
  axis?: 'x' | 'y';
  panPixels?: number;
  edit?: CustomMotionKeyframeEdit;
  pointer: { x: number; y: number; shift: boolean };
}

export function useCustomMotionSelection(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [selection, setSelection] = useState<readonly CustomMotionKeyframeRef[]>([]);
  const selectionRef = useRef(selection);
  const [preview, setPreview] = useState<Motion | null>(null);
  const [previewSelection, setPreviewSelection] = useState<readonly CustomMotionKeyframeRef[] | null>(null);
  const [graphRange, setGraphRange] = useState<{ min: number; max: number } | null>(null);
  const [marquee, setMarquee] = useState<SelectionRect | null>(null);
  const [viewport, setViewport] = useState<{ left: number; right: number } | null>(() => options.scrollContainer?.clientWidth ? { left: Math.max(0, options.scrollContainer.scrollLeft - 190), right: options.scrollContainer.scrollLeft + options.scrollContainer.clientWidth + 40 } : null);
  const gesture = useRef<Gesture | null>(null);
  const raf = useRef<number | null>(null);
  const committing = useRef(false);
  const generation = useRef(0);
  const environment = useRef({ motion: options.motion, fps: options.fps });
  const candidate = useRef(preview);
  candidate.current = preview;
  const updateSelection = useCallback((refs: readonly CustomMotionKeyframeRef[]) => {
    const current = selectionRef.current;
    if (current.length === refs.length && current.every((ref, index) => ref.parameterId === refs[index].parameterId && ref.time === refs[index].time)) return;
    selectionRef.current = refs;
    setSelection(refs);
  }, []);
  const cancel = useCallback(() => {
    generation.current++;
    gesture.current = null;
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    setPreview(null);
    setPreviewSelection(null);
    setMarquee(null);
    setGraphRange(null);
  }, []);
  const clear = useCallback(() => { cancel(); updateSelection([]); }, [cancel, updateSelection]);
  const getScroller = (canvas?: SVGSVGElement) => latest.current.scrollContainer
    ?? canvas?.closest<HTMLElement>('.timeline-editor-scroll-container')
    ?? canvas?.closest<HTMLElement>('.cme__lanes, .cme__curve-wrap');
  const coordinates = (g: Gesture, x: number, y: number) => {
    const bounds = g.canvas.getBoundingClientRect();
    const width = g.canvas.viewBox?.baseVal?.width || Number(g.canvas.getAttribute('viewBox')?.split(' ')[2]) || bounds.width;
    const height = g.canvas.viewBox?.baseVal?.height || Number(g.canvas.getAttribute('viewBox')?.split(' ')[3]) || bounds.height;
    return { x: (x - bounds.left) * width / (bounds.width || width || 1), y: g.graph ? (y - bounds.top) * height / (bounds.height || height || 1) : y - bounds.top };
  };
  const apply = useCallback(() => {
    const g = gesture.current;
    if (!g) return;
    const o = latest.current;
    if (o.motion !== g.motion || (o.busy && g.kind === 'move') || committing.current) { cancel(); return; }
    const point = coordinates(g, g.pointer.x, g.pointer.y);
    if (!g.moved && Math.hypot(g.pointer.x - g.startX, g.pointer.y - g.startY) > 4) {
      g.moved = true;
      if (g.kind === 'move') o.pause();
    }
    if (!g.moved) return;
    if (g.kind === 'marquee') {
      const rect = selectionRect(g.originX, g.originY, point.x, point.y);
      const bounds = g.canvas.getBoundingClientRect();
      setMarquee(selectionRect(bounds.left + g.originX, bounds.top + g.originY, g.pointer.x, g.pointer.y));
      const range = g.range;
      const found = keyframesInRect(g.tracks, rect, o.blockTime, o.pps,
        (index, value) => g.graph && range ? 16 + (1 - (value - range.min) / (range.max - range.min)) * 122 : index * 28 + (bounds.height || 28) / 2);
      const keys = new Map(g.baseline.map((ref) => [keyframeKey(ref.parameterId, ref.time), ref]));
      found.forEach((ref) => keys.set(keyframeKey(ref.parameterId, ref.time), ref));
      const refs = [...keys.values()];
      updateSelection(refs);
      if (refs.length === 1) o.selectParam(refs[0].parameterId);
      return;
    }
    if (g.pointer.shift && !g.axis) g.axis = Math.abs(point.x - g.originX) >= Math.abs(point.y - g.originY) ? 'x' : 'y';
    const lockedAxis = g.pointer.shift ? g.axis : undefined;
    const deltaFrames = g.resolve!(lockedAxis === 'y' ? 0 : (point.x - g.originX) / o.pps * o.fps);
    let deltaValue = g.graph && g.range && lockedAxis !== 'x' ? (g.originY - point.y + (g.panPixels ?? 0)) / 122 * (g.range.max - g.range.min) : 0;
    if (g.range?.bounded && deltaValue !== 0) {
      const values = g.refs.map((ref) => g.tracks[0].keyframes.find((kf) => kf.time === ref.time)!.value);
      const lower = g.range.min - Math.min(...values);
      const upper = g.range.max - Math.max(...values);
      deltaValue = lower <= upper ? Math.max(lower, Math.min(upper, deltaValue)) : 0;
    }
    if (g.graph && g.range) {
      const pan = (g.panPixels ?? 0) / 122 * (g.range.max - g.range.min);
      setGraphRange((current) => current?.min === g.range!.min + pan && current.max === g.range!.max + pan ? current : { min: g.range!.min + pan, max: g.range!.max + pan });
    }
    const edit: CustomMotionKeyframeEdit = { type: 'move-keyframes', keyframes: g.refs, deltaTime: deltaFrames / o.fps, deltaValue };
    if (g.edit?.type === 'move-keyframes' && g.edit.deltaTime === edit.deltaTime && g.edit.deltaValue === edit.deltaValue) return;
    g.edit = edit;
    try {
      setPreview(applyCustomMotionKeyframeEdits(g.motion, [edit]));
      setPreviewSelection(g.refs.map((ref) => ({ ...ref, time: ref.time + edit.deltaTime })));
    }
    catch (error) { cancel(); o.onError(error instanceof Error ? error.message : '无法移动关键帧'); }
  }, [cancel, updateSelection]);

  useEffect(() => {
    let previousTime = 0;
    const tick = (time: number) => {
      raf.current = null;
      const g = gesture.current;
      if (!g) return;
      const scroller = getScroller(g.canvas);
      const elapsed = previousTime ? Math.min(0.05, (time - previousTime) / 1000) : 1 / 60;
      if (g.moved && g.kind === 'move' && g.graph && !g.range?.bounded && g.axis !== 'x') {
        const bounds = g.canvas.getBoundingClientRect();
        const speed = edgeScrollSpeed(g.pointer.y, bounds.top + 16, bounds.bottom - 18);
        if (speed) { g.panPixels = (g.panPixels ?? 0) - speed * elapsed; g.dirty = true; }
      }
      if (g.moved && scroller) {
        const oldLeft = scroller.scrollLeft;
        const oldTop = scroller.scrollTop;
        const bounds = scroller.getBoundingClientRect();
        scroller.scrollLeft += edgeScrollSpeed(g.pointer.x, bounds.left, bounds.right) * elapsed;
        scroller.scrollTop += edgeScrollSpeed(g.pointer.y, bounds.top, bounds.bottom) * elapsed;
        if (scroller.scrollLeft !== oldLeft || scroller.scrollTop !== oldTop) g.dirty = true;
      }
      previousTime = time;
      if (g.dirty) { g.dirty = false; apply(); }
      if (gesture.current) raf.current = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      const g = gesture.current;
      if (!g || (event.pointerId !== undefined && event.pointerId !== g.pointerId)) return;
      g.pointer = { x: (event.clientX ?? 0), y: (event.clientY ?? 0), shift: event.shiftKey };
      g.dirty = true;
      if (raf.current === null) { previousTime = 0; raf.current = requestAnimationFrame(tick); }
    };
    const up = (event: PointerEvent) => {
      const g = gesture.current;
      if (!g || (event.pointerId !== undefined && event.pointerId !== g.pointerId)) return;
      if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) g.pointer = { x: (event.clientX ?? 0), y: (event.clientY ?? 0), shift: event.shiftKey };
      apply();
      if (!gesture.current) return;
      gesture.current = null;
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
      setMarquee(null);
      if (!g.moved) {
        if (g.deselectOnClick) updateSelection([]);
        if (g.kind === 'marquee') updateSelection(g.baseline);
        setPreview(null);
        setGraphRange(null);
        return;
      }
      if (g.kind !== 'move' || !g.edit || (g.edit.type === 'move-keyframes' && g.edit.deltaTime === 0 && !g.edit.deltaValue)) { setPreview(null); setPreviewSelection(null); setGraphRange(null); return; }
      committing.current = true;
      const edit = g.edit;
      const ticket = generation.current;
      void latest.current.commit([edit]).then(() => {
        if (ticket === generation.current && edit.type === 'move-keyframes') updateSelection(g.refs.map((ref) => ({ ...ref, time: ref.time + edit.deltaTime })));
      }).catch(() => { if (ticket === generation.current) updateSelection(g.refs); }).finally(() => { committing.current = false; setPreview(null); setPreviewSelection(null); setGraphRange(null); });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      cancel();
    };
  }, [apply, cancel, updateSelection]);

  useEffect(() => {
    const previous = environment.current;
    environment.current = { motion: options.motion, fps: options.fps };
    const changedFps = previous.fps !== options.fps;
    const externalMotionChange = previous.motion !== options.motion && (!candidate.current || customMotionFingerprint(options.motion) !== customMotionFingerprint(candidate.current));
    if (committing.current && !changedFps && !externalMotionChange) return;
    cancel();
    updateSelection(selectionRef.current.filter((ref) => options.motion.tracks.some((track) => track.parameterId === ref.parameterId && track.keyframes.some((kf) => kf.time === ref.time))));
  }, [options.motion, options.fps, options.busy, cancel, updateSelection]);

  useEffect(() => {
    const root = options.root.current;
    if (!root) return;
    const sync = () => {
      const canvas = root.querySelector<SVGSVGElement>('.cme__lane-canvas svg, .cme__curve-canvas');
      if (!canvas) { setViewport(null); return; }
      const scroller = getScroller(canvas);
      if (!scroller || !scroller.clientWidth) return;
      const bounds = canvas.getBoundingClientRect();
      const scrollBounds = scroller.getBoundingClientRect();
      const width = Number(canvas.getAttribute('viewBox')?.split(' ')[2]) || bounds.width;
      const scale = bounds.width ? width / bounds.width : 1;
      const left = Math.max(0, (scrollBounds.left - bounds.left - 40) * scale);
      const right = Math.max(left, (scrollBounds.right - bounds.left + 40) * scale);
      setViewport((current) => current?.left === left && current.right === right ? current : { left, right });
    };
    let frame: number | null = null;
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(() => { frame = null; sync(); }); };
    root.addEventListener('scroll', schedule, true);
    const parent = options.scrollContainer ?? root.closest('.timeline-editor-scroll-container');
    parent?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    observer?.observe(root);
    if (parent instanceof HTMLElement) observer?.observe(parent);
    sync();
    return () => { observer?.disconnect(); root.removeEventListener('scroll', schedule, true); parent?.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); if (frame !== null) cancelAnimationFrame(frame); };
  }, [options.root, options.scrollContainer, options.pps, options.blockTime, options.motion, options.view]);

  const startMove = useCallback((event: ReactPointerEvent, track: CustomMotionTrack, graph: boolean, time: number) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    latest.current.root.current?.focus();
    if (committing.current) return;
    const ref = { parameterId: track.parameterId, time };
    const selected = selectionRef.current.some((item) => item.parameterId === ref.parameterId && item.time === time);
    if (event.shiftKey) {
      const refs = selected ? selectionRef.current.filter((item) => item.parameterId !== ref.parameterId || item.time !== time) : [...selectionRef.current, ref];
      updateSelection(refs);
      if (refs.length === 1) latest.current.selectParam(refs[0].parameterId);
      return;
    }
    const refs = selected ? selectionRef.current : [ref];
    latest.current.selectParam(track.parameterId);
    updateSelection(refs);
    if (latest.current.busy || committing.current) return;
    cancel();
    const canvas = (event.currentTarget as Element).closest('svg')!;
    const g: Gesture = {
      kind: 'move', pointerId: event.pointerId, motion: latest.current.motion, canvas, tracks: graph ? [track] : latest.current.motion.tracks,
      graph, startX: event.clientX ?? 0, startY: event.clientY ?? 0, originX: 0, originY: 0, baseline: [], refs, moved: false,
      deselectOnClick: selected && refs.length === 1,
      pointer: { x: (event.clientX ?? 0), y: (event.clientY ?? 0), shift: event.shiftKey },
      resolve: createGroupMoveResolver(latest.current.motion.tracks, refs, latest.current.motion.durationSeconds, latest.current.fps, true),
      range: graph ? latest.current.range(track) : undefined,
    };
    const origin = coordinates(g, event.clientX ?? 0, event.clientY ?? 0);
    g.originX = origin.x; g.originY = origin.y;
    if (graph && g.range) setGraphRange(g.range);
    gesture.current = g;
  }, [cancel, updateSelection]);

  const startMarquee = useCallback((event: ReactPointerEvent<SVGSVGElement>, tracks: readonly CustomMotionTrack[], graph: boolean) => {
    if (event.button !== undefined && event.button !== 0) return;
    if ((event.target as Element).closest('[data-kf], [data-cp]')) return;
    event.preventDefault(); event.stopPropagation();
    latest.current.root.current?.focus();
    if (committing.current) return;
    cancel();
    const baseline = event.shiftKey ? selectionRef.current : [];
    updateSelection(baseline);
    const canvas = graph ? event.currentTarget : latest.current.root.current?.querySelector<SVGSVGElement>('.cme__lane-canvas svg') ?? event.currentTarget;
    const g: Gesture = {
      kind: 'marquee', pointerId: event.pointerId, motion: latest.current.motion, canvas, tracks, graph,
      startX: event.clientX ?? 0, startY: event.clientY ?? 0, originX: 0, originY: 0, baseline, refs: [], moved: false, deselectOnClick: false,
      pointer: { x: (event.clientX ?? 0), y: (event.clientY ?? 0), shift: event.shiftKey }, range: graph ? latest.current.range(tracks[0]) : undefined,
    };
    const origin = coordinates(g, event.clientX ?? 0, event.clientY ?? 0);
    g.originX = origin.x; g.originY = origin.y;
    gesture.current = g;
  }, [cancel, updateSelection]);
  return { selection, displaySelection: previewSelection ?? selection, updateSelection, clear, cancel, preview, marquee, graphRange, viewport, startMove, startMarquee };
}

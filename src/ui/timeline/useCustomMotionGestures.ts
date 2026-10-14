import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject, PointerEvent as ReactPointerEvent } from 'react';
import type { CharacterMotionOutput, CustomMotionTrack } from '../../api/types/semantic-scene';
import type { CustomMotionEditIntent, CustomMotionEditSessionSnapshot, CustomMotionKeyframeIdentity } from '../../services/timeline-authoring/CustomMotionEditingTypes';
import { useOptionalApp } from '../context/AppContext';
import { finiteOr, round6, clampValue } from './customMotionDisplayValues';
import { createGroupMoveResolver, edgeScrollSpeed, keyframeKey, keyframesInRect, selectionRect, type SelectionRect } from './customMotionSelection';

interface SelectionRef { parameterId: string; time: number }
type Range = { min: number; max: number; bounded?: boolean };

type Motion = Extract<CharacterMotionOutput, { kind: 'custom' }>;
interface Options {
  snapshot: CustomMotionEditSessionSnapshot;
  view: 'lanes' | 'graph';
  filterMode: 'all' | 'animated';
  filterQuery: string;
  blockTime: number;
  pps: number;
  root: RefObject<HTMLDivElement | null>;
  scrollContainer?: HTMLElement | null;
  layout: 'panel' | 'timeline';
  playheadTime: number;
  onSeek?: (sceneTime: number) => void;
  selectParam: (id: string) => void;
  range: (track: CustomMotionTrack) => Range;
  onError: (message: string) => void;
}
interface GestureBase {
  pointerId: number;
  motion: Motion;
  fps: number;
  canvas: SVGSVGElement;
  graph: boolean;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
  dirty?: boolean;
  pointer: { x: number; y: number; shift: boolean };
}
type Gesture = GestureBase & (
  | { kind: 'marquee'; tracks: readonly CustomMotionTrack[]; baseline: readonly SelectionRef[]; range?: Range }
  | { kind: 'move'; tracks: readonly CustomMotionTrack[]; refs: readonly SelectionRef[];
      deselectOnClick: boolean; resolve: (frames: number) => number; range?: Range;
      axis?: 'x' | 'y'; panPixels?: number; delta?: { frames: number; value: number };
      destination?: readonly SelectionRef[]; edit?: Extract<CustomMotionEditIntent, { type: 'move-keyframes' | 'update-keyframe' }> }
  | { kind: 'control'; range: Range;
      control: { track: CustomMotionTrack; keyframeIndex: number; index: 0 | 1; startValue: number };
      edit?: Extract<CustomMotionEditIntent, { type: 'set-control-point' }> }
);

function coordinates(g: Gesture, x: number, y: number) {
  const bounds = g.canvas.getBoundingClientRect();
  const width = g.canvas.viewBox?.baseVal?.width || Number(g.canvas.getAttribute('viewBox')?.split(' ')[2]) || bounds.width;
  const height = g.canvas.viewBox?.baseVal?.height || Number(g.canvas.getAttribute('viewBox')?.split(' ')[3]) || bounds.height;
  return { x: (x - bounds.left) * width / (bounds.width || width || 1), y: g.graph ? (y - bounds.top) * height / (bounds.height || height || 1) : y - bounds.top };
}

function samePointer(g: Gesture, event: { pointerId: number }): boolean {
  return event.pointerId === undefined || event.pointerId === g.pointerId;
}

/** Private UI interaction owner. Authoring and leases remain in CustomMotionEditing. */
export function useCustomMotionGestures(input: Options) {
  const playback = useOptionalApp()?.adapters.playback;
  const options = { ...input, pause: () => playback?.pause?.(), motion: input.snapshot.canonicalMotion!, fps: input.snapshot.fps,
    busy: input.snapshot.state === 'readonly' || input.snapshot.state === 'closed' || input.snapshot.committing };

  const latest = useRef(options);
  latest.current = options;
  const [selection, setSelection] = useState<readonly SelectionRef[]>([]);
  const selectionRef = useRef(selection);
  const [readout, setReadout] = useState<{ time: number; value: number; x: number; y: number } | null>(null);
  const [pendingCommit, setPendingCommit] = useState(false);
  const [preview, setPreview] = useState<Motion | null>(null);
  const [previewSelection, setPreviewSelection] = useState<readonly SelectionRef[] | null>(null);
  const [graphRange, setGraphRange] = useState<{ min: number; max: number } | null>(null);
  const [marquee, setMarquee] = useState<SelectionRect | null>(null);
  const viewport = useCustomMotionViewport(options);
  const gesture = useRef<Gesture | null>(null);
  const raf = useRef<number | null>(null);
  const committing = useRef(false);
  const generation = useRef(0);
  const environment = useRef({ motion: options.motion, fps: options.fps, session: options.snapshot.session });
  const keyframeRef = useCallback((parameterId: string, time: number): CustomMotionKeyframeIdentity => {
    const point = latest.current.snapshot.keyframes.find((candidate) => candidate.parameterId === parameterId && candidate.time === time);
    if (!point) throw new Error('关键帧已发生变化，请重新选择');
    return point.ref;
  }, []);
  const previewIntent = useCallback((intent: CustomMotionEditIntent | null): Motion => {
    const snapshot = latest.current.snapshot;
    const result = snapshot.session!.preview(intent);
    if (result.status === 'rejected') {
      if (intent) throw new Error(result.reason ?? '编辑会话已失效');
      return snapshot.canonicalMotion!;
    }
    return result.status === 'previewed' ? result.motion : snapshot.canonicalMotion!;
  }, []);
  const updateSelection = useCallback((refs: readonly SelectionRef[]) => {
    const current = selectionRef.current;
    if (current.length === refs.length && current.every((ref, index) => ref.parameterId === refs[index].parameterId && ref.time === refs[index].time)) return;
    selectionRef.current = refs;
    setSelection(refs);
  }, []);
  const cancel = useCallback(() => {
    generation.current++;
    if (gesture.current?.kind === 'marquee') updateSelection(gesture.current.baseline);
    gesture.current = null;
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (!committing.current) previewIntent(null);
    setPreview(null);
    setPreviewSelection(null);
    setMarquee(null);
    setGraphRange(null);
    setReadout(null);
  }, [previewIntent, updateSelection]);
  const clear = useCallback(() => { cancel(); updateSelection([]); }, [cancel, updateSelection]);
  useEffect(() => { clear(); }, [input.view, input.filterMode, input.filterQuery, clear]);
  const playhead = useCustomMotionPlayhead(input, clear, committing);
  const commit = useCallback(async (intent: CustomMotionEditIntent) => {
    const o = latest.current;
    if (o.busy || committing.current) throw new Error('编辑器当前不可写');
    // Numeric/discrete edits also exclude active gestures and share the commit guard.
    if (gesture.current) cancel();
    o.pause();
    committing.current = true;
    setPendingCommit(true);
    const session = o.snapshot.session!;
    try {
      previewIntent(intent);
      const result = await session.commit();
      if (result.status === 'dropped') throw new Error(result.reason ?? '编辑会话已失效');
    } catch (error) {
      o.onError(error instanceof Error ? error.message : '关键帧修改失败，请重试');
      throw error;
    } finally {
      // Use the captured session: a late completion must never clear a newer session.
      session.preview(null);
      committing.current = false;
      setPendingCommit(false);
    }
  }, [cancel, previewIntent]);
  const getScroller = (canvas?: SVGSVGElement) => latest.current.scrollContainer
    ?? canvas?.closest<HTMLElement>('.timeline-editor-scroll-container')
    ?? canvas?.closest<HTMLElement>('.cme__lanes, .cme__curve-wrap');
  const apply = useCallback(() => {
    const g = gesture.current;
    if (!g) return;
    const o = latest.current;
    if (o.motion !== g.motion || o.fps !== g.fps || (o.busy && g.kind !== 'marquee') || committing.current) { cancel(); return; }
    const point = coordinates(g, g.pointer.x, g.pointer.y);
    if (!g.moved && Math.hypot(g.pointer.x - g.startX, g.pointer.y - g.startY) > 4) {
      g.moved = true;
      if (g.kind !== 'marquee') o.pause();
    }
    if (!g.moved) return;
    if (g.kind === 'control') {
      const control = g.control;
      const keyframe = control.track.keyframes[control.keyframeIndex];
      const segment = keyframe.segment;
      const next = control.track.keyframes[control.keyframeIndex + 1];
      if (segment?.type !== 'bezier' || !next || !g.range) { cancel(); return; }
      const frameTime = Math.round((point.x / o.pps - o.blockTime) * o.fps) / o.fps;
      const min = control.index === 0 ? keyframe.time : segment.controlPoints[0].time;
      const max = control.index === 0 ? segment.controlPoints[1].time : next.time;
      const time = Math.max(min, Math.min(max, frameTime));
      const rawValue = control.startValue + (g.originY - point.y) / 122 * (g.range.max - g.range.min);
      const value = g.range.bounded ? Math.max(g.range.min, Math.min(g.range.max, rawValue)) : rawValue;
      try {
        const edit: Extract<CustomMotionEditIntent, { type: 'set-control-point' }> = { type: 'set-control-point', keyframe: keyframeRef(control.track.parameterId, keyframe.time), index: control.index, frame: Math.round(time * o.fps), value };
        if (g.edit?.type !== 'set-control-point' || g.edit.frame !== edit.frame || g.edit.value !== value) {
          setPreview(previewIntent(edit));
          g.edit = edit;
        }
        setReadout({ time, value, x: g.pointer.x, y: g.pointer.y });
      } catch (error) { cancel(); o.onError(error instanceof Error ? error.message : '控制点修改失败'); }
      return;
    }
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
    const deltaFrames = g.resolve(lockedAxis === 'y' ? 0 : (point.x - g.originX) / o.pps * o.fps);
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
    try {
      if (g.delta?.frames === deltaFrames && g.delta.value === deltaValue) return;
      const ref = g.refs[0];
      // Native single points need an absolute frame: their snapped displacement
      // can be fractional, while move-keyframes accepts integer frame deltas.
      const nativeSingle = g.refs.length === 1 && Math.abs(ref.time * o.fps - Math.round(ref.time * o.fps)) > 1e-9;
      const edit: CustomMotionEditIntent = nativeSingle
        ? { type: 'update-keyframe', keyframe: keyframeRef(ref.parameterId, ref.time),
            value: g.tracks.find((track) => track.parameterId === ref.parameterId)!.keyframes.find((kf) => kf.time === ref.time)!.value + deltaValue,
            ...(deltaFrames === 0 ? {} : { frame: Math.round(ref.time * o.fps + deltaFrames) }) }
        : { type: 'move-keyframes', keyframes: g.refs.map((item) => keyframeRef(item.parameterId, item.time)), deltaFrames, deltaValue };
      setPreview(previewIntent(edit));
      g.edit = edit;
      g.delta = { frames: deltaFrames, value: deltaValue };
      g.destination = g.refs.map((item) => ({ ...item, time: deltaFrames === 0 ? item.time : Math.round(item.time * o.fps + deltaFrames) / o.fps }));
      setPreviewSelection(g.destination);
    }
    catch (error) { cancel(); o.onError(error instanceof Error ? error.message : '无法移动关键帧'); }
  }, [cancel, updateSelection, keyframeRef, previewIntent]);

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
      if (g.moved && g.kind !== 'control' && scroller) {
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
      if (!g || !samePointer(g, event)) return;
      g.pointer = { x: (event.clientX ?? 0), y: (event.clientY ?? 0), shift: event.shiftKey };
      g.dirty = true;
      if (raf.current === null) { previousTime = 0; raf.current = requestAnimationFrame(tick); }
    };
    const up = (event: PointerEvent) => {
      const g = gesture.current;
      if (!g || !samePointer(g, event)) return;
      if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) g.pointer = { x: (event.clientX ?? 0), y: (event.clientY ?? 0), shift: event.shiftKey };
      apply();
      if (!gesture.current) return;
      gesture.current = null;
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
      setMarquee(null);
      setReadout(null);
      if (!g.moved) {
        if (g.kind === 'move' && g.deselectOnClick) updateSelection([]);
        if (g.kind === 'marquee') updateSelection(g.baseline);
        setPreview(null);
        setGraphRange(null);
        return;
      }
      if (g.kind === 'marquee' || !g.edit || (g.kind === 'move' && g.delta?.frames === 0 && !g.delta.value)) { previewIntent(null); setPreview(null); setPreviewSelection(null); setGraphRange(null); return; }
      const edit = g.edit;
      const ticket = generation.current;
      void commit(edit).then(() => {
        if (ticket === generation.current && g.kind === 'move' && g.destination) updateSelection(g.destination);
      }).catch(() => {
        if (ticket === generation.current && g.kind === 'move') {
          updateSelection(g.refs.filter((ref) => latest.current.motion.tracks.some((track) => track.parameterId === ref.parameterId && track.keyframes.some((point) => point.time === ref.time))));
        }
      }).finally(() => {
        if (ticket === generation.current) { setPreview(null); setPreviewSelection(null); setGraphRange(null); }
      });
    };
    const pointerCancel = (event: PointerEvent) => {
      if (gesture.current && samePointer(gesture.current, event)) cancel();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', pointerCancel);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', pointerCancel);
      window.removeEventListener('blur', cancel);
      cancel();
    };
  }, [apply, cancel, updateSelection, commit, previewIntent]);

  useEffect(() => {
    const previous = environment.current;
    environment.current = { motion: options.motion, fps: options.fps, session: options.snapshot.session };
    const changedFps = previous.fps !== options.fps;
    const invalid = changedFps || previous.session !== options.snapshot.session || options.snapshot.state === 'readonly' || options.snapshot.state === 'closed';
    if (committing.current && !invalid) return;
    cancel();
    updateSelection(selectionRef.current.filter((ref) => options.motion.tracks.some((track) => track.parameterId === ref.parameterId && track.keyframes.some((kf) => kf.time === ref.time))));
  }, [options.motion, options.fps, options.busy, options.snapshot.session, options.snapshot.state, cancel, updateSelection]);

  const startMove = useCallback((event: ReactPointerEvent, track: CustomMotionTrack, graph: boolean, time: number) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    latest.current.root.current?.focus();
    if (committing.current || (gesture.current && !samePointer(gesture.current, event))) return;
    cancel();
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
    const canvas = (event.currentTarget as Element).closest('svg')!;
    const g: Gesture = {
      kind: 'move', pointerId: event.pointerId, motion: latest.current.motion, fps: latest.current.fps, canvas, tracks: graph ? [track] : latest.current.motion.tracks,
      graph, startX: event.clientX ?? 0, startY: event.clientY ?? 0, originX: 0, originY: 0, refs, moved: false,
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

  const startControlPoint = useCallback((event: ReactPointerEvent, track: CustomMotionTrack, keyframeIndex: number, index: 0 | 1) => {
    const o = latest.current;
    if (o.busy || committing.current || (gesture.current && !samePointer(gesture.current, event)) || (event.button !== undefined && event.button !== 0)) return;
    const keyframe = track.keyframes[keyframeIndex];
    if (keyframe.segment?.type !== 'bezier' || !track.keyframes[keyframeIndex + 1]) return;
    event.preventDefault(); event.stopPropagation();
    o.root.current?.focus();
    cancel();
    o.pause();
    o.selectParam(track.parameterId);
    updateSelection([{ parameterId: track.parameterId, time: keyframe.time }]);
    const canvas = (event.currentTarget as Element).closest('svg')!;
    const g: Gesture = {
      kind: 'control', pointerId: event.pointerId, motion: o.motion, fps: o.fps, canvas, graph: true,
      startX: event.clientX ?? 0, startY: event.clientY ?? 0, originX: 0, originY: 0,
      moved: false,
      pointer: { x: event.clientX ?? 0, y: event.clientY ?? 0, shift: false }, range: o.range(track),
      control: { track, keyframeIndex, index, startValue: keyframe.segment.controlPoints[index].value },
    };
    const origin = coordinates(g, g.startX, g.startY);
    g.originX = origin.x; g.originY = origin.y;
    gesture.current = g;
  }, [cancel, updateSelection]);
  const startMarquee = useCallback((event: ReactPointerEvent<SVGSVGElement>, tracks: readonly CustomMotionTrack[], graph: boolean) => {
    if (event.button !== undefined && event.button !== 0) return;
    if ((event.target as Element).closest('[data-kf], [data-cp]')) return;
    event.preventDefault(); event.stopPropagation();
    latest.current.root.current?.focus();
    if (committing.current || (gesture.current && !samePointer(gesture.current, event))) return;
    cancel();
    const baseline = event.shiftKey ? selectionRef.current : [];
    updateSelection(baseline);
    const canvas = graph ? event.currentTarget : latest.current.root.current?.querySelector<SVGSVGElement>('.cme__lane-canvas svg') ?? event.currentTarget;
    const g: Gesture = {
      kind: 'marquee', pointerId: event.pointerId, motion: latest.current.motion, fps: latest.current.fps, canvas, tracks, graph,
      startX: event.clientX ?? 0, startY: event.clientY ?? 0, originX: 0, originY: 0, baseline, moved: false,
      pointer: { x: (event.clientX ?? 0), y: (event.clientY ?? 0), shift: event.shiftKey }, range: graph ? latest.current.range(tracks[0]) : undefined,
    };
    const origin = coordinates(g, event.clientX ?? 0, event.clientY ?? 0);
    g.originX = origin.x; g.originY = origin.y;
    gesture.current = g;
  }, [cancel, updateSelection]);
  const displaySelection = previewSelection ?? selection;
  const previousSelectionByTrack = useRef(new Map<string, Set<number>>());
  const selectionByTrack = useMemo(() => {
    const result = new Map<string, Set<number>>();
    for (const ref of displaySelection) {
      const times = result.get(ref.parameterId) ?? new Set<number>();
      times.add(ref.time); result.set(ref.parameterId, times);
    }
    for (const [id, times] of result) {
      const previous = previousSelectionByTrack.current.get(id);
      if (previous && previous.size === times.size && [...times].every((time) => previous.has(time))) result.set(id, previous);
    }
    previousSelectionByTrack.current = result;
    return result;
  }, [displaySelection]);
  const select = useCallback((refs: readonly SelectionRef[]) => { cancel(); updateSelection(refs); }, [cancel, updateSelection]);
  const previewValue = useCallback((intent: CustomMotionEditIntent) => {
    const o = latest.current;
    if (o.busy || committing.current) return o.motion;
    if (gesture.current) cancel();
    o.pause();
    return previewIntent(intent);
  }, [cancel, previewIntent]);
  return { selection, displaySelection, selectionByTrack, select, clear,
    motion: preview ?? options.snapshot.motion ?? options.motion, readout, marquee, graphRange, viewport,
    startMove, startMarquee, startControlPoint, commit, preview: previewValue, keyframeRef, playhead,
    writeBlocked: options.busy || pendingCommit };
}

export type CustomMotionGestures = ReturnType<typeof useCustomMotionGestures>;

/** Viewport observation is presentation work, independent of the editing lifecycle. */
function useCustomMotionViewport(options: Options & { motion: Motion }) {
  const latest = useRef(options);
  latest.current = options;
  const [viewport, setViewport] = useState<{ left: number; right: number } | null>(() => options.scrollContainer?.clientWidth ? { left: Math.max(0, options.scrollContainer.scrollLeft - 190), right: options.scrollContainer.scrollLeft + options.scrollContainer.clientWidth + 40 } : null);
  const getScroller = (canvas?: SVGSVGElement) => latest.current.scrollContainer
    ?? canvas?.closest<HTMLElement>('.timeline-editor-scroll-container')
    ?? canvas?.closest<HTMLElement>('.cme__lanes, .cme__curve-wrap');
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

  return viewport;
}

/** External seeks invalidate gestures; navigator seeks retain their new selection. */
function useCustomMotionPlayhead(options: Options, clearSelection: () => void, committing: RefObject<boolean>) {
  const playback = useOptionalApp()?.adapters.playback;
  const { playheadTime, layout, onSeek, blockTime, snapshot } = options;
  const duration = snapshot.canonicalMotion!.durationSeconds;
  const isTimeline = layout === 'timeline';
  // TrackArea stores the latest adapter notification in a ref because its
  // density rendering does not re-render for every playhead tick. On first
  // mount that value is newer than the engine getter while an async seek is
  // still settling, so the embedded timeline must use the prop it was given.
  // Standalone panel instances do not have that ref-backed contract and keep
  // the adapter getter as their initial source when it is available.
  const initialPlaybackTime = playback?.getCurrentTime();
  const initialLivePlayheadTime = isTimeline
    ? finiteOr(playheadTime, finiteOr(initialPlaybackTime, 0))
    : finiteOr(initialPlaybackTime, finiteOr(playheadTime, 0));
  const livePlayheadTimeRef = useRef(initialLivePlayheadTime);
  const [livePlayheadTime, setLivePlayheadTime] = useState(initialLivePlayheadTime);
  const initialBodyTime = useRef(initialLivePlayheadTime);
  const internalSeekRef = useRef<number | null>(null);

  useEffect(() => {
    const write = (time: number) => {
      if (!Number.isFinite(time)) return;
      if (livePlayheadTimeRef.current !== time && !committing.current) {
        if (internalSeekRef.current === null || Math.abs(internalSeekRef.current - time) > 1e-6) clearSelection();
        internalSeekRef.current = null;
      }
      livePlayheadTimeRef.current = time;
      setLivePlayheadTime(time);
    };
    if (!playback) return;
    return playback.subscribeTime(write);
  }, [playback, clearSelection, committing]);

  useEffect(() => {
    // Once mounted, adapter notifications are authoritative. The timeline
    // prop is only the bootstrapping value because TrackArea may have received
    // a newer notification before this editor mounted; copying a later parent
    // render back here would reintroduce a stale density bucket.
    if (playback || !Number.isFinite(playheadTime) || livePlayheadTimeRef.current === playheadTime) return;
    if (internalSeekRef.current === null || Math.abs(internalSeekRef.current - playheadTime) > 1e-6) clearSelection();
    internalSeekRef.current = null;
    livePlayheadTimeRef.current = playheadTime;
    setLivePlayheadTime(playheadTime);
  }, [playback, playheadTime, clearSelection]);

  const seekToScene = useCallback((sceneTime: number) => {
    internalSeekRef.current = sceneTime;
    onSeek?.(sceneTime);
  }, [onSeek]);

  const getLocalPlayheadTime = useCallback(
    () => {
      // The ref makes pointer/key interactions use the newest seek event even
      // before React commits the corresponding state update.
      const sceneTime = Number.isFinite(livePlayheadTimeRef.current)
        ? livePlayheadTimeRef.current
        : 0;
      // Keep native subframe precision for existing-point lookup. Newly
      // authored points snap to scene frames at the edit boundary.
      return round6(clampValue(sceneTime - blockTime, 0, duration));
    },
    [blockTime, duration],
  );

  return { time: livePlayheadTime, bodyTime: playback ? initialBodyTime.current : livePlayheadTime,
    getLocalTime: getLocalPlayheadTime, seek: seekToScene };
}

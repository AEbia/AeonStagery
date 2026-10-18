import type { NumericInputGesture } from './FormComponents';
import { useCallback, useEffect, useRef } from 'react';
import type { IPlaybackAdapter } from '../../api/interfaces';
import type { TransformPreviewUpdates } from '../../api/interfaces/IPlaybackAdapter';
import { STAGE_HEIGHT, STAGE_WIDTH } from '../../engine/Live2DConfig';
import type { TimelineAction } from './semanticTimelineTypes';

/** Authoring positions are normalized; character proxies use stage pixels. */
export function inspectorTransformPreview(action: TimelineAction, patch: Readonly<Record<string, unknown>>) {
  const environment = action.action === 'setEnvironmentLayer' || action.action === 'transformEnvironmentLayer';
  const character = action.action === 'addCharacter' || action.action === 'transformCharacter';
  if (!environment && !character) return null;
  const id: unknown = environment ? action.params.layerId : action.params.id;
  if (typeof id !== 'string' || !id) return null;
  const updates: TransformPreviewUpdates = {};
  for (const key of ['x', 'y', 'z', 'scale', 'rotation', 'opacity'] as const) {
    const value = patch[key];
    if (typeof value === 'number' && Number.isFinite(value)) updates[key] = value;
  }
  const position = patch.position;
  if (Array.isArray(position) && position.length === 2
    && position.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) {
    updates.x = Number(position[0]) * (character ? STAGE_WIDTH : 1);
    updates.y = Number(position[1]) * (character ? STAGE_HEIGHT : 1);
  }
  if (!Object.keys(updates).length) return null;
  return { id, environment, updates };
}

interface TransformPreviewSession {
  readonly actionId: string;
  readonly gesture?: NumericInputGesture;
  readonly apply: () => void;
  readonly detach: () => void;
  input: NonNullable<ReturnType<typeof inspectorTransformPreview>>;
}

/** A drag owns runtime state until its single source commit or cancellation. */
export function useInspectorTransformPreview(playback: IPlaybackAdapter, scope: unknown) {
  const active = useRef<TransformPreviewSession | null>(null);
  const registeredGestures = useRef(new Set<NumericInputGesture>());
  const cancelledLegacy = useRef<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const restore = useCallback(() => {
    const reapply = () => {
      // A reconstruction can await model/path work while another drag starts.
      // Its eventual proxy writes must not erase that newer temporary pose.
      const latest = active.current;
      if (mounted.current && latest && !latest.gesture?.signal.aborted) latest.apply();
    };
    void playback.seek(playback.getCurrentTime(), true).then(reapply, reapply);
  }, [playback]);
  const cancel = useCallback(() => {
    const session = active.current;
    if (!session) return;
    active.current = null;
    session.detach();
    if (!session.gesture) cancelledLegacy.current = session.actionId;
    session.gesture?.cancel();
    restore();
  }, [restore]);
  const registerNumericGesture = useCallback((gesture: NumericInputGesture) => {
    registeredGestures.current.add(gesture);
    return () => registeredGestures.current.delete(gesture);
  }, []);
  useEffect(() => {
    mounted.current = true;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', cancel);
    return () => {
      mounted.current = false;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', cancel);
      for (const gesture of [...registeredGestures.current]) gesture.cancel();
      cancel();
    };
  }, [cancel, scope]);
  const preview = useCallback((action: TimelineAction, patch: Readonly<Record<string, unknown>>, gesture?: NumericInputGesture) => {
    if (!mounted.current || !action._id || gesture?.signal.aborted) return;
    if (!gesture && cancelledLegacy.current === action._id) return;
    const input = inspectorTransformPreview(action, patch);
    if (!input) return;
    const project = input.environment ? playback.previewEnvironmentLayerTransform : playback.previewTransform;
    if (!project) return;
    let session = active.current;
    if (session && (session.actionId !== action._id || session.gesture?.signal !== gesture?.signal)) {
      cancel();
      session = null;
    }
    if (!session) {
      generation.current += 1;
      const next: TransformPreviewSession = {
        actionId: action._id, gesture, input,
        apply: () => project.call(playback, next.input.id, next.input.updates),
        detach: () => gesture?.signal.removeEventListener('abort', onAbort),
      };
      const onAbort = () => { if (active.current === next) cancel(); };
      gesture?.signal.addEventListener('abort', onAbort, { once: true });
      active.current = next;
      session = next;
      playback.pause();
    } else {
      session.input = { ...input, updates: { ...session.input.updates, ...input.updates } };
    }
    session.apply();
  }, [playback, cancel]);
  const commit = useCallback(async (id: string, author: () => unknown, gesture?: NumericInputGesture) => {
    if (!mounted.current || gesture?.signal.aborted) return;
    if (!gesture && cancelledLegacy.current === id) {
      cancelledLegacy.current = null;
      return;
    }
    const session = active.current?.actionId === id ? active.current : null;
    const commitGeneration = generation.current;
    if (session) {
      active.current = null;
      session.detach();
    }
    try {
      return await author();
    } finally {
      if (session && active.current === null && generation.current === commitGeneration) restore();
    }
  }, [restore]);
  return { preview, commit, registerNumericGesture };
}

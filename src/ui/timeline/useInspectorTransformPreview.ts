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

/** A drag owns runtime state until its single source commit or cancellation. */
export function useInspectorTransformPreview(playback: IPlaybackAdapter, scope: unknown) {
  const active = useRef<string | null>(null);
  const cancelled = useRef<string | null>(null);
  const mounted = useRef(false);
  const restore = useCallback(() => {
    // A hard reconstruction clears previewed opacity/geometry as well as the
    // GSAP proxy cache, including when authoring rejected the final value.
    void playback.seek(playback.getCurrentTime(), true).catch(() => {});
  }, [playback]);
  const cancel = useCallback(() => {
    if (active.current === null) return;
    cancelled.current = active.current;
    active.current = null;
    restore();
  }, [restore]);
  useEffect(() => {
    mounted.current = true;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', cancel);
    return () => {
      mounted.current = false;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', cancel);
      cancel();
    };
  }, [cancel, scope]);
  const preview = useCallback((action: TimelineAction, patch: Readonly<Record<string, unknown>>) => {
    if (!mounted.current || !action._id || cancelled.current === action._id) return;
    const input = inspectorTransformPreview(action, patch);
    if (!input) return;
    const apply = input.environment ? playback.previewEnvironmentLayerTransform : playback.previewTransform;
    if (!apply) return;
    if (active.current === null) playback.pause();
    active.current = action._id;
    apply.call(playback, input.id, input.updates);
  }, [playback]);
  const commit = useCallback(async (id: string, author: () => unknown) => {
    if (!mounted.current) return;
    if (cancelled.current === id) {
      cancelled.current = null;
      return;
    }
    const wasPreviewing = active.current === id;
    if (wasPreviewing) active.current = null;
    try {
      return await author();
    } finally {
      if (wasPreviewing && active.current === null) restore();
    }
  }, [restore]);
  return { preview, commit };
}

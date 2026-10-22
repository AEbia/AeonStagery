import type { RuntimeTimelineAction, RuntimeTimelineScene } from './RuntimeTimelineScene';

const HZ = 15;

/** Only camera-observable poses: focus starts and active follow intervals. */
export function cameraAnchorDemand(scene: RuntimeTimelineScene, throughTime: number) {
  const times = new Set<number>();
  const characterIds = new Set<string>();
  const actions = [...scene.timeline].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  let following: { start: number; end: number } | undefined;
  const finishFollow = (at: number) => {
    if (!following) return;
    const end = Math.min(at, following.end, throughTime);
    times.add(following.start);
    times.add(end);
    for (let index = Math.ceil(following.start * HZ); index / HZ < end; index++) times.add(index / HZ);
    following = undefined;
  };
  for (const action of actions) {
    const start = action.time ?? 0;
    if (start > throughTime) break;
    const params: Readonly<Record<string, unknown>> = action.params;
    const properties = params._cameraProperties;
    const writesPosition = Array.isArray(properties) && properties.includes('position');
    if (action.action === 'cameraFollow') {
      finishFollow(start);
      const duration = params.duration;
      following = { start, end: typeof duration === 'number' && duration >= 0 ? start + duration : Infinity };
      const id = target(action);
      if (id) characterIds.add(id);
    } else if (action.action === 'cameraUnfollow' || action.action === 'cameraReset' || writesPosition) {
      finishFollow(start);
    }
    if (action.action === 'cameraMotion' && writesPosition) {
      const id = target(action);
      if (id) { times.add(start); characterIds.add(id); }
    }
  }
  finishFollow(throughTime);
  // Pose transitions establish fade sources. Keep their exact boundaries,
  // without filling the idle gaps between them with model simulation frames.
  for (const action of actions) {
    const start = action.time ?? 0;
    if (start > throughTime) break;
    const id: unknown = action.params.id;
    if (typeof id !== 'string' || !characterIds.has(id)) continue;
    times.add(start);
    if (start > 0) times.add(Math.max(0, start - 1e-6));
    const duration: unknown = action.params.duration;
    if (action.action === 'transformCharacter' && typeof duration === 'number' && duration > 0
      && start + duration <= throughTime) times.add(start + duration);
  }
  return { times: [...times].sort((a, b) => a - b), characterIds };
}

function target(action: RuntimeTimelineAction): string | undefined {
  const params: Readonly<Record<string, unknown>> = action.params;
  const focus = params.focus;
  if (typeof focus === 'object' && focus !== null && 'character' in focus && typeof focus.character === 'string') return focus.character;
  for (const key of ['characterId', 'targetCharacter']) {
    const value = params[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

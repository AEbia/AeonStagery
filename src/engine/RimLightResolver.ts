import type { RuntimeTimelineAction, RuntimeTimelineScene } from './RuntimeTimelineScene';
import type { RimLightStyleState } from '../api/types/visual';
import { evaluateGsapEase } from './RuntimeSceneState';

const NEUTRAL_RIM_LIGHT: RimLightStyleState = {
  color: '#ffffff',
  intensity: 0,
  thickness: 10,
  angle: 45,
  softness: 2,
};

export interface ResolvedRimLightState extends RimLightStyleState {
  readonly alpha: number;
  readonly actionTime?: number;
  readonly actionId?: string;
  readonly source: 'baseline' | 'set' | 'modulate';
}

export function resolveRimLightStateAtTime(
  scene: Pick<RuntimeTimelineScene, 'visual' | 'timeline'>,
  time: number,
): Map<string, ResolvedRimLightState> {
  const states = collectBaselines(scene);
  const latched = new Map<string, ResolvedRimLightState>();
  const events = scene.timeline
    .map((action, index) => ({ action, index, time: action.time ?? 0 }))
    .filter((event) => event.time <= time && event.action.action === 'setCharacterRimLight')
    .sort((left, right) => left.time - right.time || left.index - right.index);

  for (const { action, time: actionTime } of events) {
    const params = action.params ?? {};
    const characterId = typeof params.id === 'string' ? params.id : undefined;
    if (!characterId) continue;

    const mode = params.mode === 'modulate' || params.mode === 'reset' ? params.mode : 'set';
    if (mode === 'reset') {
      const previous = states.get(characterId) ?? fromBaseline(NEUTRAL_RIM_LIGHT);
      const baseline = resolveBaseline(scene, characterId);
      const duration = Math.max(0, finiteNumber(params.duration, 0));
      latched.delete(characterId);
      if (duration > 0 && time < actionTime + duration) {
        states.set(characterId, interpolateTransition(previous, baseline, (time - actionTime) / duration));
      } else {
        restoreBaseline(states, scene, characterId);
      }
      continue;
    }

    const resolved = resolveCue(action, actionTime, mode);
    if (mode === 'set') {
      const previous = states.get(characterId) ?? fromBaseline(NEUTRAL_RIM_LIGHT);
      const duration = Math.max(0, finiteNumber(params.duration, 0));
      latched.set(characterId, resolved);
      states.set(characterId, duration > 0 && time < actionTime + duration
        ? interpolateTransition(previous, resolved, (time - actionTime) / duration)
        : resolved);
      continue;
    }

    const duration = Math.max(0, finiteNumber(params.duration, 0));
    if (time >= actionTime && time < actionTime + duration) {
      states.set(characterId, resolved);
    } else if (latched.has(characterId)) {
      states.set(characterId, latched.get(characterId)!);
    } else {
      restoreBaseline(states, scene, characterId);
    }
  }

  return states;
}

function collectBaselines(
  scene: Pick<RuntimeTimelineScene, 'visual'>,
): Map<string, ResolvedRimLightState> {
  const states = new Map<string, ResolvedRimLightState>();
  for (const [targetId, target] of Object.entries(scene.visual?.visualTargets ?? {})) {
    if (target.targetType !== 'character' || !target.rimLightBaseline) continue;
    states.set(targetId, fromBaseline(target.rimLightBaseline));
  }
  return states;
}

function restoreBaseline(
  states: Map<string, ResolvedRimLightState>,
  scene: Pick<RuntimeTimelineScene, 'visual'>,
  characterId: string,
): void {
  const resolved = resolveBaseline(scene, characterId);
  if (resolved.alpha > 0) states.set(characterId, resolved);
  else states.delete(characterId);
}

function resolveBaseline(
  scene: Pick<RuntimeTimelineScene, 'visual'>,
  characterId: string,
): ResolvedRimLightState {
  const baseline = scene.visual?.visualTargets?.[characterId]?.rimLightBaseline;
  return fromBaseline(baseline ?? NEUTRAL_RIM_LIGHT);
}

function fromBaseline(baseline: RimLightStyleState): ResolvedRimLightState {
  return {
    ...baseline,
    alpha: baseline.intensity,
    source: 'baseline',
  };
}

function interpolateTransition(
  from: ResolvedRimLightState,
  to: ResolvedRimLightState,
  progress: number,
): ResolvedRimLightState {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const easedProgress = evaluateGsapEase('power2.inOut', clampedProgress);
  return {
    ...to,
    alpha: from.alpha + (to.alpha - from.alpha) * easedProgress,
  };
}

function resolveCue(
  action: RuntimeTimelineAction,
  actionTime: number,
  source: 'set' | 'modulate',
): ResolvedRimLightState {
  const params = action.params ?? {};
  const intensity = finiteNumber(params.intensity, 1);
  return {
    color: typeof params.color === 'string' ? params.color : '#ffffff',
    intensity,
    thickness: finiteNumber(params.thickness, 10),
    angle: finiteNumber(params.angle, 45),
    softness: finiteNumber(params.softness, 2),
    alpha: intensity,
    actionTime,
    ...(action._id ? { actionId: action._id } : {}),
    source,
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import type { RuntimeTimelineScene } from './RuntimeTimelineScene';
import type { EnvironmentLayerRenderState } from './environmentLayerModel';
import { reconstructEnvironmentAtTime } from './EnvironmentLayerRuntime';
import { resolveLookAtFocus, type LookAtPointLookup } from './lookAtFocus';
import {
  CHARACTER_STAGE_HEIGHT,
  DEFAULT_CHARACTER_ENTER_EASE,
  DEFAULT_CHARACTER_EXIT_EASE,
  DEFAULT_CHARACTER_MODEL_HEIGHT,
  DEFAULT_CHARACTER_TRANSFORM_EASE,
  characterSlideEntranceOffsetNormalized,
  evaluateCharacterEase,
} from './CharacterAnimationContract';

const STAGE_HEIGHT = CHARACTER_STAGE_HEIGHT;
const DEFAULT_CHARACTER_POSITION: [number, number] = [0.5, 0.5];
const DEFAULT_CHARACTER_SCALE = 1;
const DEFAULT_CHARACTER_ROTATION = 0;
const DEFAULT_ENTER_DURATION_SECONDS = 0.6;
const DEFAULT_BLINK_INTERVAL_SECONDS = 4;
const DEFAULT_LOOK_AT_DURATION_SECONDS = 0.5;
const DEFAULT_LOOK_AT_EASE = 'power1.out';
const MILLISECONDS_PER_SECOND = 1000;

export interface RuntimeImageLayerState {
  id: string;
  file: string;
  position: [number, number];
  scale: number;
  rotation: number;
  opacity: number;
  zIndex: number;
  z?: number;
  config: Record<string, any>;
  removing?: boolean;
}

export interface RuntimeTextLayerState {
  id: string;
  text: string;
  position: [number, number];
  scale: number;
  rotation: number;
  opacity: number;
  config: Record<string, any>;
  typewriterProgress?: number;
  removing?: boolean;
}

interface RuntimeLookAtState {
  params: Record<string, any>;
  startTime: number;
  duration: number;
  fromFocus: [number, number];
  toFocus: [number, number];
}

function normalizePosition(value: any, fallback: [number, number] = [0.5, 0.5]): [number, number] {
  if (Array.isArray(value)) {
    return [
      typeof value[0] === 'number' ? value[0] : fallback[0],
      typeof value[1] === 'number' ? value[1] : fallback[1],
    ];
  }
  if (value && typeof value === 'object') {
    return [
      typeof value.x === 'number' ? value.x : fallback[0],
      typeof value.y === 'number' ? value.y : fallback[1],
    ];
  }
  return [...fallback] as [number, number];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function interpolateNumber(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function interpolatePosition(
  from: [number, number],
  to: [number, number],
  progress: number,
): [number, number] {
  return [
    interpolateNumber(from[0], to[0], progress),
    interpolateNumber(from[1], to[1], progress),
  ];
}

function normalizeDuration(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}

function resolveLookAtFocusTuple(
  params: Record<string, any>,
  lookup: LookAtPointLookup | undefined,
  selfId: string,
): [number, number] {
  const resolved = resolveLookAtFocus(params, lookup, selfId);
  return [resolved[0], resolved[1]];
}

function resolveSceneLookAtFocusTuple(
  params: Record<string, any>,
  characters: Map<string, any>,
  selfId: string,
): [number, number] {
  const lookup: LookAtPointLookup = (id) => {
    const char = characters.get(id);
    if (!char) return null;
    const position = Array.isArray(char.position)
      ? char.position
      : DEFAULT_CHARACTER_POSITION;
    return { x: Number(position[0]), y: Number(position[1]) };
  };
  const resolved = resolveLookAtFocus(params, lookup, selfId);
  return [resolved[0], resolved[1]];
}

function evaluateLookAtState(
  state: RuntimeLookAtState,
  time: number,
  characters: Map<string, any>,
): Record<string, any> {
  const target = typeof state.params.target === 'string' && state.params.target.trim()
    ? state.params.target.trim()
    : '';
  // Target-follow lookAt must resolve against the character positions at the
  // requested time, not the direction captured when the action was scheduled.
  const desiredFocus = target
    ? resolveSceneLookAtFocusTuple(state.params, characters, state.params.id)
    : state.toFocus;
  const progress = state.duration > 0
    ? clamp01((time - state.startTime) / state.duration)
    : 1;
  const eased = state.duration > 0 && time < state.startTime + state.duration
    ? evaluateCharacterEase(DEFAULT_LOOK_AT_EASE, progress, DEFAULT_LOOK_AT_EASE)
    : 1;
  return {
    ...state.params,
    startTime: state.startTime,
    duration: state.duration,
    fromFocus: [...state.fromFocus] as [number, number],
    toFocus: [...state.toFocus] as [number, number],
    focus: [
      interpolateNumber(state.fromFocus[0], desiredFocus[0], eased),
      interpolateNumber(state.fromFocus[1], desiredFocus[1], eased),
    ],
  };
}

/**
 * Resolve dialogue display fields the same way `scheduleDialogue` does before
 * `showDialogue`. `computeSceneStateAtTime` is used by seek/scrub/export to
 * restore dialogue from the runtime timeline, so its dialogue config must match
 * the cache key used when the dialogue timeline was originally scheduled.
 */
function resolveDialogueSpeaker(
  params: Record<string, any>,
  script: RuntimeTimelineScene,
): { speaker: string | undefined; speakerColor: string | undefined } {
  const speakerId = params.speakerId;
  const charMeta = speakerId
    ? script.meta.characters?.find((character) => character.id === speakerId)
    : undefined;
  return {
    speaker: speakerId && charMeta?.name ? charMeta.name : params.speaker,
    speakerColor: charMeta?.color || params.speakerColor,
  };
}

/**
 * Evaluate the same named ease strings that are handed to GSAP during
 * playback. Keeping this boundary on GSAP means seek/bake reconstruction do
 * not grow a second, subtly different easing implementation.
 */
export function evaluateGsapEase(ease: string | undefined, progress: number): number {
  return evaluateCharacterEase(ease, progress);
}

/** Semantic/UI values are seconds; the runtime Live2D contract is milliseconds. */
export function resolveBlinkIntervalMilliseconds(params: Record<string, any>): number {
  const seconds = typeof params.interval === 'number'
    ? params.interval
    : DEFAULT_BLINK_INTERVAL_SECONDS;
  return (Number.isFinite(seconds) ? Math.max(0, seconds) : DEFAULT_BLINK_INTERVAL_SECONDS)
    * MILLISECONDS_PER_SECOND;
}

export function resolveBlinkIntervalRangeMilliseconds(params: Record<string, any>): number {
  const seconds = typeof params.intervalRange === 'number'
    ? params.intervalRange
    : 0;
  return (Number.isFinite(seconds) ? Math.max(0, seconds) : 0)
    * MILLISECONDS_PER_SECOND;
}

function hasCharacterEntrance(params: Record<string, any>): boolean {
  return params.enter !== 'none' && (
    (params.enter && params.enter !== 'none') ||
    params.duration !== undefined ||
    params.enterDuration !== undefined
  );
}

function normalizeEnterPreset(value: unknown): string {
  return value === 'fade' ? 'fadeIn' : typeof value === 'string' && value ? value : 'fadeIn';
}

function normalizeExitPreset(value: unknown): string {
  return value === 'fade' ? 'fadeOut' : typeof value === 'string' && value ? value : 'fadeOut';
}

function materializeCharacterEntrance(
  params: Record<string, any>,
  startTime: number,
  time: number,
): { position: [number, number]; scale: number; opacity: number } {
  const finalPosition = normalizePosition(params.position, DEFAULT_CHARACTER_POSITION);
  const finalScale = typeof params.scale === 'number' ? params.scale : DEFAULT_CHARACTER_SCALE;
  const targetOpacity = typeof params.opacity === 'number' ? params.opacity : 1;
  if (!hasCharacterEntrance(params)) {
    return { position: finalPosition, scale: finalScale, opacity: targetOpacity };
  }

  const duration = normalizeDuration(
    params.duration ?? params.enterDuration,
    DEFAULT_ENTER_DURATION_SECONDS,
  );
  if (duration <= 0 || time >= startTime + duration) {
    return { position: finalPosition, scale: finalScale, opacity: targetOpacity };
  }

  const preset = normalizeEnterPreset(params.enter);
  const ease = preset === 'dropIn'
    ? 'bounce.out'
    : params.enterEase ?? DEFAULT_CHARACTER_ENTER_EASE;
  const eased = evaluateCharacterEase(ease, (time - startTime) / duration, DEFAULT_CHARACTER_ENTER_EASE);
  const position = [...finalPosition] as [number, number];
  let scale = finalScale;

  switch (preset) {
    case 'slideFromLeft':
      position[0] = finalPosition[0] - characterSlideEntranceOffsetNormalized() * (1 - eased);
      break;
    case 'slideFromRight':
      position[0] = finalPosition[0] + characterSlideEntranceOffsetNormalized() * (1 - eased);
      break;
    case 'slideFromBottom':
      position[1] = finalPosition[1] + DEFAULT_CHARACTER_MODEL_HEIGHT * 0.3 / STAGE_HEIGHT * (1 - eased);
      break;
    case 'dropIn':
      position[1] = finalPosition[1] - DEFAULT_CHARACTER_MODEL_HEIGHT * 0.5 / STAGE_HEIGHT * (1 - eased);
      break;
    case 'zoomIn':
      scale = interpolateNumber(finalScale * 0.3, finalScale, eased);
      break;
    case 'fadeIn':
    case 'none':
    default:
      break;
  }

  return {
    position,
    scale,
    opacity: interpolateNumber(0, targetOpacity, eased),
  };
}

/**
 * Compute runtime character, dialogue, and environment state at a given time.
 *
 * This helper consumes the scheduler-local runtime timeline shape. It is kept
 * out of the legacy SceneCompiler so prepared playback, bake, and seek do not
 * depend on source-scene compatibility helpers.
 */
export function computeSceneStateAtTime(
  script: RuntimeTimelineScene,
  time: number,
  lookAtPointLookup?: LookAtPointLookup,
): {
  characters: Map<string, any>;
  images: Map<string, RuntimeImageLayerState>;
  textLayers: Map<string, RuntimeTextLayerState>;
  background: any;
  environmentLayers: Map<string, EnvironmentLayerRenderState>;
  dialogue: any;
} {
  const characters = new Map<string, any>();
  const images = new Map<string, RuntimeImageLayerState>();
  const textLayers = new Map<string, RuntimeTextLayerState>();
  const lookAtStates = new Map<string, RuntimeLookAtState>();
  let dialogue: any = null;
  const { background, environmentLayers } = reconstructEnvironmentAtTime(script, time);

  const timeline = [...script.timeline].sort((left, right) => (left.time || 0) - (right.time || 0));
  for (const action of timeline) {
    if ((action.time || 0) > time) break;
    const p = action.params;
    switch (action.action) {
      case 'setEnvironmentLayer':
      case 'transformEnvironmentLayer':
      case 'removeEnvironmentLayer':
        break;
      case 'addCharacter': {
        const startTime = action.time || 0;
        const entrance = materializeCharacterEntrance(p, startTime, time);
        lookAtStates.delete(p.id);

        characters.set(p.id, {
          model: p.model,
          config: p,
          // A repeated addCharacter creates a new model lifetime for the same
          // id. Snapshot/handoff consumers use this boundary to reject poses
          // captured during an earlier incarnation.
          lifecycleStartTime: startTime,
          motion: null,
          expression: null,
          lookAt: null,
          blink: null,
          position: entrance.position,
          scale: entrance.scale,
          rotation: typeof p.rotation === 'number' ? p.rotation : DEFAULT_CHARACTER_ROTATION,
          opacity: entrance.opacity,
          z: p.z ?? 0,
        });
        break;
      }
      case 'transformCharacter': {
        const startTime = action.time || 0;
        const duration = normalizeDuration(p.duration, 1);
        const entry = characters.get(p.id);
        if (entry) {
          const progress = duration > 0
            ? clamp01((time - startTime) / duration)
            : 1;
          const eased = time >= startTime + duration
            ? 1
            : evaluateCharacterEase(p.ease, progress, DEFAULT_CHARACTER_TRANSFORM_EASE);
          const currentPosition = normalizePosition(entry.position, DEFAULT_CHARACTER_POSITION);
          if (p.position !== undefined) {
            entry.position = interpolatePosition(
              currentPosition,
              normalizePosition(p.position, currentPosition),
              eased,
            );
          }
          if (typeof p.scale === 'number') {
            entry.scale = interpolateNumber(entry.scale ?? DEFAULT_CHARACTER_SCALE, p.scale, eased);
          }
          if (typeof p.rotation === 'number') {
            entry.rotation = interpolateNumber(entry.rotation ?? DEFAULT_CHARACTER_ROTATION, p.rotation, eased);
          }
          if (typeof p.opacity === 'number') {
            entry.opacity = interpolateNumber(entry.opacity ?? 1, p.opacity, eased);
          }
          if (typeof p.z === 'number') {
            entry.z = interpolateNumber(entry.z ?? 0, p.z, eased);
          }
        }
        break;
      }
      case 'removeCharacter': {
        const startTime = action.time || 0;
        const duration = normalizeDuration(
          p.duration ?? p.exitDuration,
          DEFAULT_ENTER_DURATION_SECONDS,
        );
        const preset = normalizeExitPreset(p.exit);

        if (p.exit === 'none' || !p.exit) {
          characters.delete(p.id);
          break;
        }

        const effectiveDuration = preset === 'dissolve' ? duration * 1.5 : duration;
        if (time >= startTime + effectiveDuration) {
          characters.delete(p.id);
          break;
        }

        const entry = characters.get(p.id);
        if (entry && time >= startTime) {
          const progress = effectiveDuration > 0
            ? clamp01((time - startTime) / effectiveDuration)
            : 1;
          const ease = preset === 'flyUp'
            ? 'power3.in'
            : preset === 'dissolve'
              ? 'power1.out'
              : p.exitEase ?? DEFAULT_CHARACTER_EXIT_EASE;
          const eased = evaluateCharacterEase(ease, progress, DEFAULT_CHARACTER_EXIT_EASE);
          const startPosition = normalizePosition(entry.position, DEFAULT_CHARACTER_POSITION);
          const startScale = entry.scale ?? DEFAULT_CHARACTER_SCALE;
          entry.opacity = interpolateNumber(entry.opacity ?? 1, 0, eased);

          switch (preset) {
            case 'slideToLeft':
              entry.position = interpolatePosition(
                startPosition,
                [-characterSlideEntranceOffsetNormalized() * 2, startPosition[1]],
                eased,
              );
              break;
            case 'slideToRight':
              entry.position = interpolatePosition(
                startPosition,
                [1 + characterSlideEntranceOffsetNormalized() * 2, startPosition[1]],
                eased,
              );
              break;
            case 'slideToTop':
            case 'flyUp':
              entry.position = interpolatePosition(
                startPosition,
                [startPosition[0], -DEFAULT_CHARACTER_MODEL_HEIGHT / STAGE_HEIGHT],
                eased,
              );
              break;
            case 'dissolve':
              entry.scale = interpolateNumber(startScale, startScale * 1.1, eased);
              break;
            case 'zoomOut':
              entry.scale = interpolateNumber(startScale, 0, eased);
              break;
            case 'fadeOut':
            default:
              break;
          }
        }
        break;
      }
      case 'playMotion':
        if (characters.has(p.id)) {
          const motion = p.motion as CharacterMotionOutput | undefined;
          characters.get(p.id).motion = motion
            ? {
                output: motion,
                priority: p.priority ?? 3,
                time: action.time,
              }
            : null;
        }
        break;
      case 'setExpression':
        if (characters.has(p.id)) {
          characters.get(p.id).expression = {
            key: p.expression,
            time: action.time,
          };
        }
        break;
      case 'characterLookAt': {
        if (!characters.has(p.id)) break;
        const startTime = action.time || 0;
        const previous = lookAtStates.get(p.id);
        const fromFocus: [number, number] = previous
          ? evaluateLookAtState(previous, startTime, characters).focus
          : resolveLookAtFocusTuple({}, lookAtPointLookup, p.id);
        const toFocus = resolveLookAtFocusTuple(p, lookAtPointLookup, p.id);
        const duration = normalizeDuration(p.duration, DEFAULT_LOOK_AT_DURATION_SECONDS);
        lookAtStates.set(p.id, {
          params: p,
          startTime,
          duration,
          fromFocus,
          toFocus,
        });
        break;
      }
      case 'characterBlink':
        if (characters.has(p.id)) {
          const hasRange = typeof p.intervalRange === 'number' && Number.isFinite(p.intervalRange);
          characters.get(p.id).blink = {
            enabled: p.enabled !== false,
            intervalMs: resolveBlinkIntervalMilliseconds(p),
            ...(hasRange ? { intervalRangeMs: resolveBlinkIntervalRangeMilliseconds(p) } : {}),
            startTime: action.time,
          };
        }
        break;
      case 'addImage': {
        if (!p.id) break;
        const position = normalizePosition(p.position);
        images.set(p.id, {
          id: p.id,
          file: typeof p.file === 'string' ? p.file : '',
          position,
          scale: typeof p.scale === 'number' ? p.scale : 1,
          rotation: typeof p.rotation === 'number' ? p.rotation : 0,
          opacity: typeof p.opacity === 'number' ? p.opacity : 1,
          zIndex: typeof p.zIndex === 'number' ? p.zIndex : 10,
          z: typeof p.z === 'number' ? p.z : undefined,
          config: { ...p, position },
        });
        break;
      }
      case 'transformImage': {
        const entry = images.get(p.id);
        if (!entry) break;

        const startTime = action.time || 0;
        const duration = Math.max(0, typeof p.duration === 'number' ? p.duration : 0);
        const progress = duration > 0
          ? clamp01((time - startTime) / duration)
          : 1;
        if (time < startTime) break;

        const targetPosition = p.position !== undefined
          ? normalizePosition(p.position, entry.position)
          : entry.position;
        const targetScale = typeof p.scale === 'number' ? p.scale : entry.scale;
        const targetRotation = typeof p.rotation === 'number' ? p.rotation : entry.rotation;
        const targetOpacity = typeof p.opacity === 'number' ? p.opacity : entry.opacity;
        const targetZ = typeof p.z === 'number' ? p.z : entry.z;

        entry.position = interpolatePosition(entry.position, targetPosition, progress);
        entry.scale = interpolateNumber(entry.scale, targetScale, progress);
        entry.rotation = interpolateNumber(entry.rotation, targetRotation, progress);
        entry.opacity = interpolateNumber(entry.opacity, targetOpacity, progress);
        entry.z = targetZ;
        if (typeof p.zIndex === 'number') entry.zIndex = p.zIndex;
        Object.assign(entry.config, {
          position: entry.position,
          scale: entry.scale,
          rotation: entry.rotation,
          opacity: entry.opacity,
          z: entry.z,
          zIndex: entry.zIndex,
        });
        break;
      }
      case 'removeImage': {
        const entry = images.get(p.id);
        if (!entry) break;

        const startTime = action.time || 0;
        const duration = Math.max(0, typeof p.duration === 'number' ? p.duration : 0);
        if (duration <= 0 || time >= startTime + duration) {
          images.delete(p.id);
        } else if (time >= startTime) {
          const progress = clamp01((time - startTime) / duration);
          entry.opacity = interpolateNumber(entry.opacity, 0, progress);
          entry.removing = true;
        }
        break;
      }
      case 'addTextLayer': {
        if (!p.id) break;
        const startTime = action.time || 0;
        const duration = Math.max(0, typeof p.duration === 'number' ? p.duration : 0.5);
        const style = p.style ?? 'fadeIn';
        const targetOpacity = typeof p.opacity === 'number' ? p.opacity : 1;
        const position = normalizePosition(p.position);
        const entranceProgress = duration > 0
          ? clamp01((time - startTime) / duration)
          : 1;
        const hasFadeEntrance = style === 'fadeIn' || style === 'cinematic';
        const opacity = hasFadeEntrance
          ? targetOpacity * entranceProgress
          : targetOpacity;
        const renderedPosition: [number, number] = style === 'cinematic'
          ? [position[0], position[1] + (30 / STAGE_HEIGHT) * (1 - entranceProgress)]
          : position;

        textLayers.set(p.id, {
          id: p.id,
          text: typeof p.text === 'string' ? p.text : '',
          position: renderedPosition,
          scale: typeof p.scale === 'number' ? p.scale : 1,
          rotation: typeof p.rotation === 'number' ? p.rotation : 0,
          opacity,
          config: { ...p, position },
          typewriterProgress: style === 'typewriter' ? entranceProgress : undefined,
        });
        break;
      }
      case 'transformTextLayer': {
        const entry = textLayers.get(p.id);
        if (!entry) break;

        const startTime = action.time || 0;
        const duration = Math.max(0, typeof p.duration === 'number' ? p.duration : 0);
        if (time < startTime) break;
        const progress = duration > 0
          ? clamp01((time - startTime) / duration)
          : 1;
        const targetPosition = p.position !== undefined
          ? normalizePosition(p.position, entry.position)
          : entry.position;
        const targetScale = typeof p.scale === 'number' ? p.scale : entry.scale;
        const targetRotation = typeof p.rotation === 'number' ? p.rotation : entry.rotation;
        const targetOpacity = typeof p.opacity === 'number' ? p.opacity : entry.opacity;

        entry.position = interpolatePosition(entry.position, targetPosition, progress);
        entry.scale = interpolateNumber(entry.scale, targetScale, progress);
        entry.rotation = interpolateNumber(entry.rotation, targetRotation, progress);
        entry.opacity = interpolateNumber(entry.opacity, targetOpacity, progress);
        Object.assign(entry.config, {
          position: entry.position,
          scale: entry.scale,
          rotation: entry.rotation,
          opacity: entry.opacity,
        });
        break;
      }
      case 'removeTextLayer': {
        const entry = textLayers.get(p.id);
        if (!entry) break;

        const startTime = action.time || 0;
        const duration = Math.max(0, typeof p.duration === 'number' ? p.duration : 0.5);
        if (duration <= 0 || time >= startTime + duration) {
          textLayers.delete(p.id);
        } else if (time >= startTime) {
          const progress = clamp01((time - startTime) / duration);
          entry.opacity = interpolateNumber(entry.opacity, 0, progress);
          entry.removing = true;
        }
        break;
      }
      case 'dialogue': {
        const startTime = action.time || 0;
        const duration = p.duration ?? 3;
        if (time >= startTime) {
          const { speaker, speakerColor } = resolveDialogueSpeaker(p, script);
          dialogue = {
            ...p,
            speaker,
            speakerColor,
            startTime,
            duration,
            _id: (action as any)._id,
          };
        }
        break;
      }
    }
  }

  // Finalize lookAt after the full timeline state is known so target-follow
  // gaze resolves against the character positions at the requested time rather
  // than the positions captured when the lookAt action was first processed.
  for (const [id, state] of lookAtStates) {
    if (characters.has(id)) {
      characters.get(id).lookAt = evaluateLookAtState(state, time, characters);
    }
  }

  return { characters, images, textLayers, background, environmentLayers, dialogue };
}

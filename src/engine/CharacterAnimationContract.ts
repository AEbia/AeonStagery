import gsap from 'gsap';

import { STAGE_WIDTH as CHARACTER_STAGE_WIDTH } from './StageDimensions';
export { STAGE_WIDTH as CHARACTER_STAGE_WIDTH, STAGE_HEIGHT as CHARACTER_STAGE_HEIGHT } from './StageDimensions';
export const DEFAULT_CHARACTER_MODEL_WIDTH = 600;
export const DEFAULT_CHARACTER_MODEL_HEIGHT = 1000;
export const DEFAULT_CHARACTER_ENTER_EASE = 'power2.out';
export const DEFAULT_CHARACTER_TRANSFORM_EASE = 'power2.inOut';
export const DEFAULT_CHARACTER_EXIT_EASE = 'power2.in';

/** The character remains in its current lifetime until its exit finishes. */
export function resolveCharacterExitDuration(params: {
  exit?: unknown;
  duration?: unknown;
  exitDuration?: unknown;
}): number {
  if (!params.exit || params.exit === 'none') return 0;
  const value = params.duration ?? params.exitDuration;
  const duration = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0.6;
  return params.exit === 'dissolve' ? duration * 1.5 : duration;
}

const SEMANTIC_EASE_ALIASES: Readonly<Record<string, string>> = {
  smooth: 'power2.inOut',
  linear: 'none',
  accelerate: 'power3.in',
  decelerate: 'power3.out',
  overshoot: 'back.out(1.5)',
  bounce: 'bounce.out',
  anticipate: 'back.inOut(1.5)',
  hesitate: 'power4.inOut',
  easein: 'power3.in',
  easeout: 'power3.out',
  easeinout: 'power2.inOut',
};

const GSAP_FALLBACK_EASE = 'power1.out';

function resolveEaseAlias(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return SEMANTIC_EASE_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function isGsapEase(value: string): boolean {
  try {
    return typeof gsap.parseEase(value) === 'function';
  } catch {
    return false;
  }
}

/**
 * Resolve author-facing semantic aliases and make invalid saved values use the
 * same fallback that playback receives. GSAP silently falls back to its
 * default ease for unknown strings, so reconstruction must never turn an
 * invalid ease into a different linear curve.
 */
export function normalizeCharacterEase(value: unknown, fallback: string): string {
  const candidate = resolveEaseAlias(value);
  if (candidate && isGsapEase(candidate)) return candidate;

  const fallbackEase = resolveEaseAlias(fallback);
  if (fallbackEase && isGsapEase(fallbackEase)) return fallbackEase;

  return GSAP_FALLBACK_EASE;
}

export function evaluateCharacterEase(
  value: unknown,
  progress: number,
  fallback: string = GSAP_FALLBACK_EASE,
): number {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const ease = normalizeCharacterEase(value, fallback);
  const evaluator = gsap.parseEase(ease);
  const evaluated = evaluator(clampedProgress);
  return Number.isFinite(evaluated) ? evaluated : clampedProgress;
}

export function resolveCharacterModelWidth(model: unknown): number {
  const width = model && typeof model === 'object'
    ? Number((model as { width?: unknown }).width)
    : Number.NaN;
  return Number.isFinite(width) && width > 0 ? width : DEFAULT_CHARACTER_MODEL_WIDTH;
}

export function resolveCharacterModelHeight(model: unknown): number {
  const height = model && typeof model === 'object'
    ? Number((model as { height?: unknown }).height)
    : Number.NaN;
  return Number.isFinite(height) && height > 0 ? height : DEFAULT_CHARACTER_MODEL_HEIGHT;
}

export function characterSlideEntranceOffsetPixels(model?: unknown): number {
  return resolveCharacterModelWidth(model) * 0.5;
}

export function characterSlideEntranceOffsetNormalized(model?: unknown): number {
  return characterSlideEntranceOffsetPixels(model) / CHARACTER_STAGE_WIDTH;
}

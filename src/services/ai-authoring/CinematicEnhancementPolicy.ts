import type { StatementFamily } from '../../api/types/semantic-scene';
import type { SemanticSceneOperationNameV1 } from '../../api/types/semantic-scene-patch';
import type { SemanticSceneStagePolicyV1 } from '../semantic-scene/SemanticScenePatch';

/** Policy version string for checkpoint invalidation. */
export const PERFORMANCE_STAGE_POLICY_VERSION = 'performance-stage-policy/v2' as const;
export const CINEMATIC_STAGE_POLICY_VERSION = 'cinematic-stage-policy/v2' as const;

/**
 * Performance stage: insert/update characterPerformance root & companion,
 * insert/update characterTransform root only. No delete/move/reorder/family replacement.
 */
export const PERFORMANCE_ALLOWED_OPERATIONS = [
  'insertStatement',
  'insertCompanion',
  'updateStatement',
  'updateCompanion',
] as const satisfies readonly SemanticSceneOperationNameV1[];

export const PERFORMANCE_ALLOWED_FAMILIES = [
  'characterPerformance',
  'characterTransform',
] as const satisfies readonly StatementFamily[];

/**
 * Writable leaf paths for performance updates (params.* and nested fillable leaves).
 * Identity fields target/id are excluded so stage policy rejects identity mutation.
 */
export const PERFORMANCE_ALLOWED_PATHS = [
  'params',
  'params.motion',
  'params.expression',
  'params.lookAt',
  'params.lookAt.target',
  'params.lookAt.point',
  'params.lookAt.enabled',
  'params.lookAt.intensity',
  'params.blink',
  'params.blink.enabled',
  'params.blink.interval',
  'params.blink.intervalRange',
  'params.durationSeconds',
  'params.position',
  'params.scale',
  'params.rotation',
  'params.opacity',
  'params.z',
  'params.ease',
  'anchor',
  'offset',
] as const;

export const PERFORMANCE_FORBIDDEN_PATHS = [
  'type',
  'params.target',
  'params.id',
  'time',
  'id',
] as const;

export const PERFORMANCE_STAGE_POLICY_V1: SemanticSceneStagePolicyV1 = Object.freeze({
  allowedOperations: PERFORMANCE_ALLOWED_OPERATIONS,
  allowedFamilies: PERFORMANCE_ALLOWED_FAMILIES,
  allowedPaths: PERFORMANCE_ALLOWED_PATHS,
  forbiddenPaths: PERFORMANCE_FORBIDDEN_PATHS,
});

/**
 * Cinematic stage: camera / lighting / visualStyle roots with
 * insert/update/delete/move. Dialogue companions limited to camera + visualStyle.
 * No family replacement or reorderCompanions (would disturb acting/audio companions).
 * Deprecated filter families (filterAdd/filterChange/filterReset) are excluded.
 */
export const CINEMATIC_ALLOWED_OPERATIONS = [
  'insertStatement',
  'insertCompanion',
  'updateStatement',
  'updateCompanion',
  'deleteLine',
  'moveLine',
] as const satisfies readonly SemanticSceneOperationNameV1[];

export const CINEMATIC_ALLOWED_FAMILIES = [
  'camera',
  'lighting',
  'visualStyle',
] as const satisfies readonly StatementFamily[];

/** Families that may appear as dialogue companions under cinematic policy. */
export const CINEMATIC_COMPANION_FAMILIES = [
  'camera',
  'visualStyle',
] as const satisfies readonly StatementFamily[];

/** Root-only cinematic families (not attachable as dialogue companions). */
export const CINEMATIC_ROOT_ONLY_FAMILIES = [
  'lighting',
] as const satisfies readonly StatementFamily[];

export const CINEMATIC_FORBIDDEN_PATHS = [
  'type',
] as const;

export const CINEMATIC_STAGE_POLICY_V1: SemanticSceneStagePolicyV1 = Object.freeze({
  allowedOperations: CINEMATIC_ALLOWED_OPERATIONS,
  allowedFamilies: CINEMATIC_ALLOWED_FAMILIES,
  allowedCompanionFamilies: CINEMATIC_COMPANION_FAMILIES,
  forbiddenPaths: CINEMATIC_FORBIDDEN_PATHS,
});

export type EnhancementStageKind = 'performance' | 'cinematic';

export function getEnhancementStagePolicy(
  stage: EnhancementStageKind,
): SemanticSceneStagePolicyV1 {
  return stage === 'performance' ? PERFORMANCE_STAGE_POLICY_V1 : CINEMATIC_STAGE_POLICY_V1;
}

export function getEnhancementStagePolicyVersion(stage: EnhancementStageKind): string {
  return stage === 'performance'
    ? PERFORMANCE_STAGE_POLICY_VERSION
    : CINEMATIC_STAGE_POLICY_VERSION;
}

/** True when a cinematic family may be inserted/updated as a dialogue companion. */
export function isCinematicCompanionFamily(family: StatementFamily): boolean {
  return (CINEMATIC_COMPANION_FAMILIES as readonly string[]).includes(family);
}

/** True when performance stage may insert family as a root statement. */
export function isPerformanceRootFamily(family: StatementFamily): boolean {
  return family === 'characterPerformance' || family === 'characterTransform';
}

/** characterTransform is never a dialogue companion under performance policy. */
export function isPerformanceCompanionFamily(family: StatementFamily): boolean {
  return family === 'characterPerformance';
}

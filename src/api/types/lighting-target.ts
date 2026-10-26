/** Source references are structured: every legacy string remains an ID or legacy scope. */
export type LightingObjectTarget = { kind: 'character' | 'environmentLayer'; id: string };
export type LightingTargetReference = LightingObjectTarget
  | { kind: 'group'; group: 'characters' | 'environmentLayers' }
  | { kind: 'scene' };
export type LightingTarget = string | LightingTargetReference;
export type LightingEffect = 'blur' | 'post';

/** Compiled runtime keys only; these are never parsed as source reference syntax. */
export const LIGHTING_GROUP_TARGETS = {
  characters: 'group:characters',
  environmentLayers: 'group:environmentLayers',
} as const;

export function isLightingGroupTarget(target: string): boolean {
  return target === LIGHTING_GROUP_TARGETS.characters || target === LIGHTING_GROUP_TARGETS.environmentLayers;
}

export function parseCompiledLightingObjectTarget(target: string): LightingObjectTarget | undefined {
  for (const kind of ['character', 'environmentLayer'] as const) {
    const prefix = `${kind}:`;
    if (target.startsWith(prefix)) return { kind, id: target.slice(prefix.length) };
  }
  return undefined;
}

export function resolveLightingTarget(
  target: LightingTarget | undefined,
  effect: LightingEffect,
  characterIds: ReadonlySet<string>,
): LightingTargetReference {
  if (target !== undefined && typeof target !== 'string') return target;
  const value = target;
  if (!value || value === (effect === 'blur' ? 'global' : 'panorama')) {
    return { kind: 'scene' };
  }
  if (effect === 'blur' && (value === 'characters' || value === 'background')) {
    return { kind: 'group', group: value === 'characters' ? 'characters' : 'environmentLayers' };
  }
  return { kind: characterIds.has(value) ? 'character' : 'environmentLayer', id: value };
}

export function lightingTargetKey(
  target: LightingTarget | undefined,
  effect: LightingEffect,
  characterIds: ReadonlySet<string>,
): string {
  const resolved = resolveLightingTarget(target, effect, characterIds);
  if (resolved.kind === 'scene') return effect === 'blur' ? 'global' : 'panorama';
  if (resolved.kind === 'group') {
    return effect === 'blur'
      ? resolved.group === 'characters' ? 'characters' : 'background'
      : LIGHTING_GROUP_TARGETS[resolved.group];
  }
  return `${resolved.kind}:${resolved.id}`;
}

export function isLightingTarget(value: unknown): value is LightingTarget {
  if (typeof value === 'string') return true;
  if (value === null || typeof value !== 'object') return false;
  if (!('kind' in value)) return false;
  if (value.kind === 'scene') return true;
  if (value.kind === 'group') return 'group' in value && (value.group === 'characters' || value.group === 'environmentLayers');
  return (value.kind === 'character' || value.kind === 'environmentLayer') && 'id' in value && typeof value.id === 'string';
}

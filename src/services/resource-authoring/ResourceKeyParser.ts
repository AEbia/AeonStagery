import type { ResourceKey, ResourceKind } from './ResourceAuthoringTypes';

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseResourceKey(input: string, kind: ResourceKind): ResourceKey {
  const value = input.trim();
  if (!value) throw new Error('Resource short name cannot be empty');
  if (value.includes('/') || value.includes('\\')) {
    throw new Error('Resource short name cannot contain path separators');
  }

  const at = value.indexOf('@');
  if (at !== value.lastIndexOf('@')) throw new Error('Resource short name contains multiple namespace separators');
  const namespace = at >= 0 ? value.slice(0, at) : undefined;
  const local = at >= 0 ? value.slice(at + 1) : value;
  const colon = local.indexOf(':');
  if (colon !== local.lastIndexOf(':')) throw new Error('Resource short name contains multiple owner separators');
  const ownerId = colon >= 0 ? local.slice(0, colon) : undefined;
  const name = colon >= 0 ? local.slice(colon + 1) : local;

  for (const [label, segment] of [['namespace', namespace], ['owner', ownerId], ['name', name]] as const) {
    if (segment !== undefined && !SEGMENT.test(segment)) {
      throw new Error(`Invalid resource ${label}: "${segment}"`);
    }
  }
  return { kind, name, ...(namespace ? { namespace } : {}), ...(ownerId ? { ownerId } : {}) };
}

export function isExplicitResourcePath(input: string): boolean {
  const value = input.trim();
  return value.includes('/') || value.includes('\\') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('mount://');
}

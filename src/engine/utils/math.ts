import type { Vec2 } from '../../api/types/common';

/** Resolve Vec2 to {x, y} format */
export function resolveVec2(v: Vec2 | undefined): { x: number; y: number } {
  if (!v) return { x: 0.5, y: 0.5 }; // Default to center
  if (Array.isArray(v)) return { x: v[0] ?? 0.5, y: v[1] ?? 0.5 };
  return { x: v.x ?? 0.5, y: v.y ?? 0.5 };
}

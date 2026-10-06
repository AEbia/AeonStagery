interface FilterStackEntry {
  skip: boolean;
  inputTexture: { source: unknown } | null;
}

interface FilterResolutionSystem {
  _filterStackIndex: number;
  _filterStack: FilterStackEntry[];
  _findFilterResolution(rootResolution: number): number;
}

const guardedSystems = new WeakSet<object>();

/**
 * Pixi 8.21 retains pooled input textures in reusable filter-stack entries.
 * A renderer resize can destroy those textures before the next push replaces
 * them, leaving _findFilterResolution reading a null source. Keep this private
 * API workaround here; live textures still use Pixi's original lookup.
 */
export function installPixiFilterResolutionGuard(renderer: { filter?: unknown }): void {
  const system = renderer.filter as FilterResolutionSystem | undefined;
  if (!system || typeof system._findFilterResolution !== 'function' || guardedSystems.has(system)) return;
  const original = system._findFilterResolution;
  system._findFilterResolution = function (rootResolution: number): number {
    let index = this._filterStackIndex - 1;
    while (index > 0 && this._filterStack[index].skip) index--;
    const input = index > 0 ? this._filterStack[index].inputTexture : null;
    if (input && !input.source) return rootResolution;
    return original.call(this, rootResolution);
  };
  guardedSystems.add(system);
}

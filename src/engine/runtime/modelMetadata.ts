export function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Resolve the authored head hit-area anchor from model.json layout data.
 * Identical math for both runtime adapters (cubism2 and official web), so it
 * lives once here instead of being duplicated in each controls
 * implementation. Returns null when the model exposes no usable head
 * hit-area/layout.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
export function resolveHeadAnchorFromSettings(settings: any): { x: number; y: number } | null {
  const hitAreas = settings?.hit_areas_custom;
  const headX = hitAreas?.head_x;
  const headY = hitAreas?.head_y;
  if (!Array.isArray(headX) || headX.length < 2 || !Array.isArray(headY) || headY.length < 2) {
    return null;
  }

  const left = Number(headX[0]);
  const right = Number(headX[1]);
  const top = Number(headY[0]);
  const bottom = Number(headY[1]);
  if (![left, right, top, bottom].every(Number.isFinite)) return null;

  const layout = settings?.layout || {};
  const layoutCenterX = Number(layout.center_x ?? 0);
  const layoutCenterY = Number(layout.center_y ?? 0);
  const layoutWidth = Number(layout.width ?? 0);
  const scale = layoutWidth > 0 ? layoutWidth : 0;
  if (!(scale > 0)) return null;

  return {
    x: 0.5 + (((left + right) * 0.5) - layoutCenterX) / scale,
    y: 0.5 - (((top + bottom) * 0.5) - layoutCenterY) / scale,
  };
}

function normalizeParameterId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof (value as { id?: unknown }).id === 'string') {
    const id = (value as { id: string }).id;
    if (id.trim()) return id;
  }
  if (value && typeof (value as { getString?: unknown }).getString === 'function') {
    const resolved = (value as { getString: () => unknown }).getString();
    if (typeof resolved === 'string' && resolved.trim()) return resolved;
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
export function getCubism2ModelContext(coreModel: any): any | null {
  try {
    return coreModel?.getModelContext?.() ?? coreModel?._$5S ?? null;
  } catch {
    return coreModel?._$5S ?? null;
  }
}

/**
 * Cubism 2 model.json does not carry a parameter table. pixi-live2d-display
 * therefore exposes the authoritative IDs through the core model (or its
 * private parameter-id array), while tests and older wrappers may only expose
 * settings.parameters. Keep all supported shapes at this adapter boundary so
 * handoff snapshots use the same IDs as authored custom-motion tracks.
 */
export function resolveCubism2ParameterId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  coreModel: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  settings: any,
  index: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
  modelContext: any = getCubism2ModelContext(coreModel),
): string {
  const direct = [
    () => coreModel?.getParamId?.(index),
    () => coreModel?.getParamID?.(index),
    () => coreModel?.getParameterId?.(index),
    () => coreModel?.getParamIds?.()?.[index],
    () => coreModel?.getParameterIds?.()?.[index],
    () => modelContext?._$pb?.[index],
  ];
  for (const read of direct) {
    try {
      const id = normalizeParameterId(read());
      if (id) return id;
    } catch {
      // Try the next runtime representation.
    }
  }

  const setting = settings?.parameters?.[index];
  return normalizeParameterId(setting?.name)
    ?? normalizeParameterId(setting?.id)
    ?? normalizeParameterId(setting?.parameterId)
    ?? `Param_${index}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism SDK internals are versioned dynamic objects; keeping this boundary opaque preserves Cubism 2/3 fallback compatibility.
export function resolveCubismParameterId(value: any): string | undefined {
  return normalizeParameterId(value) ?? value?.getString?.()?.s;
}

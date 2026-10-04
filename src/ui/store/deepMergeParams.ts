function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deleteParamPath(target: Record<string, any>, path: string): Record<string, any> {
  const segments = path.split('.').filter(Boolean);
  if (segments.length === 0) return target;

  const [head, ...rest] = segments;
  if (!(head in target)) return target;

  if (rest.length === 0) {
    const clone = { ...target };
    delete clone[head];
    return clone;
  }

  const next = target[head];
  if (!isPlainObject(next)) return target;

  const updatedNext = deleteParamPath(next, rest.join('.'));
  if (updatedNext === next) return target;

  return {
    ...target,
    [head]: updatedNext,
  };
}

export function deepMergeParams(
  existing: Record<string, any> | null | undefined,
  patch: Record<string, any> | null | undefined,
  paramsDelete?: string[],
): Record<string, any> {
  if (patch === null || patch === undefined) {
    return {};
  }

  const safeExisting = existing ?? {};

  let result: Record<string, any> = {};

  // Start with all keys from existing
  for (const key of Object.keys(safeExisting)) {
    if (key in patch) {
      const oldVal = safeExisting[key];
      const newVal = patch[key];
      if (isPlainObject(oldVal) && isPlainObject(newVal)) {
        result[key] = deepMergeParams(oldVal, newVal);
      } else {
        result[key] = newVal;
      }
    } else {
      result[key] = safeExisting[key];
    }
  }

  // Add keys only in patch
  for (const key of Object.keys(patch)) {
    if (!(key in safeExisting)) {
      result[key] = patch[key];
    }
  }

  // Apply deletions last
  if (paramsDelete) {
    for (const key of paramsDelete) {
      result = deleteParamPath(result, key);
    }
  }

  return result;
}

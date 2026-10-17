const deeplyFrozen = new WeakSet<object>();

/** Memoization is safe only when descendants are frozen too, not just the root. */
export function isDeeplyFrozen(value: object): boolean {
  if (deeplyFrozen.has(value)) return true;
  const pending: object[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop()!;
    if (deeplyFrozen.has(current) || seen.has(current)) continue;
    if (!Object.isFrozen(current)) return false;
    seen.add(current);
    for (const child of Object.values(current)) {
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  for (const current of seen) deeplyFrozen.add(current);
  return true;
}

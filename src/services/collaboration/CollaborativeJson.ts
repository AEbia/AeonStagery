function normalizeJsonForComparison(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonForComparison);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, normalizeJsonForComparison(record[key])]),
    );
  }
  return value;
}

export function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeJsonForComparison(left ?? null))
    === JSON.stringify(normalizeJsonForComparison(right ?? null));
}

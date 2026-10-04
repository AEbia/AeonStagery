/**
 * Timeline scrubber length from real statement extents only.
 * Must not include State Span derived ends (next-state / scene-end projections).
 */
export function deriveTimelineMaxTimeSeconds(
  statementExtentEndSeconds: number,
  options: { readonly minimumSeconds?: number; readonly paddingSeconds?: number } = {},
): number {
  const minimumSeconds = options.minimumSeconds ?? 30;
  const paddingSeconds = options.paddingSeconds ?? 5;
  const safeEnd = Number.isFinite(statementExtentEndSeconds)
    ? Math.max(0, statementExtentEndSeconds)
    : 0;
  return Math.max(minimumSeconds, safeEnd) + paddingSeconds;
}

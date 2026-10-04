import type { SceneStatement } from '../../api/types/semantic-scene';
import { sceneStatementDefinitionRegistry } from './SceneStatementDefinitionRegistry';

export function migrateSceneV3ToV4(input: unknown): { document: unknown; warnings: readonly string[] } {
  if (!isRecord(input)) {
    throw new Error('migrateSceneV3ToV4 expects an object input');
  }
  if (input.schemaVersion !== 3) {
    throw new Error(`migrateSceneV3ToV4 expects schemaVersion 3, received ${describeValue(input.schemaVersion)}`);
  }
  if (!Array.isArray(input.statements)) {
    throw new Error('migrateSceneV3ToV4 expects a statements array on schemaVersion 3 scene documents');
  }

  const document = cloneJson(input) as Record<string, unknown>;
  const warnings: string[] = [];

  // Ordering invariant: the v3 scene end must be computed from the ORIGINAL
  // params before the clip removal and characterPerformance rewrites below,
  // so removed live2dParameterClip durations still contribute. The fold into
  // meta.durationSeconds happens only after all rewrites and only grows the
  // value, never shrinking it.
  const v3SceneEnd = computeV3SceneEnd(document);

  document.schemaVersion = 4;

  const rootStatements = document.statements as unknown[];
  const statements: unknown[] = [];
  for (let statementIndex = 0; statementIndex < rootStatements.length; statementIndex++) {
    const statement = rootStatements[statementIndex];
    if (!isRecord(statement)) {
      statements.push(statement);
      continue;
    }
    if (statement.type === 'live2dParameterClip') {
      warnings.push(`Removed live2dParameterClip statement "${statement.id}" at ${statement.time}s: no v4 equivalent`);
      continue;
    }
    if (Array.isArray(statement.companions)) {
      const rootCompanions = statement.companions as unknown[];
      const companions: unknown[] = [];
      for (let companionIndex = 0; companionIndex < rootCompanions.length; companionIndex++) {
        const companion = rootCompanions[companionIndex];
        if (!isRecord(companion)) {
          companions.push(companion);
          continue;
        }
        if (companion.type === 'live2dParameterClip') {
          warnings.push(`Removed live2dParameterClip companion "${companion.id}" under statement "${statement.id}": no v4 equivalent`);
          continue;
        }
        if (companion.type === 'characterPerformance') {
          companion.params = rewriteCharacterPerformanceParams(
            companion.params,
            `scene.statements[${statementIndex}].companions[${companionIndex}].params`,
            companion.id,
            warnings,
          );
        }
        companions.push(companion);
      }
      statement.companions = companions;
    }
    if (statement.type === 'characterPerformance') {
      statement.params = rewriteCharacterPerformanceParams(
        statement.params,
        `scene.statements[${statementIndex}].params`,
        statement.id,
        warnings,
      );
    }
    statements.push(statement);
  }
  document.statements = statements;

  const meta = document.meta;
  if (v3SceneEnd > 0 && isRecord(meta)) {
    const durationSeconds = meta.durationSeconds;
    const belowSceneEnd = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds < v3SceneEnd;
    if (durationSeconds === undefined || belowSceneEnd) {
      meta.durationSeconds = v3SceneEnd;
    }
  }

  return { document, warnings };
}

function computeV3SceneEnd(document: Record<string, unknown>): number {
  let sceneEnd = 0;
  if (isRecord(document.meta) && finiteNonNegativeNumber(document.meta.durationSeconds) !== undefined) {
    sceneEnd = Math.max(sceneEnd, document.meta.durationSeconds as number);
  }
  if (!Array.isArray(document.statements)) return sceneEnd;

  for (const statement of document.statements) {
    if (!isRecord(statement)) continue;
    const parentTime = finiteNonNegativeNumber(statement.time);
    const parentExtent = v3StatementExtent(statement);
    if (parentTime !== undefined) {
      sceneEnd = Math.max(sceneEnd, parentTime + parentExtent);
    }
    if (!Array.isArray(statement.companions)) continue;
    for (const companion of statement.companions) {
      if (!isRecord(companion)) continue;
      if (parentTime === undefined) continue;
      const offset = finiteNumber(companion.offset);
      if (offset === undefined) continue;
      const anchor = companion.anchor === 'end' ? parentExtent : 0;
      sceneEnd = Math.max(sceneEnd, parentTime + anchor + offset + v3StatementExtent(companion));
    }
  }
  return sceneEnd;
}

function v3StatementExtent(entity: Record<string, unknown>): number {
  if (entity.type === 'characterPerformance') {
    if (!isRecord(entity.params)) return 0;
    const durationSeconds = finiteNonNegativeNumber(entity.params.durationSeconds) ?? 0;
    if (!isRecord(entity.params.motion) || entity.params.motion.kind !== 'custom') return durationSeconds;
    const motionDurationSeconds = finiteNonNegativeNumber(entity.params.motion.durationSeconds) ?? 0;
    return Math.max(durationSeconds, motionDurationSeconds);
  }
  if (entity.type === 'live2dParameterClip') {
    return v3Live2DParameterClipExtent(entity.params);
  }
  const type = entity.type;
  if (typeof type !== 'string' || !sceneStatementDefinitionRegistry.has(type) || !isRecord(entity.params)) {
    return 0;
  }
  try {
    const extent = sceneStatementDefinitionRegistry.temporalExtent({
      id: typeof entity.id === 'string' ? entity.id : '',
      time: 0,
      type,
      params: entity.params,
    } as unknown as SceneStatement);
    return typeof extent === 'number' && Number.isFinite(extent) ? Math.max(0, extent) : 0;
  } catch {
    return 0;
  }
}

function v3Live2DParameterClipExtent(input: unknown): number {
  if (!isRecord(input)) return 0;
  const durationSeconds = finiteNonNegativeNumber(input.durationSeconds);
  if (durationSeconds !== undefined) return durationSeconds;
  if (!isRecord(input.source) || !isRecord(input.source.animation) || !Array.isArray(input.source.animation.tracks)) {
    return 0;
  }
  let extent = 0;
  for (const track of input.source.animation.tracks) {
    if (!isRecord(track) || !Array.isArray(track.keyframes)) continue;
    for (const keyframe of track.keyframes) {
      const time = isRecord(keyframe) ? finiteNonNegativeNumber(keyframe.time) : undefined;
      if (time !== undefined) extent = Math.max(extent, time);
    }
  }
  return extent;
}

function rewriteCharacterPerformanceParams(
  input: unknown,
  path: string,
  id: unknown,
  warnings: string[],
): unknown {
  if (!isRecord(input)) return input;
  const params = { ...input };

  if (params.motion !== undefined) {
    params.motion = normalizeMotion(params.motion, `${path}.motion`);
  }
  if (params.durationSeconds !== undefined) {
    expectNonNegativeNumber(params.durationSeconds, `${path}.durationSeconds`);
    delete params.durationSeconds;
  }
  if (params.loop !== undefined) {
    if (params.loop !== false) {
      warnings.push(`Dropped characterPerformance loop=${params.loop} on "${id}": v4 motions run once`);
    }
    delete params.loop;
  }
  if (params.priority !== undefined) {
    if (params.priority !== 3) {
      warnings.push(`Dropped characterPerformance priority=${params.priority} on "${id}": v4 uses deterministic timeline takeover`);
    }
    delete params.priority;
  }
  return params;
}

function normalizeMotion(motion: unknown, path: string): unknown {
  if (typeof motion === 'string') {
    return { kind: 'resource', key: expectNonEmptyString(motion, path) };
  }
  if (isRecord(motion)) {
    if (motion.kind === undefined) {
      expectKeys(motion, path, ['key', 'fadeInSeconds']);
      const normalized: Record<string, unknown> = {
        kind: 'resource',
        key: expectNonEmptyString(motion.key, `${path}.key`),
      };
      if (motion.fadeInSeconds !== undefined) {
        normalized.fadeInSeconds = expectNonNegativeNumber(motion.fadeInSeconds, `${path}.fadeInSeconds`);
      }
      return normalized;
    }
    if (motion.kind === 'resource') {
      return motion;
    }
    if (motion.kind === 'custom') {
      // The v3-era codec tolerated missing segments on non-last keyframes
      // (dropped them) and stripped a segment on the last keyframe; the
      // strict v4 codec rejects both. The migration is the legacy
      // normalization point, so v3 custom motions are completed to the v4
      // canonical shape before strict validation runs (ADR-0029).
      return normalizeCustomMotionKeyframes(motion);
    }
  }
  throw new Error(`Unsupported characterPerformance motion shape at ${path}`);
}

/**
 * Complete v3-era custom motion keyframes to the v4 canonical segment shape:
 * every non-last keyframe carries an explicit segment (linear when missing),
 * and the last keyframe never carries one. Tracks or keyframes that are not
 * plain records pass through untouched and are left to the strict codec.
 * The interior completion is shared with the legacy-v4 repair entry
 * (`repairLegacyV4CustomMotionSegments`) so both stay on one implementation.
 */
function normalizeCustomMotionKeyframes(motion: Record<string, unknown>): Record<string, unknown> {
  const completed = completeImplicitCustomMotionSegments(motion);
  if (!Array.isArray(completed.motion.tracks)) return completed.motion;
  let stripped = false;
  const tracks = (completed.motion.tracks as unknown[]).map((track) => {
    if (!isRecord(track) || !Array.isArray(track.keyframes)) return track;
    const rawKeyframes = track.keyframes as unknown[];
    const last = rawKeyframes[rawKeyframes.length - 1];
    if (!isRecord(last) || last.segment === undefined) return track;
    stripped = true;
    const keyframes = rawKeyframes.map((keyframe, keyframeIndex) => {
      if (!isRecord(keyframe) || keyframeIndex !== rawKeyframes.length - 1) return keyframe;
      const normalized = { ...keyframe };
      delete normalized.segment;
      return normalized;
    });
    return { ...track, keyframes };
  });
  return stripped ? { ...completed.motion, tracks } : completed.motion;
}

/**
 * Repair the one legacy v4 custom-motion shape produced by editors that
 * predate `CustomMotionContract`: non-last keyframes without an explicit
 * segment (implicit linear, ADR-0029). The strict codec rejects that shape,
 * so documents saved by those editors would no longer load; this is the v4
 * counterpart of the v3 migration normalization and runs at the codec
 * boundary, emitting one warning per repaired motion. Every other
 * non-canonical shape is still rejected.
 */
export function repairLegacyV4CustomMotionSegments(input: unknown): { document: unknown; warnings: readonly string[] } {
  if (!isRecord(input)) {
    throw new Error('repairLegacyV4CustomMotionSegments expects an object input');
  }
  const document = cloneJson(input) as Record<string, unknown>;
  const warnings: string[] = [];
  if (!Array.isArray(document.statements)) return { document, warnings };

  document.statements = (document.statements as unknown[]).map((statement, statementIndex) => {
    if (!isRecord(statement)) return statement;
    if (Array.isArray(statement.companions)) {
      statement.companions = (statement.companions as unknown[]).map((companion, companionIndex) => {
        if (isRecord(companion)) {
          repairCustomMotionParams(
            companion,
            `scene.statements[${statementIndex}].companions[${companionIndex}].params`,
            warnings,
          );
        }
        return companion;
      });
    }
    repairCustomMotionParams(statement, `scene.statements[${statementIndex}].params`, warnings);
    return statement;
  });
  return { document, warnings };
}

function repairCustomMotionParams(entity: Record<string, unknown>, path: string, warnings: string[]): void {
  if (!isRecord(entity.params)) return;
  const motion = entity.params.motion;
  if (!isRecord(motion) || motion.kind !== 'custom') return;
  const repaired = completeImplicitCustomMotionSegments(motion);
  if (repaired.completed === 0) return;
  entity.params = { ...entity.params, motion: repaired.motion };
  const id = typeof entity.id === 'string' ? entity.id : path;
  warnings.push(`Completed ${repaired.completed} implicit linear keyframe segment(s) on custom motion "${id}"`);
}

/**
 * Complete missing segments on non-last keyframes of a custom motion with
 * explicit `{ type: 'linear' }` segments. Tracks or keyframes that are not
 * plain records pass through untouched and are left to the strict codec.
 */
function completeImplicitCustomMotionSegments(
  motion: Record<string, unknown>,
): { motion: Record<string, unknown>; completed: number } {
  if (!Array.isArray(motion.tracks)) return { motion, completed: 0 };
  let completed = 0;
  const tracks = (motion.tracks as unknown[]).map((track) => {
    if (!isRecord(track) || !Array.isArray(track.keyframes)) return track;
    const rawKeyframes = track.keyframes as unknown[];
    let changed = false;
    const keyframes = rawKeyframes.map((keyframe, keyframeIndex) => {
      if (!isRecord(keyframe)) return keyframe;
      const isLast = keyframeIndex === rawKeyframes.length - 1;
      if (isLast || keyframe.segment !== undefined) return keyframe;
      changed = true;
      completed += 1;
      return { ...keyframe, segment: { type: 'linear' } };
    });
    if (!changed) return track;
    return { ...track, keyframes };
  });
  if (completed === 0) return { motion, completed: 0 };
  return { motion: { ...motion, tracks }, completed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value: unknown): unknown {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function expectKeys(record: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new Error(`Unknown field at ${path}.${key}`);
    }
  }
}

function expectNonEmptyString(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error(`Expected non-empty string at ${path}`);
  }
  return input;
}

function expectNonNegativeNumber(input: unknown, path: string): number {
  const value = finiteNumber(input);
  if (value === undefined || value < 0) {
    throw new Error(`Expected non-negative number at ${path}`);
  }
  return value;
}

function finiteNumber(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

function finiteNonNegativeNumber(input: unknown): number | undefined {
  const value = finiteNumber(input);
  return value !== undefined && value >= 0 ? value : undefined;
}

function describeValue(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

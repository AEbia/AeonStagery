import type {
  CurrentSceneDocument,
  SceneStatement,
  StatementCategory,
  StatementFamily,
} from '../../api/types/semantic-scene';
import type {
  SemanticSceneLineAccessV1,
  SemanticSceneLineKindV1,
  SemanticSceneLineV1,
  SemanticSceneLineViewV1,
} from '../../api/types/semantic-scene-patch';
import {
  sceneStatementDefinitionRegistry,
  type SceneStatementDefinitionRegistry,
} from './SceneStatementDefinitionRegistry';

export interface SemanticSceneLineAccessContext {
  readonly line: number;
  readonly kind: SemanticSceneLineKindV1;
  readonly type: StatementFamily;
  readonly category: StatementCategory;
  readonly time: number;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface SemanticSceneLineViewOptions {
  readonly registry?: SceneStatementDefinitionRegistry;
  readonly access?: SemanticSceneLineAccessV1
    | ((context: SemanticSceneLineAccessContext) => SemanticSceneLineAccessV1);
}

/** Internal locator data retained by the host, never included in `lines`. */
export interface SemanticSceneResolvedLine {
  readonly line: number;
  readonly kind: SemanticSceneLineKindV1;
  readonly statementId: string;
  readonly companionId?: string;
  readonly parentStatementId?: string;
  readonly statementIndex: number;
  readonly companionIndex?: number;
}

/**
 * Flatten the source-order semantic document into the compact model-facing
 * line representation. A root and all of its companions remain adjacent;
 * the source array and companion arrays are intentionally not time-sorted.
 */
export class SemanticSceneLineView implements SemanticSceneLineViewV1 {
  readonly lines: readonly SemanticSceneLineV1[];
  readonly totalLines: number;

  private readonly resolvedLines: readonly SemanticSceneResolvedLine[];
  private readonly byLine: ReadonlyMap<number, SemanticSceneResolvedLine>;

  constructor(
    document: CurrentSceneDocument,
    options: SemanticSceneLineViewOptions = {},
  ) {
    const registry = options.registry ?? sceneStatementDefinitionRegistry;
    const lines: SemanticSceneLineV1[] = [];
    const resolvedLines: SemanticSceneResolvedLine[] = [];

    document.statements.forEach((statement, statementIndex) => {
      const line = lines.length + 1;
      lines.push(projectLine(statement, line, undefined, 'statement', registry, options.access));
      resolvedLines.push({
        line,
        kind: 'statement',
        statementId: statement.id,
        statementIndex,
      });

      if (statement.companions) {
        statement.companions.forEach((companion, companionIndex) => {
          const companionLine = lines.length + 1;
          const companionTime = statement.time
            + (companion.anchor === 'end' ? registry.temporalExtent(statement) : 0)
            + companion.offset;
          const companionStatement = {
            id: companion.id,
            time: companionTime,
            type: companion.type,
            params: companion.params,
          } as SceneStatement;
          lines.push(projectLine(
            companionStatement,
            companionLine,
            line,
            'companion',
            registry,
            options.access,
          ));
          resolvedLines.push({
            line: companionLine,
            kind: 'companion',
            statementId: statement.id,
            companionId: companion.id,
            parentStatementId: statement.id,
            statementIndex,
            companionIndex,
          });
        });
      }
    });

    this.lines = deepFreeze(lines);
    this.totalLines = this.lines.length;
    this.resolvedLines = deepFreeze(resolvedLines);
    this.byLine = new Map(this.resolvedLines.map((resolved) => [resolved.line, resolved]));
  }

  /** Return only the safe, model-facing projection. */
  toJSON(): SemanticSceneLineViewV1 {
    return {
      lines: this.lines,
      totalLines: this.totalLines,
    };
  }

  /** Host-only line resolution used by the patch executor. */
  resolveInternal(line: number): SemanticSceneResolvedLine | undefined {
    return this.byLine.get(line);
  }

  /** Host-only snapshot iteration; no source identity is placed in the view. */
  internalLines(): readonly SemanticSceneResolvedLine[] {
    return this.resolvedLines;
  }
}

export function buildSemanticSceneLineView(
  document: CurrentSceneDocument,
  options: SemanticSceneLineViewOptions = {},
): SemanticSceneLineViewV1 {
  return new SemanticSceneLineView(document, options).toJSON();
}

export const createSemanticSceneLineView = buildSemanticSceneLineView;

export function flattenSemanticSceneLines(
  document: CurrentSceneDocument,
  options: SemanticSceneLineViewOptions = {},
): readonly SemanticSceneLineV1[] {
  return buildSemanticSceneLineView(document, options).lines;
}

function projectLine(
  statement: SceneStatement,
  line: number,
  parentLine: number | undefined,
  kind: SemanticSceneLineKindV1,
  registry: SceneStatementDefinitionRegistry,
  accessOption: SemanticSceneLineViewOptions['access'],
): SemanticSceneLineV1 {
  const definition = registry.get(statement.type);
  const presentation = registry.timelinePresentation(statement);
  const params = projectParams(
    statement.params as unknown,
    definition.patchMetadata?.hiddenTechnicalIdentityPaths
      ?? registry.patchMetadata(statement.type).hiddenTechnicalIdentityPaths
      ?? [],
  );
  const accessContext: SemanticSceneLineAccessContext = {
    line,
    kind,
    type: statement.type,
    category: definition.category,
    time: statement.time,
    params,
  };
  const access = typeof accessOption === 'function'
    ? accessOption(accessContext)
    : accessOption ?? 'writable';

  return {
    line,
    ...(parentLine === undefined ? {} : { parentLine }),
    kind,
    time: statement.time,
    durationSeconds: registry.temporalExtent(statement),
    type: statement.type,
    category: definition.category,
    label: presentation.label,
    iconKey: presentation.iconKey,
    access,
    params,
  };
}

function projectParams(
  value: unknown,
  hiddenTechnicalIdentityPaths: readonly string[],
): Readonly<Record<string, unknown>> {
  const hidden = new Set(hiddenTechnicalIdentityPaths);
  const projected = projectValue(value, 'params', hidden);
  if (!projected || typeof projected !== 'object' || Array.isArray(projected)) {
    return {};
  }
  return projected as Readonly<Record<string, unknown>>;
}

function projectValue(
  value: unknown,
  path: string,
  hiddenPaths: ReadonlySet<string>,
): unknown {
  if (hiddenPaths.has(path) || hiddenPaths.has(path.replace(/^params\./, ''))) return undefined;
  if (Array.isArray(value)) {
    // Custom-motion tracks are the only model-facing `tracks` arrays. Their raw
    // keyframe payloads (time/value/segment per parameter, potentially thousands
    // of entries) are editor-authored data the processors never read; replacing
    // them with a keyframeCount metadata field keeps agent / AI line views lean.
    if (path.endsWith('.tracks')) {
      return projectTrackArray(value, path, hiddenPaths);
    }
    return value.map((item, index) => projectValue(item, `${path}[${index}]`, hiddenPaths));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    Object.entries(value).forEach(([key, child]) => {
      const childPath = `${path}.${key}`;
      if (hiddenPaths.has(childPath) || hiddenPaths.has(key)) return;
      const projected = projectValue(child, childPath, hiddenPaths);
      if (projected !== undefined) result[key] = projected;
    });
    return result;
  }
  return value;
}

/**
 * Project a custom-motion `tracks` array: every track keeps its identity and
 * per-track metadata (parameterId / fadeInSeconds) but its `keyframes` array is
 * replaced by `keyframeCount`. Keyframes are never authored through patches —
 * they are produced by the keyframe editor / lease intents — so the raw payload
 * carries no addressing or constraint meaning for model-facing consumers.
 */
function projectTrackArray(
  value: unknown[],
  path: string,
  hiddenPaths: ReadonlySet<string>,
): unknown[] {
  return value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return projectValue(item, itemPath, hiddenPaths);
    }
    const record = item as Record<string, unknown>;
    if (!Array.isArray(record.keyframes)) {
      return projectValue(item, itemPath, hiddenPaths);
    }
    const keyframeCount = record.keyframes.length;
    const { keyframes: _dropped, ...rest } = record;
    const projected = projectValue(rest, itemPath, hiddenPaths);
    if (!projected || typeof projected !== 'object' || Array.isArray(projected)) {
      return projected;
    }
    return { ...(projected as Record<string, unknown>), keyframeCount };
  });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child));
  return value;
}

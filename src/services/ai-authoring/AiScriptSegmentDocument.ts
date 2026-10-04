import type {
  AuthoringOrigin,
  AuthoringScope,
  AuthoringWarning,
  ResolvedAuthoringScope,
  SemanticAuthorReceipt,
} from '../../api/types/authoring';
import type { SceneMarker } from '../../api/types/scene-common';
import type { CurrentSceneDocument, SceneStatement } from '../../api/types/semantic-scene';
import {
  SceneStatementFactory,
  sceneDocumentCodec,
  sceneStatementFactory,
  type SceneStatementCreationDraft,
  type SceneStatementIdGenerator,
} from '../semantic-scene';
import { createSemanticAuthorReceipt } from '../timeline-authoring/SemanticAuthoringReceipt';
import type {
  AiScriptSegmentCompileIssue,
  AiScriptSegmentSemanticCompileResult,
} from './AiScriptSegmentCompiler';

export type AiScriptSegmentMarkerIdGenerator = (prefix: string) => string;

export interface ApplyAiScriptSegmentOptions {
  statementIdGenerator?: SceneStatementIdGenerator;
  markerIdGenerator?: AiScriptSegmentMarkerIdGenerator;
  factory?: SceneStatementFactory;
}

export interface ApplyAiScriptSegmentResult {
  document: CurrentSceneDocument;
  createdStatements: SceneStatement[];
  createdStatementIds: string[];
  createdMarkerIds: string[];
  createdMarkers: SceneMarker[];
  timeRange?: {
    start: number;
    end: number;
  };
}

export interface AuthorAiScriptSegmentOptions extends ApplyAiScriptSegmentOptions {
  origin?: AuthoringOrigin;
  scope?: AuthoringScope;
}

export interface AuthorAiScriptSegmentResult {
  document: CurrentSceneDocument;
  receipt: SemanticAuthorReceipt;
  issues: AiScriptSegmentCompileIssue[];
}

export function applyAiScriptSegmentToCurrentSceneDocument(
  document: CurrentSceneDocument,
  compiled: AiScriptSegmentSemanticCompileResult,
  anchorTime: number,
  options: ApplyAiScriptSegmentOptions = {},
): ApplyAiScriptSegmentResult {
  const factory = options.factory ?? (options.statementIdGenerator
    ? new SceneStatementFactory({ idGenerator: options.statementIdGenerator })
    : sceneStatementFactory);
  const markerIdGenerator = options.markerIdGenerator ?? defaultIdGenerator;
  let next = document;
  const createdStatementIds: string[] = [];

  for (const draft of compiled.statements) {
    const absoluteDraft = {
      ...draft,
      time: roundTime(anchorTime + (draft.time ?? 0)),
    } as SceneStatementCreationDraft;
    const statement = factory.createStatement(
      absoluteDraft,
      next.statements.map((candidate) => candidate.id),
    );
    createdStatementIds.push(statement.id);
    next = factory.insertStatement(next, statement as SceneStatementCreationDraft, { placement: 'time' });
  }

  const createdMarkers = materializeMarkers(
    compiled,
    anchorTime,
    next.meta.markers ?? [],
    markerIdGenerator,
  );
  if (createdMarkers.length > 0) {
    next = sceneDocumentCodec.parseAndValidate({
      ...next,
      meta: {
        ...next.meta,
        markers: [
          ...(next.meta.markers ?? []),
          ...createdMarkers,
        ].sort((a, b) => a.time - b.time || a.markerId.localeCompare(b.markerId)),
      },
    });
  }

  if (compiled.durationSeconds !== undefined) {
    const nextDuration = roundTime(Math.max(
      next.meta.durationSeconds ?? 0,
      anchorTime + compiled.durationSeconds,
    ));
    next = factory.withExplicitDuration(next, nextDuration);
  }

  return {
    document: next,
    createdStatements: collectCreatedStatements(next, createdStatementIds),
    createdStatementIds,
    createdMarkerIds: createdMarkers.map((marker) => marker.markerId),
    createdMarkers,
    timeRange: compiled.timeRange
      ? {
          start: roundTime(anchorTime + compiled.timeRange.start),
          end: roundTime(anchorTime + compiled.timeRange.end),
        }
      : undefined,
  };
}

export function authorAiScriptSegmentIntoCurrentSceneDocument(
  document: CurrentSceneDocument,
  compiled: AiScriptSegmentSemanticCompileResult,
  anchorTime: number,
  correlationId: string,
  options: AuthorAiScriptSegmentOptions = {},
): AuthorAiScriptSegmentResult {
  const errors = compiled.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`Cannot apply AI script segment with compile errors: ${errors.map((issue) => issue.message).join(' ')}`);
  }

  const applied = applyAiScriptSegmentToCurrentSceneDocument(document, compiled, anchorTime, options);
  const receipt = createSemanticAuthorReceipt({
    correlationId,
    intentType: 'insert-script-segment',
    origin: options.origin ?? 'ai-script-panel',
    historyDescriptor: {
      key: 'timeline.author.insertScriptSegment',
      args: { count: applied.createdStatementIds.length + applied.createdMarkerIds.length },
      fallbackLabel: 'AI 铺戏',
    },
    resolvedScope: resolveScope(options.scope),
    warnings: compiled.issues
      .filter((issue) => issue.severity === 'warning')
      .map(issueToWarning),
    createdStatements: applied.createdStatements,
    createdMarkers: applied.createdMarkers,
    timeRange: applied.timeRange,
  });

  return {
    document: applied.document,
    receipt,
    issues: compiled.issues.map((issue) => ({ ...issue })),
  };
}

function materializeMarkers(
  compiled: AiScriptSegmentSemanticCompileResult,
  anchorTime: number,
  existingMarkers: readonly SceneMarker[],
  markerIdGenerator: AiScriptSegmentMarkerIdGenerator,
): SceneMarker[] {
  const usedIds = new Set(existingMarkers.map((marker) => marker.markerId));
  return compiled.markers.map((marker) => {
    const markerId = claimGeneratedId('marker', usedIds, markerIdGenerator);
    return {
      markerId,
      time: roundTime(anchorTime + marker.offset),
      label: marker.label,
      ...(marker.color ? { color: marker.color } : {}),
      ...(marker.role ? { role: marker.role } : {}),
    };
  });
}

function collectCreatedStatements(document: CurrentSceneDocument, createdStatementIds: readonly string[]): SceneStatement[] {
  return createdStatementIds.map((statementId) => {
    const statement = document.statements.find((candidate) => candidate.id === statementId);
    if (!statement) {
      throw new Error(`Created statement "${statementId}" is missing from CurrentSceneDocument`);
    }
    return statement;
  });
}

function resolveScope(scope: AuthoringScope | undefined): ResolvedAuthoringScope {
  if (!scope) return { kind: 'none' };
  if (scope.kind === 'none') return { kind: 'none' };
  if (scope.kind === 'character') return { kind: 'character', charId: scope.charId };
  return { kind: 'inferred-character', charId: scope.charId, source: scope.source };
}

function issueToWarning(issue: AiScriptSegmentCompileIssue): AuthoringWarning {
  return {
    severity: 'warning',
    code: 'ai-script-segment-warning',
    message: issue.message,
    ...(issue.stepIndex !== undefined ? { details: { stepIndex: issue.stepIndex } } : {}),
  };
}

function claimGeneratedId(
  prefix: string,
  usedIds: Set<string>,
  idGenerator: AiScriptSegmentMarkerIdGenerator,
): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = idGenerator(prefix);
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
  throw new Error(`Could not generate a unique id for prefix "${prefix}"`);
}

function defaultIdGenerator(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function roundTime(value: number): number {
  return Math.round(value * 10) / 10;
}

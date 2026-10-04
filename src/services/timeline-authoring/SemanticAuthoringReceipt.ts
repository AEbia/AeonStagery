import {
  AUTHORING_SCHEMA_VERSION,
  type AuthoringOrigin,
  type AuthoringSideEffect,
  type AuthoringWarning,
  type CompanionLocator,
  type HistoryDescriptor,
  type ResolvedAuthoringScope,
  type SemanticAuthorIntent,
  type SemanticAuthorReceipt,
} from '../../api/types/authoring';
import type { SceneMarker } from '../../api/types/scene-common';
import type { DialogueCompanion, SceneStatement } from '../../api/types/semantic-scene';
import { sceneStatementDefinitionRegistry } from '../semantic-scene';

export interface CompanionChange {
  readonly statementId: string;
  readonly companion: DialogueCompanion;
}

export interface SemanticAuthorReceiptInput {
  readonly correlationId: string;
  readonly intentType: SemanticAuthorIntent['kind'];
  readonly origin: AuthoringOrigin;
  readonly historyDescriptor: HistoryDescriptor;
  readonly resolvedScope: ResolvedAuthoringScope;
  readonly warnings?: readonly AuthoringWarning[];
  readonly createdStatements?: readonly SceneStatement[];
  readonly updatedStatements?: readonly SceneStatement[];
  readonly deletedStatements?: readonly SceneStatement[];
  readonly createdCompanions?: readonly CompanionChange[];
  readonly updatedCompanions?: readonly CompanionChange[];
  readonly deletedCompanions?: readonly CompanionChange[];
  readonly createdMarkers?: readonly SceneMarker[];
  readonly deletedMarkers?: readonly SceneMarker[];
  readonly sideEffects?: readonly AuthoringSideEffect[];
  readonly timeRange?: {
    readonly start: number;
    readonly end: number;
  };
}

export function createSemanticAuthorReceipt(input: SemanticAuthorReceiptInput): SemanticAuthorReceipt {
  const createdStatements = input.createdStatements ?? [];
  const updatedStatements = input.updatedStatements ?? [];
  const deletedStatements = input.deletedStatements ?? [];
  const createdMarkers = input.createdMarkers ?? [];
  const deletedMarkers = input.deletedMarkers ?? [];
  const allTimes = [
    ...createdStatements.map(statementEnd),
    ...updatedStatements.map(statementEnd),
    ...deletedStatements.map(statementEnd),
    ...createdMarkers.map((marker) => marker.time),
    ...deletedMarkers.map((marker) => marker.time),
  ];

  return {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId: input.correlationId,
    intentType: input.intentType,
    origin: input.origin,
    historyDescriptor: cloneJson(input.historyDescriptor),
    warnings: cloneJson([...(input.warnings ?? [])]),
    resolvedScope: cloneJson(input.resolvedScope),
    createdStatementIds: createdStatements.map((statement) => statement.id),
    updatedStatementIds: updatedStatements.map((statement) => statement.id),
    deletedStatementIds: deletedStatements.map((statement) => statement.id),
    createdCompanionLocators: companionLocators(input.createdCompanions ?? []),
    updatedCompanionLocators: companionLocators(input.updatedCompanions ?? []),
    deletedCompanionLocators: companionLocators(input.deletedCompanions ?? []),
    createdMarkerIds: createdMarkers.map((marker) => marker.markerId),
    deletedMarkerIds: deletedMarkers.map((marker) => marker.markerId),
    createdMarkers: cloneJson([...createdMarkers]),
    deletedMarkers: cloneJson([...deletedMarkers]),
    sideEffects: cloneJson([...(input.sideEffects ?? [])]),
    timeRange: input.timeRange
      ? cloneJson(input.timeRange)
      : allTimes.length > 0
        ? { start: Math.min(...allTimes), end: Math.max(...allTimes) }
        : undefined,
  };
}

function companionLocators(changes: readonly CompanionChange[]): CompanionLocator[] {
  return changes.map((change) => ({
    statementId: change.statementId,
    companionId: change.companion.id,
  }));
}

function statementEnd(statement: SceneStatement): number {
  return statement.time + sceneStatementDefinitionRegistry.temporalExtent(statement);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

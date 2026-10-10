import {
  AUTHORING_SCHEMA_VERSION,
  type SemanticAuthoringLocator,
  type SemanticAuthorIntent,
} from '../../api/types/authoring';
import type { CharacterMotionOutput, CompiledAction, CompiledScene, CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { DialogueCompanion, DialogueCompanionDraft, SceneStatement, SceneStatementDraft } from '../../api/types/semantic-scene';
import { sceneStatementDefinitionRegistry } from '../../services/semantic-scene';
import { getDefaultDialogueDurationSeconds } from '../SettingsStore';
import { resolveDialogueDuration } from '../../services/pacing/pacing';
import type { ReadonlyDocumentStore } from '../store/DocumentStore';
import { buildSemanticTimelineReadModel } from './semanticTimelineReadModel';

export function createSemanticTimelineCorrelationId(prefix = 'timeline_editor'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Decides whether a timeline param patch must be authored through the source
 * param seam instead of the compiled-action seam.
 *
 * Camera/visual/filter/lighting families always write source params. Other
 * families use the source seam when every patched key already exists in the
 * source params; otherwise they fall back to the compiled seam, which maps
 * runtime params back onto the source. ADR-0022 performance placeholders lower
 * to NO compiled action, so a patch introducing a field the source does not
 * have yet (expression / lookAt / blink on an empty-motion placeholder) can
 * never resolve through the compiled seam and must go to the source seam or
 * the write is silently dropped.
 */
export function shouldRouteTimelineParamPatchToSource(
  sourceParams: Readonly<Record<string, unknown>> | undefined,
  paramPatch: Readonly<Record<string, unknown>>,
  hasCompiledAction: boolean,
  semanticType?: string,
): boolean {
  if (semanticType && ['camera', 'visualStyle', 'filterAdd', 'filterChange', 'filterReset', 'lighting'].includes(semanticType)) {
    return true;
  }
  if (!sourceParams) return false;
  const keys = Object.keys(paramPatch);
  if (keys.length === 0) return false;
  if (keys.every((key) => Object.prototype.hasOwnProperty.call(sourceParams, key))) return true;
  return !hasCompiledAction;
}

export function findCompiledTimelineAction(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot'>,
  actionId: string,
): CompiledAction | undefined {
  return documentStore.getCompiledSceneSnapshot()?.actions.find((action) => action.id === actionId);
}

export function locatorForCompiledTimelineAction(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot'>,
  actionId: string,
): SemanticAuthoringLocator | null {
  const compiledAction = findCompiledTimelineAction(documentStore, actionId);
  if (!compiledAction?.source.statementId) return null;
  return compiledAction.source.companionId
    ? {
        kind: 'companion',
        statementId: compiledAction.source.statementId,
        companionId: compiledAction.source.companionId,
      }
    : {
        kind: 'statement',
        statementId: compiledAction.source.statementId,
      };
}

/**
 * Resolves a timeline block to its semantic locator. Compiled actions resolve
 * through the compiled seam; uncompiled blocks (ADR-0022 performance
 * placeholders lower to no runtime action) fall back to the semantic read
 * model so they can still be edited and deleted.
 */
export function locatorForTimelineAction(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot' | 'getCurrentSceneDocumentSnapshot'>,
  actionId: string,
): SemanticAuthoringLocator | null {
  const compiledLocator = locatorForCompiledTimelineAction(documentStore, actionId);
  if (compiledLocator) return compiledLocator;
  const document = documentStore.getCurrentSceneDocumentSnapshot();
  if (!document) return null;
  const item = buildSemanticTimelineReadModel(
    document,
    documentStore.getCompiledSceneSnapshot(),
  ).find((candidate) => candidate.id === actionId);
  return item?.locator ?? null;
}

export function buildSemanticMoveTimelineIntent(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot'>
    & Partial<Pick<ReadonlyDocumentStore, 'getCurrentSceneDocumentSnapshot'>>,
  updates: ReadonlyArray<{ id: string; time: number }>,
  correlationId = createSemanticTimelineCorrelationId('timeline_move'),
): SemanticAuthorIntent | null {
  const moves = dedupeMoves(updates.flatMap((update) => {
    const locator = locatorForCompiledTimelineAction(documentStore, update.id)
      ?? (documentStore.getCurrentSceneDocumentSnapshot
        ? locatorForTimelineAction(documentStore as Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot' | 'getCurrentSceneDocumentSnapshot'>, update.id)
        : null);
    return locator ? [{ locator, time: Math.max(0, roundTime(update.time)) }] : [];
  }));
  if (moves.length === 0) return null;
  return {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId,
    origin: 'timeline-editor',
    kind: 'move-timeline-locators',
    moves,
  };
}

export function buildSemanticDeleteTimelineIntent(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot' | 'getCurrentSceneDocumentSnapshot'>,
  actionIds: readonly string[],
  correlationId = createSemanticTimelineCorrelationId('timeline_delete'),
): SemanticAuthorIntent | null {
  return buildSemanticDeleteTimelineIntents(documentStore, actionIds, correlationId)[0] ?? null;
}

export function buildSemanticDeleteTimelineIntents(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot' | 'getCurrentSceneDocumentSnapshot'>,
  actionIds: readonly string[],
  correlationId = createSemanticTimelineCorrelationId('timeline_delete'),
): SemanticAuthorIntent[] {
  const locators = collectUniqueLocators(documentStore, actionIds);
  const statementIds = new Set<string>();
  const companionLocators: Array<{ statementId: string; companionId: string }> = [];

  for (const locator of locators) {
    if (locator.kind === 'statement') {
      statementIds.add(locator.statementId);
    }
  }
  for (const locator of locators) {
    if (locator.kind === 'companion' && !statementIds.has(locator.statementId)) {
      companionLocators.push({
        statementId: locator.statementId,
        companionId: locator.companionId,
      });
    }
  }

  const intents: SemanticAuthorIntent[] = [];
  if (statementIds.size > 0) {
    intents.push({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId,
      origin: 'timeline-editor',
      kind: 'delete-statements',
      statementIds: [...statementIds],
    });
  }
  if (companionLocators.length > 0) {
    intents.push({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: `${correlationId}_companions`,
      origin: 'timeline-editor',
      kind: 'delete-dialogue-companions',
      locators: companionLocators,
    });
  }
  return intents;
}

export function buildSemanticDuplicateTimelineIntent(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot' | 'getCurrentSceneDocumentSnapshot'>,
  actionIds: readonly string[],
  correlationId = createSemanticTimelineCorrelationId('timeline_duplicate'),
): SemanticAuthorIntent | null {
  const statementIds = new Set<string>();
  for (const locator of collectUniqueLocators(documentStore, actionIds)) {
    if (locator.kind === 'statement') statementIds.add(locator.statementId);
  }
  if (statementIds.size === 0) return null;
  return {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId,
    origin: 'timeline-editor',
    kind: 'duplicate-statements',
    statementIds: [...statementIds],
  };
}

export function buildSemanticCopyBufferForTimelineActions(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot' | 'getCurrentSceneDocumentSnapshot'>,
  actionIds: readonly string[],
): SceneStatementDraft[] {
  const document = documentStore.getCurrentSceneDocumentSnapshot();
  const compiled = documentStore.getCompiledSceneSnapshot();
  if (!document || actionIds.length === 0) return [];

  const compiledById = new Map(compiled?.actions.map((action) => [action.id, action]) ?? []);
  const semanticById = new Map(buildSemanticTimelineReadModel(document, compiled).map((item) => [item.id, item]));
  const copied = new Map<string, { time: number; draft: SceneStatementDraft }>();

  for (const actionId of actionIds) {
    const compiledAction = compiledById.get(actionId);
    const semanticItem = semanticById.get(actionId);
    const locator = compiledAction
      ? locatorForCompiledTimelineAction(documentStore, actionId)
      : semanticItem?.locator;
    if (!locator) continue;
    const key = locatorKey(locator);
    if (copied.has(key)) continue;

    if (locator.kind === 'statement') {
      const statement = findStatement(document, locator.statementId);
      if (!statement) continue;
      copied.set(key, {
        time: statement.time,
        draft: statementToDraft(statement),
      });
      continue;
    }

    const parent = findStatement(document, locator.statementId);
    const companion = parent?.companions?.find((candidate) => candidate.id === locator.companionId);
    if (!companion) continue;
    copied.set(key, {
      time: compiledAction?.time ?? semanticItem!.time,
      draft: companionToStatementDraft(companion),
    });
  }

  const items = [...copied.values()].sort((a, b) => a.time - b.time);
  if (items.length === 0) return [];
  const baseTime = items[0].time;
  return items.map(({ time, draft }) => ({
    ...draft,
    time: roundTime(time - baseTime),
  } as SceneStatementDraft));
}

export function buildSemanticPasteTimelineIntent(
  statements: readonly SceneStatementDraft[],
  anchorTime: number,
  correlationId = createSemanticTimelineCorrelationId('timeline_paste'),
  origin: SemanticAuthorIntent['origin'] = 'block-context-menu',
): SemanticAuthorIntent | null {
  if (statements.length === 0 || !Number.isFinite(anchorTime)) return null;
  return {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId,
    origin,
    kind: 'insert-script-segment',
    anchorTime: Math.max(0, roundTime(anchorTime)),
    statements: cloneJson([...statements]),
  };
}

export function buildSemanticRetargetTimelineIntents(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot' | 'getCurrentSceneDocumentSnapshot'>,
  actionIds: readonly string[],
  charId: string,
  characterName?: string,
  correlationId = createSemanticTimelineCorrelationId('timeline_retarget'),
): SemanticAuthorIntent[] {
  const document = documentStore.getCurrentSceneDocumentSnapshot();
  if (!document) return [];

  const locators = collectUniqueLocators(documentStore, actionIds);
  const intents: SemanticAuthorIntent[] = [];

  locators.forEach((locator, index) => {
    if (locator.kind === 'statement') {
      const statement = findStatement(document, locator.statementId);
      if (!statement) return;
      const patch = retargetStatement(statement, charId, characterName);
      if (!patch) return;
      intents.push({
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: `${correlationId}_${index}`,
        origin: 'timeline-editor',
        kind: 'update-statement',
        statementId: statement.id,
        patch,
      });
      return;
    }

    const parent = findStatement(document, locator.statementId);
    const companion = parent?.companions?.find((candidate) => candidate.id === locator.companionId);
    if (!companion) return;
    const patch = retargetCompanion(companion, charId, characterName);
    if (!patch) return;
    intents.push({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: `${correlationId}_${index}`,
      origin: 'timeline-editor',
      kind: 'update-dialogue-companion',
      locator: {
        statementId: locator.statementId,
        companionId: locator.companionId,
      },
      patch,
    });
  });

  return intents;
}

export function buildSemanticDurationUpdateIntent(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot' | 'getCurrentSceneDocumentSnapshot'>,
  actionId: string,
  durationSeconds: number,
  correlationId = createSemanticTimelineCorrelationId('timeline_duration'),
): SemanticAuthorIntent | null {
  const document = documentStore.getCurrentSceneDocumentSnapshot();
  const locator = locatorForCompiledTimelineAction(documentStore, actionId);
  if (!document || !locator || !Number.isFinite(durationSeconds)) return null;

  const nextDuration = roundTime(Math.max(0, durationSeconds));
  if (locator.kind === 'statement') {
    const statement = findStatement(document, locator.statementId);
    if (!statement) return null;
    const patch = durationPatchForStatement(statement, nextDuration);
    if (!patch) return null;
    return {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId,
      origin: 'timeline-editor',
      kind: 'update-statement',
      statementId: statement.id,
      patch,
    };
  }

  const parent = findStatement(document, locator.statementId);
  const companion = parent?.companions?.find((candidate) => candidate.id === locator.companionId);
  if (!companion) return null;
  const patch = durationPatchForCompanion(companion, nextDuration);
  if (!patch) return null;
  return {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId,
    origin: 'timeline-editor',
    kind: 'update-dialogue-companion',
    locator: {
      statementId: locator.statementId,
      companionId: locator.companionId,
    },
    patch,
  };
}

export function buildSemanticSourceParamUpdateIntent(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot' | 'getCurrentSceneDocumentSnapshot'>,
  actionId: string,
  sourceParamPatch: Readonly<Record<string, unknown>>,
  correlationId = createSemanticTimelineCorrelationId('timeline_source_param'),
): SemanticAuthorIntent | null {
  const document = documentStore.getCurrentSceneDocumentSnapshot();
  const locator = locatorForTimelineAction(documentStore, actionId);
  if (!document || !locator) return null;

  if (locator.kind === 'statement') {
    const statement = findStatement(document, locator.statementId);
    if (!statement) return null;
    const params = applySourceParamPatch(statement.params, sourceParamPatch);
    if (!params) return null;
    return {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId,
      origin: 'timeline-editor',
      kind: 'update-statement',
      statementId: statement.id,
      patch: { params } as Partial<SceneStatement>,
    };
  }

  const parent = findStatement(document, locator.statementId);
  const companion = parent?.companions?.find((candidate) => candidate.id === locator.companionId);
  if (!companion) return null;
  const params = applySourceParamPatch(companion.params, sourceParamPatch);
  if (!params) return null;
  return {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId,
    origin: 'timeline-editor',
    kind: 'update-dialogue-companion',
    locator: {
      statementId: locator.statementId,
      companionId: locator.companionId,
    },
    patch: { params } as Partial<DialogueCompanion>,
  };
}

export function buildSemanticSourceParamsReplaceIntent(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot' | 'getCurrentSceneDocumentSnapshot'>,
  actionId: string,
  sourceParams: Readonly<Record<string, unknown>>,
  correlationId = createSemanticTimelineCorrelationId('timeline_source_params_replace'),
): SemanticAuthorIntent | null {
  const document = documentStore.getCurrentSceneDocumentSnapshot();
  const locator = locatorForTimelineAction(documentStore, actionId);
  if (!document || !locator) return null;
  const params = cloneJson(sourceParams) as SceneStatement['params'];

  if (locator.kind === 'statement') {
    if (!findStatement(document, locator.statementId)) return null;
    return {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId,
      origin: 'timeline-editor',
      kind: 'update-statement',
      statementId: locator.statementId,
      patch: { params } as Partial<SceneStatement>,
    };
  }

  const parent = findStatement(document, locator.statementId);
  if (!parent?.companions?.some((candidate) => candidate.id === locator.companionId)) return null;
  return {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId,
    origin: 'timeline-editor',
    kind: 'update-dialogue-companion',
    locator: { statementId: locator.statementId, companionId: locator.companionId },
    patch: { params } as Partial<DialogueCompanion>,
  };
}

export function buildSemanticTimelineParamUpdateIntent(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot' | 'getCurrentSceneDocumentSnapshot'>,
  actionId: string,
  timelineParamPatch: Readonly<Record<string, unknown>>,
  correlationId = createSemanticTimelineCorrelationId('timeline_param'),
): SemanticAuthorIntent | null {
  const document = documentStore.getCurrentSceneDocumentSnapshot();
  const compiledAction = findCompiledTimelineAction(documentStore, actionId);
  const locator = locatorForCompiledTimelineAction(documentStore, actionId);
  if (!document || !compiledAction || !locator) return null;

  if (locator.kind === 'statement') {
    const statement = findStatement(document, locator.statementId);
    if (!statement) return null;
    const params = applyTimelineParamPatchToSourceParams(statement, compiledAction, timelineParamPatch);
    if (!params) return null;
    return {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId,
      origin: 'timeline-editor',
      kind: 'update-statement',
      statementId: statement.id,
      patch: { params } as Partial<SceneStatement>,
    };
  }

  const parent = findStatement(document, locator.statementId);
  const companion = parent?.companions?.find((candidate) => candidate.id === locator.companionId);
  if (!companion) return null;
  const params = applyTimelineParamPatchToSourceParams(companion, compiledAction, timelineParamPatch);
  if (!params) return null;
  return {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId,
    origin: 'timeline-editor',
    kind: 'update-dialogue-companion',
    locator: {
      statementId: locator.statementId,
      companionId: locator.companionId,
    },
    patch: { params } as Partial<DialogueCompanion>,
  };
}

export function buildSemanticSplitTimelineIntents(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot' | 'getCurrentSceneDocumentSnapshot'>,
  actionId: string,
  splitTime: number,
  correlationId = createSemanticTimelineCorrelationId('timeline_split'),
): SemanticAuthorIntent[] {
  const document = documentStore.getCurrentSceneDocumentSnapshot();
  const compiledAction = findCompiledTimelineAction(documentStore, actionId);
  const locator = locatorForCompiledTimelineAction(documentStore, actionId);
  if (!document || !compiledAction || !locator || !Number.isFinite(splitTime)) return [];

  if (locator.kind === 'statement') {
    const statement = findStatement(document, locator.statementId);
    if (!statement) return [];
    const split = splitTimelineItem(statement, compiledAction.time, splitTime);
    if (!split) return [];
    return [
      {
        version: AUTHORING_SCHEMA_VERSION,
        correlationId,
        origin: 'timeline-editor',
        kind: 'update-statement',
        statementId: statement.id,
        patch: { params: split.firstParams } as Partial<SceneStatement>,
      },
      {
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: `${correlationId}_tail`,
        origin: 'timeline-editor',
        kind: 'insert-statement',
        anchorTime: splitTime,
        statement: {
          type: statement.type,
          params: split.secondParams,
        } as SceneStatementDraft,
      },
    ];
  }

  const parent = findStatement(document, locator.statementId);
  const companion = parent?.companions?.find((candidate) => candidate.id === locator.companionId);
  if (!parent || !companion) return [];
  const split = splitTimelineItem(companion, compiledAction.time, splitTime);
  if (!split) return [];
  const baseTime = parent.time + (companion.anchor === 'end' ? sourceDurationSeconds(parent) ?? 0 : 0);
  return [
    {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId,
      origin: 'timeline-editor',
      kind: 'update-dialogue-companion',
      locator: {
        statementId: parent.id,
        companionId: companion.id,
      },
      patch: { params: split.firstParams } as Partial<DialogueCompanion>,
    },
    {
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: `${correlationId}_tail`,
      origin: 'timeline-editor',
      kind: 'insert-dialogue-companion',
      parentStatementId: parent.id,
      companion: {
        anchor: companion.anchor,
        offset: roundTime(splitTime - baseTime),
        type: companion.type,
        params: split.secondParams,
      },
    },
  ];
}

export function selectCompiledActionsForStatements(
  compiled: CompiledScene | null,
  statementIds: readonly string[],
): Record<string, boolean> {
  const wanted = new Set(statementIds);
  const selected: Record<string, boolean> = {};
  for (const action of compiled?.actions ?? []) {
    if (wanted.has(action.source.statementId) && !action.source.companionId) {
      selected[action.id] = true;
    }
  }
  return selected;
}

export function defaultDialogueStatementDraft(
  _document: CurrentSceneDocument | null,
  presentation?: import('../../api/types/semantic-scene').DialogueImagePresentation,
  template?: 'glass' | 'minimal' | 'classic',
) {
  return {
    type: 'dialogue' as const,
    params: {
      text: '新对白',
      durationSeconds: resolveDialogueDuration({
        context: 'manual-default',
        defaultDurationSeconds: getDefaultDialogueDurationSeconds(),
      }),
      ...(template ? { template } : {}),
      ...(presentation ? { presentation: JSON.parse(JSON.stringify(presentation)) } : {})
    },
  };
}

function collectUniqueLocators(
  documentStore: Pick<ReadonlyDocumentStore, 'getCompiledSceneSnapshot' | 'getCurrentSceneDocumentSnapshot'>,
  actionIds: readonly string[],
): SemanticAuthoringLocator[] {
  const locators = new Map<string, SemanticAuthoringLocator>();
  for (const actionId of actionIds) {
    const locator = locatorForTimelineAction(documentStore, actionId);
    if (!locator) continue;
    locators.set(locatorKey(locator), locator);
  }
  return [...locators.values()];
}

function findStatement(document: CurrentSceneDocument, statementId: string): SceneStatement | undefined {
  return document.statements.find((statement) => statement.id === statementId);
}

function statementToDraft(statement: SceneStatement): SceneStatementDraft {
  return {
    type: statement.type,
    params: cloneJson(statement.params),
    ...(statement.companions?.length
      ? { companions: statement.companions.map(companionToDraft) }
      : {}),
  } as SceneStatementDraft;
}

function companionToStatementDraft(companion: DialogueCompanion): SceneStatementDraft {
  return {
    type: companion.type,
    params: cloneJson(companion.params),
  } as SceneStatementDraft;
}

function companionToDraft(companion: DialogueCompanion): DialogueCompanionDraft {
  return {
    anchor: companion.anchor,
    offset: companion.offset,
    type: companion.type,
    params: cloneJson(companion.params),
  } as DialogueCompanionDraft;
}

function retargetStatement(
  statement: SceneStatement,
  charId: string,
  characterName: string | undefined,
): Partial<SceneStatement> | null {
  const params = retargetParams(statement, charId, characterName);
  return params ? { params } as Partial<SceneStatement> : null;
}

function retargetCompanion(
  companion: DialogueCompanion,
  charId: string,
  characterName: string | undefined,
): Partial<DialogueCompanion> | null {
  const params = retargetParams(companion, charId, characterName);
  return params ? { params } as Partial<DialogueCompanion> : null;
}

function durationPatchForStatement(
  statement: SceneStatement,
  durationSeconds: number,
): Partial<SceneStatement> | null {
  const params = paramsWithDuration(statement, durationSeconds);
  return params ? { params } as Partial<SceneStatement> : null;
}

function durationPatchForCompanion(
  companion: DialogueCompanion,
  durationSeconds: number,
): Partial<DialogueCompanion> | null {
  const params = paramsWithDuration(companion, durationSeconds);
  return params ? { params } as Partial<DialogueCompanion> : null;
}

function splitTimelineItem(
  item: SceneStatement | DialogueCompanion,
  startTime: number,
  splitTime: number,
): {
  firstParams: SceneStatement['params'] | DialogueCompanion['params'];
  secondParams: SceneStatement['params'] | DialogueCompanion['params'];
} | null {
  const durationSeconds = sourceDurationSeconds(item);
  if (durationSeconds === null) return null;
  const elapsed = roundTime(splitTime - startTime);
  const remaining = roundTime(durationSeconds - elapsed);
  if (elapsed <= 0 || remaining <= 0) return null;

  const firstParams = paramsWithDuration(item, elapsed);
  const secondParams = paramsWithDuration(item, remaining);
  if (!firstParams || !secondParams) return null;
  return { firstParams, secondParams };
}

function sourceDurationSeconds(item: SceneStatement | DialogueCompanion): number | null {
  if (item.type === 'characterPerformance') {
    const motion = item.params.motion;
    if (typeof motion === 'object' && motion.kind === 'custom') return motion.durationSeconds;
    return null;
  }
  const params = item.params as { durationSeconds?: unknown };
  return typeof params.durationSeconds === 'number' && Number.isFinite(params.durationSeconds)
    ? params.durationSeconds
    : null;
}

function applySourceParamPatch(
  currentParams: SceneStatement['params'] | DialogueCompanion['params'],
  sourceParamPatch: Readonly<Record<string, unknown>>,
): SceneStatement['params'] | DialogueCompanion['params'] | null {
  const entries = Object.entries(sourceParamPatch);
  if (entries.length === 0) return null;
  const params = cloneJson(currentParams) as Record<string, unknown>;
  for (const [key, value] of entries) {
    if (key === 'motion') {
      // The scene codec requires a discriminated union; a raw string from
      // legacy inspectors must be normalized into the resource branch.
      if (typeof value === 'string') {
        if (value.trim()) params[key] = { kind: 'resource', key: value.trim() };
        else delete params[key];
      } else if (value === undefined) {
        delete params[key];
      } else {
        params[key] = cloneJson(value);
      }
      continue;
    }
    if (value === undefined) delete params[key];
    else params[key] = cloneJson(value);
  }
  return params as SceneStatement['params'] | DialogueCompanion['params'];
}

function applyTimelineParamPatchToSourceParams(
  item: SceneStatement | DialogueCompanion,
  compiledAction: CompiledAction,
  timelineParamPatch: Readonly<Record<string, unknown>>,
): SceneStatement['params'] | DialogueCompanion['params'] | null {
  const params = cloneJson(item.params) as Record<string, unknown>;
  let changed = false;
  for (const [key, value] of Object.entries(timelineParamPatch)) {
    changed = applyTimelineParam(params, item, compiledAction, key, value) || changed;
  }
  return changed ? params as SceneStatement['params'] | DialogueCompanion['params'] : null;
}

function applyTimelineParam(
  params: Record<string, unknown>,
  item: SceneStatement | DialogueCompanion,
  compiledAction: CompiledAction,
  key: string,
  value: unknown,
): boolean {
  switch (item.type) {
    case 'dialogueVisibility':
      return setMappedParam(params, key === 'duration' ? 'durationSeconds' : key, value, ['visible', 'durationSeconds']);
    case 'dialogue':
      return setMappedParam(params, key === 'duration' ? 'durationSeconds' : key, value, [
        'speakerId',
        'speaker',
        'text',
        'durationSeconds',
        'voice',
        'style',
        'speakerColor',
        'textColor',
        'lipSync',
      ]);
    case 'characterPresence':
      return applyCharacterPresenceTimelineParam(params, key, value);
    case 'characterTransform':
      return setMappedParam(params, key === 'duration' ? 'durationSeconds' : key, value, [
        'id',
        'position',
        'scale',
        'rotation',
        'opacity',
        'z',
        'durationSeconds',
        'ease',
      ]);
    case 'characterPerformance':
      return applyCharacterPerformanceTimelineParam(params, compiledAction.source.outputKey, key, value);
    case 'camera':
      return applyCameraTimelineParam(params, compiledAction.action, key, value);
    case 'environmentLayer':
      return applyEnvironmentTimelineParam(params, key, value);
    case 'visualStyle':
      return applyVisualStyleTimelineParam(params, compiledAction.action, key, value);
    case 'filterAdd':
    case 'filterChange':
    case 'filterReset':
      return applyLensFilterTimelineParam(params, key, value);
    case 'lighting':
      return applyLightingTimelineParam(params, key, value);
    case 'audio':
      return applyAudioTimelineParam(params, key, value);
    case 'graphicLayer':
      return applyGraphicLayerTimelineParam(params, key, value);
    case 'customAnimation':
      return setMappedParam(params, key === 'duration' ? 'durationSeconds' : key, value, [
        'target',
        'file',
        'animation',
        'durationSeconds',
        'loop',
      ]);
    default:
      return false;
  }
}

function applyCharacterPresenceTimelineParam(params: Record<string, unknown>, key: string, value: unknown): boolean {
  const mappedKey = key === 'duration' || key === 'enterDuration' || key === 'exitDuration'
    ? 'durationSeconds'
    : key === 'enter' || key === 'exit'
      ? 'transition'
      : key === 'enterEase' || key === 'exitEase'
        ? 'ease'
        : key;
  return setMappedParam(params, mappedKey, value, [
    'id',
    'model',
    'variant',
    'position',
    'scale',
    'rotation',
    'opacity',
    'z',
    'transition',
    'durationSeconds',
    'ease',
  ]);
}

function applyCharacterPerformanceTimelineParam(
  params: Record<string, unknown>,
  outputKey: string,
  key: string,
  value: unknown,
): boolean {
  if (key === 'id') return setParam(params, 'target', value);
  if (key === 'target' && outputKey !== 'lookAt') return setParam(params, 'target', value);
  if (key === 'motion') {
    if (typeof value === 'string') {
      return value.trim() ? setParam(params, 'motion', { kind: 'resource', key: value.trim() }) : setParam(params, 'motion', undefined);
    }
    return setParam(params, 'motion', value);
  }
  if (key === 'expression') return setParam(params, 'expression', value);
  if (outputKey === 'lookAt' && (key === 'target' || key === 'point' || key === 'enabled' || key === 'intensity')) {
    return setNestedParam(params, 'lookAt', key, value);
  }
  if (outputKey === 'blink' && (key === 'enabled' || key === 'interval' || key === 'intervalRange')) {
    return setNestedParam(params, 'blink', key, value);
  }
  return false;
}

function applyCameraTimelineParam(
  params: Record<string, unknown>,
  action: CompiledAction['action'],
  key: string,
  value: unknown,
): boolean {
  if (key === 'duration') return setParam(params, 'durationSeconds', value);
  if (key === 'easing') return setParam(params, 'ease', value);
  if (key === 'angle' || key === 'rotation') return setParam(params, 'rotation', value);
  if (key === 'zoom') return setParam(params, 'zoom', parseTimelineZoom(value));

  if (action === 'cameraMotion') {
    if (key === 'target') return setParam(params, 'to', value);
    if (key !== 'focus') return false;

    const focus = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    if (typeof focus.character === 'string' && focus.character) {
      setParam(params, 'mode', 'focus');
      setParam(params, 'target', focus.character);
      if (typeof focus.part === 'string') setParam(params, 'targetPart', focus.part);
      return true;
    }
    if (Array.isArray(focus.point)) {
      setParam(params, 'mode', 'focus');
      setParam(params, 'position', focus.point);
      delete params.target;
      return true;
    }
    return false;
  }

  if (action === 'cameraPath') {
    return setMappedParam(params, key, value, ['keyframes', 'durationSeconds', 'ease', 'loop', 'repeat', 'yoyo']);
  }
  if (action === 'cameraShake') {
    return setMappedParam(params, key, value, ['intensity', 'frequency', 'durationSeconds', 'decay', 'direction']);
  }
  if (action === 'cameraHitchcock') {
    return setMappedParam(params, key === 'characterId' ? 'target' : key, value, [
      'target',
      'targetPart',
      'screenTarget',
      'zoomStart',
      'zoomEnd',
      'scaleStart',
      'scaleEnd',
      'durationSeconds',
      'ease',
    ]);
  }
  if (action === 'cameraFollow') {
    return setMappedParam(params, key === 'characterId' ? 'target' : key, value, ['target', 'offset', 'smoothing']);
  }
  if (action === 'cameraReset') {
    return setMappedParam(params, key, value, ['durationSeconds', 'ease']);
  }
  return false;
}

function applyEnvironmentTimelineParam(params: Record<string, unknown>, key: string, value: unknown): boolean {
  if (key === 'duration') return setParam(params, 'durationSeconds', value);
  if (key === 'x') return setVec2Axis(params, 0, value);
  if (key === 'y') return setVec2Axis(params, 1, value);
  return setMappedParam(params, key, value, [
    'layerId',
    'file',
    'image',
    'position',
    'scale',
    'rotation',
    'opacity',
    'z',
    'zIndex',
    'durationSeconds',
    'ease',
    'transition',
  ]);
}

function applyVisualStyleTimelineParam(
  params: Record<string, unknown>,
  action: CompiledAction['action'],
  key: string,
  value: unknown,
): boolean {
  if (key === 'mode') {
    return setParam(params, 'mode', value === 'envelope' ? 'modulate' : value === 'latching' ? 'set' : value);
  }
  const mappedKey = key === 'duration'
    ? 'durationSeconds'
    : key === 'targetId' || (action === 'setCharacterRimLight' && key === 'id')
      ? 'target'
      : key;
  return setMappedParam(params, mappedKey, value, [
    'target',
    'slot',
    'mode',
    'recipeId',
    'intensity',
    'brightness',
    'warmth',
    'bloom',
    'rgbSplit',
    'blend',
    'contamination',
    'colorStops',
    'colorBlendMode',
    'color',
    'thickness',
    'angle',
    'softness',
    'semanticOverride',
    'advancedOverride',
    'durationSeconds',
  ]);
}

function applyLensFilterTimelineParam(
  params: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  return setMappedParam(params, key === 'duration' ? 'durationSeconds' : key, value, [
    'fromRecipeId',
    'recipeId',
    'intensity',
    'warmth',
    'bloom',
    'rgbSplit',
    'blend',
    'contamination',
    'durationSeconds',
  ]);
}

function applyLightingTimelineParam(params: Record<string, unknown>, key: string, value: unknown): boolean {
  const sourceKey = key === 'duration' ? 'durationSeconds' : key;
  return setMappedParam(params, sourceKey, value, [
    'id',
    'target',
    'preset',
    'color',
    'blendMode',
    'x',
    'y',
    'radius',
    'intensity',
    'angle',
    'lacunarity',
    'bloomThreshold',
    'bloomBloomScale',
    'bloomBrightness',
    'rgbSplitX',
    'rgbSplitY',
    'godrayGain',
    'godrayLacunarity',
    'godrayAngle',
    'adjGamma',
    'adjContrast',
    'adjSaturation',
    'adjBrightness',
    'adjRed',
    'adjGreen',
    'adjBlue',
    'durationSeconds',
  ]);
}

function applyAudioTimelineParam(params: Record<string, unknown>, key: string, value: unknown): boolean {
  return setMappedParam(params, key === 'duration'
    ? 'durationSeconds'
    : key === 'id'
      ? 'instanceId'
      : key, value, [
      'file',
      'volume',
      'loop',
      'durationSeconds',
      'fadeIn',
      'fadeOut',
      'instanceId',
    ]);
}

function applyGraphicLayerTimelineParam(params: Record<string, unknown>, key: string, value: unknown): boolean {
  if (key === 'duration') return setParam(params, 'durationSeconds', value);
  if (key === 'image') return setParam(params, 'file', value);
  if (key === 'x') return setVec2Axis(params, 0, value);
  if (key === 'y') return setVec2Axis(params, 1, value);
  return setMappedParam(params, key, value, [
    'id',
    'file',
    'text',
    'position',
    'scale',
    'rotation',
    'opacity',
    'z',
    'zIndex',
    'durationSeconds',
    'ease',
    'fontFamily',
    'fontSize',
    'color',
    'style',
  ]);
}

function setMappedParam(
  params: Record<string, unknown>,
  sourceKey: string,
  value: unknown,
  allowedSourceKeys: readonly string[],
): boolean {
  if (!allowedSourceKeys.includes(sourceKey)) return false;
  return setParam(params, sourceKey, value);
}

function setNestedParam(
  params: Record<string, unknown>,
  parentKey: string,
  key: string,
  value: unknown,
): boolean {
  const nested = params[parentKey] && typeof params[parentKey] === 'object' && !Array.isArray(params[parentKey])
    ? { ...params[parentKey] as Record<string, unknown> }
    : {};
  if (value === undefined) delete nested[key];
  else nested[key] = cloneJson(value);
  if (Object.keys(nested).length === 0) delete params[parentKey];
  else params[parentKey] = nested;
  return true;
}

function setVec2Axis(params: Record<string, unknown>, axis: 0 | 1, value: unknown): boolean {
  if (typeof value !== 'number') return false;
  const current = Array.isArray(params.position) && params.position.length === 2
    ? [...params.position] as [unknown, unknown]
    : [0, 0] as [unknown, unknown];
  current[axis] = value;
  params.position = current;
  return true;
}

function setParam(params: Record<string, unknown>, key: string, value: unknown): boolean {
  if (value === undefined) delete params[key];
  else params[key] = cloneJson(value);
  return true;
}

function parseTimelineZoom(value: unknown): { kind: 'absolute' | 'delta'; value: number } | unknown {
  if (typeof value === 'number') return { kind: 'absolute', value };
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.startsWith('+=')) {
    const parsed = Number(trimmed.slice(2));
    return Number.isFinite(parsed) ? { kind: 'delta', value: parsed } : value;
  }
  if (trimmed.startsWith('-=')) {
    const parsed = Number(trimmed.slice(2));
    return Number.isFinite(parsed) ? { kind: 'delta', value: -parsed } : value;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? { kind: 'absolute', value: parsed } : value;
}

function retargetParams(
  item: SceneStatement | DialogueCompanion,
  charId: string,
  characterName: string | undefined,
): SceneStatement['params'] | DialogueCompanion['params'] | null {
  switch (item.type) {
    case 'dialogue':
      return {
        ...cloneJson(item.params),
        speakerId: charId,
        speaker: characterName || charId,
      };
    case 'characterPresence':
    case 'characterTransform':
      return {
        ...cloneJson(item.params),
        id: charId,
      };
    case 'characterPerformance':
      return {
        ...cloneJson(item.params),
        target: charId,
      };
    case 'visualStyle':
      if (item.params.scope !== 'object') return null;
      return {
        ...cloneJson(item.params),
        target: charId,
      };
    case 'filterAdd':
    case 'filterChange':
    case 'filterReset':
      return null;
    case 'customAnimation':
      return {
        ...cloneJson(item.params),
        target: charId,
      };
    default:
      return null;
  }
}

function paramsWithDuration(
  item: SceneStatement | DialogueCompanion,
  durationSeconds: number,
): SceneStatement['params'] | DialogueCompanion['params'] | null {
  const lifecycle = sceneStatementDefinitionRegistry.timelineLifecyclePresentation(item);
  if (lifecycle) {
    const durationField = lifecycle.definition.transitionDurationFields?.[lifecycle.boundary];
    if (!durationField) return null;
    return { ...cloneJson(item.params), [durationField]: durationSeconds } as SceneStatement['params'] | DialogueCompanion['params'];
  }

  switch (item.type) {
    case 'dialogue':
      if (durationSeconds <= 0) return null;
      return { ...cloneJson(item.params), durationSeconds };
    case 'characterPerformance': {
      if (typeof item.params.motion !== 'object' || item.params.motion.kind !== 'custom') return null;
      if (durationSeconds <= 0) return null;
      const params = cloneJson(item.params) as { motion: CharacterMotionOutput };
      const motion = params.motion as Extract<CharacterMotionOutput, { kind: 'custom' }>;
      params.motion = { ...motion, durationSeconds };
      return params as SceneStatement['params'] | DialogueCompanion['params'];
    }
    case 'dialogueVisibility':
    case 'characterPresence':
    case 'characterTransform':
    case 'environmentLayer':
    case 'visualStyle':
    case 'lighting':
    case 'graphicLayer':
    case 'filterAdd':
    case 'filterChange':
    case 'filterReset':
      return { ...cloneJson(item.params), durationSeconds };
    case 'camera':
      if (item.params.mode === 'follow') return null;
      return { ...cloneJson(item.params), durationSeconds };
    case 'audio':
      if (item.params.role !== 'sfx' || item.params.mode !== 'play') return null;
      return { ...cloneJson(item.params), durationSeconds };
    case 'customAnimation':
      if (durationSeconds <= 0) return null;
      return { ...cloneJson(item.params), durationSeconds };
    default:
      return null;
  }
}

function dedupeMoves(
  moves: ReadonlyArray<{ locator: SemanticAuthoringLocator; time: number }>,
): Array<{ locator: SemanticAuthoringLocator; time: number }> {
  const byLocator = new Map<string, { locator: SemanticAuthoringLocator; time: number }>();
  for (const move of moves) {
    byLocator.set(locatorKey(move.locator), move);
  }
  return [...byLocator.values()];
}

function locatorKey(locator: SemanticAuthoringLocator): string {
  return locator.kind === 'statement'
    ? `statement\u0000${locator.statementId}`
    : `companion\u0000${locator.statementId}\u0000${locator.companionId}`;
}

function roundTime(value: number): number {
  return Math.round(value * 10) / 10;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

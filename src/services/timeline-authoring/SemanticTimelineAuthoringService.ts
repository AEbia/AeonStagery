import {
  AUTHORING_SCHEMA_VERSION,
  type AuthoringScope,
  type AppendSequentialLinesAuthorIntent,
  type HistoryDescriptor,
  type InsertDialogueInChainAuthorIntent,
  type ResolvedAuthoringScope,
  type SemanticAuthoringLocator,
  type SemanticAuthorIntent,
  type SemanticAuthorReceipt,
} from '../../api/types/authoring';
import type { SceneMarker } from '../../api/types/scene-common';
import type {
  CharacterMotionOutput,
  DialogueCompanion,
  DialogueCompanionDraft,
  DialogueParams,
  ScenePaceTier,
  CurrentSceneDocument,
  SceneStatement,
  SceneStatementDraft,
} from '../../api/types/semantic-scene';
import {
  SceneStatementFactory,
  sceneDocumentCodec,
  sceneStatementDefinitionRegistry,
  sceneStatementFactory,
  type DialogueCompanionCreationDraft,
  type SceneStatementCreationDraft,
  type SceneStatementIdGenerator,
} from '../semantic-scene';
import { getSceneDocumentCanonicalOrder, withSceneDocumentCanonicalOrder } from '../semantic-scene/SceneDocumentCanonicalOrder';
import { createSemanticAuthorReceipt, type CompanionChange } from './SemanticAuthoringReceipt';
import {
  compileSequentialDialogueDrafts,
  computeTimelineEndSeconds,
  scenePaceTierOf,
} from '../sequential-flow/SequentialFlowAuthoring';
import {
  insertDialogueInChain as cascadeInsertDialogueInChain,
  applyDialogueFlowShift,
  deleteDialogueFlow,
  reorderDialogueFlow,
  reorderDialogueManual,
  insertDialogueFragmentFlow,
  moveDialogueFragmentFlow,
} from '../sequential-flow/DialogueFlowCascade';
import { resolveDialogueDuration, type DialogueTypewriterTiming } from '../pacing/pacing';

export type SemanticMarkerIdGenerator = (prefix: string) => string;

export interface SemanticTimelineAuthoringServiceOptions {
  statementIdGenerator?: SceneStatementIdGenerator;
  markerIdGenerator?: SemanticMarkerIdGenerator;
  factory?: SceneStatementFactory;
  getDialogueTypewriterTiming?: () => DialogueTypewriterTiming;
}

export interface SemanticTimelineAuthoringResult {
  document: CurrentSceneDocument;
  receipt: SemanticAuthorReceipt;
}

interface SemanticMutation {
  document: CurrentSceneDocument;
  createdStatements?: SceneStatement[];
  updatedStatements?: SceneStatement[];
  deletedStatements?: SceneStatement[];
  createdCompanions?: CompanionChange[];
  updatedCompanions?: CompanionChange[];
  deletedCompanions?: CompanionChange[];
  createdMarkers?: SceneMarker[];
  deletedMarkers?: SceneMarker[];
  timeRange?: {
    start: number;
    end: number;
  };
}

export class SemanticTimelineAuthoringService {
  private readonly factory: SceneStatementFactory;
  private readonly markerIdGenerator: SemanticMarkerIdGenerator;
  private readonly getDialogueTypewriterTiming?: () => DialogueTypewriterTiming;

  constructor(options: SemanticTimelineAuthoringServiceOptions = {}) {
    this.factory = options.factory ?? (options.statementIdGenerator
      ? new SceneStatementFactory({ idGenerator: options.statementIdGenerator })
      : sceneStatementFactory);
    this.markerIdGenerator = options.markerIdGenerator ?? defaultIdGenerator;
    this.getDialogueTypewriterTiming = options.getDialogueTypewriterTiming;
  }

  author(
    document: CurrentSceneDocument,
    intent: SemanticAuthorIntent,
    flowMode?: 'auto' | 'manual',
  ): SemanticTimelineAuthoringResult {
    if (intent.version !== AUTHORING_SCHEMA_VERSION) {
      throw new Error(`Unsupported semantic authoring schema version: ${intent.version}`);
    }

    const preservesAuthoredTiming = intent.origin === 'ai-script-panel' || intent.origin === 'raw-script';
    const flow = !preservesAuthoredTiming && (flowMode === 'auto'
      || (flowMode === undefined && 'flow' in intent && intent.flow === true));
    const mutation = this.applyIntent(document, intent, flow);
    return {
      document: mutation.document,
      receipt: createSemanticAuthorReceipt({
        correlationId: intent.correlationId,
        intentType: intent.kind,
        origin: intent.origin,
        historyDescriptor: buildHistoryDescriptor(intent, mutation),
        resolvedScope: resolveScope(intent.scope),
        createdStatements: mutation.createdStatements,
        updatedStatements: mutation.updatedStatements,
        deletedStatements: mutation.deletedStatements,
        createdCompanions: mutation.createdCompanions,
        updatedCompanions: mutation.updatedCompanions,
        deletedCompanions: mutation.deletedCompanions,
        createdMarkers: mutation.createdMarkers,
        deletedMarkers: mutation.deletedMarkers,
        timeRange: mutation.timeRange,
      }),
    };
  }

  private applyIntent(document: CurrentSceneDocument, intent: SemanticAuthorIntent, flow: boolean): SemanticMutation {
    switch (intent.kind) {
      case 'insert-statement': {
        const draft = cloneJson(intent.statement);
        if (draft.type === 'dialogue' && intent.origin !== 'ai-script-panel' && intent.origin !== 'raw-script') {
          const params = draft.params as DialogueParams;
          params.durationSeconds = resolveDialogueDuration({
            context: 'authoring-insert',
            text: params.text,
            authoredDurationSeconds: params.durationSeconds,
            typewriter: this.typewriterTiming(params),
          });
        }
        return this.insertStatement(document, {
          ...draft,
          time: roundTime(intent.anchorTime + (intent.statement.time ?? 0)),
        } as SceneStatementCreationDraft, intent.beforeStatementId, flow);
      }
      case 'insert-dialogue-companion':
        return this.insertDialogueCompanion(document, intent.parentStatementId, intent.companion);
      case 'update-dialogue-companion':
        return this.updateDialogueCompanion(document, intent.locator, intent.patch);
      case 'update-custom-motion-keyframes':
        return this.updateCustomMotionKeyframes(document, intent.locator, intent.motion);
      case 'delete-dialogue-companions':
        return this.deleteDialogueCompanions(document, intent.locators);
      case 'reorder-dialogue-companions':
        return this.reorderDialogueCompanions(document, intent.parentStatementId, intent.orderedCompanionIds);
      case 'update-statement':
        return this.updateStatement(document, intent.statementId, intent.patch, flow);
      case 'move-timeline-locators':
        return this.moveTimelineLocators(document, intent.moves, flow);
      case 'delete-statements':
        return this.deleteStatements(document, intent.statementIds, flow);
      case 'duplicate-statements':
        return this.duplicateStatements(document, intent.statementIds, flow);
      case 'add-marker':
        return this.addMarker(document, {
          time: intent.time,
          label: intent.label,
          color: intent.color,
          role: intent.role,
        });
      case 'remove-marker':
        return this.removeMarker(document, intent.markerId);
      case 'insert-script-segment':
        return this.insertScriptSegment(document, intent.anchorTime, intent.statements, intent.markers ?? [], intent.durationSeconds, flow);
      case 'append-sequential-lines':
        return this.appendSequentialLines(document, intent);
      case 'insert-dialogue-in-chain':
        return this.insertDialogueInChain(document, intent, flow);
      case 'update-scene-pace-tier':
        return this.updateScenePaceTier(document, intent.tier);
      case 'reorder-dialogue-chain':
        return this.reorderDialogueChain(
          document,
          intent.orderedDialogueIds,
          intent.movedStatementId,
          flow,
          intent.beforeStatementId,
        );
    }
  }

  private insertStatement(
    document: CurrentSceneDocument,
    draft: SceneStatementCreationDraft,
    beforeStatementId?: string,
    flow = false,
  ): SemanticMutation {
    const statement = this.factory.createStatement(
      draft,
      document.statements.map((candidate) => candidate.id),
    );
    const inserted = this.factory.insertStatement(document, statement as SceneStatementCreationDraft, {
      placement: 'time',
      ...(beforeStatementId ? { beforeStatementId } : {}),
    });
    const shifted = flow && statement.type === 'dialogue'
      ? insertDialogueFragmentFlow(document, inserted, [statement.id], scenePaceTierOf(document), beforeStatementId)
      : inserted;
    const next = shifted === inserted ? inserted : this.finalizeFlowDuration(shifted);
    const createdStatements = collectStatements(next, [statement.id]);
    const previousById = shifted === inserted
      ? undefined
      : new Map(document.statements.map((candidate) => [candidate.id, candidate]));
    const updatedStatements = previousById
      ? next.statements.filter((candidate) => {
          const previous = previousById.get(candidate.id);
          return previous !== undefined && previous.time !== candidate.time;
        })
      : [];
    return {
      document: next,
      createdStatements,
      updatedStatements,
      timeRange: statementTimeRange([...createdStatements, ...updatedStatements]),
    };
  }

  private insertDialogueCompanion(
    document: CurrentSceneDocument,
    parentStatementId: string,
    companion: DialogueCompanionDraft,
  ): SemanticMutation {
    const next = this.factory.appendDialogueCompanion(
      document,
      parentStatementId,
      companion as DialogueCompanionCreationDraft,
    );
    const beforeIds = new Set(
      document.statements.find((statement) => statement.id === parentStatementId)?.companions?.map((candidate) => candidate.id) ?? [],
    );
    const inserted = next.statements
      .find((statement) => statement.id === parentStatementId)
      ?.companions?.find((candidate) => !beforeIds.has(candidate.id));
    if (!inserted) {
      throw new Error(`Created companion is missing from statement "${parentStatementId}"`);
    }
    return {
      document: next,
      createdCompanions: [{ statementId: parentStatementId, companion: inserted }],
    };
  }

  private typewriterTiming(params: DialogueParams): DialogueTypewriterTiming | undefined {
    return (params.style ?? 'typewriter') === 'typewriter' ? this.getDialogueTypewriterTiming?.() : undefined;
  }

  private updateStatement(
    document: CurrentSceneDocument,
    statementId: string,
    patch: Partial<SceneStatement>,
    flow: boolean = false,
  ): SemanticMutation {
    const source = requireStatement(document, statementId);
    if (patch.id !== undefined && patch.id !== statementId) {
      throw new Error(`Cannot change statement id "${statementId}" to "${patch.id}"`);
    }
    if (patch.type !== undefined && patch.type !== source.type) {
      throw new Error(`Cannot change statement type "${source.type}" to "${patch.type}"`);
    }
    const patchParams = patch.params;
    const durationChanged = patchParams !== undefined
      && 'durationSeconds' in patchParams
      && patchParams.durationSeconds !== sourceDurationSeconds(source);
    const params = patchParams ? cloneJson(patchParams) : cloneJson(source.params);
    if (
      source.type === 'dialogue'
      && typeof (params as DialogueParams).text === 'string'
      && (params as DialogueParams).text !== (source.params as DialogueParams).text
    ) {
      (params as DialogueParams).durationSeconds = resolveDialogueDuration({
        context: 'authoring-update',
        text: (params as DialogueParams).text,
        pace: scenePaceTierOf(document),
        authoredDurationSeconds: (params as DialogueParams).durationSeconds,
        timeWasEdited: patch.time !== undefined,
        durationWasEdited: durationChanged,
        typewriter: this.typewriterTiming(params as DialogueParams),
      });
    }
    const updated = {
      ...source,
      ...cloneJson(patch),
      id: source.id,
      type: source.type,
      params,
    } as SceneStatement;
    if (flow && source.type === 'dialogue') {
      const shifted = applyDialogueFlowShift(document, statementId, updated, scenePaceTierOf(document));
      const originalById = new Map(
        document.statements.map((candidate) => [candidate.id, candidate]),
      );
      const updatedStatementIds = shifted.statements
        .filter((candidate) => candidate !== originalById.get(candidate.id))
        .map((candidate) => candidate.id);
      const next = this.finalizeFlowDuration(shifted);
      const updatedStatements = collectStatements(next, updatedStatementIds);
      return {
        document: next,
        updatedStatements,
        timeRange: statementTimeRange(updatedStatements),
      };
    }
    const next = this.factory.withExplicitDuration({
      ...document,
      statements: document.statements.map((statement) => statement.id === statementId ? updated : statement),
    }, document.meta.durationSeconds);
    return {
      document: next,
      updatedStatements: collectStatements(next, [statementId]),
      timeRange: statementTimeRange([updated]),
    };
  }

  private updateDialogueCompanion(
    document: CurrentSceneDocument,
    locator: { statementId: string; companionId: string },
    patch: Partial<DialogueCompanion>,
  ): SemanticMutation {
    const parent = requireStatement(document, locator.statementId);
    if (parent.type !== 'dialogue') {
      throw new Error(`Statement is not dialogue: ${locator.statementId}`);
    }
    const source = parent.companions?.find((candidate) => candidate.id === locator.companionId);
    if (!source) {
      throw new Error(`Companion not found: ${locator.statementId}/${locator.companionId}`);
    }
    if (patch.id !== undefined && patch.id !== source.id) {
      throw new Error(`Cannot change companion id "${source.id}" to "${patch.id}"`);
    }
    if (patch.type !== undefined && patch.type !== source.type && patch.params === undefined) {
      throw new Error('Changing companion type requires replacement params in the same intent');
    }
    const nextType = patch.type ?? source.type;
    const updated = {
      ...source,
      ...cloneJson(patch),
      id: source.id,
      type: nextType,
      params: patch.params
        ? cloneJson(patch.params)
        : cloneJson(source.params),
    } as DialogueCompanion;
    const next = this.factory.withExplicitDuration({
      ...document,
      statements: document.statements.map((statement) => statement.id === parent.id
        ? {
            ...statement,
            companions: statement.companions?.map((companion) => companion.id === source.id ? updated : companion),
          }
        : statement),
    }, document.meta.durationSeconds);
    return {
      document: next,
      updatedCompanions: [{ statementId: parent.id, companion: updated }],
    };
  }

  /**
   * Replace the motion output of a `characterPerformance` statement or
   * dialogue companion (ADR-0029 keyframe editing and resource-motion
   * conversion). The entity must already hold a motion whose identity matches
   * the replacement: a custom motion with the same `derivedFrom.key`, or a
   * resource motion whose `key` equals the replacement's `derivedFrom.key`.
   * Sibling outputs (Expression / LookAt / Blink) are preserved. Extending
   * the motion past `meta.durationSeconds` grows the scene duration
   * atomically.
   */
  private updateCustomMotionKeyframes(
    document: CurrentSceneDocument,
    locator: { statementId: string } | { statementId: string; companionId: string },
    motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
  ): SemanticMutation {
    let updatedStatements: SceneStatement[] | undefined;
    let updatedCompanions: CompanionChange[] | undefined;
    let endTime: number;

    if ('companionId' in locator) {
      const parent = requireStatement(document, locator.statementId);
      if (parent.type !== 'dialogue') {
        throw new Error(`Statement is not dialogue: ${locator.statementId}`);
      }
      const source = parent.companions?.find((candidate) => candidate.id === locator.companionId);
      if (!source) {
        throw new Error(`Companion not found: ${locator.statementId}/${locator.companionId}`);
      }
      requireReplaceableMotionSource(source, locator.statementId, locator.companionId, motion);
      const updated = {
        ...source,
        params: {
          ...cloneJson(source.params),
          motion: cloneJson(motion),
        },
      } as DialogueCompanion;
      endTime = parent.time + (source.anchor === 'end' ? sceneStatementDefinitionRegistry.temporalExtent(parent) : 0)
        + source.offset + motion.durationSeconds;
      const next = this.withExtendedSceneDuration({
        ...document,
        statements: document.statements.map((statement) => statement.id === parent.id
          ? {
              ...statement,
              companions: statement.companions?.map((companion) => companion.id === source.id ? updated : companion),
            }
          : statement),
      }, endTime);
      updatedCompanions = [{ statementId: parent.id, companion: updated }];
      return {
        document: next,
        updatedCompanions,
        timeRange: { start: parent.time + (source.anchor === 'end' ? sceneStatementDefinitionRegistry.temporalExtent(parent) : 0) + source.offset, end: endTime },
      };
    }

    const source = requireStatement(document, locator.statementId);
    requireReplaceableMotionSource(source, locator.statementId, undefined, motion);
    const updated = {
      ...source,
      params: {
        ...cloneJson(source.params),
        motion: cloneJson(motion),
      },
    } as SceneStatement;
    endTime = source.time + motion.durationSeconds;
    const next = this.withExtendedSceneDuration({
      ...document,
      statements: document.statements.map((statement) => statement.id === source.id ? updated : statement),
    }, endTime);
    updatedStatements = collectStatements(next, [source.id]);
    return {
      document: next,
      updatedStatements,
      timeRange: { start: source.time, end: endTime },
    };
  }

  /**
   * Grow `meta.durationSeconds` when the edited motion extends past the
   * current scene end. The stored value is rounded UP to 0.1s (never down,
   * otherwise keyframe times at the motion end would exceed the stored
   * duration and the codec would reject the document), and it is never
   * smaller than the computed scene end when `meta.durationSeconds` is
   * absent.
   */
  private withExtendedSceneDuration(
    document: CurrentSceneDocument,
    endTime: number,
  ): CurrentSceneDocument {
    const computedEnd = computedSceneEnd(document);
    const current = document.meta.durationSeconds ?? computedEnd;
    const target = roundUpTime(Math.max(endTime, computedEnd));
    if (target <= current) {
      return validateDocument(document);
    }
    return validateDocument({
      ...document,
      meta: {
        ...document.meta,
        durationSeconds: target,
      },
    });
  }

  private reorderDialogueCompanions(
    document: CurrentSceneDocument,
    parentStatementId: string,
    orderedCompanionIds: readonly string[],
  ): SemanticMutation {
    const parent = requireStatement(document, parentStatementId);
    if (parent.type !== 'dialogue') throw new Error(`Statement is not dialogue: ${parentStatementId}`);
    const companions = parent.companions ?? [];
    const currentIds = companions.map((companion) => companion.id);
    if (
      orderedCompanionIds.length !== currentIds.length
      || new Set(orderedCompanionIds).size !== orderedCompanionIds.length
      || currentIds.some((id) => !orderedCompanionIds.includes(id))
    ) {
      throw new Error(`Companion reorder must contain each current companion exactly once: ${parentStatementId}`);
    }
    const byId = new Map(companions.map((companion) => [companion.id, companion]));
    const reordered = orderedCompanionIds.map((id) => byId.get(id)!);
    const next = validateDocument({
      ...document,
      statements: document.statements.map((statement) => statement.id === parentStatementId
        ? { ...statement, companions: reordered }
        : statement),
    });
    return {
      document: next,
      updatedCompanions: reordered.map((companion) => ({ statementId: parentStatementId, companion })),
    };
  }

  private moveTimelineLocators(
    document: CurrentSceneDocument,
    moves: readonly { locator: SemanticAuthoringLocator; time: number }[],
    flow = false,
  ): SemanticMutation {
    if (moves.length === 0) {
      return { document };
    }

    const uniqueMoves = new Map<string, { locator: SemanticAuthoringLocator; time: number }>();
    for (const move of moves) {
      if (!Number.isFinite(move.time)) {
        throw new Error(`Invalid timeline move time: ${move.time}`);
      }
      const key = locatorKey(move.locator);
      uniqueMoves.set(key, {
        locator: cloneJson(move.locator),
        time: roundTime(Math.max(0, move.time)),
      });
    }

    for (const move of uniqueMoves.values()) {
      if (move.locator.kind === 'statement') {
        requireStatement(document, move.locator.statementId);
      } else {
        requireCompanion(document, move.locator);
      }
    }

    const movedRootIds = [...uniqueMoves.values()]
      .filter((move) => move.locator.kind === 'statement')
      .map((move) => move.locator.statementId);
    const firstMovedRoot = document.statements
      .filter((statement) => movedRootIds.includes(statement.id))
      .sort((a, b) => a.time - b.time)[0];
    const flowGroup = flow && movedRootIds.some((id) => requireStatement(document, id).type === 'dialogue');
    const flowDocument = flowGroup && firstMovedRoot
      ? moveDialogueFragmentFlow(
          document,
          movedRootIds,
          uniqueMoves.get(locatorKey({ kind: 'statement', statementId: firstMovedRoot.id }))!.time,
          scenePaceTierOf(document),
        )
      : document;
    const flowApplied = flowDocument !== document;
    let nextStatements = flowDocument.statements.map((statement) => {
      const move = uniqueMoves.get(locatorKey({ kind: 'statement', statementId: statement.id }));
      return move && !flowGroup
        ? ({ ...statement, time: move.time } as SceneStatement)
        : statement;
    });

    if ([...uniqueMoves.values()].some((move) => move.locator.kind === 'companion')) {
      nextStatements = nextStatements.map((statement) => {
        const companions = statement.companions?.map((companion) => {
          const move = uniqueMoves.get(locatorKey({
            kind: 'companion',
            statementId: statement.id,
            companionId: companion.id,
          }));
          if (!move) return companion;
          const baseTime = statement.time + (
            companion.anchor === 'end'
              ? sceneStatementDefinitionRegistry.temporalExtent(statement)
              : 0
          );
          return {
            ...companion,
            offset: roundTime(move.time - baseTime),
          } as DialogueCompanion;
        });
        return companions ? ({ ...statement, companions } as SceneStatement) : statement;
      });
    }

    // Moving a statement can move its temporal extent past the explicit scene
    // end. This is especially common for converted custom motions because the
    // conversion initially sets `meta.durationSeconds` to the motion's exact
    // end. Keep the move authorable by growing the scene duration before the
    // final validation instead of rejecting the user's drag.
    const movedDocument = flowApplied
      ? withSceneDocumentCanonicalOrder(
          { ...document, statements: nextStatements },
          nextStatements.map((statement) => statement.id),
        )
      : { ...document, statements: nextStatements };
    const next = flowApplied
      ? this.finalizeFlowDuration(movedDocument)
      : document.meta.durationSeconds === undefined
      ? validateDocument(movedDocument)
      : this.withExtendedSceneDuration(movedDocument, computedSceneEnd(movedDocument));
    const updatedStatementIds = new Set<string>();
    const updatedCompanions: CompanionChange[] = [];

    for (const move of uniqueMoves.values()) {
      if (move.locator.kind === 'statement') {
        updatedStatementIds.add(move.locator.statementId);
        continue;
      }
      const parent = requireStatement(next, move.locator.statementId);
      const companion = requireCompanion(next, move.locator);
      updatedCompanions.push({ statementId: parent.id, companion });
    }
    if (flowApplied) {
      const previousById = new Map(document.statements.map((statement) => [statement.id, statement]));
      for (const statement of next.statements) {
        if (statement.time !== previousById.get(statement.id)?.time) updatedStatementIds.add(statement.id);
      }
    }

    return {
      document: next,
      updatedStatements: collectStatements(next, [...updatedStatementIds]),
      updatedCompanions,
      timeRange: flowApplied
        ? statementTimeRange(collectStatements(next, [...updatedStatementIds]))
        : movedTimelineRange(next, uniqueMoves),
    };
  }

  private deleteDialogueCompanions(
    document: CurrentSceneDocument,
    locators: readonly { statementId: string; companionId: string }[],
  ): SemanticMutation {
    const uniqueLocators = new Map(locators.map((locator) => [
      `${locator.statementId}\u0000${locator.companionId}`,
      locator,
    ]));
    const deletedCompanions: CompanionChange[] = [];
    const byParent = new Map<string, Set<string>>();
    for (const locator of uniqueLocators.values()) {
      const parent = requireStatement(document, locator.statementId);
      const companion = parent.companions?.find((candidate) => candidate.id === locator.companionId);
      if (!companion) {
        throw new Error(`Companion not found: ${locator.statementId}/${locator.companionId}`);
      }
      deletedCompanions.push({ statementId: parent.id, companion });
      const ids = byParent.get(parent.id) ?? new Set<string>();
      ids.add(companion.id);
      byParent.set(parent.id, ids);
    }
    const next = validateDocument({
      ...document,
      statements: document.statements.map((statement) => {
        const deletedIds = byParent.get(statement.id);
        if (!deletedIds) return statement;
        return {
          ...statement,
          companions: statement.companions?.filter((companion) => !deletedIds.has(companion.id)),
        };
      }),
    });
    return { document: next, deletedCompanions };
  }

  /** 把显式场景时长收缩到当前语句末尾:删除等只减不增的变更后,避免残留陈旧结尾。 */
  private shrinkExplicitDuration(document: CurrentSceneDocument): CurrentSceneDocument {
    if (document.meta.durationSeconds === undefined) return document;
    const end = roundTime(this.factory.computeSceneEnd(document));
    return this.factory.withExplicitDuration(document, end === 0 ? undefined : end);
  }

  /** 自动重排后，场景结束点由当前语句末尾重新确定，不保留陈旧尾部时长。 */
  private finalizeFlowDuration(document: CurrentSceneDocument): CurrentSceneDocument {
    const end = roundTime(this.factory.computeSceneEnd(document));
    const finalized = end === 0 && document.meta.durationSeconds === undefined
      ? validateDocument(document)
      : this.factory.withExplicitDuration(document, end === 0 ? undefined : end);
    const order = getSceneDocumentCanonicalOrder(document);
    return order ? withSceneDocumentCanonicalOrder(finalized, order) : finalized;
  }

  private deleteStatements(
    document: CurrentSceneDocument,
    statementIds: readonly string[],
    flow: boolean = false,
  ): SemanticMutation {
    const uniqueIds = [...new Set(statementIds)];
    const deletedStatements = uniqueIds.map((statementId) => requireStatement(document, statementId));
    const deletedCompanions = deletedStatements.flatMap((statement) =>
      (statement.companions ?? []).map((companion) => ({ statementId: statement.id, companion })),
    );
    if (flow) {
      const dialogueIds = deletedStatements
        .filter((statement) => statement.type === 'dialogue')
        .map((statement) => statement.id);
      const nonDialogueIds = deletedStatements
        .filter((statement) => statement.type !== 'dialogue')
        .map((statement) => statement.id);
      let next = deleteDialogueFlow(document, dialogueIds, scenePaceTierOf(document));
      if (nonDialogueIds.length > 0) {
        const nonDialogueSet = new Set(nonDialogueIds);
        next = {
          ...next,
          statements: next.statements.filter((statement) => !nonDialogueSet.has(statement.id)),
        };
      }
      const originalById = new Map(
        document.statements.map((candidate) => [candidate.id, candidate]),
      );
      const shiftedStatements = next.statements.filter((statement) => (
        statement !== originalById.get(statement.id)
      ));
      const validated = this.shrinkExplicitDuration(next);
      return {
        document: validated,
        deletedStatements,
        updatedStatements: collectStatements(validated, shiftedStatements.map((statement) => statement.id)),
        deletedCompanions,
        timeRange: statementTimeRange([...deletedStatements, ...shiftedStatements]),
      };
    }
    const idSet = new Set(uniqueIds);
    const next = this.shrinkExplicitDuration(validateDocument({
      ...document,
      statements: document.statements.filter((statement) => !idSet.has(statement.id)),
    }));
    return {
      document: next,
      deletedStatements,
      deletedCompanions,
      timeRange: statementTimeRange(deletedStatements),
    };
  }

  private duplicateStatements(document: CurrentSceneDocument, statementIds: readonly string[], flow = false): SemanticMutation {
    let next = document;
    const beforeIds = new Set(document.statements.map((statement) => statement.id));
    for (const statementId of statementIds) {
      requireStatement(next, statementId);
      next = this.factory.duplicateStatement(next, statementId, { placement: 'time', timeOffsetSeconds: 1 });
    }
    const createdStatements = next.statements.filter((statement) => !beforeIds.has(statement.id));
    if (flow && createdStatements.some((statement) => statement.type === 'dialogue')) {
      next = this.finalizeFlowDuration(insertDialogueFragmentFlow(
        document, next, createdStatements.map((statement) => statement.id), scenePaceTierOf(document),
      ));
    }
    const previousById = new Map(document.statements.map((statement) => [statement.id, statement]));
    const updatedStatements = next.statements.filter((statement) =>
      previousById.has(statement.id) && statement.time !== previousById.get(statement.id)?.time);
    return {
      document: next,
      createdStatements: collectStatements(next, createdStatements.map((statement) => statement.id)),
      updatedStatements,
      timeRange: statementTimeRange([...createdStatements, ...updatedStatements]),
    };
  }

  private addMarker(
    document: CurrentSceneDocument,
    draft: Pick<SceneMarker, 'time' | 'label' | 'color' | 'role'>,
  ): SemanticMutation {
    const marker = this.createMarker(document.meta.markers ?? [], draft);
    const next = validateDocument({
      ...document,
      meta: {
        ...document.meta,
        markers: [
          ...(document.meta.markers ?? []),
          marker,
        ].sort(compareMarkers),
      },
    });
    return {
      document: next,
      createdMarkers: [marker],
    };
  }

  private removeMarker(document: CurrentSceneDocument, markerId: string): SemanticMutation {
    const marker = (document.meta.markers ?? []).find((candidate) => candidate.markerId === markerId);
    if (!marker) {
      throw new Error(`Marker not found: ${markerId}`);
    }
    const next = validateDocument({
      ...document,
      meta: {
        ...document.meta,
        markers: (document.meta.markers ?? []).filter((candidate) => candidate.markerId !== markerId),
      },
    });
    return {
      document: next,
      deletedMarkers: [marker],
    };
  }

  private insertScriptSegment(
    document: CurrentSceneDocument,
    anchorTime: number,
    statements: readonly SceneStatementDraft[],
    markers: ReadonlyArray<Pick<SceneMarker, 'label' | 'color' | 'role'> & { offset: number }>,
    durationSeconds: number | undefined,
    flow = false,
  ): SemanticMutation {
    let next = document;
    const createdStatementIds: string[] = [];
    for (const statement of statements) {
      const mutation = this.insertStatement(next, {
        ...statement,
        time: roundTime(anchorTime + (statement.time ?? 0)),
      } as SceneStatementCreationDraft);
      next = mutation.document;
      createdStatementIds.push(...(mutation.createdStatements ?? []).map((created) => created.id));
    }

    const createdBeforeFlow = collectStatements(next, createdStatementIds);
    const flowed = flow && createdBeforeFlow.some((statement) => statement.type === 'dialogue');
    if (flowed) {
      next = this.finalizeFlowDuration(insertDialogueFragmentFlow(
        document, next, createdStatementIds, scenePaceTierOf(document),
      ));
    }
    const flowOrder = flowed ? next.statements.map((statement) => statement.id) : undefined;
    const previousById = new Map(document.statements.map((statement) => [statement.id, statement]));
    const updatedStatements = next.statements.filter((statement) =>
      previousById.has(statement.id) && previousById.get(statement.id)?.time !== statement.time);

    const createdMarkers: SceneMarker[] = [];
    for (const marker of markers) {
      const mutation = this.addMarker(next, {
        ...marker,
        time: roundTime(anchorTime + marker.offset),
      });
      next = mutation.document;
      createdMarkers.push(...(mutation.createdMarkers ?? []));
    }

    const affectedRange = flowed
      ? statementTimeRange([...collectStatements(next, createdStatementIds), ...updatedStatements])
      : undefined;
    const authoredRange = durationSeconds === undefined
      ? undefined
      : { start: anchorTime, end: roundTime(anchorTime + durationSeconds) };
    const timeRange = authoredRange && affectedRange
      ? { start: Math.min(authoredRange.start, affectedRange.start), end: Math.max(authoredRange.end, affectedRange.end) }
      : authoredRange ?? affectedRange;
    if (timeRange) {
      next = this.withExtendedSceneDuration(next, timeRange.end);
    }
    if (flowOrder) next = withSceneDocumentCanonicalOrder(next, flowOrder);

    return {
      document: next,
      createdStatements: collectStatements(next, createdStatementIds),
      updatedStatements,
      createdMarkers,
      timeRange,
    };
  }

  private appendSequentialLines(
    document: CurrentSceneDocument,
    intent: AppendSequentialLinesAuthorIntent,
  ): SemanticMutation {
    const anchorTime = computeTimelineEndSeconds(document);
    const compiled = compileSequentialDialogueDrafts(
      intent.lines,
      intent.pace ?? scenePaceTierOf(document),
      this.getDialogueTypewriterTiming?.(),
    );
    if (compiled.statements.length === 0) {
      throw new Error('Sequential authoring requires at least one non-empty line');
    }

    let next = document;
    const createdStatementIds: string[] = [];
    for (const statement of compiled.statements) {
      const mutation = this.insertStatement(next, {
        ...statement,
        time: roundTime(anchorTime + (statement.time ?? 0)),
      } as SceneStatementCreationDraft);
      next = mutation.document;
      createdStatementIds.push(...(mutation.createdStatements ?? []).map((created) => created.id));
    }

    const end = roundTime(anchorTime + compiled.durationSeconds);
    next = this.factory.withExplicitDuration(next, Math.max(next.meta.durationSeconds ?? 0, end));

    return {
      document: next,
      createdStatements: collectStatements(next, createdStatementIds),
      timeRange: { start: anchorTime, end },
    };
  }

  private insertDialogueInChain(
    document: CurrentSceneDocument,
    intent: InsertDialogueInChainAuthorIntent,
    flow = false,
  ): SemanticMutation {
    const text = intent.text.trim();
    const tier = scenePaceTierOf(document);
    const statement = this.factory.createStatement(
      {
        type: 'dialogue',
        params: {
          text,
          durationSeconds: resolveDialogueDuration({
            context: 'pace-tier',
            text,
            pace: tier,
            typewriter: this.getDialogueTypewriterTiming?.(),
          }),
          style: 'typewriter',
          ...(intent.presentation ? { presentation: intent.presentation } : {}),
          ...(!intent.presentation && intent.template ? { template: intent.template } : {}),
        },
      },
      document.statements.map((candidate) => candidate.id),
    );
    const inserted = cascadeInsertDialogueInChain(
      document,
      statement,
      intent.beforeStatementId,
      tier,
      flow,
    );
    const originalById = new Map(
      document.statements.map((candidate) => [candidate.id, candidate]),
    );
    const updatedStatementIds = inserted.statements
      .filter((candidate) => (
        candidate !== originalById.get(candidate.id) && candidate.id !== statement.id
      ))
      .map((candidate) => candidate.id);
    const end = roundTime(this.factory.computeSceneEnd(inserted));
    const next = inserted.meta.durationSeconds === undefined && end === 0
      ? validateDocument(inserted)
      : this.factory.withExplicitDuration(inserted, Math.max(inserted.meta.durationSeconds ?? 0, end));
    return {
      document: next,
      createdStatements: collectStatements(next, [statement.id]),
      updatedStatements: collectStatements(next, updatedStatementIds),
      timeRange: statementTimeRange([
        statement,
        ...collectStatements(inserted, updatedStatementIds),
      ]),
    };
  }

  private updateScenePaceTier(document: CurrentSceneDocument, tier: ScenePaceTier): SemanticMutation {
    if (document.meta.paceTier === tier) return { document };
    return {
      document: validateDocument({
        ...document,
        meta: { ...document.meta, paceTier: tier },
      } as CurrentSceneDocument),
    };
  }

  private reorderDialogueChain(
    document: CurrentSceneDocument,
    orderedDialogueIds: readonly string[],
    movedStatementId?: string,
    flow: boolean = false,
    beforeStatementId?: string | null,
  ): SemanticMutation {
    const reordered = flow
      ? (() => {
          if (!movedStatementId) {
            throw new Error('Reorder-dialogue-chain flow requires movedStatementId');
          }
          return reorderDialogueFlow(document, orderedDialogueIds, movedStatementId, scenePaceTierOf(document), beforeStatementId);
        })()
      : reorderDialogueManual(document, orderedDialogueIds, movedStatementId ?? '', beforeStatementId);
    if (reordered === document) return { document };
    const originalById = new Map(
      document.statements.map((candidate) => [candidate.id, candidate]),
    );
    const updatedStatementIds = reordered.statements
      .filter((statement) => statement !== originalById.get(statement.id))
      .map((statement) => statement.id);
    const end = roundTime(this.factory.computeSceneEnd(reordered));
    const next = flow
      ? this.finalizeFlowDuration(reordered)
      : reordered.meta.durationSeconds === undefined && end === 0
        ? validateDocument(reordered)
        : this.factory.withExplicitDuration(reordered, Math.max(reordered.meta.durationSeconds ?? 0, end));
    const nextWithOrder = withSceneDocumentCanonicalOrder(
      next,
      reordered.statements.map((statement) => statement.id),
    );
    const updatedStatements = collectStatements(nextWithOrder, updatedStatementIds);
    return {
      document: nextWithOrder,
      updatedStatements,
      timeRange: statementTimeRange(updatedStatements),
    };
  }

  private createMarker(
    existingMarkers: readonly SceneMarker[],
    draft: Pick<SceneMarker, 'time' | 'label' | 'color' | 'role'>,
  ): SceneMarker {
    const usedIds = new Set(existingMarkers.map((marker) => marker.markerId));
    return {
      markerId: claimGeneratedId('marker', usedIds, this.markerIdGenerator),
      time: roundTime(draft.time),
      label: draft.label,
      ...(draft.color ? { color: draft.color } : {}),
      ...(draft.role ? { role: draft.role } : {}),
    };
  }
}

function buildHistoryDescriptor(intent: SemanticAuthorIntent, mutation: SemanticMutation): HistoryDescriptor {
  switch (intent.kind) {
    case 'insert-statement':
      return {
        key: 'timeline.author.insertStatement',
        args: { statementType: intent.statement.type },
        fallbackLabel: `插入语句: ${intent.statement.type}`,
      };
    case 'insert-dialogue-companion':
      return {
        key: 'timeline.author.insertCompanion',
        args: { statementId: intent.parentStatementId },
        fallbackLabel: '插入伴随语句',
      };
    case 'update-dialogue-companion':
      return {
        key: 'timeline.author.updateCompanion',
        args: { companionId: intent.locator.companionId },
        fallbackLabel: '更新伴随语句',
      };
    case 'update-custom-motion-keyframes':
      return {
        key: 'timeline.author.updateCustomMotionKeyframes',
        args: { statementId: intent.locator.statementId },
        fallbackLabel: '编辑自定义 Motion 关键帧',
      };
    case 'delete-dialogue-companions':
      return {
        key: 'timeline.author.deleteCompanions',
        args: { count: intent.locators.length },
        fallbackLabel: `删除 ${intent.locators.length} 个伴随语句`,
      };
    case 'reorder-dialogue-companions':
      return {
        key: 'timeline.author.reorderCompanions',
        args: { statementId: intent.parentStatementId, count: intent.orderedCompanionIds.length },
        fallbackLabel: '调整伴随语句顺序',
      };
    case 'update-statement':
      return {
        key: 'timeline.author.updateStatement',
        args: { statementId: intent.statementId },
        fallbackLabel: '更新语句',
      };
    case 'move-timeline-locators':
      return {
        key: 'timeline.author.moveTimelineLocators',
        args: { count: intent.moves.length },
        fallbackLabel: `移动 ${intent.moves.length} 个时间线语义项`,
      };
    case 'delete-statements':
      return {
        key: 'timeline.author.deleteStatements',
        args: { count: intent.statementIds.length },
        fallbackLabel: `删除 ${intent.statementIds.length} 个语句`,
      };
    case 'duplicate-statements':
      return {
        key: 'timeline.author.duplicateStatements',
        args: { count: intent.statementIds.length },
        fallbackLabel: `复制 ${intent.statementIds.length} 个语句`,
      };
    case 'add-marker':
      return {
        key: 'timeline.author.addMarker',
        args: { label: intent.label },
        fallbackLabel: `添加标记: ${intent.label}`,
      };
    case 'remove-marker':
      return {
        key: 'timeline.author.removeMarker',
        args: { markerId: intent.markerId },
        fallbackLabel: '删除标记',
      };
    case 'insert-script-segment':
      return {
        key: 'timeline.author.insertScriptSegment',
        args: { count: (mutation.createdStatements?.length ?? 0) + (mutation.createdMarkers?.length ?? 0) },
        fallbackLabel: 'AI 铺戏',
      };
    case 'append-sequential-lines':
      return {
        key: 'timeline.author.appendSequentialLines',
        args: { count: mutation.createdStatements?.length ?? 0 },
        fallbackLabel: '顺序铺排',
      };
    case 'insert-dialogue-in-chain':
      return {
        key: 'timeline.author.insertDialogueInChain',
        args: { beforeStatementId: intent.beforeStatementId ?? null },
        fallbackLabel: '插入对白',
      };
    case 'update-scene-pace-tier':
      return {
        key: 'timeline.author.updateScenePaceTier',
        args: { tier: intent.tier },
        fallbackLabel: `场景节奏档位: ${intent.tier}`,
      };
    case 'reorder-dialogue-chain':
      return {
        key: 'timeline.author.reorderDialogueChain',
        args: { count: intent.orderedDialogueIds.length },
        fallbackLabel: '调整对白顺序',
      };
  }
}

function resolveScope(scope: AuthoringScope | undefined): ResolvedAuthoringScope {
  if (!scope) return { kind: 'none' };
  if (scope.kind === 'none') return { kind: 'none' };
  if (scope.kind === 'character') return { kind: 'character', charId: scope.charId };
  return { kind: 'inferred-character', charId: scope.charId, source: scope.source };
}

function collectStatements(document: CurrentSceneDocument, statementIds: readonly string[]): SceneStatement[] {
  return statementIds.map((statementId) => requireStatement(document, statementId));
}

function requireStatement(document: CurrentSceneDocument, statementId: string): SceneStatement {
  const statement = document.statements.find((candidate) => candidate.id === statementId);
  if (!statement) {
    throw new Error(`Statement not found: ${statementId}`);
  }
  return statement;
}

function requireCompanion(
  document: CurrentSceneDocument,
  locator: { statementId: string; companionId: string },
): DialogueCompanion {
  const parent = requireStatement(document, locator.statementId);
  if (parent.type !== 'dialogue') {
    throw new Error(`Statement is not dialogue: ${locator.statementId}`);
  }
  const companion = parent.companions?.find((candidate) => candidate.id === locator.companionId);
  if (!companion) {
    throw new Error(`Companion not found: ${locator.statementId}/${locator.companionId}`);
  }
  return companion;
}

function sourceDurationSeconds(statement: SceneStatement): unknown {
  return (statement.params as { durationSeconds?: unknown }).durationSeconds;
}

/**
 * Identity guard for motion replacement (ADR-0029): the source entity must
 * already hold a motion of the same origin — a custom motion with the same
 * `derivedFrom.key` (keyframe edits), or a resource motion whose `key` equals
 * the replacement's `derivedFrom.key` (resource-motion conversion). This
 * prevents a stale authoring intent from overwriting a concurrently changed
 * motion source.
 */
function requireReplaceableMotionSource(
  source: Pick<SceneStatement, 'type' | 'params'>,
  statementId: string,
  companionId: string | undefined,
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
): void {
  const identity = companionId === undefined
    ? `statement "${statementId}"`
    : `companion "${statementId}/${companionId}"`;
  if (source.type !== 'characterPerformance') {
    throw new Error(`Cannot replace motion on non-characterPerformance ${identity}`);
  }
  const params = source.params as { motion?: CharacterMotionOutput };
  const current = params.motion;
  if (current === undefined) {
    throw new Error(`Cannot replace motion on ${identity}: params.motion is missing`);
  }
  if (current.kind === 'custom' && current.derivedFrom.key !== motion.derivedFrom.key) {
    throw new Error(
      `Cannot replace motion on ${identity}: derivedFrom.key mismatch (${current.derivedFrom.key} != ${motion.derivedFrom.key})`,
    );
  }
  if (current.kind === 'resource' && current.key !== motion.derivedFrom.key) {
    throw new Error(
      `Cannot replace motion on ${identity}: source motion key mismatch (${current.key} != ${motion.derivedFrom.key})`,
    );
  }
}

function validateDocument(document: CurrentSceneDocument): CurrentSceneDocument {
  return sceneDocumentCodec.parseAndValidate(document);
}

function statementTimeRange(statements: readonly SceneStatement[] | undefined): SemanticMutation['timeRange'] {
  if (!statements || statements.length === 0) return undefined;
  return {
    start: Math.min(...statements.map((statement) => statement.time)),
    end: Math.max(...statements.map((statement) =>
      statement.time + sceneStatementDefinitionRegistry.temporalExtent(statement),
    )),
  };
}

function movedTimelineRange(
  document: CurrentSceneDocument,
  moves: ReadonlyMap<string, { locator: SemanticAuthoringLocator; time: number }>,
): SemanticMutation['timeRange'] {
  const times: number[] = [];
  for (const move of moves.values()) {
    times.push(move.time);
    if (move.locator.kind === 'statement') {
      const statement = requireStatement(document, move.locator.statementId);
      times.push(statement.time + sceneStatementDefinitionRegistry.temporalExtent(statement));
    } else {
      const parent = requireStatement(document, move.locator.statementId);
      const companion = requireCompanion(document, move.locator);
      const companionTime = parent.time
        + (companion.anchor === 'end' ? sceneStatementDefinitionRegistry.temporalExtent(parent) : 0)
        + companion.offset;
      const companionAsStatement = {
        id: companion.id,
        time: companionTime,
        type: companion.type,
        params: companion.params,
      } as SceneStatement;
      times.push(companionTime + sceneStatementDefinitionRegistry.temporalExtent(companionAsStatement));
    }
  }
  if (times.length === 0) return undefined;
  return {
    start: Math.min(...times),
    end: Math.max(...times),
  };
}

function locatorKey(locator: SemanticAuthoringLocator): string {
  return locator.kind === 'statement'
    ? `statement\u0000${locator.statementId}`
    : `companion\u0000${locator.statementId}\u0000${locator.companionId}`;
}

function claimGeneratedId(
  prefix: string,
  usedIds: Set<string>,
  idGenerator: SemanticMarkerIdGenerator,
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

function compareMarkers(a: SceneMarker, b: SceneMarker): number {
  return a.time - b.time || a.markerId.localeCompare(b.markerId);
}

/**
 * Latest scene end computed from every statement and companion, mirroring the
 * codec invariant `meta.durationSeconds >= computed scene end`
 * (SceneDocumentCodec.validateDocumentInvariants).
 */
function computedSceneEnd(document: CurrentSceneDocument): number {
  let end = 0;
  for (const statement of document.statements) {
    end = Math.max(end, statement.time + sceneStatementDefinitionRegistry.temporalExtent(statement));
    for (const companion of statement.companions ?? []) {
      const companionTime = statement.time
        + (companion.anchor === 'end' ? sceneStatementDefinitionRegistry.temporalExtent(statement) : 0)
        + companion.offset;
      const companionAsStatement = {
        id: companion.id,
        time: companionTime,
        type: companion.type,
        params: companion.params,
      } as SceneStatement;
      end = Math.max(end, companionTime + sceneStatementDefinitionRegistry.temporalExtent(companionAsStatement));
    }
  }
  return end;
}

function roundTime(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundUpTime(value: number): number {
  return Math.ceil(value * 10) / 10;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

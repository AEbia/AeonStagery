import type { HistoryDescriptor, AuthoringWarning, CompanionLocator } from '../../api/types/authoring';
import type { LensStyleSlot, SegmentVisualRecord, SlotRecipeState } from '../../api/types/visual';
import {
  VISUAL_AUTHORING_SCHEMA_VERSION_V2,
  type SemanticVisualCompositionReceipt,
} from '../../api/types/visual-authoring';
import {
  DEFAULT_FILTER_ADD_DURATION_SECONDS,
  DEFAULT_FILTER_CHANGE_DURATION_SECONDS,
  DEFAULT_FILTER_RESET_DURATION_SECONDS,
  sceneDocumentCodec,
  sceneStatementFactory,
  type SceneStatementCreationDraft,
} from '../semantic-scene';
import type { SemanticAuthoringApplicationService } from '../timeline-authoring/SemanticAuthoringApplicationService';

export class SemanticVisualCompositionAuthoringService {
  constructor(private readonly authoring: SemanticAuthoringApplicationService) {}

  async removeVisualTargetAndRelatedCues(
    visualTargetId: string,
  ): Promise<SemanticVisualCompositionReceipt> {
    const document = this.authoring.getDocumentSnapshot();
    const deletedStatementIds: string[] = [];
    const deletedCompanionLocators: CompanionLocator[] = [];
    const statements = document.statements.flatMap((statement) => {
      if (isObjectVisualStyleForTarget(statement, visualTargetId)) {
        deletedStatementIds.push(statement.id);
        return [];
      }
      if (!statement.companions?.length) return [statement];
      const companions = statement.companions.filter((companion) => {
        if (!isObjectVisualStyleForTarget(companion, visualTargetId)) return true;
        deletedCompanionLocators.push({ statementId: statement.id, companionId: companion.id });
        return false;
      });
      return [{ ...statement, companions }];
    });

    const visualTargets = { ...(document.visual?.visualTargets ?? {}) };
    delete visualTargets[visualTargetId];
    const next = sceneDocumentCodec.parseAndValidate({
      ...document,
      visual: {
        ...(document.visual ?? {}),
        ...(Object.keys(visualTargets).length > 0 ? { visualTargets } : { visualTargets: undefined }),
      },
      statements,
    });
    await this.authoring.replaceDocument(next);
    return {
      version: VISUAL_AUTHORING_SCHEMA_VERSION_V2,
      historyDescriptor: historyDescriptor('removeVisualTargetAndRelatedCues', visualTargetId),
      warnings: [],
      affectedVisualTargetIds: [visualTargetId],
      affectedSegmentIds: [],
      createdStatementIds: [],
      deletedStatementIds,
      deletedCompanionLocators,
      deletedMarkerIds: [],
    };
  }

  async removeLensBoundaryMarkerAndRelatedSegments(
    markerId: string,
  ): Promise<SemanticVisualCompositionReceipt> {
    const document = this.authoring.getDocumentSnapshot();
    const marker = document.meta.markers?.find((candidate) => candidate.markerId === markerId);
    if (!marker) throw new Error(`Marker not found: ${markerId}`);
    if (marker.role !== 'lens-boundary') throw new Error(`Marker is not a lens-boundary: ${markerId}`);

    const segmentId = `segment:${markerId}`;
    const segment = document.visual?.segments?.[segmentId];
    const segments = { ...(document.visual?.segments ?? {}) };
    delete segments[segmentId];
    let next = sceneDocumentCodec.parseAndValidate({
      ...document,
      meta: {
        ...document.meta,
        markers: (document.meta.markers ?? []).filter((candidate) => candidate.markerId !== markerId),
      },
      visual: {
        ...(document.visual ?? {}),
        ...(Object.keys(segments).length > 0 ? { segments } : { segments: undefined }),
      },
    });
    const createdStatementIds: string[] = [];
    for (const draft of downgradeSegment(next, segment, marker.time)) {
      const statement = sceneStatementFactory.createStatement(
        draft,
        next.statements.map((candidate) => candidate.id),
      );
      createdStatementIds.push(statement.id);
      next = sceneStatementFactory.insertStatement(next, statement, { placement: 'time' });
    }

    next = sceneDocumentCodec.parseAndValidate({
      ...next,
      meta: next.meta,
      visual: next.visual,
    });
    await this.authoring.replaceDocument(next);

    const warnings: AuthoringWarning[] = segment?.lensEnvironmentOverride
      ? [{
          severity: 'warning',
          code: 'lens-environment-override-not-downgraded',
          message: `Lens boundary "${markerId}" has no statement representation for lensEnvironmentOverride.`,
        }]
      : [];
    return {
      version: VISUAL_AUTHORING_SCHEMA_VERSION_V2,
      historyDescriptor: historyDescriptor('removeLensBoundaryMarkerAndRelatedSegments', markerId),
      warnings,
      affectedVisualTargetIds: [],
      affectedSegmentIds: segment ? [segmentId] : [],
      createdStatementIds,
      deletedStatementIds: [],
      deletedCompanionLocators: [],
      deletedMarkerIds: [markerId],
    };
  }
}

function isObjectVisualStyleForTarget(
  statement: { type: string; params: unknown },
  targetId: string,
): boolean {
  if (statement.type !== 'visualStyle') return false;
  const params = statement.params as { scope?: string; target?: string };
  return params.scope === 'object' && params.target === targetId;
}

function downgradeSegment(
  document: ReturnType<SemanticAuthoringApplicationService['getDocumentSnapshot']>,
  segment: SegmentVisualRecord | undefined,
  time: number,
): SceneStatementCreationDraft[] {
  if (!segment) return [];
  const drafts: SceneStatementCreationDraft[] = [];
  const openingBaseline = document.visual?.segments?.['segment:opening']?.lensStyleBaseline ?? {};
  if (segment.lensStyleBaseline) {
    drafts.push({
      time,
      type: 'filterReset',
      params: { durationSeconds: DEFAULT_FILTER_RESET_DURATION_SECONDS },
    });
    for (const [category, state] of Object.entries(segment.lensStyleBaseline) as Array<[LensStyleSlot, SlotRecipeState]>) {
      if (!state?.recipeId) continue;
      const openingState = openingBaseline[category];
      if (openingState?.recipeId) {
        drafts.push({
          time,
          type: 'filterChange',
          params: {
            fromRecipeId: openingState.recipeId,
            recipeId: state.recipeId,
            durationSeconds: DEFAULT_FILTER_CHANGE_DURATION_SECONDS,
            ...filterOverrideParams(state),
          },
        });
      } else {
        drafts.push({
          time,
          type: 'filterAdd',
          params: {
            recipeId: state.recipeId,
            durationSeconds: DEFAULT_FILTER_ADD_DURATION_SECONDS,
            ...filterOverrideParams(state),
          },
        });
      }
    }
  }
  for (const [targetId, baseline] of Object.entries(segment.adjustedCompositeByTarget ?? {})) {
    for (const [slot, state] of Object.entries(baseline ?? {}) as Array<[string, SlotRecipeState]>) {
      if (!state?.recipeId) continue;
      drafts.push(objectVisualStyleDraft(time, targetId, slot, state));
    }
  }
  return drafts;
}

function objectVisualStyleDraft(
  time: number,
  target: string,
  slot: string,
  state: SlotRecipeState,
): SceneStatementCreationDraft {
  return {
    time,
    type: 'visualStyle',
    params: {
      scope: 'object',
      target,
      slot: slot === 'grounding' || slot === 'integration' || slot === 'accent' || slot === 'distortion'
        ? slot
        : 'integration',
      mode: 'set',
      recipeId: state.recipeId,
      ...(state.semanticOverride ? { semanticOverride: { ...state.semanticOverride } } : {}),
      ...(state.advancedOverride ? { advancedOverride: { ...state.advancedOverride } } : {}),
    },
  };
}

function filterOverrideParams(state: SlotRecipeState): Record<string, number> {
  const override = state.semanticOverride;
  if (!override) return {};
  const params: Record<string, number> = {};
  for (const key of ['intensity', 'warmth', 'bloom', 'rgbSplit', 'blend', 'contamination'] as const) {
    if (typeof override[key] === 'number' && Number.isFinite(override[key])) {
      params[key] = override[key];
    }
  }
  return params;
}

function historyDescriptor(
  kind: 'removeVisualTargetAndRelatedCues' | 'removeLensBoundaryMarkerAndRelatedSegments',
  id: string,
): HistoryDescriptor {
  return {
    key: `visualComposition.${kind}`,
    args: { id },
    fallbackLabel: kind === 'removeVisualTargetAndRelatedCues'
      ? 'Remove visual target and related statements'
      : 'Remove lens boundary and materialize segment styles',
  };
}

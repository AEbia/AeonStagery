import type { HistoryDescriptor, AuthoringWarning } from './authoring';
import type { CompanionLocator } from './authoring';
import type { SceneMarker } from './scene-common';
import type {
  StyleRecipeRecord,
  LensEnvironmentOverride,
  LensStyleBaseline,
  ObjectCompositeBaseline,
  SceneVisualBlock,
  SegmentId,
  SegmentVisualRecord,
  TargetEnvironmentOverride,
  VisualTargetId,
  VisualTargetRecord,
  VisualTargetType,
} from './visual';

export const VISUAL_AUTHORING_SCHEMA_VERSION = 1 as const;
export const VISUAL_AUTHORING_SCHEMA_VERSION_V2 = 2 as const;

export type VisualAuthoringOrigin =
  | 'visual-inspector'
  | 'timeline-editor'
  | 'scene-bootstrap'
  | 'system-sync';

interface BaseVisualAuthorIntent {
  version: typeof VISUAL_AUTHORING_SCHEMA_VERSION;
  correlationId: string;
  origin: VisualAuthoringOrigin;
}

export interface UpsertVisualTargetIntent extends BaseVisualAuthorIntent {
  kind: 'upsert-visual-target';
  visualTargetId: VisualTargetId;
  targetType: VisualTargetType;
  initial?: {
    objectCompositeBaseline?: ObjectCompositeBaseline;
    targetEnvironmentOverride?: TargetEnvironmentOverride;
  };
}

export interface RemoveVisualTargetIntent extends BaseVisualAuthorIntent {
  kind: 'remove-visual-target';
  visualTargetId: VisualTargetId;
}

export interface SetLensStyleBaselineIntent extends BaseVisualAuthorIntent {
  kind: 'set-lens-style-baseline';
  segmentId: SegmentId;
  baseline?: LensStyleBaseline;
}

export interface SetObjectCompositeBaselineIntent extends BaseVisualAuthorIntent {
  kind: 'set-object-composite-baseline';
  visualTargetId: VisualTargetId;
  baseline?: ObjectCompositeBaseline;
}

export interface SetLensEnvironmentOverrideIntent extends BaseVisualAuthorIntent {
  kind: 'set-lens-environment-override';
  segmentId: SegmentId;
  override?: LensEnvironmentOverride;
}

export interface RemoveSegmentRecordIntent extends BaseVisualAuthorIntent {
  kind: 'remove-segment-record';
  segmentId: SegmentId;
}

export interface SetTargetEnvironmentOverrideIntent extends BaseVisualAuthorIntent {
  kind: 'set-target-environment-override';
  visualTargetId: VisualTargetId;
  override?: TargetEnvironmentOverride;
}

export interface UpsertSceneRecipeIntent extends BaseVisualAuthorIntent {
  kind: 'upsert-scene-recipe';
  recipeId: VisualTargetId;
  recipe: StyleRecipeRecord;
}

export interface RemoveSceneRecipeIntent extends BaseVisualAuthorIntent {
  kind: 'remove-scene-recipe';
  recipeId: VisualTargetId;
}

export type VisualAuthorIntent =
  | UpsertVisualTargetIntent
  | RemoveVisualTargetIntent
  | SetLensStyleBaselineIntent
  | SetObjectCompositeBaselineIntent
  | SetLensEnvironmentOverrideIntent
  | RemoveSegmentRecordIntent
  | SetTargetEnvironmentOverrideIntent
  | UpsertSceneRecipeIntent
  | RemoveSceneRecipeIntent;

export interface VisualAuthorReceipt {
  version: typeof VISUAL_AUTHORING_SCHEMA_VERSION;
  correlationId: string;
  intentType: VisualAuthorIntent['kind'];
  origin: VisualAuthoringOrigin;
  historyDescriptor: HistoryDescriptor;
  warnings: AuthoringWarning[];
  affectedVisualTargetIds: VisualTargetId[];
  affectedSegmentIds: SegmentId[];
  affectedVisualFields: Array<
    | 'visual-target'
    | 'object-composite-baseline'
    | 'target-environment-override'
    | 'lens-style-baseline'
    | 'lens-environment-override'
    | 'scene-recipe-overlay'
  >;
  syncedChanges: Array<
    | 'created-visual-target-record'
    | 'removed-visual-target-record'
    | 'created-segment-record'
    | 'removed-empty-segment-record'
    | 'created-scene-recipe-record'
    | 'removed-scene-recipe-record'
  >;
  nextVisual?: SceneVisualBlock;
}

export interface VisualCompositionReceipt {
  historyDescriptor: HistoryDescriptor;
  warnings: AuthoringWarning[];
  affectedVisualTargetIds: VisualTargetId[];
  affectedSegmentIds: SegmentId[];
  visualReceipt?: VisualAuthorReceipt;
  timelineReceipt?: {
    createdActionIds: string[];
    updatedActionIds: string[];
    deletedActionIds: string[];
    createdMarkerIds: string[];
    deletedMarkerIds: string[];
    createdMarkers: SceneMarker[];
    deletedMarkers: SceneMarker[];
  };
}

export interface SemanticVisualCompositionReceipt {
  version: typeof VISUAL_AUTHORING_SCHEMA_VERSION_V2;
  historyDescriptor: HistoryDescriptor;
  warnings: AuthoringWarning[];
  affectedVisualTargetIds: VisualTargetId[];
  affectedSegmentIds: SegmentId[];
  createdStatementIds: string[];
  deletedStatementIds: string[];
  deletedCompanionLocators: CompanionLocator[];
  deletedMarkerIds: string[];
}

export type MutableVisualTargetRecord = VisualTargetRecord;
export type MutableSegmentVisualRecord = SegmentVisualRecord;

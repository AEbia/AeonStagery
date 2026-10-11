import type {
  CameraPathKeyframe,
  FilterAddParams,
  FilterChangeParams,
  FilterResetParams,
  StatementCategory,
  StatementFamily,
  StatementParamsByFamily,
} from '../../api/types/semantic-scene';
import type { ResourceImportKind, ResourceKind } from '../../api/types/project';

export interface AssetReferenceField {
  readonly path: string;
  readonly value: string;
  readonly kind: ResourceImportKind;
  readonly resourceKind: ResourceKind;
}

export interface CompiledAssetSlotDefinition {
  readonly outputKey: string;
  readonly path: string;
  readonly kind: ResourceImportKind;
}

export interface SourceAssetSlotDefinition {
  readonly path: string;
  readonly kind: ResourceImportKind;
  readonly resourceKind: ResourceKind;
}

export interface SceneStatementTimelinePresentation {
  readonly label: string;
  readonly iconKey: string;
}

/**
 * Metadata consumed by the renderer-agnostic semantic patch seam. Technical
 * identity is structural metadata, not a convention based on field names:
 * params.id and other domain keys remain visible to an agent.
 */
export interface SceneStatementPatchMetadata {
  readonly hiddenTechnicalIdentityPaths?: readonly string[];
  readonly statementForbiddenPatchPaths?: readonly string[];
  readonly companionForbiddenPatchPaths?: readonly string[];
}

export type TimelineStateSpanPresentationPreference = 'auto' | 'endpoint' | 'span';

export interface TimelineStateSpanTargetRule {
  readonly namespace: string;
  readonly fields: readonly string[];
  readonly optionalFields?: readonly string[];
}

export interface SceneStatementLifecyclePresentation<Family extends StatementFamily = StatementFamily> {
  readonly variant: string;
  readonly presentationTypeKey: `${Family}:${string}`;
  readonly when?: Readonly<Record<string, string>>;
  readonly operationField: string;
  readonly startOperations: readonly string[];
  readonly endOperations: readonly string[];
  readonly target: TimelineStateSpanTargetRule;
  readonly transitionDurationFields?: {
    readonly start?: string;
    readonly end?: string;
  };
  readonly configurable: true;
  readonly settingsLabel: string;
  readonly settingsGroup: string;
  readonly settingsOrder: number;
  readonly defaultPreference: TimelineStateSpanPresentationPreference;
}

export interface RegisteredSceneStatementLifecyclePresentation extends SceneStatementLifecyclePresentation {
  readonly family: StatementFamily;
}

export interface ResolvedSceneStatementLifecyclePresentation {
  readonly definition: RegisteredSceneStatementLifecyclePresentation;
  readonly boundary: 'start' | 'end';
  readonly stateKey: string;
  readonly transitionDurationSeconds: number;
}

export interface SceneStatementStateSpanDependency {
  readonly presentationTypeKey: string;
  readonly when?: Readonly<Record<string, string>>;
  readonly operationField?: string;
  readonly operations?: readonly string[];
  readonly target: TimelineStateSpanTargetRule;
  readonly inheritFields?: readonly string[];
}

export interface ResolvedSceneStatementStateSpanDependency {
  readonly presentationTypeKey: string;
  readonly stateKey: string;
}

export interface SceneStatementDefinition<Family extends StatementFamily = StatementFamily> {
  readonly family: Family;
  /** Omitted for families present in the historical scene v4 contract. */
  readonly minimumSceneSchemaVersion?: 5;
  readonly category: StatementCategory;
  readonly label: string;
  readonly discriminators: readonly string[];
  readonly attachableTo?: readonly StatementFamily[];
  parseParams(input: unknown, path: string): StatementParamsByFamily[Family];
  temporalExtent(params: StatementParamsByFamily[Family]): number;
  collectAssetReferences(params: StatementParamsByFamily[Family]): readonly AssetReferenceField[];
  readonly compiledAssetSlots?: readonly CompiledAssetSlotDefinition[];
  readonly sourceAssetSlots?: readonly SourceAssetSlotDefinition[];
  readonly patchMetadata?: SceneStatementPatchMetadata;
  timelinePresentation(params: StatementParamsByFamily[Family]): SceneStatementTimelinePresentation;
  readonly lifecyclePresentations?: readonly SceneStatementLifecyclePresentation<Family>[];
  readonly stateSpanDependencies?: readonly SceneStatementStateSpanDependency[];
  isAttachable?(params: StatementParamsByFamily[Family], parentFamily: StatementFamily): boolean;
}

export const DEFAULT_CHARACTER_ENTER_TRANSITION = 'fadeIn';
export const DEFAULT_CHARACTER_EXIT_TRANSITION = 'fadeOut';
export const DEFAULT_CHARACTER_PRESENCE_TRANSITION_SECONDS = 0.6;
export const DEFAULT_ENVIRONMENT_SET_TRANSITION = 'crossFade';
export const DEFAULT_ENVIRONMENT_REMOVE_TRANSITION = 'fadeOut';
export const DEFAULT_ENVIRONMENT_SET_DURATION_SECONDS = 1;
export const DEFAULT_ENVIRONMENT_TRANSFORM_DURATION_SECONDS = 1;
export const DEFAULT_ENVIRONMENT_REMOVE_DURATION_SECONDS = 0.6;
export const DEFAULT_AUDIO_BGM_FADE_IN_SECONDS = 0.5;
export const DEFAULT_AUDIO_STOP_FADE_OUT_SECONDS = 0.5;
export const DEFAULT_FILTER_ADD_DURATION_SECONDS = 0.6;
export const DEFAULT_FILTER_CHANGE_DURATION_SECONDS = 0.6;
export const DEFAULT_FILTER_RESET_DURATION_SECONDS = 0.4;

export function resolveFilterTransitionDuration(
  params: FilterAddParams | FilterChangeParams | FilterResetParams,
): number {
  if (params.durationSeconds !== undefined) return params.durationSeconds;
  if ('fromRecipeId' in params) return DEFAULT_FILTER_CHANGE_DURATION_SECONDS;
  if ('recipeId' in params) return DEFAULT_FILTER_ADD_DURATION_SECONDS;
  return DEFAULT_FILTER_RESET_DURATION_SECONDS;
}

export type SceneStatementDefinitionMap = {
  readonly [Family in StatementFamily]: SceneStatementDefinition<Family>;
};

/**
 * Camera paths are authored in source space. Keep the editor fallback next to
 * the strict parser that enforces the same minimum cardinality, so a newly
 * created/editing path cannot temporarily become a one-keyframe statement.
 */
export const DEFAULT_CAMERA_PATH_KEYFRAMES: readonly CameraPathKeyframe[] = Object.freeze([
  Object.freeze({ time: 0, position: Object.freeze([0.5, 0.5]) as [number, number] }),
  Object.freeze({ time: 1, position: Object.freeze([0.5, 0.5]) as [number, number] }),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize an authoring value without discarding fields authored on valid
 * keyframes. One-keyframe values receive a cloned endpoint; empty/invalid
 * values receive the schema-safe neutral path.
 */
export function ensureCameraPathKeyframes(value: unknown): CameraPathKeyframe[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = undefined;
    }
  }

  const authored = Array.isArray(parsed)
    ? parsed
      .filter(isRecord)
      .map((keyframe) => ({
        ...keyframe,
        ...(Array.isArray(keyframe.position) ? { position: [...keyframe.position] } : {}),
      })) as CameraPathKeyframe[]
    : [];

  if (authored.length >= 2) return authored;
  if (authored.length === 1) {
    const first = authored[0];
    const firstTime = typeof first.time === 'number' && Number.isFinite(first.time) ? first.time : 0;
    return [
      first,
      {
        ...first,
        time: Math.max(1, firstTime + 1),
        ...(Array.isArray(first.position)
          ? { position: [...first.position] as [number, number] }
          : { position: [0.5, 0.5] as [number, number] }),
      },
    ];
  }

  return DEFAULT_CAMERA_PATH_KEYFRAMES.map((keyframe) => ({
    ...keyframe,
    position: [...(keyframe.position ?? [0.5, 0.5])] as [number, number],
  }));
}

import type {
  AudioParams,
  SceneStatement,
  SceneStatementDraft,
  StatementFamily,
  StatementParamsByFamily,
} from '../../api/types/semantic-scene';
import {
  UnknownSceneDiscriminatorError,
} from './SceneDocumentContractErrors';
import type {
  CompiledAssetSlotDefinition,
  RegisteredSceneStatementLifecyclePresentation,
  ResolvedSceneStatementLifecyclePresentation,
  ResolvedSceneStatementStateSpanDependency,
  SceneStatementDefinition,
  SceneStatementDefinitionMap,
  SceneStatementPatchMetadata,
  SceneStatementTimelinePresentation,
  SourceAssetSlotDefinition,
  TimelineStateSpanTargetRule,
  AssetReferenceField,
} from './SceneStatementDefinitionTypes';
import {
  resolveLifecycleTransitionDuration,
  SCENE_STATEMENT_DEFINITIONS,
  SCENE_STATEMENT_PATCH_METADATA,
} from './SceneStatementDefinitionCatalog';

// Compatibility marker: the definition interface includes timelinePresentation(params, path).

export {
  DEFAULT_AUDIO_BGM_FADE_IN_SECONDS,
  DEFAULT_AUDIO_STOP_FADE_OUT_SECONDS,
  DEFAULT_CHARACTER_ENTER_TRANSITION,
  DEFAULT_CHARACTER_EXIT_TRANSITION,
  DEFAULT_CHARACTER_PRESENCE_TRANSITION_SECONDS,
  DEFAULT_ENVIRONMENT_REMOVE_DURATION_SECONDS,
  DEFAULT_ENVIRONMENT_REMOVE_TRANSITION,
  DEFAULT_ENVIRONMENT_SET_DURATION_SECONDS,
  DEFAULT_ENVIRONMENT_SET_TRANSITION,
  DEFAULT_ENVIRONMENT_TRANSFORM_DURATION_SECONDS,
  DEFAULT_FILTER_ADD_DURATION_SECONDS,
  DEFAULT_FILTER_CHANGE_DURATION_SECONDS,
  DEFAULT_FILTER_RESET_DURATION_SECONDS,
  DEFAULT_CAMERA_PATH_KEYFRAMES,
  ensureCameraPathKeyframes,
  resolveFilterTransitionDuration,
} from './SceneStatementDefinitionTypes';
export {
  parseDialogueImagePresentation,
} from './SceneStatementParamParsers';
export {
  isCharacterPerformancePlaceholderCompanion,
  isCharacterPerformancePlaceholderParams,
  resolveAudioFadeIn,
  resolveAudioFadeOut,
  resolveCharacterPresenceTransition,
  resolveCharacterPresenceTransitionDuration,
  resolveEnvironmentLayerDuration,
  resolveEnvironmentLayerTransition,
  SCENE_STATEMENT_DEFINITIONS,
  SCENE_STATEMENT_PATCH_METADATA,
} from './SceneStatementDefinitionCatalog';
export type {
  AssetReferenceField,
  CompiledAssetSlotDefinition,
  RegisteredSceneStatementLifecyclePresentation,
  ResolvedSceneStatementLifecyclePresentation,
  ResolvedSceneStatementStateSpanDependency,
  SceneStatementDefinition,
  SceneStatementDefinitionMap,
  SceneStatementLifecyclePresentation,
  SceneStatementPatchMetadata,
  SceneStatementStateSpanDependency,
  SceneStatementTimelinePresentation,
  SourceAssetSlotDefinition,
  TimelineStateSpanPresentationPreference,
  TimelineStateSpanTargetRule,
} from './SceneStatementDefinitionTypes';

export class SceneStatementDefinitionRegistry {
  private readonly definitions: SceneStatementDefinitionMap;

  constructor(definitionMap: SceneStatementDefinitionMap = SCENE_STATEMENT_DEFINITIONS) {
    this.definitions = definitionMap;
  }

  get<Family extends StatementFamily>(family: Family): SceneStatementDefinition<Family> {
    return this.definitions[family];
  }

  patchMetadata(family: StatementFamily): SceneStatementPatchMetadata {
    return this.get(family).patchMetadata ?? SCENE_STATEMENT_PATCH_METADATA[family];
  }

  has(family: string): family is StatementFamily {
    return Object.prototype.hasOwnProperty.call(this.definitions, family);
  }

  assertSupportedInSchema(family: StatementFamily, schemaVersion: number, path: string): void {
    const minimum = this.get(family).minimumSceneSchemaVersion ?? 4;
    if (schemaVersion < minimum) {
      throw new UnknownSceneDiscriminatorError(
        path,
        family,
        undefined,
        `Statement family ${family} requires scene schemaVersion ${minimum} at ${path}`,
      );
    }
  }

  list(): readonly SceneStatementDefinition[] {
    return Object.freeze(Object.values(this.definitions));
  }

  listLifecyclePresentations(): readonly RegisteredSceneStatementLifecyclePresentation[] {
    const entries = Object.values(this.definitions).flatMap((definition) => (
      (definition.lifecyclePresentations ?? []).map((presentation) => ({
        ...presentation,
        family: definition.family,
      } as RegisteredSceneStatementLifecyclePresentation))
    ));
    const keys = new Set<string>();
    for (const entry of entries) {
      if (keys.has(entry.presentationTypeKey)) {
        throw new Error(`Duplicate lifecycle presentation type: ${entry.presentationTypeKey}`);
      }
      if (!entry.presentationTypeKey.startsWith(`${entry.family}:`)) {
        throw new Error(`Lifecycle presentation type must use its family prefix: ${entry.presentationTypeKey}`);
      }
      if (entry.startOperations.length === 0 || entry.endOperations.length === 0) {
        throw new Error(`Lifecycle presentation must declare both boundaries: ${entry.presentationTypeKey}`);
      }
      if (entry.startOperations.some((operation) => entry.endOperations.includes(operation))) {
        throw new Error(`Lifecycle presentation boundaries overlap: ${entry.presentationTypeKey}`);
      }
      const targetFields = [...entry.target.fields, ...(entry.target.optionalFields ?? [])];
      if (new Set(targetFields).size !== targetFields.length) {
        throw new Error(`Lifecycle presentation target fields must be unique: ${entry.presentationTypeKey}`);
      }
      keys.add(entry.presentationTypeKey);
    }
    return Object.freeze(entries.sort((left, right) => left.settingsOrder - right.settingsOrder));
  }

  parseParams<Family extends StatementFamily>(
    family: Family,
    input: unknown,
    path: string,
  ): StatementParamsByFamily[Family] {
    return this.get(family).parseParams(input, path);
  }

  temporalExtent(statement: SceneStatement): number {
    const definition = this.get(statement.type);
    return definition.temporalExtent(statement.params as never);
  }

  collectAssetReferences(statement: SceneStatement): readonly AssetReferenceField[] {
    const definition = this.get(statement.type);
    return definition.collectAssetReferences(statement.params as never);
  }

  compiledAssetSlots(
    statement: Pick<SceneStatement, 'type'>,
    outputKey: string,
  ): readonly CompiledAssetSlotDefinition[] {
    return (this.get(statement.type).compiledAssetSlots ?? []).filter((slot) => slot.outputKey === outputKey);
  }

  sourceAssetSlot(
    statement: Pick<SceneStatement, 'type' | 'params'>,
    path: string,
  ): SourceAssetSlotDefinition | undefined {
    const slot = this.sourceAssetSlots(statement).find((candidate) => candidate.path === path);
    if (!slot) return undefined;
    if (statement.type === 'audio' && path === 'params.file') {
      const params = statement.params as AudioParams;
      return params.role === 'sfx'
        ? { path, kind: 'generic', resourceKind: 'sfx' }
        : slot;
    }
    return slot;
  }

  sourceAssetSlots(
    statement: Pick<SceneStatement, 'type' | 'params'>,
  ): readonly SourceAssetSlotDefinition[] {
    const slots = this.get(statement.type).sourceAssetSlots ?? [];
    const params = statement.params as unknown as Record<string, unknown>;
    if (statement.type === 'characterPresence' && params.mode !== 'enter') return [];
    if (statement.type === 'environmentLayer') {
      if (params.mode !== 'set') return [];
      const preferredPath = typeof params.file === 'string' && !params.image ? 'params.file' : 'params.image';
      return slots.filter((slot) => slot.path === preferredPath);
    }
    if (statement.type === 'audio' && params.mode !== 'play') return [];
    if (statement.type === 'graphicLayer' && (params.kind !== 'image' || params.mode !== 'set')) return [];
    if (statement.type === 'customAnimation') {
      const preferredPath = typeof params.animation === 'string' && !params.file ? 'params.animation' : 'params.file';
      return slots.filter((slot) => slot.path === preferredPath);
    }
    return slots;
  }

  timelinePresentation(statement: Pick<SceneStatement, 'type' | 'params'>): SceneStatementTimelinePresentation {
    const definition = this.get(statement.type);
    return definition.timelinePresentation(statement.params as never);
  }

  timelineLifecyclePresentation(
    statement: Pick<SceneStatement, 'type' | 'params'>,
  ): ResolvedSceneStatementLifecyclePresentation | undefined {
    const params = statement.params as unknown as Record<string, unknown>;
    const presentations = this.get(statement.type).lifecyclePresentations ?? [];
    for (const presentation of presentations) {
      if (presentation.when && Object.entries(presentation.when).some(([key, value]) => params[key] !== value)) {
        continue;
      }
      const operation = params[presentation.operationField];
      const boundary = presentation.startOperations.includes(operation as string)
        ? 'start'
        : presentation.endOperations.includes(operation as string)
          ? 'end'
          : undefined;
      if (!boundary) continue;
      const stateKey = resolveLifecycleStateKey(presentation.target, params);
      if (!stateKey) continue;
      const transitionDurationField = presentation.transitionDurationFields?.[boundary];
      const transitionDurationValue = transitionDurationField ? params[transitionDurationField] : undefined;
      return {
        definition: {
          ...presentation,
          family: statement.type,
        } as RegisteredSceneStatementLifecyclePresentation,
        boundary,
        stateKey,
        transitionDurationSeconds: resolveLifecycleTransitionDuration(
          statement,
          boundary,
          transitionDurationValue,
        ),
      };
    }
    return undefined;
  }

  timelineStateSpanDependency(
    statement: Pick<SceneStatement, 'type' | 'params'>,
  ): ResolvedSceneStatementStateSpanDependency | undefined {
    const params = statement.params as unknown as Record<string, unknown>;
    for (const dependency of this.get(statement.type).stateSpanDependencies ?? []) {
      if (dependency.when && Object.entries(dependency.when).some(([key, value]) => params[key] !== value)) {
        continue;
      }
      if (
        dependency.operationField
        && !dependency.operations?.includes(params[dependency.operationField] as string)
      ) {
        continue;
      }
      const stateKey = resolveLifecycleStateKey(dependency.target, params);
      if (!stateKey) continue;
      return {
        presentationTypeKey: dependency.presentationTypeKey,
        stateKey,
      };
    }
    return undefined;
  }

  materializeLifecycleEndDraft(
    startStatement: Pick<SceneStatement, 'type' | 'params'>,
    transitionDurationSeconds = 0,
    endParamsTemplate: Readonly<Record<string, unknown>> = {},
  ): SceneStatementDraft {
    const lifecycle = this.timelineLifecyclePresentation(startStatement);
    if (!lifecycle || lifecycle.boundary !== 'start') {
      throw new Error(`Statement is not a State Span start boundary: ${startStatement.type}`);
    }
    const definition = lifecycle.definition;
    const sourceParams = startStatement.params as unknown as Record<string, unknown>;
    const params: Record<string, unknown> = {
      ...endParamsTemplate,
      ...(definition.when ?? {}),
      [definition.operationField]: definition.endOperations[0],
    };
    for (const field of definition.target.fields) params[field] = sourceParams[field];
    for (const field of definition.target.optionalFields ?? []) {
      if (sourceParams[field] !== undefined) params[field] = sourceParams[field];
    }
    const durationField = definition.transitionDurationFields?.end;
    if (durationField) {
      params[durationField] = Number.isFinite(transitionDurationSeconds)
        ? Math.max(0, transitionDurationSeconds)
        : 0;
    }
    return {
      type: startStatement.type,
      params: this.parseParams(startStatement.type, params, 'materializedStateSpanEnd.params'),
    } as SceneStatementDraft;
  }

  materializeStateSpanDependencyDraft(
    startStatement: Pick<SceneStatement, 'type' | 'params'>,
    dependencyType: StatementFamily,
    presentationTypeKey: string,
    paramsTemplate: Readonly<Record<string, unknown>> = {},
  ): SceneStatementDraft {
    const lifecycle = this.timelineLifecyclePresentation(startStatement);
    if (
      !lifecycle
      || lifecycle.boundary !== 'start'
      || lifecycle.definition.presentationTypeKey !== presentationTypeKey
    ) {
      throw new Error(`Statement is not the requested State Span start boundary: ${presentationTypeKey}`);
    }
    const dependency = (this.get(dependencyType).stateSpanDependencies ?? [])
      .find((candidate) => candidate.presentationTypeKey === presentationTypeKey);
    if (!dependency) {
      throw new Error(`Statement family does not depend on State Span type: ${dependencyType} -> ${presentationTypeKey}`);
    }

    const sourceParams = startStatement.params as unknown as Record<string, unknown>;
    const params: Record<string, unknown> = {
      ...paramsTemplate,
      ...(dependency.when ?? {}),
    };
    if (dependency.operationField && dependency.operations?.[0]) {
      params[dependency.operationField] = dependency.operations[0];
    }
    for (const field of dependency.target.fields) params[field] = sourceParams[field];
    for (const field of dependency.target.optionalFields ?? []) {
      if (sourceParams[field] !== undefined) params[field] = sourceParams[field];
    }
    for (const field of dependency.inheritFields ?? []) {
      if (sourceParams[field] !== undefined) params[field] = sourceParams[field];
    }

    const draft = {
      type: dependencyType,
      params: this.parseParams(dependencyType, params, 'materializedStateSpanDependency.params'),
    } as SceneStatementDraft;
    const resolved = this.timelineStateSpanDependency(draft);
    if (
      !resolved
      || resolved.presentationTypeKey !== presentationTypeKey
      || resolved.stateKey !== lifecycle.stateKey
    ) {
      throw new Error(`Materialized dependency does not target its State Span: ${presentationTypeKey}`);
    }
    return draft;
  }

  isAttachableToDialogue(statement: Pick<SceneStatement, 'type' | 'params'>): boolean {
    const definition = this.get(statement.type);
    if (!definition.attachableTo?.includes('dialogue')) return false;
    return definition.isAttachable
      ? definition.isAttachable(statement.params as never, 'dialogue')
      : true;
  }
}

function resolveLifecycleStateKey(
  target: TimelineStateSpanTargetRule,
  params: Readonly<Record<string, unknown>>,
): string | undefined {
  const values: string[] = [];
  for (const field of target.fields) {
    const value = params[field];
    if (typeof value !== 'string' || value.length === 0) return undefined;
    values.push(`${field}=${JSON.stringify(value)}`);
  }
  for (const field of target.optionalFields ?? []) {
    const value = params[field];
    // Post-processing's omitted target is the panorama. Keep omitted and
    // explicit panorama statements in the same lifecycle state span so a
    // reset/modulate operation cannot accidentally pair with another target.
    if (value === undefined && target.namespace === 'lighting:post' && field === 'target') {
      values.push(`${field}=${JSON.stringify('panorama')}`);
      continue;
    }
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0) return undefined;
    values.push(`${field}=${JSON.stringify(value)}`);
  }
  return values.length > 0 ? `${target.namespace}:${values.join('|')}` : target.namespace;
}

export const sceneStatementDefinitionRegistry = new SceneStatementDefinitionRegistry();

/**
 * Deterministic execution-contract fingerprint over the statement families
 * the project-Agent write tools depend on (ADR0023): family identity, patch
 * metadata and asset-slot shapes. A changed registry between sessions must
 * trigger journal migration and a forced continuation compaction; the
 * fingerprint is stable across calls for the same registry.
 */
export function deriveSceneStatementRegistryFingerprint(
  registry?: SceneStatementDefinitionRegistry,
): string {
  const definitions = registry ? registry.list() : Object.values(SCENE_STATEMENT_DEFINITIONS);
  const parts = definitions.map((definition) => JSON.stringify({
    family: definition.family,
    ...(definition.minimumSceneSchemaVersion ? { minimumSceneSchemaVersion: definition.minimumSceneSchemaVersion } : {}),
    category: definition.category,
    label: definition.label,
    discriminators: definition.discriminators,
    ...(definition.attachableTo ? { attachableTo: [...definition.attachableTo].sort() } : {}),
    ...(definition.patchMetadata ? { patchMetadata: definition.patchMetadata } : {}),
    ...(definition.compiledAssetSlots ? { compiledAssetSlots: definition.compiledAssetSlots } : {}),
    ...(definition.sourceAssetSlots ? { sourceAssetSlots: definition.sourceAssetSlots } : {}),
  })).sort();
  return fnv1a8(parts.join('\n'));
}

function fnv1a8(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

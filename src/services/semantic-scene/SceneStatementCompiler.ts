import {
  SCENE_SCHEMA_VERSION,
  type AudioParams,
  type CameraParams,
  type CharacterPerformanceParams,
  type CharacterPresenceParams,
  type CharacterTransformParams,
  type CompiledScene,
  type CurrentSceneDocument,
  type CustomAnimationParams,
  type DialogueCompanion,
  type DialogueParams,
  type EnvironmentLayerParams,
  type FilterAddParams,
  type FilterChangeParams,
  type FilterResetParams,
  type GraphicLayerParams,
  type LightingParams,
  type RuntimeActionParams,
  type RuntimeActionType,
  type SceneStatement,
  type VisualStyleParams,
  type ZoomIntent,
} from '../../api/types/semantic-scene';
import type { SceneVisualBlock } from '../../api/types/visual';
import {
  resolveAudioFadeIn,
  resolveAudioFadeOut,
  resolveCharacterPresenceTransition,
  resolveCharacterPresenceTransitionDuration,
  resolveEnvironmentLayerDuration,
  resolveEnvironmentLayerTransition,
  resolveFilterTransitionDuration,
  sceneStatementDefinitionRegistry,
  type SceneStatementDefinitionRegistry,
} from './SceneStatementDefinitionRegistry';
import { assertLensFilterStatements } from './LensFilterStatementValidator';
import { getLensFilterCategory } from '../../engine/visual-runtime/BuiltInVisualRecipeCatalog';

type SceneCharacter = NonNullable<CurrentSceneDocument['meta']['characters']>[number];

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;

interface LoweredAction {
  readonly outputKey: string;
  readonly action: RuntimeActionType;
  readonly params: RuntimeActionParams;
  readonly assetSlots?: readonly import('../../api/types/semantic-scene').CompiledAssetSlot[];
}

interface CompiledUnit {
  readonly statementId: string;
  readonly companionId?: string;
  readonly statementOrder: number;
  readonly companionOrder: number;
  readonly outputOrder: number;
  readonly time: number;
  readonly lowered: LoweredAction;
}

interface CompanionContext {
  readonly parent: Extract<SceneStatement, { type: 'dialogue' }>;
  readonly parentPath: string;
  readonly characterIds: ReadonlySet<string>;
}

interface CameraTimelineEvent {
  readonly id: string;
  readonly time: number;
  readonly statementOrder: number;
  readonly companionOrder: number;
  readonly params: CameraParams;
}

export class SceneStatementCompiler {
  constructor(
    private readonly registry: SceneStatementDefinitionRegistry = sceneStatementDefinitionRegistry,
  ) {}

  compile(document: CurrentSceneDocument): CompiledScene {
    if (document.schemaVersion !== SCENE_SCHEMA_VERSION) {
      throw new Error(`SceneStatementCompiler only accepts schemaVersion ${SCENE_SCHEMA_VERSION}`);
    }
    assertLensFilterStatements(document);

    const charactersById = new Map(
      (document.meta.characters ?? []).map((character) => [character.id, character] as const),
    );
    const characterIds = new Set(charactersById.keys());
    validateCameraFollowLifecycle(document, this.registry);
    const units: CompiledUnit[] = [];
    let derivedDuration = 0;

    document.statements.forEach((statement, statementIndex) => {
      const statementEnd = statement.time + this.registry.temporalExtent(statement);
      derivedDuration = Math.max(derivedDuration, statementEnd);
      units.push(...this.compileStatement(statement, statement.time, statementIndex, 0, characterIds, charactersById, document.visual));

      if (statement.companions?.length) {
        if (statement.type !== 'dialogue') {
          throw new Error(`Only dialogue statements can own companions: ${statement.id}`);
        }
        statement.companions.forEach((companion, companionIndex) => {
          const companionTime =
            statement.time +
            (companion.anchor === 'end' ? statement.params.durationSeconds : 0) +
            companion.offset;
          if (companionTime < 0) {
            throw new Error(`Companion "${companion.id}" under "${statement.id}" resolves before 0s`);
          }
          const companionAsStatement = companionToStatement(companion, companionTime);
          derivedDuration = Math.max(
            derivedDuration,
            companionTime + this.registry.temporalExtent(companionAsStatement),
          );
          units.push(
            ...this.compileStatement(
              companionAsStatement,
              companionTime,
              statementIndex,
              companionIndex + 1,
              characterIds,
              charactersById,
              document.visual,
              {
                parent: statement,
                parentPath: `statement ${statement.id}`,
                characterIds,
              },
            ),
          );
        });
      }
    });

    if (document.meta.durationSeconds !== undefined && document.meta.durationSeconds < derivedDuration) {
      throw new Error(
        `meta.durationSeconds (${document.meta.durationSeconds}) is before compiled scene end (${derivedDuration})`,
      );
    }

    const seenCompiledIds = new Set<string>();
    const actions = units
      .map((unit) => {
        const id = encodeCompiledActionId(unit.statementId, unit.companionId, unit.lowered.outputKey);
        if (seenCompiledIds.has(id)) {
          throw new Error(`Duplicate compiled action id generated: ${id}`);
        }
        seenCompiledIds.add(id);
        return {
          id,
          time: unit.time,
          action: unit.lowered.action,
          params: deepFreeze(cloneJson(unit.lowered.params)),
          assetSlots: deepFreeze(cloneJson(unit.lowered.assetSlots ?? [])),
          source: {
            statementId: unit.statementId,
            ...(unit.companionId ? { companionId: unit.companionId } : {}),
            outputKey: unit.lowered.outputKey,
          },
          statementOrder: unit.statementOrder,
          companionOrder: unit.companionOrder,
          outputOrder: unit.outputOrder,
        };
      })
      .sort((a, b) => (
        a.time - b.time ||
        a.statementOrder - b.statementOrder ||
        a.companionOrder - b.companionOrder ||
        a.outputOrder - b.outputOrder ||
        a.id.localeCompare(b.id)
      ))
      .map(({ statementOrder: _statementOrder, companionOrder: _companionOrder, outputOrder: _outputOrder, ...action }) =>
        deepFreeze(action),
      );

    return deepFreeze({
      sourceSchemaVersion: document.schemaVersion,
      sceneId: document.sceneId,
      meta: cloneJson(document.meta),
      ...(document.visual ? { visual: cloneJson(document.visual) } : {}),
      durationSeconds: document.meta.durationSeconds ?? derivedDuration,
      actions,
    });
  }

  private compileStatement(
    statement: SceneStatement,
    time: number,
    statementOrder: number,
    companionOrder: number,
    characterIds: ReadonlySet<string>,
    charactersById: ReadonlyMap<string, SceneCharacter>,
    visual: SceneVisualBlock | undefined,
    companionContext?: CompanionContext,
  ): CompiledUnit[] {
    validateSpeakerReference(statement, companionContext, characterIds);
    const resolvedStatement = resolveStatementReferences(statement, companionContext);
    const lowered = lowerStatement(resolvedStatement, charactersById, visual);
    assertUniqueOutputKeys(lowered, statement.id, companionContext?.parent.id);
    return lowered.map((entry, outputOrder) => ({
      statementId: companionContext?.parent.id ?? statement.id,
      ...(companionContext ? { companionId: statement.id } : {}),
      statementOrder,
      companionOrder,
      outputOrder,
      time,
      lowered: {
        ...entry,
        assetSlots: this.registry.compiledAssetSlots(resolvedStatement, entry.outputKey)
          .map(({ path, kind }) => ({ path, kind })),
      },
    }));
  }
}

export const sceneStatementCompiler = new SceneStatementCompiler();

export function encodeCompiledActionId(
  statementId: string,
  companionId: string | undefined,
  outputKey: string,
): string {
  return [
    encodeTupleField('statementId', statementId),
    ...(companionId ? [encodeTupleField('companionId', companionId)] : []),
    encodeTupleField('outputKey', outputKey),
  ].join('|');
}

function encodeTupleField(tag: string, value: string): string {
  return `${tag}:${new TextEncoder().encode(value).byteLength}:${value}`;
}

export function decodeCompiledActionId(id: string): {
  statementId: string;
  companionId?: string;
  outputKey: string;
} | null {
  if (typeof id !== 'string' || !id.startsWith('statementId:')) {
    return null;
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(id);
  let offset = 0;
  let statementId: string | undefined;
  let companionId: string | undefined;
  let outputKey: string | undefined;

  while (offset < bytes.length) {
    let colon1 = -1;
    for (let i = offset; i < bytes.length; i++) {
      if (bytes[i] === 58 /* ':' */) {
        colon1 = i;
        break;
      }
    }
    if (colon1 === -1) return null;

    const tag = decoder.decode(bytes.subarray(offset, colon1));

    let colon2 = -1;
    for (let i = colon1 + 1; i < bytes.length; i++) {
      if (bytes[i] === 58 /* ':' */) {
        colon2 = i;
        break;
      }
    }
    if (colon2 === -1) return null;

    const lenStr = decoder.decode(bytes.subarray(colon1 + 1, colon2));
    const byteLen = parseInt(lenStr, 10);
    if (Number.isNaN(byteLen) || byteLen < 0) return null;

    const valStart = colon2 + 1;
    const valEnd = valStart + byteLen;
    if (valEnd > bytes.length) return null;

    const value = decoder.decode(bytes.subarray(valStart, valEnd));
    if (tag === 'statementId') statementId = value;
    else if (tag === 'companionId') companionId = value;
    else if (tag === 'outputKey') outputKey = value;

    offset = valEnd;
    if (offset < bytes.length) {
      if (bytes[offset] === 124 /* '|' */) {
        offset += 1;
      } else {
        return null;
      }
    }
  }

  if (!statementId || !outputKey) return null;
  return {
    statementId,
    ...(companionId !== undefined ? { companionId } : {}),
    outputKey,
  };
}

function companionToStatement(companion: DialogueCompanion, time: number): SceneStatement {
  return {
    id: companion.id,
    time,
    type: companion.type,
    params: companion.params,
  } as SceneStatement;
}

function validateCameraFollowLifecycle(
  document: CurrentSceneDocument,
  registry: SceneStatementDefinitionRegistry,
): void {
  let activeFollow: CameraTimelineEvent | undefined;
  for (const event of collectCameraTimelineEvents(document, registry)) {
    const params = event.params;
    if (params.mode === 'follow') {
      if (params.operation === 'start') {
        if (!params.target) {
          throw new Error(`Camera follow start "${event.id}" requires target`);
        }
        if (activeFollow) {
          throw new Error(
            `Camera follow "${activeFollow.id}" is still active when "${event.id}" starts another follow`,
          );
        }
        activeFollow = event;
      } else {
        activeFollow = undefined;
      }
      continue;
    }

    if (params.mode === 'reset') {
      activeFollow = undefined;
      continue;
    }

    if (activeFollow && cameraStatementWritesPosition(params)) {
      throw new Error(
        `Camera follow "${activeFollow.id}" is still active when "${event.id}" writes camera position`,
      );
    }
  }
}

function collectCameraTimelineEvents(
  document: CurrentSceneDocument,
  registry: SceneStatementDefinitionRegistry,
): CameraTimelineEvent[] {
  const events: CameraTimelineEvent[] = [];
  document.statements.forEach((statement, statementIndex) => {
    if (statement.type === 'camera') {
      events.push({
        id: statement.id,
        time: statement.time,
        statementOrder: statementIndex,
        companionOrder: 0,
        params: statement.params,
      });
    }
    if (statement.type !== 'dialogue') return;
    statement.companions?.forEach((companion, companionIndex) => {
      if (companion.type !== 'camera') return;
      const companionTime =
        statement.time +
        (companion.anchor === 'end' ? registry.temporalExtent(statement) : 0) +
        companion.offset;
      events.push({
        id: companion.id,
        time: companionTime,
        statementOrder: statementIndex,
        companionOrder: companionIndex + 1,
        params: companion.params,
      });
    });
  });

  return events.sort((a, b) => (
    a.time - b.time ||
    a.statementOrder - b.statementOrder ||
    a.companionOrder - b.companionOrder ||
    a.id.localeCompare(b.id)
  ));
}

function cameraStatementWritesPosition(params: CameraParams): boolean {
  switch (params.mode) {
    case 'focus':
      return params.target !== undefined || params.position !== undefined;
    case 'move':
      return params.position !== undefined || params.to !== undefined;
    case 'path':
      return params.keyframes.some((keyframe) => keyframe.position !== undefined);
    case 'hitchcock':
      return true;
    case 'follow':
    case 'reset':
    case 'shake':
      return false;
  }
}

function validateSpeakerReference(
  statement: SceneStatement,
  companionContext: CompanionContext | undefined,
  characterIds: ReadonlySet<string>,
): void {
  if (statement.type === 'dialogue' && statement.params.speakerId && !characterIds.has(statement.params.speakerId)) {
    throw new Error(`Dialogue "${statement.id}" references unknown speakerId "${statement.params.speakerId}"`);
  }
  if (!containsSpeakerToken(statement.params)) return;
  if (!companionContext) {
    throw new Error(`$speaker can only be used inside a dialogue companion: ${statement.id}`);
  }
  const speakerId = companionContext.parent.params.speakerId;
  if (!speakerId) {
    throw new Error(`$speaker companion under ${companionContext.parentPath} requires parent speakerId`);
  }
  if (!characterIds.has(speakerId)) {
    throw new Error(`$speaker companion under ${companionContext.parentPath} references unknown speakerId "${speakerId}"`);
  }
}

function containsSpeakerToken(value: unknown): boolean {
  if (value === '$speaker') return true;
  if (Array.isArray(value)) return value.some(containsSpeakerToken);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsSpeakerToken);
  }
  return false;
}

function resolveStatementReferences(
  statement: SceneStatement,
  companionContext: CompanionContext | undefined,
): SceneStatement {
  const speakerId = companionContext?.parent.params.speakerId;
  return {
    ...statement,
    params: resolveValue(statement.params, speakerId) as typeof statement.params,
  } as SceneStatement;
}

function resolveValue(value: unknown, speakerId: string | undefined): unknown {
  if (value === '$speaker') return speakerId;
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, speakerId));
  if (value && typeof value === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      resolved[key] = resolveValue(nested, speakerId);
    }
    return resolved;
  }
  return value;
}

function assertUniqueOutputKeys(
  outputs: readonly LoweredAction[],
  statementId: string,
  parentStatementId: string | undefined,
): void {
  const seen = new Set<string>();
  for (const output of outputs) {
    if (seen.has(output.outputKey)) {
      throw new Error(`Duplicate lowerer outputKey "${output.outputKey}" for statement "${parentStatementId ?? statementId}"`);
    }
    seen.add(output.outputKey);
  }
}

function lowerStatement(
  statement: SceneStatement,
  charactersById: ReadonlyMap<string, SceneCharacter>,
  visual: SceneVisualBlock | undefined,
): LoweredAction[] {
  switch (statement.type) {
    case 'dialogue':
      return lowerDialogue(statement.params);
    case 'characterPresence':
      return lowerCharacterPresence(statement.params, charactersById.get(statement.params.id)?.model);
    case 'characterTransform':
      return [withOutput('primary', 'transformCharacter', lowerCharacterTransformParams(statement.params))];
    case 'characterPerformance':
      return lowerCharacterPerformance(statement.params);
    case 'camera':
      return lowerCamera(statement.params);
    case 'environmentLayer':
      return lowerEnvironmentLayer(statement.params);
    case 'visualStyle':
      return lowerVisualStyle(statement.params);
    case 'filterAdd':
      return lowerFilterAdd(statement.params, visual);
    case 'filterChange':
      return lowerFilterChange(statement.params, visual);
    case 'filterReset':
      return lowerFilterReset(statement.params);
    case 'lighting':
      return lowerLighting(statement.params);
    case 'audio':
      return lowerAudio(statement.params);
    case 'graphicLayer':
      return lowerGraphicLayer(statement.params);
    case 'customAnimation':
      return [withOutput('primary', 'playCustomAnimation', lowerCustomAnimation(statement.params))];
  }
}

function lowerDialogue(params: DialogueParams): LoweredAction[] {
  const runtimeLipSync = params.lipSync === undefined
    ? undefined
    : params.lipSync
      ? (params.voice ? 'audio' : 'text')
      : 'none';

  return [
    withOutput('primary', 'dialogue', renameDuration({ ...params, lipSync: runtimeLipSync })),
  ];
}

function lowerCharacterPresence(params: CharacterPresenceParams, defaultModel: string | undefined): LoweredAction[] {
  const transition = resolveCharacterPresenceTransition(params);
  const duration = resolveCharacterPresenceTransitionDuration(params);
  if (params.mode === 'enter') {
    const model = params.model ?? defaultModel;
    return [
      withOutput('primary', 'addCharacter', cleanParams({
        id: params.id,
        model,
        variant: params.variant,
        position: params.position,
        scale: params.scale,
        rotation: params.rotation,
        opacity: params.opacity,
        z: params.z,
        enter: transition,
        duration,
        enterDuration: duration,
        enterEase: params.ease,
      })),
    ];
  }
  return [
    withOutput('primary', 'removeCharacter', cleanParams({
      id: params.id,
      exit: transition,
      duration,
      exitDuration: duration,
      exitEase: params.ease,
    })),
  ];
}

function lowerCharacterTransformParams(params: CharacterTransformParams): RuntimeActionParams {
  return cleanParams({
    id: params.id,
    position: params.position,
    scale: params.scale,
    rotation: params.rotation,
    opacity: params.opacity,
    z: params.z,
    duration: params.durationSeconds,
    ease: params.ease,
  });
}

function lowerCharacterPerformance(params: CharacterPerformanceParams): LoweredAction[] {
  const outputs: LoweredAction[] = [];
  if (params.motion) {
    outputs.push(withOutput('motion', 'playMotion', cleanParams({
      id: params.target,
      motion: params.motion,
    })));
  }
  if (params.expression) {
    outputs.push(withOutput('expression', 'setExpression', {
      id: params.target,
      expression: params.expression,
    }));
  }
  if (params.lookAt) {
    const point = params.lookAt.point ?? [0, 0] as const;
    const enabled = params.lookAt.enabled ?? true;
    outputs.push(withOutput('lookAt', 'characterLookAt', cleanParams({
      id: params.target,
      target: params.lookAt.target,
      // Keep the source point representation through the runtime seam. The
      // synchronizer still accepts focusX/focusY for legacy compiled scenes.
      point: [point[0], point[1]],
      enabled,
      intensity: params.lookAt.intensity,
    })));
  }
  if (params.blink) {
    outputs.push(withOutput('blink', 'characterBlink', cleanParams({
      id: params.target,
      enabled: params.blink.enabled,
      interval: params.blink.interval,
      intervalRange: params.blink.intervalRange,
    })));
  }
  return outputs;
}

function lowerCamera(params: CameraParams): LoweredAction[] {
  switch (params.mode) {
    case 'focus':
      return [withOutput('primary', 'cameraMotion', cleanParams({
        move: cameraMoveForZoom(params.zoom, params.target ? 'focus' : 'pan'),
        easing: mapEase(params.ease),
        duration: params.durationSeconds,
        focus: params.target ? {
          character: params.target,
          part: params.targetPart ?? 'head',
        } : { point: params.position },
        zoom: lowerZoomValue(params.zoom),
        angle: params.rotation,
      }))];
    case 'move':
      return [withOutput('primary', 'cameraMotion', cleanParams({
        move: cameraMoveForZoom(params.zoom, params.position || params.to ? 'pan' : 'zoom'),
        easing: mapEase(params.ease),
        duration: params.durationSeconds,
        target: params.to ?? params.position,
        zoom: lowerZoomValue(params.zoom),
        angle: params.rotation,
      }))];
    case 'follow':
      if (params.operation === 'start') {
        return [withOutput('start', 'cameraFollow', cleanParams({
          characterId: params.target,
          offset: params.offset,
          smoothing: params.smoothing,
        }))];
      }
      // Follow only holds the position channel: releasing it must not touch
      // zoom/rotation, so stop lowers to a dedicated unfollow action instead
      // of a full camera reset (KSM-0003 follow state contract).
      return [withOutput('stop', 'cameraUnfollow', {})];
    case 'path':
      return [withOutput('primary', 'cameraPath', cleanParams({
        keyframes: params.keyframes,
        duration: params.durationSeconds,
        ease: params.ease,
        loop: params.loop,
        repeat: params.repeat,
        yoyo: params.yoyo,
      }))];
    case 'shake':
      return [withOutput('primary', 'cameraShake', cleanParams({
        intensity: params.intensity,
        frequency: params.frequency,
        duration: params.durationSeconds,
        decay: params.decay,
        direction: params.direction,
      }))];
    case 'hitchcock':
      return [withOutput('primary', 'cameraHitchcock', cleanParams({
        characterId: params.target,
        targetPart: params.targetPart,
        screenTarget: params.screenTarget,
        zoomStart: params.zoomStart,
        zoomEnd: params.zoomEnd,
        scaleStart: params.scaleStart,
        scaleEnd: params.scaleEnd,
        duration: params.durationSeconds,
        ease: params.ease,
      }))];
    case 'reset':
      return [withOutput('primary', 'cameraReset', cleanParams({
        duration: params.durationSeconds,
        ease: params.ease,
      }))];
  }
}

function lowerEnvironmentLayer(params: EnvironmentLayerParams): LoweredAction[] {
  const transition = resolveEnvironmentLayerTransition(params);
  const duration = resolveEnvironmentLayerDuration(params);
  const runtimeParams = cleanParams({
    layerId: params.layerId,
    image: params.image ?? params.file,
    x: params.position?.[0],
    y: params.position?.[1],
    scale: params.scale,
    rotation: params.rotation,
    opacity: params.opacity,
    z: params.z,
    zIndex: params.zIndex,
    duration,
    ease: params.ease,
    transition,
  });
  const action: RuntimeActionType =
    params.mode === 'set'
      ? 'setEnvironmentLayer'
      : params.mode === 'transform'
        ? 'transformEnvironmentLayer'
        : 'removeEnvironmentLayer';
  return [withOutput('primary', action, runtimeParams)];
}

function lowerVisualStyle(params: VisualStyleParams): LoweredAction[] {
  if (params.slot === 'rim-light') {
    return [withOutput('rim-light', 'setCharacterRimLight', cleanParams({
      id: params.target,
      mode: params.mode,
      color: params.color,
      intensity: params.intensity,
      thickness: params.thickness,
      angle: params.angle,
      softness: params.softness,
      duration: params.durationSeconds,
    }))];
  }
  const common = {
    targetId: params.target,
    slot: params.slot,
    intensity: params.intensity,
    ...(params.slot === 'integration' ? { brightness: params.brightness } : {}),
    warmth: params.warmth,
    bloom: params.bloom,
    rgbSplit: params.rgbSplit,
    blend: params.blend,
    contamination: params.contamination,
    color: params.color,
    colorStops: params.colorStops,
    colorBlendMode: params.colorBlendMode,
    semanticOverride: params.semanticOverride,
    advancedOverride: params.advancedOverride,
    duration: params.durationSeconds,
  };
  switch (params.mode) {
    case 'set':
      return [withOutput('primary', 'setCompositeRecipe', cleanParams({
        ...common,
        recipeId: params.recipeId,
        mode: 'latching',
      }))];
    case 'modulate':
      return [withOutput('primary', 'modulateComposite', cleanParams({
        ...common,
        mode: 'envelope',
      }))];
    case 'reset':
      return [withOutput('primary', 'resetCompositeRecipe', cleanParams({
        targetId: params.target,
        slot: params.slot,
        duration: params.durationSeconds,
      }))];
  }
  return assertNever(params, 'visualStyle params');
}

/** @deprecated Keep compiling historical lens filter statements for playback compatibility. */
function lowerFilterAdd(params: FilterAddParams, visual: SceneVisualBlock | undefined): LoweredAction[] {
  const category = getLensFilterCategory(visual, params.recipeId);
  if (!category) throw new Error(`Unknown lens filter recipe: ${params.recipeId}`);
  return [withOutput('primary', 'addLensFilter', cleanParams({
    category,
    recipeId: params.recipeId,
    intensity: params.intensity,
    warmth: params.warmth,
    bloom: params.bloom,
    rgbSplit: params.rgbSplit,
    blend: params.blend,
    contamination: params.contamination,
    duration: resolveFilterTransitionDuration(params),
  }))];
}

/** @deprecated Keep compiling historical lens filter statements for playback compatibility. */
function lowerFilterChange(params: FilterChangeParams, visual: SceneVisualBlock | undefined): LoweredAction[] {
  const category = getLensFilterCategory(visual, params.recipeId);
  const fromCategory = getLensFilterCategory(visual, params.fromRecipeId);
  if (!category) throw new Error(`Unknown lens filter recipe: ${params.recipeId}`);
  if (!fromCategory) throw new Error(`Unknown current lens filter recipe: ${params.fromRecipeId}`);
  return [withOutput('primary', 'changeLensFilter', cleanParams({
    category,
    fromCategory,
    fromRecipeId: params.fromRecipeId,
    recipeId: params.recipeId,
    intensity: params.intensity,
    warmth: params.warmth,
    bloom: params.bloom,
    rgbSplit: params.rgbSplit,
    blend: params.blend,
    contamination: params.contamination,
    duration: resolveFilterTransitionDuration(params),
  }))];
}

/** @deprecated Keep compiling historical lens filter statements for playback compatibility. */
function lowerFilterReset(params: FilterResetParams): LoweredAction[] {
  return [withOutput('primary', 'resetLensFilters', cleanParams({
    duration: resolveFilterTransitionDuration(params),
  }))];
}

function lowerLighting(params: LightingParams): LoweredAction[] {
  switch (params.effect) {
    case 'preset':
      switch (params.mode) {
        case 'reset':
          return [withOutput('primary', 'resetLighting', cleanParams({ duration: params.durationSeconds }))];
        case 'set':
        case 'modulate':
          return [withOutput('primary', 'setLighting', cleanParams({
            preset: params.preset,
            intensity: params.intensity,
            duration: params.durationSeconds,
          }))];
        default:
          return assertNever(params, 'lighting preset params');
      }
    case 'blur':
      switch (params.mode) {
        case 'reset':
          return [withOutput('primary', 'resetBlur', cleanParams({ target: params.target, duration: params.durationSeconds }))];
        case 'set':
        case 'modulate':
          return [withOutput('primary', 'setBlur', cleanParams({
            target: params.target,
            intensity: params.intensity,
            duration: params.durationSeconds,
          }))];
        default:
          return assertNever(params, 'lighting blur params');
      }
    case 'godrays':
      switch (params.mode) {
        case 'reset':
          return [withOutput('primary', 'resetGodrays', cleanParams({ duration: params.durationSeconds }))];
        case 'set':
        case 'modulate':
          return [withOutput('primary', 'setGodrays', cleanParams({
            intensity: params.intensity,
            angle: params.angle,
            lacunarity: params.lacunarity,
            duration: params.durationSeconds,
          }))];
        default:
          return assertNever(params, 'lighting godrays params');
      }
    case 'post':
      switch (params.mode) {
        case 'reset':
          return [withOutput('primary', 'resetPostProcessing', cleanParams({
            target: params.target ?? 'panorama',
            duration: params.durationSeconds,
          }))];
        case 'set':
        case 'modulate':
          return [withOutput('primary', 'setPostProcessing', cleanParams({
            target: params.target ?? 'panorama',
            bloomThreshold: params.bloomThreshold,
            bloomBloomScale: params.bloomBloomScale,
            bloomBrightness: params.bloomBrightness,
            rgbSplitX: params.rgbSplitX,
            rgbSplitY: params.rgbSplitY,
            godrayGain: params.godrayGain,
            godrayLacunarity: params.godrayLacunarity,
            godrayAngle: params.godrayAngle,
            adjGamma: params.adjGamma,
            adjContrast: params.adjContrast,
            adjSaturation: params.adjSaturation,
            adjBrightness: params.adjBrightness,
            adjRed: params.adjRed,
            adjGreen: params.adjGreen,
            adjBlue: params.adjBlue,
            overlayColor: params.overlayColor,
            overlayBlendMode: params.overlayBlendMode,
            overlayIntensity: params.overlayIntensity,
            duration: params.durationSeconds,
          }))];
        default:
          return assertNever(params, 'lighting post params');
      }
    case 'overlay':
      switch (params.mode) {
        case 'clear':
          return [withOutput('clear', 'clearColorOverlays', cleanParams({ duration: params.durationSeconds }))];
        case 'remove':
          return [withOutput('primary', 'removeColorOverlay', cleanParams({ id: params.id, duration: params.durationSeconds }))];
        case 'set':
        case 'modulate':
          return [withOutput('primary', 'addColorOverlay', cleanParams({
            id: params.id,
            color: params.color,
            mode: params.blendMode,
            intensity: params.intensity,
            duration: params.durationSeconds,
          }))];
        default:
          return assertNever(params, 'lighting overlay params');
      }
    case 'pointLight':
      switch (params.mode) {
        case 'clear':
          return [withOutput('clear', 'clearPointLights', cleanParams({ duration: params.durationSeconds }))];
        case 'remove':
          return [withOutput('primary', 'removePointLight', cleanParams({ id: params.id, duration: params.durationSeconds }))];
        case 'set':
        case 'modulate':
          return [withOutput('primary', 'addPointLight', cleanParams({
            id: params.id,
            x: resolvePointLightCoordinate(params.x, STAGE_WIDTH),
            y: resolvePointLightCoordinate(params.y, STAGE_HEIGHT),
            color: params.color,
            radius: params.radius,
            intensity: params.intensity,
            duration: params.durationSeconds,
          }))];
        default:
          return assertNever(params, 'lighting pointLight params');
      }
  }
  return assertNever(params, 'lighting params');
}

function resolvePointLightCoordinate(value: number | undefined, stageSize: number): number | undefined {
  if (value === undefined) return undefined;
  return Math.abs(value) <= 2 ? value * stageSize : value;
}

function assertNever(value: never, context: string): never {
  throw new Error(`Unsupported ${context}: ${String(value)}`);
}

function lowerAudio(params: AudioParams): LoweredAction[] {
  if (params.role === 'bgm' && params.mode === 'play') {
    return [withOutput('primary', 'setBGM', cleanParams({
      file: params.file,
      volume: params.volume,
      loop: params.loop,
      fadeIn: resolveAudioFadeIn(params),
      fadeOut: params.fadeOut,
    }))];
  }
  if (params.role === 'bgm') {
    return [withOutput('stop', 'stopAudio', cleanParams({
      id: 'bgm',
      fadeOut: resolveAudioFadeOut(params),
    }))];
  }
  if (params.mode === 'play') {
    return [withOutput('primary', 'playAudio', cleanParams({
      id: params.instanceId,
      file: params.file,
      volume: params.volume,
      loop: params.loop,
      duration: params.durationSeconds,
      fadeIn: params.fadeIn,
      fadeOut: params.fadeOut,
    }))];
  }
  return [withOutput('stop', 'stopAudio', cleanParams({
    id: params.instanceId,
    fadeOut: resolveAudioFadeOut(params),
  }))];
}

function lowerGraphicLayer(params: GraphicLayerParams): LoweredAction[] {
  if (params.kind === 'text') {
    const action: RuntimeActionType =
      params.mode === 'set'
        ? 'addTextLayer'
        : params.mode === 'transform'
          ? 'transformTextLayer'
          : 'removeTextLayer';
    return [withOutput('primary', action, cleanParams({
      id: params.id,
      text: params.text,
      position: params.position,
      scale: params.scale,
      rotation: params.rotation,
      opacity: params.opacity,
      z: params.z,
      zIndex: params.zIndex,
      duration: params.durationSeconds,
      ease: params.ease,
      fontFamily: params.fontFamily,
      fontSize: params.fontSize,
      color: params.color,
      style: params.style,
    }))];
  }

  const action: RuntimeActionType =
    params.mode === 'set'
      ? 'addImage'
      : params.mode === 'transform'
        ? 'transformImage'
        : 'removeImage';
  return [withOutput('primary', action, cleanParams({
    id: params.id,
    file: params.file,
    position: params.position,
    scale: params.scale,
    rotation: params.rotation,
    opacity: params.opacity,
    z: params.z,
    zIndex: params.zIndex,
    duration: params.durationSeconds,
    ease: params.ease,
  }))];
}

function lowerCustomAnimation(params: CustomAnimationParams): RuntimeActionParams {
  return cleanParams({
    target: params.target,
    file: params.file ?? params.animation,
    duration: params.durationSeconds,
    loop: params.loop,
  });
}

function withOutput(outputKey: string, action: RuntimeActionType, params: RuntimeActionParams): LoweredAction {
  return { outputKey, action, params };
}

function renameDuration<T extends { durationSeconds?: number }>(params: T): RuntimeActionParams {
  const { durationSeconds, ...rest } = params;
  return cleanParams({ ...rest, duration: durationSeconds });
}

function lowerZoomValue(zoom: ZoomIntent | undefined): number | string | undefined {
  if (!zoom) return undefined;
  if (zoom.kind === 'absolute') return zoom.value;
  return zoom.value >= 0 ? `+=${zoom.value}` : `-=${Math.abs(zoom.value)}`;
}

function cameraMoveForZoom(zoom: ZoomIntent | undefined, fallback: 'focus' | 'pan' | 'zoom'): string {
  if (!zoom) return fallback === 'focus' ? 'pan' : fallback;
  if (zoom.kind === 'absolute') return 'zoom';
  return zoom.value >= 0 ? 'push' : 'pull';
}

function mapEase(ease: string | undefined): string {
  if (!ease) return 'smooth';
  const normalized = ease.toLowerCase();
  if (normalized === 'linear') return 'linear';
  if (normalized.includes('inout') || normalized === 'smooth') return 'smooth';
  if (normalized.includes('out')) return 'decelerate';
  if (normalized.includes('in')) return 'accelerate';
  return ease;
}

function cleanParams(record: Record<string, unknown>): RuntimeActionParams {
  const next: RuntimeActionParams = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) next[key] = value;
  }
  return next;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}

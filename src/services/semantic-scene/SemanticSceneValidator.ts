import type {
  CameraParams,
  CharacterPerformanceParams,
  CharacterPresenceParams,
  CurrentSceneDocument,
  LightingParams,
  SceneStatement,
  Vec2,
} from '../../api/types/semantic-scene';
import type { ValidationIssue } from '../../api/types/validation';
import { sceneStatementDefinitionRegistry } from './SceneStatementDefinitionRegistry';
import { validateLensFilterStatements } from './LensFilterStatementValidator';

export interface SemanticValidationIssue extends ValidationIssue {
  readonly code?: string;
  readonly location?: string;
}

export const SEMANTIC_VISUAL_DIAGNOSTIC_CODES = Object.freeze({
  cameraMoveMissingOperation: 'semantic.camera.move.missing-operation',
  cameraFocusMissingTarget: 'semantic.camera.focus.missing-target',
  cameraTargetEmpty: 'semantic.camera.target.empty',
  cameraTargetUnknown: 'semantic.camera.target.unknown',
  cameraPathMissingKeyframes: 'semantic.camera.path.missing-keyframes',
  cameraPathMissingValues: 'semantic.camera.path.missing-values',
  cameraFollowMissingTarget: 'semantic.camera.follow.missing-target',
  cameraFollowStopWithoutActiveTarget: 'semantic.camera.follow.stop-without-active-target',
  cameraFollowStopTargetMismatch: 'semantic.camera.follow.stop-target-mismatch',
  cameraFollowOverlap: 'semantic.camera.follow.overlap',
  cameraFollowPositionConflict: 'semantic.camera.follow.position-conflict',
  cameraBlackEdge: 'semantic.camera.black-edge',
  cameraBackgroundBlackEdge: 'semantic.camera.black-edge',
  lightingPresetMissing: 'semantic.lighting.preset.missing',
  lightingBlurTargetEmpty: 'semantic.lighting.blur.target-empty',
  lightingPostTargetEmpty: 'semantic.lighting.post.target-empty',
  lightingPostTargetUnknown: 'semantic.lighting.post.target-unknown',
  lightingGodraysMissingValues: 'semantic.lighting.godrays.missing-values',
  lightingResetWithoutActiveResource: 'semantic.lighting.reset.without-active-resource',
  lightingOverlayMissingId: 'semantic.lighting.overlay.missing-id',
  lightingOverlayMissingResource: 'semantic.lighting.overlay.missing-resource',
  lightingPointLightMissingId: 'semantic.lighting.point-light.missing-id',
  lightingPointLightMissingResource: 'semantic.lighting.point-light.missing-resource',
} as const);

export const SEMANTIC_CHARACTER_ORDERING_CODES = Object.freeze({
  actionBeforeEntrance: 'semantic.character.ordering.before-entrance',
  actionWithoutEntrance: 'semantic.character.ordering.without-entrance',
  duplicateEntrance: 'semantic.character.ordering.duplicate-entrance',
} as const);

export const SEMANTIC_AUDIO_DIAGNOSTIC_CODES = Object.freeze({
  dialogueVoiceWindowTruncated: 'semantic.dialogue.voice.window-truncated',
  dialogueVoiceDurationInvalid: 'semantic.dialogue.voice.duration-invalid',
  dialogueVoiceLipSyncDisabled: 'semantic.dialogue.voice.lipsync-disabled',
  dialogueVoiceCutOff: 'semantic.dialogue.voice.cut-off',
  audioOverlapTruncated: 'semantic.audio.overlap-truncated',
  companionAudioExceedsDialogue: 'semantic.audio.companion.exceeds-dialogue',
} as const);

interface AssetDiagnosticSlot {
  readonly label: string;
  readonly value: unknown;
}

interface StatementValidationContext {
  readonly statement: SceneStatement;
  readonly actionId: string;
  readonly actionType: SceneStatement['type'];
  readonly location: string;
  readonly isCompanion: boolean;
  readonly sourceOrder: number;
  readonly companionOrder: number;
}

interface ActiveFollow {
  readonly target: string;
}

/**
 * State of one active environment layer at a scene time. The stage renderer
 * cover-fits every layer image to the stage at scale 1, so scale 1 covers
 * exactly one viewport; rotation expands the axis-aligned half-extent.
 * `z` is the layer's render order (Pixi container zIndex), `order` breaks
 * equal-z ties by insertion sequence.
 */
interface EnvironmentLayerCoverage {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly rotation: number;
  readonly z: number;
  readonly order: number;
}

interface CameraFrameValidation {
  readonly follow: ActiveFollow | undefined;
  readonly zoom: number;
  readonly rotation: number;
}

interface CharacterPresenceSegment {
  readonly enterTime: number;
  exitTime: number | undefined;
}

interface LightingValidationState {
  readonly singletonEffects: Set<string>;
  readonly blurTargets: Set<'global' | 'background' | 'characters'>;
  readonly overlayIds: Set<string>;
  readonly pointLightIds: Set<string>;
}

export interface SemanticSceneValidationOptions {
  /**
   * Optional map, record, or lookup function for audio asset durations (in seconds).
   * Used to diagnose audio playback window truncations when durations are known.
   */
  readonly audioDurations?:
    | ReadonlyMap<string, number>
    | Record<string, number>
    | ((assetPath: string) => number | undefined);
}

export function validateSemanticSceneStructure(
  document: CurrentSceneDocument,
  options?: SemanticSceneValidationOptions,
): SemanticValidationIssue[] {
  const issues: SemanticValidationIssue[] = [];
  const characterIds = new Set((document.meta.characters ?? []).map((character) => character.id));
  if (!document.meta.title?.trim()) issues.push({ severity: 'warning', message: '场景缺少标题' });
  if ((document.meta.characters?.length ?? 0) === 0) issues.push({ severity: 'warning', message: '场景未声明角色' });
  if (document.statements.length === 0) issues.push({ severity: 'warning', message: '语义时间轴为空' });
  validateCharacterAssetReferences(document, issues);
  for (const filterIssue of validateLensFilterStatements(document)) {
    issues.push({
      severity: 'error',
      message: filterIssue.message,
      actionId: filterIssue.statementId,
      actionType: filterIssue.type,
    });
  }

  const contexts = collectStatementValidationContexts(document);
  const seenMotion = new Map<string, { motion: string; time: number; statementId: string }>();
  for (const context of contexts) {
    const statement = context.statement;
    validateStatementReferences(
      statement,
      characterIds,
      issues,
      context.isCompanion ? statement.id : undefined,
      context.actionId,
      context.actionType,
    );
    if (statement.type === 'characterPerformance') {
      const motionKey = motionKeyOf(statement.params.motion);
      if (motionKey !== undefined) {
        const key = `${statement.params.target}\u0000${motionKey}`;
        const previous = seenMotion.get(key);
        if (previous && statement.time - previous.time < 30) {
          issues.push({
            severity: 'warning',
            message: `角色 ${statement.params.target} 在 ${Math.round(statement.time - previous.time)} 秒内重复动作 ${motionKey}`,
            actionId: statement.id,
            actionType: statement.type,
          });
        }
        seenMotion.set(key, { motion: motionKey, time: statement.time, statementId: statement.id });
      }
    }
  }

  validateSemanticVisualStatements(contexts, characterIds, issues);
  validateCharacterOrdering(contexts, issues);
  validateSemanticAudioStatements(contexts, issues, options);
  return issues;
}

function motionKeyOf(motion: CharacterPerformanceParams['motion']): string | undefined {
  if (!motion || typeof motion !== 'object') return undefined;
  return motion.kind === 'resource' ? motion.key : motion.derivedFrom.key;
}

function collectStatementValidationContexts(document: CurrentSceneDocument): StatementValidationContext[] {
  const contexts: StatementValidationContext[] = [];
  document.statements.forEach((statement, sourceOrder) => {
    contexts.push({
      statement,
      actionId: statement.id,
      actionType: statement.type,
      location: statementLocation(statement.id),
      isCompanion: false,
      sourceOrder,
      companionOrder: 0,
    });

    statement.companions?.forEach((companion, companionIndex) => {
      const companionTime = statement.time
        + (companion.anchor === 'end' ? sceneStatementDefinitionRegistry.temporalExtent(statement) : 0)
        + companion.offset;
      contexts.push({
        statement: {
          id: companion.id,
          time: companionTime,
          type: companion.type,
          params: companion.params,
        } as SceneStatement,
        actionId: statement.id,
        actionType: companion.type,
        location: companionLocation(statement.id, companion.id),
        isCompanion: true,
        sourceOrder,
        companionOrder: companionIndex + 1,
      });
    });
  });
  return contexts;
}

function validateStatementReferences(
  statement: SceneStatement,
  characterIds: ReadonlySet<string>,
  issues: SemanticValidationIssue[],
  companionId?: string,
  actionId = statement.id,
  actionType: SceneStatement['type'] = statement.type,
): void {
  const target = getCharacterTarget(statement);
  if (target && statement.type !== 'camera' && target !== '$speaker' && !characterIds.has(target)) {
    issues.push({
      severity: 'warning',
      message: `${companionId ? `Companion ${companionId}` : '语句'} 引用了不存在的角色 ${target}`,
      actionId,
      actionType,
    });
  }
  for (const asset of sceneStatementDefinitionRegistry.collectAssetReferences(statement)) {
    appendAssetPathIssue(issues, assetLabelForStatement(statement, asset.path), asset.value, actionId, actionType);
  }
  for (const slot of collectStatementAssetSlots(statement)) {
    appendAssetPathIssue(issues, slot.label, slot.value, actionId, actionType);
  }
}

function getCharacterTarget(statement: SceneStatement): string | undefined {
  const params = statement.params as unknown as Record<string, unknown>;
  if (statement.type === 'dialogue') return typeof params.speakerId === 'string' ? params.speakerId : undefined;
  if (statement.type === 'characterPresence' || statement.type === 'characterTransform') return typeof params.id === 'string' ? params.id : undefined;
  if (statement.type === 'characterPerformance') return typeof params.target === 'string' ? params.target : undefined;
  if (statement.type === 'camera' && (params.mode === 'focus' || params.mode === 'follow' || params.mode === 'hitchcock')) {
    return typeof params.target === 'string' ? params.target : undefined;
  }
  return undefined;
}

function validateSemanticVisualStatements(
  contexts: readonly StatementValidationContext[],
  characterIds: ReadonlySet<string>,
  issues: SemanticValidationIssue[],
): void {
  let activeFollow: ActiveFollow | undefined;
  const lightingState = createLightingValidationState();
  // Environment layer IDs are declarations, not an active-time lookup. A
  // valid post target may be applied before its layer enters the stage; the
  // runtime retains that action and applies it when the layer appears.
  const environmentLayerIds = new Set<string>(['background']);
  for (const context of contexts) {
    if (context.statement.type !== 'environmentLayer') continue;
    const layerId = context.statement.params.layerId;
    if (hasNonEmptyString(layerId)) environmentLayerIds.add(layerId);
  }
  let environmentLayers = new Map<string, EnvironmentLayerCoverage>();
  let environmentOrder = 0;
  let cameraZoom = 1;
  let cameraRotation = 0;
  const orderedContexts = [...contexts].sort((left, right) => (
    left.statement.time - right.statement.time
    || left.sourceOrder - right.sourceOrder
    || left.companionOrder - right.companionOrder
  ));

  for (const context of orderedContexts) {
    if (context.statement.type === 'environmentLayer') {
      environmentLayers = updateEnvironmentLayerCoverage(environmentLayers, context.statement, environmentOrder++);
      continue;
    }
    if (context.statement.type === 'camera') {
      const bottom = bottommostEnvironmentLayer(environmentLayers);
      validateCameraCoverage(context, bottom, cameraZoom, cameraRotation, issues);
      const next = validateCameraStatement(context, characterIds, activeFollow, cameraZoom, cameraRotation, issues);
      activeFollow = next.follow;
      cameraZoom = next.zoom;
      cameraRotation = next.rotation;
    } else if (context.statement.type === 'lighting') {
      validateLightingStatement(context, lightingState, characterIds, environmentLayerIds, issues);
    }
  }
}

function updateEnvironmentLayerCoverage(
  layers: ReadonlyMap<string, EnvironmentLayerCoverage>,
  statement: Extract<SceneStatement, { type: 'environmentLayer' }>,
  order: number,
): Map<string, EnvironmentLayerCoverage> {
  const next = new Map(layers);
  if (statement.params.mode === 'remove') {
    next.delete(statement.params.layerId);
    return next;
  }
  const current = next.get(statement.params.layerId);
  const isSet = statement.params.mode === 'set';
  next.set(statement.params.layerId, {
    x: statement.params.position?.[0] ?? (isSet ? 0.5 : current?.x ?? 0.5),
    y: statement.params.position?.[1] ?? (isSet ? 0.5 : current?.y ?? 0.5),
    scale: statement.params.scale ?? (isSet ? 1 : current?.scale ?? 1),
    rotation: statement.params.rotation ?? (isSet ? 0 : current?.rotation ?? 0),
    z: statement.params.z ?? current?.z ?? 0,
    order: current?.order ?? order,
  });
  return next;
}

/** The bottom-most active environment layer is the backdrop (lowest z, then insertion order). */
function bottommostEnvironmentLayer(
  layers: ReadonlyMap<string, EnvironmentLayerCoverage>,
): { readonly layerId: string; readonly coverage: EnvironmentLayerCoverage } | undefined {
  let bottom: { readonly layerId: string; readonly coverage: EnvironmentLayerCoverage } | undefined;
  for (const [layerId, coverage] of layers) {
    if (
      bottom === undefined
      || coverage.z < bottom.coverage.z
      || (coverage.z === bottom.coverage.z && coverage.order < bottom.coverage.order)
    ) {
      bottom = { layerId, coverage };
    }
  }
  return bottom;
}

function rotatedHalfExtent(scale: number, rotationDegrees: number): number {
  const theta = (rotationDegrees * Math.PI) / 180;
  return (scale * (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta)))) / 2;
}

function validateCameraCoverage(
  context: StatementValidationContext,
  backdrop: { readonly layerId: string; readonly coverage: EnvironmentLayerCoverage } | undefined,
  cameraZoom: number,
  cameraRotation: number,
  issues: SemanticValidationIssue[],
): void {
  if (backdrop === undefined) return;
  if (!Number.isFinite(cameraZoom) || cameraZoom <= 0) return;
  const params = context.statement.params as CameraParams;
  const { x: backgroundX, y: backgroundY, scale: backgroundScale, rotation: backgroundRotation } = backdrop.coverage;
  const backgroundHalfExtent = rotatedHalfExtent(backgroundScale, backgroundRotation);

  if (params.mode === 'focus') {
    // Focus with a character target derives its position from the character
    // and is clamped by the runtime; only explicit pan points are checked.
    if (params.target !== undefined || params.position === undefined) return;
    assertCameraPositionCoverage(
      context,
      params.position,
      backdrop.layerId,
      backgroundX,
      backgroundY,
      backgroundHalfExtent,
      applyZoomIntent(cameraZoom, params.zoom),
      params.rotation ?? cameraRotation,
      issues,
    );
    return;
  }
  if (params.mode === 'move') {
    const target = params.to ?? params.position;
    if (target === undefined) return;
    assertCameraPositionCoverage(
      context,
      target,
      backdrop.layerId,
      backgroundX,
      backgroundY,
      backgroundHalfExtent,
      applyZoomIntent(cameraZoom, params.zoom),
      params.rotation ?? cameraRotation,
      issues,
    );
    return;
  }
  if (params.mode === 'path') {
    let zoom = cameraZoom;
    let rotation = cameraRotation;
    for (const keyframe of [...params.keyframes].sort((left, right) => left.time - right.time)) {
      if (keyframe.zoom !== undefined) zoom = keyframe.zoom;
      if (keyframe.rotation !== undefined) rotation = keyframe.rotation;
      if (keyframe.position === undefined) continue;
      assertCameraPositionCoverage(
        context,
        keyframe.position,
        backdrop.layerId,
        backgroundX,
        backgroundY,
        backgroundHalfExtent,
        zoom,
        rotation,
        issues,
      );
    }
  }
}

function applyZoomIntent(current: number, zoom: { kind: 'absolute' | 'delta'; value: number } | undefined): number {
  if (!zoom) return current;
  return zoom.kind === 'absolute' ? zoom.value : current + zoom.value;
}

function assertCameraPositionCoverage(
  context: StatementValidationContext,
  position: Vec2,
  layerId: string,
  backgroundX: number,
  backgroundY: number,
  backgroundHalfExtent: number,
  zoom: number,
  rotationDegrees: number,
  issues: SemanticValidationIssue[],
): void {
  if (!Number.isFinite(zoom) || zoom <= 0) return;
  const halfView = rotatedHalfExtent(1 / zoom, rotationDegrees);
  const epsilon = 1e-6;
  const [px, py] = position;
  const insideX = Math.abs(px - backgroundX) <= backgroundHalfExtent - halfView + epsilon;
  const insideY = Math.abs(py - backgroundY) <= backgroundHalfExtent - halfView + epsilon;
  if (insideX && insideY) return;
  issues.push({
    severity: 'warning',
    message: `镜头运镜至 (${roundNumber(px)}, ${roundNumber(py)}) 超出最底部环境图层「${layerId}」的覆盖范围（zoom ${roundNumber(zoom)}、图层覆盖 ${roundNumber(backgroundHalfExtent * 2)}），画面边缘会出现黑边；请放大 zoom、扩大该图层 scale 或减小平移幅度。`,
    actionId: context.actionId,
    actionType: context.actionType,
    code: SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraBlackEdge,
    location: `${context.location}.params`,
  });
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function validateCharacterOrdering(
  contexts: readonly StatementValidationContext[],
  issues: SemanticValidationIssue[],
): void {
  const orderedContexts = [...contexts].sort(
    (left, right) => left.statement.time - right.statement.time
      || left.sourceOrder - right.sourceOrder
      || left.companionOrder - right.companionOrder,
  );

  const segmentsByCharacter = new Map<string, CharacterPresenceSegment[]>();
  const openSegmentByCharacter = new Map<string, CharacterPresenceSegment>();
  for (const context of orderedContexts) {
    const params = context.statement.params as CharacterPresenceParams;
    if (context.statement.type !== 'characterPresence' || !hasNonEmptyString(params.id)) continue;
    const id = params.id;
    if (params.mode === 'enter') {
      if (openSegmentByCharacter.has(id)) {
        issues.push({
          severity: 'error',
          message: `角色「${id}」在退场前再次登场（第 ${Math.round(context.statement.time)} 秒），同一角色登场期间不能重复登场。`,
          actionId: context.actionId,
          actionType: context.actionType,
          code: SEMANTIC_CHARACTER_ORDERING_CODES.duplicateEntrance,
          location: context.location,
        });
      } else {
        const segment: CharacterPresenceSegment = {
          enterTime: context.statement.time,
          exitTime: undefined,
        };
        openSegmentByCharacter.set(id, segment);
        const segments = segmentsByCharacter.get(id);
        if (segments) segments.push(segment);
        else segmentsByCharacter.set(id, [segment]);
      }
    } else if (params.mode === 'exit') {
      const openSegment = openSegmentByCharacter.get(id);
      if (openSegment) openSegment.exitTime = context.statement.time;
      openSegmentByCharacter.delete(id);
    }
  }

  for (const context of contexts) {
    const target = characterActionTarget(context.statement);
    if (!target || target === '$speaker') continue;
    const label = sceneStatementDefinitionRegistry.timelinePresentation(context.statement).label;
    const segments = segmentsByCharacter.get(target);
    if (!segments) {
      issues.push({
        severity: 'warning',
        message: `角色「${target}」的「${label}」没有对应的登场步骤，登场前无法执行。`,
        actionId: context.actionId,
        actionType: context.actionType,
        code: SEMANTIC_CHARACTER_ORDERING_CODES.actionWithoutEntrance,
        location: context.location,
      });
      continue;
    }
    const time = context.statement.time;
    const withinPresence = segments.some((segment) => (
      time >= segment.enterTime
      && (segment.exitTime === undefined || time <= segment.exitTime)
    ));
    if (withinPresence) continue;
    const nextEnter = segments.find((segment) => segment.enterTime > time);
    issues.push({
      severity: 'error',
      message: nextEnter
        ? `角色「${target}」的「${label}」发生时角色不在舞台上，下一次登场在第 ${Math.round(nextEnter.enterTime)} 秒。`
        : `角色「${target}」的「${label}」发生时角色不在舞台上，该角色之后没有再次登场。`,
      actionId: context.actionId,
      actionType: context.actionType,
      code: SEMANTIC_CHARACTER_ORDERING_CODES.actionBeforeEntrance,
      location: context.location,
    });
  }
}

function characterActionTarget(statement: SceneStatement): string | undefined {
  const params = statement.params as unknown as Record<string, unknown>;
  if (statement.type === 'characterPresence') {
    if (params.mode !== 'exit') return undefined;
    return typeof params.id === 'string' ? params.id : undefined;
  }
  if (statement.type === 'characterTransform') {
    return typeof params.id === 'string' ? params.id : undefined;
  }
  if (statement.type === 'characterPerformance') {
    return typeof params.target === 'string' ? params.target : undefined;
  }
  return undefined;
}
function validateCameraStatement(
  context: StatementValidationContext,
  characterIds: ReadonlySet<string>,
  activeFollow: ActiveFollow | undefined,
  zoom: number,
  rotation: number,
  issues: SemanticValidationIssue[],
): CameraFrameValidation {
  const params = context.statement.params as CameraParams;

  if (activeFollow && params.mode !== 'follow' && cameraStatementWritesPosition(params)) {
    appendVisualIssue(
      issues,
      context,
      SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraFollowPositionConflict,
      undefined,
      `镜头跟随「${activeFollow.target}」仍处于活动状态，不能同时写入镜头位置。请先停止跟随。`,
    );
  }

  switch (params.mode) {
    case 'focus':
      if (params.target === undefined && params.position === undefined) {
        appendVisualIssue(
          issues,
          context,
          SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraFocusMissingTarget,
          undefined,
          '镜头对焦缺少目标，请提供有效角色 ID 或 position。',
        );
      }
      if (params.target !== undefined) {
        validateCameraCharacterTarget(context, params.target, characterIds, issues);
      }
      return {
        follow: activeFollow,
        zoom: applyZoomIntent(zoom, params.zoom),
        rotation: params.rotation ?? rotation,
      };
    case 'move':
      validateCameraMove(context, params, issues);
      return {
        follow: activeFollow,
        zoom: applyZoomIntent(zoom, params.zoom),
        rotation: params.rotation ?? rotation,
      };
    case 'path':
      validateCameraPath(context, params, issues);
      return {
        follow: activeFollow,
        zoom: lastPathFrameZoom(params, zoom),
        rotation: lastPathFrameRotation(params, rotation),
      };
    case 'follow':
      if (params.operation === 'stop') {
        // Runtime follow stop compiles to cameraReset, restoring defaults.
        return {
          follow: validateCameraFollow(context, params, characterIds, activeFollow, issues),
          zoom: 1,
          rotation: 0,
        };
      }
      return {
        follow: validateCameraFollow(context, params, characterIds, activeFollow, issues),
        zoom,
        rotation,
      };
    case 'hitchcock':
      validateCameraCharacterTarget(context, params.target, characterIds, issues);
      return {
        follow: activeFollow,
        zoom: params.zoomEnd,
        rotation,
      };
    case 'reset':
      return {
        follow: undefined,
        zoom: 1,
        rotation: 0,
      };
    case 'shake':
      return {
        follow: activeFollow,
        zoom,
        rotation,
      };
  }
}

function lastPathFrameZoom(
  params: Extract<CameraParams, { mode: 'path' }>,
  fallback: number,
): number {
  let zoom = fallback;
  for (const keyframe of params.keyframes) {
    if (keyframe.zoom !== undefined) zoom = keyframe.zoom;
  }
  return zoom;
}

function lastPathFrameRotation(
  params: Extract<CameraParams, { mode: 'path' }>,
  fallback: number,
): number {
  let rotation = fallback;
  for (const keyframe of params.keyframes) {
    if (keyframe.rotation !== undefined) rotation = keyframe.rotation;
  }
  return rotation;
}

function validateCameraMove(
  context: StatementValidationContext,
  params: Extract<CameraParams, { mode: 'move' }>,
  issues: SemanticValidationIssue[],
): void {
  const hasTransform = params.position !== undefined
    || params.to !== undefined
    || params.zoom !== undefined
    || params.rotation !== undefined;
  if (!hasTransform) {
    appendVisualIssue(
      issues,
      context,
      SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraMoveMissingOperation,
      undefined,
      '镜头移动缺少可执行的变换，请提供 position、to、zoom 或 rotation。',
    );
  }
}

function validateCameraPath(
  context: StatementValidationContext,
  params: Extract<CameraParams, { mode: 'path' }>,
  issues: SemanticValidationIssue[],
): void {
  if (!Array.isArray(params.keyframes) || params.keyframes.length < 2) {
    appendVisualIssue(
      issues,
      context,
      SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraPathMissingKeyframes,
      'keyframes',
      '镜头路径至少需要两个关键帧。',
    );
    return;
  }
  const hasExecutableValue = params.keyframes.some((keyframe) => (
    keyframe.position !== undefined
    || keyframe.zoom !== undefined
    || keyframe.rotation !== undefined
  ));
  if (!hasExecutableValue) {
    appendVisualIssue(
      issues,
      context,
      SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraPathMissingValues,
      'keyframes',
      '镜头路径没有可执行的关键帧值，请至少提供 position、zoom 或 rotation。',
    );
  }
}

function validateCameraFollow(
  context: StatementValidationContext,
  params: Extract<CameraParams, { mode: 'follow' }>,
  characterIds: ReadonlySet<string>,
  activeFollow: ActiveFollow | undefined,
  issues: SemanticValidationIssue[],
): ActiveFollow | undefined {
  const hasTarget = Object.prototype.hasOwnProperty.call(params, 'target');
  if (params.operation === 'start') {
    if (!hasTarget || params.target === undefined || !hasNonEmptyString(params.target)) {
      appendVisualIssue(
        issues,
        context,
        SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraFollowMissingTarget,
        'target',
        '镜头跟随启动缺少目标，请提供有效角色 ID。',
      );
    } else {
      validateCameraCharacterTarget(context, params.target, characterIds, issues);
    }
    if (activeFollow) {
      appendVisualIssue(
        issues,
        context,
        SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraFollowOverlap,
        'operation',
        `镜头跟随「${activeFollow.target}」尚未停止，不能启动新的跟随目标。`,
      );
    }
    return params.target && hasNonEmptyString(params.target)
      ? { target: params.target }
      : undefined;
  }

  if (hasTarget && params.target !== undefined && !hasNonEmptyString(params.target)) {
    appendVisualIssue(
      issues,
      context,
      SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraTargetEmpty,
      'target',
      '镜头跟随停止目标为空；请移除该字段以停止当前跟随，或提供有效角色 ID。',
    );
  } else if (hasTarget && params.target !== undefined) {
    validateCameraCharacterTarget(context, params.target, characterIds, issues);
  }

  if (!activeFollow) {
    appendVisualIssue(
      issues,
      context,
      SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraFollowStopWithoutActiveTarget,
      'operation',
      '镜头跟随停止没有对应的活动跟随目标。',
    );
  } else if (params.target !== undefined && hasNonEmptyString(params.target) && params.target !== activeFollow.target) {
    appendVisualIssue(
      issues,
      context,
      SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraFollowStopTargetMismatch,
      'target',
      `镜头跟随停止目标「${params.target}」与活动目标「${activeFollow.target}」不一致。`,
    );
  }
  return undefined;
}

function validateCameraCharacterTarget(
  context: StatementValidationContext,
  target: unknown,
  characterIds: ReadonlySet<string>,
  issues: SemanticValidationIssue[],
): void {
  if (!hasNonEmptyString(target)) {
    appendVisualIssue(
      issues,
      context,
      SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraTargetEmpty,
      'target',
      '镜头目标为空，请提供有效角色 ID。',
    );
    return;
  }
  if (target === '$speaker' && !context.isCompanion) {
    appendVisualIssue(
      issues,
      context,
      SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraTargetUnknown,
      'target',
      '镜头目标 $speaker 只能用于对白 companion。',
    );
    return;
  }
  if (target !== '$speaker' && !characterIds.has(target as string)) {
    appendVisualIssue(
      issues,
      context,
      SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraTargetUnknown,
      'target',
      `镜头目标引用了不存在的角色「${target as string}」。`,
    );
  }
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

function createLightingValidationState(): LightingValidationState {
  return {
    singletonEffects: new Set(),
    blurTargets: new Set(),
    overlayIds: new Set(),
    pointLightIds: new Set(),
  };
}

function validateLightingStatement(
  context: StatementValidationContext,
  state: LightingValidationState,
  characterIds: ReadonlySet<string>,
  environmentLayerIds: ReadonlySet<string>,
  issues: SemanticValidationIssue[],
): void {
  const params = context.statement.params as LightingParams;
  switch (params.effect) {
    case 'preset':
      if (params.mode === 'reset') {
        validateLightingReset(context, 'preset', '灯光预设', state.singletonEffects, issues);
      } else if (!hasNonEmptyString(params.preset)) {
        appendVisualIssue(
          issues,
          context,
          SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingPresetMissing,
          'preset',
          '灯光预设为空，请提供有效预设名称。',
        );
      } else {
        state.singletonEffects.add('preset');
      }
      return;
    case 'blur': {
      const rawTarget = params.target as unknown;
      if (rawTarget !== undefined && !hasNonEmptyString(rawTarget)) {
        appendVisualIssue(
          issues,
          context,
          SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingBlurTargetEmpty,
          'target',
          '模糊目标为空，请提供 global、background 或 characters。',
        );
        return;
      }
      const target = (rawTarget ?? 'global') as 'global' | 'background' | 'characters';
      if (params.mode === 'reset') {
        validateLightingReset(context, 'blur', `模糊「${target}」`, state.blurTargets, issues, target);
      } else {
        state.blurTargets.add(target);
      }
      return;
    }
    case 'godrays':
      if (params.mode === 'reset') {
        validateLightingReset(context, 'godrays', '体积光', state.singletonEffects, issues);
      } else {
        if (params.intensity === undefined && params.angle === undefined && params.lacunarity === undefined) {
          appendVisualIssue(
            issues,
            context,
            SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingGodraysMissingValues,
            undefined,
            '体积光缺少可应用的参数，请提供 intensity、angle 或 lacunarity。',
          );
        }
        state.singletonEffects.add('godrays');
      }
      return;
    case 'post':
      validateLightingPostTarget(context, params.target, characterIds, environmentLayerIds, issues);
      {
        const target = hasNonEmptyString(params.target) ? params.target : 'panorama';
        const stateKey = `post:${target}`;
        if (params.mode === 'reset') {
          validateLightingReset(context, stateKey, `后期处理「${target}」`, state.singletonEffects, issues);
        } else {
          state.singletonEffects.add(stateKey);
        }
      }
      return;
    case 'overlay':
      if (params.mode === 'clear') {
        state.overlayIds.clear();
        return;
      }
      validateLightingCollectionResource(
        context,
        params.mode,
        params.id,
        '色彩叠加',
        state.overlayIds,
        SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingOverlayMissingId,
        SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingOverlayMissingResource,
        issues,
      );
      return;
    case 'pointLight':
      if (params.mode === 'clear') {
        state.pointLightIds.clear();
        return;
      }
      validateLightingCollectionResource(
        context,
        params.mode,
        params.id,
        '点光源',
        state.pointLightIds,
        SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingPointLightMissingId,
        SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingPointLightMissingResource,
        issues,
      );
      return;
  }
}

function validateLightingPostTarget(
  context: StatementValidationContext,
  rawTarget: unknown,
  characterIds: ReadonlySet<string>,
  environmentLayerIds: ReadonlySet<string>,
  issues: SemanticValidationIssue[],
): void {
  if (rawTarget === undefined) return;
  if (!hasNonEmptyString(rawTarget)) {
    appendVisualIssue(
      issues,
      context,
      SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingPostTargetEmpty,
      'target',
      '后期处理目标为空，请提供 panorama、角色 ID 或环境图层 ID。',
    );
    return;
  }

  const target = rawTarget as string;
  if (target === 'panorama' || characterIds.has(target) || environmentLayerIds.has(target)) return;
  appendVisualIssue(
    issues,
    context,
    SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingPostTargetUnknown,
    'target',
    `后期处理目标「${target}」不是 panorama、已声明角色或已声明环境图层。`,
  );
}

function validateLightingReset<T extends string>(
  context: StatementValidationContext,
  effect: string,
  label: string,
  activeResources: Set<T>,
  issues: SemanticValidationIssue[],
  target?: T,
): void {
  const resource = target ?? effect as T;
  if (!activeResources.has(resource)) {
    appendVisualIssue(
      issues,
      context,
      SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingResetWithoutActiveResource,
      'mode',
      `重置${label}时没有对应的活动资源。`,
    );
  }
  activeResources.delete(resource);
}

function validateLightingCollectionResource(
  context: StatementValidationContext,
  mode: string,
  id: unknown,
  label: string,
  activeResources: Set<string>,
  missingIdCode: string,
  missingResourceCode: string,
  issues: SemanticValidationIssue[],
): void {
  if (!hasNonEmptyString(id)) {
    appendVisualIssue(
      issues,
      context,
      missingIdCode,
      'id',
      `${label}缺少 ID，请提供非空的稳定资源 ID。`,
    );
    return;
  }

  const resourceId = id as string;
  if (mode === 'set') {
    activeResources.add(resourceId);
    return;
  }
  if (mode === 'modulate') {
    if (!activeResources.has(resourceId)) {
      appendVisualIssue(
        issues,
        context,
        missingResourceCode,
        'id',
        `${label}「${resourceId}」尚未设置，无法调制。`,
      );
    }
    return;
  }
  if (mode === 'remove') {
    if (!activeResources.has(resourceId)) {
      appendVisualIssue(
        issues,
        context,
        missingResourceCode,
        'id',
        `${label}「${resourceId}」不存在，无法移除。`,
      );
    }
    activeResources.delete(resourceId);
    return;
  }
  activeResources.clear();
}

function appendVisualIssue(
  issues: SemanticValidationIssue[],
  context: StatementValidationContext,
  code: string,
  field: string | undefined,
  message: string,
): void {
  issues.push({
    severity: 'error',
    message,
    actionId: context.actionId,
    actionType: context.actionType,
    code,
    location: `${context.location}.params${field ? `.${field}` : ''}`,
  });
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function statementLocation(statementId: string): string {
  return `scene.statements[${JSON.stringify(statementId)}]`;
}

function companionLocation(statementId: string, companionId: string): string {
  return `${statementLocation(statementId)}.companions[${JSON.stringify(companionId)}]`;
}

function validateCharacterAssetReferences(
  document: CurrentSceneDocument,
  issues: ValidationIssue[],
): void {
  for (const character of document.meta.characters ?? []) {
    if (character.model !== undefined) {
      appendAssetPathIssue(issues, `角色「${character.name || character.id}」模型资源`, character.model);
    }
    for (const variant of character.variants ?? []) {
      appendAssetPathIssue(issues, `角色「${character.name || character.id}」变体「${variant.name}」模型资源`, variant.model);
    }
  }
}

function collectStatementAssetSlots(statement: SceneStatement): AssetDiagnosticSlot[] {
  const params = statement.params as unknown as Record<string, unknown>;
  switch (statement.type) {
    case 'dialogue':
      return Object.prototype.hasOwnProperty.call(params, 'voice')
        ? [{ label: '对白语音资源', value: params.voice }]
        : [];
    case 'characterPresence':
      return Object.prototype.hasOwnProperty.call(params, 'model')
        ? [{ label: '角色模型资源', value: params.model }]
        : [];
    case 'environmentLayer':
      if (params.mode === 'set') {
        const slots: AssetDiagnosticSlot[] = [];
        if (Object.prototype.hasOwnProperty.call(params, 'file')) {
          slots.push({ label: '环境画面资源', value: params.file });
        }
        if (Object.prototype.hasOwnProperty.call(params, 'image')) {
          slots.push({ label: '环境画面资源', value: params.image });
        }
        return slots.length > 0 ? slots : [{ label: '环境画面资源', value: '' }];
      }
      return ['file', 'image']
        .filter((key) => Object.prototype.hasOwnProperty.call(params, key))
        .map((key) => ({ label: '环境图层资源', value: params[key] }));
    case 'audio':
      if (params.mode !== 'play') return [];
      return [{
        label: params.role === 'bgm' ? '背景音乐资源' : '音效资源',
        value: params.file,
      }];
    case 'graphicLayer':
      if (params.kind !== 'image') return [];
      if (params.mode === 'set') return [{ label: '图片图层资源', value: params.file ?? '' }];
      return Object.prototype.hasOwnProperty.call(params, 'file')
        ? [{ label: '图片图层资源', value: params.file }]
        : [];
    case 'customAnimation':
      return ['file', 'animation']
        .filter((key) => Object.prototype.hasOwnProperty.call(params, key))
        .map((key) => ({ label: '自定义动画资源', value: params[key] }));
    default:
      return [];
  }
}

function assetLabelForStatement(statement: SceneStatement, path: string): string {
  if (statement.type === 'dialogue' && path === 'params.voice') return '对白语音资源';
  if (statement.type === 'characterPresence' && path === 'params.model') return '角色模型资源';
  if (statement.type === 'environmentLayer') return '环境画面资源';
  if (statement.type === 'audio') return statement.params.role === 'bgm' ? '背景音乐资源' : '音效资源';
  if (statement.type === 'graphicLayer') return '图片图层资源';
  if (statement.type === 'customAnimation') return '自定义动画资源';
  return '资源路径';
}

function appendAssetPathIssue(
  issues: ValidationIssue[],
  label: string,
  value: unknown,
  actionId?: string,
  actionType?: string,
): void {
  const message = describeAssetPathIssue(label, value);
  if (!message) return;
  const duplicate = issues.some((issue) => (
    issue.severity === 'error'
    && issue.message === message
    && issue.actionId === actionId
    && issue.actionType === actionType
  ));
  if (duplicate) return;
  issues.push({
    severity: 'error',
    message,
    actionId,
    actionType,
  });
}

function describeAssetPathIssue(label: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return `${label}为空，请选择或输入资源路径。`;
  const normalized = value.replace(/\\/g, '/').trim();
  if (/^data:/i.test(normalized)) return `${label}使用 data URI，不能作为剧本资源路径：${value}`;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized) || normalized.startsWith('//')) {
    return `${label}使用 URL/协议路径，不能作为剧本资源路径：${value}`;
  }
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) {
    return `${label}使用本机绝对路径，需导入项目或改为 @mount/ 引用：${value}`;
  }
  if (normalized.startsWith('@mount/')) {
    const [, mountId, ...relativeSegments] = normalized.split('/');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(mountId ?? '') || relativeSegments.join('/').trim() === '') {
      return `${label}使用无效挂载资源引用：${value}`;
    }
    return validateRelativeSegments(label, relativeSegments, value);
  }
  return validateRelativeSegments(label, normalized.split('/'), value);
}

function validateRelativeSegments(label: string, segments: string[], originalValue: string): string | null {
  let depth = 0;
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) return `${label}逃逸项目资源根目录：${originalValue}`;
      continue;
    }
    depth += 1;
  }
  return null;
}

const MIN_AUDIO_GAP_SECONDS = 0.05;

function resolveAudioDurationFromOptions(
  reference: string,
  audioDurations: SemanticSceneValidationOptions['audioDurations'],
): number | undefined {
  if (!audioDurations) return undefined;
  if (typeof audioDurations === 'function') {
    const d = audioDurations(reference);
    return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : undefined;
  }
  const normalized = reference.replace(/\\/g, '/');
  if (audioDurations instanceof Map) {
    const d = audioDurations.get(reference) ?? audioDurations.get(normalized);
    return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : undefined;
  }
  if (typeof audioDurations === 'object') {
    const map = audioDurations as Record<string, number>;
    const d = map[reference] ?? map[normalized];
    return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : undefined;
  }
  return undefined;
}

function resolveVoiceDuration(
  voice: string,
  params: Record<string, unknown>,
  options?: SemanticSceneValidationOptions,
): number | undefined {
  if (typeof params.voiceDuration === 'number' && Number.isFinite(params.voiceDuration) && params.voiceDuration > 0) {
    return params.voiceDuration;
  }
  if (typeof params.voiceDurationSeconds === 'number' && Number.isFinite(params.voiceDurationSeconds) && params.voiceDurationSeconds > 0) {
    return params.voiceDurationSeconds;
  }
  if (typeof params.audioDuration === 'number' && Number.isFinite(params.audioDuration) && params.audioDuration > 0) {
    return params.audioDuration;
  }
  return resolveAudioDurationFromOptions(voice, options?.audioDurations);
}

function validateSemanticAudioStatements(
  contexts: readonly StatementValidationContext[],
  issues: SemanticValidationIssue[],
  options?: SemanticSceneValidationOptions,
): void {
  for (const context of contexts) {
    if (context.statement.type === 'dialogue') {
      const p = context.statement.params as unknown as Record<string, unknown>;
      const voice = typeof p.voice === 'string' ? p.voice.trim() : '';
      const rawDuration = typeof p.durationSeconds === 'number'
        ? p.durationSeconds
        : (typeof (p as Record<string, unknown>).duration === 'number'
          ? (p as Record<string, unknown>).duration as number
          : undefined);

      if (voice !== '') {
        if (p.lipSync === false || p.lipSync === 'none') {
          issues.push({
            severity: 'warning',
            code: SEMANTIC_AUDIO_DIAGNOSTIC_CODES.dialogueVoiceLipSyncDisabled,
            message: '对白设置了语音但 lipSync 为 none，角色不会跟随语音做口型同步。',
            actionId: context.actionId,
            actionType: context.actionType,
            location: `${context.location}.params.lipSync`,
          });
        }
        const voiceDuration = resolveVoiceDuration(voice, p, options);
        if (
          rawDuration !== undefined &&
          Number.isFinite(rawDuration) &&
          rawDuration > 0 &&
          voiceDuration !== undefined &&
          voiceDuration > rawDuration
        ) {
          issues.push({
            severity: 'warning',
            code: SEMANTIC_AUDIO_DIAGNOSTIC_CODES.dialogueVoiceWindowTruncated,
            message: `对白语音 "${p.voice}" 会被当前 dialogue.duration (${rawDuration}s) 作为播放窗口限制；语音文件时长 (${voiceDuration}s) 超过该播放窗口，会在对白结束时被截断。`,
            actionId: context.actionId,
            actionType: context.actionType,
            location: `${context.location}.params.voice`,
          });
        }
        if (rawDuration !== undefined && rawDuration <= 0) {
          issues.push({
            severity: 'warning',
            code: SEMANTIC_AUDIO_DIAGNOSTIC_CODES.dialogueVoiceDurationInvalid,
            message: '对白语音会使用 dialogue.duration 作为播放窗口，当前时长无效会导致语音无法正常调度。',
            actionId: context.actionId,
            actionType: context.actionType,
            location: `${context.location}.params.durationSeconds`,
          });
        }
      }

      const companions = context.statement.companions ?? [];
      for (const companion of companions) {
        if (companion.type === 'audio') {
          const compParams = companion.params as unknown as Record<string, unknown>;
          if (compParams.role === 'sfx' && compParams.mode === 'play') {
            const compDuration = typeof compParams.durationSeconds === 'number' && Number.isFinite(compParams.durationSeconds)
              ? compParams.durationSeconds
              : 0;
            const dialogueDuration = rawDuration !== undefined && Number.isFinite(rawDuration) ? rawDuration : 0;
            const offset = typeof companion.offset === 'number' && Number.isFinite(companion.offset) ? companion.offset : 0;
            const startOffset = companion.anchor === 'end' ? dialogueDuration + offset : offset;
            const endOffset = startOffset + compDuration;
            if (companion.anchor === 'start' && endOffset > dialogueDuration) {
              issues.push({
                severity: 'warning',
                code: SEMANTIC_AUDIO_DIAGNOSTIC_CODES.companionAudioExceedsDialogue,
                message: `伴随音效 "${compParams.file ?? ''}" 的播放范围超过了对白持续时间 (${dialogueDuration}s)，可能在对白结束后继续播放或被截断。`,
                actionId: context.actionId,
                actionType: companion.type,
                location: `${companionLocation(context.statement.id, companion.id)}.params.durationSeconds`,
              });
            }
          }
        }
      }
    }
  }

  const dialoguesWithVoice = contexts
    .filter((c) => !c.isCompanion && c.statement.type === 'dialogue')
    .filter((c) => {
      const p = c.statement.params as unknown as Record<string, unknown>;
      return typeof p.voice === 'string' && p.voice.trim() !== '';
    })
    .sort((a, b) => a.statement.time - b.statement.time || a.sourceOrder - b.sourceOrder);

  for (let i = 0; i < dialoguesWithVoice.length - 1; i++) {
    const curr = dialoguesWithVoice[i];
    const next = dialoguesWithVoice[i + 1];
    const currParams = curr.statement.params as unknown as Record<string, unknown>;
    const rawDuration = typeof currParams.durationSeconds === 'number'
      ? currParams.durationSeconds
      : (typeof (currParams as Record<string, unknown>).duration === 'number'
        ? (currParams as Record<string, unknown>).duration as number
        : undefined);
    const currDuration = rawDuration !== undefined && Number.isFinite(rawDuration) && rawDuration > 0
      ? rawDuration
      : 0;
    if (currDuration <= 0) continue;
    const currEnd = curr.statement.time + currDuration;
    if (next.statement.time < currEnd + MIN_AUDIO_GAP_SECONDS) {
      const detail = next.statement.time < currEnd
        ? `下一句对白在当前对白结束前 (${next.statement.time.toFixed(2)}s) 开始，语音将被提前中断。`
        : `下一句对白在 ${next.statement.time.toFixed(2)}s 开始，间隔不足 ${(MIN_AUDIO_GAP_SECONDS * 1000).toFixed(0)}ms，可能导致尾音被截断。`;
      issues.push({
        severity: 'warning',
        code: SEMANTIC_AUDIO_DIAGNOSTIC_CODES.dialogueVoiceCutOff,
        message: `对白语音 "${currParams.voice}" 的播放窗口在 ${currEnd.toFixed(2)}s 结束，${detail}`,
        actionId: curr.actionId,
        actionType: curr.actionType,
        location: `${curr.location}.params.voice`,
      });
    }
  }

  const audioPlayContexts = contexts
    .filter((c) => {
      if (c.statement.type !== 'audio') return false;
      const p = c.statement.params as unknown as Record<string, unknown>;
      return p.mode === 'play' && typeof p.file === 'string' && p.file.trim() !== '';
    })
    .sort((a, b) => a.statement.time - b.statement.time || a.sourceOrder - b.sourceOrder || a.companionOrder - b.companionOrder);

  for (let i = 1; i < audioPlayContexts.length; i++) {
    const prev = audioPlayContexts[i - 1];
    const curr = audioPlayContexts[i];
    const prevParams = prev.statement.params as unknown as Record<string, unknown>;
    const prevDuration = typeof prevParams.durationSeconds === 'number' && Number.isFinite(prevParams.durationSeconds) && prevParams.durationSeconds > 0
      ? prevParams.durationSeconds
      : 0;
    if (prevDuration <= 0) continue;
    const prevEnd = prev.statement.time + prevDuration;
    const currStart = curr.statement.time;
    if (currStart < prevEnd + MIN_AUDIO_GAP_SECONDS) {
      issues.push({
        severity: 'warning',
        code: SEMANTIC_AUDIO_DIAGNOSTIC_CODES.audioOverlapTruncated,
        message: `playAudio 音频 "${prevParams.file}" 的播放窗口到 ${prevEnd.toFixed(2)}s，下一段音频在 ${currStart.toFixed(2)}s 开始，可能发生重叠或截断。`,
        actionId: curr.actionId,
        actionType: curr.actionType,
        location: `${curr.location}.params`,
      });
    }
  }
}

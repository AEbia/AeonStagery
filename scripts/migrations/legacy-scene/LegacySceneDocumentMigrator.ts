import type { LegacyActionType, SceneAction, SceneScript } from './LegacySceneTypes';
import {
  SCENE_SCHEMA_VERSION,
  type AudioParams,
  type CameraParams,
  type CharacterPerformanceParams,
  type CharacterPresenceParams,
  type CharacterTransformParams,
  type CustomAnimationParams,
  type EnvironmentLayerParams,
  type GraphicLayerParams,
  type LightingParams,
  type CurrentSceneDocument,
  type CurrentSceneMeta,
  type SceneStatement,
  type VisualStyleParams,
  type ZoomIntent,
} from '../../../src/api/types/semantic-scene';
import { sceneDocumentCodec } from '../../../src/services/semantic-scene/SceneDocumentCodec';
import { isBlendMode, type BlendMode } from '../../../src/api/types/blend-mode';

const BACKGROUND_LAYER_ID = 'background';

export interface LegacySceneMigrationIssue {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly actionIndex?: number;
  readonly actionId?: string;
  readonly actionType?: LegacyActionType;
}

export interface LegacySceneMigrationResult {
  readonly document: CurrentSceneDocument | null;
  readonly issues: readonly LegacySceneMigrationIssue[];
}

export interface LegacySceneMigrationOptions {
  readonly validate?: boolean;
}

interface MigrationContext {
  readonly issues: LegacySceneMigrationIssue[];
  readonly nextStatementId: (action: SceneAction, index: number) => string;
}

interface TimedAction {
  readonly action: SceneAction;
  readonly index: number;
  readonly time: number;
}

export function migrateLegacySceneScriptToDocumentV3(
  scene: SceneScript,
  options: LegacySceneMigrationOptions = {},
): LegacySceneMigrationResult {
  const issues: LegacySceneMigrationIssue[] = [];
  const nextStatementId = createStatementIdFactory();
  const context: MigrationContext = { issues, nextStatementId };
  const statements: SceneStatement[] = [];
  let explicitDuration = readOptionalNumber((scene.meta as CurrentSceneMeta).durationSeconds);

  if (scene.audio?.bgm?.file) {
    const bgmId = nextStatementId({
      _id: 'initial-bgm',
      action: 'setBGM',
      time: 0,
      params: scene.audio.bgm,
    }, -1);
    statements.push(statement('audio', bgmId, 0, clean({
      role: 'bgm',
      mode: 'play',
      file: scene.audio.bgm.file,
      volume: scene.audio.bgm.volume,
      loop: scene.audio.bgm.loop,
      fadeIn: scene.audio.bgm.fadeIn,
    }) as AudioParams));
  }

  for (const timed of materializeLegacyTimes(scene.timeline ?? [])) {
    const migrated = migrateAction(timed, context);
    if (migrated.kind === 'statement') {
      statements.push(migrated.statement);
      if (migrated.endTime !== undefined) {
        explicitDuration = Math.max(explicitDuration ?? 0, migrated.endTime);
      }
      continue;
    }
    if (migrated.kind === 'duration') {
      explicitDuration = Math.max(explicitDuration ?? 0, migrated.endTime);
    }
  }

  const meta = clean({
    ...cloneJson(scene.meta),
    durationSeconds: explicitDuration,
  }) as CurrentSceneMeta;
  const draft: CurrentSceneDocument = {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: scene.sceneId,
    meta,
    ...(scene.visual ? { visual: cloneJson(scene.visual) } : {}),
    statements,
  };

  if (options.validate === false) {
    return { document: cloneJson(draft), issues };
  }

  try {
    return {
      document: sceneDocumentCodec.parseAndValidate(draft),
      issues,
    };
  } catch (error) {
    return {
      document: null,
      issues: [
        ...issues,
        {
          severity: 'error',
          code: 'codec-validation-failed',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function materializeLegacyTimes(timeline: SceneAction[]): TimedAction[] {
  let cursor = 0;
  return timeline.map((action, index) => {
    const time = isFiniteNumber(action.time)
      ? action.time
      : cursor + (isFiniteNumber(action.delay) ? action.delay : 0);
    cursor = time;
    return { action, index, time };
  });
}

function migrateAction(
  timed: TimedAction,
  context: MigrationContext,
): { readonly kind: 'statement'; readonly statement: SceneStatement; readonly endTime?: number } | { readonly kind: 'duration'; readonly endTime: number } | { readonly kind: 'drop' } {
  const { action, index, time } = timed;
  const params = action.params ?? {};
  const id = context.nextStatementId(action, index);

  switch (action.action) {
    case 'setBackground':
      return migrateEnvironment(action, id, time, {
        mode: 'set',
        layerId: BACKGROUND_LAYER_ID,
        image: readString(params.image) ?? readString(params.file),
        position: readPosition(params) ?? readXY(params),
        scale: readOptionalNumber(params.scale),
        rotation: readOptionalNumber(params.rotation),
        opacity: readOptionalNumber(params.opacity),
        z: readOptionalNumber(params.z),
        zIndex: readOptionalNumber(params.zIndex),
        durationSeconds: readDuration(params),
        ease: readString(params.ease),
        transition: readString(params.transition),
      });
    case 'removeBackground':
      return migrateEnvironment(action, id, time, {
        mode: 'remove',
        layerId: BACKGROUND_LAYER_ID,
        durationSeconds: readDuration(params),
        ease: readString(params.ease),
        transition: readString(params.transition),
      });
    case 'transformBackground':
      return migrateEnvironment(action, id, time, {
        mode: 'transform',
        layerId: BACKGROUND_LAYER_ID,
        position: readPosition(params) ?? readXY(params),
        scale: readOptionalNumber(params.scale),
        rotation: readOptionalNumber(params.rotation),
        opacity: readOptionalNumber(params.opacity),
        z: readOptionalNumber(params.z),
        zIndex: readOptionalNumber(params.zIndex),
        durationSeconds: readDuration(params),
        ease: readString(params.ease),
      });
    case 'setEnvironmentLayer':
      return migrateEnvironment(action, id, time, {
        mode: 'set',
        layerId: readString(params.layerId) ?? BACKGROUND_LAYER_ID,
        image: readString(params.image) ?? readString(params.file),
        position: readPosition(params) ?? readXY(params),
        scale: readOptionalNumber(params.scale),
        rotation: readOptionalNumber(params.rotation),
        opacity: readOptionalNumber(params.opacity),
        z: readOptionalNumber(params.z),
        zIndex: readOptionalNumber(params.zIndex),
        durationSeconds: readDuration(params),
        ease: readString(params.ease),
        transition: readString(params.transition),
      });
    case 'transformEnvironmentLayer':
      return migrateEnvironment(action, id, time, {
        mode: 'transform',
        layerId: readString(params.layerId) ?? BACKGROUND_LAYER_ID,
        position: readPosition(params) ?? readXY(params),
        scale: readOptionalNumber(params.scale),
        rotation: readOptionalNumber(params.rotation),
        opacity: readOptionalNumber(params.opacity),
        z: readOptionalNumber(params.z),
        zIndex: readOptionalNumber(params.zIndex),
        durationSeconds: readDuration(params),
        ease: readString(params.ease),
      });
    case 'removeEnvironmentLayer':
      return migrateEnvironment(action, id, time, {
        mode: 'remove',
        layerId: readString(params.layerId) ?? BACKGROUND_LAYER_ID,
        durationSeconds: readDuration(params),
        ease: readString(params.ease),
        transition: readString(params.transition),
      });
    case 'setLensRecipe':
    case 'modulateLens':
      addIssue(
        context,
        timed,
        'error',
        'lens-visual-style-removed',
        `${action.action} cannot be migrated into v3 visualStyle; author filterAdd/filterChange/filterReset instead.`,
      );
      return { kind: 'drop' };
    case 'setCompositeRecipe':
      return migrateVisualStyle(action, id, time, context, {
        scope: 'object',
        mode: 'set',
        target: readString(params.targetId) ?? BACKGROUND_LAYER_ID,
        slot: readCompositeRecipeSlot(params.slot) ?? 'integration',
        recipeId: requiredString(params.recipeId, 'recipeId', timed, context),
        intensity: readOptionalNumber(params.intensity),
        warmth: readOptionalNumber(params.warmth),
        blend: readOptionalNumber(params.blend),
        contamination: readOptionalNumber(params.contamination),
        colorStops: readStringArray(params.colorStops),
        colorBlendMode: readBlendMode(params.colorBlendMode),
        semanticOverride: readStructuredOverride(params.semanticOverride),
        advancedOverride: readStructuredOverride(params.advancedOverride),
      } as VisualStyleParams);
    case 'modulateComposite':
      return migrateVisualStyle(action, id, time, context, {
        scope: 'object',
        mode: 'modulate',
        target: readString(params.targetId) ?? BACKGROUND_LAYER_ID,
        slot: readCompositeSlot(params.slot) ?? 'accent',
        intensity: readOptionalNumber(params.intensity),
        warmth: readOptionalNumber(params.warmth),
        blend: readOptionalNumber(params.blend),
        contamination: readOptionalNumber(params.contamination),
        durationSeconds: readDuration(params),
      } as VisualStyleParams);
    case 'addCharacter':
      return statementResult(statement('characterPresence', id, time, clean({
        mode: 'enter',
        id: readString(params.id) ?? id,
        model: readString(params.model),
        position: readPosition(params),
        scale: readOptionalNumber(params.scale),
        rotation: readOptionalNumber(params.rotation),
        opacity: readOptionalNumber(params.opacity),
        z: readOptionalNumber(params.z),
        transition: readString(params.enter),
        durationSeconds: readDuration(params) ?? readOptionalNumber(params.enterDuration),
        ease: readString(params.enterEase) ?? readString(params.ease),
      }) as CharacterPresenceParams));
    case 'removeCharacter':
      return statementResult(statement('characterPresence', id, time, clean({
        mode: 'exit',
        id: readString(params.id) ?? id,
        transition: readString(params.exit),
        durationSeconds: readDuration(params) ?? readOptionalNumber(params.exitDuration),
        ease: readString(params.exitEase) ?? readString(params.ease),
      }) as CharacterPresenceParams));
    case 'moveCharacter':
    case 'transformCharacter':
      return statementResult(statement('characterTransform', id, time, clean({
        id: readString(params.id) ?? id,
        position: readPosition(params),
        scale: readOptionalNumber(params.scale),
        rotation: readOptionalNumber(params.rotation),
        opacity: readOptionalNumber(params.opacity),
        z: readOptionalNumber(params.z),
        durationSeconds: readDuration(params),
        ease: readString(params.ease),
      }) as CharacterTransformParams));
    case 'characterLookAt': {
      const durationSeconds = readDuration(params);
      return {
        kind: 'statement',
        statement: statement('characterPerformance', id, time, clean({
          target: readString(params.id) ?? id,
          lookAt: clean({
            target: readString(params.target),
            point: readPosition(params) ?? readFocusPoint(params),
            enabled: readBoolean(params.enabled),
            intensity: readOptionalNumber(params.intensity),
          }),
        }) as CharacterPerformanceParams),
        endTime: durationSeconds !== undefined ? time + durationSeconds : undefined,
      };
    }
    case 'characterBlink':
      return statementResult(statement('characterPerformance', id, time, clean({
        target: readString(params.id) ?? id,
        blink: clean({
          enabled: readBoolean(params.enabled),
          interval: readOptionalNumber(params.interval),
        }),
      }) as CharacterPerformanceParams));
    case 'playMotion': {
      const motionKey = readString(params.motion);
      if (!motionKey) {
        return { kind: 'drop' };
      }
      const durationSeconds = readDuration(params);
      return {
        kind: 'statement',
        statement: statement('characterPerformance', id, time, clean({
          target: readString(params.id) ?? id,
          motion: { kind: 'resource', key: motionKey },
        }) as CharacterPerformanceParams),
        endTime: durationSeconds !== undefined ? time + durationSeconds : undefined,
      };
    }
    case 'setExpression':
      return statementResult(statement('characterPerformance', id, time, clean({
        target: readString(params.id) ?? id,
        expression: readString(params.expression) ?? '',
      }) as CharacterPerformanceParams));
    case 'dialogue':
      return statementResult(statement('dialogue', id, time, clean({
        speakerId: readString(params.speakerId),
        speaker: readString(params.speaker),
        text: readString(params.text) ?? '',
        durationSeconds: readDuration(params) ?? 3,
        voice: readString(params.voice),
        style: readString(params.style) ?? readString(params.template),
        speakerColor: readString(params.speakerColor),
        textColor: readString(params.textColor),
        lipSync: readBoolean(params.lipSync),
      })));
    case 'cameraMove':
      return statementResult(statement('camera', id, time, migrateLegacyCameraMove(params)));
    case 'cameraPath': {
      const keyframes = readCameraKeyframes(params.keyframes, timed, context);
      if (!keyframes) return { kind: 'drop' };
      return statementResult(statement('camera', id, time, clean({
        mode: 'path',
        keyframes,
        durationSeconds: readDuration(params),
        ease: readString(params.ease),
        loop: readBoolean(params.loop),
        repeat: readOptionalNumber(params.repeat),
        yoyo: readBoolean(params.yoyo),
      }) as CameraParams));
    }
    case 'cameraShake':
      return statementResult(statement('camera', id, time, clean({
        mode: 'shake',
        intensity: readOptionalNumber(params.intensity),
        frequency: readOptionalNumber(params.frequency),
        durationSeconds: readDuration(params),
        decay: readBoolean(params.decay),
        direction: readDirection(params.direction),
      }) as CameraParams));
    case 'cameraFollow':
      return statementResult(statement('camera', id, time, clean({
        mode: 'follow',
        operation: 'start',
        target: readString(params.characterId) ?? readString(params.id),
        offset: readPosition({ position: params.offset }),
        smoothing: readOptionalNumber(params.smoothing),
      }) as CameraParams));
    case 'cameraReset':
      return statementResult(statement('camera', id, time, clean({
        mode: 'reset',
        durationSeconds: readDuration(params),
        ease: readString(params.ease),
      }) as CameraParams));
    case 'cameraHitchcock':
      return statementResult(statement('camera', id, time, clean({
        mode: 'hitchcock',
        target: readString(params.characterId) ?? readString(params.id) ?? id,
        targetPart: readString(params.targetPart),
        screenTarget: readPosition({ position: params.screenTarget }),
        zoomStart: readOptionalNumber(params.zoomStart) ?? 1,
        zoomEnd: readOptionalNumber(params.zoomEnd) ?? 1,
        scaleStart: readOptionalNumber(params.scaleStart) ?? 1,
        scaleEnd: readOptionalNumber(params.scaleEnd) ?? 1,
        durationSeconds: readDuration(params) ?? 1,
        ease: readString(params.ease),
      }) as CameraParams));
    case 'cameraMotion':
      return statementResult(statement('camera', id, time, migrateCameraMotion(params)));
    case 'setLighting':
      return migrateLighting(action, id, time, {
        effect: 'preset',
        mode: 'set',
        preset: readString(params.preset) ?? 'normal',
        intensity: readOptionalNumber(params.intensity),
        durationSeconds: readDuration(params),
      });
    case 'resetLighting':
      return migrateLighting(action, id, time, {
        effect: 'preset',
        mode: 'reset',
        durationSeconds: readDuration(params),
      });
    case 'setBlur':
      return migrateLighting(action, id, time, {
        effect: 'blur',
        mode: 'set',
        target: readBlurTarget(params.target),
        intensity: readOptionalNumber(params.intensity),
        durationSeconds: readDuration(params),
      });
    case 'resetBlur':
      return migrateLighting(action, id, time, {
        effect: 'blur',
        mode: 'reset',
        target: readBlurTarget(params.target),
        durationSeconds: readDuration(params),
      });
    case 'setGodrays':
      return migrateLighting(action, id, time, {
        effect: 'godrays',
        mode: 'set',
        intensity: readOptionalNumber(params.intensity) ?? readOptionalNumber(params.gain),
        angle: readOptionalNumber(params.angle),
        lacunarity: readOptionalNumber(params.lacunarity),
        durationSeconds: readDuration(params),
      });
    case 'resetGodrays':
      return migrateLighting(action, id, time, {
        effect: 'godrays',
        mode: 'reset',
        durationSeconds: readDuration(params),
      });
    case 'setPostProcessing':
      return migrateLighting(action, id, time, {
        effect: 'post',
        mode: 'set',
        durationSeconds: readDuration(params),
        bloomThreshold: readOptionalNumber(params.bloomThreshold),
        bloomBloomScale: readOptionalNumber(params.bloomBloomScale),
        bloomBrightness: readOptionalNumber(params.bloomBrightness),
        rgbSplitX: readOptionalNumber(params.rgbSplitX),
        rgbSplitY: readOptionalNumber(params.rgbSplitY),
        godrayGain: readOptionalNumber(params.godrayGain),
        godrayLacunarity: readOptionalNumber(params.godrayLacunarity),
        godrayAngle: readOptionalNumber(params.godrayAngle),
        adjGamma: readOptionalNumber(params.adjGamma),
        adjContrast: readOptionalNumber(params.adjContrast),
        adjSaturation: readOptionalNumber(params.adjSaturation),
        adjBrightness: readOptionalNumber(params.adjBrightness),
        adjRed: readOptionalNumber(params.adjRed),
        adjGreen: readOptionalNumber(params.adjGreen),
        adjBlue: readOptionalNumber(params.adjBlue),
        overlayColor: readString(params.overlayColor),
        overlayBlendMode: readLightingBlendMode(params.overlayBlendMode),
        overlayIntensity: readOptionalNumber(params.overlayIntensity),
      });
    case 'resetPostProcessing':
      return migrateLighting(action, id, time, {
        effect: 'post',
        mode: 'reset',
        durationSeconds: readDuration(params),
      });
    case 'addColorOverlay': {
      const overlayId = requiredString(params.id, 'id', timed, context);
      if (!overlayId) return { kind: 'drop' };
      return migrateLighting(action, id, time, {
        effect: 'overlay',
        mode: 'set',
        id: overlayId,
        color: readString(params.color),
        blendMode: readLightingBlendMode(params.mode),
        intensity: readOptionalNumber(params.intensity),
        durationSeconds: readDuration(params),
      });
    }
    case 'removeColorOverlay': {
      const overlayId = requiredString(params.id, 'id', timed, context);
      if (!overlayId) return { kind: 'drop' };
      return migrateLighting(action, id, time, {
        effect: 'overlay',
        mode: 'remove',
        id: overlayId,
        durationSeconds: readDuration(params),
      });
    }
    case 'clearColorOverlays':
      return migrateLighting(action, id, time, {
        effect: 'overlay',
        mode: 'clear',
        durationSeconds: readDuration(params),
      });
    case 'addPointLight': {
      const pointLightId = requiredString(params.id, 'id', timed, context);
      if (!pointLightId) return { kind: 'drop' };
      return migrateLighting(action, id, time, {
        effect: 'pointLight',
        mode: 'set',
        id: pointLightId,
        x: readOptionalNumber(params.x),
        y: readOptionalNumber(params.y),
        color: readString(params.color),
        radius: readOptionalNumber(params.radius),
        intensity: readOptionalNumber(params.intensity),
        durationSeconds: readDuration(params),
      });
    }
    case 'clearPointLights':
      return migrateLighting(action, id, time, {
        effect: 'pointLight',
        mode: 'clear',
        durationSeconds: readDuration(params),
      });
    case 'setCharacterRimLight':
      return statementResult(statement('visualStyle', id, time, clean({
        scope: 'object',
        target: requiredString(params.id ?? params.characterId, 'id', timed, context),
        slot: 'rim-light',
        mode: 'set',
        color: readString(params.color),
        intensity: readOptionalNumber(params.intensity),
        thickness: readOptionalNumber(params.thickness),
        angle: readOptionalNumber(params.angle),
        softness: readOptionalNumber(params.softness),
        durationSeconds: readDuration(params),
      }) as VisualStyleParams));
    case 'addImage':
    case 'transformImage':
    case 'removeImage':
      return statementResult(statement('graphicLayer', id, time, migrateImageLayer(action.action, params, id)));
    case 'addTextLayer':
    case 'transformTextLayer':
    case 'removeTextLayer':
      return statementResult(statement('graphicLayer', id, time, migrateTextLayer(action.action, params, id)));
    case 'playCustomAnimation':
      return statementResult(statement('customAnimation', id, time, clean({
        target: readString(params.target) ?? readString(params.layer) ?? 'overlay',
        file: readString(params.file),
        animation: readString(params.animation),
        durationSeconds: readDuration(params) ?? 1,
        loop: readBoolean(params.loop),
      }) as CustomAnimationParams));
    case 'playAudio': {
      const file = requiredString(params.file ?? params.url, 'file', timed, context);
      if (!file) return { kind: 'drop' };
      return statementResult(statement('audio', id, time, clean({
        role: 'sfx',
        mode: 'play',
        instanceId: readString(params.id) ?? `${id}_sfx`,
        file,
        volume: readOptionalNumber(params.volume),
        loop: readBoolean(params.loop),
        durationSeconds: readDuration(params),
        fadeIn: readOptionalNumber(params.fadeIn),
        fadeOut: readOptionalNumber(params.fadeOut),
      }) as AudioParams));
    }
    case 'stopAudio': {
      const target = readString(params.id) ?? readString(params.target);
      if (target === 'bgm') {
        return statementResult(statement('audio', id, time, clean({
          role: 'bgm',
          mode: 'stop',
          fadeOut: readOptionalNumber(params.fadeOut),
        }) as AudioParams));
      }
      if (!target) {
        addIssue(context, timed, 'error', 'missing-audio-instance-id', 'stopAudio needs a stable id/target to migrate to v3 audio stop.');
        return { kind: 'drop' };
      }
      return statementResult(statement('audio', id, time, clean({
        role: 'sfx',
        mode: 'stop',
        instanceId: target,
        fadeOut: readOptionalNumber(params.fadeOut),
      }) as AudioParams));
    }
    case 'setBGM': {
      const file = requiredString(params.file, 'file', timed, context);
      if (!file) return { kind: 'drop' };
      return statementResult(statement('audio', id, time, clean({
        role: 'bgm',
        mode: 'play',
        file,
        volume: readOptionalNumber(params.volume),
        loop: readBoolean(params.loop),
        fadeIn: readOptionalNumber(params.fadeIn),
        fadeOut: readOptionalNumber(params.fadeOut),
      }) as AudioParams));
    }
    case 'wait':
      return { kind: 'duration', endTime: time + (readDuration(params) ?? 0) };
    case 'custom':
      addIssue(context, timed, 'warning', 'custom-action-dropped', 'custom actions are intentionally dropped in the v3 migration pending a plugin permission ADR.');
      return { kind: 'drop' };
    default:
      return { kind: 'drop' };
  }
}

function migrateEnvironment(
  _action: SceneAction,
  id: string,
  time: number,
  params: EnvironmentLayerParams,
): { readonly kind: 'statement'; readonly statement: SceneStatement } {
  return statementResult(statement('environmentLayer', id, time, clean(params) as EnvironmentLayerParams));
}

function migrateVisualStyle(
  action: SceneAction,
  id: string,
  time: number,
  context: MigrationContext,
  params: VisualStyleParams,
): { readonly kind: 'statement'; readonly statement: SceneStatement } | { readonly kind: 'drop' } {
  if (params.mode === 'set' && !params.recipeId) {
    addIssue(context, { action, index: -1, time }, 'error', 'missing-visual-recipe-id', `${action.action} needs recipeId to migrate to v3 visualStyle.`);
    return { kind: 'drop' };
  }
  return statementResult(statement('visualStyle', id, time, clean(params) as VisualStyleParams));
}

function migrateLighting(
  _action: SceneAction,
  id: string,
  time: number,
  params: LightingParams,
): { readonly kind: 'statement'; readonly statement: SceneStatement } {
  return statementResult(statement('lighting', id, time, clean(params) as LightingParams));
}

function migrateLegacyCameraMove(params: Record<string, any>): CameraParams {
  const zoom = readZoomIntent(params.zoom, 'absolute');
  if (readString(params.targetCharacter)) {
    return clean({
      mode: 'focus',
      target: readString(params.targetCharacter),
      targetPart: readString(params.targetPart),
      position: readPosition(params),
      zoom,
      rotation: readOptionalNumber(params.rotation),
      durationSeconds: readDuration(params),
      ease: readString(params.ease),
    }) as CameraParams;
  }
  return clean({
    mode: 'move',
    position: readPosition(params) ?? readPosition({ position: params.target }),
    zoom,
    rotation: readOptionalNumber(params.rotation),
    durationSeconds: readDuration(params),
    ease: readString(params.ease),
  }) as CameraParams;
}

function migrateCameraMotion(params: Record<string, any>): CameraParams {
  const move = readString(params.move);
  if (move === 'follow') {
    return clean({
      mode: 'follow',
      operation: 'start',
      target: readString(params.characterId) ?? readString(params.focus?.character),
      offset: readPosition({ position: params.offset }),
      smoothing: readOptionalNumber(params.smoothing),
    }) as CameraParams;
  }
  if (move === 'shake') {
    return clean({
      mode: 'shake',
      intensity: readOptionalNumber(params.intensity),
      frequency: readOptionalNumber(params.frequency),
      durationSeconds: readDuration(params),
      decay: readBoolean(params.decay),
      direction: readDirection(params.shakeDirection ?? params.direction),
    }) as CameraParams;
  }
  const focus = params.focus && typeof params.focus === 'object'
    ? params.focus as Record<string, unknown>
    : undefined;
  const zoomKind = move === 'push' || move === 'pull' ? 'delta' : 'absolute';
  if (focus?.character) {
    return clean({
      mode: 'focus',
      target: readString(focus.character),
      targetPart: readString(focus.part),
      position: readPosition({ position: focus.point }),
      zoom: readZoomIntent(params.zoom ?? params.zoomDelta ?? params.zoomLevel, zoomKind),
      rotation: readOptionalNumber(params.angle),
      durationSeconds: readDuration(params),
      ease: readString(params.easing),
    }) as CameraParams;
  }
  return clean({
    mode: 'move',
    position: readPosition(params) ?? readPosition({ position: params.target }),
    to: readPosition({ position: params.to }),
    zoom: readZoomIntent(params.zoom ?? params.zoomDelta ?? params.zoomLevel, zoomKind),
    rotation: readOptionalNumber(params.angle),
    durationSeconds: readDuration(params),
    ease: readString(params.easing),
  }) as CameraParams;
}

function migrateImageLayer(actionType: LegacyActionType, params: Record<string, any>, fallbackId: string): GraphicLayerParams {
  return clean({
    kind: 'image',
    mode: actionType === 'addImage' ? 'set' : actionType === 'transformImage' ? 'transform' : 'remove',
    id: readString(params.id) ?? fallbackId,
    file: readString(params.file),
    position: readPosition(params),
    scale: readOptionalNumber(params.scale),
    rotation: readOptionalNumber(params.rotation),
    opacity: readOptionalNumber(params.opacity),
    z: readOptionalNumber(params.z),
    zIndex: readOptionalNumber(params.zIndex),
    durationSeconds: readDuration(params),
    ease: readString(params.ease),
  }) as GraphicLayerParams;
}

function migrateTextLayer(actionType: LegacyActionType, params: Record<string, any>, fallbackId: string): GraphicLayerParams {
  return clean({
    kind: 'text',
    mode: actionType === 'addTextLayer' ? 'set' : actionType === 'transformTextLayer' ? 'transform' : 'remove',
    id: readString(params.id) ?? fallbackId,
    text: readString(params.text),
    position: readPosition(params),
    scale: readOptionalNumber(params.scale),
    rotation: readOptionalNumber(params.rotation),
    opacity: readOptionalNumber(params.opacity),
    z: readOptionalNumber(params.z),
    zIndex: readOptionalNumber(params.zIndex),
    durationSeconds: readDuration(params),
    ease: readString(params.ease),
    fontFamily: readString(params.fontFamily),
    fontSize: readOptionalNumber(params.fontSize),
    color: readString(params.color),
    style: readString(params.style),
  }) as GraphicLayerParams;
}

function statement<Family extends SceneStatement['type']>(
  type: Family,
  id: string,
  time: number,
  params: Extract<SceneStatement, { type: Family }>['params'],
): SceneStatement {
  return { id, time, type, params } as SceneStatement;
}

function statementResult(statementValue: SceneStatement): { readonly kind: 'statement'; readonly statement: SceneStatement } {
  return { kind: 'statement', statement: statementValue };
}

function createStatementIdFactory(): (action: SceneAction, index: number) => string {
  const used = new Set<string>();
  return (action, index) => {
    const rawBase = readString(action._id) ?? (index < 0 ? `stmt_${action.action}` : `stmt_${index + 1}_${action.action}`);
    let candidate = rawBase;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${rawBase}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  };
}

function readCameraKeyframes(
  value: unknown,
  timed: TimedAction,
  context: MigrationContext,
): Extract<CameraParams, { mode: 'path' }>['keyframes'] | null {
  const parsed = typeof value === 'string'
    ? safeParseJson(value, timed, context)
    : value;
  if (!Array.isArray(parsed) || parsed.length < 2) {
    addIssue(context, timed, 'error', 'invalid-camera-path-keyframes', 'cameraPath requires at least two keyframes to migrate.');
    return null;
  }
  const keyframes = parsed.map((item, index) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return clean({
      time: readOptionalNumber(record.time) ?? index,
      position: readPosition({ position: record.position }),
      zoom: readOptionalNumber(record.zoom),
      rotation: readOptionalNumber(record.rotation),
      ease: readString(record.ease),
      label: readString(record.label),
    });
  });
  return keyframes as Extract<CameraParams, { mode: 'path' }>['keyframes'];
}

function safeParseJson(value: string, timed: TimedAction, context: MigrationContext): unknown {
  try {
    return JSON.parse(value);
  } catch {
    addIssue(context, timed, 'error', 'invalid-json-camera-keyframes', 'cameraPath keyframes string is not valid JSON.');
    return null;
  }
}

function addIssue(
  context: MigrationContext,
  timed: TimedAction,
  severity: LegacySceneMigrationIssue['severity'],
  code: string,
  message: string,
): void {
  context.issues.push({
    severity,
    code,
    message,
    actionIndex: timed.index >= 0 ? timed.index : undefined,
    actionId: readString(timed.action._id),
    actionType: timed.action.action,
  });
}

function requiredString(
  value: unknown,
  field: string,
  timed: TimedAction,
  context: MigrationContext,
): string | undefined {
  const parsed = readString(value);
  if (!parsed) {
    addIssue(context, timed, 'error', `missing-${field}`, `${timed.action.action} needs ${field} to migrate to v3.`);
  }
  return parsed;
}

function readDuration(params: Record<string, unknown>): number | undefined {
  return readOptionalNumber(params.duration);
}

function readPosition(params: Record<string, unknown>): [number, number] | undefined {
  const value = params.position;
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const x = readOptionalNumber(value[0]);
  const y = readOptionalNumber(value[1]);
  return x === undefined || y === undefined ? undefined : [x, y];
}

function readXY(params: Record<string, unknown>): [number, number] | undefined {
  const x = readOptionalNumber(params.x);
  const y = readOptionalNumber(params.y);
  return x === undefined || y === undefined ? undefined : [x, y];
}

function readFocusPoint(params: Record<string, unknown>): [number, number] | undefined {
  const x = readOptionalNumber(params.focusX);
  const y = readOptionalNumber(params.focusY);
  return x === undefined || y === undefined ? undefined : [x, y];
}

function readZoomIntent(value: unknown, defaultKind: ZoomIntent['kind']): ZoomIntent | undefined {
  const numeric = readOptionalNumber(value);
  if (numeric === undefined) return undefined;
  return { kind: defaultKind, value: numeric };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readCompositeSlot(value: unknown): VisualStyleParams['slot'] | undefined {
  return value === 'grounding' || value === 'integration' || value === 'accent' || value === 'distortion' || value === 'rim-light'
    ? value
    : undefined;
}

function readCompositeRecipeSlot(value: unknown): Exclude<VisualStyleParams['slot'], 'rim-light'> | undefined {
  return value === 'grounding' || value === 'integration' || value === 'accent' || value === 'distortion'
    ? value
    : undefined;
}

function readBlendMode(value: unknown): BlendMode | undefined {
  return isBlendMode(value) ? value : undefined;
}

function readLightingBlendMode(value: unknown): BlendMode | undefined {
  return isBlendMode(value) ? value : undefined;
}

function readBlurTarget(value: unknown): 'global' | 'background' | 'characters' | undefined {
  return value === 'global' || value === 'background' || value === 'characters' ? value : undefined;
}

function readStructuredOverride(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return cloneJson(value as Record<string, unknown>);
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.filter((item): item is string => typeof item === 'string');
  return parsed.length === value.length ? parsed : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readDirection(value: unknown): 'both' | 'horizontal' | 'vertical' | undefined {
  return value === 'both' || value === 'horizontal' || value === 'vertical' ? value : undefined;
}

function clean<T extends object>(record: T): T {
  const next = { ...record } as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return next as T;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

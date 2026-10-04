import {
  AUTHORING_SCHEMA_VERSION,
  type AuthoringOrigin,
  type AuthoringScope,
  type SemanticAuthorIntent,
  type SemanticAuthorReceipt,
} from '../../api/types/authoring';
import type { CharacterMotionOutput, CurrentSceneDocument, SceneStatement } from '../../api/types/semantic-scene';
import {
  convertSampledMotionToCustomMotion,
  type CustomMotionDensity,
  type CustomMotionSampledTrack,
} from '../../engine/live2d/customMotionConversion';
import {
  Cubism2MotionSamplingError,
  mergeCubism2SampledCurves,
  resolveCubism2MotionMeta,
  sampleCubism2MotionCurves,
  type Cubism2MotionCurve,
  type Cubism2MotionMeta,
  type Cubism2MotionSamplerTarget,
  type Cubism2MotionSamplingOptions,
} from '../../engine/live2d/cubism2MotionSampler';
import { SemanticAuthoringApplicationService } from './SemanticAuthoringApplicationService';
import { type CustomMotionEditLeaseGate, locatorToLeaseTarget } from './CustomMotionEditLeaseGate';
import { assertCanonicalCustomMotion, CustomMotionContractError } from '../semantic-scene';

/**
 * Default entry fade inherited from the source motion when neither the
 * resource branch nor the source `.mtn` declares one (ADR-0029: 500ms).
 */
export const CUSTOM_MOTION_CONVERSION_DEFAULT_FADE_IN_SECONDS = 0.5 as const;

/** Character target of a `characterPerformance` source entity. */
export type CustomMotionConversionTarget =
  | ({ kind: 'statement' } & { statementId: string })
  | ({ kind: 'companion' } & { statementId: string; companionId: string });

export interface CustomMotionConversionRequest {
  locator: CustomMotionConversionTarget;
  /** One of 'sparse' | 'standard' | 'fine' | 'perFrame'. */
  density: CustomMotionDensity;
  origin: AuthoringOrigin;
  correlationId?: string;
  scope?: AuthoringScope;
}

export interface CustomMotionConversionReceipt {
  authoring: SemanticAuthorReceipt;
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  staticTrackIds: readonly string[];
  simplifiedTrackIds: readonly string[];
}

export interface CustomMotionConversionPorts {
  /** Existing atomic authoring service; the converted motion commits through it. */
  authoring: SemanticAuthoringApplicationService;
  /**
   * Concrete Cubism 2.1 sampler targets of a character. Empty when the
   * character is not loaded or is not a Cubism 2.1 runtime.
   */
  samplerTargets: (characterId: string) => readonly Cubism2MotionSamplerTarget[];
  /** Optional collaboration lease gate; when set, conversion requires the lease. */
  leaseGate?: CustomMotionEditLeaseGate;
  /**
   * Injectable sampler seam (tests substitute fakes here). Defaults to the
   * real Cubism 2.1 sampler implementation.
   */
  sampler?: CustomMotionConversionSampler;
}

export interface CustomMotionConversionSampler {
  sample: typeof sampleCubism2MotionCurves;
  merge: typeof mergeCubism2SampledCurves;
  resolveMeta: typeof resolveCubism2MotionMeta;
}

export type CustomMotionConversionErrorCode =
  | 'entity-not-found'
  | 'not-character-performance'
  | 'motion-source-unavailable'
  | 'character-not-loaded'
  | 'no-convertible-parameters'
  | 'sampling-failed'
  | 'lease-denied'
  | 'entity-changed'
  | 'invalid-conversion-result';

export class CustomMotionConversionError extends Error {
  constructor(
    message: string,
    readonly code: CustomMotionConversionErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CustomMotionConversionError';
  }
}

interface CharacterPerformanceParamsLike {
  target: string;
  motion?: CharacterMotionOutput;
}

/**
 * Convert a resource motion, or explicitly regenerate an existing custom
 * motion from its `derivedFrom` source, into a self-contained custom motion
 * (ADR-0029 "自定义动作"). The operation is atomic: on any failure the scene
 * document keeps its current motion. In collaboration mode the target entity
 * lease must be acquired before the commit; otherwise the conversion is
 * refused.
 */
export class CustomMotionConversionCommand {
  private readonly samplerImpl: CustomMotionConversionSampler;

  constructor(private readonly ports: CustomMotionConversionPorts) {
    this.samplerImpl = ports.sampler ?? {
      sample: sampleCubism2MotionCurves,
      merge: mergeCubism2SampledCurves,
      resolveMeta: resolveCubism2MotionMeta,
    };
  }

  async convert(request: CustomMotionConversionRequest): Promise<CustomMotionConversionReceipt> {
    const document = this.ports.authoring.getDocumentSnapshot();
    const entity = resolveCharacterPerformance(document, request.locator);
    const params = entity.params as CharacterPerformanceParamsLike;
    const source = resolveConversionSource(params.motion);
    if (!source) {
      throw new CustomMotionConversionError(
        'Custom motion conversion requires a resource motion or a custom motion with derivedFrom metadata',
        'motion-source-unavailable',
        { statementId: request.locator.statementId },
      );
    }

    const motionKey = source.motionKey;
    const characterId = params.target;
    console.log(`[CustomMotionConvert] 开始转换 motion="${motionKey}" character="${characterId}"`);
    const targets = this.ports.samplerTargets(characterId);
    console.log(`[CustomMotionConvert] samplerTargets 数量=${targets.length}`);
    if (targets.length === 0) {
      throw new CustomMotionConversionError(
        `Character "${characterId}" is not loaded as a Cubism 2.1 model; conversion requires a loaded concrete model`,
        'character-not-loaded',
        { characterId },
      );
    }
    targets.forEach((target, index) => {
      const mm = target.motionManager;
      console.log(`[CustomMotionConvert] target[${index}] 有 motionManager=${!!mm}, 有 settings=${!!mm?.settings}, settings.motions 键=${mm?.settings?.motions ? Object.keys(mm.settings.motions).join(',') : '(无)'}`);
    });

    let meta: Cubism2MotionMeta;
    try {
      meta = await this.samplerImpl.resolveMeta(targets[0], motionKey);
      console.log(`[CustomMotionConvert] resolveMeta 成功: duration=${meta.durationSeconds}s fadeIn=${meta.fadeInSeconds} fadeOut=${meta.fadeOutSeconds}`);
    } catch (error) {
      console.error(`[CustomMotionConvert] resolveMeta 失败:`, error);
      throw wrapSamplingError(error, characterId, motionKey);
    }

    const fps = document.meta.fps ?? DEFAULT_SCENE_FPS;
    const samplingOptions: Cubism2MotionSamplingOptions = {
      fps,
      durationSeconds: meta.durationSeconds,
      fadeInSeconds: meta.fadeInSeconds,
      fadeOutSeconds: meta.fadeOutSeconds,
    };

    let merged: readonly Cubism2MotionCurve[];
    try {
      const perModel = await Promise.all(
        targets.map((target) => this.samplerImpl.sample(target, motionKey, samplingOptions)),
      );
      merged = this.samplerImpl.merge(perModel);
      console.log(`[CustomMotionConvert] 采样成功: ${merged.length} 条曲线`);
    } catch (error) {
      console.error(`[CustomMotionConvert] 采样失败:`, error);
      throw wrapSamplingError(error, characterId, motionKey);
    }

    const sampledTracks: CustomMotionSampledTrack[] = merged.map((curve) => ({
      parameterId: curve.parameterId,
      samples: curve.samples,
    }));

    const leaseTarget = locatorToLeaseTarget(request.locator);
    if (this.ports.leaseGate) {
      const acquired = await this.ports.leaseGate.acquire(leaseTarget);
      if (!acquired) {
        throw new CustomMotionConversionError(
          `Edit lease for character performance "${request.locator.statementId}" is held by another collaborator`,
          'lease-denied',
          { statementId: request.locator.statementId },
        );
      }
    }

    try {
      let conversion: ReturnType<typeof convertSampledMotionToCustomMotion> | undefined;
      const receipt = await this.ports.authoring.authorTransaction((currentDocument) => {
        // Execute the post-sampling read, conversion, and replacement intent
        // inside the application service queue. This preserves sibling output
        // edits that were queued while the lease was pending.
        const currentEntity = resolveCharacterPerformance(currentDocument, request.locator);
        const currentParams = currentEntity.params as CharacterPerformanceParamsLike;
        const currentSource = resolveConversionSource(currentParams.motion);
        if (!currentSource || currentSource.kind !== source.kind || currentSource.motionKey !== motionKey) {
          throw new CustomMotionConversionError(
            `Source motion of "${request.locator.statementId}" changed while sampling; conversion aborted`,
            'entity-changed',
            { statementId: request.locator.statementId },
          );
        }

        const fadeInSeconds = currentSource.kind === 'custom'
          ? currentSource.fadeInSeconds
          : currentSource.fadeInSeconds
            ?? meta.fadeInSeconds
            ?? CUSTOM_MOTION_CONVERSION_DEFAULT_FADE_IN_SECONDS;

        try {
          conversion = convertSampledMotionToCustomMotion({
            durationSeconds: Math.max(meta.durationSeconds, fadeInSeconds),
            fadeInSeconds,
            derivedFromKey: motionKey,
            derivedFromFadeInSeconds: meta.fadeInSeconds,
            derivedFromFadeOutSeconds: meta.fadeOutSeconds,
            density: request.density,
            sampledTracks,
          });
          // Conversion adapter: the engine layer stays free of semantic-scene
          // dependencies, so the canonical contract (ADR-0029) is enforced
          // here on the produced motion before it can be committed. Non-finite
          // sampled values and any other output violating the persisted
          // invariants fail the whole conversion atomically.
          assertCanonicalCustomMotion(conversion.motion);
        } catch (error) {
          if (error instanceof CustomMotionContractError) {
            throw new CustomMotionConversionError(
              `Converted motion for "${motionKey}" violates the canonical custom motion contract: ${error.message}`,
              'invalid-conversion-result',
              {
                characterId,
                motionKey,
                contractPath: error.path,
                contractCode: error.code,
                ...(error.details ? { details: error.details } : {}),
              },
            );
          }
          if (error instanceof Cubism2MotionSamplingError) {
            throw wrapSamplingError(error, characterId, motionKey);
          }
          if (error instanceof Error && /track|parameter/i.test(error.message)) {
            throw new CustomMotionConversionError(
              `Source motion "${motionKey}" has no convertible parameter curves (only ignored Parts curves remain)`,
              'no-convertible-parameters',
              { characterId, motionKey },
            );
          }
          throw error;
        }

        return [buildConversionIntent(request, currentEntity, conversion.motion)];
      });
      if (!conversion) throw new Error('Custom motion conversion did not produce a motion');
      return {
        authoring: receipt,
        motion: conversion.motion,
        staticTrackIds: conversion.staticTrackIds,
        simplifiedTrackIds: conversion.simplifiedTrackIds,
      };
    } finally {
      // ADR-0029: a conversion either commits atomically or releases the
      // edit lease immediately, so collaborators are never blocked until the
      // lease timeout (default ~30s).
      if (this.ports.leaseGate) {
        this.ports.leaseGate.release(leaseTarget);
      }
    }
  }
}

const DEFAULT_SCENE_FPS = 60 as const;

type ResolvedConversionSource =
  | { kind: 'resource'; motionKey: string; fadeInSeconds?: number }
  | { kind: 'custom'; motionKey: string; fadeInSeconds: number };

function resolveConversionSource(motion: CharacterMotionOutput | undefined): ResolvedConversionSource | null {
  if (!motion) return null;
  if (motion.kind === 'resource') {
    return {
      kind: 'resource',
      motionKey: motion.key,
      ...(motion.fadeInSeconds !== undefined ? { fadeInSeconds: motion.fadeInSeconds } : {}),
    };
  }
  if (!motion.derivedFrom.key) return null;
  return {
    kind: 'custom',
    motionKey: motion.derivedFrom.key,
    fadeInSeconds: motion.fadeInSeconds,
  };
}

function resolveCharacterPerformance(
  document: CurrentSceneDocument,
  locator: CustomMotionConversionTarget,
): SceneStatement {
  if (locator.kind === 'statement') {
    const statement = document.statements.find((candidate) => candidate.id === locator.statementId);
    if (!statement) {
      throw new CustomMotionConversionError(`Statement not found: ${locator.statementId}`, 'entity-not-found', {
        statementId: locator.statementId,
      });
    }
    if (statement.type !== 'characterPerformance') {
      throw new CustomMotionConversionError(
        `Statement "${locator.statementId}" is not a characterPerformance entity`,
        'not-character-performance',
        { statementId: locator.statementId, type: statement.type },
      );
    }
    return statement;
  }

  const parent = document.statements.find((candidate) => candidate.id === locator.statementId);
  if (!parent) {
    throw new CustomMotionConversionError(`Statement not found: ${locator.statementId}`, 'entity-not-found', {
      statementId: locator.statementId,
    });
  }
  const companion = parent.companions?.find((candidate) => candidate.id === locator.companionId);
  if (!companion) {
    throw new CustomMotionConversionError(
      `Companion not found: ${locator.statementId}/${locator.companionId}`,
      'entity-not-found',
      { statementId: locator.statementId, companionId: locator.companionId },
    );
  }
  if (companion.type !== 'characterPerformance') {
    throw new CustomMotionConversionError(
      `Companion "${locator.statementId}/${locator.companionId}" is not a characterPerformance entity`,
      'not-character-performance',
      { statementId: locator.statementId, companionId: locator.companionId, type: companion.type },
    );
  }
  return companion as unknown as SceneStatement;
}

function buildConversionIntent(
  request: CustomMotionConversionRequest,
  entity: SceneStatement,
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
): SemanticAuthorIntent {
  const base = {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId: request.correlationId ?? `custom-motion-convert-${entity.id}`,
    origin: request.origin,
    ...(request.scope ? { scope: request.scope } : {}),
  } as const;

  // The intent goes through the dedicated motion-replacement path so the
  // scene duration grows atomically when the converted motion extends past
  // `meta.durationSeconds`; sibling performance outputs (Expression /
  // LookAt / Blink) are preserved and the identity guard re-checks the
  // resource source key or the custom motion's derived source key.
  return {
    ...base,
    kind: 'update-custom-motion-keyframes',
    locator: request.locator.kind === 'statement'
      ? { statementId: request.locator.statementId }
      : { statementId: request.locator.statementId, companionId: request.locator.companionId },
    motion,
  };
}

function wrapSamplingError(
  error: unknown,
  characterId: string,
  motionKey: string,
): CustomMotionConversionError {
  const code = error instanceof Cubism2MotionSamplingError ? error.code : 'queue-evaluation-failed';
  const message = error instanceof Error ? error.message : String(error);
  return new CustomMotionConversionError(
    `Sampling motion "${motionKey}" on character "${characterId}" failed: ${message}`,
    'sampling-failed',
    { characterId, motionKey, code },
  );
}

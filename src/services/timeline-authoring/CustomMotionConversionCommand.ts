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
import type {
  Live2DMotionSampledCurve,
  Live2DMotionSamplingMetadata,
  Live2DMotionSamplingOptions,
  Live2DMotionSamplingResult,
} from '../../engine/runtime/Live2DRuntimeContracts';
import { SemanticAuthoringApplicationService } from './SemanticAuthoringApplicationService';
import { InMemoryCustomMotionEditAuthority, type CustomMotionEditAuthority, type HeldCustomMotionLease } from './CustomMotionEditAuthority';
import { customMotionFingerprint } from './customMotionKeyframeEdits';
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
  signal?: AbortSignal;
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
  /** Preferred bound-runtime sampling behavior. */
  sampleMotion?: (characterId: string, motionKey: string, options: Live2DMotionSamplingOptions) => Promise<Live2DMotionSamplingResult>;
  /** Shared application authority; standalone callers use in-memory ownership. */
  authority?: CustomMotionEditAuthority;
  /**
   * Injectable sampler seam (tests substitute fakes here). Defaults to the
   * real Cubism 2.1 sampler implementation.
   */
  sampler?: CustomMotionConversionSampler;
}

export interface CustomMotionConversionSampler {
  sample(characterId: string, motionKey: string, options: Live2DMotionSamplingOptions): Promise<readonly Live2DMotionSampledCurve[]>;
  resolveMeta(characterId: string, motionKey: string): Promise<Live2DMotionSamplingMetadata>;
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
  private readonly samplerImpl?: CustomMotionConversionSampler;
  private readonly authority: CustomMotionEditAuthority;

  constructor(private readonly ports: CustomMotionConversionPorts) {
    this.authority = ports.authority ?? new InMemoryCustomMotionEditAuthority();
    this.samplerImpl = ports.sampler;
  }

  async convert(request: CustomMotionConversionRequest, handoff?: (lease: HeldCustomMotionLease) => Promise<boolean>): Promise<CustomMotionConversionReceipt> {
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
    const characterId = resolveCharacterId(document, request.locator, params);
    if (!this.ports.sampleMotion && !this.samplerImpl) {
      throw new CustomMotionConversionError(
        `Character "${characterId}" is not loaded for motion sampling`,
        'character-not-loaded',
        { characterId },
      );
    }

    let meta: Live2DMotionSamplingMetadata;
    let merged: readonly Live2DMotionSampledCurve[];
    try {
      if (this.ports.sampleMotion) {
        const sampled = await this.ports.sampleMotion(characterId, motionKey, {
          fps: document.meta.fps ?? DEFAULT_SCENE_FPS,
          zeroSourceFades: true,
        });
        if (sampled.status !== 'sampled' || !sampled.metadata) {
          throw new Error(sampled.diagnostics?.join('; ') ?? 'Runtime does not support motion sampling');
        }
        meta = sampled.metadata;
        if (sampled.motion) {
          merged = sampled.motion.tracks.map((track) => ({
            parameterId: track.parameterId,
            samples: track.keyframes.map((keyframe) => ({ time: keyframe.time, value: keyframe.value })),
          }));
        } else {
          merged = sampled.curves ?? [];
        }
      } else {
        const sampler = this.samplerImpl!;
        meta = await sampler.resolveMeta(characterId, motionKey);
        merged = await sampler.sample(characterId, motionKey, {
          fps: document.meta.fps ?? DEFAULT_SCENE_FPS,
          zeroSourceFades: true,
        });
      }
    } catch (error) {
      throw wrapSamplingError(error, characterId, motionKey);
    }

    const fps = document.meta.fps ?? DEFAULT_SCENE_FPS;

    const sampledTracks: CustomMotionSampledTrack[] = merged.map((curve) => ({
      parameterId: curve.parameterId,
      samples: curve.samples,
    }));

    const leaseTarget = request.locator.kind === 'companion'
      ? { kind: 'companion' as const, statementId: request.locator.statementId, companionId: request.locator.companionId }
      : { kind: 'statement' as const, statementId: request.locator.statementId };
    const signal = request.signal ?? new AbortController().signal;
    const decision = await this.authority.acquire(leaseTarget, signal);
    if (decision.status !== 'granted') throw new CustomMotionConversionError('Custom motion edit authority refused the conversion', 'lease-denied');
    let retained = false;
    let lost = false;
    const unsubscribeLoss = this.authority.onLoss(decision.lease, () => { lost = true; });

    try {
      let conversion: ReturnType<typeof convertSampledMotionToCustomMotion> | undefined;
      const receipt = await this.ports.authoring.authorTransaction((currentDocument) => {
        // Execute the post-sampling read, conversion, and replacement intent
        // inside the application service queue. This preserves sibling output
        // edits that were queued while the lease was pending.
        if (signal.aborted || lost || currentDocument.sceneId !== document.sceneId || (currentDocument.meta.fps ?? DEFAULT_SCENE_FPS) !== fps) {
          throw new CustomMotionConversionError('Conversion context changed before commit', 'entity-changed');
        }
        const currentEntity = resolveCharacterPerformance(currentDocument, request.locator);
        const currentParams = currentEntity.params as CharacterPerformanceParamsLike;
        const currentSource = resolveConversionSource(currentParams.motion);
        if (!currentSource || currentSource.kind !== source.kind || currentSource.motionKey !== motionKey
          || resolveCharacterId(currentDocument, request.locator, currentParams) !== characterId
          || (params.motion?.kind === 'custom' && (currentParams.motion?.kind !== 'custom' || customMotionFingerprint(currentParams.motion) !== customMotionFingerprint(params.motion)))) {
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
      if (handoff && !lost && !signal.aborted) retained = await handoff(decision.lease);
      return {
        authoring: receipt,
        motion: conversion.motion,
        staticTrackIds: conversion.staticTrackIds,
        simplifiedTrackIds: conversion.simplifiedTrackIds,
      };
    } finally {
      unsubscribeLoss();
      if (!retained) await this.authority.release(decision.lease);
    }
  }
}

const DEFAULT_SCENE_FPS = 60 as const;

function resolveCharacterId(document: CurrentSceneDocument, locator: CustomMotionConversionTarget, params: CharacterPerformanceParamsLike): string {
  if (params.target !== '$speaker') return params.target;
  const parent = document.statements.find((statement) => statement.id === locator.statementId);
  return parent?.type === 'dialogue' ? parent.params.speakerId ?? '' : '';
}

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
  const message = error instanceof Error ? error.message : String(error);
  return new CustomMotionConversionError(
    `Sampling motion "${motionKey}" on character "${characterId}" failed: ${message}`,
    'sampling-failed',
    { characterId, motionKey },
  );
}

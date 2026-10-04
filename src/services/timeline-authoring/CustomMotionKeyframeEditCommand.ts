import {
  AUTHORING_SCHEMA_VERSION,
  type AuthoringOrigin,
  type AuthoringScope,
  type CompanionLocator,
  type SemanticAuthorReceipt,
  type StatementLocator,
} from '../../api/types/authoring';
import type { CharacterMotionOutput, CurrentSceneDocument, SceneStatement } from '../../api/types/semantic-scene';
import { SemanticAuthoringApplicationService } from './SemanticAuthoringApplicationService';
import { type CustomMotionEditLeaseGate, locatorToLeaseTarget } from './CustomMotionEditLeaseGate';
import {
  applyCustomMotionKeyframeEdits,
  customMotionFingerprint,
  assertValidCustomMotionEdit,
  type CustomMotionKeyframeEdit,
} from './customMotionKeyframeEdits';

export type CustomMotionKeyframeEditTarget =
  | (StatementLocator & { kind: 'statement' })
  | ({ kind: 'companion' } & CompanionLocator);

export interface CustomMotionKeyframeEditRequest {
  locator: CustomMotionKeyframeEditTarget;
  expectedMotion?: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  expectedSceneId?: string;
  expectedFps?: number;

  /** Applied atomically as a single undo record (ADR-0029). */
  edits: readonly CustomMotionKeyframeEdit[];
  origin: AuthoringOrigin;
  correlationId?: string;
  scope?: AuthoringScope;
}

export interface CustomMotionKeyframeEditPorts {
  /** Existing atomic authoring service; the edited motion commits through it. */
  authoring: SemanticAuthoringApplicationService;
  /** Optional collaboration lease gate; when set, writes require the lease. */
  leaseGate?: CustomMotionEditLeaseGate;
}

export type CustomMotionKeyframeEditCommandErrorCode =
  | 'entity-not-found'
  | 'not-character-performance'
  | 'motion-not-custom'
  | 'lease-denied'
  | 'entity-changed';

export class CustomMotionKeyframeEditCommandError extends Error {
  constructor(
    message: string,
    readonly code: CustomMotionKeyframeEditCommandErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CustomMotionKeyframeEditCommandError';
  }
}

export interface CustomMotionKeyframeEditReceipt {
  authoring: SemanticAuthorReceipt;
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
}

/**
 * Apply keyframe edits to a custom motion (ADR-0029). The batch is
 * pre-validated (F0 protection, strictly increasing times, fade/duration
 * bounds) before it reaches the authoring pipeline; the document codec stays
 * the final fallback. In collaboration mode the target entity lease must be
 * held before the local write is applied.
 */
export class CustomMotionKeyframeEditCommand {
  constructor(private readonly ports: CustomMotionKeyframeEditPorts) {}

  async edit(request: CustomMotionKeyframeEditRequest): Promise<CustomMotionKeyframeEditReceipt> {
    const leaseTarget = locatorToLeaseTarget(request.locator);
    if (this.ports.leaseGate) {
      const acquired = await this.ports.leaseGate.acquire(leaseTarget);
      if (!acquired) {
        throw new CustomMotionKeyframeEditCommandError(
          `Edit lease for character performance "${request.locator.statementId}" is held by another collaborator`,
          'lease-denied',
          { statementId: request.locator.statementId },
        );
      }
    }

    try {
      let motion: Extract<CharacterMotionOutput, { kind: 'custom' }> | undefined;
      const receipt = await this.ports.authoring.authorTransaction((document) => {
        // The factory executes inside the application service mutation queue,
        // so reads and the resulting replacement are one lease critical
        // section even when another local authoring task was already queued.
        if (request.expectedSceneId !== undefined && request.expectedSceneId !== document.sceneId) {
          throw new CustomMotionKeyframeEditCommandError('Scene changed before the edit could commit', 'entity-changed');
        }
        if (request.expectedFps !== undefined && request.expectedFps !== (document.meta.fps ?? 60)) {
          throw new CustomMotionKeyframeEditCommandError('Scene frame rate changed before the edit could commit', 'entity-changed');
        }
        const entity = resolveEntity(document, request.locator);
        const params = entity.params as { motion?: CharacterMotionOutput };
        if (params.motion === undefined || params.motion.kind !== 'custom') {
          throw new CustomMotionKeyframeEditCommandError(
            `Entity "${request.locator.statementId}" does not hold a custom motion`,
            'motion-not-custom',
            { statementId: request.locator.statementId },
          );
        }

        if (request.expectedMotion && customMotionFingerprint(params.motion) !== customMotionFingerprint(request.expectedMotion)) {
          throw new CustomMotionKeyframeEditCommandError('Motion changed before the edit could commit', 'entity-changed');
        }
        motion = applyCustomMotionKeyframeEdits(params.motion, request.edits);
        assertValidCustomMotionEdit(motion);
        return [{
          version: AUTHORING_SCHEMA_VERSION,
          correlationId: request.correlationId ?? `custom-motion-keyframes-${entity.id}`,
          origin: request.origin,
          ...(request.scope ? { scope: request.scope } : {}),
          kind: 'update-custom-motion-keyframes' as const,
          locator: 'companionId' in request.locator
            ? { statementId: request.locator.statementId, companionId: request.locator.companionId }
            : { statementId: request.locator.statementId },
          motion,
        }];
      });

      if (!motion) throw new Error('Custom motion edit did not produce a motion');
      return { authoring: receipt, motion };
    } finally {
      // A keyframe batch is the lease critical section. Releasing here avoids
      // retaining an entity lock after the command has committed (or failed).
      this.ports.leaseGate?.release(leaseTarget);
    }
  }
}

function resolveEntity(
  document: CurrentSceneDocument,
  locator: CustomMotionKeyframeEditTarget,
): SceneStatement {
  if (locator.kind === 'statement') {
    const statement = document.statements.find((candidate) => candidate.id === locator.statementId);
    if (!statement) {
      throw new CustomMotionKeyframeEditCommandError(
        `Statement not found: ${locator.statementId}`,
        'entity-not-found',
        { statementId: locator.statementId },
      );
    }
    if (statement.type !== 'characterPerformance') {
      throw new CustomMotionKeyframeEditCommandError(
        `Statement "${locator.statementId}" is not a characterPerformance entity`,
        'not-character-performance',
        { statementId: locator.statementId, type: statement.type },
      );
    }
    return statement;
  }

  const parent = document.statements.find((candidate) => candidate.id === locator.statementId);
  if (!parent) {
    throw new CustomMotionKeyframeEditCommandError(
      `Statement not found: ${locator.statementId}`,
      'entity-not-found',
      { statementId: locator.statementId },
    );
  }
  const companion = parent.companions?.find((candidate) => candidate.id === locator.companionId);
  if (!companion) {
    throw new CustomMotionKeyframeEditCommandError(
      `Companion not found: ${locator.statementId}/${locator.companionId}`,
      'entity-not-found',
      { statementId: locator.statementId, companionId: locator.companionId },
    );
  }
  if (companion.type !== 'characterPerformance') {
    throw new CustomMotionKeyframeEditCommandError(
      `Companion "${locator.statementId}/${locator.companionId}" is not a characterPerformance entity`,
      'not-character-performance',
      { statementId: locator.statementId, companionId: locator.companionId, type: companion.type },
    );
  }
  return companion as unknown as SceneStatement;
}

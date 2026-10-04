import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { SemanticScenePatchV1 } from '../../api/types/semantic-scene-patch';
import { SEMANTIC_SCENE_PATCH_VERSION } from '../../api/types/semantic-scene-patch';
import {
  applySemanticScenePatch,
} from '../semantic-scene/SemanticScenePatch';
import {
  sceneDocumentCodec,
  sceneStatementCompiler,
  validateSemanticSceneStructure,
} from '../semantic-scene';
import {
  checkSceneEnhancementSnapshotValidity,
  type SceneEnhancementSnapshotV1,
  type SceneEnhancementVersionBindingV1,
} from './SceneEnhancementSnapshot';
import { materializePerformancePlaceholders } from './CharacterBindingPlan';
import {
  getEnhancementStagePolicy,
} from './CinematicEnhancementPolicy';
import {
  assertMonotonicPerformanceCompletion,
  collectPerformanceStatementSnapshots,
} from './performance/PerformanceCompletionGate';

export interface FormalEnhancementResourceDiagnosticV1 {
  readonly gate?: 'schema' | 'semantic' | 'compiler' | 'resource';
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly code?: string;
  readonly path?: string;
}

export interface FormalEnhancementApplyPorts {
  /**
   * Commit the final candidate in one authoring transaction (one history entry).
   * Must re-check base version against the live store before writing.
   */
  readonly commitCandidate: (input: {
    readonly baseDocument: CurrentSceneDocument;
    readonly baseVersion: number;
    readonly candidate: CurrentSceneDocument;
  }) => Promise<CurrentSceneDocument> | CurrentSceneDocument;
  /**
   * Optional strict resource reference gate (project/model assets).
   * When provided, hard errors block commit after schema/semantic/compiler.
   */
  readonly validateResources?: (
    candidate: CurrentSceneDocument,
  ) =>
    | readonly FormalEnhancementResourceDiagnosticV1[]
    | Promise<readonly FormalEnhancementResourceDiagnosticV1[]>;
}

export type FormalEnhancementApplyResultV1 =
  | {
      readonly ok: true;
      readonly document: CurrentSceneDocument;
      readonly operationCount: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'snapshot_invalid'
        | 'not_preview_ready'
        | 'empty_patch'
        | 'version_conflict'
        | 'validation_failed'
        | 'resource_validation_failed'
        | 'apply_failed';
      readonly message: string;
    };

export type EnhancementStageNameV1 = 'performance' | 'cinematic';

export interface EnhancementStageContributionV1 {
  readonly stage: EnhancementStageNameV1;
  readonly patch: SemanticScenePatchV1;
}

/**
 * Ordered stage contributions. Each stage's line locators are resolved against
 * the candidate produced by prior stages (never concatenated onto one base).
 */
export interface EnhancementStagePlanV1 {
  readonly version: 1;
  readonly stages: readonly EnhancementStageContributionV1[];
}

/**
 * ADR-0022 workbench presentation: collect the real motion keys the
 * performance enhancement stage adds to dialogue performance companions
 * (insertCompanion or updateCompanion with a non-empty characterPerformance
 * motion). Base prose staging placeholders (exact empty motion) never count —
 * they are not presented as filled motions in the workbench.
 */
export function collectEnhancementPerformanceMotions(
  plan: EnhancementStagePlanV1,
): { readonly motionCount: number; readonly motions: readonly string[] } {
  let motionCount = 0;
  const seen = new Set<string>();
  for (const stage of plan.stages) {
    if (stage.stage !== 'performance') continue;
    for (const operation of stage.patch.operations) {
      let motion: unknown;
      if (operation.kind === 'insertCompanion' && operation.companion.type === 'characterPerformance') {
        motion = operation.companion.params.motion;
      } else if (operation.kind === 'updateCompanion' && operation.patch.type === 'characterPerformance') {
        motion = operation.patch.params?.motion;
      }
      const motionKey = performanceMotionKey(motion);
      if (motionKey) {
        motionCount += 1;
        seen.add(motionKey);
      }
    }
  }
  return { motionCount, motions: [...seen] };
}

function performanceMotionKey(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (!value || typeof value !== 'object') return undefined;
  const motion = value as { kind?: unknown; key?: unknown; derivedFrom?: { key?: unknown } };
  if (motion.kind === 'resource' && typeof motion.key === 'string') return motion.key;
  if (motion.kind === 'custom' && typeof motion.derivedFrom?.key === 'string') return motion.derivedFrom.key;
  return undefined;
}

/**
 * Apply a formal enhancement preview: validity → sequential stages → gates → one commit.
 * Never partial-commits performance vs cinematic.
 */
export async function applyFormalEnhancementPreview(input: {
  readonly snapshot: SceneEnhancementSnapshotV1;
  readonly document: CurrentSceneDocument;
  readonly binding: SceneEnhancementVersionBindingV1;
  readonly ports: FormalEnhancementApplyPorts;
}): Promise<FormalEnhancementApplyResultV1> {
  const validity = checkSceneEnhancementSnapshotValidity(input.snapshot, input.binding);
  if (!validity.valid) {
    return {
      ok: false,
      code: 'snapshot_invalid',
      message: validity.reason === 'document_version_changed'
        ? '场景已编辑，增强预览已失效。'
        : '场景会话已切换，增强预览已失效。',
    };
  }

  if (input.snapshot.phase === 'no_changes') {
    return {
      ok: false,
      code: 'empty_patch',
      message: '无需更改：空 scene 或模型判断无修改，不创建 history。',
    };
  }

  if (input.snapshot.phase !== 'preview_ready') {
    return {
      ok: false,
      code: 'not_preview_ready',
      message: '预览尚未就绪，无法应用。',
    };
  }

  if (input.binding.documentVersion !== input.snapshot.binding.documentVersion) {
    return {
      ok: false,
      code: 'version_conflict',
      message: 'DocumentStore version 与预览绑定不一致。',
    };
  }

  const plan = resolveEnhancementStagePlan(input.snapshot);
  if (!plan || plan.stages.every((stage) => stage.patch.operations.length === 0)) {
    return {
      ok: false,
      code: 'empty_patch',
      message: '预览 patch 为空，不创建 history。',
    };
  }

  let candidate: CurrentSceneDocument;
  let operationCount: number;
  try {
    const applied = applyEnhancementStagePlan(input.document, plan);
    candidate = applied.candidate;
    operationCount = applied.operationCount;
  } catch (error) {
    return {
      ok: false,
      code: 'apply_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (operationCount === 0) {
    return {
      ok: false,
      code: 'empty_patch',
      message: '预览 patch 为空，不创建 history。',
    };
  }

  try {
    const validated = sceneDocumentCodec.parseAndValidate(candidate);
    const semanticIssues = validateSemanticSceneStructure(validated);
    const errors = semanticIssues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      return {
        ok: false,
        code: 'validation_failed',
        message: errors.map((issue) => issue.message).join('; '),
      };
    }
    sceneStatementCompiler.compile(validated);
    candidate = validated;
  } catch (error) {
    return {
      ok: false,
      code: 'validation_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (input.ports.validateResources) {
    try {
      const resourceDiagnostics = await input.ports.validateResources(candidate);
      const resourceErrors = resourceDiagnostics.filter((item) => item.severity === 'error');
      if (resourceErrors.length > 0) {
        return {
          ok: false,
          code: 'resource_validation_failed',
          message: resourceErrors.map((item) => item.message).join('; '),
        };
      }
    } catch (error) {
      return {
        ok: false,
        code: 'resource_validation_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    const committed = await input.ports.commitCandidate({
      baseDocument: input.document,
      baseVersion: input.binding.documentVersion,
      candidate,
    });
    return {
      ok: true,
      document: committed,
      operationCount,
    };
  } catch (error) {
    return {
      ok: false,
      code: 'apply_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build an ordered stage plan. Empty-operation stages are omitted.
 * Callers must apply via {@link applyEnhancementStagePlan}, not flatten+single-shot.
 */
export function combineStagePatches(
  performance?: SemanticScenePatchV1,
  cinematic?: SemanticScenePatchV1,
): EnhancementStagePlanV1 {
  const stages: EnhancementStageContributionV1[] = [];
  if (performance && performance.operations.length > 0) {
    stages.push({ stage: 'performance', patch: performance });
  }
  if (cinematic && cinematic.operations.length > 0) {
    stages.push({ stage: 'cinematic', patch: cinematic });
  }
  return { version: 1, stages };
}

/**
 * Preserve processing-unit patch boundaries so every patch resolves against
 * the candidate produced by its predecessor.
 */
export function combineStageUnitPatches(
  performance: readonly SemanticScenePatchV1[] | undefined,
  cinematic: readonly SemanticScenePatchV1[] | undefined,
): EnhancementStagePlanV1 {
  const stages: EnhancementStageContributionV1[] = [];
  for (const patch of performance ?? []) {
    if (patch.operations.length > 0) stages.push({ stage: 'performance', patch });
  }
  for (const patch of cinematic ?? []) {
    if (patch.operations.length > 0) stages.push({ stage: 'cinematic', patch });
  }
  return { version: 1, stages };
}

/** Display / summary only — never use as a single apply base after multi-stage authorship. */
export function flattenEnhancementStagePlan(plan: EnhancementStagePlanV1): SemanticScenePatchV1 {
  return {
    version: SEMANTIC_SCENE_PATCH_VERSION,
    operations: plan.stages.flatMap((stage) => [...stage.patch.operations]),
  };
}

/**
 * Sequentially apply stage patches. Each stage resolves lines against the prior candidate.
 * By default materializes empty-motion performance placeholders to match runner baseline.
 */
export function applyEnhancementStagePlan(
  document: CurrentSceneDocument,
  plan: EnhancementStagePlanV1,
  options: { readonly materializePlaceholders?: boolean } = {},
): { readonly candidate: CurrentSceneDocument; readonly operationCount: number } {
  const shouldMaterializePlaceholders = options.materializePlaceholders
    ?? plan.stages.some((stage) => stage.stage === 'performance');
  let candidate = shouldMaterializePlaceholders
    ? materializePerformancePlaceholders(document)
    : document;
  let operationCount = 0;
  for (const stage of plan.stages) {
    if (stage.patch.operations.length === 0) continue;
    const policy = getEnhancementStagePolicy(stage.stage);
    const applied = applySemanticScenePatch(candidate, stage.patch, { policy });
    if (stage.stage === 'performance') {
      const violations = assertMonotonicPerformanceCompletion({
        base: collectPerformanceStatementSnapshots(candidate),
        candidate: collectPerformanceStatementSnapshots(applied.candidate),
      });
      if (violations.length > 0) {
        throw new Error(violations.map((violation) => violation.message).join('; '));
      }
    }
    candidate = applied.candidate;
    operationCount += stage.patch.operations.length;
  }
  return { candidate, operationCount };
}

/**
 * Prefer explicit stage patches from the snapshot; fall back to legacy flat previewPatch.
 */
export function resolveEnhancementStagePlan(
  snapshot: SceneEnhancementSnapshotV1,
): EnhancementStagePlanV1 | null {
  const hasStageResults = snapshot.performance !== undefined || snapshot.cinematic !== undefined;
  const fromStages = combineStageUnitPatches(
    stagePatches(snapshot.performance),
    stagePatches(snapshot.cinematic),
  );
  if (fromStages.stages.length > 0) return fromStages;

  if (hasStageResults) return null;

  if (snapshot.previewPatch && snapshot.previewPatch.operations.length > 0) {
    return {
      version: 1,
      stages: [{ stage: 'performance', patch: snapshot.previewPatch }],
    };
  }
  return null;
}

function stagePatches(
  stage: { readonly status: string; readonly patch?: SemanticScenePatchV1; readonly unitPatches?: readonly SemanticScenePatchV1[] } | undefined,
): readonly SemanticScenePatchV1[] | undefined {
  if (stage?.status !== 'succeeded') return undefined;
  if (stage.unitPatches) return stage.unitPatches;
  return stage.patch ? [stage.patch] : undefined;
}

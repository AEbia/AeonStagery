import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { AiProseEnhancementStageCheckpointV1 } from '../../api/types/ai-prose-enhancement';
import type { SemanticScenePatchV1 } from '../../api/types/semantic-scene-patch';
import type { SceneEnhancementStageResultV1 } from '../../services/ai-authoring/SceneEnhancementSnapshot';
import type { AiProseAuthoringComposition } from '../../services/ai-authoring/AiProseAuthoringComposition';
import { replaceEnhancementState, setCharacterBindingPlan, type DraftSession } from '../../services/ai-authoring/AiProseDraftSession';
import { buildCharacterBindingPlan, projectDraftSemanticScene } from '../../services/ai-authoring/CharacterBindingPlan';
import { combineStageUnitPatches, flattenEnhancementStagePlan, type EnhancementStagePlanV1 } from '../../services/ai-authoring/FormalEnhancementApply';
import { FormalEnhancementOrchestrator } from '../../services/ai-authoring/FormalEnhancementOrchestrator';
import { EnhancementProcessorRunner } from '../../services/ai-authoring/EnhancementProcessorRunner';
import { beginFormalEnhancementRun, buildFormalStatementGroups, buildSingleSegmentSegmentation } from '../../services/ai-authoring/FormalSceneEnhancementHost';
import { enhancementStageCheckpointFromSnapshot, createIncrementalStageCheckpointPersister } from '../../services/ai-authoring/AiProseEnhancementRestore';
import { createEmptyEnhancementState, withEnhancementStageCheckpoint } from '../../services/ai-authoring/AiProseEnhancementState';
import type { EnhancementCapabilityPortsV1 } from '../hooks/useEnhancementCapabilityPorts';

interface DraftEnhancementInput {
  currentDraft: DraftSession;
  document: CurrentSceneDocument;
  documentVersion: number;
  composition: AiProseAuthoringComposition;
  capabilityPorts: EnhancementCapabilityPortsV1;
  enableActing: boolean;
  enableCinematic: boolean;
  getCurrentDraft: () => DraftSession | null;
  commitDraft: (draft: DraftSession, immediate: boolean) => void;
  onMessage: (message: string) => void;
}

/** Runs optional stages against a projected draft; persistence and UI state stay with the caller. */
export async function runDraftEnhancement({
  currentDraft, document, documentVersion, composition, capabilityPorts,
  enableActing, enableCinematic, getCurrentDraft, commitDraft, onMessage,
}: DraftEnhancementInput): Promise<EnhancementStagePlanV1 | null | undefined> {
  const preview = currentDraft.preview;
  if (!preview) return;
  // Bind the run to the exact DocumentStore version it authors line
  // locators against; apply/restore refuse stale results after a scene edit.
  const boundDocumentVersion = documentVersion;

  const plan = buildCharacterBindingPlan({
    document,
    confirmedMainCharacters: currentDraft.confirmedMainCharacters,
    requestedBindings: currentDraft.characterBindings,
  });
  if (plan.status === 'ambiguous') {
    onMessage(
      `角色绑定歧义：${plan.ambiguous.map((item) => item.name).join('、')}。请在人物确认中选择。`,
    );
    commitDraft(setCharacterBindingPlan(currentDraft, plan), true);
    return;
  }
  // Persist the binding plan as a session fact so a restart restores the
  // exact plan used by the enhancement run (ADR-0022 schema v4).
  commitDraft(setCharacterBindingPlan(currentDraft, plan), true);

  // Persist each stage checkpoint into the draft session so successful
  // windows/splits survive a restart (ticket 02) and can be restored.
  const persistEnhancementStageCheckpoint = async (
    checkpoint: AiProseEnhancementStageCheckpointV1,
  ) => {
    const latest = getCurrentDraft();
    if (!latest) return;
    const base = latest.enhancement ?? createEmptyEnhancementState(latest);
    commitDraft(replaceEnhancementState(latest, {
      ...base,
      characterBindingPlan: plan,
      boundDocumentVersion,
      ...withEnhancementStageCheckpoint(base, checkpoint),
    }), true);
  };

  const persistEnhancementCheckpoint = async (
    stage: 'performance' | 'cinematic',
    result: SceneEnhancementStageResultV1,
  ) => {
    await persistEnhancementStageCheckpoint(enhancementStageCheckpointFromSnapshot(stage, result));
  };

  // Persist a 'running' stage checkpoint before the first unit and an
  // incremental partial checkpoint after each completed unit, so a crash
  // mid-stage keeps every finished unit (ADR-0022 per-unit checkpoints).
  const checkpointHooks = createIncrementalStageCheckpointPersister({
    persist: (_stage, checkpoint) => {
      void persistEnhancementStageCheckpoint(checkpoint);
    },
  });

  // Same baseline shape as AiProseSceneApplicator: existing formal + draft dialogues.
  const projected = projectDraftSemanticScene({
    baseDocument: document,
    plan,
    confirmedMainCharacters: currentDraft.confirmedMainCharacters,
    previewStatements: preview.statements.map((statement) => ({
      speaker: statement.speaker,
      text: statement.text,
      time: statement.time,
      durationSeconds: statement.durationSeconds,
    })),
  });

  const groups = buildFormalStatementGroups(projected);
  const segmentation = buildSingleSegmentSegmentation(groups);
  // The projection preserves formal statement ids; placeholder materialization
  // must stay created-only so the baseline matches the apply-time baseline
  // (pre-existing formal dialogues are never backfilled by the apply path).
  const formalStatementIds = new Set(document.statements.map((statement) => statement.id));
  const createdStatementIds = new Set(
    projected.statements
      .filter((statement) => !formalStatementIds.has(statement.id))
      .map((statement) => statement.id),
  );
  const runner = new EnhancementProcessorRunner({
    llm: composition.llm,
    modelCapabilities: capabilityPorts.modelCapabilityPort,
    cinematicCapabilities: capabilityPorts.cinematicCapabilityPort,
    profileProvider: capabilityPorts.profileProvider,
    onUnitComplete: checkpointHooks.onUnitComplete,
    onStageStarted: checkpointHooks.onStageStarted,
  });
  const orchestrator = new FormalEnhancementOrchestrator({
    llm: composition.llm,
    runnerFactory: () => runner,
  });
  const binding = { sceneSessionEpoch: 0, documentVersion: 0 };
  let snap = beginFormalEnhancementRun({
    binding,
    document: projected,
    segmentation,
  });

  let performancePatches: readonly SemanticScenePatchV1[] | undefined = undefined;
  if (enableActing) {
    snap = await orchestrator.runPerformance({
      snapshot: snap,
      document: projected,
      binding,
      ensurePlaceholders: false,
      placeholderTargetStatementIds: createdStatementIds,
    });
    if (snap.performance?.status !== 'succeeded') {
      onMessage(
        `表演增强失败：${snap.performance?.diagnostics?.map((d) => d.message).join('; ') || '未知错误'}`,
      );
      return;
    }
    performancePatches = snap.performance.unitPatches
      ?? (snap.performance.patch ? [snap.performance.patch] : undefined);
    await persistEnhancementCheckpoint('performance', snap.performance);
  }

  let cinematicPatches: readonly SemanticScenePatchV1[] | undefined = undefined;
  if (enableCinematic) {
    snap = await orchestrator.runCinematic({
      snapshot: snap,
      document: projected,
      placeholderTargetStatementIds: createdStatementIds,
    });
    if (snap.cinematic?.status !== 'succeeded' && snap.phase !== 'preview_ready') {
      onMessage(
        `电影感增强失败：${snap.cinematic?.diagnostics?.map((d) => d.message).join('; ') || '未知错误'}`,
      );
    }
    cinematicPatches = snap.cinematic?.status === 'succeeded'
      ? (snap.cinematic.unitPatches
        ?? (snap.cinematic.patch ? [snap.cinematic.patch] : undefined))
      : undefined;
    if (snap.cinematic) {
      await persistEnhancementCheckpoint('cinematic', snap.cinematic);
    }
  }

  const stagePlan = combineStageUnitPatches(performancePatches, cinematicPatches);
  const opCount = flattenEnhancementStagePlan(stagePlan).operations.length;
  onMessage(
    opCount > 0
      ? `可选增强就绪：${opCount} 项操作，将随原子应用一并写入。`
      : '可选增强完成：无需额外更改。',
  );
  return stagePlan.stages.length > 0 ? stagePlan : null;
}

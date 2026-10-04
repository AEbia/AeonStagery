import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  IconPerformanceDirector,
  IconX,
} from './icons';
import { eventBus } from '../api/events';
import { AiWorkbenchModeSwitch } from './AiWorkbenchMode';
import {
  useApp,
  useDocumentStore,
  useProjectWorkspaceService,
  useSemanticAuthoringService,
} from './context/AppContext';
import { useSemanticDocument } from './store/storeHooks';
import { useSettings } from './SettingsStore';
import {
  AiRequestTracePanel,
  useAiRequestTrace,
} from './AiProseTrace';
import {
  beginFormalEnhancementRun,
  buildFormalStatementGroups,
  buildSingleSegmentSegmentation,
  formalSceneEnhancementStore,
  formatFormalTime,
  parseFormalTimepointLines,
  previewFormalSegmentation,
  resolveFormalUserTimepoints,
  summarizeSemanticScenePatch,
  type FormalStatementGroupV1,
} from '../services/ai-authoring/FormalSceneEnhancementHost';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';
import {
  checkSceneEnhancementSnapshotValidity,
  isEmptySceneDocument,
  type SceneEnhancementPhaseV1,
  type SceneEnhancementSnapshotV1,
  type SceneEnhancementStageResultV1,
} from '../services/ai-authoring/SceneEnhancementSnapshot';
import { DEFAULT_AI_TARGET_BATCH_SIZE } from '../api/types/ai-prose-authoring';
import { FormalEnhancementOrchestrator } from '../services/ai-authoring/FormalEnhancementOrchestrator';
import { applyFormalEnhancementPreview } from '../services/ai-authoring/FormalEnhancementApply';
import {
  EnhancementProcessorRunner,
  type EnhancementUnitCheckpointV1,
} from '../services/ai-authoring/EnhancementProcessorRunner';
import type { TechnicalSplitUnitV1 } from '../services/ai-authoring/EnhancementScope';
import { SemanticSceneLineView } from '../services/semantic-scene/SemanticSceneLineView';
import { projectFormalSceneStoryText } from '../services/ai-authoring/SceneLineProjection';
import type { SceneEnhancementUnitCheckpointSummaryV1 } from '../services/ai-authoring/SceneEnhancementSnapshot';
import { validatePerformanceResourceCapabilities } from '../services/ai-authoring/PerformanceCapabilityGate';
import { useEnhancementCapabilityPorts } from './hooks/useEnhancementCapabilityPorts';
import { showToast } from './Toast';

type EnhancementStep = 'segment' | 'performance' | 'preview';

const STEPS: readonly { id: EnhancementStep; number: string; label: string }[] = [
  { id: 'segment', number: '01', label: '叙事分段' },
  { id: 'performance', number: '02', label: '表演指导' },
  { id: 'preview', number: '03', label: '预览应用' },
];

const PHASE_LABELS: Record<SceneEnhancementPhaseV1, string> = {
  idle: '未开始',
  segmenting: '分段中',
  performance: '表演中',
  cinematic: '电影感中',
  preview_ready: '预览就绪',
  failed: '失败',
  no_changes: '无需更改',
};

const FAMILY_LABELS: Record<string, string> = {
  characterPerformance: '角色表演',
  characterTransform: '角色变换',
  camera: '镜头',
  lighting: '灯光',
  visualStyle: '视觉风格',
  filterAdd: '滤镜添加',
  filterChange: '滤镜变更',
  filterReset: '滤镜重置',
  line: '行移动/删除',
  companions: 'companion 重排',
  unknown: '其他',
};

const OP_LABELS: Record<string, string> = {
  insertStatement: '插入语句',
  insertCompanion: '插入 companion',
  updateStatement: '更新语句',
  updateCompanion: '更新 companion',
  deleteLine: '删除',
  moveLine: '移动',
  reorderCompanions: '重排 companion',
};

const UNIT_STATUS_LABELS: Record<string, string> = {
  idle: '待命',
  running: '运行中',
  succeeded: '成功',
  retryableFailed: '可重试失败',
  failed: '失败',
};

function formatCount(value: number): string {
  return value.toLocaleString('zh-CN');
}

function toUnitCheckpoints(
  units: readonly SceneEnhancementUnitCheckpointSummaryV1[] | undefined,
  stage: EnhancementUnitCheckpointV1['stage'],
): readonly EnhancementUnitCheckpointV1[] {
  if (!units || units.length === 0) return [];
  return units.map((unit) => ({
    key: unit.key,
    stage,
    status: unit.status,
    attemptCount: unit.attemptCount,
    policyVersion: '',
    processorVersion: '',
    ...(unit.inputFingerprint ? { inputFingerprint: unit.inputFingerprint } : {}),
    ...(unit.diagnostics ? { diagnostics: unit.diagnostics } : {}),
  }));
}

type LiveUnitStatus = 'idle' | 'running' | 'succeeded' | 'retryableFailed' | 'failed';

type LiveUnitRow = {
  readonly key: string;
  readonly narrativeKey: string;
  readonly startGroupIndex: number;
  readonly endGroupIndexExclusive: number;
  readonly visibleChars: number;
  readonly status: LiveUnitStatus;
  readonly attemptCount: number;
  readonly diagnostics?: readonly { readonly code: string; readonly message: string }[];
};

type SegmentPerformancePreviewV1 = {
  readonly parentLine: number;
  readonly line: number;
  readonly target: string | undefined;
  readonly motion: string | undefined;
};

type SegmentPreviewV1 = {
  readonly key: string;
  readonly startGroupIndex: number;
  readonly endGroupIndexExclusive: number;
  readonly visibleChars: number;
  readonly storyText: string;
  readonly performances: readonly SegmentPerformancePreviewV1[];
};

/**
 * Per-narrative-segment preview for the enhancement workspace: story text with
 * `[Line:n]` tags (what the processor sees) plus the characterPerformance
 * companion params (`target: "$speaker"`, `motion: ""` placeholders) read
 * through the same line view the processors consume.
 */
function buildSegmentPreviews(
  document: CurrentSceneDocument,
  groups: readonly FormalStatementGroupV1[],
  segmentation: NonNullable<SceneEnhancementSnapshotV1['segmentation']>,
): readonly SegmentPreviewV1[] {
  const view = new SemanticSceneLineView(document);
  const rootLinesByTime = new Map<number, number[]>();
  const performancesByParent = new Map<number, SegmentPerformancePreviewV1[]>();
  for (const line of view.lines) {
    if (line.kind === 'statement' && line.type === 'dialogue') {
      const lines = rootLinesByTime.get(line.time) ?? [];
      lines.push(line.line);
      rootLinesByTime.set(line.time, lines);
    } else if (
      line.kind === 'companion'
      && line.type === 'characterPerformance'
      && line.parentLine !== undefined
    ) {
      const target = typeof line.params.target === 'string' ? line.params.target : undefined;
      const motion = typeof line.params.motion === 'string' ? line.params.motion : undefined;
      const rows = performancesByParent.get(line.parentLine) ?? [];
      rows.push({ parentLine: line.parentLine, line: line.line, target, motion });
      performancesByParent.set(line.parentLine, rows);
    }
  }
  const timeByGroup = new Map(groups.map((group) => [group.index, group.time] as const));
  return segmentation.narrativeBoundaries.map((boundary) => {
    const lines: number[] = [];
    let visibleChars = 0;
    for (let groupIndex = boundary.startGroupIndex; groupIndex < boundary.endGroupIndexExclusive; groupIndex += 1) {
      const time = timeByGroup.get(groupIndex);
      if (time !== undefined) lines.push(...(rootLinesByTime.get(time) ?? []));
      visibleChars += groups[groupIndex]?.visibleChars ?? 0;
    }
    const storyText = projectFormalSceneStoryText(document, { lineFilter: lines });
    const performances = lines.flatMap((parentLine) => performancesByParent.get(parentLine) ?? []);
    return {
      key: boundary.key,
      startGroupIndex: boundary.startGroupIndex,
      endGroupIndexExclusive: boundary.endGroupIndexExclusive,
      visibleChars,
      storyText,
      performances,
    };
  });
}

function toLiveUnitRows(units: readonly TechnicalSplitUnitV1[]): readonly LiveUnitRow[] {
  return units.map((unit) => ({
    key: unit.key,
    narrativeKey: unit.narrativeKey,
    startGroupIndex: unit.startGroupIndex,
    endGroupIndexExclusive: unit.endGroupIndexExclusive,
    visibleChars: unit.visibleChars,
    status: 'idle',
    attemptCount: 0,
  }));
}

export function FormalSceneEnhancementPanel({ onClose }: { onClose?: () => void }) {
  const app = useApp();
  const documentStore = useDocumentStore();
  const semanticAuthoring = useSemanticAuthoringService();
  const { document } = useSemanticDocument();
  const { settings } = useSettings();
  const composition = app.services?.aiProse;
  const characterAdapter = app.adapters.character;
  const projectWorkspace = useProjectWorkspaceService();
  const currentProject = useSyncExternalStore(
    projectWorkspace ? (listener) => projectWorkspace.subscribe(listener) : () => () => {},
    projectWorkspace ? () => projectWorkspace.getCurrentProject() : () => null,
    () => null,
  );

  const targetBatchSize = settings.aiProse?.targetBatchSize ?? DEFAULT_AI_TARGET_BATCH_SIZE;
  const documentVersion = documentStore.version;
  const documentSceneId = document?.sceneId;
  const sceneSessionEpoch = useMemo(() => {
    if (!documentSceneId) return 0;
    return Math.abs(
      Array.from(documentSceneId).reduce((hash, char) => ((hash << 5) - hash) + char.charCodeAt(0), 0),
    );
  }, [documentSceneId]);

  const binding = useMemo(
    () => ({ sceneSessionEpoch, documentVersion }),
    [sceneSessionEpoch, documentVersion],
  );

  const [snapshot, setSnapshot] = useState<SceneEnhancementSnapshotV1 | null>(
    () => formalSceneEnhancementStore.get(),
  );
  const [activeStep, setActiveStep] = useState<EnhancementStep>('segment');
  const [segmentMode, setSegmentMode] = useState<'auto' | 'timepoints'>('auto');
  const [timepointInput, setTimepointInput] = useState('');
  const [message, setMessage] = useState('');
  const [runnerNotice, setRunnerNotice] = useState(
    '锁定叙事分段后，可运行表演指导并预览应用。',
  );
  const [busy, setBusy] = useState<'idle' | 'segment' | 'performance' | 'apply'>('idle');
  const [unitCheckpoints, setUnitCheckpoints] = useState<readonly EnhancementUnitCheckpointV1[]>([]);
  const [traceOpen, setTraceOpen] = useState(true);
  const [liveStage, setLiveStage] = useState<EnhancementUnitCheckpointV1['stage'] | null>(null);
  const [liveUnits, setLiveUnits] = useState<readonly LiveUnitRow[]>([]);
  const runTokenRef = useRef(0);

  const capabilityPorts = useEnhancementCapabilityPorts({
    document,
    characterAdapter: characterAdapter,
    templatePackages: app.services?.templatePackages ?? null,
    enabledTemplateIds: currentProject?.metadata.templates?.enabledTemplateIds ?? null,
  });
  const modelCapabilityPort = capabilityPorts.modelCapabilityPort;
  const profileProvider = capabilityPorts.profileProvider;
  const modelCapabilities = capabilityPorts.modelCapabilities;
  const modelCapabilitiesLoading = capabilityPorts.loading;
  const aiTrace = useAiRequestTrace({ effort: settings.aiProse?.effort });

  const validateEnhancementResources = useCallback((candidate: NonNullable<typeof document>) => {
    if (!document) return [];
    return validatePerformanceResourceCapabilities(candidate, modelCapabilityPort);
  }, [document, modelCapabilityPort]);

  const orchestrator = useMemo(() => {
    if (!composition?.llm) return null;
    return new FormalEnhancementOrchestrator({
      llm: composition.llm,
      requestBudget: composition.configuration?.requestBudget,
      modelCapabilities: modelCapabilityPort,
      profileProvider,
      runnerFactory: (options) => new EnhancementProcessorRunner({
        ...options,
        onStagePlanned: (stage, units) => {
          setLiveStage(stage);
          setLiveUnits(toLiveUnitRows(units));
        },
        onUnitComplete: (unit, unitIndex) => {
          setLiveUnits((current) => current.map((row, index) => (
            index === unitIndex
              ? {
                  ...row,
                  status: unit.status,
                  attemptCount: unit.attemptCount,
                  ...(unit.diagnostics ? { diagnostics: unit.diagnostics } : {}),
                }
              : row
          )));
        },
      }),
    });
  }, [composition?.llm, composition?.configuration?.requestBudget, modelCapabilityPort, profileProvider]);

  const validity = snapshot
    ? checkSceneEnhancementSnapshotValidity(snapshot, binding)
    : { valid: true as const };

  useEffect(() => {
    if (!snapshot) return;
    if (!validity.valid) {
      formalSceneEnhancementStore.discard(validity.reason);
      setSnapshot(null);
      setUnitCheckpoints([]);
      setMessage(
        validity.reason === 'document_version_changed'
          ? '场景已编辑，增强预览已失效。请重新分段并运行。'
          : '场景会话已切换，增强预览已失效。',
      );
      setActiveStep('segment');
    }
  }, [snapshot, validity.valid, validity.reason, binding]);

  const segmentationPreview = useMemo(
    () => (document ? previewFormalSegmentation(document, targetBatchSize) : null),
    [document, targetBatchSize],
  );

  const resolvedTimepoints = useMemo(() => {
    if (!segmentationPreview || segmentMode !== 'timepoints') return null;
    const points = parseFormalTimepointLines(timepointInput);
    if (points.length === 0) return null;
    return resolveFormalUserTimepoints(segmentationPreview.groups, points);
  }, [segmentationPreview, segmentMode, timepointInput]);

  const patchSummary = useMemo(
    () => (snapshot?.previewPatch ? summarizeSemanticScenePatch(snapshot.previewPatch) : null),
    [snapshot?.previewPatch],
  );

  const segmentPreviews = useMemo(
    () => (document && snapshot?.segmentation
      ? buildSegmentPreviews(document, buildFormalStatementGroups(document), snapshot.segmentation)
      : []),
    [document, snapshot?.segmentation],
  );

  const commitSnapshot = useCallback((next: SceneEnhancementSnapshotV1) => {
    formalSceneEnhancementStore.set(next);
    setSnapshot(next);
  }, []);

  const handleDiscard = useCallback(() => {
    runTokenRef.current += 1;
    formalSceneEnhancementStore.discard('explicit_discard');
    setSnapshot(null);
    setUnitCheckpoints([]);
    setBusy('idle');
    setMessage('已丢弃增强预览。');
    setActiveStep('segment');
  }, []);

  const handleConfirmSegmentation = useCallback(async () => {
    if (!document || !segmentationPreview) return;

    if (isEmptySceneDocument(document)) {
      const empty = beginFormalEnhancementRun({
        binding,
        document,
        segmentation: { segmentKeys: [], narrativeBoundaries: [], source: 'empty_scene' },
      });
      commitSnapshot(empty);
      setUnitCheckpoints([]);
      setMessage('空 scene：无需更改，不发起模型请求。');
      setActiveStep('preview');
      return;
    }

    setBusy('segment');
    const token = ++runTokenRef.current;
    try {
      let segmentation;
      if (segmentMode === 'auto') {
        if (segmentationPreview.effectiveTarget <= 1) {
          segmentation = buildSingleSegmentSegmentation(segmentationPreview.groups);
        } else if (!orchestrator) {
          setMessage('自动语义分段需要 AI 服务。请配置 AI 设置，或改用时间点分段。');
          return;
        } else {
          setMessage('正在自动语义分段…');
          aiTrace.reset();
          const resolved = await orchestrator.resolveAutoSegmentation({
            document,
            targetBatchSize,
            llmOptions: { onProgress: aiTrace.handleLlmProgress },
          });
          if (token !== runTokenRef.current) return;
          if (!resolved.ok) {
            setMessage(`自动分段失败：${resolved.message}`);
            return;
          }
          segmentation = resolved.segmentation;
        }
      } else {
        const points = parseFormalTimepointLines(timepointInput);
        const resolved = resolveFormalUserTimepoints(segmentationPreview.groups, points);
        if (!resolved.ok) {
          setMessage(resolved.message);
          return;
        }
        segmentation = resolved.segmentation;
      }

      if (token !== runTokenRef.current) return;
      const next = beginFormalEnhancementRun({ binding, document, segmentation });
      commitSnapshot(next);
      setUnitCheckpoints([]);
      setMessage(`已锁定 ${next.segmentation?.segmentKeys.length ?? 0} 个叙事段（version ${binding.documentVersion}）。`);
      setRunnerNotice('分段已锁定。可运行表演指导，或跳过到预览。');
      setActiveStep('performance');
    } finally {
      if (token === runTokenRef.current) setBusy('idle');
    }
  }, [
    aiTrace,
    document,
    segmentationPreview,
    segmentMode,
    timepointInput,
    binding,
    commitSnapshot,
    orchestrator,
    targetBatchSize,
  ]);

  const handleRunPerformance = useCallback(async () => {
    if (!document || !snapshot?.segmentation || !orchestrator) {
      setMessage(!orchestrator ? '需要 AI 服务才能运行表演指导。请打开 AI 设置。' : '请先锁定分段。');
      return;
    }
    if (modelCapabilitiesLoading) {
      setMessage('正在读取角色模型能力，请稍后再运行表演指导。');
      return;
    }
    const capabilityError = Object.values(modelCapabilities).find((entry) => entry.error)?.error;
    if (capabilityError) {
      setMessage(`角色模型能力读取失败：${capabilityError}`);
      return;
    }
    setBusy('performance');
    setRunnerNotice('表演指导运行中…');
    const token = ++runTokenRef.current;
    aiTrace.reset();
    setLiveStage(null);
    setLiveUnits([]);
    try {
      const next = await orchestrator.runPerformance({
        snapshot,
        document,
        binding,
        ensurePlaceholders: true,
        llmOptions: { onProgress: aiTrace.handleLlmProgress },
      });
      if (token !== runTokenRef.current) return;
      commitSnapshot(next);
      setUnitCheckpoints(toUnitCheckpoints(next.performance?.units, 'performance'));
      if (next.performance?.status === 'succeeded') {
        setMessage(
          next.previewPatch && next.previewPatch.operations.length > 0
            ? `表演完成：${next.previewPatch.operations.length} 项操作，可检查预览并应用。`
            : '表演完成：无需更改。可检查预览。',
        );
        setRunnerNotice('表演阶段已成功。');
        setActiveStep('preview');
      } else {
        setMessage(
          `表演阶段失败：${next.performance?.diagnostics?.map((d) => d.message).join('; ') || '未知错误'}`,
        );
        setRunnerNotice('可重试表演指导，或返回分段。');
      }
    } catch (error) {
      if (token !== runTokenRef.current) return;
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (token === runTokenRef.current) setBusy('idle');
    }
  }, [aiTrace, binding, commitSnapshot, document, modelCapabilities, modelCapabilitiesLoading, orchestrator, snapshot]);

  const handleApply = useCallback(async () => {
    if (!document || !snapshot || !semanticAuthoring) {
      setMessage(!semanticAuthoring ? '语义 authoring 服务不可用。' : '无可应用预览。');
      return;
    }
    setBusy('apply');
    const token = ++runTokenRef.current;
    try {
      const result = await applyFormalEnhancementPreview({
        snapshot,
        document,
        binding,
        ports: {
          commitCandidate: async ({ candidate, baseVersion }) => {
            if (documentStore.version !== baseVersion) {
              throw new Error('场景已在应用前被修改，请重新运行增强。');
            }
            return semanticAuthoring.replaceDocument(candidate, true, baseVersion);
          },
          validateResources: validateEnhancementResources,
        },
      });
      if (token !== runTokenRef.current) return;
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      formalSceneEnhancementStore.discard('explicit_discard');
      setSnapshot(null);
      setUnitCheckpoints([]);
      setMessage(`已应用 ${result.operationCount} 项操作（一条 history）。`);
      setRunnerNotice('应用成功。');
      showToast(`正式增强已应用 · ${result.operationCount} 项`, 'success');
      setActiveStep('segment');
    } catch (error) {
      if (token !== runTokenRef.current) return;
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (token === runTokenRef.current) setBusy('idle');
    }
  }, [binding, document, documentStore, semanticAuthoring, snapshot, validateEnhancementResources]);

  if (!document) {
    return (
      <div className="ai-prose-workbench ai-prose-workbench--empty" onMouseDown={(event) => event.stopPropagation()}>
        <header className="ai-prose-topbar">
          <div className="ai-prose-brand">正式增强</div>
          <AiWorkbenchModeSwitch />
          <div className="ai-prose-topbar__spacer" />
          {onClose && (
            <button
              className="ai-prose-button ai-prose-button--icon"
              type="button"
              onClick={onClose}
              title="关闭"
              aria-label="关闭正式 scene 增强"
            >
              <IconX width={16} height={16} />
            </button>
          )}
        </header>
        <div className="ai-prose-empty-state">
          <span className="ai-prose-empty-state__mark">EN</span>
          <h2>正式 scene 增强</h2>
          <p>打开场景后，可对当前 active scene 运行表演指导并预览结果。</p>
        </div>
      </div>
    );
  }

  const phase = snapshot?.phase ?? 'idle';
  const isStaleBanner = snapshot && !validity.valid;
  const canApply = Boolean(
    snapshot
    && validity.valid
    && snapshot.phase === 'preview_ready'
    && snapshot.previewPatch
    && snapshot.previewPatch.operations.length > 0
    && busy === 'idle',
  );
  const isBusy = busy !== 'idle';
  const liveSettledCount = liveUnits.filter((unit) => (
    unit.status === 'succeeded' || unit.status === 'retryableFailed' || unit.status === 'failed'
  )).length;
  const busyLabelText = busy === 'performance' && liveUnits.length > 0
    ? `${busyLabel(busy)} · ${liveSettledCount}/${liveUnits.length} 单元`
    : busyLabel(busy);

  return (
    <div
      className="ai-prose-workbench ai-prose-workbench--enhance"
      data-phase={phase}
      data-busy={busy}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header className="ai-prose-topbar">
        <div className="ai-prose-brand">正式增强</div>
        <AiWorkbenchModeSwitch />
        <div className="ai-prose-topbar__spacer" />
        <span className="ai-prose-save-state">
          <i />
          预览 · v
          {documentVersion}
        </span>
        <span className={`ai-prose-ai-state ${phase === 'failed' ? 'is-error' : phase === 'preview_ready' ? 'is-ready' : isBusy ? 'is-running' : ''}`}>
          <i />
          {isBusy ? busyLabelText : PHASE_LABELS[phase]}
        </span>
        <button className="ai-prose-button ai-prose-button--ghost" type="button" onClick={() => setTraceOpen((value) => !value)}>
          {traceOpen ? '隐藏轨迹' : '显示轨迹'}
        </button>
        {snapshot && (
          <button className="ai-prose-button ai-prose-button--ghost" type="button" onClick={handleDiscard} disabled={isBusy}>
            丢弃预览
          </button>
        )}
        <button
          className="ai-prose-button ai-prose-button--ghost"
          type="button"
          onClick={() => void eventBus.emit('ui:openSettings', { tab: 'ai' })}
        >
          AI 设置
        </button>
        {onClose && (
          <button
            className="ai-prose-button ai-prose-button--icon"
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭正式 scene 增强"
          >
            <IconX width={16} height={16} />
          </button>
        )}
      </header>

      <div className={`ai-prose-body-grid ${traceOpen ? 'has-trace' : ''}`}>
        <aside className="ai-prose-source-rail" aria-label="增强阶段">
          <div className="ai-prose-rail-inner">
            <div className="ai-prose-section-title">
              <h2>{document.meta.title || document.sceneId}</h2>
              <span className="ai-prose-session-id">
                v
                {documentVersion}
              </span>
            </div>
            <div className="ai-prose-field-foot">
              <strong>
                {formatCount(document.statements.length)}
                {' '}
                句
              </strong>
              <span>
                {formatCount(segmentationPreview?.speakerTextVisibleChars ?? 0)}
                {' '}
                对白字 ·
                {' '}
                {segmentationPreview?.requestedTarget ?? 0}
                {' '}
                期望段
              </span>
            </div>

            <div className="ai-prose-section-title ai-prose-section-title--artifacts">
              <h3>阶段</h3>
              <span>
                {STEPS.findIndex((step) => step.id === activeStep) + 1}
                {' '}
                / 3
              </span>
            </div>
            <div className="ai-prose-artifact-list" role="tablist" aria-label="增强阶段">
              {STEPS.map((step) => {
                const state = stepState(step.id, snapshot, busy, isStepDone(step.id, snapshot));
                return (
                  <button
                    key={step.id}
                    type="button"
                    role="tab"
                    aria-selected={activeStep === step.id}
                    className={`ai-prose-artifact-item ${activeStep === step.id ? 'is-active' : ''}`}
                    onClick={() => setActiveStep(step.id)}
                    disabled={isBusy}
                  >
                    <span className="ai-prose-artifact-glyph">
                      {state === 'succeeded' ? '✓' : step.id === 'performance' ? <IconPerformanceDirector width={12} height={12} /> : step.number}
                    </span>
                    <span className="ai-prose-artifact-name">{step.label}</span>
                    <span className={`ai-prose-artifact-state is-${state}`}>
                      {state === 'succeeded' ? '就绪' : state === 'running' ? '运行中' : state === 'failed' ? '需重试' : '未开始'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <main className="ai-prose-pipeline-space">
          {(isStaleBanner || message || runnerNotice) && (
            <div className={`ai-prose-run-banner ${isStaleBanner ? 'is-stale' : ''}`}>
              <div className="ai-prose-run-title">
                <span className="ai-prose-run-icon">{isStaleBanner ? '!' : phase === 'no_changes' ? '·' : 'i'}</span>
                <strong>{isStaleBanner ? '预览已失效' : message || runnerNotice}</strong>
              </div>
            </div>
          )}

          <div className="ai-prose-artifact-workspace">
            {activeStep === 'segment' && segmentationPreview && (
              <SegmentStep
                preview={segmentationPreview}
                targetBatchSize={targetBatchSize}
                segmentMode={segmentMode}
                timepointInput={timepointInput}
                resolvedTimepoints={resolvedTimepoints}
                onModeChange={setSegmentMode}
                onTimepointInputChange={setTimepointInput}
                onConfirm={() => void handleConfirmSegmentation()}
                hasLockedSegmentation={Boolean(snapshot?.segmentation)}
                busy={busy === 'segment'}
                hasOrchestrator={Boolean(orchestrator)}
              />
            )}

            {activeStep === 'performance' && (
              <StageRunPanel
                icon={<IconPerformanceDirector width={18} height={18} />}
                title="表演指导"
                body="补全 motion / expression / lookAt / blink 与 characterTransform。空 motion 占位可填；已有非空字段不覆盖。"
                stageResult={snapshot?.performance}
                segmentCount={snapshot?.segmentation?.segmentKeys.length ?? 0}
                units={unitCheckpoints.filter((unit) => unit.stage === 'performance')}
                liveUnits={liveStage === 'performance' ? liveUnits : []}
                liveStage={liveStage}
                segmentPreviews={segmentPreviews}
                busy={busy === 'performance'}
                canRun={Boolean(snapshot?.segmentation && orchestrator && !isBusy)}
                primaryLabel="运行表演指导"
                onRun={() => void handleRunPerformance()}
              />
            )}

            {activeStep === 'preview' && (
              <PreviewStep
                snapshot={snapshot}
                summary={patchSummary}
                canApply={canApply}
                applying={busy === 'apply'}
                onDiscard={handleDiscard}
                onApply={() => void handleApply()}
              />
            )}
          </div>
        </main>

        {traceOpen && (
          <AiRequestTracePanel
            requests={aiTrace.traceRequests}
            expandedIds={aiTrace.expandedRequestIds}
            onToggle={aiTrace.toggleTraceRequest}
            onCollapse={() => setTraceOpen(false)}
          />
        )}
      </div>

      <footer className="ai-prose-bottom-bar">
        <div className="ai-prose-bottom-summary">
          <span className="ai-prose-bottom-mark">
            {STEPS.find((step) => step.id === activeStep)?.number}
          </span>
          <span>
            <strong>{STEPS.find((step) => step.id === activeStep)?.label}</strong>
            <small>
              绑定 version {documentVersion}
              {snapshot?.previewPatch
                ? ` · ${snapshot.previewPatch.operations.length} 项操作`
                : ' · 未生成预览 patch'}
            </small>
          </span>
        </div>
        <div className="ai-prose-bottom-spacer" />
        <div className="ai-prose-bottom-actions">
          {activeStep === 'segment' && (
            <button
              className="ai-prose-button ai-prose-button--primary"
              type="button"
              disabled={isBusy}
              onClick={() => void handleConfirmSegmentation()}
            >
              {busy === 'segment' ? '分段中…' : '确认分段'}
              <span>→</span>
            </button>
          )}
          {activeStep === 'performance' && (
            <>
              <button
                className="ai-prose-button ai-prose-button--secondary"
                type="button"
                disabled={!snapshot?.segmentation || isBusy}
                onClick={() => void handleRunPerformance()}
              >
                {busy === 'performance' ? '运行中…' : '运行表演'}
              </button>
              <button
                className="ai-prose-button ai-prose-button--primary"
                type="button"
                disabled={isBusy}
                onClick={() => setActiveStep('preview')}
              >
                查看预览
                <span>→</span>
              </button>
            </>
          )}
          {activeStep === 'preview' && (
            <button
              className="ai-prose-button ai-prose-button--primary"
              type="button"
              disabled={!canApply}
              onClick={() => void handleApply()}
            >
              {busy === 'apply' ? '应用中…' : '应用到时间线'}
              <span>→</span>
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

function busyLabel(busy: 'idle' | 'segment' | 'performance' | 'apply'): string {
  switch (busy) {
    case 'segment': return '分段中';
    case 'performance': return '表演中';
    case 'apply': return '应用中';
    default: return '就绪';
  }
}

function isStepDone(step: EnhancementStep, snapshot: SceneEnhancementSnapshotV1 | null): boolean {
  if (!snapshot) return false;
  if (step === 'segment') return Boolean(snapshot.segmentation);
  if (step === 'performance') return snapshot.performance?.status === 'succeeded';
  return snapshot.phase === 'preview_ready' || snapshot.phase === 'no_changes';
}

type StepState = 'idle' | 'running' | 'succeeded' | 'failed';

function stepState(
  step: EnhancementStep,
  snapshot: SceneEnhancementSnapshotV1 | null,
  busy: 'idle' | 'segment' | 'performance' | 'apply',
  done: boolean,
): StepState {
  if (busy !== 'idle') {
    if ((step === 'segment' && busy === 'segment')
      || (step === 'performance' && busy === 'performance')
      || (step === 'preview' && busy === 'apply')) {
      return 'running';
    }
  }
  if (done) return 'succeeded';
  if (!snapshot) return 'idle';
  if (step === 'performance') {
    const status = snapshot.performance?.status;
    return status === 'retryableFailed' || status === 'failed' ? 'failed' : 'idle';
  }
  if (step === 'segment') return 'idle';
  return snapshot.phase === 'failed' ? 'failed' : 'idle';
}

function SegmentStep({
  preview,
  targetBatchSize,
  segmentMode,
  timepointInput,
  resolvedTimepoints,
  onModeChange,
  onTimepointInputChange,
  onConfirm,
  hasLockedSegmentation,
  busy,
  hasOrchestrator,
}: {
  preview: NonNullable<ReturnType<typeof previewFormalSegmentation>>;
  targetBatchSize: number;
  segmentMode: 'auto' | 'timepoints';
  timepointInput: string;
  resolvedTimepoints: ReturnType<typeof resolveFormalUserTimepoints> | null;
  onModeChange: (mode: 'auto' | 'timepoints') => void;
  onTimepointInputChange: (value: string) => void;
  onConfirm: () => void;
  hasLockedSegmentation: boolean;
  busy: boolean;
  hasOrchestrator: boolean;
}) {
  return (
    <div className="ai-prose-tab-panel ai-enhance-panel">
      <div className="ai-prose-tab-intro">
        <div>
          <h2>叙事分段</h2>
        </div>
      </div>

      <div className="ai-enhance-mode-row" role="group" aria-label="分段方式">
        <button
          type="button"
          className={`ai-prose-button ${segmentMode === 'auto' ? 'ai-prose-button--primary' : 'ai-prose-button--secondary'}`}
          onClick={() => onModeChange('auto')}
          disabled={busy}
        >
          自动
        </button>
        <button
          type="button"
          className={`ai-prose-button ${segmentMode === 'timepoints' ? 'ai-prose-button--primary' : 'ai-prose-button--secondary'}`}
          onClick={() => onModeChange('timepoints')}
          disabled={busy}
        >
          时间点
        </button>
      </div>

      <div className="ai-prose-field-foot">
        <strong>
          期望
          {' '}
          {preview.requestedTarget}
          {' '}
          段 · 可形成
          {' '}
          {preview.effectiveTarget}
        </strong>
        <span>
          边界
          {' '}
          {preview.candidateBoundaryCount}
          {' · batch '}
          {formatCount(targetBatchSize)}
        </span>
      </div>

      {segmentMode === 'auto' && preview.effectiveTarget > 1 && !hasOrchestrator && (
        <div className="ai-enhance-note">多段自动需要 AI 服务；请配置设置或改用时间点。</div>
      )}

      {segmentMode === 'timepoints' && (
        <div className="ai-enhance-timepoints">
          <label htmlFor="formal-enhance-timepoints">时间点（秒或 mm:ss）</label>
          <textarea
            id="formal-enhance-timepoints"
            className="ai-prose-source-editor ai-enhance-timepoints__input"
            value={timepointInput}
            onChange={(event) => onTimepointInputChange(event.target.value)}
            placeholder={'12.5\n01:05\n90'}
            disabled={busy}
          />
          {resolvedTimepoints?.ok && (
            <div className="ai-enhance-resolved">
              <div className="ai-prose-section-title">
                <h3>段起点</h3>
                <span>
                  {resolvedTimepoints.resolvedStarts.length}
                  {' '}
                  cuts
                </span>
              </div>
              <ul>
                {resolvedTimepoints.resolvedStarts.map((item) => (
                  <li key={`${item.groupIndex}-${item.timepoint}`}>
                    <span>{formatFormalTime(item.timepoint)}</span>
                    <b>
                      → G
                      {item.groupIndex}
                      {' · '}
                      {formatFormalTime(item.groupTime)}
                    </b>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {resolvedTimepoints && !resolvedTimepoints.ok && (
            <div className="ai-enhance-note ai-enhance-note--error">{resolvedTimepoints.message}</div>
          )}
        </div>
      )}

      <div className="ai-enhance-groups">
        <div className="ai-prose-section-title">
          <h3>Groups</h3>
          <span>{preview.groups.length}</span>
        </div>
        <div className="ai-enhance-group-list">
          {preview.groups.length === 0 ? (
            <div className="ai-enhance-note">空 scene → no_changes</div>
          ) : (
            preview.groups.map((group) => (
              <div key={group.index} className="ai-enhance-group-row">
                <span className="ai-enhance-group-row__index">
                  G
                  {group.index}
                </span>
                <b>{formatFormalTime(group.time)}</b>
                <span>
                  {group.rootCount}
                  {' '}
                  roots
                </span>
                <span>{group.hasSpeakerText ? `${formatCount(group.visibleChars)} 字` : '非文本'}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="ai-enhance-actions">
        <button
          className="ai-prose-button ai-prose-button--primary"
          type="button"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? '处理中…' : hasLockedSegmentation ? '重新锁定分段' : '确认分段'}
        </button>
      </div>
    </div>
  );
}

function StageRunPanel({
  icon,
  title,
  body,
  stageResult,
  segmentCount,
  units,
  liveUnits,
  liveStage,
  segmentPreviews,
  busy,
  canRun,
  primaryLabel,
  onRun,
}: {
  icon?: React.ReactNode;
  title: string;
  body: string;
  stageResult?: SceneEnhancementStageResultV1;
  segmentCount: number;
  units: readonly EnhancementUnitCheckpointV1[];
  liveUnits: readonly LiveUnitRow[];
  liveStage: EnhancementUnitCheckpointV1['stage'] | null;
  segmentPreviews: readonly SegmentPreviewV1[];
  busy: boolean;
  canRun: boolean;
  primaryLabel: string;
  onRun: () => void;
}) {
  const status = stageResult?.status ?? 'idle';
  const showLiveUnits = busy && liveStage !== null && liveUnits.length > 0;
  const liveSettled = liveUnits.filter((unit) => (
    unit.status === 'succeeded' || unit.status === 'retryableFailed' || unit.status === 'failed'
  )).length;
  const liveProgress = liveUnits.length > 0
    ? Math.round((liveSettled / liveUnits.length) * 100)
    : 0;
  return (
    <div className="ai-prose-tab-panel ai-enhance-panel">
      <div className="ai-prose-tab-intro">
        <div>
          <h2>
            {icon ? <span style={{ display: 'inline-flex', verticalAlign: 'middle', marginRight: 8, opacity: 0.9 }}>{icon}</span> : null}
            {title}
          </h2>
          <p>{body}</p>
        </div>
      </div>
      <div className="ai-prose-field-foot">
        <strong>
          {segmentCount}
          {' '}
          叙事段
        </strong>
        <span className={`ai-enhance-status is-${status}`}>
          {busy ? '运行中' : UNIT_STATUS_LABELS[status] ?? status}
        </span>
      </div>

      {(busy || showLiveUnits) && (
        <div className="ai-prose-segment-progress" aria-live="polite">
          <div>
            <strong>
              {showLiveUnits ? `处理单元 ${liveSettled}/${liveUnits.length}` : '处理中'}
            </strong>
            <b>{liveProgress}%</b>
          </div>
          <div className="ai-prose-progress-track">
            <span style={{ width: `${showLiveUnits ? liveProgress : 8}%` }} />
          </div>
          <small>
            {showLiveUnits ? '单元按叙事段切分，逐个通过校验后合并' : '正在读取模型能力与资源目录…'}
          </small>
        </div>
      )}

      {showLiveUnits && (
        <div className="ai-enhance-unit-list" aria-label="实时处理单元">
          {liveUnits.map((unit, index) => (
            <div key={unit.key} className={`ai-enhance-unit-row is-${unit.status}`}>
              <span className="ai-enhance-unit-row__key">
                #{index + 1} {unit.key}
                {' · '}
                {unit.narrativeKey}
                {' · G'}
                {unit.startGroupIndex}
                –G
                {Math.max(0, unit.endGroupIndexExclusive - 1)}
                {' · '}
                {formatCount(unit.visibleChars)}
                字
              </span>
              <b>{UNIT_STATUS_LABELS[unit.status] ?? unit.status}</b>
              <span>
                ×
                {unit.attemptCount}
              </span>
              {unit.diagnostics && unit.diagnostics.length > 0 && (
                <small>{unit.diagnostics.map((d) => d.message).join(' · ')}</small>
              )}
            </div>
          ))}
        </div>
      )}

      {!busy && units.length > 0 && (
        <div className="ai-enhance-unit-list" aria-label="处理单元">
          {units.map((unit) => (
            <div key={unit.key} className={`ai-enhance-unit-row is-${unit.status}`}>
              <span className="ai-enhance-unit-row__key">{unit.key}</span>
              <b>{UNIT_STATUS_LABELS[unit.status] ?? unit.status}</b>
              <span>
                ×
                {unit.attemptCount}
              </span>
              {unit.diagnostics && unit.diagnostics.length > 0 && (
                <small>{unit.diagnostics.map((d) => d.message).join(' · ')}</small>
              )}
            </div>
          ))}
        </div>
      )}

      {segmentPreviews.length > 0 && (
        <div className="ai-enhance-segment-list" aria-label="故事段预览">
          {segmentPreviews.map((preview, index) => (
            <details key={preview.key} className="ai-enhance-segment-card" open={index === 0}>
              <summary>
                <span className="ai-enhance-segment-card__badge">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <b>{preview.key}</b>
                <span>
                  G{preview.startGroupIndex}
                  –G
                  {Math.max(0, preview.endGroupIndexExclusive - 1)}
                </span>
                <span>{formatCount(preview.visibleChars)} 字</span>
                <span>
                  {preview.performances.length}
                  {' '}
                  条表演
                </span>
              </summary>
              {preview.storyText && (
                <pre className="ai-enhance-segment-card__text">{preview.storyText}</pre>
              )}
              {preview.performances.length > 0 && (
                <div className="ai-enhance-segment-card__perf">
                  {preview.performances.map((perf) => (
                    <span key={perf.line} className="ai-enhance-segment-card__perf-row">
                      <code>L{perf.parentLine}</code>
                      {' '}
                      characterPerformance
                      {' · '}
                      target
                      {' '}
                      <code>{perf.target ?? '—'}</code>
                      {' · motion '}
                      <code>
                        {perf.motion === undefined
                          ? '—'
                          : perf.motion === ''
                            ? '""（占位）'
                            : `"${perf.motion}"`}
                      </code>
                    </span>
                  ))}
                </div>
              )}
              {!preview.storyText && preview.performances.length === 0 && (
                <div className="ai-enhance-note">该段没有 speaker/text 或表演占位。</div>
              )}
            </details>
          ))}
        </div>
      )}

      {stageResult?.diagnostics && stageResult.diagnostics.length > 0 && (
        <div className="ai-enhance-note ai-enhance-note--error">
          {stageResult.diagnostics.map((d) => d.message).join('；')}
        </div>
      )}

      {stageResult?.patch && (
        <div className="ai-prose-field-foot">
          <strong>
            {stageResult.patch.operations.length}
            {' '}
            操作
          </strong>
          <span>
            {stageResult.policyVersion ?? 'policy'}
            {' · '}
            {stageResult.processorVersion ?? 'processor'}
          </span>
        </div>
      )}

      <div className="ai-enhance-actions">
        <button
          className="ai-prose-button ai-prose-button--primary"
          type="button"
          disabled={!canRun}
          onClick={onRun}
        >
          {busy ? '运行中…' : primaryLabel}
        </button>
      </div>
    </div>
  );
}

function PreviewStep({
  snapshot,
  summary,
  canApply,
  applying,
  onDiscard,
  onApply,
}: {
  snapshot: SceneEnhancementSnapshotV1 | null;
  summary: ReturnType<typeof summarizeSemanticScenePatch> | null;
  canApply: boolean;
  applying: boolean;
  onDiscard: () => void;
  onApply: () => void;
}) {
  if (!snapshot) {
    return (
      <div className="ai-prose-tab-panel ai-enhance-panel">
        <div className="ai-prose-tab-intro">
          <div>
            <h2>预览应用</h2>
            <p>先确认分段，再运行表演指导。</p>
          </div>
        </div>
      </div>
    );
  }

  if (snapshot.phase === 'no_changes') {
    return (
      <div className="ai-prose-tab-panel ai-enhance-panel">
        <div className="ai-prose-tab-intro">
          <div>
            <h2>无需更改</h2>
            <p>空 scene：不请求模型、不写 history。</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-prose-tab-panel ai-enhance-panel">
      <div className="ai-prose-tab-intro">
        <div>
          <h2>预览摘要</h2>
          <p>
            version
            {' '}
            {snapshot.binding.documentVersion}
            {' '}
            · 一次 transaction 应用
          </p>
        </div>
      </div>

      <div className="ai-enhance-stage-chips">
        <span className={`ai-enhance-chip is-${snapshot.performance?.status ?? 'idle'}`}>
          表演 ·
          {' '}
          {UNIT_STATUS_LABELS[snapshot.performance?.status ?? 'idle']}
        </span>
      </div>

      {summary ? (
        <>
          <div className="ai-prose-field-foot">
            <strong>
              {summary.operationCount}
              {' '}
              操作
            </strong>
            <span>
              +
              {summary.counts.inserted}
              {' · ~'}
              {summary.counts.updated}
              {' · −'}
              {summary.counts.deleted}
              {' / '}
              {summary.counts.moved}
            </span>
          </div>

          <div className="ai-enhance-family-list">
            {summary.byFamily.map((item) => (
              <div key={item.family} className="ai-enhance-family-row">
                <span className={`ai-enhance-family-dot is-${item.family}`} />
                <b>{FAMILY_LABELS[item.family] ?? item.family}</b>
                <span>{item.count}</span>
                <small>{item.operations.map((op) => OP_LABELS[op] ?? op).join(' · ')}</small>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="ai-enhance-note">尚无 preview patch。请先运行表演指导。</div>
      )}

      <div className="ai-enhance-actions">
        <button className="ai-prose-button ai-prose-button--secondary" type="button" onClick={onDiscard} disabled={applying}>
          丢弃
        </button>
        <button
          className="ai-prose-button ai-prose-button--primary"
          type="button"
          disabled={!canApply}
          onClick={onApply}
        >
          {applying ? '应用中…' : '应用到时间线'}
        </button>
      </div>
    </div>
  );
}

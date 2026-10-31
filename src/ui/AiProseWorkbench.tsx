import './ai-prose-workbench.css';
import { eventBus } from '../api/events';
import { collectEnhancementPerformanceMotions } from '../services/ai-authoring/FormalEnhancementApply';
import { AiWorkbenchModeSwitch } from './AiWorkbenchMode';
import { AiRequestTracePanel } from './AiProseTrace';
import { IconCheck, IconChevronLeft, IconChevronRight, IconFileText, IconPlus, IconX } from './icons';
import { useAiProseWorkbench } from './ai-prose/useAiProseWorkbench';
import { SourceEditor, SourceReference, SourceStage } from './ai-prose/SourceStage';
import { SegmentsStage } from './ai-prose/SegmentsStage';
import { CharactersStage } from './ai-prose/CharactersStage';
import { NormalizeStage } from './ai-prose/NormalizeStage';
import { TimingStage } from './ai-prose/TimingStage';
import { ApplyDialog, WorkbenchErrorAlert } from './ai-prose/WorkbenchFeedback';
import { STAGES, createWorkbenchErrorInfo, formatCount, getCompletedTaskCount, isStageReady, stageStatus, statusText } from './ai-prose/workbenchPresentation';

export function AiProseWorkbench({ onClose }: { onClose?: () => void } = {}) {
  const {
    composition,
    project,
    document,
    draft,
    activeStage,
    setActiveStage,
    sourceText,
    sourceName,
    mainCharacters,
    setMainCharacters,
    targetBatchSize,
    scriptReadingSpeed,
    busyStage,
    errorMessage,
    errorInfo,
    persistenceMessage,
    initializing,
    initializationMessage,
    traceOpen,
    setTraceOpen,
    showApplyDialog,
    setShowApplyDialog,
    enableActing,
    setEnableActing,
    enableCinematic,
    setEnableCinematic,
    enhancementBusy,
    enhancementMessage,
    enhancementStagePlan,
    fileInputKey,
    dialogRef,
    aiTrace,
    startNewDraft,
    handleSourceChange,
    handleImportFile,
    runPrepare,
    handleReadingSpeedChange,
    handleTargetBatchSizeChange,
    handleBindingChange,
    runNormalization,
    retryNormalizationSegment,
    runRhythm,
    handleRunDraftEnhancement,
    handleDuplicateArchive,
    handleDeleteArchive,
    handleApply,
    lineCount,
    visibleCount,
    spokenCount,
    segments,
    normalizationBlocks,
    filteredBlocks,
    selectedFilter,
    setSelectedFilter,
    selectedSegment,
    setSelectedSegment,
    canApply,
    activeStageIndex,
    aiStateText,
    aiStateClass,
  } = useAiProseWorkbench(onClose);

  if (!composition || !project || !document) {
    return (
      <div className="ai-prose-workbench ai-prose-workbench--empty">
        <div className="ai-prose-empty-state">
          <span className="ai-prose-empty-state__mark">AI</span>
          <h2>AI 铺戏工作台</h2>
          <p>打开项目和场景后，可将完整正文无损结构化为可编排语句。</p>
        </div>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="ai-prose-workbench ai-prose-workbench--empty">
        <header className="ai-prose-topbar">
          <div className="ai-prose-brand">AI 铺戏</div>
          <AiWorkbenchModeSwitch />
          <div className="ai-prose-topbar__spacer" />
          {onClose && <button className="ai-prose-button ai-prose-button--icon" type="button" onClick={onClose} title="关闭 AI 铺戏" aria-label="关闭 AI 铺戏"><IconX width={16} height={16} /></button>}
        </header>
        <div className="ai-prose-empty-state">
          <span className="ai-prose-empty-state__mark">{initializing ? '…' : '!'}</span>
          <h2>{initializing ? '正在恢复 AI 草稿' : 'AI 草稿不可用'}</h2>
          <p>{initializationMessage || errorMessage || '当前场景还没有可编辑的草稿。'}</p>
          {!initializing && <button className="ai-prose-button ai-prose-button--primary" type="button" onClick={startNewDraft}>新建草稿</button>}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={dialogRef}
      className="ai-prose-workbench"
      data-stage={activeStage}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header className="ai-prose-topbar">
        <div className="ai-prose-brand">AI 铺戏</div>
        <AiWorkbenchModeSwitch />
        <div className="ai-prose-topbar__spacer" />
        <span className="ai-prose-save-state"><i />{persistenceMessage ? '保存异常' : '草稿已保存'}</span>
        <span className={`ai-prose-ai-state ${aiStateClass}`} aria-live="polite"><i />{aiStateText}</span>
        <button className="ai-prose-button ai-prose-button--ghost" type="button" aria-expanded={traceOpen} onClick={() => setTraceOpen((value) => !value)}>{traceOpen ? '隐藏轨迹' : '显示轨迹'}</button>
        <button className="ai-prose-button ai-prose-button--ghost" type="button" onClick={() => void eventBus.emit('ui:openSettings', { tab: 'ai' })}>AI 设置</button>
        <button className="ai-prose-button ai-prose-button--icon" type="button" onClick={startNewDraft} title="新建 AI 草稿" aria-label="新建 AI 草稿"><IconPlus size={16} /></button>
        {onClose && <button className="ai-prose-button ai-prose-button--icon" type="button" onClick={onClose} title="关闭 AI 铺戏" aria-label="关闭 AI 铺戏"><IconX width={16} height={16} /></button>}
      </header>

      <div className={`ai-prose-body-grid ${traceOpen ? 'has-trace' : ''}`}>
        <aside className="ai-prose-source-rail" aria-label="正文与阶段">
          <div className="ai-prose-rail-inner">
            <div className="ai-prose-draft-context">
              <IconFileText size={18} />
              <div>
                <strong title={document.meta.title || document.sceneId}>{document.meta.title || document.sceneId}</strong>
                <span>{draft.status === 'applied' ? '已应用的草稿' : 'AI 铺戏草稿'}</span>
              </div>
            </div>
            <div className="ai-prose-section-title ai-prose-section-title--artifacts">
              <h3>铺戏流程</h3>
              <span>
                {getCompletedTaskCount(STAGES.map((stage) => ({ status: stageStatus(draft, stage.id) })))}
                {' '}
                /
                {' '}
                5
              </span>
            </div>
            <div className="ai-prose-artifact-list" role="tablist" aria-orientation="vertical" aria-label="AI 铺戏阶段">
              {STAGES.map((stage) => {
                const status = stageStatus(draft, stage.id);
                return (
                  <button
                    key={stage.id}
                    id={`ai-prose-tab-${stage.id}`}
                    className={`ai-prose-artifact-item ${activeStage === stage.id ? 'is-active' : ''}`}
                    type="button"
                    role="tab"
                    aria-selected={activeStage === stage.id}
                    aria-controls="ai-prose-stage-panel"
                    tabIndex={activeStage === stage.id ? 0 : -1}
                    onKeyDown={(event) => {
                      const availableStages = STAGES.filter((item) => isStageReady(draft, item.id));
                      const index = availableStages.findIndex((item) => item.id === stage.id);
                      let nextIndex: number;
                      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % availableStages.length;
                      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + availableStages.length) % availableStages.length;
                      else if (event.key === 'Home') nextIndex = 0;
                      else if (event.key === 'End') nextIndex = availableStages.length - 1;
                      else return;
                      event.preventDefault();
                      const nextStage = availableStages[nextIndex];
                      setActiveStage(nextStage.id);
                      event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#ai-prose-tab-${nextStage.id}`)?.focus();
                    }}
                    onClick={() => setActiveStage(stage.id)}
                    disabled={!isStageReady(draft, stage.id)}
                  >
                    <span className={`ai-prose-artifact-glyph is-${status}`} aria-hidden="true">{status === 'succeeded' ? <IconCheck size={14} /> : stage.number}</span>
                    <span className="ai-prose-artifact-name"><span>{stage.label}</span><span className="ai-prose-artifact-short-name">{stage.shortLabel}</span></span>
                    <span className={`ai-prose-artifact-state is-${status}`}>{statusText(status)}</span>
                  </button>
                );
              })}
            </div>
            <div className="ai-prose-rail-source">
              {activeStage !== 'source' ? (
                <SourceReference
                  sourceText={sourceText}
                  sourceName={sourceName}
                  busy={busyStage !== null}
                  onEdit={(event) => {
                    setActiveStage('source');
                    event.currentTarget.closest('aside')?.querySelector<HTMLButtonElement>('#ai-prose-tab-source')?.focus();
                  }}
                />
              ) : (
                <p className="ai-prose-draft-note">分析结果保存在草稿中。完成预览后，再写入正式时间线。</p>
              )}
            </div>
          </div>
        </aside>

        <main className="ai-prose-pipeline-space" id="ai-prose-workbench-title">
          {errorMessage && <WorkbenchErrorAlert info={errorInfo ?? createWorkbenchErrorInfo(errorMessage, activeStage)} />}
          {busyStage && (
            <div className="ai-prose-run-banner is-running" role="status">
              <div className="ai-prose-run-title">
                <span className="ai-prose-run-icon">…</span>
                <strong>
                  正在运行：
                  {STAGES.find((stage) => stage.id === busyStage)?.label}
                </strong>
              </div>
            </div>
          )}

          <div className="ai-prose-artifact-workspace" id="ai-prose-stage-panel" role="tabpanel" aria-labelledby={`ai-prose-tab-${activeStage}`} tabIndex={0}>
            {activeStage === 'source' && (
              <SourceStage
                anchorMode={draft.anchorMode}
                scriptReadingSpeed={scriptReadingSpeed}
                onReadingSpeedChange={handleReadingSpeedChange}
                editor={(
                  <SourceEditor
                    sourceText={sourceText}
                    sourceName={sourceName}
                    visibleCount={visibleCount}
                    spokenCount={spokenCount}
                    fileInputKey={fileInputKey}
                    busy={busyStage !== null}
                    onSourceChange={handleSourceChange}
                    onImportFile={handleImportFile}
                  />
                )}
              />
            )}
            {activeStage === 'segments' && (
              <SegmentsStage
                draft={draft}
                segments={segments}
                selectedSegment={selectedSegment}
                targetBatchSize={targetBatchSize}
                onSelectSegment={setSelectedSegment}
                onTargetBatchSizeChange={handleTargetBatchSizeChange}
                onPrepare={() => void runPrepare()}
                busy={busyStage !== null}
              />
            )}
            {activeStage === 'characters' && (
              <CharactersStage
                draft={draft}
                names={mainCharacters}
                document={document}
                onNamesChange={setMainCharacters}
                onBindingChange={handleBindingChange}
                busy={busyStage !== null}
              />
            )}
            {activeStage === 'normalize' && (
              <NormalizeStage
                draft={draft}
                blocks={filteredBlocks}
                selectedFilter={selectedFilter}
                onFilterChange={setSelectedFilter}
                onRetry={retryNormalizationSegment}
                onNormalize={() => void runNormalization(draft.confirmedMainCharacters)}
                busy={busyStage !== null}
              />
            )}
            {activeStage === 'timing' && (
              <TimingStage
                draft={draft}
                blocks={normalizationBlocks}
                scriptReadingSpeed={scriptReadingSpeed}
                onReadingSpeedChange={handleReadingSpeedChange}
                onRhythm={() => void runRhythm()}
                busy={busyStage !== null || enhancementBusy}
                enableActing={enableActing}
                enableCinematic={enableCinematic}
                onEnableActingChange={setEnableActing}
                onEnableCinematicChange={setEnableCinematic}
                onRunEnhancement={() => void handleRunDraftEnhancement()}
                enhancementBusy={enhancementBusy}
                enhancementMessage={enhancementMessage}
                enhancementOperationCount={enhancementStagePlan
                  ? enhancementStagePlan.stages.reduce((sum, stage) => sum + stage.patch.operations.length, 0)
                  : 0}
                enhancementMotions={enhancementStagePlan
                  ? collectEnhancementPerformanceMotions(enhancementStagePlan)
                  : null}
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
          <span className="ai-prose-bottom-mark">{STAGES[activeStageIndex]?.number}</span>
          <span>
            <strong>{STAGES[activeStageIndex]?.label}</strong>
            <small>
              {formatCount(visibleCount)}
              {' '}
              字 ·
              {' '}
              {lineCount}
              {' '}
              行
              {draft.status === 'applied' ? ' · 已应用' : ''}
              {initializationMessage ? ` · ${initializationMessage}` : ''}
            </small>
          </span>
        </div>
        <div className="ai-prose-bottom-spacer" />
        {draft.status === 'applied' && (
          <div className="ai-prose-archive-actions">
            <button
              className="ai-prose-button"
              type="button"
              onClick={() => void handleDuplicateArchive()}
              disabled={busyStage !== null}
            >
              复制为新会话
            </button>
            <button
              className="ai-prose-button ai-prose-button--archive-delete"
              type="button"
              onClick={() => void handleDeleteArchive()}
              disabled={busyStage !== null}
            >
              删除归档
            </button>
          </div>
        )}
        <div className="ai-prose-bottom-actions">
          {activeStageIndex > 0 && (
            <button
              className="ai-prose-button ai-prose-button--ghost"
              type="button"
              onClick={() => setActiveStage(STAGES[activeStageIndex - 1].id)}
              disabled={busyStage !== null || enhancementBusy}
            >
              <IconChevronLeft size={14} /> 上一步
            </button>
          )}
          <button
            className="ai-prose-button ai-prose-button--primary"
            type="button"
            onClick={() => {
              if (activeStage === 'source') void runPrepare();
              else if (activeStage === 'segments' && draft.segmentation.status === 'succeeded') setActiveStage('characters');
              else if (activeStage === 'characters') void runNormalization(mainCharacters);
              else if (activeStage === 'normalize') void runRhythm();
              else if (activeStage === 'timing') setShowApplyDialog(true);
            }}
            disabled={
              busyStage !== null
              || enhancementBusy
              || (activeStage === 'source' && !sourceText.trim())
              || (activeStage === 'segments' && draft.segmentation.status !== 'succeeded')
              || (activeStage === 'timing' && !canApply)
            }
          >
            {activeStage === 'timing'
              ? '写入正式时间线'
              : busyStage
                ? '分析中…'
                : activeStage === 'source'
                  ? '开始分析'
                  : activeStage === 'segments'
                    ? '进入人物确认'
                    : activeStage === 'characters'
                      ? '确认人物并规范化'
                      : activeStage === 'normalize'
                        ? '计算时间预览'
                        : '继续'}
            <IconChevronRight size={14} />
          </button>
        </div>
      </footer>

      {showApplyDialog && <ApplyDialog draft={draft} onCancel={() => setShowApplyDialog(false)} onConfirm={() => void handleApply()} />}
    </div>
  );
}

export default AiProseWorkbench;

import React from 'react';
import type { ProjectAgentTaskStatusPayload } from '../../api/types/project-agent-ipc';
import { diagnoseAiError } from '../../services/ai-authoring/aiErrorPresentation';
import { IconClock, IconTools, IconChevronDown, IconArrowDown, IconWarning } from '../icons';
import {
  ActivityRow,
  AssistantReply,
  ThinkDisclosure,
  StreamingReply,
  ReplyPlaceholder,
} from './AgentConversationParts';
import {
  formatPauseReason,
  formatDuration,
  formatPhase,
  TAIL_TOOL_GROUP_KEY,
  TURN_STATE_TEXT,
  type PendingSupplement,
} from './agentWindowPresentation';
import { projectAgentToolDisplayName } from '../../services/project-agent/ProjectAgentTask';
import type { AgentThreadState } from './useAgentThread';

interface AgentWindowThreadProps {
  thread: AgentThreadState;
  selectedId: string;
  selectedStatus: ProjectAgentTaskStatusPayload | null;
  selectedRunning: boolean;
  selectedSuspended: boolean;
  selectedPauseReason: string | undefined;
  selectedNoContinue: boolean;
  contextCompactionPaused: boolean;
  switchDir: 'forward' | 'back' | null;
  pendingQueue: readonly PendingSupplement[];
  waiting: boolean;
  anyRunning: boolean;
  startError: string | null;
  continueSelected: () => void;
  pauseTask: () => void;
  openSettings: () => void;
  deleteConversation: (id: string) => Promise<boolean>;
}
export function AgentWindowThread({
  thread,
  selectedId,
  selectedStatus,
  selectedRunning,
  selectedSuspended,
  selectedPauseReason,
  selectedNoContinue,
  contextCompactionPaused,
  switchDir,
  pendingQueue,
  waiting,
  anyRunning,
  startError,
  continueSelected,
  pauseTask,
  openSettings,
  deleteConversation,
}: AgentWindowThreadProps) {
  const {
    selectedLog,
    selectedActivities,
    flowWalk,
    threadSections,
    leadingLog,
    trailingReply,
    selectedVisibleUserTexts,
    selectedUndeliveredSupplements,
    expandedActivities,
    collapsedToolGroups,
    toggleActivity,
    toggleToolGroup,
    threadRef,
    handleThreadScroll,
    handleThreadWheel,
    showBackToBottom,
    scrollToBottom,
    streamingText,
    streamingReasoning,
    streamingActive,
    turnState,
    roundStart,
    roundEnd,
    turnStartedAt,
    turnDurationMs,
    clockNow,
    modelProgressLabel,
    toolProgressLabel,
  } = thread;
  /**
   * Harness-style turn tail: the status line of the latest round, the trailing
   * (not yet flow-anchored) tool rows, the in-flight tool row and the reply
   * placeholder. Rendered in place right after the round anchor, or at the end
   * of the thread when the round has no anchor yet.
   */
  const renderTurnTail = () => (
    <>
      {(flowWalk
        ? (flowWalk.trailingActivities.length > 0 || (selectedRunning && !!selectedStatus?.toolProgress))
        : (selectedRunning && !!selectedStatus?.toolProgress)) && (
        <div className="agent-tools agent-tools--tail">
          <button
            type="button"
            className="agent-tools__trigger"
            aria-expanded={!collapsedToolGroups.has(TAIL_TOOL_GROUP_KEY)}
            onClick={() => toggleToolGroup(TAIL_TOOL_GROUP_KEY)}
          >
            <span className="agent-tools__trigger-icon" aria-hidden="true">
              <IconTools width={12} height={12} />
            </span>
            <span className="agent-tools__trigger-label">工具</span>
            <span className="agent-tools__trigger-count">
              {(flowWalk ? flowWalk.trailingActivities.length : 0)
                + (selectedRunning && selectedStatus?.toolProgress ? 1 : 0)}
            </span>
            <IconChevronDown width={12} height={12} className={!collapsedToolGroups.has(TAIL_TOOL_GROUP_KEY) ? 'agent-tools__chevron--open' : ''} />
          </button>
          {!collapsedToolGroups.has(TAIL_TOOL_GROUP_KEY) && (
            <div className="agent-tools__rows">
              {flowWalk?.trailingActivities.map(({ activity, index }, rowIndex) => (
                <ActivityRow
                  key={`tail-${index}`}
                  activity={activity}
                  expanded={expandedActivities.has(index)}
                  onToggle={() => toggleActivity(index)}
                  delayIndex={rowIndex}
                />
              ))}
              {selectedRunning && selectedStatus?.toolProgress && (
                <div className="agent-log__activity agent-log__activity--live" role="status">
                  <span className="agent-log__activity-icon" aria-hidden="true">
                    <span className="agent-tool-spinner" />
                  </span>
                  <span className="agent-log__activity-text">
                    {projectAgentToolDisplayName(selectedStatus.toolProgress.toolName)}
                    {toolProgressLabel
                      ? <span className="agent-log__activity-detail">{toolProgressLabel}</span>
                      : null}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {/* The reply streams in while the model works; the phase turns
          assistant_reply only once the reply itself is in the flow. When the
          provider streams content deltas the live text renders here and the
          placeholder stays hidden. */}
      {selectedRunning && (flowWalk
        ? selectedStatus?.phase !== 'assistant_reply'
        : !trailingReply) && (
        streamingActive
          ? (
            <StreamingReply
              text={streamingText.length > 0 ? streamingText : undefined}
              reasoning={streamingReasoning.length > 0 ? streamingReasoning : undefined}
            />
          )
          : <ReplyPlaceholder />
      )}
      {/* The status line renders for a live status, or for the journal-derived
          timing of an ended round (reopened / switched-away conversation). */}
      {turnState && (selectedStatus || (roundStart !== null && roundEnd !== null)) && (
        <div className={`agent-turn-status agent-turn-status--${turnState}`} role="status">
          <span className="agent-turn-status__state">
            {turnState === 'running' ? (
              <span className="agent-turn-status__shimmer">运行中</span>
            ) : (
              <span className={`agent-turn-status__label${turnState === 'failed' ? ' agent-turn-status__label--error' : ''}`}>
                {TURN_STATE_TEXT[turnState]}
              </span>
            )}
            {turnState === 'running' && turnStartedAt !== null && !modelProgressLabel && (
              <span className="agent-turn-status__clock">
                {Math.max(0, Math.floor((clockNow - turnStartedAt) / 1000))}s
              </span>
            )}
            {turnState !== 'running' && turnDurationMs !== null && (
              <span className="agent-turn-status__clock">{formatDuration(turnDurationMs)}</span>
            )}
          </span>
          {turnState === 'running' && selectedStatus && (
            <span className="agent-turn-status__phase">
              {modelProgressLabel ?? formatPhase(selectedStatus.phase)}
            </span>
          )}
          {turnState === 'running' && selectedStatus?.model && (
            <span className="agent-turn-status__model">{selectedStatus.model}</span>
          )}
          {turnState === 'running' && selectedStatus && (
            <span className="agent-turn-status__reads">
              成功读取 {selectedStatus.counters.successfulRelatedReadCount}
            </span>
          )}
          {turnState === 'running' && selectedStatus
            && (selectedStatus.counters.successfulTerminalCommandCount ?? 0) > 0 && (
            <span className="agent-turn-status__reads">
              命令 {selectedStatus.counters.successfulTerminalCommandCount}
            </span>
          )}
          {turnState === 'running' && (
            <button
              type="button"
              className="agent-turn-status__pause"
              onClick={pauseTask}
            >
              暂停
            </button>
          )}
          {/* No continue affordance here: the paused card below owns it, and a
              lifecycle interruption renders no status line at all. The line
              would otherwise sit directly above the card's 「继续执行」 with a
              second button for the same action. */}
          {turnState === 'failed' && selectedStatus?.providerDetail && (
            <span className="agent-turn-status__error">
              <IconWarning width={12} height={12} />
              {selectedStatus.providerDetail.code}
              {selectedStatus.providerDetail.status !== undefined
                ? ` (${selectedStatus.providerDetail.status})`
                : ''}
              ：{selectedStatus.providerDetail.message}
            </span>
          )}
        </div>
      )}
    </>
  );

  return (
    <main
      className={`agent-window__thread${switchDir ? ` agent-window__thread--switching-${switchDir}` : ''}`}
      ref={threadRef}
      role="log"
      aria-live="polite"
      onScroll={handleThreadScroll}
      onWheel={handleThreadWheel}
    >
      {waiting && selectedLog.length === 0 && !flowWalk && (
        <div className="agent-window__empty agent-window__empty--idle">
          <span className="agent-window__empty-mark" aria-hidden="true">
            <IconClock width={22} height={22} />
          </span>
          <p>正在载入对话…</p>
        </div>
      )}

      {flowWalk ? (
        <>
          {(threadSections ?? []).map((section) => {
            if (section.kind === 'user') {
              return (
                <div className="agent-window__msg agent-window__msg--user" key={section.key}>
                  <div className="agent-window__bubble agent-window__bubble--user">
                    <p className="agent-window__task-text">{section.text}</p>
                  </div>
                </div>
                      );
                    }
            if (section.kind === 'assistant') {
              return (
                <React.Fragment key={section.key}>
                  {section.reasoningContent && <ThinkDisclosure content={section.reasoningContent} />}
                  {section.text && <AssistantReply text={section.text} />}
                </React.Fragment>
                      );
                    }
            return (
              <div className="agent-tools" key={section.key}>
                <button
                  type="button"
                  className="agent-tools__trigger"
                  aria-expanded={!collapsedToolGroups.has(section.key)}
                  onClick={() => toggleToolGroup(section.key)}
                >
                  <span className="agent-tools__trigger-icon" aria-hidden="true">
                    <IconTools width={12} height={12} />
                  </span>
                  <span className="agent-tools__trigger-label">工具</span>
                  <span className="agent-tools__trigger-count">{section.rows.length}</span>
                  <IconChevronDown width={12} height={12} className={!collapsedToolGroups.has(section.key) ? 'agent-tools__chevron--open' : ''} />
                </button>
                {!collapsedToolGroups.has(section.key) && (
                  <div className="agent-tools__rows">
                    {section.rows.map((row) => (
                      <ActivityRow
                        key={row.key}
                        activity={row.activity}
                        expanded={row.activityIndex >= 0 && expandedActivities.has(row.activityIndex)}
                        onToggle={() => { if (row.activityIndex >= 0) toggleActivity(row.activityIndex); }}
                        delayIndex={Math.max(0, row.activityIndex)}
                      />
                    ))}
                  </div>
                )}
              </div>
                    );
          })}
        </>
      ) : (
        <>
          {leadingLog.map((entry, index) => (
            entry.role === 'user' ? (
              <div
                className="agent-window__msg agent-window__msg--user"
                key={`user-${index}`}
              >
                <div className="agent-window__bubble agent-window__bubble--user">
                  <p className="agent-window__task-text">{entry.text}</p>
                </div>
              </div>
            ) : (
              <AssistantReply
                key={`assistant-${index}`}
                text={entry.text}
              />
            )
          ))}
          {trailingReply && (
            <AssistantReply
              key="assistant-final"
              text={trailingReply.text}
              final
            />
          )}
          {selectedActivities.map((activity, index) => (
            <ActivityRow
              key={`activity-${index}`}
              activity={activity}
              expanded={expandedActivities.has(index)}
              onToggle={() => toggleActivity(index)}
              delayIndex={index}
            />
          ))}
        </>
      )}

      {selectedUndeliveredSupplements.map((supplement) => (
        <div
          className="agent-window__msg agent-window__msg--user"
          key={`restored-${supplement.id}`}
        >
          <div className="agent-window__bubble agent-window__bubble--user">
            <p className="agent-window__task-text">{supplement.text}</p>
          </div>
        </div>
      ))}

      {!selectedRunning && pendingQueue
        .filter((pending) => (
          pending.conversationId === selectedId
          && !selectedVisibleUserTexts.has(pending.text)
          && !selectedUndeliveredSupplements.some((s) => s.text === pending.text)
        ))
        .map((pending) => (
          <div
            className="agent-window__msg agent-window__msg--user"
            key={pending.id}
          >
            <div className="agent-window__bubble agent-window__bubble--user">
              <p className="agent-window__task-text">{pending.text}</p>
            </div>
          </div>
        ))}

      {renderTurnTail()}

      {selectedRunning && pendingQueue
        .filter((pending) => (
          pending.conversationId === selectedId
          && !selectedVisibleUserTexts.has(pending.text)
          && !selectedUndeliveredSupplements.some((s) => s.text === pending.text)
        ))
        .map((pending) => (
          <div
            className="agent-window__msg agent-window__msg--user agent-window__msg--queued"
            key={pending.id}
          >
            <div className="agent-window__queued-wrap">
              <div className="agent-window__bubble agent-window__bubble--user agent-window__bubble--queued">
                <p className="agent-window__task-text">{pending.text}</p>
              </div>
              <div className="agent-window__queued-hint" aria-label="排队中">
                <IconClock width={11} height={11} aria-hidden="true" />
                <span>排队中</span>
              </div>
            </div>
          </div>
        ))}

      {showBackToBottom && (
        <button
          type="button"
          className="agent-back-to-bottom"
          onClick={scrollToBottom}
          aria-label="回到底部"
        >
          <IconArrowDown width={14} height={14} />
          回到底部
        </button>
      )}

      {selectedSuspended && (() => {
        const providerDetail = selectedStatus?.providerDetail;
        const providerDiagnosis = providerDetail
          ? diagnoseAiError(providerDetail.message, {
              code: providerDetail.code,
              status: providerDetail.status,
            })
          : null;
        const showOpenSettingsInPausedCard = (
          selectedPauseReason === 'provider_configuration_required'
          || selectedPauseReason === 'provider_protocol_incompatible'
          || Boolean(providerDiagnosis?.suggestOpenSettings)
                );
        return (
          <div className="agent-window__msg agent-window__msg--agent">
            <span className="agent-window__agent-mark" aria-hidden="true">
              <IconClock width={12} height={12} />
            </span>
            <div className="agent-window__agent-card agent-window__agent-card--paused">
              <p className="agent-window__paused-text">
                {formatPauseReason(selectedPauseReason)}
              </p>
              {providerDiagnosis && providerDiagnosis.category !== 'unknown' && (
                <p className="agent-window__paused-guidance">
                  <strong>{providerDiagnosis.userTitle}：</strong>
                  {providerDiagnosis.userMessage}
                  {' '}
                  {providerDiagnosis.suggestion}
                </p>
              )}
              {selectedNoContinue && (
                <p className="agent-window__notice agent-window__notice--error">
                  <IconWarning width={13} height={13} />
                  此对话无法继续，已提交的变更不会丢失。
                </p>
              )}
              {contextCompactionPaused && (
                <p className="agent-window__notice agent-window__notice--compaction">
                  <span className="agent-window__compress-mark" aria-hidden="true">
                    <span className="agent-window__compress-mark-bar agent-window__compress-mark-bar--left" />
                    <span className="agent-window__compress-mark-bar agent-window__compress-mark-bar--right" />
                  </span>
                  继续执行会先重试上下文压缩。
                </p>
              )}
              <div className="agent-window__actions">
                {!selectedNoContinue && (
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={anyRunning}
                    onClick={continueSelected}
                  >
                    继续执行
                  </button>
                )}
                {showOpenSettingsInPausedCard && (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={openSettings}
                  >
                    前往 AI 设置
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void deleteConversation(selectedId)}
                >
                  删除对话
                </button>
              </div>
            </div>
          </div>
                );
      })()}

      {startError && (() => {
        const diagnosis = diagnoseAiError(startError);
        return (
          <div className="agent-window__notice agent-window__notice--error" role="alert">
            <div className="agent-window__notice-row">
              <IconWarning width={13} height={13} />
              <span>{startError}</span>
            </div>
            {diagnosis.category !== 'unknown' && diagnosis.userMessage !== startError && (
              <p className="agent-window__notice-detail">
                {diagnosis.userMessage}
                {' '}
                {diagnosis.suggestion}
              </p>
            )}
            {diagnosis.suggestOpenSettings && (
              <button
                type="button"
                className="btn btn--sm agent-window__notice-action"
                onClick={openSettings}
              >
                前往 AI 设置
              </button>
            )}
          </div>
                );
      })()}
    </main>

  );
}

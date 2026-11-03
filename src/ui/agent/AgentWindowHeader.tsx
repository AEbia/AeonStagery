import type React from 'react';
import type { ProjectAgentProjectContext, ProjectAgentTaskStatusPayload } from '../../api/types/project-agent-ipc';
import {
  CONTEXT_COMPACTION_UI_THRESHOLD,
  formatContextUsedDetail,
  formatContextUsedLabel,
} from './agentWindowPresentation';

interface AgentWindowHeaderProps {
  selectedTitle: string;
  selectedStatus: ProjectAgentTaskStatusPayload | null;
  context: ProjectAgentProjectContext | null;
  selectedRunning: boolean;
  selectedPauseReason: string | undefined;
}
export function AgentWindowHeader({
  selectedTitle,
  selectedStatus,
  context,
  selectedRunning,
  selectedPauseReason,
}: AgentWindowHeaderProps) {
  const selectedContextUsed = selectedStatus?.contextUsed ?? null;
  const contextNearCompaction = !!selectedContextUsed
    && selectedContextUsed.usageRatio >= CONTEXT_COMPACTION_UI_THRESHOLD;
  const contextCompactionPaused = selectedPauseReason === 'context_compaction_required';
  const showContextCompactionCue = contextNearCompaction || contextCompactionPaused;
  const contextCompactionCueText = contextCompactionPaused ? '等待压缩' : '即将压缩';
  const contextCompactionCueTitle = contextCompactionPaused
    ? '本轮执行已因上下文压缩暂停；继续执行时会先重试压缩。'
    : '上下文接近模型上限；下次请求前会先压缩上下文。';
  return (
    <header className="agent-window__header">
      <div className="agent-window__identity">
        <div className="agent-window__identity-text">
          <strong>{selectedTitle}</strong>
          {selectedStatus?.sceneName
            ? <span className="agent-window__identity-scene">{selectedStatus.sceneName}</span>
            : context?.sceneName
              ? <span className="agent-window__identity-scene">{context.sceneName}</span>
              : null}
        </div>
      </div>
      <div className="agent-window__badge-wrap">
        {selectedContextUsed && (
          <span
            className={`agent-window__context-used${contextNearCompaction ? ' agent-window__context-used--warn agent-window__context-used--compacting' : ''}`}
            title={formatContextUsedDetail(selectedContextUsed)}
          >
            <span className="agent-window__context-used-bar" aria-hidden="true">
              <span
                className="agent-window__context-used-fill"
                style={{
                  '--context-usage-ratio': String(Math.min(1, selectedContextUsed.usageRatio)),
                } as React.CSSProperties}
              />
            </span>
            <span className="agent-window__context-used-label">
              {formatContextUsedLabel(selectedContextUsed)}
            </span>
          </span>
        )}
        {showContextCompactionCue && (
          <span
            className={`agent-window__badge agent-window__badge--compaction${contextCompactionPaused ? ' agent-window__badge--compaction-paused' : ''}`}
            title={contextCompactionCueTitle}
          >
            <span className="agent-window__compress-mark" aria-hidden="true">
              <span className="agent-window__compress-mark-bar agent-window__compress-mark-bar--left" />
              <span className="agent-window__compress-mark-bar agent-window__compress-mark-bar--right" />
            </span>
            {contextCompactionCueText}
          </span>
        )}
        {selectedRunning && (
          <span className="agent-window__badge agent-window__badge--running">
            <span className="agent-window__pulse" aria-hidden="true" />
            运行中
          </span>
        )}
      </div>
    </header>

  );
}

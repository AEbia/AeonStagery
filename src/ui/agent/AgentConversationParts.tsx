import React, { useState } from 'react';
import type { ProjectAgentActivityRecord } from '../../services/project-agent/ProjectAgentTask';
import {
  IconAgent,
  IconChevronDown,
  IconThink,
  IconTools,
  IconToolCompaction,
  IconToolProjectFiles,
  IconToolProjectOverview,
  IconToolProjectSearch,
  IconToolProjectText,
  IconToolResourceInspect,
  IconToolResourceSearch,
  IconToolSceneRead,
  IconToolSceneSearch,
  IconToolSceneValidate,
  IconToolTerminal,
  IconToolVision,
  IconToolWrite,
  IconWarning,
} from '../icons';
import { MarkdownContent } from '../MarkdownContent';

interface AssistantReplyProps {
  text: string;
  final?: boolean;
}

export const AssistantReply: React.FC<AssistantReplyProps> = ({ text, final }) => (
  <div className={`agent-log__assistant${final ? ' agent-log__assistant--final' : ''}`}>
    <div className="agent-log__assistant-label">
      <IconAgent width={12} height={12} />
      项目 Agent
    </div>
    <MarkdownContent text={text} />
  </div>
);

/** Collapsible reasoning shown above an assistant reply when present. */
export const ThinkDisclosure: React.FC<{ content: string }> = ({ content }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="agent-think">
      <button
        type="button"
        className="agent-think__trigger"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="agent-think__trigger-icon" aria-hidden="true">
          <IconThink width={12} height={12} />
        </span>
        <span className="agent-think__trigger-label">思考</span>
        <IconChevronDown width={12} height={12} className={open ? 'agent-think__chevron--open' : ''} />
      </button>
      {open && <div className="agent-think__body">{content}</div>}
    </div>
  );
};

/** Resolve a specialized icon for a project agent activity record. */
function renderActivityToolIcon(activity: ProjectAgentActivityRecord | null): React.ReactElement {
  if (!activity) return <IconTools width={12} height={12} />;
  if (activity.kind === 'tool_error') return <IconWarning width={12} height={12} />;
  if (activity.kind === 'context_compaction') return <IconToolCompaction width={12} height={12} />;
  if (activity.kind === 'write' || activity.kind === 'write_no_change') return <IconToolWrite width={12} height={12} />;
  switch (activity.toolName) {
    case 'readScene': return <IconToolSceneRead width={12} height={12} />;
    case 'searchScene': return <IconToolSceneSearch width={12} height={12} />;
    case 'validateScene': return <IconToolSceneValidate width={12} height={12} />;
    case 'readProjectOverview': return <IconToolProjectOverview width={12} height={12} />;
    case 'listProjectFiles': return <IconToolProjectFiles width={12} height={12} />;
    case 'readProjectText': return <IconToolProjectText width={12} height={12} />;
    case 'searchProjectText': return <IconToolProjectSearch width={12} height={12} />;
    case 'searchResources': return <IconToolResourceSearch width={12} height={12} />;
    case 'inspectResource': return <IconToolResourceInspect width={12} height={12} />;
    case 'readImage': return <IconToolVision width={12} height={12} />;
    case 'runTerminalCommand': return <IconToolTerminal width={12} height={12} />;
    default:
      if (
        activity.toolName.startsWith('insert') ||
        activity.toolName.startsWith('update') ||
        activity.toolName.startsWith('delete') ||
        activity.toolName.startsWith('move') ||
        activity.toolName.startsWith('reorder') ||
        activity.toolName.startsWith('apply')
      ) return <IconToolWrite width={12} height={12} />;
      return <IconTools width={12} height={12} />;
  }
}

/** Turn legacy JSON activity details into readable key/value lines. */
function renderLegacyJsonContent(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  const lines: string[] = [];
  const walk = (item: unknown, prefix: string): void => {
    if (item === null || typeof item !== 'object') {
      lines.push(prefix + String(item));
      return;
    }
    if (Array.isArray(item)) {
      if (item.length === 0) lines.push(prefix + '（空）');
      else item.forEach((entry, index) => walk(entry, `${prefix}#${index + 1} `));
      return;
    }
    for (const [key, entry] of Object.entries(item)) {
      if (entry !== null && typeof entry === 'object') walk(entry, `${prefix}${key}.`);
      else lines.push(`${prefix}${key}: ${String(entry)}`);
    }
  };
  walk(value, '');
  return lines.join('\n');
}

const ACTIVITY_CHANGE_KIND_LABEL: Readonly<Record<string, string>> = {
  inserted: '新增',
  updated: '更新',
  deleted: '删除',
  moved: '移动',
  reordered: '重排',
};

/** Render one tool row and its optional expandable facts panel. */
export const ActivityRow: React.FC<{
  activity: ProjectAgentActivityRecord | null;
  expanded: boolean;
  onToggle: () => void;
  delayIndex: number;
}> = ({ activity, expanded, onToggle, delayIndex }) => {
  const details = activity?.details;
  const content = details?.content;
  const isError = activity?.kind === 'tool_error';
  const isCompaction = activity?.kind === 'context_compaction';
  const rowClass = [
    'agent-log__activity',
    isCompaction ? 'agent-log__activity--context-compaction' : '',
    isError ? 'agent-log__activity--tool-error' : '',
    !activity ? 'agent-log__activity--pending' : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={rowClass} style={{ animationDelay: `${Math.min(delayIndex, 4) * 40}ms` }}>
      <span className={`agent-log__activity-icon${isCompaction ? ' agent-log__activity-icon--context-compaction' : ''}`} aria-hidden="true">
        {isCompaction ? (
          <span className="agent-window__compress-mark">
            <span className="agent-window__compress-mark-bar agent-window__compress-mark-bar--left" />
            <span className="agent-window__compress-mark-bar agent-window__compress-mark-bar--right" />
          </span>
        ) : renderActivityToolIcon(activity)}
      </span>
      {details ? (
        <button
          type="button"
          className="agent-log__activity-button"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className="agent-log__activity-text">
            {activity?.text ?? '工具'}
            {activity?.detail ? <span className="agent-log__activity-detail">{activity.detail}</span> : null}
          </span>
          <IconChevronDown width={12} height={12} className={expanded ? 'agent-log__activity-chevron--open' : ''} />
        </button>
      ) : (
        <span className="agent-log__activity-text">
          {activity?.text ?? '工具'}
          {activity?.detail ? <span className="agent-log__activity-detail">{activity.detail}</span> : null}
        </span>
      )}
      {expanded && details && (
        <div className="agent-log__activity-facts">
          {content && (
            <pre className={`agent-log__activity-content agent-log__activity-content--${content.format}`}>
              {content.format === 'json' ? renderLegacyJsonContent(content.text) : content.text}
            </pre>
          )}
          {details.lineRange && <span>行范围 L{details.lineRange.start}~L{details.lineRange.end}</span>}
          {details.query && <span>条件 {details.query}</span>}
          {details.matches !== undefined && <span>命中 {details.matches}</span>}
          {details.reference && <span>引用 {details.reference}</span>}
          {details.paths && <span>路径 {details.paths.join('、')}{details.pagination?.remaining ? `，另有 ${details.pagination.remaining} 条` : ''}</span>}
          {details.pagination && (details.pagination.hasMore || details.pagination.truncated) && <span>结果已分页或截断</span>}
          {details.diagnostics && <span>诊断 错误 {details.diagnostics.errors} · 警告 {details.diagnostics.warnings}</span>}
          {details.counts && <span>写入 新增 {details.counts.inserted} · 更新 {details.counts.updated} · 删除 {details.counts.deleted} · 移动 {details.counts.moved}</span>}
          {details.changedObjects && details.changedObjects.length > 0 && (
            <span>
              变更对象 {details.changedObjects.map((changed) => (
                `${changed.statementId}${changed.companionId ? `/${changed.companionId}` : ''}（${ACTIVITY_CHANGE_KIND_LABEL[changed.kind]}）`
              )).join('、')}
            </span>
          )}
          {details.timeRange && <span>时间范围 {details.timeRange.start.toFixed(2)}s~{details.timeRange.end.toFixed(2)}s</span>}
          {content?.truncated && <span>读取结果已截断</span>}
          {details.safe && !content && <span>安全摘要</span>}
        </div>
      )}
    </div>
  );
};

/** Show a placeholder until a running turn produces its reply. */
export const ReplyPlaceholder: React.FC = () => (
  <div className="agent-reply-pending" role="status">
    <span className="agent-reply-pending__caret" aria-hidden="true" />
    <span className="agent-reply-pending__label">正在回复…</span>
  </div>
);

/** Show live assistant text and reasoning until the final reply arrives. */
export const StreamingReply: React.FC<{ text?: string; reasoning?: string }> = ({ text, reasoning }) => {
  const showThinking = !!reasoning && reasoning.length > 0;
  const showText = !!text && text.length > 0;
  return (
    <div className="agent-log__assistant agent-reply-streaming" role="status">
      {showThinking && <ThinkDisclosure content={reasoning!} />}
      {showText ? (
        <div className="agent-reply-streaming__body">
          <MarkdownContent text={text!} />
          <span className="agent-reply-streaming__caret" aria-hidden="true" />
        </div>
      ) : (
        <span className="agent-reply-pending__label">正在回复…</span>
      )}
    </div>
  );
};

import type { ProjectAgentContextUsedPayload, ProjectAgentTaskPhase, ProjectAgentTaskStatusPayload } from '../../api/types/project-agent-ipc';
import type { ProjectAgentJournalRecord } from '../../services/project-agent/ProjectAgentJournal';

export const RUNNING_LIFE_CYCLES = new Set(['running', 'cancelling']);
export const SUSPENDED_LIFE_CYCLES = new Set(['suspended', 'paused']);
/** Suspended conversations that can never resume: browse or delete only (ADR0023). */
export const NO_CONTINUE_PAUSE_REASONS = new Set(['target_scene_unavailable', 'task_state_incompatible']);
/** Routine lifecycle pause reasons that hydrate as suspended but are simply idle conversations. */
const LIFECYCLE_INTERRUPTION_REASONS = new Set([
  'application_exit',
  'window_closed',
  'renderer_reloaded',
  'lease_lost',
]);

export function isLifecycleInterruption(reason?: string | null): boolean {
  return !!reason && LIFECYCLE_INTERRUPTION_REASONS.has(reason);
}

/** ADR0023: force compaction before the next model request once usage reaches 80%. */
export const CONTEXT_COMPACTION_UI_THRESHOLD = 0.8;
/** Group key of the trailing (not yet flow-anchored) tool rows. */
export const TAIL_TOOL_GROUP_KEY = 'tail';

/** Settled turn-state labels for the harness-style status line. */
export const TURN_STATE_TEXT: Readonly<Record<string, string>> = {
  completed: '已完成',
  cancelled: '已取消',
  suspended: '已暂停',
  failed: '失败',
};

export function formatPhase(phase: ProjectAgentTaskPhase): string {
  switch (phase) {
    case 'starting':
      return '正在启动';
    case 'model_request':
      return '模型处理中';
    case 'tools_executed':
      return '工具执行完成';
    case 'assistant_reply':
      return '已回复';
    case 'settled':
      return '已就绪';
    case 'suspended':
    case 'paused':
      return '已暂停';
    case 'waiting':
      return '等待中';
    case 'scheduling_stopped':
      return '调度停止';
    case 'terminal_signal_required':
      return '等待终止信号';
    case 'terminal':
      return '回合结束';
    case 'blocked':
      return '已阻塞';
    case 'cancelled':
    case 'user_cancelled':
      return '已取消';
    default:
      return '等待中';
  }
}

const PAUSE_REASON_TEXT: Readonly<Record<string, string>> = {
  user_requested: '你已暂停本次执行。',
  provider_unavailable: '服务暂时不可用（网络或限流），可以在稍后继续。',
  provider_configuration_required: '需要检查模型或接口配置，调整后可以继续。',
  context_compaction_required: '当前上下文需要压缩后才能继续，重试即可。',
  target_scene_inactive: '目标场景未激活，请先回到该场景。',
  target_scene_unavailable: '目标场景已不可用，此对话仅可浏览或删除。',
  task_state_incompatible: '任务状态与当前版本不兼容，仅可浏览或删除。',
  repeated_invalid_tool_calls: '工具调用连续无效，可以补充说明后重试。',
  provider_protocol_incompatible: '模型协议不兼容，可以更换模型后重试。',
  version_conflict_exhausted: '版本冲突已达上限，可以重新描述后继续。',
  missing_authorization: '缺少必要授权，无法继续执行。',
  resource_unavailable: '必要资源不可用，无法继续执行。',
  unrecoverable_error: '遇到不可恢复错误。',
  agent_reported: 'Agent 报告当前无法继续。',
  window_closed: '窗口关闭时中断了执行，可以随时继续。',
  application_exit: '上次退出时中断了执行，可以随时继续。',
  renderer_reloaded: '编辑器重载时中断了执行，可以随时继续。',
  lease_lost: '执行槽被释放，可以随时继续。',
};

export function formatPauseReason(reason: string | undefined): string {
  if (!reason) return '执行回合已暂停。';
  return PAUSE_REASON_TEXT[reason] ?? `执行回合已暂停（${reason}）。`;
}

/** Compact elapsed duration label, e.g. 「12.3s」 or 「1分05秒」. */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}分${String(rest).padStart(2, '0')}秒`;
}

/** Compact token label: 118K / 262K. */
function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '—';
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(Math.round(tokens));
}

/** Short badge label, e.g. 「Context used 45% · 118K/262K」. */
export function formatContextUsedLabel(info: ProjectAgentContextUsedPayload): string {
  const percent = Math.round(info.usageRatio * 100);
  const tokens = typeof info.actualInputTokens === 'number' && Number.isFinite(info.actualInputTokens)
    ? info.actualInputTokens
    : info.estimatedTokens;
  return `Context used ${percent}% · ${formatTokenCount(tokens)}/${formatTokenCount(info.contextWindow)}`;
}

/** Full tooltip detail with the estimate/actual breakdown. */
export function formatContextUsedDetail(info: ProjectAgentContextUsedPayload): string {
  const percent = Math.round(info.usageRatio * 100);
  const parts = [
    `Context used ${percent}%（估算 ${formatTokenCount(info.estimatedTokens)} / ${formatTokenCount(info.contextWindow)} tokens，含保留输出 ${formatTokenCount(Math.max(0, info.estimatedTokens - info.estimatedInputTokens))}）`,
  ];
  if (typeof info.actualInputTokens === 'number' && Number.isFinite(info.actualInputTokens)) {
    parts.push(`本次实际输入 ${formatTokenCount(info.actualInputTokens)} tokens`);
  }
  if (info.usageRatio >= CONTEXT_COMPACTION_UI_THRESHOLD) {
    parts.push('已达到上下文压缩阈值，下次请求前会先压缩上下文');
  }
  return parts.join('；');
}

/** Human-friendly relative time label for the sidebar conversation list. */
export function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}小时前`;
  if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)}天前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function conversationUpdatedAt(
  record: ProjectAgentJournalRecord,
  status: ProjectAgentTaskStatusPayload | null,
): number {
  return status?.updatedAt ?? record.updatedAt ?? record.identity?.createdAt ?? 0;
}

export function conversationDotClass(
  status: ProjectAgentTaskStatusPayload | null,
): string {
  const lifecycle = status?.lifecycle;
  if (lifecycle && RUNNING_LIFE_CYCLES.has(lifecycle)) return 'agent-sidebar__conv-dot--running';
  if (lifecycle && SUSPENDED_LIFE_CYCLES.has(lifecycle)) {
    const reason = status?.suspensionReason ?? status?.pauseReason;
    if (isLifecycleInterruption(reason)) return 'agent-sidebar__conv-dot--idle';
    return 'agent-sidebar__conv-dot--paused';
  }
  return 'agent-sidebar__conv-dot--idle';
}

export interface PendingSupplement {
  id: string;
  text: string;
  /** Conversation the prompt was sent to; bubbles only render in its thread. */
  conversationId: string;
  /** True when enqueued while the conversation is running, waiting for next turn. */
  queued?: boolean;
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  conversationDisplayTitle,
  projectConversationLogFromMessages,
  projectConversationTurnFlow,
  type ProjectAgentConversationFlowEntry,
  type ProjectAgentConversationLogEntry,
  type ProjectAgentContextUsedPayload,
  type ProjectAgentProjectContext,
  type ProjectAgentStartRequest,
  type ProjectAgentTaskPhase,
  type ProjectAgentTaskStatusPayload,
} from './api/types/project-agent-ipc';
import { AI_PROSE_EFFORTS, DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL } from './api/types/ai-prose-authoring';
import {
  decodeProjectAgentConversationMessages,
  type ProjectAgentJournalRecord,
} from './services/project-agent/ProjectAgentJournal';
import type { ProjectAgentActivityRecord } from './services/project-agent/ProjectAgentTask';
import { projectAgentToolDisplayName, PROJECT_AGENT_HOST_RECOVERY_NOTE_PREFIX } from './services/project-agent/ProjectAgentTask';
import {
  IconArrowDown,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconFile,
  IconFolder,
  IconImage,
  IconPencil,
  IconPlus,
  IconSearch,
  IconSend,
  IconSettings,
  IconSquare,
  IconTools,
  IconTrash,
  IconWarning,
  IconX,
} from './ui/icons';
import {
  ActivityRow,
  AssistantReply,
  ReplyPlaceholder,
  StreamingReply,
  ThinkDisclosure,
} from './ui/agent/AgentConversationParts';

const RUNNING_LIFE_CYCLES = new Set(['running', 'cancelling']);
const SUSPENDED_LIFE_CYCLES = new Set(['suspended', 'paused']);
/** Suspended conversations that can never resume: browse or delete only (ADR0023). */
const NO_CONTINUE_PAUSE_REASONS = new Set(['target_scene_unavailable', 'task_state_incompatible']);
/** Routine lifecycle pause reasons that hydrate as suspended but are simply idle conversations. */
const LIFECYCLE_INTERRUPTION_REASONS = new Set([
  'application_exit',
  'window_closed',
  'renderer_reloaded',
  'lease_lost',
]);

function isLifecycleInterruption(reason?: string | null): boolean {
  return !!reason && LIFECYCLE_INTERRUPTION_REASONS.has(reason);
}

const MAX_IMAGE_DIMENSION = 1568;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const START_RESULT_TIMEOUT_MS = 30_000;
const SWITCH_STATUS_TIMEOUT_MS = 8_000;
/** ADR0023: force compaction before the next model request once usage reaches 80%. */
const CONTEXT_COMPACTION_UI_THRESHOLD = 0.8;
/** Group key of the trailing (not yet flow-anchored) tool rows. */
const TAIL_TOOL_GROUP_KEY = 'tail';

/** Settled turn-state labels for the harness-style status line. */
const TURN_STATE_TEXT: Readonly<Record<string, string>> = {
  completed: '已完成',
  cancelled: '已取消',
  suspended: '已暂停',
  failed: '失败',
};

const EXCLUDED_FILE_DIRS = new Set([
  '.git',
  '.generated',
  '.impeccable',
  '.scratch',
  '.superpowers',
  'node_modules',
  'dist',
  'dist-electron',
  'coverage',
  'test-results',
  'release',
]);

interface AiProseSettingsShape {
  baseUrl?: string;
  defaultModel?: string;
  projectAgentModel?: string;
  effort?: string;
}

interface StoredSettingsShape {
  theme?: string;
  aiProse?: AiProseSettingsShape;
}

function readStoredSettings(): StoredSettingsShape {
  try {
    const raw = localStorage.getItem('aeonstagery_settings');
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredSettingsShape;
    return {
      theme: typeof parsed.theme === 'string' ? parsed.theme : undefined,
      aiProse: parsed.aiProse && typeof parsed.aiProse === 'object' ? parsed.aiProse : undefined,
    };
  } catch {
    return {};
  }
}

function effectiveModelFrom(settings: StoredSettingsShape): string {
  const aiProse = settings.aiProse;
  const projectAgentModel = aiProse?.projectAgentModel?.trim();
  return projectAgentModel && projectAgentModel.length > 0
    ? projectAgentModel
    : (aiProse?.defaultModel?.trim() || DEFAULT_AI_MODEL);
}

function effectiveEffortFrom(settings: StoredSettingsShape): string {
  const effort = settings.aiProse?.effort;
  return effort && AI_PROSE_EFFORTS.includes(effort as (typeof AI_PROSE_EFFORTS)[number])
    ? effort
    : 'medium';
}

function formatPhase(phase: ProjectAgentTaskPhase): string {
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

function formatPauseReason(reason: string | undefined): string {
  if (!reason) return '执行回合已暂停。';
  return PAUSE_REASON_TEXT[reason] ?? `执行回合已暂停（${reason}）。`;
}

/** Compact elapsed duration label, e.g. 「12.3s」 or 「1分05秒」. */
function formatDuration(milliseconds: number): string {
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
function formatContextUsedLabel(info: ProjectAgentContextUsedPayload): string {
  const percent = Math.round(info.usageRatio * 100);
  const tokens = typeof info.actualInputTokens === 'number' && Number.isFinite(info.actualInputTokens)
    ? info.actualInputTokens
    : info.estimatedTokens;
  return `Context used ${percent}% · ${formatTokenCount(tokens)}/${formatTokenCount(info.contextWindow)}`;
}

/** Full tooltip detail with the estimate/actual breakdown. */
function formatContextUsedDetail(info: ProjectAgentContextUsedPayload): string {
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

function readTheme(): 'light' | 'dark' | 'system' {
  const theme = readStoredSettings().theme;
  return theme === 'light' || theme === 'dark' ? theme : 'system';
}

function applyTheme(theme: 'light' | 'dark' | 'system') {
  if (typeof document === 'undefined') return;
  const isDark = theme === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false)
    : theme === 'dark';
  if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}

/** Human-friendly relative time label for the sidebar conversation list. */
function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}小时前`;
  if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)}天前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function conversationUpdatedAt(
  record: ProjectAgentJournalRecord,
  status: ProjectAgentTaskStatusPayload | null,
): number {
  return status?.updatedAt ?? record.updatedAt ?? record.identity?.createdAt ?? 0;
}

function conversationDotClass(
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

async function listProjectFiles(root: string): Promise<string[]> {
  const seen = new Set<string>();
  const walk = async (dir: string, depth: number, prefix: string): Promise<void> => {
    if (depth > 4 || seen.size >= 500) return;
    const result = await window.aeonStageryAPI?.fs.readDir(dir);
    if (!result?.success || !result.data) return;
    for (const entry of result.data) {
      if (seen.size >= 500) return;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (EXCLUDED_FILE_DIRS.has(entry.name)) continue;
        await walk(entry.path, depth + 1, relative);
      } else {
        seen.add(relative);
      }
    }
  };
  await walk(root, 1, '');
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

interface ImageAttachment {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  previewUrl: string;
}

interface PendingSupplement {
  id: string;
  text: string;
  /** Conversation the prompt was sent to; bubbles only render in its thread. */
  conversationId: string;
  /** True when enqueued while the conversation is running, waiting for next turn. */
  queued?: boolean;
}

/**
 * Host-injected recovery notes (pauseRecovery / turn_aborted projections,
 * ADR0023) are appended as user-role conversation messages for the MODEL to
 * reread/replan — they are not user input and must never surface as user
 * bubbles in the thread.
 */
function isHostInjectedUserText(text: string): boolean {
  return text.startsWith(PROJECT_AGENT_HOST_RECOVERY_NOTE_PREFIX);
}

/**
 * Downscale + re-encode a picked image so the bytes stay within the transport
 * limits shared with the readImage tool (ADR0023): max dimension and byte cap.
 */
async function processPickedImage(file: File): Promise<ImageAttachment> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法处理图片');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', 0.85);
  });
  if (!blob) throw new Error('无法处理图片');
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('图片过大，请选择更小的图片');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    name: file.name,
    mimeType: blob.type || 'image/jpeg',
    bytes,
    previewUrl: URL.createObjectURL(blob),
  };
}

/**
 * Dedicated project Agent window (ADR0023): a persistent-conversation UI over
 * the project Agent. The sidebar lists the project's Conversations (auto
 * title / user rename / last activity); the thread renders the conversation
 * log — user messages as bubbles, assistant replies and tool activities
 * directly on the page — plus the current execution-round state. The window
 * never switches scenes and never creates a task on its own; task starts
 * relay through the editor renderer, the sole mutation owner.
 */
export const AgentWindow: React.FC = () => {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, ProjectAgentTaskStatusPayload>>(
    () => new Map(),
  );
  const [records, setRecords] = useState<readonly ProjectAgentJournalRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const [pendingQueue, setPendingQueue] = useState<readonly PendingSupplement[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [draft, setDraft] = useState('');
  const [fullAccess, setFullAccess] = useState(false);
  const [context, setContext] = useState<ProjectAgentProjectContext | null>(null);
  const [imageAttachment, setImageAttachment] = useState<ImageAttachment | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [expandedActivities, setExpandedActivities] = useState<ReadonlySet<number>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelListState, setModelListState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [modelList, setModelList] = useState<string[]>([]);
  const [effectiveModel, setEffectiveModel] = useState(() => (
    effectiveModelFrom(readStoredSettings())
  ));
  const [effort, setEffort] = useState(() => effectiveEffortFrom(readStoredSettings()));
  const [pendingStartId, setPendingStartId] = useState<string | null>(null);
  /** Per-group collapse state: each 工具 group (thread section or tail)
   *  expands/collapses independently (ADR0023). */
  const [collapsedToolGroups, setCollapsedToolGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [showBackToBottom, setShowBackToBottom] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Turn timing (harness-style status line): round start and settled end of
   *  the latest round — captured from live statuses while watching, or derived
   *  from the journal record's lastSettledRound when reopening/switching back.
   *  State (not refs) so the settled 「已完成 · Ns」 line renders itself. */
  const [roundStart, setRoundStart] = useState<number | null>(null);
  const [roundEnd, setRoundEnd] = useState<{ at: number; label: 'completed' | 'cancelled' | 'suspended' } | null>(null);
  /** Follow-scroll: keep pinned to the thread bottom while the user has not
   *  scrolled up; a back-to-bottom chip resumes following on click. */
  const followRef = useRef(true);
  const mentionFilesRef = useRef<string[]>([]);
  const mentionRangeRef = useRef<{ start: number; end: number } | null>(null);
  const pendingStartResolversRef = useRef(new Map<string, (payload: { ok: boolean; error?: string }) => void>());
  const modelFetchingRef = useRef(false);
  const initialSelectionDoneRef = useRef(false);
  const autoSelectNextNewRef = useRef<ReadonlySet<string> | null>(null);
  const statusesRef = useRef<ReadonlyMap<string, ProjectAgentTaskStatusPayload>>(new Map());
  const knownTaskIdsRef = useRef<ReadonlySet<string>>(new Set());
  const prevSelectedRef = useRef<{ id: string | null; index: number | null }>({ id: null, index: null });
  const lastSelectedConversationIdRef = useRef<string | null>(null);
  const switchTimerRef = useRef<number | null>(null);
  const [switchDir, setSwitchDir] = useState<'forward' | 'back' | null>(null);

  const projectName = context?.projectName?.trim() || '当前项目';
  const bridge = window.aeonStageryAPI?.projectAgent;

  useEffect(() => {
    statusesRef.current = statuses;
  }, [statuses]);

  useEffect(() => {
    applyTheme(readTheme());
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'aeonstagery_settings' || event.key === null) {
        applyTheme(readTheme());
        setEffectiveModel(effectiveModelFrom(readStoredSettings()));
        setEffort(effectiveEffortFrom(readStoredSettings()));
      }
    };
    const onSystemTheme = () => applyTheme(readTheme());
    window.addEventListener('storage', onStorage);
    window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', onSystemTheme);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.matchMedia?.('(prefers-color-scheme: dark)')?.removeEventListener?.('change', onSystemTheme);
    };
  }, []);

  const mergeStatus = (next: ProjectAgentTaskStatusPayload) => {
    setStatuses((previous) => {
      if (previous.get(next.taskId)?.updatedAt === next.updatedAt) return previous;
      const merged = new Map(previous);
      merged.set(next.taskId, next);
      return merged;
    });
  };

  useEffect(() => {
    if (!bridge) {
      setWaiting(false);
      return undefined;
    }
    void bridge.getTaskStatus().then((existing) => {
      if (existing) mergeStatus(existing);
      setWaiting(false);
    });
    const unsubscribe = bridge.onStatus((next) => {
      mergeStatus(next);
      setWaiting(false);
    });
    return unsubscribe;
  }, [bridge]);

  useEffect(() => {
    const conversationBridge = window.aeonStageryAPI?.conversation;
    if (!conversationBridge?.onDebugLog) return undefined;
    return conversationBridge.onDebugLog((entry) => {
      console.info(`[LLM debug] ${entry.tag}`, entry.payload);
    });
  }, []);

  useEffect(() => {
    if (!bridge) return undefined;
    void bridge.getProjectContext().then((existing) => {
      if (existing) setContext(existing);
    });
    const unsubscribe = bridge.onContext((next) => setContext(next));
    return unsubscribe;
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return undefined;
    const unsubscribe = bridge.onStartResult((payload) => {
      const resolve = pendingStartResolversRef.current.get(payload.requestId);
      if (!resolve) return;
      pendingStartResolversRef.current.delete(payload.requestId);
      resolve({ ok: payload.ok, error: payload.error });
    });
    return unsubscribe;
  }, [bridge]);

  useEffect(() => {
    if (!bridge || !context?.projectId) {
      setRecords([]);
      return undefined;
    }
    let disposed = false;
    void bridge.journalListByProject(context.projectId).then((list) => {
      if (disposed) return;
      const sorted = [...list].sort(
        (a, b) => conversationUpdatedAt(b, null) - conversationUpdatedAt(a, null),
      );
      knownTaskIdsRef.current = new Set(sorted.map((record) => record.identity.taskId));
      setRecords(sorted);
      setPendingQueue((queue) => {
        const known = new Set<string>();
        for (const record of sorted) {
          known.add(record.originalTaskText);
          for (const supplement of record.supplements) known.add(supplement.text);
        }
        const filtered = queue.filter((pending) => !known.has(pending.text));
        return filtered.length === queue.length ? queue : filtered;
      });
      for (const record of sorted) {
        const id = record.identity.taskId;
        if (statusesRef.current.has(id)) continue;
        void bridge.getTaskStatus(id).then((existing) => {
          if (existing) mergeStatus(existing);
        });
      }
    });
    return () => {
      disposed = true;
    };
  }, [bridge, context?.projectId, listRefreshKey]);

  /**
   * Reconcile the optimistic pending bubbles: once the sent text is visible
   * in its conversation's live flow/log (delivered) or in the journal record
   * (supplement persisted), the pending queued bubble must disappear —
   * otherwise the same prompt renders twice (a normal user bubble plus a
   * stale queued one) after an interrupted round is continued.
   */
  useEffect(() => {
    if (pendingQueue.length === 0) return;
    setPendingQueue((queue) => {
      const filtered = queue.filter((pending) => {
        const status = statuses.get(pending.conversationId);
        if (status) {
          for (const entry of status.flow ?? []) {
            if (entry.kind === 'user' && entry.text === pending.text) return false;
          }
          for (const entry of status.log ?? []) {
            if (entry.role === 'user' && entry.text === pending.text) return false;
          }
        }
        const record = records.find((r) => r.identity.taskId === pending.conversationId);
        if (record) {
          if (record.supplements.some((s) => s.text === pending.text)) return false;
          const decoded = decodeProjectAgentConversationMessages(record.conversationBlob);
          if (decoded && projectConversationTurnFlow(decoded).some(
            (entry) => entry.kind === 'user' && entry.text === pending.text,
          )) {
            return false;
          }
        }
        return true;
      });
      return filtered.length === queue.length ? queue : filtered;
    });
  }, [statuses, records, pendingQueue.length]);

  // A status for a conversation the list has never seen (e.g. one started
  // from the editor while the window is open) triggers a list refresh so the
  // new conversation becomes selectable and auto-selectable.
  useEffect(() => {
    for (const taskId of statuses.keys()) {
      if (!knownTaskIdsRef.current.has(taskId)) {
        setListRefreshKey((key) => key + 1);
        break;
      }
    }
  }, [statuses]);

  // Initial selection: the first conversation with an active round wins,
  // otherwise the most recently active conversation (resume your work). The
  // ref is only claimed once the first list load landed — an empty list just
  // means the welcome surface stays until the user starts a conversation.
  useEffect(() => {
    if (initialSelectionDoneRef.current || waiting || !context?.projectId) return;
    if (records.length === 0) return;
    initialSelectionDoneRef.current = true;
    const active = records.find((record) => {
      const lifecycle = statuses.get(record.identity.taskId)?.lifecycle;
      return !!lifecycle && RUNNING_LIFE_CYCLES.has(lifecycle);
    });
    setSelectedId(active?.identity.taskId ?? records[0]?.identity.taskId ?? null);
  }, [records, statuses, waiting, context?.projectId]);

  // A freshly started conversation auto-selects when its first status
  // arrives: only a conversation id unknown before the start is a candidate,
  // so an already-known conversation can never steal the selection.
  useEffect(() => {
    const knownBefore = autoSelectNextNewRef.current;
    if (!knownBefore) return;
    for (const record of records) {
      const id = record.identity.taskId;
      if (knownBefore.has(id)) continue;
      if (statuses.has(id)) {
        autoSelectNextNewRef.current = null;
            setSelectedId(id);
        break;
      }
    }
  }, [records, statuses]);

  // Direction-aware thread continuity: when the selection moves along the
  // list (newest first), the arriving log slips in from that direction.
  useEffect(() => {
    if (!selectedId) return;
    const index = records.findIndex((record) => record.identity.taskId === selectedId);
    const prev = prevSelectedRef.current;
    if (prev.id && prev.id !== selectedId && prev.index !== null && index !== -1) {
      setSwitchDir(index < prev.index ? 'forward' : 'back');
      if (switchTimerRef.current !== null) window.clearTimeout(switchTimerRef.current);
      switchTimerRef.current = window.setTimeout(() => setSwitchDir(null), 200);
    }
    prevSelectedRef.current = { id: selectedId, index };
  }, [selectedId, records]);

  useEffect(() => () => {
    if (switchTimerRef.current !== null) window.clearTimeout(switchTimerRef.current);
  }, []);

  // Follow-scroll (harness-style): pin to the thread bottom while the user
  // has not scrolled up; a back-to-bottom chip resumes following on click.
  // Conversation switches and sends always reset to following.
  useEffect(() => {
    followRef.current = true;
    setShowBackToBottom(false);
    threadRef.current?.scrollTo?.({ top: threadRef.current.scrollHeight, behavior: 'instant' });
  }, [selectedId]);

  useEffect(() => {
    if (!followRef.current) return;
    threadRef.current?.scrollTo?.({ top: threadRef.current.scrollHeight, behavior: 'instant' });
  }, [statuses, pendingQueue, waiting]);

  const handleThreadWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) {
      followRef.current = false;
      setShowBackToBottom(true);
    }
  };

  const handleThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceToBottom > 24) {
      followRef.current = false;
      setShowBackToBottom(true);
    } else if (distanceToBottom <= 16) {
      followRef.current = true;
      setShowBackToBottom(false);
    }
  };

  const scrollToBottom = () => {
    followRef.current = true;
    setShowBackToBottom(false);
    threadRef.current?.scrollTo?.({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  };

  useEffect(() => () => {
    if (imageAttachment) URL.revokeObjectURL(imageAttachment.previewUrl);
  }, [imageAttachment]);

  const selectedStatus = selectedId ? (statuses.get(selectedId) ?? null) : null;
  const selectedRecord = selectedId
    ? (records.find((record) => record.identity.taskId === selectedId) ?? null)
    : null;
  const selectedLifecycle = selectedStatus?.lifecycle ?? selectedRecord?.lifecycle ?? null;
  const selectedRunning = !!selectedLifecycle && RUNNING_LIFE_CYCLES.has(selectedLifecycle);
  const selectedPauseReason = selectedStatus?.suspensionReason
    ?? selectedStatus?.pauseReason
    ?? selectedRecord?.pauseReason;
  const isInterrupted = isLifecycleInterruption(selectedPauseReason);
  const selectedSuspended = !!selectedLifecycle
    && SUSPENDED_LIFE_CYCLES.has(selectedLifecycle)
    && !isInterrupted;
  const anyRunning = [...statuses.values()].some(
    (status) => RUNNING_LIFE_CYCLES.has(status.lifecycle),
  );
  const selectedNoContinue = selectedSuspended
    && !!selectedPauseReason
    && NO_CONTINUE_PAUSE_REASONS.has(selectedPauseReason);
  const selectedContextUsed = selectedStatus?.contextUsed ?? null;
  const contextNearCompaction = !!selectedContextUsed
    && selectedContextUsed.usageRatio >= CONTEXT_COMPACTION_UI_THRESHOLD;
  const contextCompactionPaused = selectedPauseReason === 'context_compaction_required';
  const showContextCompactionCue = contextNearCompaction || contextCompactionPaused;
  const contextCompactionCueText = contextCompactionPaused ? '等待压缩' : '即将压缩';
  const contextCompactionCueTitle = contextCompactionPaused
    ? '本轮执行已因上下文压缩暂停；继续执行时会先重试压缩。'
    : '上下文接近模型上限；下次请求前会先压缩上下文。';
  const selectedModelProgress = selectedStatus?.modelProgress;
  const hasSelectedModelProgress = !!selectedModelProgress;
  const selectedModelProgressStartedAt = selectedModelProgress?.startedAt;
  const selectedModelProgressPhase = selectedModelProgress?.phase;

  useEffect(() => {
    if (!hasSelectedModelProgress) return undefined;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasSelectedModelProgress, selectedModelProgressPhase, selectedModelProgressStartedAt]);

  const selectedLog = useMemo(() => {
    const visible = (entry: ProjectAgentConversationLogEntry) =>
      !(entry.role === 'user' && isHostInjectedUserText(entry.text));
    if (selectedStatus?.log) return selectedStatus.log.filter(visible);
    if (!selectedRecord) return [];
    const decoded = decodeProjectAgentConversationMessages(selectedRecord.conversationBlob);
    return decoded ? projectConversationLogFromMessages(decoded).filter(visible) : [];
  }, [selectedStatus, selectedRecord]);

  /**
   * Chronological thread (ADR0023): the status flow projection when live,
   * otherwise the journal blob decoded locally. Tool anchors bind to their
   * activity by toolCallId, so every tool row renders at the moment it
   * happened instead of sinking below the conversation — and activities with
   * no tool message (context compaction, terminal scene-gate failures) can
   * never shift later rows.
   */
  const selectedFlow = useMemo(() => {
    const visible = (entry: ProjectAgentConversationFlowEntry) =>
      !(entry.kind === 'user' && isHostInjectedUserText(entry.text));
    if (selectedStatus?.flow) return selectedStatus.flow.filter(visible);
    if (!selectedRecord) return null;
    const decoded = decodeProjectAgentConversationMessages(selectedRecord.conversationBlob);
    return decoded ? projectConversationTurnFlow(decoded).filter(visible) : null;
  }, [selectedStatus, selectedRecord]);

  const selectedActivities = useMemo(() => {
    if (selectedStatus?.activities) return selectedStatus.activities;
    return selectedRecord?.activities ?? [];
  }, [selectedStatus, selectedRecord]);

  interface FlowWalkItem {
    key: string;
    entry: ProjectAgentConversationFlowEntry;
    /** Matched activity for `tool` anchors (by toolCallId; id-less legacy
     *  records fall back to the append-order greedy match). */
    activity: ProjectAgentActivityRecord | null;
    activityIndex: number;
  }

  const flowWalk = useMemo(() => {
    if (!selectedFlow) return null;
    const activities = selectedActivities;
    // Anchor binding (ADR0023): activities carrying a toolCallId bind to
    // their tool anchor by id — unanchored activities (context compaction,
    // terminal scene-gate failures, post-compaction history whose tool
    // messages were replaced) render as independent rows in the tail. A
    // strictly-aligned legacy record where NO activity carries an id keeps
    // the append-order greedy match, so old flows render exactly as before.
    const byId = new Map<string, number[]>();
    const idLess: number[] = [];
    activities.forEach((activity, index) => {
      if (activity.toolCallId) {
        const list = byId.get(activity.toolCallId);
        if (list) list.push(index); else byId.set(activity.toolCallId, [index]);
      } else {
        idLess.push(index);
      }
    });
    const legacy = byId.size === 0;
    const consumed = new Set<number>();
    const nextById = new Map<string, number>();
    const consumeById = (toolCallId: string): number => {
      const list = byId.get(toolCallId);
      if (!list) return -1;
      const cursor = nextById.get(toolCallId) ?? 0;
      if (cursor >= list.length) return -1;
      const index = list[cursor]!;
      nextById.set(toolCallId, cursor + 1);
      consumed.add(index);
      return index;
    };
    let nextIdLess = 0;
    const items: FlowWalkItem[] = [];
    selectedFlow.forEach((entry, index) => {
      if (entry.kind === 'tool') {
        let activityIndex = -1;
        if (!legacy && entry.toolCallId) {
          activityIndex = consumeById(entry.toolCallId);
        } else if (legacy) {
          while (nextIdLess < idLess.length && consumed.has(idLess[nextIdLess]!)) {
            nextIdLess += 1;
          }
          if (nextIdLess < idLess.length) {
            activityIndex = idLess[nextIdLess]!;
            consumed.add(activityIndex);
            nextIdLess += 1;
          }
        }
        items.push({
          key: `flow-${index}`,
          entry,
          activity: activityIndex >= 0 ? activities[activityIndex]! : null,
          activityIndex,
        });
      } else {
        items.push({ key: `flow-${index}`, entry, activity: null, activityIndex: -1 });
      }
    });
    // Unanchored activities render as their own rows in the tail block,
    // keeping their real activity index for expansion state.
    const trailingActivities = activities
      .map((activity, index) => ({ activity, index }))
      .filter(({ index }) => !consumed.has(index));
    return {
      items,
      trailingActivities,
    };
  }, [selectedFlow, selectedActivities]);

  /**
   * Latest-round timing (harness-style status line): capture the round start
   * on the first running status and the settled end once, so the status line
   * keeps 「已完成 · Ns」 after the round settles and until the next round.
   */
  useEffect(() => {
    if (!selectedStatus) return;
    if (RUNNING_LIFE_CYCLES.has(selectedStatus.lifecycle)) {
      if (roundStart === null) {
        setRoundStart(selectedStatus.modelProgress?.startedAt ?? selectedStatus.updatedAt);
        setRoundEnd(null);
      }
    } else if (roundStart !== null && roundEnd === null) {
      const label = (selectedStatus.lifecycle === 'cancelled' || selectedStatus.lifecycle === 'user_cancelled')
        ? 'cancelled' as const
        : (selectedStatus.lifecycle === 'suspended' || selectedStatus.lifecycle === 'paused'
          || selectedStatus.lifecycle === 'blocked')
          ? 'suspended' as const
          : 'completed' as const;
      setRoundEnd({ at: selectedStatus.updatedAt, label });
    }
  }, [roundEnd, roundStart, selectedStatus]);

  useEffect(() => {
    const isNewConversation = lastSelectedConversationIdRef.current !== selectedId;
    lastSelectedConversationIdRef.current = selectedId;

    if (isNewConversation) {
      setExpandedActivities(new Set());
      setCollapsedToolGroups(new Set());
      followRef.current = true;
      setShowBackToBottom(false);
    }
    // Re-capture the round start when the newly selected conversation is
    // mid-round; otherwise derive the last settled round from the journal
    // record, so an ended round keeps its status line after switching away
    // or reopening. A live (non-running) status leaves the captured timing
    // alone — the status-timing effect above owns it.
    const status = selectedId ? (statusesRef.current.get(selectedId) ?? null) : null;
    if (status && RUNNING_LIFE_CYCLES.has(status.lifecycle)) {
      setRoundStart(status.modelProgress?.startedAt ?? status.updatedAt);
      setRoundEnd(null);
    } else {
      const settled = selectedRecord?.lastSettledRound;
      if (settled) {
        setRoundStart(settled.startedAt);
        setRoundEnd({
          at: settled.endedAt,
          label: settled.kind === 'settled'
            ? 'completed'
            : settled.kind === 'cancelled'
              ? 'cancelled'
              : 'suspended',
        });
      } else if (!status) {
        setRoundStart(null);
        setRoundEnd(null);
      }
    }
  }, [selectedId, selectedRecord]);

  /** Turn-state of the latest round: running / completed / cancelled /
   *  suspended / failed (blocked or provider suspension). */
  const settledTurnState = selectedStatus
    ? (selectedRunning
        ? 'running'
        : selectedLifecycle === 'cancelled' || selectedLifecycle === 'user_cancelled'
          ? 'cancelled'
          : selectedLifecycle === 'blocked'
            ? 'failed'
            : selectedSuspended
              ? (selectedStatus.providerDetail ? 'failed' : 'suspended')
              : roundEnd?.label ?? null)
    // No live status (reopened/restored conversation): the journal-derived
    // round timing still carries the latest round's state.
    : (roundEnd?.label ?? null);
  /**
   * A routine lifecycle interruption (app exit, window close, renderer reload,
   * lease release) does leave an aborted round behind, but the conversation
   * reads as an idle one: no paused card, no paused dot and — because the
   * journal keeps that round's timing as `lastSettledRound: suspended` — no
   * 「已暂停」 status line either. Execution resumes by typing the next
   * instruction; the send path already requests continue for a selection that
   * is not running.
   */
  const turnState = isInterrupted && settledTurnState === 'suspended'
    ? null
    : settledTurnState;
  const turnStartedAt = selectedStatus?.modelProgress?.startedAt ?? roundStart;
  const turnEndedAt = roundEnd?.at ?? selectedStatus?.updatedAt ?? null;
  const turnDurationMs = (turnState && turnStartedAt !== null && turnEndedAt !== null)
    ? Math.max(0, turnEndedAt - turnStartedAt)
    : null;

  /** Flow sections: consecutive tool anchors merge into one collapsible run. */
  type ThreadSection =
    | { readonly kind: 'user'; readonly key: string; readonly index: number; readonly text: string }
    | {
        readonly kind: 'assistant';
        readonly key: string;
        readonly index: number;
        readonly reasoningContent?: string;
        readonly text?: string;
      }
    | { readonly kind: 'tools'; readonly key: string; readonly index: number; readonly rows: readonly FlowWalkItem[] };

  const threadSections = useMemo<readonly ThreadSection[] | null>(() => {
    if (!flowWalk) return null;
    const sections: ThreadSection[] = [];
    for (const item of flowWalk.items) {
      const index = Number(item.key.split('-')[1] ?? '-1');
      if (item.entry.kind === 'tool') {
        const last = sections[sections.length - 1];
        if (last && last.kind === 'tools') {
          sections[sections.length - 1] = {
            kind: 'tools',
            key: last.key,
            index: last.index,
            rows: [...last.rows, item],
          };
        } else {
          sections.push({ kind: 'tools', key: item.key, index, rows: [item] });
        }
      } else if (item.entry.kind === 'user') {
        sections.push({ kind: 'user', key: item.key, index, text: item.entry.text });
      } else {
        sections.push({
          kind: 'assistant',
          key: item.key,
          index,
          ...(item.entry.text ? { text: item.entry.text } : {}),
          ...(item.entry.reasoningContent ? { reasoningContent: item.entry.reasoningContent } : {}),
        });
      }
    }
    return sections;
  }, [flowWalk]);

  const toggleActivity = (index: number) => {
    setExpandedActivities((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };

  /** Toggle only the clicked tool group; other groups keep their state. */
  const toggleToolGroup = (key: string) => {
    setCollapsedToolGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  /**
   * Live streaming state of the selected round: the service publishes the
   * accumulated delta text while its model exchange is streaming, and clears
   * it on every phase transition away from `model_request`, so the live card
   * can never coexist with the flow's final assistant reply.
   */
  const streamingText = selectedRunning && selectedStatus?.phase === 'model_request'
    ? selectedStatus.modelProgress?.deltaText ?? ''
    : '';
  const streamingReasoning = selectedRunning && selectedStatus?.phase === 'model_request'
    ? selectedStatus.modelProgress?.reasoningDeltaText ?? ''
    : '';
  const streamingActive = streamingText.length > 0 || streamingReasoning.length > 0;

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

  const modelProgressLabel = selectedStatus?.modelProgress
    ? selectedStatus.modelProgress.phase === 'working'
      ? `正在工作（${Math.max(0, Math.floor((clockNow - selectedStatus.modelProgress.startedAt) / 1000))} 秒）`
      : '正在连接'
    : null;
  const toolProgressLabel = selectedStatus?.toolProgress
    ? selectedStatus.toolProgress.phase === 'reading'
      ? '正在读取'
      : selectedStatus.toolProgress.phase === 'validating'
        ? '正在校验'
        : selectedStatus.toolProgress.phase === 'writing'
          ? '正在写入'
          : '正在执行'
    : null;

  /**
   * Fallback thread (legacy statuses without `flow`): the text log plus the
   * activity log at the bottom, with the running strip and final reply on top
   * of the activities — the pre-flow behavior stays intact.
   */
  const lastLogIsAssistant = selectedLog.length > 0
    && selectedLog[selectedLog.length - 1]!.role === 'assistant';
  const leadingLog = lastLogIsAssistant ? selectedLog.slice(0, -1) : selectedLog;
  const trailingReply = lastLogIsAssistant
    ? selectedLog[selectedLog.length - 1]!
    : null;

  /**
   * User texts already visible in the thread (live status flow/log or the
   * journal-derived fallback). A journal record can lag behind the live flow
   * (delivery lands in the coordinator before the window re-fetches the
   * list), so an undelivered-looking supplement whose text is already in the
   * thread must not render a second queued bubble.
   */
  const selectedVisibleUserTexts = useMemo(() => {
    const texts = new Set<string>();
    for (const entry of selectedFlow ?? []) {
      if (entry.kind === 'user') texts.add(entry.text);
    }
    for (const entry of selectedLog) {
      if (entry.role === 'user') texts.add(entry.text);
    }
    return texts;
  }, [selectedFlow, selectedLog]);

  const selectedUndeliveredSupplements = useMemo(() => {
    if (!selectedRecord) return [];
    return selectedRecord.supplements.filter(
      (supplement) => !supplement.deliveredToModel
        && !selectedVisibleUserTexts.has(supplement.text),
    );
  }, [selectedRecord, selectedVisibleUserTexts]);

  const selectedTitle = selectedId
    ? conversationDisplayTitle(selectedRecord ?? {
        originalTaskText: selectedStatus?.originalTaskText ?? '',
        title: selectedStatus?.title,
        userRename: selectedStatus?.userRename,
      })
    : '项目 Agent';

  const filteredRecords = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return records;
    return records.filter((record) => (
      conversationDisplayTitle(record).toLowerCase().includes(query)
    ));
  }, [records, searchQuery]);

  const canAttachImage = !anyRunning && context?.imageInputSupported !== false;

  const startTask = () => {
    const text = draft.trim();
    if ((!text && !imageAttachment) || pendingStartId || anyRunning) return;
    const knownBefore = new Set<string>([
      ...statusesRef.current.keys(),
      ...records.map((record) => record.identity.taskId),
    ]);
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setStartError(null);
    const payload: ProjectAgentStartRequest = {
      taskText: text,
      requestId,
      ...(fullAccess ? { accessMode: 'full_access' as const } : {}),
      ...(imageAttachment
        ? {
            image: {
              name: imageAttachment.name,
              mimeType: imageAttachment.mimeType,
              bytes: imageAttachment.bytes,
              detail: 'auto' as const,
            },
          }
        : {}),
    };
    setPendingStartId(requestId);
    const resultPromise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timeout = window.setTimeout(() => {
        pendingStartResolversRef.current.delete(requestId);
        resolve({ ok: false, error: '任务启动超时，请确认编辑器窗口可用后重试。' });
      }, START_RESULT_TIMEOUT_MS);
      pendingStartResolversRef.current.set(requestId, (result) => {
        window.clearTimeout(timeout);
        resolve(result);
      });
    });
    if (!bridge) {
      pendingStartResolversRef.current.delete(requestId);
      setStartError('项目 Agent 服务不可用。');
      setPendingStartId(null);
      return;
    }
    void bridge.requestStart(payload).then(async (relayResult) => {
      if (!relayResult.ok) {
        pendingStartResolversRef.current.delete(requestId);
        setStartError(relayResult.error || '任务启动失败。');
        setPendingStartId(null);
        return;
      }
      const result = await resultPromise;
      setPendingStartId(null);
      if (!result.ok) {
        setStartError(result.error || '任务启动失败。');
        return;
      }
      setDraft('');
      setFullAccess(false);
      setImageAttachment(null);
      setAttachError(null);
      setListRefreshKey((key) => key + 1);
      autoSelectNextNewRef.current = knownBefore;
    });
  };

  /**
   * Wait until the editor has re-hydrated the target conversation after a
   * switch (ADR0023): the editor's restoreTask publishes a fresh status on
   * completion, so a status with `updatedAt` at or after the switch time is
   * the deterministic completion signal — no blind delay, no race with the
   * window-open restore pushes.
   */
  const waitForSwitchSettle = async (
    conversationId: string,
    issuedAt: number,
  ): Promise<boolean> => {
    if (!bridge) return false;
    const deadline = Date.now() + SWITCH_STATUS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = statusesRef.current.get(conversationId);
      if (current && current.updatedAt >= issuedAt) return true;
      const existing = await bridge.getTaskStatus(conversationId);
      if (existing) {
        mergeStatus(existing);
        if (existing.updatedAt >= issuedAt) return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  };

  const sendToSelected = () => {
    const text = draft.trim();
    if (!text || !selectedId || !context?.projectId || !bridge) return;
    setDraft('');
    setStartError(null);
    if (selectedRunning) {
      const pending: PendingSupplement = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        conversationId: selectedId,
        queued: true,
      };
      setPendingQueue((queue) => [...queue, pending]);
      followRef.current = true;
      setShowBackToBottom(false);
      void bridge.sendSupplement(selectedId, text);
      return;
    }
    if (selectedNoContinue) {
      setStartError('该对话已不可继续执行，只能浏览或删除。');
      return;
    }
    if (anyRunning) {
      setStartError('另一个对话正在执行，请等待其回合结束后再发送。');
      return;
    }
    const pending: PendingSupplement = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      conversationId: selectedId,
    };
    setPendingQueue((queue) => [...queue, pending]);
    // A new execution round begins: reset the latest-round timing and resume
    // following so the running status line and fresh work stay in view.
    if (!selectedRunning) {
      setRoundStart(null);
      setRoundEnd(null);
    }
    followRef.current = true;
    setShowBackToBottom(false);
    // Switching rehydrates even an idle persisted Conversation as suspended
    // until the editor owns it again, so any non-running selection needs an
    // execution request after its new user message is relayed.
    const needsExecution = !selectedRunning;
    const issuedAt = Date.now();
    void (async () => {
      const switched = await bridge.switchConversation(context.projectId, selectedId);
      if (!switched.ok) {
        setPendingQueue((queue) => queue.filter((entry) => entry.id !== pending.id));
        setStartError(switched.error ?? '无法切换到该对话。');
        return;
      }
      const settled = await waitForSwitchSettle(selectedId, issuedAt);
      if (!settled) {
        setPendingQueue((queue) => queue.filter((entry) => entry.id !== pending.id));
        setStartError('切换对话超时，请确认编辑器窗口可用后重试。');
        return;
      }
      await bridge.sendSupplement(selectedId, text);
      if (needsExecution) {
        await bridge.requestContinue(selectedId);
      }
    })();
  };

  const continueSelected = () => {
    if (!selectedId || !context?.projectId || !bridge) return;
    if (selectedRunning || selectedNoContinue || anyRunning) return;
    setRoundStart(null);
    setRoundEnd(null);
    followRef.current = true;
    setShowBackToBottom(false);
    const issuedAt = Date.now();
    void (async () => {
      const switched = await bridge.switchConversation(context.projectId, selectedId);
      if (!switched.ok) {
        setStartError(switched.error ?? '无法切换到该对话。');
        return;
      }
      const settled = await waitForSwitchSettle(selectedId, issuedAt);
      if (!settled) {
        setStartError('切换对话超时，请确认编辑器窗口可用后重试。');
        return;
      }
      await bridge.requestContinue(selectedId);
    })();
  };

  const pauseTask = () => {
    if (!selectedId) return;
    void bridge?.requestPause(selectedId, 'user_requested');
  };

  const cancelTask = () => {
    if (!selectedId) return;
    void bridge?.requestCancel(selectedId);
  };

  const deleteConversation = async (conversationId: string) => {
    if (!bridge || !context?.projectId) return;
    setStartError(null);
    const result = await bridge.deleteConversation(context.projectId, conversationId);
    if (!result.ok) {
      setStartError(result.error || '删除对话失败。');
      return;
    }
    setStatuses((previous) => {
      const next = new Map(previous);
      next.delete(conversationId);
      return next;
    });
    if (selectedId === conversationId) {
        setSelectedId(null);
    }
    setDeleteConfirmId(null);
    setListRefreshKey((key) => key + 1);
  };

  const commitRename = async (conversationId: string) => {
    if (!bridge || !context?.projectId) return;
    const result = await bridge.renameConversation(
      context.projectId,
      conversationId,
      renameDraft,
    );
    if (!result.ok) {
      setStartError(result.error || '重命名失败。');
    }
    setRenamingId(null);
    setRenameDraft('');
    setListRefreshKey((key) => key + 1);
  };

  const newConversation = () => {
    setSelectedId(null);
    setDraft('');
    setImageAttachment(null);
    setAttachError(null);
    setStartError(null);
    setSearchOpen(false);
    setSearchQuery('');
    setMentionOpen(false);
    setModelMenuOpen(false);
    setDeleteConfirmId(null);
    setRenamingId(null);
  };

  const openSettings = () => {
    void bridge?.requestOpenSettings();
  };

  const handleDraftChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setDraft(next);
    setStartError(null);
    const cursor = event.target.selectionStart ?? next.length;
    const before = next.slice(0, cursor);
    const match = /(^|\s)(@[^\s]*)$/.exec(before);
    if (match) {
      const wordStart = cursor - match[2].length;
      mentionRangeRef.current = { start: wordStart, end: cursor };
      setMentionFilter(match[2].slice(1).toLowerCase());
      setMentionIndex(0);
      if (!mentionOpen) {
        setMentionOpen(true);
        if (context?.projectRoot && mentionFilesRef.current.length === 0) {
          void listProjectFiles(context.projectRoot).then((files) => {
            mentionFilesRef.current = files;
            setMentionFiles(files);
          });
        }
      }
    } else {
      mentionRangeRef.current = null;
      setMentionOpen(false);
    }
  };

  const insertMention = (path: string) => {
    const range = mentionRangeRef.current;
    const textarea = draftRef.current;
    if (!range || !textarea) {
      setMentionOpen(false);
      return;
    }
    const next = `${draft.slice(0, range.start)}@${path}${draft.slice(range.end)}`;
    setDraft(next);
    setMentionOpen(false);
    mentionRangeRef.current = null;
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = range.start + path.length + 1;
      textarea.setSelectionRange(cursor, cursor);
    });
  };

  const mentionCandidates = useMemo(() => {
    if (!mentionFilter) return mentionFiles;
    return mentionFiles.filter((path) => {
      const name = path.split('/').pop()?.toLowerCase() ?? '';
      return path.toLowerCase().includes(mentionFilter) || name.includes(mentionFilter);
    });
  }, [mentionFiles, mentionFilter]);

  const toggleModelMenu = () => {
    const next = !modelMenuOpen;
    setModelMenuOpen(next);
    if (next) {
      fetchModels();
    }
  };

  const fetchModels = () => {
    if (modelFetchingRef.current) return;
    modelFetchingRef.current = true;
    setModelListState('loading');
    const settings = readStoredSettings();
    const baseUrl = settings.aiProse?.baseUrl?.trim() || DEFAULT_AI_BASE_URL;
    const aiBridge = window.aeonStageryAPI?.aiProse;
    if (!aiBridge?.listModels) {
      modelFetchingRef.current = false;
      setModelListState('error');
      return;
    }
    void aiBridge.listModels(baseUrl || '').then((result) => {
      modelFetchingRef.current = false;
      if (result.success) {
        setModelList(result.models);
        setModelListState('ready');
      } else {
        setModelListState('error');
      }
    }).catch(() => {
      modelFetchingRef.current = false;
      setModelListState('error');
    });
  };

  const selectModel = (model: string) => {
    setModelMenuOpen(false);
    void bridge?.setAgentModel(model).then((result) => {
      if (!result.ok) {
        setStartError(result.error || '模型切换失败。');
      }
    });
  };

  const selectEffort = (next: string) => {
    if (!AI_PROSE_EFFORTS.includes(next as (typeof AI_PROSE_EFFORTS)[number])) return;
    setEffort(next);
    void bridge?.setEffort(next).then((result) => {
      if (!result.ok) {
        setStartError(result.error || 'Effort 调整失败。');
      }
    });
  };

  const handlePickImage = () => {
    if (!canAttachImage) return;
    if (selectedId) {
      setAttachError('仅发起新对话时可附加图片。');
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setAttachError(null);
    try {
      const attachment = await processPickedImage(file);
      setImageAttachment((previous) => {
        if (previous) URL.revokeObjectURL(previous.previewUrl);
        return attachment;
      });
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : '图片处理失败。');
    }
  };

  const removeImage = () => {
    setImageAttachment((previous) => {
      if (previous) URL.revokeObjectURL(previous.previewUrl);
      return null;
    });
  };

  /**
   * Shared input box (ADR0023): one persistent composer surface pinned to the
   * footer of both the welcome surface and every conversation — same seat,
   * same width, same card chrome, so sending never moves or widens it.
   */
  const composerPlaceholder = selectedId
    ? (selectedRunning ? '追加指令…' : '继续输入，发送给当前对话…')
    : `可向 ${projectName} 询问任何事，输入 @ 提及文件`;

  const composerBlocked = anyRunning && !selectedRunning;
  const composerBlockedHint = composerBlocked
    ? '另一个对话正在执行，请等待其回合结束。'
    : selectedNoContinue
      ? '该对话已不可继续执行，只能浏览或删除。'
      : null;

  /** Shared composer submit: a new task from the welcome surface, a supplement otherwise. */
  const sendComposer = () => {
    if (selectedId) sendToSelected();
    else startTask();
  };

  const composerSendDisabled = selectedId
    ? !draft.trim() || composerBlocked || selectedNoContinue || !!pendingStartId
    : ((!draft.trim() && !imageAttachment) || !!pendingStartId || anyRunning);

  const greeting = `我们该在 ${projectName} 中做什么？`;

  return (
    <div className="agent-window">
      <aside className="agent-sidebar">
        <div className="agent-sidebar__top">
          <button
            type="button"
            className="agent-sidebar__action agent-sidebar__action--new"
            onClick={newConversation}
            title="发起新对话"
          >
            <IconPlus width={15} height={15} />
            <span>新对话</span>
          </button>
          <button
            type="button"
            className={`agent-sidebar__action agent-sidebar__action--icon ${searchOpen ? 'agent-sidebar__action--active' : ''}`}
            onClick={() => setSearchOpen((open) => !open)}
            title="搜索对话"
            aria-label="搜索"
          >
            <IconSearch width={15} height={15} />
          </button>
        </div>

        {searchOpen && (
          <div className="agent-sidebar__search">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="搜索对话…"
              aria-label="搜索对话"
            />
          </div>
        )}

        <div className="agent-sidebar__section">
          <h3 className="agent-sidebar__section-title">项目</h3>
          {context ? (
            <div className="agent-sidebar__project agent-sidebar__project--active">
              <span className="agent-sidebar__project-icon" aria-hidden="true">
                <IconFolder width={15} height={15} />
              </span>
              <span className="agent-sidebar__project-text">
                <strong>{context.projectName}</strong>
                {context.sceneName && <em>{context.sceneName}</em>}
              </span>
            </div>
          ) : (
            <p className="agent-sidebar__empty">未打开项目</p>
          )}
        </div>

        <div className="agent-sidebar__section agent-sidebar__section--grow">
          <h3 className="agent-sidebar__section-title">对话</h3>
          <ul className="agent-sidebar__convs" aria-label="对话列表">
            {filteredRecords.map((record) => {
              const id = record.identity.taskId;
              const status = statuses.get(id) ?? null;
              const active = id === selectedId;
              const renaming = id === renamingId;
              const deleting = id === deleteConfirmId;
              return (
                <li
                  key={id}
                  className={`agent-sidebar__conv ${active ? 'agent-sidebar__conv--active' : ''}`}
                >
                  {renaming ? (
                    <div className="agent-sidebar__conv-rename">
                      <input
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                            void commitRename(id);
                          } else if (event.key === 'Escape') {
                            setRenamingId(null);
                          }
                        }}
                        onFocus={(event) => event.target.select()}
                        placeholder="对话名称"
                        aria-label="对话名称"
                        autoFocus
                      />
                      <button
                        type="button"
                        className="agent-sidebar__conv-iconbtn"
                        onClick={() => void commitRename(id)}
                        aria-label="保存名称"
                        title="保存"
                      >
                        <IconCheck width={13} height={13} />
                      </button>
                      <button
                        type="button"
                        className="agent-sidebar__conv-iconbtn"
                        onClick={() => setRenamingId(null)}
                        aria-label="取消重命名"
                        title="取消"
                      >
                        <IconX width={13} height={13} />
                      </button>
                    </div>
                  ) : deleting ? (
                    <div className="agent-sidebar__conv-delete">
                      <span>删除此对话？</span>
                      <button
                        type="button"
                        className="agent-sidebar__conv-iconbtn agent-sidebar__conv-iconbtn--danger"
                        onClick={() => void deleteConversation(id)}
                        title="确认删除"
                      >
                        <IconTrash width={13} height={13} />
                      </button>
                      <button
                        type="button"
                        className="agent-sidebar__conv-iconbtn"
                        onClick={() => setDeleteConfirmId(null)}
                        title="取消"
                      >
                        <IconX width={13} height={13} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="agent-sidebar__conv-row"
                      onClick={() => {
                                            setSelectedId(id);
                        setStartError(null);
                      }}
                    >
                      <span
                        className={`agent-sidebar__conv-dot ${conversationDotClass(status)}`}
                        aria-hidden="true"
                      />
                      <span className="agent-sidebar__conv-text" title={conversationDisplayTitle(record)}>
                        {conversationDisplayTitle(record)}
                      </span>
                      <span className="agent-sidebar__conv-time">
                        {formatRelativeTime(conversationUpdatedAt(record, status))}
                      </span>
                      <span className="agent-sidebar__conv-actions">
                        <span
                          role="button"
                          tabIndex={0}
                          className="agent-sidebar__conv-iconbtn"
                          aria-label="重命名对话"
                          title="重命名"
                          onClick={(event) => {
                            event.stopPropagation();
                            setRenameDraft(conversationDisplayTitle(record));
                            setRenamingId(id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.stopPropagation();
                              setRenameDraft(conversationDisplayTitle(record));
                              setRenamingId(id);
                            }
                          }}
                        >
                          <IconPencil width={13} height={13} />
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          className="agent-sidebar__conv-iconbtn"
                          aria-label="删除对话"
                          title="删除对话"
                          onClick={(event) => {
                            event.stopPropagation();
                            setDeleteConfirmId(id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.stopPropagation();
                              setDeleteConfirmId(id);
                            }
                          }}
                        >
                          <IconTrash width={13} height={13} />
                        </span>
                      </span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {filteredRecords.length === 0 && (
            <p className="agent-sidebar__empty">
              {searchQuery ? '没有匹配的对话' : '暂无对话，发起第一个吧'}
            </p>
          )}
        </div>

        <div className="agent-sidebar__footer">
          <button
            type="button"
            className="agent-sidebar__action agent-sidebar__action--footer"
            onClick={openSettings}
          >
            <IconSettings width={15} height={15} />
            <span>设置</span>
          </button>
        </div>
      </aside>

      <div className="agent-main">
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

        {selectedId ? (
          <>
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

              {selectedSuspended && (
                <div className="agent-window__msg agent-window__msg--agent">
                  <span className="agent-window__agent-mark" aria-hidden="true">
                    <IconClock width={12} height={12} />
                  </span>
                  <div className="agent-window__agent-card agent-window__agent-card--paused">
                    <p className="agent-window__paused-text">
                      {formatPauseReason(selectedPauseReason)}
                    </p>
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
              )}

              {startError && (
                <p className="agent-window__notice agent-window__notice--error" role="alert">
                  <IconWarning width={13} height={13} />
                  {startError}
                </p>
              )}
            </main>
          </>
        ) : (
          <main className="agent-welcome">
            {startError && (
              <p className="agent-welcome__error" role="alert">
                <IconWarning width={13} height={13} />
                {startError}
              </p>
            )}
            <h1 className="agent-welcome__title">{greeting}</h1>
          </main>
        )}
        <div className="agent-composer-wrap">
          <div className="agent-promptbox">
            {imageAttachment && (
              <div className="agent-promptbox__preview">
                <img
                  className="agent-promptbox__preview-thumb"
                  src={imageAttachment.previewUrl}
                  alt={imageAttachment.name}
                />
                <span className="agent-promptbox__preview-name" title={imageAttachment.name}>
                  {imageAttachment.name}
                </span>
                <button
                  type="button"
                  className="agent-promptbox__preview-remove"
                  onClick={removeImage}
                  aria-label="移除图片"
                >
                  <IconX width={12} height={12} />
                </button>
              </div>
            )}
            <textarea
              id="agent-window-supplement"
              ref={draftRef}
              className="agent-promptbox__input"
              value={draft}
              placeholder={composerPlaceholder}
              aria-label="任务描述"
              rows={3}
              disabled={selectedId ? (composerBlocked || selectedNoContinue) : false}
              onChange={handleDraftChange}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && mentionOpen && mentionCandidates.length > 0) {
                  event.preventDefault();
                  setMentionIndex((index) => (index + 1) % mentionCandidates.length);
                } else if (event.key === 'ArrowUp' && mentionOpen && mentionCandidates.length > 0) {
                  event.preventDefault();
                  setMentionIndex((index) => (
                    (index - 1 + mentionCandidates.length) % mentionCandidates.length
                  ));
                } else if (event.key === 'Enter' && !event.nativeEvent.isComposing && !mentionOpen) {
                  event.preventDefault();
                  sendComposer();
                } else if (event.key === 'Enter' && mentionOpen) {
                  event.preventDefault();
                  if (mentionCandidates[mentionIndex]) {
                    insertMention(mentionCandidates[mentionIndex]!);
                  }
                } else if (event.key === 'Escape') {
                  setMentionOpen(false);
                  setModelMenuOpen(false);
                }
              }}
            />

            {mentionOpen && (
              <div className="agent-popover agent-popover--mention" role="listbox" aria-label="提及文件">
                <div className="agent-popover__head">
                  <span className="agent-popover__head-icon" aria-hidden="true">
                    <IconFile width={12} height={12} />
                  </span>
                  项目文件
                </div>
                <ul className="agent-popover__list">
                  {mentionCandidates.length === 0 && (
                    <li className="agent-popover__empty">没有匹配的文件</li>
                  )}
                  {mentionCandidates.map((path, index) => (
                    <li
                      key={path}
                      role="option"
                      aria-selected={index === mentionIndex}
                      className={`agent-popover__item ${index === mentionIndex ? 'agent-popover__item--active' : ''}`}
                      onMouseEnter={() => setMentionIndex(index)}
                      onClick={() => insertMention(path)}
                    >
                      <IconFile width={12} height={12} />
                      <span>{path}</span>
                    </li>
                  ))}
                </ul>
                {mentionFiles.length >= 500 && (
                  <p className="agent-popover__hint">文件较多，仅显示部分（至多 500 项）</p>
                )}
              </div>
            )}

            {attachError && <p className="agent-promptbox__attach-error">{attachError}</p>}

            {!selectedId && fullAccess && (
              <div className="agent-promptbox__access-warning" role="status">
                <IconWarning width={13} height={13} />
                <span>完全访问已开启：Agent 将获得执行 Shell 终端命令的系统权限。</span>
              </div>
            )}

            <div className="agent-promptbox__footer">
              <div className="agent-promptbox__footer-left">
                {!selectedId && (
                  <label
                    className="agent-promptbox__access"
                    title="允许 Agent 执行任意终端命令；仅影响这次新建对话"
                  >
                    <input
                      type="checkbox"
                      checked={fullAccess}
                      disabled={anyRunning || !!pendingStartId}
                      onChange={(event) => setFullAccess(event.target.checked)}
                    />
                    <span className="agent-promptbox__access-track" aria-hidden="true" />
                    <span>完全访问</span>
                  </label>
                )}
                <button
                  type="button"
                  className="agent-promptbox__tool"
                  onClick={handlePickImage}
                  disabled={!canAttachImage}
                  title={selectedId
                    ? '仅发起新对话时可附加图片'
                    : !canAttachImage && anyRunning
                      ? '另一个对话执行中，不能附加图片'
                      : context?.imageInputSupported === false
                        ? '当前模型不支持图片输入'
                        : '上传图片'}
                  aria-label="上传图片"
                >
                  <IconPlus width={15} height={15} />
                  <IconImage width={15} height={15} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(event) => void handleFileChange(event)}
                />
              </div>
              <div className="agent-promptbox__footer-right">
                <button
                  type="button"
                  className={`agent-promptbox__model ${modelMenuOpen ? 'agent-promptbox__model--open' : ''}`}
                  onClick={toggleModelMenu}
                  title="切换模型"
                  aria-haspopup="listbox"
                  aria-expanded={modelMenuOpen}
                >
                  <span>{effectiveModel || '未配置模型'}</span>
                  <IconChevronDown width={12} height={12} aria-hidden="true" />
                </button>
                {selectedRunning && !draft.trim() ? (
                  <button
                    type="button"
                    className="agent-promptbox__stop"
                    onClick={cancelTask}
                    aria-label="停止生成"
                    title="停止生成"
                  >
                    <IconSquare width={13} height={13} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="agent-promptbox__send"
                    disabled={composerSendDisabled}
                    onClick={sendComposer}
                    aria-label="发送"
                  >
                    {pendingStartId
                      ? <span className="agent-promptbox__send-spinner" aria-hidden="true" />
                      : <IconSend width={15} height={15} />}
                  </button>
                )}
              </div>
            </div>

            {modelMenuOpen && (
              <div className="agent-model-panel" aria-label="模型与 Effort 设置">
                <div className="agent-model-panel__effort">
                  <div className="agent-model-panel__effort-head">
                    <span className="agent-model-panel__label">Effort</span>
                    <span className="agent-model-panel__effort-value">{effort}</span>
                  </div>
                  <input
                    type="range"
                    className="agent-model-panel__effort-slider"
                    min={0}
                    max={AI_PROSE_EFFORTS.length - 1}
                    step={1}
                    value={AI_PROSE_EFFORTS.indexOf(effort as (typeof AI_PROSE_EFFORTS)[number])}
                    aria-label="推理力度"
                    style={{
                      '--effort-fill': `${(AI_PROSE_EFFORTS.indexOf(effort as (typeof AI_PROSE_EFFORTS)[number]) / (AI_PROSE_EFFORTS.length - 1)) * 100}%`,
                    } as React.CSSProperties}
                    onChange={(event) => {
                      const next = AI_PROSE_EFFORTS[Number(event.target.value)];
                      if (next) selectEffort(next);
                    }}
                  />
                </div>

                <div className="agent-model-panel__divider" aria-hidden="true" />
                {modelListState === 'loading' && (
                  <p className="agent-popover__empty">正在获取模型列表...</p>
                )}
                {modelListState === 'error' && (
                  <>
                    <p className="agent-popover__empty">无法获取模型列表（请检查 AI 设置中的接口地址）。</p>
                    <button
                      type="button"
                      className="btn btn--sm agent-popover__retry"
                      onClick={fetchModels}
                    >
                      重试
                    </button>
                  </>
                )}
                {modelListState === 'ready' && (
                  <ul
                    className={`agent-popover__list ${modelList.length > 8 ? 'agent-model-panel__list--grid' : ''}`}
                    role="listbox"
                    aria-label="选择模型"
                  >
                    {modelList.length === 0 && (
                      <li className="agent-popover__empty">接口未返回可用模型</li>
                    )}
                    {modelList.map((model) => (
                      <li
                        key={model}
                        role="option"
                        aria-selected={model === effectiveModel}
                        title={model}
                        className={`agent-popover__item ${model === effectiveModel ? 'agent-popover__item--active' : ''}`}
                        onClick={() => selectModel(model)}
                      >
                        <span>{model}</span>
                        {model === effectiveModel && <IconCheck width={12} height={12} />}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          {selectedId && composerBlockedHint && (
            <p className="agent-window__composer-hint">{composerBlockedHint}</p>
          )}
        </div>
      </div>
    </div>
  );
};

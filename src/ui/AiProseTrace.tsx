import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { AiProseEffort } from '../api/types/ai-prose-authoring';
import type {
  AiProseLlmProgress,
  AiProseTokenCountSource,
} from '../services/ai-authoring/AiProseContracts';

export type AiProseTraceProgress = AiProseLlmProgress & {
  delta?: string;
  content?: string;
  effort?: AiProseEffort;
  error?: unknown;
  contextWindow?: number;
};

export type AiRequestTraceStatus = 'running' | 'completed' | 'failed';

export type AiRequestRuntimeState = 'idle' | 'running' | 'succeeded' | 'failed';

export const AI_TRACE_STATUS_LABELS: Record<AiRequestTraceStatus, string> = {
  running: '思考中',
  completed: '已完成',
  failed: '失败',
};

export const AI_STAGE_LABELS: Record<AiProseLlmProgress['stage'], string> = {
  segmentation: '语义分段',
  characterExtraction: '人物提取',
  normalization: '语句规范化',
  rhythm: '语义节奏',
  acting: '表演指导',
  cinematic: '电影感',
};

export type AiRequestTrace = {
  requestId: string;
  stage: AiProseLlmProgress['stage'];
  status: AiRequestTraceStatus;
  inputTokens: number;
  outputTokens: number;
  inputTokensSource: AiProseTokenCountSource;
  outputTokensSource: AiProseTokenCountSource;
  model?: string;
  effort?: AiProseEffort;
  httpStatus?: number;
  contextWindow?: number;
  elapsedMs?: number;
  /** 1-based attempt number; > 1 means this card is a retry of the same operation. */
  attempt?: number;
  content: string;
  error?: string;
};

function formatCount(value: number): string {
  return value.toLocaleString('zh-CN');
}

export function toRecord(value: unknown): Record<string, unknown> | undefined {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function formatProgressError(error: unknown): string | undefined {
  if (error === undefined || error === null || error === '') return undefined;
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const record = toRecord(error);
  if (typeof record?.message === 'string') return record.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getTraceStatus(
  previous: AiRequestTraceStatus | undefined,
  phase: AiProseLlmProgress['phase'],
): AiRequestTraceStatus {
  if (previous === 'completed' || previous === 'failed') return previous;
  if (phase === 'failed') return 'failed';
  if (phase === 'completed') return 'completed';
  return 'running';
}

function formatTelemetryCount(value: number, source: AiProseTokenCountSource): string {
  return `${source === 'estimate' ? '≈' : ''}${formatCount(Math.max(0, Math.round(value)))}`;
}

function formatElapsedMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const safe = Math.max(0, value);
  return safe < 1000 ? `${Math.round(safe)} ms` : `${(safe / 1000).toFixed(1)} s`;
}

function formatContextUsage(request: AiRequestTrace): string | undefined {
  if (request.contextWindow === undefined || request.contextWindow <= 0) return undefined;
  const usedTokens = request.inputTokens + request.outputTokens;
  const percentage = (usedTokens / request.contextWindow) * 100;
  return `${percentage.toFixed(1)}%`;
}

export interface UseAiRequestTraceOptions {
  effort?: AiProseEffort;
}

/**
 * Live AI request trace shared by the prose workbench and the formal
 * enhancement panel: keeps request cards (stage/model/tokens/status/raw
 * response) in a ref-backed map and derives the overall runtime state from
 * running/failed requests, mirroring the transport's progress events.
 */
export function useAiRequestTrace(options: UseAiRequestTraceOptions = {}) {
  const { effort } = options;
  const traceRef = useRef(new Map<string, AiRequestTrace>());
  const [traceRequests, setTraceRequests] = useState<readonly AiRequestTrace[]>([]);
  const [expandedRequestIds, setExpandedRequestIds] = useState<ReadonlySet<string>>(new Set());
  const [runtimeState, setRuntimeState] = useState<AiRequestRuntimeState>('idle');

  const handleLlmProgress = useCallback((progress: AiProseTraceProgress) => {
    const previous = traceRef.current.get(progress.requestId);
    const status = getTraceStatus(previous?.status, progress.phase);
    const progressError = formatProgressError(progress.error);
    const nextError = progressError ?? previous?.error;
    const nextContent = typeof progress.content === 'string'
      ? progress.content
      : typeof progress.delta === 'string'
        ? `${previous?.content ?? ''}${progress.delta}`
        : previous?.content ?? '';
    const next: AiRequestTrace = {
      requestId: progress.requestId,
      stage: progress.stage,
      status,
      inputTokens: progress.inputTokensSource === 'provider'
        ? progress.inputTokens
        : Math.max(previous?.inputTokens ?? 0, progress.inputTokens),
      outputTokens: progress.outputTokensSource === 'provider'
        ? progress.outputTokens
        : Math.max(previous?.outputTokens ?? 0, progress.outputTokens),
      inputTokensSource: progress.inputTokensSource === 'provider'
        ? 'provider'
        : previous?.inputTokensSource ?? 'estimate',
      outputTokensSource: progress.outputTokensSource === 'provider'
        ? 'provider'
        : previous?.outputTokensSource ?? 'estimate',
      content: nextContent,
      attempt: progress.attempt ?? previous?.attempt ?? 1,
      ...(progress.model !== undefined ? { model: progress.model } : previous?.model ? { model: previous.model } : {}),
      effort: progress.effort ?? previous?.effort ?? effort,
      ...(progress.status !== undefined ? { httpStatus: progress.status } : previous?.httpStatus !== undefined ? { httpStatus: previous.httpStatus } : {}),
      ...(typeof progress.contextWindow === 'number' && progress.contextWindow > 0
        ? { contextWindow: progress.contextWindow }
        : previous?.contextWindow !== undefined
          ? { contextWindow: previous.contextWindow }
          : {}),
      ...(typeof progress.elapsedMs === 'number' && Number.isFinite(progress.elapsedMs)
        ? { elapsedMs: progress.elapsedMs }
        : previous?.elapsedMs !== undefined
          ? { elapsedMs: previous.elapsedMs }
          : {}),
      ...(nextError ? { error: nextError } : {}),
    };
    traceRef.current.set(progress.requestId, next);
    setExpandedRequestIds((current) => {
      const nextExpanded = new Set(current);
      if (!previous || status === 'running') nextExpanded.add(progress.requestId);
      if (status === 'completed') nextExpanded.delete(progress.requestId);
      if (status === 'failed') nextExpanded.add(progress.requestId);
      return nextExpanded;
    });
    setTraceRequests([...traceRef.current.values()]);
    if (status === 'running') {
      setRuntimeState('running');
    } else if (status === 'failed') {
      setRuntimeState('failed');
    } else {
      const hasActiveRequest = [...traceRef.current.values()]
        .some((request) => request.status === 'running');
      if (!hasActiveRequest) {
        const hasFailedRequest = [...traceRef.current.values()]
          .some((request) => request.status === 'failed');
        setRuntimeState(hasFailedRequest ? 'failed' : 'succeeded');
      }
    }
  }, [effort]);

  const reset = useCallback(() => {
    traceRef.current.clear();
    setExpandedRequestIds(new Set());
    setTraceRequests([]);
  }, []);

  const toggleTraceRequest = useCallback((requestId: string) => {
    setExpandedRequestIds((current) => {
      const next = new Set(current);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });
  }, []);

  return useMemo(
    () => ({
      traceRequests,
      expandedRequestIds,
      runtimeState,
      setRuntimeState,
      reset,
      toggleTraceRequest,
      handleLlmProgress,
    }),
    [
      traceRequests,
      expandedRequestIds,
      runtimeState,
      setRuntimeState,
      reset,
      toggleTraceRequest,
      handleLlmProgress,
    ],
  );
}

export type AiRequestTracePanelProps = {
  requests: readonly AiRequestTrace[];
  expandedIds: ReadonlySet<string>;
  onToggle: (requestId: string) => void;
  onCollapse?: () => void;
};

export function AiRequestTracePanel({
  requests,
  expandedIds,
  onToggle,
  onCollapse,
}: AiRequestTracePanelProps) {
  return (
    <aside className="ai-prose-trace-panel" aria-label="AI 运行轨迹">
      <div className="ai-prose-trace-inner">
        <div className="ai-prose-trace-header">
          <div className="ai-prose-trace-header-copy">
            <strong>AI 请求轨迹</strong>
            <small>发送/接收 tokens · 状态 · 原始响应</small>
          </div>
          <span className="ai-prose-trace-header-count">
            {requests.length}
            {' '}
            条
          </span>
          {onCollapse && (
            <button className="ai-prose-button ai-prose-button--icon" type="button" onClick={onCollapse} aria-label="收起运行轨迹">›</button>
          )}
        </div>
        {requests.length > 0 ? (
          <div className="ai-prose-request-trace-list">
            {requests.map((request) => (
              <AiRequestTraceCard
                key={request.requestId}
                request={request}
                expanded={expandedIds.has(request.requestId)}
                onToggle={onToggle}
              />
            ))}
          </div>
        ) : (
          <div className="ai-prose-trace-empty">等待 AI 请求</div>
        )}
      </div>
    </aside>
  );
}

type AiRequestTraceCardProps = {
  request: AiRequestTrace;
  expanded: boolean;
  onToggle: (requestId: string) => void;
};

export const AiRequestTraceCard = React.memo(function AiRequestTraceCard({
  request,
  expanded,
  onToggle,
}: AiRequestTraceCardProps) {
  const contextUsage = formatContextUsage(request);
  const contentId = `ai-prose-trace-content-${request.requestId}`;
  return (
    <article
      className={`ai-prose-trace-card is-${request.status} ${expanded ? 'is-expanded' : ''}`}
      data-request-id={request.requestId}
      data-status={request.status}
      data-testid={`ai-prose-trace-card-${request.requestId}`}
    >
      <button
        className="ai-prose-trace-card-header"
        type="button"
        onClick={() => onToggle(request.requestId)}
        aria-controls={contentId}
        aria-expanded={expanded}
        aria-label={`${request.requestId} ${request.status}`}
      >
        <span className="ai-prose-trace-card-heading">
          <strong>{AI_STAGE_LABELS[request.stage] ?? request.stage}</strong>
          <small>{request.model ?? '—'} · {contextUsage ? `${contextUsage} context used` : '— context used'}</small>
          {request.attempt !== undefined && request.attempt > 1 && (
            <em className="ai-prose-trace-card-attempt">第 {request.attempt - 1} 次重试</em>
          )}
        </span>
        <span className={`ai-prose-trace-card-status is-${request.status}`}>{AI_TRACE_STATUS_LABELS[request.status]}</span>
        <span className="ai-prose-trace-card-chevron" aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
      </button>

      <dl className="ai-prose-trace-card-details">
        <div className="ai-prose-trace-token-metric is-sent">
          <dt><span className="ai-prose-trace-token-label"><span className="ai-prose-trace-token-icon" aria-hidden="true">↑</span>发送 tokens</span></dt>
          <dd>{formatTelemetryCount(request.inputTokens, request.inputTokensSource)}</dd>
        </div>
        <div className="ai-prose-trace-token-metric is-received">
          <dt><span className="ai-prose-trace-token-label"><span className="ai-prose-trace-token-icon" aria-hidden="true">↓</span>接收 tokens</span></dt>
          <dd>{formatTelemetryCount(request.outputTokens, request.outputTokensSource)}</dd>
        </div>
        <div><dt>推理力度</dt><dd>{request.effort ?? '—'}</dd></div>
        <div><dt>耗时</dt><dd>{formatElapsedMs(request.elapsedMs)}</dd></div>
        {request.attempt !== undefined && (
          <div data-testid="ai-prose-trace-attempt">
            <dt>请求次数</dt>
            <dd>第 {request.attempt} 次</dd>
          </div>
        )}
        {contextUsage && (
          <div data-testid="ai-prose-trace-context">
            <dt>上下文占用</dt>
            <dd>{contextUsage}</dd>
          </div>
        )}
        {request.httpStatus !== undefined && <div><dt>HTTP 状态</dt><dd>{request.httpStatus}</dd></div>}
      </dl>

      {request.error && (
        <div className="ai-prose-trace-card-error" role="alert">
          <span>错误</span>
          <code>{request.error}</code>
        </div>
      )}

      {expanded && (
        <div
          id={contentId}
          className={`ai-prose-trace-card-content ${request.status === 'running' ? 'is-running' : ''}`}
          aria-busy={request.status === 'running'}
        >
          {request.status === 'running' && (
            <div className="ai-prose-trace-thinking" role="status">
              <span className="ai-prose-trace-spinner" aria-hidden="true" />
              <span>正在思考</span>
              <span className="ai-prose-trace-thinking-dots" aria-hidden="true">···</span>
            </div>
          )}
          <pre aria-label={`raw response ${request.requestId}`}>
            {request.content || (request.status === 'running' ? '等待响应内容…' : '暂无原始响应')}
          </pre>
        </div>
      )}
    </article>
  );
});

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  projectConversationLogFromMessages,
  projectConversationTurnFlow,
  type ProjectAgentConversationLogEntry,
  type ProjectAgentConversationFlowEntry,
  type ProjectAgentTaskStatusPayload,
} from '../../api/types/project-agent-ipc';
import {
  decodeProjectAgentConversationMessages,
  type ProjectAgentJournalRecord,
} from '../../services/project-agent/ProjectAgentJournal';
import {
  PROJECT_AGENT_HOST_RECOVERY_NOTE_PREFIX,
  type ProjectAgentActivityRecord,
} from '../../services/project-agent/ProjectAgentTask';
import { RUNNING_LIFE_CYCLES, type PendingSupplement } from './agentWindowPresentation';

interface AgentThreadOptions {
  selectedId: string | null;
  selectedStatus: ProjectAgentTaskStatusPayload | null;
  selectedRecord: ProjectAgentJournalRecord | null;
  selectedRunning: boolean;
  selectedSuspended: boolean;
  selectedLifecycle: string | null;
  isInterrupted: boolean;
  statuses: ReadonlyMap<string, ProjectAgentTaskStatusPayload>;
  pendingQueue: readonly PendingSupplement[];
  waiting: boolean;
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

export function useAgentThread({
  selectedId,
  selectedStatus,
  selectedRecord,
  selectedRunning,
  selectedSuspended,
  selectedLifecycle,
  isInterrupted,
  statuses,
  pendingQueue,
  waiting,
}: AgentThreadOptions) {
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [expandedActivities, setExpandedActivities] = useState<ReadonlySet<number>>(() => new Set());
  /** Per-group collapse state: each 工具 group (thread section or tail)
   *  expands/collapses independently (ADR0023). */
  const [collapsedToolGroups, setCollapsedToolGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [showBackToBottom, setShowBackToBottom] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  /** Turn timing (harness-style status line): round start and settled end of
   *  the latest round — captured from live statuses while watching, or derived
   *  from the journal record's lastSettledRound when reopening/switching back.
   *  State (not refs) so the settled 「已完成 · Ns」 line renders itself. */
  const [roundStart, setRoundStart] = useState<number | null>(null);
  const [roundEnd, setRoundEnd] = useState<{ at: number; label: 'completed' | 'cancelled' | 'suspended' } | null>(null);
  /** Follow-scroll: keep pinned to the thread bottom while the user has not
   *  scrolled up; a back-to-bottom chip resumes following on click. */
  const followRef = useRef(true);
  const lastSelectedConversationIdRef = useRef<string | null>(null);
  const selectedStatusRef = useRef(selectedStatus);
  useEffect(() => {
    selectedStatusRef.current = selectedStatus;
  }, [selectedStatus]);
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
    const status = selectedId ? selectedStatusRef.current : null;
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

  const resumeFollowing = () => {
    followRef.current = true;
    setShowBackToBottom(false);
  };
  const resetRound = () => {
    setRoundStart(null);
    setRoundEnd(null);
  };
  return {
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
    resetRound,
    resumeFollowing,
  };
}

export type AgentThreadState = ReturnType<typeof useAgentThread>;

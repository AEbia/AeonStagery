import React, { useEffect, useRef, useState } from 'react';
import {
  conversationDisplayTitle,
  projectConversationTurnFlow,
  type ProjectAgentProjectContext,
  type ProjectAgentStartRequest,
  type ProjectAgentTaskStatusPayload,
} from './api/types/project-agent-ipc';
import {
  decodeProjectAgentConversationMessages,
  type ProjectAgentJournalRecord,
} from './services/project-agent/ProjectAgentJournal';
import { MISSING_CREDENTIAL_GUIDE_MESSAGE } from './services/ai-authoring/aiErrorPresentation';
import {
  RUNNING_LIFE_CYCLES,
  SUSPENDED_LIFE_CYCLES,
  NO_CONTINUE_PAUSE_REASONS,
  isLifecycleInterruption,
  conversationUpdatedAt,
  type PendingSupplement,
} from './ui/agent/agentWindowPresentation';
import { useAgentThread } from './ui/agent/useAgentThread';
import { useAgentWindowSettings } from './ui/agent/useAgentWindowSettings';
import { useAgentImageAttachment } from './ui/agent/useAgentImageAttachment';
import { useAgentFileMentions } from './ui/agent/useAgentFileMentions';
import { AgentWindowSidebar } from './ui/agent/AgentWindowSidebar';
import { AgentWindowHeader } from './ui/agent/AgentWindowHeader';
import { AgentWindowThread } from './ui/agent/AgentWindowThread';
import { AgentWindowWelcome } from './ui/agent/AgentWindowWelcome';
import { AgentWindowComposer } from './ui/agent/AgentWindowComposer';

const START_RESULT_TIMEOUT_MS = 30_000;
const SWITCH_STATUS_TIMEOUT_MS = 8_000;
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
  const [waiting, setWaiting] = useState(true);
  const [draft, setDraft] = useState('');
  const [fullAccess, setFullAccess] = useState(false);
  const [context, setContext] = useState<ProjectAgentProjectContext | null>(null);
  const supplementSendingRef = useRef(false);
  const [supplementSending, setSupplementSending] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const settings = useAgentWindowSettings(setStartError);
  const { needsCredentialSetup } = settings;
  const mentions = useAgentFileMentions(draft, setDraft, context?.projectRoot, () => setStartError(null));
  const [pendingStartId, setPendingStartId] = useState<string | null>(null);
  const pendingStartResolversRef = useRef(new Map<string, (payload: { ok: boolean; error?: string }) => void>());
  const initialSelectionDoneRef = useRef(false);
  const autoSelectNextNewRef = useRef<ReadonlySet<string> | null>(null);
  const statusesRef = useRef<ReadonlyMap<string, ProjectAgentTaskStatusPayload>>(new Map());
  const knownTaskIdsRef = useRef<ReadonlySet<string>>(new Set());
  const prevSelectedRef = useRef<{ id: string | null; index: number | null }>({ id: null, index: null });
  const switchTimerRef = useRef<number | null>(null);
  const [switchDir, setSwitchDir] = useState<'forward' | 'back' | null>(null);

  const projectName = context?.projectName?.trim() || '当前项目';
  const bridge = window.aeonStageryAPI?.projectAgent;

  useEffect(() => {
    statusesRef.current = statuses;
  }, [statuses]);

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
  const thread = useAgentThread({
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
  });

  const selectedTitle = selectedId
    ? conversationDisplayTitle(selectedRecord ?? {
        originalTaskText: selectedStatus?.originalTaskText ?? '',
        title: selectedStatus?.title,
        userRename: selectedStatus?.userRename,
      })
    : '项目 Agent';

  const canAttachImage = (!anyRunning || selectedRunning) && !selectedNoContinue
    && !pendingStartId && !supplementSending && context?.imageInputSupported !== false;

  const images = useAgentImageAttachment(selectedId, context?.projectId, canAttachImage);
  const { imageAttachment, imageProcessing, setImageAttachment, setAttachError } = images;

  const startTask = () => {
    const text = draft.trim();
    if ((!text && !imageAttachment) || imageProcessing || pendingStartId || anyRunning) return;
    if (needsCredentialSetup) {
      setStartError(MISSING_CREDENTIAL_GUIDE_MESSAGE);
      return;
    }
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
    if ((!text && !imageAttachment) || !selectedId || !context?.projectId || !bridge
      || imageProcessing || pendingStartId || supplementSendingRef.current) return;
    if (selectedNoContinue) {
      setStartError('该对话已不可继续执行，只能浏览或删除。');
      return;
    }
    if (anyRunning && !selectedRunning) {
      setStartError('另一个对话正在执行，请等待其回合结束后再发送。');
      return;
    }
    if (needsCredentialSetup) {
      setStartError(MISSING_CREDENTIAL_GUIDE_MESSAGE);
      return;
    }
    const attachment = imageAttachment;
    const image = attachment ? {
      name: attachment.name, mimeType: attachment.mimeType,
      bytes: attachment.bytes, detail: 'auto' as const,
    } : undefined;
    const pending: PendingSupplement = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: [text, ...(image ? ['[已附加图片]'] : [])].filter(Boolean).join('\n'),
      conversationId: selectedId,
      ...(selectedRunning ? { queued: true } : {}),
    };
    supplementSendingRef.current = true;
    setSupplementSending(true);
    setStartError(null);
    setPendingQueue((queue) => [...queue, pending]);
    if (!selectedRunning) {
      thread.resetRound();
    }
    thread.resumeFollowing();
    const issuedAt = Date.now();
    void (async () => {
      try {
        if (!selectedRunning) {
          const switched = await bridge.switchConversation(context.projectId, selectedId);
          if (!switched.ok) throw new Error(switched.error ?? '无法切换到该对话。');
          if (!await waitForSwitchSettle(selectedId, issuedAt)) {
            throw new Error('切换对话超时，请确认编辑器窗口可用后重试。');
          }
        }
        const sent = image
          ? await bridge.sendSupplement(selectedId, text, image)
          : await bridge.sendSupplement(selectedId, text);
        if (!sent.ok) throw new Error(sent.error || '消息发送失败，请重试。');
        setDraft((current) => current.trim() === text ? '' : current);
        setImageAttachment((current) => current === attachment ? null : current);
        setAttachError(null);
        if (!selectedRunning) {
          const continued = await bridge.requestContinue(selectedId);
          if (!continued.ok) setStartError(continued.error || '消息已保存，请重试继续执行。');
        }
      } catch (error) {
        setPendingQueue((queue) => queue.filter((entry) => entry.id !== pending.id));
        setStartError(error instanceof Error ? error.message : '消息发送失败，请重试。');
      } finally {
        supplementSendingRef.current = false;
        setSupplementSending(false);
      }
    })();
  };

  const continueSelected = () => {
    if (!selectedId || !context?.projectId || !bridge) return;
    if (selectedRunning || selectedNoContinue || anyRunning) return;
    thread.resetRound();
    thread.resumeFollowing();
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

  function pauseTask() {
    if (!selectedId) return;
    void bridge?.requestPause(selectedId, 'user_requested');
  }

  const cancelTask = () => {
    if (!selectedId) return;
    void bridge?.requestCancel(selectedId);
  };

  const deleteConversation = async (conversationId: string): Promise<boolean> => {
    if (!bridge || !context?.projectId) return false;
    setStartError(null);
    const result = await bridge.deleteConversation(context.projectId, conversationId);
    if (!result.ok) {
      setStartError(result.error || '删除对话失败。');
      return false;
    }
    setStatuses((previous) => {
      const next = new Map(previous);
      next.delete(conversationId);
      return next;
    });
    if (selectedId === conversationId) {
      setSelectedId(null);
    }
    setListRefreshKey((key) => key + 1);
    return true;
  };

  const commitRename = async (conversationId: string, title: string) => {
    if (!bridge || !context?.projectId) return;
    const result = await bridge.renameConversation(
      context.projectId,
      conversationId,
      title,
    );
    if (!result.ok) {
      setStartError(result.error || '重命名失败。');
    }
    setListRefreshKey((key) => key + 1);
  };

  const newConversation = () => {
    images.resetImages();
    setSelectedId(null);
    setDraft('');
    setStartError(null);
    mentions.setMentionOpen(false);
    settings.setModelMenuOpen(false);
  };

  const openSettings = () => {
    void bridge?.requestOpenSettings();
  };

  /** Shared composer submit: a new task from the welcome surface, a supplement otherwise. */
  const sendComposer = () => {
    if (selectedId) sendToSelected();
    else startTask();
  };

  const greeting = `我们该在 ${projectName} 中做什么？`;

  return (
    <div className="agent-window">
      <AgentWindowSidebar
        context={context}
        records={records}
        statuses={statuses}
        selectedId={selectedId}
        setSelectedId={setSelectedId}
        newConversation={newConversation}
        openSettings={openSettings}
        onClearError={() => setStartError(null)}
        commitRename={commitRename}
        deleteConversation={deleteConversation}
      />

      <div className="agent-main">
        <AgentWindowHeader
          selectedTitle={selectedTitle}
          selectedStatus={selectedStatus}
          context={context}
          selectedRunning={selectedRunning}
          selectedPauseReason={selectedPauseReason}
        />

        {selectedId ? (
          <AgentWindowThread
            thread={thread}
            selectedId={selectedId}
            selectedStatus={selectedStatus}
            selectedRunning={selectedRunning}
            selectedSuspended={selectedSuspended}
            selectedPauseReason={selectedPauseReason}
            selectedNoContinue={selectedNoContinue}
            contextCompactionPaused={selectedPauseReason === 'context_compaction_required'}
            switchDir={switchDir}
            pendingQueue={pendingQueue}
            waiting={waiting}
            anyRunning={anyRunning}
            startError={startError}
            continueSelected={continueSelected}
            pauseTask={pauseTask}
            openSettings={openSettings}
            deleteConversation={deleteConversation}
          />
        ) : (
          <AgentWindowWelcome
            greeting={greeting}
            startError={startError}
            needsCredentialSetup={needsCredentialSetup}
            openSettings={openSettings}
          />
        )}
        <AgentWindowComposer
          settings={settings}
          images={images}
          mentions={mentions}
          selectedId={selectedId}
          selectedRunning={selectedRunning}
          selectedNoContinue={selectedNoContinue}
          anyRunning={anyRunning}
          context={context}
          projectName={projectName}
          draft={draft}
          fullAccess={fullAccess}
          setFullAccess={setFullAccess}
          pendingStartId={pendingStartId}
          supplementSending={supplementSending}
          canAttachImage={canAttachImage}
          sendComposer={sendComposer}
          cancelTask={cancelTask}
        />
      </div>
    </div>
  );
};

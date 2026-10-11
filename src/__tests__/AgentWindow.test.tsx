/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProjectAgentProjectContext,
  ProjectAgentStartResultPayload,
  ProjectAgentTaskStatusPayload,
} from '../api/types/project-agent-ipc';
import type { ProjectAgentJournalRecord } from '../services/project-agent/ProjectAgentJournal';
import { AgentWindow } from '../AgentWindow';

const mocks = vi.hoisted(() => {
  let statusHandler: ((status: ProjectAgentTaskStatusPayload) => void) | null = null;
  let contextHandler: ((context: ProjectAgentProjectContext) => void) | null = null;
  let startResultHandler: ((payload: ProjectAgentStartResultPayload) => void) | null = null;
  return {
    emitted: [] as ProjectAgentTaskStatusPayload[],
    sendSupplement: vi.fn(async () => ({ ok: true })),
    requestStart: vi.fn((payload: { requestId?: string }) => {
      if (payload.requestId && startResultHandler) {
        startResultHandler({ requestId: payload.requestId, ok: true });
      }
      return Promise.resolve({ ok: true });
    }),
    requestPause: vi.fn(async () => ({ ok: true })),
    requestCancel: vi.fn(async () => ({ ok: true })),
    requestContinue: vi.fn(async () => ({ ok: true })),
    switchConversation: vi.fn(async () => ({ ok: true })),
    deleteConversation: vi.fn(async () => ({ ok: true, deleted: true })),
    renameConversation: vi.fn(async () => ({ ok: true, title: 'renamed' })),
    getTaskStatus: vi.fn(async (): Promise<ProjectAgentTaskStatusPayload | null> => null),
    getProjectContext: vi.fn(async (): Promise<ProjectAgentProjectContext | null> => null),
    journalListByProject: vi.fn(async (): Promise<ProjectAgentJournalRecord[]> => []),
    setAgentModel: vi.fn(async () => ({ ok: true })),
    setEffort: vi.fn(async () => ({ ok: true })),
    requestOpenSettings: vi.fn(async () => ({ ok: true })),
    listModels: vi.fn(async () => ({ success: true, models: ['gpt-4o', 'gpt-4o-mini'] })),
    readDir: vi.fn(async () => ({
      success: true,
      data: [
        { name: 'scene.json', isDirectory: false, isSymbolicLink: false, path: '/proj/scene.json' },
        { name: 'figure', isDirectory: true, isSymbolicLink: false, path: '/proj/figure' },
      ],
    })),
    publish(status: ProjectAgentTaskStatusPayload) {
      mocks.emitted.push(status);
      // The component handler mutates React state, so it must run inside
      // act() even when tests publish straight from the test body; this keeps
      // the async UI tests deterministic and free of act() warnings.
      act(() => statusHandler?.(status));
    },
    setHandler(handler: ((status: ProjectAgentTaskStatusPayload) => void) | null) {
      statusHandler = handler;
    },
    publishContext(context: ProjectAgentProjectContext) {
      contextHandler?.(context);
    },
    setContextHandler(handler: ((context: ProjectAgentProjectContext) => void) | null) {
      contextHandler = handler;
    },
    publishStartResult(payload: ProjectAgentStartResultPayload) {
      startResultHandler?.(payload);
    },
    setStartResultHandler(handler: ((payload: ProjectAgentStartResultPayload) => void) | null) {
      startResultHandler = handler;
    },
  };
});

function status(overrides: Partial<ProjectAgentTaskStatusPayload> = {}): ProjectAgentTaskStatusPayload {
  return {
    projectId: 'project-1',
    taskId: 'task-1',
    lifecycle: 'running',
    phase: 'model_request',
    originalTaskText: 'Verify the scene',
    sceneName: 'Main Scene',
    model: 'agent-model',
    endpoint: 'https://provider.test',
    counters: {
      transportRetryCount: 0,
      versionConflictRetryCount: 0,
      successfulRelatedReadCount: 1,
      lastWriteReceiptReturnedToModel: false,
      hasCommittedWrite: false,
      pendingWriteReceiptForModel: false,
    },
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Minimal structurally valid conversation store state (ADR0023): the same
 * shape the journal persists — used to exercise the window's decode fallback.
 */
function conversationBlob(entries: readonly { role: 'user' | 'assistant'; text: string }[]): unknown {
  return {
    storeVersion: 1,
    currentMessageIds: entries.map((_, index) => `m${index}`),
    messages: entries.map((entry, index) => ({
      messageId: `m${index}`,
      message: {
        role: entry.role,
        content: [{ type: 'text', text: entry.text }],
        ...(entry.role === 'assistant' ? { toolCalls: [] } : {}),
      },
    })),
  };
}

function journalRecord(overrides: Partial<ProjectAgentJournalRecord> = {}): ProjectAgentJournalRecord {
  return {
    kind: 'running',
    identity: {
      taskId: 'task-1',
      projectId: 'project-1',
      targetSceneIdentity: 'scene-entry-1:scene-doc-1',
      createdAt: 500,
    },
    lifecycle: 'idle',
    originalTaskText: 'Verify the scene',
    supplements: [],
    counters: {
      transportRetryCount: 0,
      versionConflictRetryCount: 0,
      successfulRelatedReadCount: 0,
      lastWriteReceiptReturnedToModel: false,
      hasCommittedWrite: false,
      pendingWriteReceiptForModel: false,
    },
    fingerprints: {
      journalVersion: 1,
      agentProtocolVersion: 1,
      toolsetVersion: 1,
      registryFingerprint: 'fp',
    },
    committedReceipts: [],
    conversationBlob: conversationBlob([
      { role: 'user', text: 'Verify the scene' },
      { role: 'assistant', text: 'I checked the scene.' },
    ]),
    updatedAt: overrides.identity?.createdAt ?? 500,
    ...overrides,
  } as ProjectAgentJournalRecord;
}

const CONTEXT: ProjectAgentProjectContext = {
  projectId: 'project-1',
  projectName: '杂乱素材',
  sceneName: 'Main Scene',
  projectRoot: '/proj',
};

beforeEach(() => {
  mocks.emitted.length = 0;
  mocks.sendSupplement.mockClear();
  mocks.requestStart.mockClear();
  mocks.requestPause.mockClear();
  mocks.requestCancel.mockClear();
  mocks.requestContinue.mockClear();
  mocks.switchConversation.mockClear();
  mocks.deleteConversation.mockClear();
  mocks.renameConversation.mockClear();
  mocks.getTaskStatus.mockClear();
  mocks.getTaskStatus.mockResolvedValue(null);
  mocks.getProjectContext.mockClear();
  mocks.getProjectContext.mockResolvedValue(null);
  mocks.journalListByProject.mockClear();
  mocks.journalListByProject.mockResolvedValue([]);
  mocks.setAgentModel.mockClear();
  mocks.setEffort.mockClear();
  mocks.requestOpenSettings.mockClear();
  // mockClear preserves implementations, so restore defaults for tests that override these fixtures.
  mocks.listModels.mockClear();
  mocks.listModels.mockResolvedValue({ success: true, models: ['gpt-4o', 'gpt-4o-mini'] });
  mocks.readDir.mockClear();
  mocks.readDir.mockResolvedValue({
    success: true,
    data: [
      { name: 'scene.json', isDirectory: false, isSymbolicLink: false, path: '/proj/scene.json' },
      { name: 'figure', isDirectory: true, isSymbolicLink: false, path: '/proj/figure' },
    ],
  });
  mocks.setHandler(null);
  mocks.setContextHandler(null);
  mocks.setStartResultHandler(null);
  localStorage.clear();
  localStorage.setItem('aeonstagery_settings', JSON.stringify({
    theme: 'system',
    aiProse: { baseUrl: 'https://provider.test', defaultModel: 'gpt-default', projectAgentModel: 'agent-model' },
  }));
  Object.defineProperty(window, 'aeonStageryAPI', {
    configurable: true,
    value: {
      projectAgent: {
        getTaskStatus: mocks.getTaskStatus,
        onStatus: (handler: (status: ProjectAgentTaskStatusPayload) => void) => {
          mocks.setHandler(handler);
          return () => mocks.setHandler(null);
        },
        getProjectContext: mocks.getProjectContext,
        onContext: (handler: (context: ProjectAgentProjectContext) => void) => {
          mocks.setContextHandler(handler);
          return () => mocks.setContextHandler(null);
        },
        onStartResult: (handler: (payload: ProjectAgentStartResultPayload) => void) => {
          mocks.setStartResultHandler(handler);
          return () => mocks.setStartResultHandler(null);
        },
        journalListByProject: mocks.journalListByProject,
        sendSupplement: mocks.sendSupplement,
        requestStart: mocks.requestStart,
        requestPause: mocks.requestPause,
        requestCancel: mocks.requestCancel,
        requestContinue: mocks.requestContinue,
        switchConversation: mocks.switchConversation,
        deleteConversation: mocks.deleteConversation,
        renameConversation: mocks.renameConversation,
        setAgentModel: mocks.setAgentModel,
        setEffort: mocks.setEffort,
        requestOpenSettings: mocks.requestOpenSettings,
      },
      aiProse: {
        listModels: mocks.listModels,
      },
      fs: {
        readDir: mocks.readDir,
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Mount with a conversation record + context so the thread surface shows. */
async function renderWithConversation(record?: ProjectAgentJournalRecord) {
  mocks.journalListByProject.mockResolvedValue([record ?? journalRecord()]);
  mocks.getProjectContext.mockResolvedValue(CONTEXT);
  // Settle context loading, journal loading, selection and its reset effects
  // before tests publish statuses or interact with the selected conversation.
  await act(async () => {
    render(<AgentWindow />);
  });
  return {
    pushStatus: (next: ProjectAgentTaskStatusPayload) => act(() => mocks.publish(next)),
  };
}

describe('AgentWindow conversation thread', () => {
  it('shows the conversation title, scene and running badge when a status arrives', async () => {
    await renderWithConversation();
    mocks.publish(status());
    expect(await screen.findAllByText('Verify the scene')).not.toHaveLength(0);
    expect(screen.getAllByText('Main Scene').length).toBeGreaterThanOrEqual(1);
    // 「运行中」 appears in the header badge and in the in-flow turn status line.
    // Await it: the sidebar list renders a tick before the active-conversation
    // auto-select effect finishes, so the running badge may not be present yet.
    expect(await screen.findAllByText('运行中')).not.toHaveLength(0);
  });

  it('renders user messages as bubbles and assistant replies directly on the page', async () => {
    await renderWithConversation(journalRecord({
      conversationBlob: conversationBlob([
        { role: 'user', text: '请检查场景' },
        { role: 'assistant', text: '已检查，场景没有语义错误。' },
        { role: 'user', text: '再确认一下资源' },
      ]),
    }));
    mocks.publish(status({ lifecycle: 'idle', phase: 'settled' }));
    expect(await screen.findByText('请检查场景')).toBeTruthy();
    expect(screen.getByText('已检查，场景没有语义错误。')).toBeTruthy();
    expect(screen.getByText('再确认一下资源')).toBeTruthy();
    const assistant = screen.getByText('已检查，场景没有语义错误。').closest('.agent-log__assistant');
    expect(assistant).not.toBeNull();
    expect(assistant!.querySelector('.agent-window__bubble--user')).toBeNull();
  });

  it('interleaves tool activities at their chronological flow position', async () => {
    await renderWithConversation(journalRecord({
      conversationBlob: conversationBlob([
        { role: 'user', text: '检查背景资源' },
        { role: 'assistant', text: '背景资源已就绪。' },
      ]),
    }));
    mocks.publish(status({
      lifecycle: 'idle',
      phase: 'settled',
      flow: [
        { kind: 'user', text: '检查背景资源' },
        { kind: 'tool', name: 'readScene', toolCallId: 'c1' },
        { kind: 'tool', name: 'searchResources', toolCallId: 'c2' },
        { kind: 'assistant', text: '背景资源已就绪。' },
      ],
      activities: [
        { kind: 'read', toolName: 'readScene', text: '读取 scene', detail: 'L1~L1 · 1 行' },
        { kind: 'read', toolName: 'searchResources', text: '搜索资源', detail: 'text=森林' },
      ],
    }));
    const answer = await screen.findByText('背景资源已就绪。');
    const activity = screen.getByText(/搜索资源/);
    const thread = answer.closest('.agent-window__thread');
    expect(thread).not.toBeNull();
    // The tool rows sit between the user message and the reply — not sunk below.
    const userIndex = [...thread!.children].indexOf(
      screen.getByText('检查背景资源').closest('.agent-window__msg--user')!,
    );
    const toolsIndex = [...thread!.children].indexOf(activity.closest('.agent-tools')!);
    const answerIndex = [...thread!.children].indexOf(answer.closest('.agent-log__assistant')!);
    expect(userIndex).toBeGreaterThan(-1);
    expect(toolsIndex).toBeGreaterThan(userIndex);
    expect(answerIndex).toBeGreaterThan(toolsIndex);
    expect(activity.closest('.agent-tools')).not.toBeNull();
  });

  it('keeps tool anchors matched to their own activities after a context compaction', async () => {
    await renderWithConversation();
    mocks.publish(status({
      lifecycle: 'idle',
      phase: 'settled',
      flow: [
        { kind: 'user', text: '继续' },
        { kind: 'tool', name: 'readScene', toolCallId: 'new-1' },
        { kind: 'tool', name: 'searchResources', toolCallId: 'new-2' },
        { kind: 'assistant', text: '完成。' },
      ],
      // The compaction replaced the old tool messages, so old-1 has no anchor
      // and the compaction activity has no tool message at all — only the
      // new round's activities can bind to the post-compaction anchors.
      activities: [
        { kind: 'read', toolName: 'readProjectOverview', text: '读取项目概览', toolCallId: 'old-1' },
        { kind: 'context_compaction', toolName: 'compactContext', text: '上下文已压缩' },
        { kind: 'read', toolName: 'readScene', text: '读取 scene', toolCallId: 'new-1' },
        { kind: 'read', toolName: 'searchResources', text: '搜索资源', toolCallId: 'new-2' },
      ],
    }));
    const answer = await screen.findByText('完成。');
    const thread = answer.closest('.agent-window__thread')!;
    // The post-compaction round's rows render in-thread at their anchors…
    const userIndex = [...thread.children].indexOf(
      screen.getByText('继续').closest('.agent-window__msg--user')!,
    );
    const readRow = screen.getByText('读取 scene').closest('.agent-log__activity')!;
    const toolsIndex = [...thread.children].indexOf(readRow.closest('.agent-tools')!);
    const answerIndex = [...thread.children].indexOf(answer.closest('.agent-log__assistant')!);
    expect(userIndex).toBeGreaterThan(-1);
    expect(toolsIndex).toBeGreaterThan(userIndex);
    expect(answerIndex).toBeGreaterThan(toolsIndex);
    // …showing their OWN activities — the compaction can never mislabel them.
    expect(readRow.textContent).toContain('读取 scene');
    expect(readRow.textContent).not.toContain('读取项目概览');
    expect(screen.getByText('搜索资源').closest('.agent-log__activity')!.textContent)
      .not.toContain('上下文已压缩');
    // Unanchored activities (the pre-compaction history and the compaction
    // itself) render as independent rows in the tail block, not squeezed
    // into later tool anchors.
    const tail = screen.getByText('上下文已压缩').closest('.agent-tools--tail')!;
    expect(tail.textContent).toContain('读取项目概览');
    expect(tail.textContent).toContain('上下文已压缩');
  });

  it('renders tool activities directly on the page, without bubbles', async () => {
    await renderWithConversation();
    mocks.publish(status({
      lifecycle: 'idle',
      phase: 'settled',
      activities: [
        { kind: 'read', toolName: 'readScene', text: '读取 scene' },
        { kind: 'write', toolName: 'insertStatement', text: '已提交 2 处修改' },
      ],
    }));
    expect(await screen.findByText('读取 scene')).toBeTruthy();
    expect(screen.getByText('已提交 2 处修改')).toBeTruthy();
    const activity = screen.getByText('读取 scene').closest('.agent-log__activity');
    expect(activity).not.toBeNull();
    expect(activity!.querySelector('.agent-window__bubble--user')).toBeNull();
  });

  it('decodes the conversation log from the journal record when no live status exists', async () => {
    await renderWithConversation(journalRecord({
      lifecycle: 'suspended',
      conversationBlob: conversationBlob([
        { role: 'user', text: '历史问题' },
        { role: 'assistant', text: '历史回答' },
      ]),
      activities: [{ kind: 'read', toolName: 'readScene', text: '读取 scene' }],
    }));
    expect(await screen.findByText('历史问题')).toBeTruthy();
    expect(screen.getByText('历史回答')).toBeTruthy();
    expect(screen.getByText('读取 scene')).toBeTruthy();
  });

  it('shows undelivered supplements from the record as queued bubbles', async () => {
    await renderWithConversation(journalRecord({
      supplements: [
        { id: 's1', text: '排队中的补充', enqueuedAt: 1000, deliveredToModel: false },
      ],
    }));
    mocks.publish(status());
    expect(await screen.findByText('排队中的补充')).toBeTruthy();
    expect(screen.queryByText('排队中')).toBeNull();
  });

  it('hides host-injected recovery notes decoded from the journal record', async () => {
    await renderWithConversation(journalRecord({
      conversationBlob: conversationBlob([
        { role: 'user', text: '请检查场景' },
        { role: 'assistant', text: '已检查。' },
        {
          role: 'user',
          text: 'Host recovery note: the task was paused (user_requested). No in-flight assistant round was discarded.',
        },
        { role: 'user', text: '继续之前的工作' },
      ]),
    }));
    mocks.publish(status({ lifecycle: 'idle', phase: 'settled' }));
    expect(await screen.findByText('继续之前的工作')).toBeTruthy();
    expect(screen.getByText('请检查场景')).toBeTruthy();
    expect(screen.queryByText(/Host recovery note/)).toBeNull();
  });

  it('hides host-injected recovery notes from a live status flow', async () => {
    await renderWithConversation();
    mocks.publish(status({
      lifecycle: 'idle',
      phase: 'settled',
      flow: [
        { kind: 'user', text: 'Verify the scene' },
        { kind: 'assistant', text: 'I checked the scene.' },
        {
          kind: 'user',
          text: 'Host recovery note: the task was paused (user_requested). No in-flight assistant round was discarded.',
        },
        { kind: 'user', text: '再确认资源' },
      ],
    }));
    expect(await screen.findByText('再确认资源')).toBeTruthy();
    expect(screen.getByText('I checked the scene.')).toBeTruthy();
    expect(screen.queryByText(/Host recovery note/)).toBeNull();
  });

  it('does not duplicate a message already visible in the live flow from a stale record supplement', async () => {
    await renderWithConversation(journalRecord({
      supplements: [
        { id: 's1', text: '继续之前的工作', enqueuedAt: 1000, deliveredToModel: false },
      ],
    }));
    mocks.publish(status({
      lifecycle: 'running',
      phase: 'model_request',
      flow: [
        { kind: 'user', text: 'Verify the scene' },
        { kind: 'user', text: '继续之前的工作' },
      ],
    }));
    expect(await screen.findByText('继续之前的工作')).toBeTruthy();
    expect(screen.getAllByText('继续之前的工作')).toHaveLength(1);
    expect(screen.queryByText('排队中')).toBeNull();
  });

  it('removes the pending queued bubble once the message appears in the flow', async () => {
    await renderWithConversation();
    mocks.publish(status({ lifecycle: 'idle', phase: 'settled' }));
    mocks.getTaskStatus.mockImplementation(async () => status({
      lifecycle: 'idle',
      phase: 'settled',
      updatedAt: Date.now(),
    }));
    const composerPlaceholder = /继续输入/;
    await screen.findByPlaceholderText(composerPlaceholder);
    // Initial conversation selection can replace the composer after findBy resolves.
    fireEvent.change(screen.getByPlaceholderText(composerPlaceholder), {
      target: { value: 'read the assets' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText(composerPlaceholder), { key: 'Enter' });
    await waitFor(() => {
      expect(mocks.sendSupplement).toHaveBeenCalledWith('task-1', 'read the assets');
    });
    // The optimistic bubble shows exactly once as a clean user bubble while delivery
    // is pending — the sent text must not render twice and has no queue tag.
    expect(await screen.findAllByText('read the assets')).toHaveLength(1);
    expect(screen.queryByText('排队中')).toBeNull();
    // Delivery lands: the live flow now contains the user message, so the
    // pending bubble is reconciled away and only the normal bubble remains.
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'running',
        phase: 'model_request',
        flow: [
          { kind: 'user', text: 'Verify the scene' },
          { kind: 'user', text: 'read the assets' },
        ],
      }));
    });
    await waitFor(() => {
      expect(screen.queryByText('排队中')).toBeNull();
    });
    expect(screen.getAllByText('read the assets')).toHaveLength(1);
  });

  it('scopes pending queued bubbles to the conversation the prompt was sent to', async () => {
    mocks.journalListByProject.mockResolvedValue([
      journalRecord(),
      journalRecord({
        identity: { taskId: 'task-2', projectId: 'project-1', targetSceneIdentity: 's', createdAt: 400 },
        originalTaskText: '另一个对话',
        lifecycle: 'idle',
        conversationBlob: conversationBlob([{ role: 'user', text: '另一个对话' }]),
      } as ProjectAgentJournalRecord),
    ]);
    mocks.getProjectContext.mockResolvedValue(CONTEXT);
    render(<AgentWindow />);
    mocks.publish(status({ lifecycle: 'idle', phase: 'settled' }));
    mocks.getTaskStatus.mockImplementation(async () => status({
      lifecycle: 'idle',
      phase: 'settled',
      updatedAt: Date.now(),
    }));
    const composerPlaceholder = /继续输入/;
    await screen.findByPlaceholderText(composerPlaceholder);
    // Initial conversation selection can replace the composer after findBy resolves.
    fireEvent.change(screen.getByPlaceholderText(composerPlaceholder), {
      target: { value: 'read the assets' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText(composerPlaceholder), { key: 'Enter' });
    await waitFor(() => {
      expect(mocks.sendSupplement).toHaveBeenCalledWith('task-1', 'read the assets');
    });
    expect(await screen.findAllByText('read the assets')).toHaveLength(1);
    expect(screen.queryByText('排队中')).toBeNull();
    // Switching to the other conversation hides the pending bubble.
    fireEvent.click(screen.getByRole('button', { name: /另一个对话/ }));
    await waitFor(() => {
      expect(screen.queryByText('read the assets')).toBeNull();
    });
    // Switching back restores it while the message is still undelivered.
    fireEvent.click(screen.getByRole('button', { name: /Verify the scene/ }));
    await waitFor(() => {
      expect(screen.getAllByText('read the assets')).toHaveLength(1);
    });
  });

  it('shows the running status strip with phase, model and read count', async () => {
    await renderWithConversation();
    mocks.publish(status({ lifecycle: 'running', phase: 'tools_executed' }));
    expect(await screen.findByText('工具执行完成')).toBeTruthy();
    expect(screen.getAllByText('agent-model').length).toBeGreaterThan(0);
    expect(screen.getByText('成功读取 1')).toBeTruthy();
  });

  it('counts terminal command success separately from related reads in the status strip', async () => {
    await renderWithConversation();
    mocks.publish(status({
      lifecycle: 'running',
      phase: 'tools_executed',
      counters: {
        transportRetryCount: 0,
        versionConflictRetryCount: 0,
        successfulRelatedReadCount: 0,
        successfulTerminalCommandCount: 1,
        lastWriteReceiptReturnedToModel: false,
        hasCommittedWrite: false,
        pendingWriteReceiptForModel: false,
      },
    }));
    expect(await screen.findByText('成功读取 0')).toBeTruthy();
    // The terminal success shows on its own counter — never as 「成功读取」.
    expect(screen.getByText('命令 1')).toBeTruthy();
    expect(screen.queryByText('成功读取 1')).toBeNull();
  });

  it('keeps the ended-round status line when reopening from the journal record', async () => {
    await renderWithConversation(journalRecord({
      lifecycle: 'idle',
      lastSettledRound: { startedAt: 0, endedAt: 12_500, kind: 'settled' },
      conversationBlob: conversationBlob([
        { role: 'user', text: '检查场景' },
        { role: 'assistant', text: '检查完成。' },
      ]),
    }));
    expect(await screen.findByText('已完成')).toBeTruthy();
    expect(screen.getByText(/12\.5s/)).toBeTruthy();
  });

  it('shows connection then elapsed model work, and clears the timer outside model requests', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderWithConversation();
      const startedAt = Date.now();
      await act(async () => {
        mocks.publish(status({
          phase: 'model_request',
          modelProgress: { phase: 'connecting', startedAt },
        }));
      });
      expect(await screen.findByText('正在连接')).toBeTruthy();

      await act(async () => {
        mocks.publish(status({
          phase: 'model_request',
          modelProgress: { phase: 'working', startedAt },
        }));
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(screen.getByText('正在工作（20 秒）')).toBeTruthy();

      await act(async () => {
        mocks.publish(status({ lifecycle: 'running', phase: 'tools_executed' }));
      });
      expect(screen.queryByText(/正在工作（/)).toBeNull();
      expect(screen.getByText('工具执行完成')).toBeTruthy();

      await act(async () => {
        mocks.publish(status({
          lifecycle: 'running',
          phase: 'tools_executed',
          toolProgress: { phase: 'reading', toolName: 'readScene' },
          updatedAt: Date.now() + 1,
        }));
      });
      // The in-flight tool renders as a live row with its display name and phase label.
      expect(screen.getByText('正在读取')).toBeTruthy();
      expect(screen.getByText('读取 scene').closest('.agent-log__activity--live')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the settled turn status with its duration after the round completes', async () => {
    await renderWithConversation();
    const startedAt = Date.now() - 12_000;
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'running',
        phase: 'model_request',
        modelProgress: { phase: 'working', startedAt },
      }));
    });
    expect(await screen.findByText('正在工作（12 秒）')).toBeTruthy();
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'idle',
        phase: 'settled',
        updatedAt: startedAt + 12_500,
      }));
    });
    expect(await screen.findByText('已完成')).toBeTruthy();
    expect(screen.getByText(/12\.5s/)).toBeTruthy();
  });

  it('shows the failed turn state with the provider detail on a provider suspension', async () => {
    await renderWithConversation();
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'suspended',
        phase: 'suspended',
        suspensionReason: 'provider_configuration_required',
        providerDetail: { code: 'invalid_api_key', status: 401, message: 'API key 无效' },
      }));
    });
    expect(await screen.findByText('失败')).toBeTruthy();
    expect(screen.getByText(/invalid_api_key/)).toBeTruthy();
    expect(screen.getByText(/API key 无效/)).toBeTruthy();
  });

  it('collapses and expands the collapsible tool group', async () => {
    await renderWithConversation();
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'idle',
        phase: 'settled',
        flow: [
          { kind: 'user', text: '检查资源' },
          { kind: 'tool', name: 'readScene', toolCallId: 'c1' },
          { kind: 'assistant', text: '已检查。' },
        ],
        activities: [
          { kind: 'read', toolName: 'readScene', text: '读取 scene', detail: 'L1~L1 · 1 行' },
        ],
      }));
    });
    expect(await screen.findByText('读取 scene')).toBeTruthy();
    const trigger = screen.getByRole('button', { name: /工具/ });
    fireEvent.click(trigger);
    expect(screen.queryByText('读取 scene')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText('读取 scene')).toBeTruthy();
  });

  it('collapses only the clicked tool group and leaves other groups expanded', async () => {
    await renderWithConversation();
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'idle',
        phase: 'settled',
        flow: [
          { kind: 'user', text: '第一轮' },
          { kind: 'tool', name: 'readScene', toolCallId: 'c1' },
          { kind: 'assistant', text: '第一轮完成。' },
          { kind: 'user', text: '第二轮' },
          { kind: 'tool', name: 'searchResources', toolCallId: 'c2' },
          { kind: 'assistant', text: '第二轮完成。' },
        ],
        activities: [
          { kind: 'read', toolName: 'readScene', text: '读取 scene' },
          { kind: 'read', toolName: 'searchResources', text: '搜索资源' },
        ],
      }));
    });
    expect(await screen.findByText('读取 scene')).toBeTruthy();
    expect(screen.getByText('搜索资源')).toBeTruthy();
    const triggers = screen.getAllByRole('button', { name: /工具/ });
    expect(triggers).toHaveLength(2);
    expect(triggers[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(triggers[1]!.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(triggers[0]!);
    expect(triggers[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(triggers[1]!.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText('读取 scene')).toBeNull();
    expect(screen.getByText('搜索资源')).toBeTruthy();
    fireEvent.click(triggers[0]!);
    expect(screen.getByText('读取 scene')).toBeTruthy();
    expect(screen.getByText('搜索资源')).toBeTruthy();
  });

  it('renders legacy json activity content as readable lines instead of raw JSON', async () => {
    await renderWithConversation();
    mocks.publish(status({
      lifecycle: 'idle',
      phase: 'settled',
      activities: [{
        kind: 'read',
        toolName: 'searchProjectText',
        text: '搜索项目文本',
        details: {
          content: {
            format: 'json',
            text: JSON.stringify({
              hits: [{ path: 'scenes/main.scene.json', line: 12, text: '台词' }],
              total: 1,
            }),
            truncated: false,
          },
          safe: true,
        },
      }],
    }));
    const activity = await screen.findByRole('button', { name: /搜索项目文本/ });
    expect(screen.queryByText(/"hits"/)).toBeNull();
    fireEvent.click(activity);
    expect(screen.getByText(/#1 path: scenes\/main\.scene\.json/)).toBeTruthy();
    expect(screen.getByText(/#1 text: 台词/)).toBeTruthy();
    expect(screen.queryByText(/"hits"/)).toBeNull();
  });

  it('shows the think disclosure for reasoning content and toggles it', async () => {
    await renderWithConversation();
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'idle',
        phase: 'settled',
        flow: [
          { kind: 'user', text: '检查场景' },
          { kind: 'assistant', text: '检查完成。', reasoningContent: '先读取 scene，再比对资源。' },
        ],
      }));
    });
    const trigger = await screen.findByRole('button', { name: /思考/ });
    expect(screen.queryByText('先读取 scene，再比对资源。')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText('先读取 scene，再比对资源。')).toBeTruthy();
  });

  it('shows the reply placeholder while running and replaces it with the final reply', async () => {
    await renderWithConversation();
    await act(async () => {
      mocks.publish(status({ lifecycle: 'running', phase: 'model_request' }));
    });
    expect(await screen.findByText('正在回复…')).toBeTruthy();
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'running',
        phase: 'assistant_reply',
        updatedAt: Date.now() + 1000,
        flow: [
          { kind: 'user', text: 'Verify the scene' },
          { kind: 'assistant', text: '已完成检查。' },
        ],
      }));
    });
    expect(await screen.findByText('已完成检查。')).toBeTruthy();
    expect(screen.queryByText('正在回复…')).toBeNull();
  });

  it('streams live assistant text while the model works and hands off to the final reply', async () => {
    await renderWithConversation();
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'running',
        phase: 'model_request',
        updatedAt: Date.now() + 100,
        modelProgress: { phase: 'working', startedAt: Date.now(), deltaText: '正在完成场景检查' },
      }));
    });
    expect(await screen.findByText(/正在完成场景检查/)).toBeTruthy();
    expect(screen.queryByText('正在回复…')).toBeNull();
    expect(document.querySelector('.agent-reply-streaming__caret')).toBeTruthy();

    // The next throttled publish grows the same streaming block.
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'running',
        phase: 'model_request',
        updatedAt: Date.now() + 200,
        modelProgress: { phase: 'working', startedAt: Date.now(), deltaText: '正在完成场景检查，并写入表演占位。' },
      }));
    });
    expect(await screen.findByText(/并写入表演占位/)).toBeTruthy();

    // The completed round settles: the flow's final reply replaces the live
    // card in the same seat — no duplicated text, no stale caret.
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'idle',
        phase: 'settled',
        updatedAt: Date.now() + 300,
        flow: [
          { kind: 'user', text: 'Verify the scene' },
          { kind: 'assistant', text: '正在完成场景检查，并写入表演占位。' },
        ],
      }));
    });
    expect(await screen.findByText('正在完成场景检查，并写入表演占位。')).toBeTruthy();
    expect(document.querySelector('.agent-reply-streaming')).toBeNull();
  });

  it('streams live reasoning into the think disclosure while running', async () => {
    await renderWithConversation();
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'running',
        phase: 'model_request',
        updatedAt: Date.now() + 100,
        modelProgress: { phase: 'working', startedAt: Date.now(), reasoningDeltaText: '先读取 scene 再比对资源' },
      }));
    });
    const trigger = await screen.findByRole('button', { name: /思考/ });
    expect(screen.queryByText('先读取 scene 再比对资源')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText('先读取 scene 再比对资源')).toBeTruthy();
  });

  it('hides the live stream when the phase leaves the model exchange (tool progress)', async () => {
    await renderWithConversation();
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'running',
        phase: 'model_request',
        updatedAt: Date.now() + 100,
        modelProgress: { phase: 'working', startedAt: Date.now(), deltaText: '已想好方案' },
      }));
    });
    expect(await screen.findByText(/已想好方案/)).toBeTruthy();
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'running',
        phase: 'tools_executed',
        updatedAt: Date.now() + 200,
        toolProgress: { phase: 'reading', toolName: 'readScene' },
      }));
    });
    expect(await screen.findByText(/读取 scene/)).toBeTruthy();
    expect(document.querySelector('.agent-reply-streaming')).toBeNull();
  });

  it('does not surface redundant idle state hints', async () => {
    await renderWithConversation();
    await act(async () => {
      mocks.publish(status({ lifecycle: 'idle', phase: 'settled' }));
    });
    await screen.findAllByText('Verify the scene');
    expect(screen.queryByText('可输入')).toBeNull();
    expect(screen.queryByText('已就绪，可以继续输入。')).toBeNull();
  });

  it('shows the back-to-bottom chip when the user scrolls up during a run', async () => {
    await renderWithConversation();
    await act(async () => {
      mocks.publish(status({ lifecycle: 'running', phase: 'model_request' }));
    });
    await screen.findByText(/正在回复/);
    const thread = screen.getByRole('log');
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 300 });
    thread.scrollTop = 500;
    fireEvent.scroll(thread);
    const chip = await screen.findByRole('button', { name: /回到底部/ });
    fireEvent.click(chip);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /回到底部/ })).toBeNull();
    });
  });

  it('detaches auto-scroll immediately when user wheels up, even within 64px from bottom', async () => {
    await renderWithConversation();
    await act(async () => {
      mocks.publish(status({ lifecycle: 'running', phase: 'model_request' }));
    });
    await screen.findByText(/正在回复/);
    const thread = screen.getByRole('log');
    const scrollToSpy = vi.fn();
    thread.scrollTo = scrollToSpy;
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 300 });

    thread.scrollTop = 700;
    fireEvent.wheel(thread, { deltaY: -30 });
    thread.scrollTop = 670;
    fireEvent.scroll(thread);

    scrollToSpy.mockClear();

    await act(async () => {
      mocks.publish(status({
        lifecycle: 'running',
        phase: 'model_request',
        updatedAt: Date.now() + 50,
        modelProgress: {
          phase: 'working',
          startedAt: Date.now() - 1000,
          deltaText: 'chunk 1',
        },
      }));
    });

    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /回到底部/ })).toBeTruthy();
  });

  it('does not auto-scroll to bottom or collapse activities when records update for the same conversation while scrolled up', async () => {
    const record = journalRecord();
    mocks.journalListByProject.mockResolvedValue([record]);
    await renderWithConversation(record);
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'running',
        phase: 'model_request',
        activities: [
          {
            kind: 'read',
            toolName: 'searchProjectText',
            text: '搜索项目文本',
            details: { paths: ['scenes/main.scene.json'], query: '森林', matches: 1 },
          },
        ],
      }));
    });
    await screen.findByText('搜索项目文本');
    const thread = screen.getByRole('log');
    const scrollToSpy = vi.fn();
    thread.scrollTo = scrollToSpy;
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 300 });

    thread.scrollTop = 500;
    fireEvent.scroll(thread);
    expect(await screen.findByRole('button', { name: /回到底部/ })).toBeTruthy();

    const activityBtn = screen.getByRole('button', { name: /搜索项目文本/ });
    fireEvent.click(activityBtn);
    expect(activityBtn.getAttribute('aria-expanded')).toBe('true');

    scrollToSpy.mockClear();

    // Publish a status from an unknown task id to trigger setListRefreshKey and reload records
    const updatedRecord = { ...record, updatedAt: Date.now() + 100 };
    mocks.journalListByProject.mockResolvedValue([updatedRecord]);
    await act(async () => {
      mocks.publish(status({
        taskId: 'new-task-triggering-refresh',
        lifecycle: 'idle',
        phase: 'settled',
        updatedAt: Date.now() + 100,
      }));
    });

    // Wait for list refresh to settle
    await waitFor(() => {
      expect(mocks.journalListByProject).toHaveBeenCalled();
    });

    // Activities must not be collapsed!
    expect(activityBtn.getAttribute('aria-expanded')).toBe('true');
    // Scroll to bottom must not be triggered!
    expect(scrollToSpy).not.toHaveBeenCalled();
    // Back to bottom button must still be present!
    expect(screen.queryByRole('button', { name: /回到底部/ })).not.toBeNull();
  });

  it('expands structured activity facts and leaves old activities as static text', async () => {
    await renderWithConversation();
    mocks.publish(status({
      lifecycle: 'idle',
      phase: 'settled',
      activities: [
        { kind: 'read', toolName: 'readScene', text: '读取 scene' },
        {
          kind: 'read',
          toolName: 'searchProjectText',
          text: '搜索项目文本',
          details: {
            paths: ['scenes/main.scene.json'],
            query: '森林',
            matches: 1,
            safe: true,
          },
        },
      ],
    }));
    expect(await screen.findByText('读取 scene')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '读取 scene' })).toBeNull();

    const activityName = /搜索项目文本/;
    expect(screen.getByRole('button', { name: activityName }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: activityName }));
    expect(screen.getByRole('button', { name: /搜索项目文本/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('条件 森林')).toBeTruthy();
    expect(screen.getByText('路径 scenes/main.scene.json')).toBeTruthy();
    expect(screen.getByText('安全摘要')).toBeTruthy();
  });

  it('expands a read activity to the actual content returned by the tool', async () => {
    await renderWithConversation();
    mocks.publish(status({
      lifecycle: 'idle',
      phase: 'settled',
      activities: [{
        kind: 'read',
        toolName: 'readProjectText',
        text: '读取文件',
        detail: 'docs/scene-notes.md · 2 行',
        details: {
          content: {
            format: 'text',
            text: '第一行：角色走到窗边。\n第二行：雨声渐强。',
            truncated: false,
          },
          safe: true,
        },
      }],
    }));

    const activity = await screen.findByRole('button', { name: /读取文件/ });
    expect(screen.queryByText('第一行：角色走到窗边。')).toBeNull();
    fireEvent.click(activity);
    expect(document.querySelector('.agent-log__activity-content')?.textContent).toBe(
      '第一行：角色走到窗边。\n第二行：雨声渐强。',
    );
    expect(screen.queryByText('安全摘要')).toBeNull();
  });

  it('shows the context-used indicator with token usage and percentage', async () => {
    await renderWithConversation();
    mocks.publish(status({
      contextUsed: {
        estimatedTokens: 118000,
        estimatedInputTokens: 117000,
        contextWindow: 262144,
        usageRatio: 0.45,
        actualInputTokens: 116000,
      },
    }));
    const chip = await screen.findByText(/Context used 45% · 116K\/262K/);
    expect(chip).toBeTruthy();
    expect(chip.closest('.agent-window__context-used')).not.toBeNull();
  });

  it('renders a successful context compaction in the activity log', async () => {
    await renderWithConversation();
    mocks.publish(status({
      lifecycle: 'idle',
      phase: 'settled',
      activities: [{
        kind: 'context_compaction',
        toolName: 'compactContext',
        text: '上下文已压缩',
      }],
    }));
    const activity = await screen.findByText('上下文已压缩');
    expect(activity.closest('.agent-log__activity--context-compaction')).not.toBeNull();
  });

  it('does not show the context-used indicator without usage data', async () => {
    await renderWithConversation();
    mocks.publish(status());
    expect(await screen.findAllByText('Verify the scene')).not.toHaveLength(0);
    expect(screen.queryByText(/Context used/)).toBeNull();
  });
});

describe('AgentWindow composer', () => {
  it('keeps one composer seat and card across the welcome and conversation states', () => {
    mocks.journalListByProject.mockResolvedValue([]);
    mocks.getProjectContext.mockResolvedValue(CONTEXT);
    const welcome = render(<AgentWindow />);
    const welcomeWrap = welcome.container.querySelector('.agent-composer-wrap')!;
    expect(welcomeWrap.className).toBe('agent-composer-wrap');
    expect(welcome.container.querySelector('.agent-promptbox')).not.toBeNull();
    cleanup();

    mocks.journalListByProject.mockResolvedValue([journalRecord()]);
    const conv = render(<AgentWindow />);
    const convWrap = conv.container.querySelector('.agent-composer-wrap')!;
    expect(convWrap.className).toBe('agent-composer-wrap');
    expect(conv.container.querySelector('.agent-promptbox')).not.toBeNull();
    cleanup();
  });

  it('sends the supplement text to the running conversation', async () => {
    await renderWithConversation();
    mocks.publish(status());
    const input = await screen.findByPlaceholderText(/追加指令/);
    fireEvent.change(input, { target: { value: 'also verify asset roots' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(mocks.sendSupplement).toHaveBeenCalledWith('task-1', 'also verify asset roots');
    });
  });

  it('replaces stop button with send button when input is non-empty while running, queues at bottom, and reconciles into flow on next turn', async () => {
    await renderWithConversation();
    mocks.publish(status({
      lifecycle: 'running',
      phase: 'model_request',
      flow: [
        { kind: 'user', text: 'Verify the scene' },
        { kind: 'assistant', text: 'Initial reply' },
      ],
      toolProgress: { phase: 'reading', toolName: 'readScene' },
    }));

    const input = await screen.findByPlaceholderText(/追加指令/);
    // When input is empty, the button is "停止生成"
    expect(screen.getByRole('button', { name: /停止生成/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^发送$/i })).toBeNull();

    // Type text into input
    fireEvent.change(input, { target: { value: 'also verify asset roots' } });

    // Now button switches to "发送"
    expect(screen.queryByRole('button', { name: /停止生成/i })).toBeNull();
    const sendBtn = screen.getByRole('button', { name: /^发送$/i });
    expect(sendBtn).toBeTruthy();

    // Click the send button
    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(mocks.sendSupplement).toHaveBeenCalledWith('task-1', 'also verify asset roots');
    });

    // Input is cleared, so button reverts to "停止生成"
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(await screen.findByRole('button', { name: /停止生成/i })).toBeTruthy();

    // Sent supplement is queued and sunk to the bottom with '排队中'
    expect(await screen.findByText('also verify asset roots')).toBeTruthy();
    expect(screen.getByText('排队中')).toBeTruthy();

    // The queued bubble is placed after the turn tail (which contains 'readScene')
    const queuedHint = screen.getByText('排队中');
    const toolElem = screen.getByText(/读取 scene/);
    expect(toolElem.compareDocumentPosition(queuedHint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Agent reaches next tool call / turn and delivers supplement to flow
    await act(async () => {
      mocks.publish(status({
        lifecycle: 'running',
        phase: 'tools_executed',
        flow: [
          { kind: 'user', text: 'Verify the scene' },
          { kind: 'assistant', text: 'Initial reply' },
          { kind: 'user', text: 'also verify asset roots' },
        ],
        toolProgress: { phase: 'reading', toolName: 'readProjectOverview' },
      }));
    });

    // Queued tag disappears and message is now part of regular flow
    await waitFor(() => {
      expect(screen.queryByText('排队中')).toBeNull();
    });
    expect(screen.getAllByText('also verify asset roots')).toHaveLength(1);
    expect(screen.getByText(/读取项目概览/)).toBeTruthy();
  });

  it('starts a new execution round when sending to an idle conversation', async () => {
    await renderWithConversation();
    mocks.publish(status({ lifecycle: 'idle', phase: 'settled' }));
    mocks.getTaskStatus.mockImplementation(async () => status({
      lifecycle: 'idle',
      phase: 'settled',
      updatedAt: Date.now(),
    }));
    const input = await screen.findByPlaceholderText(/继续输入/);
    fireEvent.change(input, { target: { value: 'read the assets' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(mocks.switchConversation).toHaveBeenCalledWith('project-1', 'task-1');
    });
    mocks.getTaskStatus.mockResolvedValue(status({ lifecycle: 'idle', phase: 'settled', updatedAt: Date.now() }));
    await waitFor(() => {
      expect(mocks.sendSupplement).toHaveBeenCalledWith('task-1', 'read the assets');
    });
    expect(mocks.requestStart).not.toHaveBeenCalled();
    expect(mocks.requestContinue).toHaveBeenCalledWith('task-1');
  });
  it('switches to, queues text into and continues a suspended conversation on send', async () => {
    await renderWithConversation(journalRecord({
      lifecycle: 'suspended',
      pauseReason: 'window_closed',
      conversationBlob: conversationBlob([{ role: 'user', text: '旧对话' }]),
    }));
    mocks.publish(status({ lifecycle: 'suspended', phase: 'suspended', pauseReason: 'window_closed' }));
    mocks.getTaskStatus.mockImplementation(async () => status({
      lifecycle: 'suspended',
      phase: 'suspended',
      pauseReason: 'window_closed',
      updatedAt: Date.now(),
    }));
    const input = await screen.findByPlaceholderText(/继续输入/);
    fireEvent.change(input, { target: { value: '继续之前的工作' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/i }));
    await waitFor(() => {
      expect(mocks.switchConversation).toHaveBeenCalledWith('project-1', 'task-1');
    });
    await waitFor(() => {
      expect(mocks.sendSupplement).toHaveBeenCalledWith('task-1', '继续之前的工作');
    });
    await waitFor(() => {
      expect(mocks.requestContinue).toHaveBeenCalledWith('task-1');
    });
  });

  it('sends a user pause request while the round runs', async () => {
    await renderWithConversation();
    mocks.publish(status());
    await screen.findByRole('button', { name: /暂停/i });
    // Re-query synchronously at click time: the find* result can already be a
    // detached node once the selection-settle re-render commits, and a click
    // dispatched on a detached node never bubbles to React's root listener
    // (flaky "0 calls" failures). getByRole resolves the currently mounted
    // node in the same synchronous block as the dispatch.
    fireEvent.click(screen.getByRole('button', { name: /暂停/i }));
    await waitFor(() => {
      expect(mocks.requestPause).toHaveBeenCalledWith('task-1', 'user_requested');
    });
  });

  it('sends a cancel request through the composer stop button while the round runs', async () => {
    await renderWithConversation();
    mocks.publish(status());
    await screen.findByRole('button', { name: /停止生成/i });
    // Same detached-node race as the pause test above: click the currently
    // mounted node rather than the find* result.
    fireEvent.click(screen.getByRole('button', { name: /停止生成/i }));
    await waitFor(() => {
      expect(mocks.requestCancel).toHaveBeenCalledWith('task-1');
    });
  });

  it('disables the composer while another conversation is running', async () => {
    mocks.journalListByProject.mockResolvedValue([
      journalRecord(),
      journalRecord({
        identity: { taskId: 'task-2', projectId: 'project-1', targetSceneIdentity: 's', createdAt: 400 },
        originalTaskText: '另一个对话',
        lifecycle: 'suspended',
      } as ProjectAgentJournalRecord),
    ]);
    mocks.getProjectContext.mockResolvedValue(CONTEXT);
    render(<AgentWindow />);
    mocks.publish(status());
    await screen.findByText('另一个对话');
    fireEvent.click(screen.getByText('另一个对话'));
    const input = await screen.findByPlaceholderText(/继续输入/);
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/另一个对话正在执行/)).toBeTruthy();
  });
});

describe('AgentWindow suspended conversations', () => {
  it('shows the pause reason with continue and delete actions', async () => {
    await renderWithConversation(journalRecord({ lifecycle: 'suspended', pauseReason: 'provider_unavailable' }));
    mocks.publish(status({ lifecycle: 'suspended', phase: 'suspended', pauseReason: 'provider_unavailable' }));
    mocks.getTaskStatus.mockImplementation(async () => status({
      lifecycle: 'suspended',
      phase: 'suspended',
      pauseReason: 'provider_unavailable',
      updatedAt: Date.now(),
    }));
    expect(await screen.findByText(/服务暂时不可用/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /继续执行/i }));
    await waitFor(() => {
      expect(mocks.switchConversation).toHaveBeenCalledWith('project-1', 'task-1');
    });
    await waitFor(() => {
      expect(mocks.requestContinue).toHaveBeenCalledWith('task-1');
    });
  });

  it('offers no continue action for target_scene_unavailable', async () => {
    await renderWithConversation(journalRecord({
      lifecycle: 'suspended',
      pauseReason: 'target_scene_unavailable',
    }));
    mocks.publish(status({
      lifecycle: 'suspended',
      phase: 'suspended',
      pauseReason: 'target_scene_unavailable',
    }));
    expect(await screen.findByText(/目标场景已不可用/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /继续执行/i })).toBeNull();
  });

  it('shows the structured provider failure detail on a provider suspension', async () => {
    await renderWithConversation(journalRecord({ lifecycle: 'suspended', pauseReason: 'provider_configuration_required' }));
    mocks.publish(status({
      lifecycle: 'suspended',
      phase: 'suspended',
      pauseReason: 'provider_configuration_required',
      providerDetail: {
        code: 'model_not_found',
        status: 404,
        message: 'The model agent-model does not exist on this endpoint.',
      },
    }));
    expect(await screen.findByText(/model_not_found/)).toBeTruthy();
    expect(screen.getByText(/does not exist on this endpoint/)).toBeTruthy();
  });

  it('deletes a suspended conversation through the card action and clears the surface', async () => {
    await renderWithConversation(journalRecord({ lifecycle: 'suspended', pauseReason: 'user_requested' }));
    mocks.publish(status({ lifecycle: 'suspended', phase: 'suspended', pauseReason: 'user_requested' }));
    const thread = await screen.findByRole('log');
    const deleteButton = await within(thread).findByRole('button', { name: /删除对话/i });
    mocks.journalListByProject.mockResolvedValue([]);
    fireEvent.click(deleteButton);
    await waitFor(() => {
      expect(mocks.deleteConversation).toHaveBeenCalledWith('project-1', 'task-1');
    });
    expect(screen.queryByRole('log')).toBeNull();
  });
});

describe('AgentWindow conversation list', () => {
  it('shows the greeting and prompt box when no conversation is selected', async () => {
    render(<AgentWindow />);
    expect(await screen.findByText(/我们该在 当前项目 中做什么？/)).toBeTruthy();
    expect(screen.getByPlaceholderText(/可向 当前项目 询问任何事/)).toBeTruthy();
    expect(screen.getByText('暂无对话，发起第一个吧')).toBeTruthy();
  });

  it('starts a new task from the idle composer with the relay payload', async () => {
    render(<AgentWindow />);
    const input = await screen.findByLabelText('任务描述');
    fireEvent.change(input, { target: { value: 'check the scene' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/i }));
    await waitFor(() => {
      expect(mocks.requestStart).toHaveBeenCalled();
    });
    const payload = mocks.requestStart.mock.calls[0]![0] as { taskText: string; requestId?: string };
    expect(payload.taskText).toBe('check the scene');
    expect(typeof payload.requestId).toBe('string');
  });

  it('opts a newly created conversation into full access only when the switch is enabled', async () => {
    render(<AgentWindow />);
    const input = await screen.findByLabelText('任务描述');
    expect(screen.queryByText(/完全访问已开启/)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '完全访问' }));
    expect(screen.getByText(/完全访问已开启/)).toBeTruthy();
    fireEvent.change(input, { target: { value: 'inspect the project with the terminal' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/i }));

    await waitFor(() => {
      expect(mocks.requestStart).toHaveBeenCalled();
    });
    const payload = mocks.requestStart.mock.calls[0]![0] as { accessMode?: string };
    expect(payload.accessMode).toBe('full_access');
  });

  it('clears the draft after a successful start result', async () => {
    render(<AgentWindow />);
    const input = await screen.findByLabelText('任务描述');
    fireEvent.change(input, { target: { value: 'check the scene' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/i }));
    await waitFor(() => {
      expect(mocks.requestStart).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect((input as HTMLTextAreaElement).value).toBe('');
    });
  });

  it('shows the start failure from the editor and keeps the draft', async () => {
    mocks.requestStart.mockImplementationOnce((payload: { requestId?: string }) => {
      if (payload.requestId) {
        mocks.publishStartResult({ requestId: payload.requestId, ok: false, error: '当前模型不支持图片输入，请切换支持图片的模型后再上传图片。' });
      }
      return Promise.resolve({ ok: true });
    });
    render(<AgentWindow />);
    const input = await screen.findByLabelText('任务描述');
    fireEvent.change(input, { target: { value: 'check the scene' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/i }));
    expect(await screen.findByText(/当前模型不支持图片输入/)).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe('check the scene');
  });

  it('auto-selects the freshly started conversation when its first status arrives', async () => {
    await renderWithConversation();
    await screen.findByRole('button', { name: /Verify the scene/ });
    fireEvent.click(screen.getByRole('button', { name: /新对话/i }));
    const input = await screen.findByLabelText('任务描述');
    fireEvent.change(input, { target: { value: '全新的对话' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/i }));
    await waitFor(() => {
      expect(mocks.requestStart).toHaveBeenCalled();
    });
    // The new conversation appears in the list; its first status arrives.
    mocks.journalListByProject.mockResolvedValue([
      journalRecord(),
      journalRecord({
        identity: { taskId: 'task-new', projectId: 'project-1', targetSceneIdentity: 's', createdAt: 600 },
        originalTaskText: '全新的对话',
        updatedAt: Date.now() + 100,
      } as ProjectAgentJournalRecord),
    ]);
    mocks.publish(status({
      taskId: 'task-new',
      originalTaskText: '全新的对话',
      lifecycle: 'running',
      phase: 'model_request',
      updatedAt: Date.now() + 200,
    }));
    expect(await screen.findByRole('button', { name: /停止生成/i })).toBeTruthy();
  });

  it('renders the sidebar with the pushed project context and conversations', async () => {
    mocks.journalListByProject.mockResolvedValue([
      journalRecord({ updatedAt: Date.now() - 2 * 86_400_000 }),
      journalRecord({
        identity: {
          taskId: 'task-9',
          projectId: 'project-1',
          targetSceneIdentity: 'scene-entry-1:scene-doc-1',
          createdAt: 400,
        },
        originalTaskText: '补全表演信息',
        updatedAt: Date.now() - 1000,
      } as ProjectAgentJournalRecord),
    ]);
    render(<AgentWindow />);
    act(() => {
      mocks.publishContext(CONTEXT);
    });
    expect(await screen.findAllByText('杂乱素材')).toHaveLength(1);
    expect(await screen.findAllByText('Verify the scene')).not.toHaveLength(0);
    expect(await screen.findAllByText('补全表演信息')).not.toHaveLength(0);
    expect(screen.getByText('2天前')).toBeTruthy();
    expect(mocks.journalListByProject).toHaveBeenCalledWith('project-1');
  });

  it('shows the user rename as the conversation title', async () => {
    mocks.journalListByProject.mockResolvedValue([
      journalRecord({ userRename: '我的第一幕', originalTaskText: '重新编排开场' }),
    ]);
    render(<AgentWindow />);
    act(() => {
      mocks.publishContext(CONTEXT);
    });
    expect(await screen.findByText('我的第一幕')).toBeTruthy();
    expect(screen.queryByText('重新编排开场')).toBeNull();
  });

  it('selects a conversation from the list and switches the thread', async () => {
    mocks.journalListByProject.mockResolvedValue([
      journalRecord(),
      journalRecord({
        identity: { taskId: 'task-2', projectId: 'project-1', targetSceneIdentity: 's', createdAt: 400 },
        originalTaskText: '绑定背景资源',
        conversationBlob: conversationBlob([
          { role: 'user', text: '绑定背景资源' },
          { role: 'assistant', text: '背景资源已绑定。' },
        ]),
        updatedAt: Date.now() - 2000,
      } as ProjectAgentJournalRecord),
    ]);
    render(<AgentWindow />);
    act(() => {
      mocks.publishContext(CONTEXT);
    });
    await screen.findByRole('button', { name: /绑定背景资源/ });
    fireEvent.click(screen.getByRole('button', { name: /绑定背景资源/ }));
    expect(await screen.findByText('背景资源已绑定。')).toBeTruthy();
    expect(screen.getAllByText('绑定背景资源').length).toBeGreaterThanOrEqual(2);
  });

  it('renames a conversation inline through the pencil action', async () => {
    mocks.journalListByProject.mockResolvedValue([journalRecord()]);
    render(<AgentWindow />);
    act(() => {
      mocks.publishContext(CONTEXT);
    });
    await screen.findByRole('button', { name: /Verify the scene/ });
    fireEvent.click(screen.getByRole('button', { name: /重命名对话/i }));
    const renameInput = await screen.findByLabelText('对话名称');
    fireEvent.change(renameInput, { target: { value: '新标题' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });
    await waitFor(() => {
      expect(mocks.renameConversation).toHaveBeenCalledWith('project-1', 'task-1', '新标题');
    });
  });

  it('deletes a conversation through the list row confirm flow', async () => {
    mocks.journalListByProject.mockResolvedValue([journalRecord()]);
    render(<AgentWindow />);
    act(() => {
      mocks.publishContext(CONTEXT);
    });
    await screen.findByRole('button', { name: /Verify the scene/ });
    fireEvent.click(screen.getByRole('button', { name: /删除对话/i }));
    expect(screen.getByText('删除此对话？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /确认删除/i }));
    await waitFor(() => {
      expect(mocks.deleteConversation).toHaveBeenCalledWith('project-1', 'task-1');
    });
  });

  it('returns to the welcome surface via the new conversation button', async () => {
    await renderWithConversation();
    mocks.publish(status({ lifecycle: 'idle', phase: 'settled' }));
    await screen.findByRole('button', { name: /Verify the scene/ });
    fireEvent.click(screen.getByRole('button', { name: /新对话/i }));
    expect(await screen.findByText(/我们该在 杂乱素材 中做什么？/)).toBeTruthy();
  });

  it('provides no scene switcher and no second-task entry point', async () => {
    await renderWithConversation();
    mocks.publish(status());
    await screen.findByRole('button', { name: /Verify the scene/ });
    expect(screen.queryByText(/场景切换|切换场景/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /新任务|新建任务|发起任务/i })).toBeNull();
  });

  it('filters conversations through the sidebar search', async () => {
    mocks.journalListByProject.mockResolvedValue([
      journalRecord({ updatedAt: Date.now() - 1000 }),
      journalRecord({ identity: { taskId: 'task-2', projectId: 'project-1', targetSceneIdentity: 's', createdAt: 400 }, originalTaskText: '绑定背景资源', updatedAt: Date.now() - 2000 }),
    ]);
    render(<AgentWindow />);
    act(() => {
      mocks.publishContext(CONTEXT);
    });
    await screen.findAllByText('Verify the scene');
    fireEvent.click(screen.getByRole('button', { name: /搜索/i }));
    const search = await screen.findByLabelText('搜索对话');
    fireEvent.change(search, { target: { value: '绑定' } });
    const list = screen.getByRole('list', { name: '对话列表' });
    await waitFor(() => {
      expect(within(list).queryByText('Verify the scene')).toBeNull();
    });
    expect(within(list).getByText('绑定背景资源')).toBeTruthy();
  });
});

describe('AgentWindow welcome surface', () => {
  it('updates the greeting and placeholder with the project name', async () => {
    render(<AgentWindow />);
    act(() => {
      mocks.publishContext(CONTEXT);
    });
    expect(await screen.findByText('我们该在 杂乱素材 中做什么？')).toBeTruthy();
    expect(screen.getByPlaceholderText(/可向 杂乱素材 询问任何事/)).toBeTruthy();
    expect(screen.getAllByText('杂乱素材').length).toBeGreaterThanOrEqual(1);
  });

  it('opens the @ file mention popup and inserts the relative path into the draft', async () => {
    mocks.getProjectContext.mockResolvedValue(CONTEXT);
    render(<AgentWindow />);
    const input = await screen.findByLabelText('任务描述');
    await screen.findByText('我们该在 杂乱素材 中做什么？');
    fireEvent.change(input, { target: { value: '@sc' } });
    fireEvent.click(await screen.findByRole('option', { name: 'scene.json' }));
    await waitFor(() => {
      expect((input as HTMLTextAreaElement).value).toBe('@scene.json');
    });
  });

  it('navigates the @ file popup with arrow keys and inserts via Enter', async () => {
    mocks.getProjectContext.mockResolvedValue(CONTEXT);
    mocks.readDir.mockResolvedValue({
      success: true,
      data: [
        { name: 'alpha.txt', isDirectory: false, isSymbolicLink: false, path: '/proj/alpha.txt' },
        { name: 'beta.txt', isDirectory: false, isSymbolicLink: false, path: '/proj/beta.txt' },
      ],
    });
    render(<AgentWindow />);
    const input = await screen.findByLabelText('任务描述');
    await screen.findByText('我们该在 杂乱素材 中做什么？');
    fireEvent.change(input, { target: { value: '@' } });
    await screen.findByRole('option', { name: 'alpha.txt' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect((input as HTMLTextAreaElement).value).toBe('@beta.txt');
    });
  });

  it('disables the image attach button when the model does not support image input', async () => {
    render(<AgentWindow />);
    act(() => {
      mocks.publishContext({ ...CONTEXT, imageInputSupported: false });
    });
    const attach = await screen.findByRole('button', { name: /上传图片/i });
    expect((attach as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the effective model from settings and switches via the editor relay', async () => {
    render(<AgentWindow />);
    fireEvent.click(await screen.findByRole('button', { name: 'agent-model' }));
    const option = await screen.findByRole('option', { name: /gpt-4o-mini/ });
    fireEvent.click(option);
    await waitFor(() => {
      expect(mocks.setAgentModel).toHaveBeenCalledWith('gpt-4o-mini');
    });
  });

  it('switches the model list to a two-column grid when many models are returned', async () => {
    const manyModels = Array.from({ length: 12 }, (_, index) => `model-${index}`);
    mocks.listModels.mockResolvedValue({ success: true, models: manyModels });
    render(<AgentWindow />);
    fireEvent.click(await screen.findByRole('button', { name: 'agent-model' }));
    const listbox = await screen.findByRole('listbox', { name: '选择模型' });
    expect(listbox.className).toContain('agent-model-panel__list--grid');
    expect(within(listbox).getAllByRole('option')).toHaveLength(12);
  });

  it('shows the effort from settings and relays effort changes via the editor relay', async () => {
    localStorage.setItem('aeonstagery_settings', JSON.stringify({
      theme: 'system',
      aiProse: {
        baseUrl: 'https://provider.test',
        defaultModel: 'gpt-default',
        projectAgentModel: 'agent-model',
        effort: 'high',
      },
    }));
    render(<AgentWindow />);
    fireEvent.click(await screen.findByRole('button', { name: 'agent-model' }));
    const panel = await screen.findByLabelText('模型与 Effort 设置');
    const slider = within(panel).getByRole('slider', { name: '推理力度' }) as HTMLInputElement;
    expect(slider.value).toBe('2');
    fireEvent.change(slider, { target: { value: '4' } });
    await waitFor(() => {
      expect(mocks.setEffort).toHaveBeenCalledWith('max');
    });
  });

  it('relays the sidebar settings entry to the editor', async () => {
    render(<AgentWindow />);
    fireEvent.click(screen.getByRole('button', { name: /设置/i }));
    await waitFor(() => {
      expect(mocks.requestOpenSettings).toHaveBeenCalled();
    });
  });
});

describe('AgentWindow markdown replies', () => {
  it('renders assistant replies as markdown', async () => {
    await renderWithConversation(journalRecord({
      conversationBlob: conversationBlob([
        { role: 'user', text: '总结' },
        {
          role: 'assistant',
          text: '# 结论\n\n**重点**：场景正常\n\n- 第一项\n- 第二项\n\n```ts\nconst ok = true;\n```',
        },
      ]),
    }));
    mocks.publish(status({ lifecycle: 'idle', phase: 'settled' }));
    const heading = await screen.findByRole('heading', { name: '结论' });
    const body = heading.closest('.markdown-body') as HTMLElement | null;
    expect(body).not.toBeNull();
    expect(within(body!).getAllByText((_content, element) => (
      element?.textContent?.includes('重点：场景正常') ?? false
    )).length).toBeGreaterThan(0);
    expect(within(body!).getByText('第一项')).toBeTruthy();
    expect(within(body!).getByText('const ok = true;')).toBeTruthy();
    expect(within(body!).getByRole('list')).toBeTruthy();
  });

  it('escapes raw HTML in assistant replies instead of injecting elements', async () => {
    await renderWithConversation(journalRecord({
      conversationBlob: conversationBlob([
        { role: 'user', text: '检查' },
        { role: 'assistant', text: '<script>alert(1)</script> 正常文本' },
      ]),
    }));
    mocks.publish(status({ lifecycle: 'idle', phase: 'settled' }));
    await screen.findByText(/正常文本/);
    expect(document.querySelector('script')).toBeNull();
    expect(document.body.textContent).toContain('<script>alert(1)</script> 正常文本');
  });

  it('renders differentiated icons for distinct tool activities and agent features in the feed', async () => {
    await renderWithConversation(journalRecord({
      conversationBlob: conversationBlob([
        { role: 'user', text: '多项操作' },
        { role: 'assistant', text: '全部完成。' },
      ]),
    }));
    mocks.publish(status({
      lifecycle: 'idle',
      phase: 'settled',
      flow: [
        { kind: 'user', text: '多项操作' },
        { kind: 'tool', name: 'readScene', toolCallId: 'c1' },
        { kind: 'tool', name: 'searchResources', toolCallId: 'c2' },
        { kind: 'tool', name: 'validateScene', toolCallId: 'c3' },
        { kind: 'tool', name: 'applyAuthoringTransaction', toolCallId: 'c4' },
        { kind: 'assistant', text: '全部完成。', reasoningContent: '思考过程分析' },
      ],
      activities: [
        { kind: 'read', toolName: 'readScene', text: '读取 scene', toolCallId: 'c1' },
        { kind: 'read', toolName: 'searchResources', text: '搜索资源', toolCallId: 'c2' },
        { kind: 'read', toolName: 'validateScene', text: '校验 scene', toolCallId: 'c3' },
        { kind: 'write', toolName: 'applyAuthoringTransaction', text: '已提交 1 处修改', toolCallId: 'c4' },
      ],
    }));

    await screen.findByText('全部完成。');
    await screen.findByText('思考');
    const thinkBtn = screen.getByRole('button', { name: /思考/ });
    expect(thinkBtn.querySelector('svg.mgf-icon')).not.toBeNull();

    const activityIcons = Array.from(document.querySelectorAll('.agent-log__activity-icon svg.mgf-icon'));
    expect(activityIcons.length).toBe(4);

    // Verify SVGs are rendered and not all identical
    const glyphs = new Set(activityIcons.map((svg) => svg.innerHTML));
    expect(glyphs.size).toBe(4); // 4 distinct tool icons for readScene, searchResources, validateScene, write
  });

  it('renders thinking disclosure and streaming reply strictly below older assistant messages when continuing', async () => {
    await renderWithConversation(journalRecord({
      lifecycle: 'idle',
      conversationBlob: conversationBlob([
        { role: 'user', text: '第一轮问题' },
        { role: 'assistant', text: '第一轮回答。' },
      ]),
    }));
    mocks.publish(status({
      lifecycle: 'running',
      phase: 'model_request',
      flow: [
        { kind: 'user', text: '第一轮问题' },
        { kind: 'assistant', text: '第一轮回答。' },
      ],
      modelProgress: {
        phase: 'working',
        startedAt: Date.now(),
        reasoningDeltaText: '正在进行第二轮思考',
        deltaText: '第二轮回答进行中',
      },
    }));
    const firstReply = await screen.findByText('第一轮回答。');
    const reasoningTrigger = await screen.findByRole('button', { name: /思考/ });
    // Verify chronological DOM order: reasoning trigger comes AFTER the first assistant reply
    expect(firstReply.compareDocumentPosition(reasoningTrigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const streamingBody = await screen.findByText('第二轮回答进行中');
    expect(firstReply.compareDocumentPosition(streamingBody) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not show interrupted card or paused message on routine application exit', async () => {
    await renderWithConversation(journalRecord({
      lifecycle: 'suspended',
      pauseReason: 'application_exit',
      // The host persists the aborted round's timing as a suspended
      // lastSettledRound (ProjectAgentTask), which is what the status line
      // derives its 「已暂停」 label from — the realistic reopen shape.
      lastSettledRound: { startedAt: 0, endedAt: 5_000, kind: 'suspended' },
      conversationBlob: conversationBlob([
        { role: 'user', text: '检查场景' },
        { role: 'assistant', text: '检查完成。' },
      ]),
    }));
    mocks.publish(status({
      lifecycle: 'suspended',
      phase: 'suspended',
      pauseReason: 'application_exit',
    }));
    // The switch settle handshake waits for a status fresher than the send,
    // same as the queued-send test above.
    mocks.getTaskStatus.mockImplementation(async () => status({
      lifecycle: 'suspended',
      phase: 'suspended',
      pauseReason: 'application_exit',
      updatedAt: Date.now(),
    }));
    expect(await screen.findByText('检查完成。')).toBeTruthy();
    expect(screen.queryByText(/中断了执行/)).toBeNull();
    expect(screen.queryByText(/上次退出/)).toBeNull();
    expect(screen.queryByText('已暂停')).toBeNull();
    // No turn status line at all: the interrupted round reads as plain history.
    expect(document.querySelector('.agent-turn-status')).toBeNull();
    // And the conversation resumes through the composer, not a resume button.
    const input = screen.getByPlaceholderText(/继续输入/);
    fireEvent.change(input, { target: { value: '接着做' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/i }));
    await waitFor(() => {
      expect(mocks.requestContinue).toHaveBeenCalledWith('task-1');
    });
  });

  it('keeps a single continue affordance for a real pause with a suspended round', async () => {
    await renderWithConversation(journalRecord({
      lifecycle: 'suspended',
      pauseReason: 'user_requested',
      lastSettledRound: { startedAt: 0, endedAt: 5_000, kind: 'suspended' },
      conversationBlob: conversationBlob([
        { role: 'user', text: '检查场景' },
        { role: 'assistant', text: '检查完成。' },
      ]),
    }));
    mocks.publish(status({
      lifecycle: 'suspended',
      phase: 'suspended',
      pauseReason: 'user_requested',
    }));
    // The paused card stays, so the status line must not grow a second button.
    expect(await screen.findByText(/你已暂停本次执行/)).toBeTruthy();
    expect(screen.getByText('已暂停')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /继续执行/ })).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import type {
  AiAssistantMessage,
  AiConversationRequest,
  AiConversationResponse,
  AiReadyToolCall,
} from '../api/types/ai-conversation';
import type { AgentToolResult, AgentWriteReceipt, ProjectAgentHostWriteReceipt } from '../api/types/project-agent';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { AiConversationTransport } from '../services/ai-authoring/AiConversationTransport';
import { ProjectAgentCoordinator } from '../services/project-agent/ProjectAgentCoordinator';
import type { ProjectAgentContinuationSummarizerPort } from '../services/project-agent/ProjectAgentCoordinator';
import { InMemoryProjectAgentJournalPort } from '../services/project-agent/ProjectAgentJournal';
import { InMemoryProjectAgentLeasePort } from '../services/project-agent/ProjectAgentLease';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import { ProjectAgentToolRegistry } from '../services/project-agent/ProjectAgentToolRegistry';
import { projectHostWriteActivity, projectToolActivity } from '../services/project-agent/ProjectAgentTask';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_activity',
    meta: {
      title: 'Activity Scene',
      characters: [{ id: 'a', name: 'A' }],
    },
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'a', text: 'Hi', durationSeconds: 1 },
      },
    ],
  };
}

function createRegistry(): ProjectAgentToolRegistry {
  let document = makeDocument();
  let version = 1;
  const readPorts: ProjectAgentReadPorts = {
    overview: {
      getOverview: () => ({
        name: 'P',
        projectVersion: 1,
        scenes: [],
        assetRoots: {},
      }),
    },
    files: { listFiles: () => [] },
    text: { readText: () => ({ lines: ['x'], binary: false }) },
    textSearch: { searchText: () => [] },
    resources: { searchResources: () => [] },
    resourceInspect: {
      inspectResource: (reference) => ({
        exists: true,
        reference,
        scope: 'project',
        bindable: true,
      }),
    },
    scene: { getSnapshot: () => ({ document, version }) },
    validation: { validate: () => [] },
  };
  const writePorts: ProjectAgentWritePorts = {
    scene: { getSnapshot: () => ({ document, version }) },
    validation: { validate: () => [] },
    authoring: {
      commit: (request) => {
        document = request.candidate;
        version += 1;
        return { version };
      },
    },
  };
  return new ProjectAgentToolRegistry({ readPorts, writePorts });
}

function assistantWithTools(calls: AiReadyToolCall[], text = ''): AiAssistantMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    toolCalls: calls,
  };
}

function transportFromResponses(
  responses: Array<AiConversationResponse | Error>,
): AiConversationTransport & { calls: number; requests: AiConversationRequest[] } {
  let i = 0;
  const wrapper = {
    calls: 0,
    requests: [] as AiConversationRequest[],
    async complete(request: AiConversationRequest): Promise<AiConversationResponse> {
      wrapper.calls += 1;
      wrapper.requests.push(request);
      const next = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return wrapper;
}

async function startCoordinator(
  transport: AiConversationTransport,
  journalPort = new InMemoryProjectAgentJournalPort(),
  continuationSummarizer?: ProjectAgentContinuationSummarizerPort,
) {
  const coordinator = new ProjectAgentCoordinator({
    transport,
    toolRegistry: createRegistry(),
    lease: new InMemoryProjectAgentLeasePort(),
    journalPort,
    ...(continuationSummarizer ? { continuationSummarizer } : {}),
  });
  const started = await coordinator.start({
    projectId: 'proj',
    targetSceneIdentity: 'scene_activity',
    originalTaskText: 'Polish dialogue',
    systemPrompt: 'You are the project agent.',
    endpoint: 'https://example.test',
    model: 'test-model',
    taskId: 'task-activity',
  });
  expect(started.ok).toBe(true);
  return { coordinator, journalPort };
}

const readSceneCall: AiReadyToolCall = {
  status: 'ready',
  toolCallId: 'c1',
  name: 'readScene',
  arguments: { startLine: 1, lineCount: 5 },
};
const validateSceneCall: AiReadyToolCall = {
  status: 'ready',
  toolCallId: 'c2',
  name: 'validateScene',
  arguments: {},
};
const updateStatementCall: AiReadyToolCall = {
  status: 'ready',
  toolCallId: 'c3',
  name: 'updateStatement',
  arguments: { statementId: 'dlg_1', patch: { params: { text: 'Hello' } } },
};

describe('ProjectAgentActivityLog', () => {
  it('projects deterministic read activities after a completed tool round', async () => {
    const transport = transportFromResponses([{ message: assistantWithTools([readSceneCall]) }]);
    const { coordinator, journalPort } = await startCoordinator(transport);
    const turn = await coordinator.runModelTurn();
    expect(turn.status).toBe('tools_executed');
    expect(coordinator.getTask()!.snapshot().activities).toMatchObject([
      { kind: 'read', toolName: 'readScene', text: '读取 scene', detail: 'L1~L1 · 1 行' },
    ]);
    const record = await journalPort.load('proj', 'task-activity');
    expect(record?.activities).toMatchObject([
      { kind: 'read', toolName: 'readScene', text: '读取 scene', detail: 'L1~L1 · 1 行' },
    ]);
  });

  it('keeps activities in original tool-call order across a mixed round', async () => {
    const transport = transportFromResponses([{
      message: assistantWithTools([readSceneCall, validateSceneCall]),
    }]);
    const { coordinator } = await startCoordinator(transport);
    await coordinator.runModelTurn();
    expect(coordinator.getTask()!.getActivities().map((a) => a.text)).toEqual([
      '读取 scene',
      '校验 scene',
    ]);
  });

  it('projects committed-write activities with trusted counts from the receipt', async () => {
    const transport = transportFromResponses([{
      message: assistantWithTools([readSceneCall, updateStatementCall]),
    }]);
    const { coordinator } = await startCoordinator(transport);
    const turn = await coordinator.runModelTurn();
    expect(turn.status).toBe('tools_executed');
    const activities = coordinator.getTask()!.getActivities();
    expect(activities).toMatchObject([
      { kind: 'read', toolName: 'readScene', text: '读取 scene', detail: 'L1~L1 · 1 行' },
      { kind: 'write', toolName: 'updateStatement', text: '已提交 1 处修改' },
    ]);
  });

  it('projects deterministic tool_error activities for failed tool results', async () => {
    const badTransactionCall: AiReadyToolCall = {
      status: 'ready',
      toolCallId: 'c9',
      name: 'applyAuthoringTransaction',
      arguments: { version: 99, operations: [] },
    };
    const transport = transportFromResponses([{
      message: assistantWithTools([readSceneCall, badTransactionCall]),
    }]);
    const { coordinator } = await startCoordinator(transport);
    await coordinator.runModelTurn();
    expect(coordinator.getTask()!.getActivities()).toMatchObject([
      { kind: 'read', toolName: 'readScene', text: '读取 scene', detail: 'L1~L1 · 1 行' },
      { kind: 'tool_error', toolName: 'applyAuthoringTransaction', text: '失败 (invalid_arguments)' },
    ]);
  });

  it('projects write_no_change activities for empty transactions', async () => {
    const emptyTransactionCall: AiReadyToolCall = {
      status: 'ready',
      toolCallId: 'c10',
      name: 'applyAuthoringTransaction',
      arguments: { version: 1, operations: [] },
    };
    const transport = transportFromResponses([{
      message: assistantWithTools([readSceneCall, emptyTransactionCall]),
    }]);
    const { coordinator } = await startCoordinator(transport);
    await coordinator.runModelTurn();
    expect(coordinator.getTask()!.getActivities()).toMatchObject([
      { kind: 'read', toolName: 'readScene', text: '读取 scene', detail: 'L1~L1 · 1 行' },
      { kind: 'write_no_change', toolName: 'applyAuthoringTransaction', text: '写入无变更' },
    ]);
  });

  it('never enters AiConversationRequest.messages and leaves the full receipt in the tool message', async () => {
    const transport = transportFromResponses([
      { message: assistantWithTools([readSceneCall, updateStatementCall]) },
      { message: assistantWithTools([], 'Done') },
    ]);
    const { coordinator } = await startCoordinator(transport);
    await coordinator.runModelTurn();
    const settled = await coordinator.runModelTurn();
    expect(settled.status).toBe('settled');

    const lastRequest = transport.requests[transport.requests.length - 1]!;
    const serialized = JSON.stringify(lastRequest.messages);
    expect(serialized).not.toContain('已提交');
    expect(serialized).not.toContain('读取 scene');
    expect(serialized).not.toContain('失败 (');
    const toolMessage = lastRequest.messages.find(
      (m) => m.role === 'tool' && m.name === 'updateStatement',
    );
    expect(toolMessage).toBeDefined();
    const json = toolMessage!.content.find((b) => b.type === 'json');
    expect(json?.type === 'json' && (json.value as { ok?: boolean })).toMatchObject({ ok: true });
    const data = json?.type === 'json' ? (json.value as { data?: AgentWriteReceipt }).data : undefined;
    expect(data).toMatchObject({
      status: 'committed',
      counts: { updated: 1 },
    });
    // Model-visible receipt: ordered outcomes only, no version/line-map facts.
    expect(Array.isArray(data?.outcomes)).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/version|lineMap/);

    expect(coordinator.getTask()!.getActivities()).toHaveLength(2);
  });

  it('persists on the journal record and survives hydration from the store', async () => {
    const transport = transportFromResponses([{
      message: assistantWithTools([readSceneCall, updateStatementCall]),
    }]);
    const { coordinator, journalPort } = await startCoordinator(transport);
    await coordinator.runModelTurn();

    const record = await journalPort.load('proj', 'task-activity');
    expect(record?.activities).toMatchObject([
      { kind: 'read', toolName: 'readScene', text: '读取 scene', detail: 'L1~L1 · 1 行' },
      { kind: 'write', toolName: 'updateStatement', text: '已提交 1 处修改' },
    ]);

    const revived = new ProjectAgentCoordinator({
      transport,
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort,
    });
    await revived.hydrateFromJournal(record!);
    expect(revived.getTask()!.getActivities()).toMatchObject([
      { kind: 'read', toolName: 'readScene', text: '读取 scene', detail: 'L1~L1 · 1 行' },
      { kind: 'write', toolName: 'updateStatement', text: '已提交 1 处修改' },
    ]);
  });

  it('survives compaction deletion of tool-result messages', async () => {
    const transport = transportFromResponses([{ message: assistantWithTools([readSceneCall]) }]);
    // The compaction path needs a successful AgentConversationSummaryV1
    // (ADR0023): with a failing summarizer the round would suspend as
    // context_compaction_required and the old tool results would stay.
    const stubSummarizer: ProjectAgentContinuationSummarizerPort = {
      summarize: async () => ({
        ok: true,
        value: {
          version: 1,
          objective: 'Keep polishing',
          importantDetails: [],
          workState: { completed: [], active: [], nextMove: [] },
          relevantFiles: [],
        },
      }),
    };
    const { coordinator, journalPort } = await startCoordinator(transport, undefined, stubSummarizer);
    await coordinator.runModelTurn();

    const compact = await coordinator.forceCompact();
    expect(compact.ok).toBe(true);
    expect(coordinator.getMessages().some((m) => m.role === 'tool')).toBe(false);
    const record = await journalPort.load('proj', 'task-activity');
    expect(record?.activities).toMatchObject([
      { kind: 'read', toolName: 'readScene', text: '读取 scene', detail: 'L1~L1 · 1 行' },
      { kind: 'context_compaction', toolName: 'compactContext', text: '上下文已压缩' },
    ]);
    const storeState = record?.conversationBlob as {
      currentMessageIds: readonly string[];
      messages: readonly { messageId: string; message: { role: string } }[];
    };
    expect(storeState.messages.some((m) => m.message.role === 'tool')).toBe(false);
  });

  it('is deterministic: the same tool-result envelope always yields the same activity', () => {
    const readOk: AgentToolResult<unknown> = {
      ok: true,
      data: { lines: [], totalLines: 0, version: 1 },
    };
    expect(projectToolActivity('readScene', readOk)).toEqual({
      kind: 'read',
      toolName: 'readScene',
      text: '读取 scene',
    });
    expect(projectToolActivity('readScene', readOk)).toEqual(projectToolActivity('readScene', readOk));

    const receipt: AgentWriteReceipt = {
      status: 'committed',
      counts: {
        insertedStatements: 1,
        insertedCompanions: 1,
        updatedStatements: 0,
        updatedCompanions: 0,
        deletedLines: 0,
        movedLines: 0,
        reorderedCompanionGroups: 0,
        inserted: 1,
        updated: 0,
        deleted: 1,
        moved: 0,
      },
      warnings: [],
      outcomes: [
        { kind: 'inserted', statementId: 'st-a' },
        { kind: 'deleted' },
      ],
    };
    expect(projectToolActivity('updateStatement', { ok: true, data: receipt })).toEqual({
      kind: 'write',
      toolName: 'updateStatement',
      text: '已提交 2 处修改',
      details: {
        counts: { inserted: 1, updated: 0, deleted: 1, moved: 0 },
        safe: true,
      },
    });

    expect(projectToolActivity('readScene', {
      ok: false,
      error: { code: 'version_conflict', message: 'conflict', retryable: true },
    })).toEqual({
      kind: 'tool_error',
      toolName: 'readScene',
      text: '失败 (version_conflict)',
    });

    expect(projectToolActivity('someProbe', readOk)).toEqual({
      kind: 'read',
      toolName: 'someProbe',
      text: '读取 someProbe',
    });
  });

  it('derives deterministic display details from tool args and result envelopes', () => {
    const ok = (data: unknown): AgentToolResult<unknown> => ({ ok: true, data });

    expect(projectToolActivity('readScene', ok({
      startLine: 5,
      endLine: 24,
      lines: new Array(20).fill({ line: 1 }),
    }))).toMatchObject({
      kind: 'read',
      toolName: 'readScene',
      text: '读取 scene',
      detail: 'L5~L24 · 20 行',
    });

    expect(projectToolActivity('searchScene', ok({ total: 3 }), {
      text: '森林',
      family: 'dialogue',
    })).toMatchObject({
      kind: 'read',
      toolName: 'searchScene',
      text: '搜索 scene',
      detail: 'text=森林 · family=dialogue · 命中 3',
    });

    expect(projectToolActivity('searchResources', ok({ entries: [] }), {
      text: '森林',
      kind: 'background',
      namespace: 'project',
    })).toMatchObject({
      kind: 'read',
      toolName: 'searchResources',
      text: '搜索资源',
      detail: 'text=森林 · kind=background · namespace=project',
    });

    expect(projectToolActivity('readProjectText', ok({}), {
      path: 'docs/note.md',
      lineCount: 40,
    })).toMatchObject({
      kind: 'read',
      toolName: 'readProjectText',
      text: '读取文件',
      detail: 'docs/note.md · 40 行',
    });

    expect(projectToolActivity('searchProjectText', ok({ hits: [] }), {
      query: 'Live2D 动作',
    })).toMatchObject({
      kind: 'read',
      toolName: 'searchProjectText',
      text: '搜索项目文本',
      detail: '查询 “Live2D 动作”',
    });

    expect(projectToolActivity('inspectResource', ok({}), {
      reference: '@mount/mygo/anon.png',
    })).toMatchObject({
      kind: 'read',
      toolName: 'inspectResource',
      text: '检查资源',
      detail: '@mount/mygo/anon.png',
    });

    // Absent args or empty envelopes fall back to the plain activity text.
    expect(projectToolActivity('searchResources', ok({ entries: [] }))).toEqual({
      kind: 'read',
      toolName: 'searchResources',
      text: '搜索资源',
    });

    // Errors retain aggregate diagnostics only, never message or path content.
    expect(projectToolActivity('readScene', {
      ok: false,
      error: {
        code: 'version_conflict',
        message: 'conflict',
        retryable: true,
        diagnostics: [{ severity: 'error', message: 'secret scene source', path: '/private/project/a.scene' }],
      },
    }, { startLine: 5 })).toEqual({
      kind: 'tool_error',
      toolName: 'readScene',
      text: '失败 (version_conflict)',
      details: { diagnostics: { errors: 1, warnings: 0 }, safe: true },
    });
  });

  it('keeps the actual bounded text read for an expandable activity', () => {
    const activity = projectToolActivity('readProjectText', {
      ok: true,
      data: {
        path: 'docs/scene-notes.md',
        lines: ['第一行：角色走到窗边。', '第二行：雨声渐强。'],
        startLine: 8,
        endLine: 9,
        binary: false,
        hasMore: false,
        totalLines: 9,
        truncated: false,
      },
    }, {
      path: 'docs/scene-notes.md',
      startLine: 8,
      lineCount: 2,
    });

    expect(activity.details?.content).toEqual({
      format: 'text',
      text: '第一行：角色走到窗边。\n第二行：雨声渐强。',
      truncated: false,
    });
  });

  it('projects a human-readable terminal activity for runTerminalCommand', () => {
    const activity = projectToolActivity('runTerminalCommand', {
      ok: true,
      data: {
        shell: 'powershell',
        exitCode: 0,
        stdout: 'C:\\project\n',
        stderr: '',
        truncated: false,
        timedOut: false,
        cancelled: false,
      },
    }, { command: 'Get-Location' });

    expect(activity).toMatchObject({
      kind: 'read',
      toolName: 'runTerminalCommand',
      text: '运行命令',
      detail: 'Get-Location',
    });
    const text = activity.details?.content?.text ?? '';
    expect(activity.details?.content?.format).toBe('text');
    expect(text).toContain('$ Get-Location');
    expect(text).toContain('C:\\project');
    expect(text).toContain('退出码 0');
  });

  it('marks terminal non-zero exits, stderr, timeouts and truncation in the activity content', () => {
    const activity = projectToolActivity('runTerminalCommand', {
      ok: true,
      data: {
        shell: 'bash',
        exitCode: 2,
        stdout: 'partial output',
        stderr: 'boom',
        truncated: true,
        timedOut: true,
        cancelled: false,
      },
    }, { command: 'npm test' });

    const text = activity.details?.content?.text ?? '';
    expect(text).toContain('$ npm test');
    expect(text).toContain('partial output');
    expect(text).toContain('[stderr]');
    expect(text).toContain('boom');
    expect(text).toContain('退出码 2');
    expect(text).toContain('命令超时');
    expect(activity.details?.content?.truncated).toBe(true);
  });

  it('renders readScene content as readable scene lines instead of JSON', () => {
    const activity = projectToolActivity('readScene', {
      ok: true,
      data: {
        lines: [
          {
            line: 5,
            type: 'dialogue',
            time: 0,
            kind: 'root',
            access: {},
            params: { speaker: '林晚', text: '雨停了。' },
          },
          {
            line: 6,
            type: 'background',
            time: 0,
            kind: 'root',
            access: {},
            params: { background: 'background/rain.png' },
          },
        ],
        totalLines: 6,
        startLine: 5,
        endLine: 6,
        meta: { title: '雨夜' },
        characters: [{ id: 'linwan', name: '林晚' }],
        hasMore: false,
      },
    }, { startLine: 5, lineCount: 2 });

    const text = activity.details?.content?.text ?? '';
    expect(activity.details?.content?.format).toBe('text');
    expect(text).toContain('场景 雨夜');
    expect(text).toContain('L5 · dialogue · 林晚：雨停了。');
    expect(text).toContain('L6 · background · background（background=background/rain.png）');
    expect(text).toContain('角色 linwan=林晚');
    expect(text).toContain('共 6 行');
    expect(text).not.toContain('{');
  });

  it('renders validateScene diagnostics and readProjectOverview as readable lines', () => {
    const validation = projectToolActivity('validateScene', {
      ok: true,
      data: {
        ok: false,
        diagnostics: [
          { gate: 'semantic', severity: 'error', message: '缺少台词文本' },
          { gate: 'resource', severity: 'warning', message: '资源未绑定' },
        ],
      },
    });
    const validationText = validation.details?.content?.text ?? '';
    expect(validationText).toContain('校验：失败（1 错误 · 1 警告）');
    expect(validationText).toContain('[semantic] error · 缺少台词文本');
    expect(validationText).toContain('[resource] warning · 资源未绑定');

    const overview = projectToolActivity('readProjectOverview', {
      ok: true,
      data: {
        name: 'Demo',
        projectVersion: 3,
        activeScene: { name: '主场景', relativePath: 'scenes/main.scene.json' },
        scenes: [{ name: '主场景', relativePath: 'scenes/main.scene.json' }],
        assetRoots: { background: 'assets/bg' },
      },
    });
    const overviewText = overview.details?.content?.text ?? '';
    expect(overviewText).toContain('项目：Demo');
    expect(overviewText).toContain('版本：v3');
    expect(overviewText).toContain('当前场景：主场景（scenes/main.scene.json）');
    expect(overviewText).toContain('资源根：background=assets/bg');
  });

  it('redacts hidden reasoning and unsafe paths from structured read content', () => {
    const activity = projectToolActivity('searchResources', {
      ok: true,
      data: {
        entries: [{
          kind: 'background',
          displayName: 'Rainy street',
          scope: 'project',
          reference: 'background/rain.png',
          metadata: {
            sourcePath: '/private/project/background/rain.png',
            reasoningContent: 'must not reach the Agent window',
          },
        }],
        hasMore: false,
      },
    });

    const content = activity.details?.content?.text ?? '';
    expect(content).toContain('background/rain.png');
    expect(content).not.toContain('/private/project');
    expect(content).not.toContain('reasoningContent');
    expect(content).not.toContain('must not reach');
  });

  it('projects bounded, safe activity facts without file contents or absolute paths', () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      path: index === 0 ? '/private/project/secret.txt' : `assets/background-${index}.png`,
      text: `file contents ${index}`,
    }));
    const activity = projectToolActivity('listProjectFiles', {
      ok: true,
      data: { entries, total: 30, hasMore: true },
    });

    expect(activity).toMatchObject({
      kind: 'read',
      text: '读取项目文件',
      details: {
        paths: Array.from({ length: 25 }, (_, index) => `assets/background-${index + 1}.png`),
        matches: 30,
        pagination: { hasMore: true, truncated: false, remaining: 5 },
        safe: true,
      },
    });
    expect(JSON.stringify(activity)).not.toContain('/private/project');
    expect(JSON.stringify(activity)).not.toContain('file contents');
  });

  it('projects committed-write activities with object-level facts from the host receipt', async () => {
    const transport = transportFromResponses([{
      message: assistantWithTools([readSceneCall, updateStatementCall]),
    }]);
    const { coordinator } = await startCoordinator(transport);
    const turn = await coordinator.runModelTurn();
    expect(turn.status).toBe('tools_executed');
    const write = coordinator.getTask()!.getActivities().find((a) => a.kind === 'write');
    expect(write).toMatchObject({
      toolName: 'updateStatement',
      text: '已提交 1 处修改',
      details: {
        counts: { updated: 1 },
        changedObjects: [{ statementId: 'dlg_1', kind: 'updated' }],
        safe: true,
      },
    });
    // Object-level facts never carry a document version or scene fragment.
    expect(JSON.stringify(write)).not.toMatch(/version|lines|params/);
  });

  it('projects deterministic object-level activities for every change category (ADR0024)', () => {
    const base = {
      status: 'committed' as const,
      version: 2,
      counts: {
        insertedStatements: 0, insertedCompanions: 0, updatedStatements: 0, updatedCompanions: 0,
        deletedLines: 0, movedLines: 0, reorderedCompanionGroups: 0,
        inserted: 0, updated: 0, deleted: 0, moved: 0,
      },
      warnings: [],
    };

    const inserted = projectHostWriteActivity('insertStatement', {
      ...base,
      counts: { ...base.counts, insertedStatements: 1, inserted: 1 },
      outcomes: [{ kind: 'inserted', statementId: 'st_new' }],
      changedObjects: [{ statementId: 'st_new', kind: 'inserted' }],
      timeRange: { start: 3, end: 3 },
    });
    expect(inserted).toMatchObject({
      kind: 'write',
      toolName: 'insertStatement',
      text: '已提交 1 处修改',
      details: {
        changedObjects: [{ statementId: 'st_new', kind: 'inserted' }],
        timeRange: { start: 3, end: 3 },
        safe: true,
      },
    });

    const updated = projectHostWriteActivity('updateStatement', {
      ...base,
      counts: { ...base.counts, updatedStatements: 1, updated: 1 },
      outcomes: [{ kind: 'updated' }],
      changedObjects: [{ statementId: 'dlg_1', kind: 'updated' }],
      timeRange: { start: 0, end: 0 },
    });
    expect(updated.details?.changedObjects).toEqual([{ statementId: 'dlg_1', kind: 'updated' }]);

    const deleted = projectHostWriteActivity('deleteSourceItem', {
      ...base,
      counts: { ...base.counts, deletedLines: 1, deleted: 1 },
      outcomes: [{ kind: 'deleted' }],
      changedObjects: [{ statementId: 'cam_1', kind: 'deleted' }],
      timeRange: { start: 4, end: 4 },
    });
    expect(deleted.details?.changedObjects).toEqual([{ statementId: 'cam_1', kind: 'deleted' }]);

    const moved = projectHostWriteActivity('moveSourceItem', {
      ...base,
      counts: { ...base.counts, movedLines: 1, moved: 1 },
      outcomes: [{ kind: 'moved' }],
      changedObjects: [{ statementId: 'dlg_1', kind: 'moved' }],
      timeRange: { start: 2, end: 9.5 },
    });
    expect(moved.details).toMatchObject({
      changedObjects: [{ statementId: 'dlg_1', kind: 'moved' }],
      timeRange: { start: 2, end: 9.5 },
    });

    const reordered = projectHostWriteActivity('reorderCompanions', {
      ...base,
      counts: { ...base.counts, reorderedCompanionGroups: 1 },
      outcomes: [{ kind: 'reordered' }],
      changedObjects: [{ statementId: 'dlg_1', kind: 'reordered' }],
      timeRange: { start: 0, end: 0 },
    });
    expect(reordered.details?.changedObjects).toEqual([{ statementId: 'dlg_1', kind: 'reordered' }]);

    // Family replacement: the surviving root updates and its incompatible
    // companions are reported deleted by their former composite identities.
    const family = projectHostWriteActivity('updateStatement', {
      ...base,
      counts: { ...base.counts, updatedStatements: 1, updated: 1, deletedLines: 1, deleted: 1 },
      outcomes: [{
        kind: 'updated',
        deletedCompanions: [{ statementId: 'dlg_1', companionId: 'cmp_a' }],
      }],
      changedObjects: [
        { statementId: 'dlg_1', kind: 'updated' },
        { statementId: 'dlg_1', companionId: 'cmp_a', kind: 'deleted' },
      ],
      timeRange: { start: 0, end: 0 },
    });
    expect(family.details?.changedObjects).toEqual([
      { statementId: 'dlg_1', kind: 'updated' },
      { statementId: 'dlg_1', companionId: 'cmp_a', kind: 'deleted' },
    ]);
    // One outcome per input operation: the family replacement is a single update.
    expect(family.text).toBe('已提交 1 处修改');

    // Mixed transaction: one ordered object fact per real change.
    const mixed = projectHostWriteActivity('applyAuthoringTransaction', {
      ...base,
      counts: { ...base.counts, updatedStatements: 1, updated: 1, insertedStatements: 1, inserted: 1 },
      outcomes: [
        { kind: 'updated' },
        { kind: 'inserted', statementId: 'st_new' },
        { kind: 'no_change' },
      ],
      changedObjects: [
        { statementId: 'dlg_1', kind: 'updated' },
        { statementId: 'st_new', kind: 'inserted' },
      ],
      timeRange: { start: 0, end: 3 },
    });
    expect(mixed.text).toBe('已提交 2 处修改');
    expect(mixed.details?.changedObjects).toHaveLength(2);
    expect(mixed.details?.timeRange).toEqual({ start: 0, end: 3 });
  });

  it('never projects model-visible document versions into write activities', () => {
    const receipt: ProjectAgentHostWriteReceipt = {
      status: 'committed',
      version: 7,
      counts: {
        insertedStatements: 0, insertedCompanions: 0, updatedStatements: 1, updatedCompanions: 0,
        deletedLines: 0, movedLines: 0, reorderedCompanionGroups: 0,
        inserted: 0, updated: 1, deleted: 0, moved: 0,
      },
      warnings: [],
      outcomes: [{ kind: 'updated' }],
      changedObjects: [{ statementId: 'dlg_1', kind: 'updated' }],
      timeRange: { start: 0, end: 0 },
    };
    const activity = projectHostWriteActivity('updateStatement', receipt);
    expect(activity.kind).toBe('write');
    expect(JSON.stringify(activity)).not.toContain('7');
    expect(JSON.stringify(activity)).not.toMatch(/version/);
  });
});

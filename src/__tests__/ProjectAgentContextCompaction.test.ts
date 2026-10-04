import { describe, expect, it } from 'vitest';
import type {
  AiAssistantMessage,
  AiConversationMessage,
  AiConversationRequest,
  AiConversationResponse,
  AiReadyToolCall,
  AiToolMessage,
  JsonValue,
} from '../api/types/ai-conversation';
import type { AiConversationTransport } from '../services/ai-authoring/AiConversationTransport';
import {
  ProjectAgentCoordinator,
  PROJECT_AGENT_CONTEXT_COMPACTION_THRESHOLD,
  PROJECT_AGENT_CONVERSATION_SUMMARY_MAX_TOKENS,
  SimpleProjectAgentContextBudgetEstimator,
  ModelProjectAgentContinuationSummarizer,
  type ProjectAgentContinuationSummarizerPort,
} from '../services/project-agent/ProjectAgentCoordinator';
import {
  validateAgentConversationSummary,
} from '../services/project-agent/ProjectAgentTask';
import { InMemoryProjectAgentJournalPort } from '../services/project-agent/ProjectAgentJournal';
import { InMemoryProjectAgentLeasePort } from '../services/project-agent/ProjectAgentLease';
import { ProjectAgentToolRegistry } from '../services/project-agent/ProjectAgentToolRegistry';
import { ProjectAgentImageSessionCache } from '../services/project-agent/ProjectAgentImageSessionCache';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { PROJECT_AGENT_CAPABILITY_CATALOG_SLOT } from '../services/project-agent/ProjectAgentPerformanceCatalog';
import type { PerformanceCapabilityCatalogV1 } from '../services/ai-authoring/performance/PerformanceProfileTypes';
import type { ProjectAgentMainHost, ProjectAgentTaskStatusPayload } from '../api/types/project-agent-ipc';
import {
  ProjectAgentService,
  type ProjectAgentServiceOptions,
} from '../services/project-agent-service/ProjectAgentService';
import { buildProjectAgentSystemPrompt } from '../services/project-agent-service/ProjectAgentSystemPrompt';

function makeDocument(hugeText?: string): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-cc',
    meta: { title: 'Scene', characters: [{ id: 'soyo', name: 'Soyo', model: 'models/soyo.model3.json' }] },
    statements: [{
      id: 'dlg_1',
      time: 0,
      type: 'dialogue',
      params: { speakerId: 'soyo', text: hugeText ?? 'Hi', durationSeconds: 1 },
    }],
  };
}

function createRegistry(hugeText?: string, options?: {
  registerReadImage?: boolean;
  imageRead?: ProjectAgentReadPorts['image'];
}): ProjectAgentToolRegistry {
  let document = makeDocument(hugeText);
  let version = 1;
  const readPorts: ProjectAgentReadPorts = {
    overview: { getOverview: () => ({ name: 'P', projectVersion: 1, scenes: [], assetRoots: {} }) },
    files: { listFiles: () => [] },
    text: { readText: () => ({ lines: ['x'], binary: false }) },
    textSearch: { searchText: () => [] },
    resources: { searchResources: () => [] },
    resourceInspect: { inspectResource: () => ({ exists: true, reference: 'x', scope: 'project', bindable: true }) },
    scene: { getSnapshot: () => ({ document, version }) },
    validation: { validate: () => [] },
    ...(options?.imageRead ? { image: options.imageRead } : {}),
  };
  const writePorts: ProjectAgentWritePorts = {
    scene: { getSnapshot: () => ({ document, version }) },
    validation: { validate: () => [] },
    authoring: { commit: (request) => { document = request.candidate; version += 1; return { version }; } },
  };
  return new ProjectAgentToolRegistry({
    readPorts,
    writePorts,
    ...(options?.registerReadImage ? { registerReadImage: true } : {}),
  });
}

function assistantWithTools(calls: AiReadyToolCall[], text = ''): AiAssistantMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    toolCalls: calls,
  };
}

function assistantText(text: string): AiAssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

function capturingTransport(
  responses: Array<AiConversationResponse | Error | AiAssistantMessage>,
): { transport: AiConversationTransport & { calls: number }; requests: AiConversationRequest[] } {
  const requests: AiConversationRequest[] = [];
  let i = 0;
  const transport = {
    calls: 0,
    async complete(request: AiConversationRequest): Promise<AiConversationResponse> {
      transport.calls += 1;
      requests.push(request);
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      if (!next) throw new Error('Unexpected transport call');
      return 'message' in next
        ? next
        : { message: next as AiAssistantMessage };
    },
  };
  return { transport, requests };
}

function summaryResponse(summary: Record<string, unknown>): AiConversationResponse {
  return {
    message: assistantText(JSON.stringify(summary)),
  };
}

const VALID_SUMMARY_JSON = summaryResponse({
  version: 1,
  objective: 'Polish soyo lines in the active scene',
  importantDetails: ['soyo is the focus character'],
  workState: {
    completed: ['surveyed the scene'],
    active: ['polishing soyo dialogue'],
    nextMove: ['re-read the scene and apply polish'],
  },
  relevantFiles: ['scene-cc'],
});

const EMPTY_CATALOG: PerformanceCapabilityCatalogV1 = {
  version: 1,
  characters: [],
  lookAtTargets: [],
  reactionTargets: [],
  diagnostics: [],
};

function toolMessage(name: string, data: JsonValue, toolCallId = 'tc-1'): AiToolMessage {
  return {
    role: 'tool',
    toolCallId,
    name,
    content: [{ type: 'json', value: { ok: true, data } }],
  };
}

function validSummary(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    objective: 'Continue polishing',
    importantDetails: [],
    workState: { completed: [], active: [], nextMove: [] },
    relevantFiles: [],
    ...overrides,
  };
}

describe('SimpleProjectAgentContextBudgetEstimator accounting', () => {
  it('counts full tool schemas as part of the next request', () => {
    const estimator = new SimpleProjectAgentContextBudgetEstimator();
    const base = {
      messages: [],
      pendingSupplements: [],
      contextWindow: 1_000_000,
      reservedOutputTokens: 0,
    };
    const withoutTools = estimator.estimate(base);
    const withTools = estimator.estimate({
      ...base,
      tools: [
        { name: 'readScene', description: 'x', parameters: { type: 'object', properties: { startLine: { type: 'number' } } } },
        { name: 'updateStatement', parameters: { type: 'object', properties: { patch: { type: 'object' } } } },
      ],
    });
    expect(withTools.estimatedTokens).toBeGreaterThan(withoutTools.estimatedTokens);
  });

  it('counts pending supplements verbatim into the next-request estimate', () => {
    const estimator = new SimpleProjectAgentContextBudgetEstimator();
    const base = {
      messages: [],
      contextWindow: 1_000_000,
      reservedOutputTokens: 0,
    };
    const plain = estimator.estimate({ ...base, pendingSupplements: [] });
    const withPending = estimator.estimate({ ...base, pendingSupplements: ['first', 'second instruction '.repeat(200)] });
    expect(withPending.estimatedTokens).toBeGreaterThan(plain.estimatedTokens);
  });

  it('accounts for reasoning content and exposes a complete content-free breakdown', () => {
    const estimator = new SimpleProjectAgentContextBudgetEstimator();
    const reasoning = 'I need the next scene page before writing.';
    const messages: AiConversationMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'base catalog-json' }] },
      { role: 'user', content: [{ type: 'text', text: 'Add background' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Reading the scene.' }],
        toolCalls: [],
        reasoningContent: reasoning,
      },
      toolMessage('readScene', { lines: [{ line: 1, type: 'dialogue' }] }),
    ];
    const estimate = estimator.estimate({
      messages,
      pendingSupplements: ['Preserve dialogue.'],
      fixedContext: { capabilityCatalogChars: 'catalog-json'.length },
      contextWindow: 1_000_000,
      reservedOutputTokens: 0,
    });
    const breakdown = estimate.breakdown;

    expect(breakdown).toBeDefined();
    if (!breakdown) return;
    expect(breakdown.assistantReasoningChars).toBe(reasoning.length);
    expect(breakdown.systemPromptChars + breakdown.capabilityCatalogChars)
      .toBe('base catalog-json'.length);
    const allMessageChars = breakdown.systemPromptChars
      + breakdown.capabilityCatalogChars
      + breakdown.userMessageChars
      + breakdown.assistantContentChars
      + breakdown.assistantToolCallChars
      + breakdown.assistantReasoningChars
      + breakdown.toolResultChars;
    expect(breakdown.messageTokens).toBe(Math.ceil(
      (allMessageChars + breakdown.pendingSupplementChars) / 4,
    ));
    expect(estimate.estimatedInputTokens).toBe(
      breakdown.calibratedMessageTokens + breakdown.toolSchemaTokens + breakdown.imageTokens,
    );
  });

  it('adds conservative image token costs for readImage descriptors', () => {
    const estimator = new SimpleProjectAgentContextBudgetEstimator();
    const descriptor = (reference: string, detail: 'auto' | 'low' | 'high') => toolMessage('readImage', {
      reference,
      contentFingerprint: 'fp',
      detail,
      imagePayload: { mimeType: 'image/png', width: 100, height: 100 },
    });
    const base = { messages: [] as AiToolMessage[], pendingSupplements: [], contextWindow: 1_000_000, reservedOutputTokens: 0 };
    const none = estimator.estimate(base);
    const low = estimator.estimate({ ...base, messages: [descriptor('@mount/1/a.png', 'low')] });
    const high = estimator.estimate({ ...base, messages: [descriptor('@mount/1/b.png', 'high')] });
    expect(low.estimatedTokens).toBeGreaterThan(none.estimatedTokens);
    expect(high.estimatedTokens).toBeGreaterThan(low.estimatedTokens);
  });

  it('includes reserved output in the estimate and flags the 80% boundary', () => {
    const estimator = new SimpleProjectAgentContextBudgetEstimator();
    const boundary = estimator.estimate({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(80 * 4) }] }],
      pendingSupplements: [],
      contextWindow: 100,
      reservedOutputTokens: 0,
    });
    expect(boundary.usageRatio).toBeCloseTo(PROJECT_AGENT_CONTEXT_COMPACTION_THRESHOLD);
    expect(boundary.exceedsThreshold).toBe(true);
    const below = estimator.estimate({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(79 * 4) }] }],
      pendingSupplements: [],
      contextWindow: 100,
      reservedOutputTokens: 0,
    });
    expect(below.exceedsThreshold).toBe(false);
  });

  it('calibrates with actual provider usage without changing the 80% threshold', () => {
    const estimator = new SimpleProjectAgentContextBudgetEstimator();
    const input = {
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'y'.repeat(400) }] }],
      pendingSupplements: [] as string[],
      contextWindow: 100_000,
      reservedOutputTokens: 0,
    };
    const before = estimator.estimate(input);
    estimator.calibrate({ inputTokens: before.estimatedInputTokens * 4 }, before.estimatedInputTokens);
    const after = estimator.estimate(input);
    expect(after.estimatedTokens).toBeGreaterThan(before.estimatedTokens);
    expect(PROJECT_AGENT_CONTEXT_COMPACTION_THRESHOLD).toBe(0.8);
  });
});

describe('AgentConversationSummaryV1 validation', () => {
  it('accepts objective, importantDetails, workState and relevantFiles with version 1', () => {
    const result = validateAgentConversationSummary(validSummary());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.version).toBe(1);
      expect(result.summary.objective).toBe('Continue polishing');
      expect(result.summary.workState).toEqual({ completed: [], active: [], nextMove: [] });
      expect(result.summary.importantDetails).toEqual([]);
      expect(result.summary.relevantFiles).toEqual([]);
    }
  });

  it('rejects missing fields, wrong versions, and non-string items', () => {
    const { objective: _missing, ...rest } = validSummary() as Record<string, unknown>;
    expect(validateAgentConversationSummary(rest).ok).toBe(false);
    expect(validateAgentConversationSummary(validSummary({ version: 2 })).ok).toBe(false);
    expect(validateAgentConversationSummary(validSummary({ importantDetails: [1] })).ok).toBe(false);
    expect(validateAgentConversationSummary(validSummary({ objective: 42 })).ok).toBe(false);
    expect(validateAgentConversationSummary(validSummary({
      workState: { completed: [], active: [], nextMove: 'nope' },
    })).ok).toBe(false);
    expect(validateAgentConversationSummary(validSummary({ workState: null })).ok).toBe(false);
    expect(validateAgentConversationSummary('not an object').ok).toBe(false);
  });

  it('enforces the 8192-token cap on the summary', () => {
    const over = validSummary({
      importantDetails: ['x'.repeat((PROJECT_AGENT_CONVERSATION_SUMMARY_MAX_TOKENS + 1) * 4)],
    });
    const result = validateAgentConversationSummary(over);
    expect(result.ok).toBe(false);
  });
});

describe('ModelProjectAgentContinuationSummarizer', () => {
  it('uses the current projectAgentModel without tools and parses the AgentConversationSummaryV1 JSON', async () => {
    const { transport, requests } = capturingTransport([VALID_SUMMARY_JSON]);
    const summarizer = new ModelProjectAgentContinuationSummarizer({ transport });
    const result = await summarizer.summarize({
      originalTaskText: 'Polish the scene',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'conversation history' }] }],
      committedChangeNotes: ['v2:committed(+1/~0/-0)'],
      maxTokens: PROJECT_AGENT_CONVERSATION_SUMMARY_MAX_TOKENS,
      endpoint: 'https://current.test',
      model: 'current-model',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe(1);
      expect(result.value.objective).toBe('Polish soyo lines in the active scene');
      expect(result.value.workState.active).toEqual(['polishing soyo dialogue']);
    }
    const request = requests[0]!;
    expect(request.endpoint).toBe('https://current.test');
    expect(request.model).toBe('current-model');
    expect(request.stream).toBe(false);
    expect(request.tools).toBeUndefined();
    expect(request.responseFormat).toEqual({ type: 'json_object' });
    const systemText = JSON.stringify(request.messages[0]!.content);
    expect(systemText).toContain('AgentConversationSummaryV1');
    expect(systemText).toContain('workState');
    expect(systemText).toContain('objective');
    expect(requests).toHaveLength(1);
  });

  it('projects in-memory image payloads into the summary request', async () => {
    const cache = new ProjectAgentImageSessionCache();
    cache.set('@mount/1/shot.png', {
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      width: 10,
      height: 10,
      detail: 'high',
      contentFingerprint: 'fp-1',
    });
    const { transport, requests } = capturingTransport([VALID_SUMMARY_JSON]);
    const summarizer = new ModelProjectAgentContinuationSummarizer({ transport, imagePayloadResolver: cache });
    const imageResult = toolMessage('readImage', {
      reference: '@mount/1/shot.png',
      contentFingerprint: 'fp-1',
      detail: 'high',
      imagePayload: { mimeType: 'image/png', width: 10, height: 10 },
    });
    const result = await summarizer.summarize({
      originalTaskText: 'Inspect the shot',
      messages: [imageResult],
      committedChangeNotes: [],
      maxTokens: PROJECT_AGENT_CONVERSATION_SUMMARY_MAX_TOKENS,
      endpoint: 'e',
      model: 'm',
      imagePayloadResolver: cache,
    });
    expect(result.ok).toBe(true);
    const blocks = requests[0]!.messages.flatMap((message) => message.content);
    const imageBlock = blocks.find((block) => block.type === 'image');
    expect(imageBlock).toBeDefined();
    expect((imageBlock as { type: 'image'; bytes: Uint8Array }).bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('drops stale image payloads to a text note instead of replaying bytes', async () => {
    const cache = new ProjectAgentImageSessionCache();
    cache.set('@mount/1/shot.png', {
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      width: 10,
      height: 10,
      detail: 'high',
      contentFingerprint: 'fp-1',
    });
    const { transport, requests } = capturingTransport([VALID_SUMMARY_JSON]);
    const summarizer = new ModelProjectAgentContinuationSummarizer({ transport, imagePayloadResolver: cache });
    const staleResult = toolMessage('readImage', {
      reference: '@mount/1/shot.png',
      contentFingerprint: 'stale-fp',
      detail: 'high',
      imagePayload: { mimeType: 'image/png', width: 10, height: 10 },
    });
    const result = await summarizer.summarize({
      originalTaskText: 'Inspect the shot',
      messages: [staleResult],
      committedChangeNotes: [],
      maxTokens: PROJECT_AGENT_CONVERSATION_SUMMARY_MAX_TOKENS,
      endpoint: 'e',
      model: 'm',
      imagePayloadResolver: cache,
    });
    expect(result.ok).toBe(true);
    const request = requests[0]!;
    expect(request.messages.some((m) => m.role === 'tool'
      && m.content.some((b) => b.type === 'text' && b.text.includes('unavailable')))).toBe(true);
    expect(request.messages.some((m) => m.role === 'tool'
      && m.content.some((b) => b.type === 'image'))).toBe(false);
  });

  it('returns a structured failure instead of throwing on invalid JSON', async () => {
    const { transport } = capturingTransport([assistantText('this is not json at all')]);
    const summarizer = new ModelProjectAgentContinuationSummarizer({ transport });
    const result = await summarizer.summarize({
      originalTaskText: 't',
      messages: [],
      committedChangeNotes: [],
      maxTokens: 100,
      endpoint: 'e',
      model: 'm',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('summary_schema_invalid');
  });

  it('returns a structured failure when the summary transport throws', async () => {
    const { transport } = capturingTransport([new Error('network down')]);
    const summarizer = new ModelProjectAgentContinuationSummarizer({ transport });
    const result = await summarizer.summarize({
      originalTaskText: 't',
      messages: [],
      committedChangeNotes: [],
      maxTokens: 100,
      endpoint: 'e',
      model: 'm',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('summary_request_failed');
  });
});

describe('ProjectAgentCoordinator compaction behavior', () => {
  async function compactingCoordinator(options?: {
    contextWindow?: number;
    continuationSummarizer?: ProjectAgentContinuationSummarizerPort;
    imageCache?: ProjectAgentImageSessionCache;
  }) {
    const coordinator = new ProjectAgentCoordinator({
      transport: capturingTransport([VALID_SUMMARY_JSON, assistantWithTools([], 'ignored')]).transport,
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort: new InMemoryProjectAgentJournalPort(),
      // The window must be large enough to fit the compaction request itself
      // (conversation + 8192 reserved summary output, ADR0023); a window too
      // small for the request legitimately suspends instead of compacting.
      contextWindow: options?.contextWindow ?? 12_000,
      ...(options?.continuationSummarizer ? { continuationSummarizer: options.continuationSummarizer } : {}),
      ...(options?.imageCache ? { imageCache: options.imageCache } : {}),
    });
    const started = await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene-cc',
      originalTaskText: 'Polish the scene',
      systemPrompt: 'You are the project agent.',
      endpoint: 'https://current.test',
      model: 'current-model',
      taskId: 'compact-task',
    });
    expect(started.ok).toBe(true);
    return coordinator;
  }

  it('compacts between the completed tool round and the next model call', async () => {
    const summarizerTransport = capturingTransport([VALID_SUMMARY_JSON]);
    const main = capturingTransport([
      assistantWithTools([{ status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 2000 } }], 'reading'),
      assistantText('done'),
    ]);
    const coordinator = new ProjectAgentCoordinator({
      transport: main.transport,
      toolRegistry: createRegistry('huge scene payload '.repeat(5000)),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort: new InMemoryProjectAgentJournalPort(),
      contextWindow: 10_000,
      continuationSummarizer: new ModelProjectAgentContinuationSummarizer({
        transport: summarizerTransport.transport,
      }),
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene-cc',
      originalTaskText: 'Polish the scene',
      systemPrompt: 'You are the project agent.',
      endpoint: 'https://current.test',
      model: 'current-model',
      taskId: 'between-turns',
    });
    await coordinator.runModelTurn();
    expect(main.requests).toHaveLength(1);
    expect(coordinator.getTask()?.getLifecycle()).toBe('running');
    const settled = await coordinator.runModelTurn();
    expect(main.requests).toHaveLength(2);
    expect(settled.status).toBe('settled');
    const compacted = main.requests[1]!.messages;
    expect(compacted.some((m) => m.role === 'user'
      && m.content.some((b) => b.type === 'text' && b.text.includes('Continuation summary')))).toBe(true);
    const serialized = JSON.stringify(compacted);
    expect(serialized).not.toContain('huge scene payload');
    expect(serialized).toContain('AgentConversationSummaryV1');
    // The summary request went out with the CURRENT model and no tools.
    expect(summarizerTransport.requests).toHaveLength(1);
    expect(summarizerTransport.requests[0]!.endpoint).toBe('https://current.test');
    expect(summarizerTransport.requests[0]!.tools).toBeUndefined();
    // A plain assistant reply settled the round: idle, no terminal lifecycle.
    expect(coordinator.getTask()?.getLifecycle()).toBe('idle');
  });

  it('corrects one schema failure and suspends as context_compaction_required on the second', async () => {
    const calls: string[] = [];
    const badSummarizer: ProjectAgentContinuationSummarizerPort = {
      summarize: async (input) => {
        calls.push(input.previousError ?? 'first');
        return { ok: true, value: { version: 2 } as never };
      },
    };
    const coordinator = await compactingCoordinator({
      contextWindow: 12_000,
      continuationSummarizer: badSummarizer,
    });
    const messagesBefore = coordinator.getMessages();
    const compact = await coordinator.forceCompact();
    expect(compact.ok).toBe(false);
    if (!compact.ok) expect(compact.code).toBe('context_compaction_required');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('first');
    expect(calls[1]).toContain('Summary version must be 1');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('suspended');
    expect(coordinator.getTask()?.getSuspensionReason()).toBe('context_compaction_required');
    expect(coordinator.getTask()?.getLeaseToken()).toBeUndefined();
    // The original model context is preserved: no summary message was written.
    expect(coordinator.getMessages()).toEqual(messagesBefore);
    expect(JSON.stringify(coordinator.getMessages())).not.toContain('Continuation summary');
  });

  it('suspends with context_compaction_required when the summary request fails, keeping the original messages', async () => {
    const failing: ProjectAgentContinuationSummarizerPort = {
      summarize: async () => ({ ok: false, code: 'summary_request_failed', message: 'boom' }),
    };
    const coordinator = await compactingCoordinator({ contextWindow: 12_000, continuationSummarizer: failing });
    const messagesBefore = coordinator.getMessages();
    const compact = await coordinator.forceCompact();
    expect(compact.ok).toBe(false);
    if (!compact.ok) expect(compact.code).toBe('context_compaction_required');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('suspended');
    expect(coordinator.getTask()?.getSuspensionReason()).toBe('context_compaction_required');
    expect(coordinator.getTask()?.getLeaseToken()).toBeUndefined();
    expect(coordinator.getMessages()).toEqual(messagesBefore);
    expect(JSON.stringify(coordinator.getMessages())).not.toContain('Continuation summary');
  });

  it('suspends the round before the next model request when compaction cannot fit', async () => {
    // The compaction request (conversation + 8192 reserved summary output)
    // cannot fit the window even though nothing is reducible: the round
    // suspends as context_compaction_required before any model request.
    const main = capturingTransport([assistantText('never sent')]);
    const coordinator = new ProjectAgentCoordinator({
      transport: main.transport,
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort: new InMemoryProjectAgentJournalPort(),
      contextWindow: 12_000,
      continuationSummarizer: new ModelProjectAgentContinuationSummarizer({
        transport: capturingTransport([VALID_SUMMARY_JSON]).transport,
      }),
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene-cc',
      originalTaskText: 'Polish the scene '.repeat(2_400),
      systemPrompt: 'You are the project agent.',
      endpoint: 'https://current.test',
      model: 'current-model',
      taskId: 'cannot-fit',
    });
    // The pre-request estimate already crosses 80%: the 80% trigger fires on
    // the first model call and the compaction request cannot fit.
    const turn = await coordinator.runModelTurn();
    expect(turn.status).toBe('suspended');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('suspended');
    expect(coordinator.getTask()?.getSuspensionReason()).toBe('context_compaction_required');
    // No model request was issued on the uncompacted context.
    expect(main.requests).toHaveLength(0);
    // The original messages stayed intact.
    expect(JSON.stringify(coordinator.getMessages())).toContain('Polish the scene');
    expect(JSON.stringify(coordinator.getMessages())).not.toContain('Continuation summary');
  });

  it('preserves undelivered supplements verbatim after compaction', async () => {
    const coordinator = await compactingCoordinator({ contextWindow: 12_000 });
    coordinator.enqueueSupplement('keep this exact instruction');
    const compact = await coordinator.forceCompact();
    expect(compact.ok).toBe(true);
    const messages = coordinator.getMessages();
    const texts = messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
    expect(texts.filter((t) => t === 'keep this exact instruction')).toHaveLength(1);
    expect(coordinator.getTask()?.peekPendingSupplements()).toHaveLength(0);
  });

  it('deletes in-memory image payloads after compaction consumed them', async () => {
    const cache = new ProjectAgentImageSessionCache();
    cache.set('@mount/1/shot.png', {
      mimeType: 'image/png',
      bytes: new Uint8Array([9]),
      width: 10,
      height: 10,
      detail: 'high',
      contentFingerprint: 'fp',
    });
    const coordinator = await compactingCoordinator({ contextWindow: 12_000, imageCache: cache });
    const compact = await coordinator.forceCompact();
    expect(compact.ok).toBe(true);
    expect(cache.get('@mount/1/shot.png', 'fp', 'high')).toBeNull();
  });

  it('reduces oversized rereadable payloads so the compaction request fits, keeping the original task', async () => {
    const summarizerTransport = capturingTransport([VALID_SUMMARY_JSON]);
    const main = capturingTransport([
      assistantWithTools([{ status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 5000 } }], 'big read'),
      assistantText('done'),
    ]);
    const coordinator = new ProjectAgentCoordinator({
      transport: main.transport,
      toolRegistry: createRegistry('huge scene payload '.repeat(8000)),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort: new InMemoryProjectAgentJournalPort(),
      contextWindow: 10_000,
      continuationSummarizer: new ModelProjectAgentContinuationSummarizer({
        transport: summarizerTransport.transport,
      }),
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene-cc',
      originalTaskText: 'Polish the scene',
      systemPrompt: 'You are the project agent.',
      endpoint: 'https://current.test',
      model: 'current-model',
      taskId: 'reduce-payloads',
    });
    await coordinator.runModelTurn();
    expect(coordinator.getTask()?.getLifecycle()).toBe('running');
    const settled = await coordinator.runModelTurn();
    expect(settled.status).toBe('settled');
    const summaryRequest = summarizerTransport.requests[0]!;
    const serialized = JSON.stringify(summaryRequest.messages);
    expect(serialized).toContain('host reference');
    expect(serialized).not.toContain('huge scene payload');
    const compacted = main.requests[1]!.messages;
    const compactedText = JSON.stringify(compacted);
    expect(compactedText).toContain('Polish the scene');
    expect(compactedText).not.toContain('huge scene payload');
    expect(coordinator.getTask()?.getLifecycle()).toBe('idle');
  });

  it('writes the summary message atomically, deletes replaced messages and their image bytes, and keeps activities', async () => {
    const cache = new ProjectAgentImageSessionCache();
    cache.set('@mount/1/shot.png', {
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      width: 10,
      height: 10,
      detail: 'high',
      contentFingerprint: 'fp-1',
    });
    const main = capturingTransport([
      assistantWithTools([{ status: 'ready', toolCallId: 'img1', name: 'readImage', arguments: { reference: '@mount/1/shot.png', detail: 'high' } }], 'look'),
      VALID_SUMMARY_JSON,
      assistantText('done'),
    ]);
    const journalPort = new InMemoryProjectAgentJournalPort();
    const coordinator = new ProjectAgentCoordinator({
      transport: main.transport,
      toolRegistry: createRegistry(undefined, {
        registerReadImage: true,
        imageRead: {
          readImage: async () => ({
            mimeType: 'image/png',
            bytes: new Uint8Array([1, 2, 3]),
            originalWidth: 10,
            originalHeight: 10,
            deliveredWidth: 10,
            deliveredHeight: 10,
            scaled: false,
            contentFingerprint: 'fp-1',
          }),
        },
      }),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort,
      contextWindow: 12_000,
      imageCache: cache,
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene-cc',
      originalTaskText: 'Polish the scene',
      systemPrompt: 'You are the project agent.',
      endpoint: 'https://current.test',
      model: 'current-model',
      taskId: 'atomic-replace',
    });
    await coordinator.runModelTurn();
    const preRecord = await journalPort.load('proj', 'atomic-replace');
    const preState = preRecord?.conversationBlob as {
      currentMessageIds: readonly string[];
      messages: readonly { messageId: string; message: { role: string; content: readonly { type: string }[] } }[];
    };
    const preTool = preState.messages.find((m) => m.message.role === 'tool');
    expect(preTool).toBeDefined();
    expect(preTool!.message.content.some((b) => b.type === 'image')).toBe(true);
    expect(JSON.stringify(preState)).toContain('AQID');

    const compact = await coordinator.forceCompact();
    expect(compact.ok).toBe(true);
    const settled = await coordinator.runModelTurn();
    expect(settled.status).toBe('settled');

    const record = await journalPort.load('proj', 'atomic-replace');
    expect(record?.activities).toMatchObject([
      { kind: 'read', toolName: 'readImage', text: '读取图片', detail: '@mount/1/shot.png' },
      { kind: 'context_compaction', toolName: 'compactContext', text: '上下文已压缩' },
    ]);
    // ADR0023: the tool-round activity carries the SAME toolCallId as its
    // (pre-compaction) stored tool message — the flow anchor binding key —
    // while the compaction activity has no tool message and no id, so the
    // window renders it as a standalone row instead of shifting anchors.
    const preToolMessage = preState.messages.find((m) => m.message.role === 'tool');
    expect(preToolMessage).toBeDefined();
    expect(record?.activities?.[0]?.toolCallId).toBe(
      (preToolMessage!.message as { toolCallId?: string }).toolCallId,
    );
    expect(record?.activities?.[1]?.toolCallId).toBeUndefined();
    // The settled round timing is persisted for the window status line.
    expect(record?.lastSettledRound).toMatchObject({ kind: 'settled' });
    if (record?.lastSettledRound) {
      expect(record.lastSettledRound.startedAt).toBeLessThanOrEqual(record.lastSettledRound.endedAt);
    }
    const storeState = record?.conversationBlob as {
      currentMessageIds: readonly string[];
      messages: readonly { messageId: string; message: { role: string; content: readonly { type: string }[] } }[];
    };
    // Replaced old messages (tool result with its image bytes) are deleted.
    expect(storeState.messages.some((m) => m.message.role === 'tool')).toBe(false);
    expect(storeState.messages.some((m) => m.message.content.some((b) => b.type === 'image'))).toBe(false);
    expect(JSON.stringify(storeState)).not.toContain('AQID');
    // The summary message is part of the replaced set.
    const summaryMessage = storeState.messages.find((m) =>
      m.message.content.some((b) => b.type === 'text'
        && (b as unknown as { text: string }).text.includes('Continuation summary')));
    expect(summaryMessage).toBeDefined();
    expect(summaryMessage!.message.content.some((b) => b.type === 'text'
      && (b as unknown as { text: string }).text.includes('AgentConversationSummaryV1'))).toBe(true);
    expect(storeState.currentMessageIds).toEqual(storeState.messages.map((m) => m.messageId));
  });

  it('compaction never produces a terminal lifecycle: objective is a direction, not a goal', async () => {
    const coordinator = await compactingCoordinator({ contextWindow: 12_000 });
    const compact = await coordinator.forceCompact();
    expect(compact.ok).toBe(true);
    if (compact.ok) {
      expect(compact.summary.objective.length).toBeGreaterThan(0);
      expect(compact.summary.workState.nextMove).toEqual(['re-read the scene and apply polish']);
    }
    expect(coordinator.getTask()?.isTerminal()).toBe(false);
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('running');
    // The conversation stays input-ready: a later plain-text turn settles to idle.
    const settled = await coordinator.runModelTurn();
    expect(settled.status).toBe('settled');
    expect(coordinator.getTask()?.getLifecycle()).toBe('idle');
    // A suspended compaction can be retried on the same Conversation.
    const bad: ProjectAgentContinuationSummarizerPort = {
      summarize: async () => ({ ok: false, code: 'summary_request_failed', message: 'boom' }),
    };
    const retry = new ProjectAgentCoordinator({
      transport: capturingTransport([VALID_SUMMARY_JSON, assistantText('retry ok')]).transport,
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort: new InMemoryProjectAgentJournalPort(),
      contextWindow: 12_000,
      continuationSummarizer: bad,
    });
    await retry.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene-cc',
      originalTaskText: 'Polish the scene',
      systemPrompt: 'You are the project agent.',
      endpoint: 'https://current.test',
      model: 'current-model',
      taskId: 'retry-task',
    });
    const failed = await retry.forceCompact();
    expect(failed.ok).toBe(false);
    expect(retry.getTask()?.getExecutionRoundState()).toBe('suspended');
    // The suspended Conversation accepts a new execution round.
    const continued = await retry.continuePaused();
    expect(continued.ok).toBe(true);
    expect(retry.getTask()?.getExecutionRoundState()).toBe('running');
  });

  it('injects the performance catalog at task start and refreshes it on fingerprint change', async () => {
    let fingerprint = 'fp-v1';
    const resolver = {
      resolve: async () => ({
        ok: true as const,
        value: { fingerprint, catalog: { ...EMPTY_CATALOG, characters: [{ characterId: 'soyo', name: 'Soyo', motions: ['angry01'], expressions: ['angry'], fieldLevelDegrade: false }] } },
      }),
    };
    const fresh = new ProjectAgentCoordinator({
      transport: capturingTransport([assistantWithTools([], 'ok'), assistantWithTools([], 'ok')]).transport,
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort: new InMemoryProjectAgentJournalPort(),
      contextWindow: 100_000,
      performanceCatalog: resolver,
    });
    await fresh.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene-cc',
      originalTaskText: 'Polish the scene',
      systemPrompt: `You are the agent. ${PROJECT_AGENT_CAPABILITY_CATALOG_SLOT}`,
      endpoint: 'e',
      model: 'm',
      taskId: 'catalog-task',
    });
    const systemText = () => JSON.stringify(fresh.getMessages()[0]!.content);
    expect(systemText()).not.toContain(PROJECT_AGENT_CAPABILITY_CATALOG_SLOT);
    expect(systemText()).toContain('angry01');
    fingerprint = 'fp-v2';
    await fresh.runModelTurn();
    expect(systemText()).toContain('angry01');
    const afterRefresh = systemText();
    // Unchanged fingerprint → no re-injection churn in the system message.
    await fresh.runModelTurn();
    expect(systemText()).toBe(afterRefresh);
    expect(JSON.stringify(fresh.getMessages())).not.toContain(PROJECT_AGENT_CAPABILITY_CATALOG_SLOT);
  });

  it('keeps the last injected catalog when the resolver fails without blocking', async () => {
    let fail = false;
    const resolver = {
      resolve: async () => fail
        ? { ok: false as const, code: 'scene_unavailable', message: 'no scene' }
        : { ok: true as const, value: { fingerprint: 'fp', catalog: EMPTY_CATALOG } },
    };
    const coordinator = new ProjectAgentCoordinator({
      transport: capturingTransport([assistantWithTools([], 'ok'), assistantWithTools([], 'ok')]).transport,
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort: new InMemoryProjectAgentJournalPort(),
      contextWindow: 100_000,
      performanceCatalog: resolver,
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene-cc',
      originalTaskText: 'Polish the scene',
      systemPrompt: `You are the agent. ${PROJECT_AGENT_CAPABILITY_CATALOG_SLOT}`,
      endpoint: 'e',
      model: 'm',
      taskId: 'catalog-fail',
    });
    const systemText = () => JSON.stringify(coordinator.getMessages()[0]!.content);
    expect(systemText()).not.toContain(PROJECT_AGENT_CAPABILITY_CATALOG_SLOT);
    fail = true;
    await coordinator.runModelTurn();
    expect(systemText()).not.toContain(PROJECT_AGENT_CAPABILITY_CATALOG_SLOT);
    expect(systemText()).toContain('characters');
    // Plain assistant text settled the round: idle, no terminal lifecycle.
    expect(coordinator.getTask()?.getLifecycle()).toBe('idle');
  });

  it('preserves host execution state and trusted receipts across compaction', async () => {
    const coordinator = await compactingCoordinator({ contextWindow: 12_000 });
    coordinator.getTask()?.recordVersionConflictRetry();
    coordinator.getTask()?.recordTransportRetry();
    const receipt = {
      status: 'committed' as const,
      version: 3,
      counts: {
        insertedStatements: 1,
        insertedCompanions: 0,
        updatedStatements: 0,
        updatedCompanions: 0,
        deletedLines: 0,
        movedLines: 0,
        reorderedCompanionGroups: 0,
        inserted: 1,
        updated: 0,
        deleted: 0,
        moved: 0,
      },
      warnings: [],
      outcomes: [{ kind: 'inserted' as const, statementId: 'st-1' }],
      changedObjects: [{ statementId: 'st-1', kind: 'inserted' as const }],
    };
    coordinator.getTask()?.recordCommittedWrite(receipt);
    const compact = await coordinator.forceCompact();
    expect(compact.ok).toBe(true);
    const after = coordinator.getTask()!;
    // Correctness state survives compaction: counters are never reset.
    expect(after.getCounters().versionConflictRetryCount).toBe(1);
    expect(after.getCounters().transportRetryCount).toBe(1);
    expect(after.getCommittedWriteReceiptCount()).toBe(1);
    expect(after.getLifecycle()).toBe('running');
    // The summary does NOT embed full receipts or internal state.
    const summaryText = JSON.stringify(
      coordinator.getMessages().find((m) => m.role === 'user'
        && m.content.some((b) => b.type === 'text' && b.text.includes('Continuation summary'))),
    );
    expect(summaryText).toContain('Continuation summary');
    expect(summaryText).toContain('AgentConversationSummaryV1');
    expect(summaryText).not.toContain('lineMap');
  });

  it('runs many turns without any cumulative budget or tool-loop cap', async () => {
    const turns = Array.from({ length: 6 }, () => (
      assistantWithTools([{ status: 'ready', toolCallId: 't', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } }], 'keep going')
    ));
    turns.push(assistantText('done'));
    const summarizerTransport = capturingTransport([VALID_SUMMARY_JSON]);
    const main = capturingTransport(turns);
    const coordinator = new ProjectAgentCoordinator({
      transport: main.transport,
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort: new InMemoryProjectAgentJournalPort(),
      contextWindow: 100_000,
      continuationSummarizer: new ModelProjectAgentContinuationSummarizer({
        transport: summarizerTransport.transport,
      }),
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene-cc',
      originalTaskText: 'Polish the scene',
      systemPrompt: 'You are the project agent.',
      endpoint: 'e',
      model: 'm',
      taskId: 'no-budgets',
    });
    for (let i = 0; i < 7; i += 1) {
      const turn = await coordinator.runModelTurn();
      if (i === 6) expect(turn.status).toBe('settled');
    }
    expect(coordinator.getTask()?.getLifecycle()).toBe('idle');
    expect(main.requests.length).toBeGreaterThanOrEqual(7);
  });
});

describe('ProjectAgentService compaction composition', () => {
  const SCENE_DOCUMENT_ID = 'scene-doc-7';
  const SCENE_ENTRY_ID = 'scene-entry-42';
  const PROJECT_ID = 'project-abc';
  const TASK_ID = 'task-cc-1';

  interface Harness {
    service: ProjectAgentService;
    requests: AiConversationRequest[];
    statuses: ProjectAgentTaskStatusPayload[];
    journalPort: InMemoryProjectAgentJournalPort;
    lease: InMemoryProjectAgentLeasePort;
  }

  function createServiceHarness(
    responses: Array<AiConversationResponse | Error | AiAssistantMessage>,
    options?: Partial<ProjectAgentServiceOptions>,
  ): Harness {
    const requests: AiConversationRequest[] = [];
    const transport: AiConversationTransport = {
      complete: async (request) => {
        requests.push(request);
        const next = responses.shift();
        if (!next) throw new Error('Unexpected transport call');
        if (next instanceof Error) throw next;
        return 'message' in next ? next : { message: next };
      },
    };
    const statuses: ProjectAgentTaskStatusPayload[] = [];
    const lease = new InMemoryProjectAgentLeasePort();
    const journalPort = new InMemoryProjectAgentJournalPort();
    const host: ProjectAgentMainHost = {
      beginTask: async (request) => ({ ok: true, taskId: request.taskId }),
      acquireLease: (projectId, taskId) => lease.tryAcquire(projectId, taskId),
      releaseLease: (token) => lease.release(token),
      getLeaseHolder: () => lease.getHolder(),
      journalLoad: (projectId, taskId) => journalPort.load(projectId, taskId),
      journalSave: async (record) => {
        await journalPort.save(record);
        return { kind: 'saved' };
      },
      journalListByProject: (projectId) => journalPort.listByProject(projectId),
      publishTaskStatus: (status) => { statuses.push(status); return true; },
      getTaskStatus: async () => null,
      acknowledgeReport: async () => ({ ok: true }),
      publishProjectContext: async () => undefined,
      getProjectContext: async () => null,
      publishStartResult: async () => undefined,
    };
    const document = makeDocument('huge scene payload '.repeat(5000));
    const service = new ProjectAgentService({
      transport,
      host,
      readPorts: {
        overview: { getOverview: () => ({ name: 'P', projectVersion: 1, scenes: [], assetRoots: {} }) },
        files: { listFiles: () => [] },
        text: { readText: () => ({ lines: ['x'], binary: false }) },
        textSearch: { searchText: () => [] },
        resources: { searchResources: () => [] },
        resourceInspect: { inspectResource: () => ({ exists: true, reference: 'x', scope: 'project', bindable: true }) },
        scene: { getSnapshot: () => ({ document, version: 1 }) },
        validation: { validate: () => [] },
      },
      writePorts: {
        scene: { getSnapshot: () => ({ document, version: 1 }) },
        validation: { validate: () => [] },
        authoring: { commit: () => ({ version: 1 }) },
      },
      systemPrompt: buildProjectAgentSystemPrompt({ baseSystemPrompt: 'You are the project agent.' }),
      admission: {
        resolve: async () => ({
          ok: true,
          endpoint: 'https://provider.test',
          model: 'agent-model',
        }),
      },
      resolveTargetIdentity: () => ({
        ok: true,
        projectId: PROJECT_ID,
        sceneEntryId: SCENE_ENTRY_ID,
        sceneDocumentId: SCENE_DOCUMENT_ID,
        sceneName: 'Scene',
      }),
      idFactory: () => TASK_ID,
      now: () => 1000,
      ...options,
    });
    return { service, requests, statuses, journalPort, lease };
  }

  it('compacts mid-run through the production summarizer with the current model', async () => {
    const harness = createServiceHarness([
      assistantWithTools([{ status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 5000 } }], 'reading'),
      {
        message: assistantText(JSON.stringify({
          version: 1,
          objective: 'Finish polishing the scene',
          importantDetails: ['the scene is huge'],
          workState: {
            completed: ['read the scene'],
            active: ['polishing dialogue'],
            nextMove: ['re-read and finish'],
          },
          relevantFiles: [],
        })),
      },
      assistantText('done'),
    ], { contextWindow: 20_000 });
    const started = await harness.service.start({ taskText: 'Polish the scene' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();
    expect(harness.service.getTaskSnapshot()?.getLifecycle()).toBe('idle');

    const summaryRequest = harness.requests.find((request) => request.tools === undefined);
    expect(summaryRequest).toBeDefined();
    expect(summaryRequest!.endpoint).toBe('https://provider.test');
    expect(summaryRequest!.model).toBe('agent-model');
    expect(summaryRequest!.stream).toBe(false);
    expect(summaryRequest!.responseFormat).toEqual({ type: 'json_object' });
    const mainRequests = harness.requests.filter((request) => request.tools !== undefined);
    expect(mainRequests.length).toBe(2);
    const compacted = mainRequests[1]!.messages;
    expect(JSON.stringify(compacted)).toContain('Continuation summary');
    expect(JSON.stringify(compacted)).toContain('AgentConversationSummaryV1');
    expect(JSON.stringify(compacted)).not.toContain('huge scene payload');
  });

  it('injects the catalog at task start and refreshes it after resume', async () => {
    let fingerprint = 'fp-1';
    let resolvedCount = 0;
    const resolver = {
      resolve: async () => {
        resolvedCount += 1;
        return {
          ok: true as const,
          value: { fingerprint, catalog: { ...EMPTY_CATALOG, characters: [{ characterId: 'soyo', name: 'Soyo', motions: ['angry01'], expressions: [], fieldLevelDegrade: false }] } },
        };
      },
    };
    const harness = createServiceHarness(
      [
        assistantWithTools([{ status: 'ready', toolCallId: 'c1', name: 'updateStatement', arguments: { line: 1, patch: { params: { text: 'Hello' } } } }], 'writing'),
        assistantText('done'),
        assistantWithTools([{ status: 'ready', toolCallId: 'c2', name: 'updateStatement', arguments: { line: 1, patch: { params: { text: 'Again' } } } }], 'writing'),
        assistantText('done'),
      ],
      { performanceCatalog: resolver },
    );
    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.whenIdle();
    const firstRequest = harness.requests[0]!;
    const firstSystem = firstRequest.messages[0]!;
    expect(JSON.stringify(firstSystem.content)).toContain('angry01');
    expect(JSON.stringify(firstSystem.content)).not.toContain(PROJECT_AGENT_CAPABILITY_CATALOG_SLOT);

    // Pause → fingerprint changes → resume must inject the fresh catalog.
    fingerprint = 'fp-2';
    const paused = await harness.service.pause('user_requested');
    expect(paused.ok).toBe(true);
    const resumed = await harness.service.continueTask();
    expect(resumed.ok).toBe(true);
    await harness.service.whenIdle();
    const afterResume = harness.requests.at(-1)!;
    expect(JSON.stringify(afterResume.messages[0]!.content)).toContain('angry01');
    expect(resolvedCount).toBeGreaterThan(1);
  });
});

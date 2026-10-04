import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AI_CAPABILITY_PROBE_NONCE,
  AI_CAPABILITY_SENTINEL_TOOL_NAME,
} from '../services/ai-conversation/ProjectAgentCapabilityProbe';
import type { AiConversationRequest, AiConversationResponse, JsonObject } from '../api/types/ai-conversation';
import type { AiConversationTransport } from '../services/ai-authoring/AiConversationTransport';
import type { StandaloneAgentProviderConfig } from '../services/project-agent-standalone/StandaloneProjectAgentEngine';
import {
  createStandaloneProjectAgentBenchmarkSamplePort,
} from '../services/project-agent-standalone/StandaloneProjectAgentBenchmarkSamplePort';
import { createProjectAgentBenchmarkScene } from '../services/project-agent-benchmark/ProjectAgentBenchmarkFixture';

const PROVIDER: StandaloneAgentProviderConfig = {
  endpoint: 'https://ai.example.test/v1',
  defaultModel: 'default-model',
};

function isCapabilityProbe(request: AiConversationRequest): boolean {
  return (request.tools ?? []).length === 0
    || request.tools!.some((tool) => tool.name === AI_CAPABILITY_SENTINEL_TOOL_NAME);
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function assistantTextWithUsage(text: string, usage: Usage): AiConversationResponse {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
    usage,
  };
}

function assistantToolsWithUsage(
  calls: readonly { name: string; arguments: JsonObject }[],
  usage: Usage,
): AiConversationResponse {
  return {
    message: {
      role: 'assistant',
      content: [],
      toolCalls: calls.map((call, index) => ({
        status: 'ready' as const,
        toolCallId: `call-${index + 1}`,
        name: call.name,
        arguments: call.arguments,
      })),
    },
    usage,
  };
}

function createScriptedTransport(
  script: readonly (() => AiConversationResponse)[],
): AiConversationTransport & { readonly totalRequests: number; readonly businessRequests: number } {
  let index = 0;
  let totalRequests = 0;
  let businessRequests = 0;
  return {
    get totalRequests() {
      return totalRequests;
    },
    get businessRequests() {
      return businessRequests;
    },
    async complete(request: AiConversationRequest): Promise<AiConversationResponse> {
      totalRequests += 1;
      if (isCapabilityProbe(request)) {
        const isToolProbe = (request.tools ?? []).some(
          (tool) => tool.name === AI_CAPABILITY_SENTINEL_TOOL_NAME,
        );
        if (isToolProbe) {
          return assistantToolsWithUsage(
            [
              {
                name: AI_CAPABILITY_SENTINEL_TOOL_NAME,
                arguments: { nonce: AI_CAPABILITY_PROBE_NONCE },
              },
            ],
            { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          );
        }
        return assistantTextWithUsage('a tiny test image', { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
      }
      businessRequests += 1;
      const responder = script[Math.min(index, script.length - 1)];
      index += 1;
      return responder();
    },
  };
}

function dialogueText(document: unknown, statementId: string): string | undefined {
  const candidate = document as { statements?: readonly { id?: string; params?: { text?: string } }[] };
  const statement = candidate.statements?.find((item) => item.id === statementId);
  return statement?.params?.text;
}

const baseDirs: string[] = [];

function freshBaseTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-port-base-'));
  baseDirs.push(dir);
  return dir;
}

function residualBenchmarkDirs(baseTmpDir: string): string[] {
  return fs.readdirSync(baseTmpDir).filter((name) => name.startsWith('aeon-agent-benchmark-'));
}

beforeEach(() => {
  baseDirs.length = 0;
});

afterEach(() => {
  for (const dir of baseDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('StandaloneProjectAgentBenchmarkSamplePort.runTask', () => {
  it('writes scene, applies the write, projects rounds with usage/resultCodes/writeCount, and bumps version', async () => {
    const baseTmpDir = freshBaseTmpDir();
    const transport = createScriptedTransport([
      () => assistantToolsWithUsage(
        [{ name: 'readScene', arguments: { startLine: 1, lineCount: 500 } }],
        { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      ),
      () => assistantToolsWithUsage(
        [
          {
            name: 'updateStatement',
            arguments: {
              statementId: 'dlg_update_target',
              patch: { params: { text: '森林深处的回响' } },
            },
          },
        ],
        { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
      ),
      () => assistantTextWithUsage('完成', { inputTokens: 30, outputTokens: 6, totalTokens: 36 }),
    ]);
    const port = createStandaloneProjectAgentBenchmarkSamplePort({
      provider: PROVIDER,
      transport,
      baseTmpDir,
    });

    const execution = await port.runTask({
      runIndex: 0,
      taskId: 'singleUpdate',
      fixture: createProjectAgentBenchmarkScene(),
      canStartNextRound: () => true,
    });

    expect(dialogueText(execution.document, 'dlg_update_target')).toBe('森林深处的回响');
    // One committed write during the task: exactly one version increase (the
    // open() snapshot bump is not part of the task).
    expect(execution.documentVersionIncrease).toBe(1);
    expect(execution.rounds.length).toBeGreaterThan(0);

    for (const round of execution.rounds) {
      expect(Array.isArray(round.toolNameSequence)).toBe(true);
      expect(Array.isArray(round.resultCodes)).toBe(true);
      expect(typeof round.writeCount).toBe('number');
      expect(typeof round.versionConflictCount).toBe('number');
    }

    // Three business rounds: readScene, updateStatement, final text reply.
    // Their usages come from the corresponding business response, not the probes.
    expect(execution.rounds).toHaveLength(3);
    expect(execution.rounds[0]!.usage?.inputTokens).toBe(10);
    expect(execution.rounds[0]!.usage?.outputTokens).toBe(2);
    expect(execution.rounds[1]!.usage?.inputTokens).toBe(20);
    expect(execution.rounds[1]!.usage?.outputTokens).toBe(4);
    expect(execution.rounds[2]!.usage?.inputTokens).toBe(30);
    expect(execution.rounds[2]!.usage?.outputTokens).toBe(6);
    expect(execution.rounds[2]!.usage?.totalTokens).toBe(36);

    // readScene and updateStatement are separate tool rounds; the text reply is the terminal round.
    expect(execution.rounds[0]!.toolNameSequence).toEqual(['readScene']);
    expect(execution.rounds[1]!.toolNameSequence).toEqual(['updateStatement']);
    expect(execution.rounds[2]!.toolNameSequence).toEqual([]);

    // First-read cost comes from the readScene round only.
    expect(execution.firstReadTokens).toBe(12);

    // Two capability probes ran before the business requests and are reported
    // separately, never as task tokens.
    expect(execution.capabilityProbe).toEqual({ requestCount: 2, inputTokens: 2, outputTokens: 2 });

    // updateStatement is a real write: ok:true, so writeCount is 1 (mixed with reads is fine).
    expect(execution.rounds[1]!.writeCount).toBeGreaterThanOrEqual(1);
    expect(execution.rounds[2]!.writeCount).toBe(0);

    await port.cleanup();
  });

  it('leaves the scene untouched and reports a single open version bump for a zero-write task', async () => {
    const baseTmpDir = freshBaseTmpDir();
    const transport = createScriptedTransport([
      () => assistantTextWithUsage('当前场景无需修改。', { inputTokens: 5, outputTokens: 1, totalTokens: 6 }),
    ]);
    const port = createStandaloneProjectAgentBenchmarkSamplePort({
      provider: PROVIDER,
      transport,
      baseTmpDir,
    });

    const execution = await port.runTask({
      runIndex: 0,
      taskId: 'singleUpdate',
      fixture: createProjectAgentBenchmarkScene(),
      canStartNextRound: () => true,
    });

    expect(execution.documentVersionIncrease).toBe(0);
    expect(execution.rounds).toHaveLength(1);
    expect(dialogueText(execution.document, 'dlg_update_target')).toBe('Update this line.');
    expect(execution.rounds[0]!.writeCount).toBe(0);
    expect(execution.rounds[0]!.toolNameSequence).toEqual([]);

    await port.cleanup();
  });

  it('is idempotent: cleanup twice does not throw and removes the temp project', async () => {
    const baseTmpDir = freshBaseTmpDir();
    const transport = createScriptedTransport([
      () => assistantTextWithUsage('完成', { inputTokens: 5, outputTokens: 1, totalTokens: 6 }),
    ]);
    const port = createStandaloneProjectAgentBenchmarkSamplePort({
      provider: PROVIDER,
      transport,
      baseTmpDir,
    });

    await port.runTask({
      runIndex: 0,
      taskId: 'singleUpdate',
      fixture: createProjectAgentBenchmarkScene(),
      canStartNextRound: () => true,
    });

    expect(residualBenchmarkDirs(baseTmpDir).length).toBe(1);

    await port.cleanup();
    await expect(port.cleanup()).resolves.toBeUndefined();
    expect(residualBenchmarkDirs(baseTmpDir)).toEqual([]);
  });

  it("excludes capability probes from rounds: rounds length equals business request count", async () => {
    const baseTmpDir = freshBaseTmpDir();
    const transport = createScriptedTransport([
      () => assistantTextWithUsage('完成', { inputTokens: 5, outputTokens: 1, totalTokens: 6 }),
    ]);
    const port = createStandaloneProjectAgentBenchmarkSamplePort({
      provider: PROVIDER,
      transport,
      baseTmpDir,
    });

    const execution = await port.runTask({
      runIndex: 0,
      taskId: 'singleUpdate',
      fixture: createProjectAgentBenchmarkScene(),
      canStartNextRound: () => true,
    });

    // Two capability probes always run before the single business request.
    expect(transport.totalRequests).toBeGreaterThan(2);
    expect(transport.businessRequests).toBe(1);
    expect(execution.rounds).toHaveLength(transport.businessRequests);

    await port.cleanup();
  });

  it('throws on engine open failure so the runner records run_failed, then cleanup stays idempotent', async () => {
    const baseTmpDir = freshBaseTmpDir();
    const port = createStandaloneProjectAgentBenchmarkSamplePort({
      provider: PROVIDER,
      baseTmpDir,
    });
    // runTask with a fixture that is not a valid scene document forces open() to fail.
    await expect(port.runTask({
      runIndex: 0,
      taskId: 'singleUpdate',
      fixture: { schemaVersion: 999, sceneId: 'x' } as never,
      canStartNextRound: () => true,
    })).rejects.toThrow();
    await expect(port.cleanup()).resolves.toBeUndefined();
    expect(residualBenchmarkDirs(baseTmpDir)).toEqual([]);
  });
});

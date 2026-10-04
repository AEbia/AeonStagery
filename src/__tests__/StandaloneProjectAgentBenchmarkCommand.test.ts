import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';
import { PROJECT_AGENT_BENCHMARK_EXIT } from '../services/project-agent-benchmark/ProjectAgentBenchmarkCli';
import { PROJECT_AGENT_BENCHMARK_TASKS, createProjectAgentBenchmarkScene } from '../services/project-agent-benchmark/ProjectAgentBenchmarkFixture';
import type { ProjectAgentBenchmarkSamplePort } from '../services/project-agent-benchmark/ProjectAgentBenchmarkRunner';
import { PROJECT_AGENT_BENCHMARK_SOURCE_IDENTITY_PROTOCOL_VERSION } from '../services/project-agent-benchmark/ProjectAgentBenchmarkTypes';
import {
  runStandaloneProjectAgentBenchmarkPhase,
} from '../services/project-agent-standalone/StandaloneProjectAgentBenchmarkCommand';
import {
  createStandaloneProjectAgentBenchmarkSamplePort,
} from '../services/project-agent-standalone/StandaloneProjectAgentBenchmarkSamplePort';
import type { StandaloneAgentProviderConfig } from '../services/project-agent-standalone/StandaloneProjectAgentEngine';
import type { AiConversationRequest, AiConversationResponse, JsonObject } from '../api/types/ai-conversation';
import { AI_CAPABILITY_PROBE_NONCE, AI_CAPABILITY_SENTINEL_TOOL_NAME } from '../services/ai-conversation/ProjectAgentCapabilityProbe';
import type { AiConversationTransport } from '../services/ai-authoring/AiConversationTransport';

const PROVIDER: StandaloneAgentProviderConfig = {
  endpoint: 'https://ai.example.test/v1',
  defaultModel: 'default-model',
};

const PHASE_ARGS = {
  phase: 'candidate' as const,
  runs: 1,
  tokenBudget: 100_000,
  output: '',
  overwrite: false,
  provider: PROVIDER,
};

function tmpArtifactPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-command-')), 'artifact.json');
}

const tempDirs: string[] = [];

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Port whose mutations pass every deterministic oracle; mirrors the runner
 * test's fake transport so the command-level exit mapping is exercised
 * without an engine.
 */
function oraclePassingPort(): ProjectAgentBenchmarkSamplePort {
  return {
    runTask: async ({ taskId, fixture }) => ({
      rounds: [
        {
          usage: { inputTokens: 10, outputTokens: 2 },
          toolNameSequence: ['readScene'],
          resultCodes: ['ok'],
          writeCount: 1,
          versionConflictCount: 0,
        },
      ],
      document: mutate(taskId, fixture),
      documentVersionIncrease: taskId === 'atomicBatch' ? 1 : 2,
      firstReadTokens: 12,
      capabilityProbe: { requestCount: 2, inputTokens: 2, outputTokens: 2 },
    }),
    cleanup: async () => undefined,
  };
}

describe('runStandaloneProjectAgentBenchmarkPhase', () => {
  it('writes an eligible artifact and exits 0 when all oracles pass', async () => {
    const output = tmpArtifactPath();
    tempDirs.push(path.dirname(output));
    const outcome = await runStandaloneProjectAgentBenchmarkPhase({
      ...PHASE_ARGS,
      output,
      createSample: async () => oraclePassingPort(),
    });

    expect(outcome.exitCode).toBe(PROJECT_AGENT_BENCHMARK_EXIT.success);
    expect(outcome.artifact.eligibility).toBe('eligible');
    expect(outcome.artifact.transportKind).toBe('provider');
    expect(outcome.artifact.identities.protocolVersion).toBe(PROJECT_AGENT_BENCHMARK_SOURCE_IDENTITY_PROTOCOL_VERSION);
    expect(outcome.artifact.identities.model).toBe(PROVIDER.defaultModel);
    expect(outcome.artifact.identities.runs).toBe(1);
    expect(outcome.artifact.identities.tokenBudget).toBe(100_000);
    expect(outcome.artifact.capabilityProbe).toEqual({ requestCount: 8, inputTokens: 8, outputTokens: 8 });
    expect(outcome.outputPath).toBe(path.resolve(output));
    expect(fs.existsSync(outcome.outputPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(outcome.outputPath, 'utf-8'));
    expect(onDisk).toEqual(outcome.artifact);
    // No prompt/scene/credential/endpoint content in the artifact.
    const serialized = JSON.stringify(onDisk);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toContain('Updated by benchmark.');
    expect(serialized).not.toContain('sk-');
  });

  it('refuses to replace an existing artifact unless overwrite is set', async () => {
    const output = tmpArtifactPath();
    tempDirs.push(path.dirname(output));
    const first = await runStandaloneProjectAgentBenchmarkPhase({
      ...PHASE_ARGS,
      output,
      createSample: async () => oraclePassingPort(),
    });
    expect(first.exitCode).toBe(PROJECT_AGENT_BENCHMARK_EXIT.success);

    const refused = await runStandaloneProjectAgentBenchmarkPhase({
      ...PHASE_ARGS,
      output,
      createSample: async () => oraclePassingPort(),
    });
    expect(refused.exitCode).toBe(PROJECT_AGENT_BENCHMARK_EXIT.configuration);
    expect(refused.writeError).toContain('already exists');

    const overwritten = await runStandaloneProjectAgentBenchmarkPhase({
      ...PHASE_ARGS,
      output,
      overwrite: true,
      createSample: async () => oraclePassingPort(),
    });
    expect(overwritten.exitCode).toBe(PROJECT_AGENT_BENCHMARK_EXIT.success);
  });

  it('maps oracle failure to exit 1', async () => {
    const output = tmpArtifactPath();
    tempDirs.push(path.dirname(output));
    const outcome = await runStandaloneProjectAgentBenchmarkPhase({
      ...PHASE_ARGS,
      output,
      createSample: async () => ({
        runTask: async ({ fixture }) => ({
          rounds: [{ usage: { inputTokens: 1, outputTokens: 1 }, toolNameSequence: [], resultCodes: [], writeCount: 0, versionConflictCount: 0 }],
          document: structuredClone(fixture),
          documentVersionIncrease: 1,
        }),
        cleanup: async () => undefined,
      }),
    });

    expect(outcome.exitCode).toBe(PROJECT_AGENT_BENCHMARK_EXIT.runOrOracleFailure);
    expect(outcome.artifact.eligibility).toBe('ineligible');
    expect(outcome.artifact.ineligibleReason).toBe('oracle_failed');
    expect(fs.existsSync(outcome.outputPath)).toBe(true);
  });

  it('maps phase budget exhaustion to exit 2 and keeps the ineligible artifact', async () => {
    const output = tmpArtifactPath();
    tempDirs.push(path.dirname(output));
    const outcome = await runStandaloneProjectAgentBenchmarkPhase({
      ...PHASE_ARGS,
      tokenBudget: 5,
      output,
      createSample: async () => ({
        runTask: async () => ({
          rounds: [{ usage: { inputTokens: 4, outputTokens: 2 }, toolNameSequence: [], resultCodes: [], writeCount: 0, versionConflictCount: 0 }],
          document: structuredClone(createProjectAgentBenchmarkScene()),
          documentVersionIncrease: 1,
        }),
        cleanup: async () => undefined,
      }),
    });

    expect(outcome.exitCode).toBe(PROJECT_AGENT_BENCHMARK_EXIT.budgetExhausted);
    expect(outcome.artifact.ineligibleReason).toBe('phase_budget_exhausted');
    expect(fs.existsSync(outcome.outputPath)).toBe(true);
  });

  it('maps missing provider usage to exit 3', async () => {
    const output = tmpArtifactPath();
    tempDirs.push(path.dirname(output));
    const outcome = await runStandaloneProjectAgentBenchmarkPhase({
      ...PHASE_ARGS,
      output,
      createSample: async () => ({
        runTask: async () => ({
          rounds: [{ usage: undefined, toolNameSequence: [], resultCodes: [], writeCount: 0, versionConflictCount: 0 }],
          document: structuredClone(createProjectAgentBenchmarkScene()),
          documentVersionIncrease: 1,
        }),
        cleanup: async () => undefined,
      }),
    });

    expect(outcome.exitCode).toBe(PROJECT_AGENT_BENCHMARK_EXIT.configuration);
    expect(outcome.artifact.ineligibleReason).toBe('usage_unavailable');
    expect(fs.existsSync(outcome.outputPath)).toBe(true);
  });

  it('drives the standalone engine sample port end to end and maps its outcome', async () => {
    const baseTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-command-base-'));
    tempDirs.push(baseTmpDir);
    const output = path.join(baseTmpDir, 'artifact.json');
    const transport = createScriptedTransport([
      () => assistantToolsWithUsage(
        [{ name: 'readScene', arguments: { startLine: 1, lineCount: 500 } }],
        { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      ),
      () => assistantToolsWithUsage(
        [{ name: 'updateStatement', arguments: { statementId: 'dlg_update_target', patch: { params: { text: 'Updated by benchmark.' } } } }],
        { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
      ),
      () => assistantTextWithUsage('完成', { inputTokens: 30, outputTokens: 6, totalTokens: 36 }),
    ]);

    const outcome = await runStandaloneProjectAgentBenchmarkPhase({
      ...PHASE_ARGS,
      output,
      createSample: async () => createStandaloneProjectAgentBenchmarkSamplePort({
        provider: PROVIDER,
        transport,
        baseTmpDir,
      }),
    });

    // Task 1 (singleUpdate) passes the oracle through the real engine; the
    // scripted transport then runs dry on the remaining tasks, so the phase
    // is ineligible with an oracle failure and exit 1.
    expect(outcome.exitCode).toBe(PROJECT_AGENT_BENCHMARK_EXIT.runOrOracleFailure);
    expect(outcome.artifact.ineligibleReason).toBe('oracle_failed');
    expect(outcome.artifact.samples[0]?.tasks[0]?.oraclePassed).toBe(true);
    expect(outcome.artifact.samples[0]?.tasks[0]?.totalTokens).toBe(72);
    expect(outcome.artifact.samples[0]?.tasks[0]?.firstReadTokens).toBe(12);
    expect(outcome.artifact.capabilityProbe.requestCount).toBeGreaterThan(0);
    expect(fs.existsSync(outcome.outputPath)).toBe(true);
    // Every sample temp project is cleaned up.
    expect(fs.readdirSync(baseTmpDir).filter((name) => name.startsWith('aeon-agent-benchmark-'))).toEqual([]);
  });
});

function mutate(taskId: keyof typeof PROJECT_AGENT_BENCHMARK_TASKS, source: CurrentSceneDocument): CurrentSceneDocument {
  const next = structuredClone(source);
  if (taskId === 'singleUpdate') updateText(next, 'dlg_update_target', PROJECT_AGENT_BENCHMARK_TASKS.singleUpdate.expectedText);
  if (taskId === 'insertThenUpdate') next.statements.push({ id: 'generated', time: 80, type: 'dialogue', params: { speakerId: 'tomori', text: PROJECT_AGENT_BENCHMARK_TASKS.insertThenUpdate.expectedText, durationSeconds: 2 } });
  if (taskId === 'deleteThenUpdateDownstream') {
    next.statements = next.statements.filter((item) => item.id !== 'cam_delete_target');
    updateText(next, 'dlg_downstream', PROJECT_AGENT_BENCHMARK_TASKS.deleteThenUpdateDownstream.expectedText);
  }
  if (taskId === 'atomicBatch') {
    updateText(next, 'dlg_batch_target', PROJECT_AGENT_BENCHMARK_TASKS.atomicBatch.expectedText);
    const camera = next.statements.find((item) => item.id === 'cam_batch_target');
    if (camera) camera.time = PROJECT_AGENT_BENCHMARK_TASKS.atomicBatch.expectedCameraTime;
  }
  return next;
}

function updateText(document: CurrentSceneDocument, id: string, text: string): void {
  const statement = document.statements.find((item) => item.id === id);
  if (statement?.type === 'dialogue') statement.params = { ...statement.params, text };
}

/* ------------------------------------------------------------------------ *
 * Scripted transport (mirrors the sample-port test helpers).
 * ------------------------------------------------------------------------ */

function isCapabilityProbe(request: AiConversationRequest): boolean {
  return (request.tools ?? []).length === 0
    || request.tools!.some((tool) => tool.name === AI_CAPABILITY_SENTINEL_TOOL_NAME);
}

function assistantTextWithUsage(text: string, usage: { inputTokens: number; outputTokens: number; totalTokens: number }): AiConversationResponse {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
    usage,
  };
}

function assistantToolsWithUsage(
  calls: readonly { name: string; arguments: JsonObject }[],
  usage: { inputTokens: number; outputTokens: number; totalTokens: number },
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
): AiConversationTransport {
  let index = 0;
  return {
    async complete(request: AiConversationRequest): Promise<AiConversationResponse> {
      if (isCapabilityProbe(request)) {
        const isToolProbe = (request.tools ?? []).some(
          (tool) => tool.name === AI_CAPABILITY_SENTINEL_TOOL_NAME,
        );
        if (isToolProbe) {
          return assistantToolsWithUsage(
            [{ name: AI_CAPABILITY_SENTINEL_TOOL_NAME, arguments: { nonce: AI_CAPABILITY_PROBE_NONCE } }],
            { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          );
        }
        return assistantTextWithUsage('a tiny test image', { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
      }
      const responder = script[Math.min(index, script.length - 1)];
      index += 1;
      return responder();
    },
  };
}

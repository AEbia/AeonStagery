import { describe, expect, it } from 'vitest';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';
import { runProjectAgentBenchmark } from '../services/project-agent-benchmark/ProjectAgentBenchmarkRunner';
import { PROJECT_AGENT_BENCHMARK_TASKS } from '../services/project-agent-benchmark/ProjectAgentBenchmarkFixture';

describe('Project Agent benchmark runner', () => {
  it('keeps fake transport ineligible while collecting all deterministic oracle outcomes and cleaning every sample', async () => {
    let cleanupCount = 0;
    const artifact = await runProjectAgentBenchmark({
      phase: 'baseline', runs: 1, tokenBudget: 10_000, model: 'fake', protocolVersion: 'line-v1', toolsetVersion: 3,
      transportKind: 'fake',
      createSample: async () => ({
        runTask: async ({ taskId, fixture }) => ({
          rounds: [{ usage: { inputTokens: 3, outputTokens: 2 }, toolNameSequence: ['readScene'], resultCodes: ['ok'], writeCount: 1, versionConflictCount: 0 }],
          document: mutate(taskId, fixture),
          documentVersionIncrease: taskId === 'atomicBatch' ? 1 : 2,
          firstReadTokens: 3,
          capabilityProbe: { requestCount: 2, inputTokens: 2, outputTokens: 2 },
        }),
        cleanup: async () => { cleanupCount += 1; },
      }),
    });
    expect(artifact.eligibility).toBe('ineligible');
    expect(artifact.ineligibleReason).toBe('fake_transport');
    expect(artifact.samples[0]?.tasks).toHaveLength(4);
    expect(artifact.samples[0]?.tasks.every((task) => task.oraclePassed)).toBe(true);
    expect(cleanupCount).toBe(4);
    // Per-execution capability probes are accumulated into the phase report.
    expect(artifact.capabilityProbe).toEqual({ requestCount: 8, inputTokens: 8, outputTokens: 8 });
  });

  it('retains completed partial work, then stops before dispatching another sample when budget is exhausted', async () => {
    let calls = 0;
    const artifact = await runProjectAgentBenchmark({
      phase: 'baseline', runs: 2, tokenBudget: 5, model: 'provider', protocolVersion: 'line-v1', toolsetVersion: 3,
      transportKind: 'provider',
      createSample: async () => ({
        runTask: async ({ taskId, fixture }) => {
          calls += 1;
          return {
            rounds: [{ usage: { inputTokens: 4, outputTokens: 2 }, toolNameSequence: [], resultCodes: [], writeCount: 1, versionConflictCount: 0 }],
            document: mutate(taskId, fixture), documentVersionIncrease: taskId === 'atomicBatch' ? 1 : 2,
          };
        },
        cleanup: async () => undefined,
      }),
    });
    expect(calls).toBe(1);
    expect(artifact.ineligibleReason).toBe('phase_budget_exhausted');
    expect(artifact.samples[0]?.tasks).toHaveLength(1);
    expect(artifact.spentTaskTokens).toBe(6);
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

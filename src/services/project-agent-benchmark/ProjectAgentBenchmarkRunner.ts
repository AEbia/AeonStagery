import {
  PROJECT_AGENT_BENCHMARK_TASKS,
  createProjectAgentBenchmarkScene,
  hashProjectAgentBenchmarkFixture,
  hashProjectAgentBenchmarkTasks,
  type ProjectAgentBenchmarkTaskId,
} from './ProjectAgentBenchmarkFixture';
import { judgeProjectAgentBenchmarkScene } from './ProjectAgentBenchmarkOracles';
import { ProjectAgentBenchmarkBudget, type ProjectAgentBenchmarkUsage } from './ProjectAgentBenchmarkUsage';
import {
  PROJECT_AGENT_BENCHMARK_ARTIFACT_VERSION,
  type ProjectAgentBenchmarkArtifact,
  type ProjectAgentBenchmarkIneligibleReason,
  type ProjectAgentBenchmarkRequestRecord,
  type ProjectAgentBenchmarkSampleRecord,
  type ProjectAgentBenchmarkTaskAggregate,
  type ProjectAgentBenchmarkTaskRecord,
  type ProjectAgentBenchmarkTransportKind,
} from './ProjectAgentBenchmarkTypes';
import type { ProjectAgentBenchmarkPhaseName } from './ProjectAgentBenchmarkCli';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';

export interface ProjectAgentBenchmarkRound {
  readonly usage?: ProjectAgentBenchmarkUsage;
  readonly toolNameSequence: readonly string[];
  readonly resultCodes: readonly string[];
  readonly writeCount: number;
  readonly versionConflictCount: number;
}

export interface ProjectAgentBenchmarkTaskExecution {
  readonly rounds: readonly ProjectAgentBenchmarkRound[];
  readonly document: CurrentSceneDocument;
  readonly documentVersionIncrease: number;
  readonly firstReadTokens?: number;
  /** Capability probe usage performed by this sample, reported separately. */
  readonly capabilityProbe?: { readonly requestCount: number; readonly inputTokens: number; readonly outputTokens: number };
}

/**
 * The Electron host supplies this port. It owns fixture copying, its private
 * journal and a benchmark-only lease. This module deliberately never sees a
 * provider request, prompt, credential, endpoint or project path.
 */
export interface ProjectAgentBenchmarkSamplePort {
  runTask(input: {
    readonly runIndex: number;
    readonly taskId: ProjectAgentBenchmarkTaskId;
    readonly fixture: CurrentSceneDocument;
    readonly canStartNextRound: () => boolean;
  }): Promise<ProjectAgentBenchmarkTaskExecution>;
  cleanup(): Promise<void>;
}

export interface ProjectAgentBenchmarkRunnerOptions {
  readonly phase: ProjectAgentBenchmarkPhaseName;
  readonly runs: number;
  readonly tokenBudget: number;
  readonly model: string;
  readonly protocolVersion: string;
  readonly toolsetVersion: number;
  readonly transportKind: ProjectAgentBenchmarkTransportKind;
  readonly capabilityProbe?: { readonly requestCount: number; readonly inputTokens: number; readonly outputTokens: number };
  readonly createSample: () => Promise<ProjectAgentBenchmarkSamplePort>;
}

const TASK_IDS = Object.keys(PROJECT_AGENT_BENCHMARK_TASKS) as ProjectAgentBenchmarkTaskId[];

export async function runProjectAgentBenchmark(
  options: ProjectAgentBenchmarkRunnerOptions,
): Promise<ProjectAgentBenchmarkArtifact> {
  const budget = new ProjectAgentBenchmarkBudget(options.tokenBudget);
  const samples: ProjectAgentBenchmarkSampleRecord[] = [];
  let failure: ProjectAgentBenchmarkIneligibleReason | undefined;

  // Per-execution probe usage accumulates unless the caller supplied an
  // explicit phase-level probe record (fake-transport harness tests).
  const probeAccumulator = { requestCount: 0, inputTokens: 0, outputTokens: 0 };

  let stopped = false;
  for (let runIndex = 0; runIndex < options.runs && !stopped; runIndex += 1) {
    const tasks: ProjectAgentBenchmarkTaskRecord[] = [];
    for (const taskId of TASK_IDS) {
      if (!budget.canStartNextRound()) {
        failure = budget.state === 'usage_unavailable' ? 'usage_unavailable' : 'phase_budget_exhausted';
        stopped = true;
        break;
      }
      const port = await options.createSample().catch(() => null);
      if (!port) {
        failure = 'isolation';
        stopped = true;
        break;
      }
      try {
        const baseline = createProjectAgentBenchmarkScene();
        const execution = await port.runTask({
          runIndex,
          taskId,
          fixture: structuredClone(baseline),
          canStartNextRound: () => budget.canStartNextRound(),
        });
        if (execution.capabilityProbe) {
          probeAccumulator.requestCount += execution.capabilityProbe.requestCount;
          probeAccumulator.inputTokens += execution.capabilityProbe.inputTokens;
          probeAccumulator.outputTokens += execution.capabilityProbe.outputTokens;
        }
        const requests = execution.rounds.map((round) => {
          budget.recordCompletedRound(round.usage);
          return requestRecord(round);
        });
        const oracle = judgeProjectAgentBenchmarkScene({
          taskId,
          baseline,
          actual: execution.document,
          documentVersionIncrease: execution.documentVersionIncrease,
        });
        tasks.push({
          taskId,
          oraclePassed: oracle.passed,
          ...(oracle.reason ? { oracleReason: oracle.reason } : {}),
          modelRounds: requests.length,
          ...(execution.firstReadTokens === undefined ? {} : { firstReadTokens: execution.firstReadTokens }),
          totalTokens: requests.reduce((total, request) => total + request.inputTokens + request.outputTokens, 0),
          documentVersionIncrease: execution.documentVersionIncrease,
          requests,
        });
        if (!oracle.passed) failure = 'oracle_failed';
        if (budget.state === 'usage_unavailable') {
          failure = 'usage_unavailable';
          stopped = true;
          break;
        }
        if (budget.state === 'exhausted' && (runIndex !== options.runs - 1 || taskId !== TASK_IDS.at(-1))) {
          failure = 'phase_budget_exhausted';
          stopped = true;
          break;
        }
      } catch {
        failure = 'run_failed';
        stopped = true;
        break;
      } finally {
        await port.cleanup().catch(() => { failure ??= 'isolation'; });
      }
    }
    samples.push({ runIndex, tasks });
  }

  const aggregate = aggregateSamples(samples);
  const incomplete = samples.length !== options.runs || samples.some((sample) => sample.tasks.length !== TASK_IDS.length);
  const ineligibleReason = options.transportKind === 'fake'
    ? 'fake_transport'
    : failure ?? (incomplete ? 'run_failed' : undefined);
  return {
    version: PROJECT_AGENT_BENCHMARK_ARTIFACT_VERSION,
    phase: options.phase,
    eligibility: ineligibleReason ? 'ineligible' : 'eligible',
    ...(ineligibleReason ? { ineligibleReason } : {}),
    transportKind: options.transportKind,
    identities: {
      model: options.model,
      protocolVersion: options.protocolVersion,
      toolsetVersion: options.toolsetVersion,
      fixtureHash: hashProjectAgentBenchmarkFixture(),
      taskHash: hashProjectAgentBenchmarkTasks(),
      runs: options.runs,
      tokenBudget: options.tokenBudget,
    },
    capabilityProbe: options.capabilityProbe ?? probeAccumulator,
    spentTaskTokens: budget.spentTokens,
    cache: cacheStats(samples),
    samples,
    aggregates: aggregate,
  };
}

function requestRecord(round: ProjectAgentBenchmarkRound): ProjectAgentBenchmarkRequestRecord {
  return {
    inputTokens: round.usage?.inputTokens ?? 0,
    outputTokens: round.usage?.outputTokens ?? 0,
    ...(round.usage?.cachedInputTokens === undefined ? {} : { cachedInputTokens: round.usage.cachedInputTokens }),
    toolNameSequence: [...round.toolNameSequence],
    resultCodes: [...round.resultCodes],
    writeCount: round.writeCount,
    versionConflictCount: round.versionConflictCount,
  };
}

function aggregateSamples(samples: readonly ProjectAgentBenchmarkSampleRecord[]): ProjectAgentBenchmarkArtifact['aggregates'] {
  const perTask = Object.fromEntries(TASK_IDS.map((taskId) => [taskId, aggregateTask(samples.flatMap((sample) => sample.tasks.filter((task) => task.taskId === taskId)))])) as Record<ProjectAgentBenchmarkTaskId, ProjectAgentBenchmarkTaskAggregate>;
  const all = samples.flatMap((sample) => sample.tasks);
  const successful = all.filter((task) => task.oraclePassed);
  return {
    perTask,
    allSampleTokens: all.reduce((total, task) => total + task.totalTokens, 0),
    successfulSampleTokens: successful.reduce((total, task) => total + task.totalTokens, 0),
    equalWeightMedian: median(TASK_IDS.map((taskId) => perTask[taskId].medianTotalTokens).filter((value): value is number => value !== null)),
  };
}

function aggregateTask(tasks: readonly ProjectAgentBenchmarkTaskRecord[]): ProjectAgentBenchmarkTaskAggregate {
  const success = tasks.filter((task) => task.oraclePassed);
  return {
    successRate: tasks.length === 0 ? 0 : success.length / tasks.length,
    medianTotalTokens: median(tasks.map((task) => task.totalTokens)),
    medianSuccessfulTokens: median(success.map((task) => task.totalTokens)),
    medianFirstReadTokens: median(tasks.flatMap((task) => task.firstReadTokens === undefined ? [] : [task.firstReadTokens])),
    medianModelRounds: median(tasks.map((task) => task.modelRounds)),
  };
}

function cacheStats(samples: readonly ProjectAgentBenchmarkSampleRecord[]): ProjectAgentBenchmarkArtifact['cache'] {
  const requests = samples.flatMap((sample) => sample.tasks).flatMap((task) => task.requests);
  const withCache = requests.filter((request) => request.cachedInputTokens !== undefined);
  const inputWithCache = withCache.reduce((total, request) => total + request.inputTokens, 0);
  const cached = withCache.reduce((total, request) => total + (request.cachedInputTokens ?? 0), 0);
  return {
    requestsWithUsage: requests.length,
    requestsWithCacheDetail: withCache.length,
    coverage: requests.length === 0 ? 0 : withCache.length / requests.length,
    ...(withCache.length === 0 || inputWithCache === 0 ? {} : { hitRate: cached / inputWithCache }),
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

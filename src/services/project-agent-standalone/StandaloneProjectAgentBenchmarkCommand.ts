import { PROJECT_AGENT_TOOLSET_VERSION } from '../../api/types/project-agent';
import { writeProjectAgentBenchmarkArtifact } from '../project-agent-benchmark/ProjectAgentBenchmarkArtifact';
import { PROJECT_AGENT_BENCHMARK_EXIT, type ProjectAgentBenchmarkPhaseName } from '../project-agent-benchmark/ProjectAgentBenchmarkCli';
import {
  runProjectAgentBenchmark,
  type ProjectAgentBenchmarkSamplePort,
} from '../project-agent-benchmark/ProjectAgentBenchmarkRunner';
import {
  PROJECT_AGENT_BENCHMARK_SOURCE_IDENTITY_PROTOCOL_VERSION,
  type ProjectAgentBenchmarkArtifact,
} from '../project-agent-benchmark/ProjectAgentBenchmarkTypes';
import {
  createStandaloneProjectAgentBenchmarkSamplePort,
} from './StandaloneProjectAgentBenchmarkSamplePort';
import type { StandaloneAgentProviderConfig } from './StandaloneProjectAgentEngine';

export interface StandaloneProjectAgentBenchmarkPhaseOptions {
  readonly phase: ProjectAgentBenchmarkPhaseName;
  readonly runs: number;
  readonly tokenBudget: number;
  readonly output: string;
  readonly overwrite: boolean;
  readonly provider: StandaloneAgentProviderConfig;
  /** Test injection; defaults to one isolated standalone-engine sample port per task. */
  readonly createSample?: () => Promise<ProjectAgentBenchmarkSamplePort>;
}

export interface StandaloneProjectAgentBenchmarkPhaseOutcome {
  readonly exitCode: (typeof PROJECT_AGENT_BENCHMARK_EXIT)[keyof typeof PROJECT_AGENT_BENCHMARK_EXIT];
  readonly artifact: ProjectAgentBenchmarkArtifact;
  readonly outputPath: string;
  /** Present only when writing the artifact failed (configuration exit). */
  readonly writeError?: string;
}

/**
 * Run one ADR0024 benchmark phase over the shared standalone engine and write
 * the redacted artifact. The runner itself is provider-neutral; the sample
 * port owns per-sample isolation (temp project, private journal, cleanup).
 * Exit codes follow the benchmark contract: 0 success, 1 run/oracle failure,
 * 2 phase budget exhausted, 3 configuration/usage/isolation/write failure.
 */
export async function runStandaloneProjectAgentBenchmarkPhase(
  options: StandaloneProjectAgentBenchmarkPhaseOptions,
): Promise<StandaloneProjectAgentBenchmarkPhaseOutcome> {
  const artifact = await runProjectAgentBenchmark({
    phase: options.phase,
    runs: options.runs,
    tokenBudget: options.tokenBudget,
    model: options.provider.defaultModel,
    protocolVersion: PROJECT_AGENT_BENCHMARK_SOURCE_IDENTITY_PROTOCOL_VERSION,
    toolsetVersion: PROJECT_AGENT_TOOLSET_VERSION,
    transportKind: 'provider',
    createSample:
      options.createSample
      ?? (async () => createStandaloneProjectAgentBenchmarkSamplePort({ provider: options.provider })),
  });

  let written;
  try {
    written = writeProjectAgentBenchmarkArtifact({
      output: options.output,
      overwrite: options.overwrite,
      artifact,
    });
  } catch (error) {
    // Redaction assertion or filesystem failure: configuration-level outcome.
    return {
      exitCode: PROJECT_AGENT_BENCHMARK_EXIT.configuration,
      artifact,
      outputPath: options.output,
      ...(error instanceof Error ? { writeError: error.message } : {}),
    };
  }
  if (!written.ok) {
    return {
      exitCode: written.exitCode,
      artifact,
      outputPath: options.output,
      writeError: written.message,
    };
  }

  return {
    exitCode: benchmarkExitCode(artifact),
    artifact,
    outputPath: written.outputPath,
  };
}

function benchmarkExitCode(artifact: ProjectAgentBenchmarkArtifact): StandaloneProjectAgentBenchmarkPhaseOutcome['exitCode'] {
  if (artifact.eligibility === 'eligible') return PROJECT_AGENT_BENCHMARK_EXIT.success;
  switch (artifact.ineligibleReason) {
    case 'run_failed':
    case 'oracle_failed':
      return PROJECT_AGENT_BENCHMARK_EXIT.runOrOracleFailure;
    case 'phase_budget_exhausted':
      return PROJECT_AGENT_BENCHMARK_EXIT.budgetExhausted;
    default:
      // usage_unavailable / configuration / isolation (fake_transport cannot
      // occur here: the command always runs a real provider transport).
      return PROJECT_AGENT_BENCHMARK_EXIT.configuration;
  }
}

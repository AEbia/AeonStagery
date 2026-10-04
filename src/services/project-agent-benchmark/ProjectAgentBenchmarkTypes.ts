import type { ProjectAgentBenchmarkPhaseName } from './ProjectAgentBenchmarkCli';
import type { ProjectAgentBenchmarkTaskId } from './ProjectAgentBenchmarkFixture';

export const PROJECT_AGENT_BENCHMARK_ARTIFACT_VERSION = 1 as const;

/**
 * The protocol identity recorded in artifacts produced against the current
 * source-identity Project Agent write protocol (ADR0024). The historical
 * line-based protocol identity is `line-v1` (see the benchmark fixture); a
 * baseline captured from that protocol would carry `line-v1`.
 */
export const PROJECT_AGENT_BENCHMARK_SOURCE_IDENTITY_PROTOCOL_VERSION = 'source-identity-v1' as const;

export type ProjectAgentBenchmarkTransportKind = 'provider' | 'fake';

export type ProjectAgentBenchmarkEligibility = 'eligible' | 'ineligible';

export type ProjectAgentBenchmarkIneligibleReason =
  | 'phase_budget_exhausted'
  | 'usage_unavailable'
  | 'configuration'
  | 'isolation'
  | 'oracle_failed'
  | 'run_failed'
  | 'fake_transport';

export interface ProjectAgentBenchmarkRequestRecord {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly toolNameSequence: readonly string[];
  readonly resultCodes: readonly string[];
  readonly writeCount: number;
  readonly versionConflictCount: number;
}

export interface ProjectAgentBenchmarkTaskRecord {
  readonly taskId: ProjectAgentBenchmarkTaskId;
  readonly oraclePassed: boolean;
  readonly oracleReason?: string;
  readonly modelRounds: number;
  readonly firstReadTokens?: number;
  readonly totalTokens: number;
  readonly documentVersionIncrease: number;
  readonly requests: readonly ProjectAgentBenchmarkRequestRecord[];
}

export interface ProjectAgentBenchmarkSampleRecord {
  readonly runIndex: number;
  readonly tasks: readonly ProjectAgentBenchmarkTaskRecord[];
}

export interface ProjectAgentBenchmarkTaskAggregate {
  readonly successRate: number;
  readonly medianTotalTokens: number | null;
  readonly medianSuccessfulTokens: number | null;
  readonly medianFirstReadTokens: number | null;
  readonly medianModelRounds: number | null;
}

export interface ProjectAgentBenchmarkArtifact {
  readonly version: typeof PROJECT_AGENT_BENCHMARK_ARTIFACT_VERSION;
  readonly phase: ProjectAgentBenchmarkPhaseName;
  readonly eligibility: ProjectAgentBenchmarkEligibility;
  readonly ineligibleReason?: ProjectAgentBenchmarkIneligibleReason;
  readonly transportKind: ProjectAgentBenchmarkTransportKind;
  readonly identities: {
    readonly model: string;
    readonly protocolVersion: string;
    readonly toolsetVersion: number;
    readonly fixtureHash: string;
    readonly taskHash: string;
    readonly runs: number;
    readonly tokenBudget: number;
  };
  readonly capabilityProbe: {
    readonly requestCount: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly spentTaskTokens: number;
  readonly cache: {
    readonly requestsWithUsage: number;
    readonly requestsWithCacheDetail: number;
    readonly coverage: number;
    readonly hitRate?: number;
  };
  readonly samples: readonly ProjectAgentBenchmarkSampleRecord[];
  readonly aggregates: {
    readonly perTask: Readonly<Record<ProjectAgentBenchmarkTaskId, ProjectAgentBenchmarkTaskAggregate>>;
    readonly allSampleTokens: number;
    readonly successfulSampleTokens: number;
    readonly equalWeightMedian: number | null;
  };
}

export interface ProjectAgentBenchmarkPhaseResult {
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly artifact: ProjectAgentBenchmarkArtifact;
  readonly outputPath: string;
}

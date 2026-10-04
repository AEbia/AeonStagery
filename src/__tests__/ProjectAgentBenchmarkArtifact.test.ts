import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PROJECT_AGENT_BENCHMARK_EXIT,
} from '../services/project-agent-benchmark/ProjectAgentBenchmarkCli';
import {
  assertProjectAgentBenchmarkArtifactRedacted,
  writeProjectAgentBenchmarkArtifact,
} from '../services/project-agent-benchmark/ProjectAgentBenchmarkArtifact';
import type { ProjectAgentBenchmarkArtifact } from '../services/project-agent-benchmark/ProjectAgentBenchmarkTypes';

function makeArtifact(): ProjectAgentBenchmarkArtifact {
  return {
    version: 1,
    phase: 'baseline',
    eligibility: 'ineligible',
    ineligibleReason: 'fake_transport',
    transportKind: 'fake',
    identities: {
      model: 'fake-model',
      protocolVersion: 'line-v1',
      toolsetVersion: 3,
      fixtureHash: 'sha256:abc',
      taskHash: 'sha256:def',
      runs: 1,
      tokenBudget: 100,
    },
    capabilityProbe: { requestCount: 0, inputTokens: 0, outputTokens: 0 },
    spentTaskTokens: 0,
    cache: { requestsWithUsage: 0, requestsWithCacheDetail: 0, coverage: 0 },
    samples: [],
    aggregates: {
      perTask: {
        singleUpdate: { successRate: 0, medianTotalTokens: null, medianSuccessfulTokens: null, medianFirstReadTokens: null, medianModelRounds: null },
        insertThenUpdate: { successRate: 0, medianTotalTokens: null, medianSuccessfulTokens: null, medianFirstReadTokens: null, medianModelRounds: null },
        deleteThenUpdateDownstream: { successRate: 0, medianTotalTokens: null, medianSuccessfulTokens: null, medianFirstReadTokens: null, medianModelRounds: null },
        atomicBatch: { successRate: 0, medianTotalTokens: null, medianSuccessfulTokens: null, medianFirstReadTokens: null, medianModelRounds: null },
      },
      allSampleTokens: 0,
      successfulSampleTokens: 0,
      equalWeightMedian: null,
    },
  };
}

describe('Project Agent benchmark artifact I/O', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const directory of temps) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    temps.length = 0;
  });

  it('refuses to replace an existing artifact unless overwrite is explicit', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bench-artifact-'));
    temps.push(directory);
    const output = path.join(directory, 'baseline.json');
    fs.writeFileSync(output, '{"kept":true}', 'utf8');

    const refused = writeProjectAgentBenchmarkArtifact({
      output,
      overwrite: false,
      artifact: makeArtifact(),
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.exitCode).toBe(PROJECT_AGENT_BENCHMARK_EXIT.configuration);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual({ kept: true });

    const written = writeProjectAgentBenchmarkArtifact({
      output,
      overwrite: true,
      artifact: makeArtifact(),
    });
    expect(written.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).phase).toBe('baseline');
  });

  it('rejects artifacts that still contain prohibited content', () => {
    const dirty = {
      ...makeArtifact(),
      leak: 'sk-secret https://provider.example/v1 Update this line.',
    };
    expect(() => assertProjectAgentBenchmarkArtifactRedacted(dirty)).toThrow(/prohibited/i);
    expect(() => assertProjectAgentBenchmarkArtifactRedacted(makeArtifact())).not.toThrow();
  });
});

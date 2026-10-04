import { describe, expect, it } from 'vitest';
import {
  PROJECT_AGENT_BENCHMARK_EXIT,
  parseProjectAgentBenchmarkCli,
} from '../services/project-agent-benchmark/ProjectAgentBenchmarkCli';

describe('Project Agent benchmark CLI', () => {
  it('requires explicit phase, runs, token budget, and output', () => {
    const result = parseProjectAgentBenchmarkCli([
      '--phase', 'baseline',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(PROJECT_AGENT_BENCHMARK_EXIT.configuration);
    expect(result.message).toMatch(/--runs|--token-budget|--output/);
  });

  it('accepts a complete command and defaults overwrite to false', () => {
    const result = parseProjectAgentBenchmarkCli([
      '--phase', 'candidate',
      '--runs', '3',
      '--token-budget', '120000',
      '--output', '.scratch/project-agent-benchmark/candidate.json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args).toEqual({
      phase: 'candidate',
      runs: 3,
      tokenBudget: 120000,
      output: '.scratch/project-agent-benchmark/candidate.json',
      overwrite: false,
    });
  });

  it('accepts explicit overwrite', () => {
    const result = parseProjectAgentBenchmarkCli([
      '--phase', 'baseline',
      '--runs', '1',
      '--token-budget', '1',
      '--output', 'out.json',
      '--overwrite',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.overwrite).toBe(true);
  });

  it('rejects credential, endpoint, or model overrides', () => {
    const flags = [
      ['--api-key', 'secret'],
      ['--endpoint', 'https://example.test'],
      ['--model', 'gpt-test'],
    ];
    for (const extra of flags) {
      const result = parseProjectAgentBenchmarkCli([
        '--phase', 'baseline',
        '--runs', '1',
        '--token-budget', '10',
        '--output', 'out.json',
        ...extra,
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.exitCode).toBe(PROJECT_AGENT_BENCHMARK_EXIT.configuration);
      expect(result.message).toMatch(/does not accept/i);
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  extractProviderNeutralUsage,
  ProjectAgentBenchmarkBudget,
} from '../services/project-agent-benchmark/ProjectAgentBenchmarkUsage';

describe('Project Agent benchmark usage accounting', () => {
  it('maps OpenAI-shaped prompt and completion tokens', () => {
    expect(extractProviderNeutralUsage({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
    })).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  });

  it('maps Anthropic-shaped input and output tokens', () => {
    expect(extractProviderNeutralUsage({
      input_tokens: 8,
      output_tokens: 2,
    })).toEqual({ inputTokens: 8, outputTokens: 2 });
  });

  it('records explicitly reported cached input tokens and does not guess when absent', () => {
    expect(extractProviderNeutralUsage({
      prompt_tokens: 20,
      completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 7 },
    })).toEqual({ inputTokens: 20, outputTokens: 3, cachedInputTokens: 7 });

    expect(extractProviderNeutralUsage({
      prompt_tokens: 20,
      completion_tokens: 3,
      prompt_tokens_details: {},
    })).toEqual({ inputTokens: 20, outputTokens: 3 });
  });

  it('returns undefined when provider usage is missing or malformed', () => {
    expect(extractProviderNeutralUsage(undefined)).toBeUndefined();
    expect(extractProviderNeutralUsage({ prompt_tokens: 1 })).toBeUndefined();
    expect(extractProviderNeutralUsage({
      prompt_tokens: '10',
      completion_tokens: 2,
    })).toBeUndefined();
  });

  it('accumulates completed-round tokens, permits one-request overshoot, and never resets per sample', () => {
    const budget = new ProjectAgentBenchmarkBudget(10);
    expect(budget.canStartNextRound()).toBe(true);
    budget.recordCompletedRound({ inputTokens: 4, outputTokens: 2 });
    expect(budget.canStartNextRound()).toBe(true);
    budget.recordCompletedRound({ inputTokens: 5, outputTokens: 1 });
    expect(budget.spentTokens).toBe(12);
    expect(budget.canStartNextRound()).toBe(false);
    expect(budget.state).toBe('exhausted');
  });

  it('stops immediately as usage unavailable when a completed round lacks usage', () => {
    const budget = new ProjectAgentBenchmarkBudget(100);
    budget.recordCompletedRound(undefined);
    expect(budget.state).toBe('usage_unavailable');
    expect(budget.canStartNextRound()).toBe(false);
  });
});

import type { AiConversationUsage } from '../../api/types/ai-conversation';

export interface ProjectAgentBenchmarkUsage extends AiConversationUsage {
  readonly cachedInputTokens?: number;
}

export type ProjectAgentBenchmarkBudgetState = 'open' | 'exhausted' | 'usage_unavailable';

export function extractProviderNeutralUsage(raw: unknown): ProjectAgentBenchmarkUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const inputTokens = firstFiniteNumber(raw.prompt_tokens, raw.input_tokens);
  const outputTokens = firstFiniteNumber(raw.completion_tokens, raw.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const totalTokens = firstFiniteNumber(raw.total_tokens);
  const cachedInputTokens = extractCachedInputTokens(raw);
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

export class ProjectAgentBenchmarkBudget {
  private spent = 0;
  private current: ProjectAgentBenchmarkBudgetState = 'open';

  constructor(private readonly threshold: number) {}

  get spentTokens(): number {
    return this.spent;
  }

  get state(): ProjectAgentBenchmarkBudgetState {
    return this.current;
  }

  canStartNextRound(): boolean {
    return this.current === 'open' && this.spent < this.threshold;
  }

  recordCompletedRound(usage: ProjectAgentBenchmarkUsage | undefined): void {
    if (this.current === 'usage_unavailable') return;
    if (!usage) {
      this.current = 'usage_unavailable';
      return;
    }
    this.spent += usage.inputTokens + usage.outputTokens;
    if (this.spent >= this.threshold) {
      this.current = 'exhausted';
    }
  }
}

function extractCachedInputTokens(raw: Record<string, unknown>): number | undefined {
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined;
  const cached = firstFiniteNumber(
    raw.cached_tokens,
    raw.cached_input_tokens,
    raw.cache_read_input_tokens,
    details?.cached_tokens,
    details?.cached_input_tokens,
  );
  return cached;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

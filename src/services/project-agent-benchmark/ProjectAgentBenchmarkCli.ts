export const PROJECT_AGENT_BENCHMARK_EXIT = {
  success: 0,
  runOrOracleFailure: 1,
  budgetExhausted: 2,
  configuration: 3,
} as const;

export type ProjectAgentBenchmarkPhaseName = 'baseline' | 'candidate';

export interface ProjectAgentBenchmarkCliArgs {
  readonly phase: ProjectAgentBenchmarkPhaseName;
  readonly runs: number;
  readonly tokenBudget: number;
  readonly output: string;
  readonly overwrite: boolean;
}

export type ProjectAgentBenchmarkCliParseResult =
  | { readonly ok: true; readonly args: ProjectAgentBenchmarkCliArgs }
  | { readonly ok: false; readonly exitCode: typeof PROJECT_AGENT_BENCHMARK_EXIT.configuration; readonly message: string };

const FORBIDDEN_OVERRIDE_FLAGS = new Set([
  '--api-key',
  '--apikey',
  '--credential',
  '--endpoint',
  '--model',
  '--base-url',
]);

const REQUIRED_FLAGS = ['--phase', '--runs', '--token-budget', '--output'] as const;

export function parseProjectAgentBenchmarkCli(argv: readonly string[]): ProjectAgentBenchmarkCliParseResult {
  const forbidden = argv.find((token) => FORBIDDEN_OVERRIDE_FLAGS.has(token));
  if (forbidden) {
    return fail(`Benchmark command does not accept ${forbidden} overrides`);
  }

  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      return fail(`Unexpected argument: ${token}`);
    }
    const next = argv[index + 1];
    if (token === '--overwrite') {
      values.set(token, true);
      continue;
    }
    if (next === undefined || next.startsWith('--')) {
      return fail(`Missing value for ${token}`);
    }
    values.set(token, next);
    index += 1;
  }

  const missing = REQUIRED_FLAGS.filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    return fail(`Missing required arguments: ${missing.join(', ')}`);
  }

  const phase = values.get('--phase');
  if (phase !== 'baseline' && phase !== 'candidate') {
    return fail('--phase must be baseline or candidate');
  }

  const runs = parsePositiveInteger(values.get('--runs'), '--runs');
  if (!runs.ok) return runs;

  const tokenBudget = parsePositiveInteger(values.get('--token-budget'), '--token-budget');
  if (!tokenBudget.ok) return tokenBudget;

  const output = values.get('--output');
  if (typeof output !== 'string' || output.trim().length === 0) {
    return fail('--output must be a non-empty path');
  }

  return {
    ok: true,
    args: {
      phase,
      runs: runs.value,
      tokenBudget: tokenBudget.value,
      output,
      overwrite: values.get('--overwrite') === true,
    },
  };
}

function parsePositiveInteger(
  raw: string | true | undefined,
  flag: string,
): { readonly ok: true; readonly value: number } | ProjectAgentBenchmarkCliParseResult & { readonly ok: false } {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    return fail(`${flag} must be a positive integer`);
  }
  return { ok: true, value: Number(raw) };
}

function fail(message: string): ProjectAgentBenchmarkCliParseResult & { readonly ok: false } {
  return {
    ok: false,
    exitCode: PROJECT_AGENT_BENCHMARK_EXIT.configuration,
    message,
  };
}

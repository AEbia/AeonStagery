import { createInterface } from 'readline';
import { redactAgentBridgePayload } from '../src/services/project-agent-standalone/AgentBridgeProtocol';
import { PROJECT_AGENT_BENCHMARK_EXIT } from '../src/services/project-agent-benchmark/ProjectAgentBenchmarkCli';
import { FileSystemProjectAgentJournalPort } from '../src/services/project-agent-service/FileSystemProjectAgentJournalPort';
import {
  agentBridgeUsageText,
  createAgentBridgeSession,
  handleAgentBridgeServeRequest,
  makeAgentBridgeOkResponse,
  parseAgentBridgeCliArgs,
  projectAgentRunResultJson,
  type AgentBridgeCliArgs,
} from '../src/services/project-agent-standalone/AgentBridgeCli';
import { StandaloneProjectAgentEngine } from '../src/services/project-agent-standalone/StandaloneProjectAgentEngine';
import { runStandaloneProjectAgentBenchmarkPhase } from '../src/services/project-agent-standalone/StandaloneProjectAgentBenchmarkCommand';

/** Exit codes: 0 success, 1 start/runtime failure, 2 usage error. */
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(message: string, exitCode: number = EXIT_FAILURE): never {
  printJson({ ok: false, error: message });
  process.exit(exitCode);
}

function requireProvider(
  args: AgentBridgeCliArgs,
  exitCode: number = EXIT_FAILURE,
): {
  endpoint: string;
  defaultModel: string;
  apiKey?: string;
  contextWindow?: number;
} {
  if (!args.endpoint || !args.model) {
    return fail(
      'a provider is required (use --endpoint/--model or AEON_AGENT_BRIDGE_ENDPOINT/AEON_AGENT_BRIDGE_MODEL)',
      exitCode,
    );
  }
  return {
    endpoint: args.endpoint,
    defaultModel: args.model,
    ...(args.apiKey ? { apiKey: args.apiKey } : {}),
    ...(args.contextWindow !== undefined && args.contextWindow > 0
      ? { contextWindow: args.contextWindow }
      : {}),
  };
}

async function runCommand(args: AgentBridgeCliArgs): Promise<number> {
  const provider = requireProvider(args);
  const opened = await StandaloneProjectAgentEngine.open({
    projectDir: args.projectDir as string,
    sceneRelPath: args.sceneRelPath as string,
    journalDirectory: args.journalDirectory,
    provider,
    ...(args.accessMode ? { accessMode: args.accessMode } : {}),
    ...(args.mounts ? { externalMounts: args.mounts } : {}),
  });
  if ('ok' in opened && opened.ok === false) {
    return fail(`${opened.code}: ${opened.message}`, EXIT_FAILURE);
  }
  const engine = opened;

  const timeoutMs = args.timeoutMs ?? 0;
  const taskPromise = engine.run(args.message as string);
  let runResult;
  if (timeoutMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const result = await Promise.race([taskPromise, timeout]);
    if (result === 'timeout') {
      if (timer) clearTimeout(timer);
      engine.close();
      return fail('timeout', EXIT_FAILURE);
    }
    if (timer) clearTimeout(timer);
    runResult = result;
  } else {
    runResult = await taskPromise;
  }

  engine.close();
  if (!runResult.ok) {
    return fail(runResult.message ?? runResult.code ?? 'run failed', EXIT_FAILURE);
  }
  printJson(projectAgentRunResultJson(runResult));
  return EXIT_OK;
}

async function listCommand(args: AgentBridgeCliArgs): Promise<number> {
  const port = new FileSystemProjectAgentJournalPort(args.journalDirectory);
  const records = await port.listByProject(args.projectId as string);
  const summary = records.map((record) => ({
    taskId: record.identity.taskId,
    title: record.title ?? null,
    lifecycle: record.lifecycle,
    updatedAt: record.updatedAt,
    originalTaskText: truncateText(record.originalTaskText, 120),
  }));
  printJson({ projectId: args.projectId, records: summary });
  return EXIT_OK;
}

async function showCommand(args: AgentBridgeCliArgs): Promise<number> {
  const port = new FileSystemProjectAgentJournalPort(args.journalDirectory);
  const record = await port.load(args.projectId as string, args.taskId as string);
  if (!record) return fail('not_found', EXIT_FAILURE);
  printJson(redactAgentBridgePayload(record));
  return EXIT_OK;
}

/**
 * ADR0024 benchmark phase (baseline | candidate): runs the isolated sample
 * ports over the standalone engine, writes the redacted artifact atomically,
 * and exits with the benchmark contract codes (0/1/2/3). Provider config
 * comes from the same bridge flags/env as run/serve; the benchmark itself
 * accepts no credential/endpoint/model overrides of its own.
 */
async function benchmarkCommand(args: AgentBridgeCliArgs): Promise<number> {
  // Missing provider is a configuration failure (benchmark exit 3), not a
  // generic bridge usage error.
  const provider = requireProvider(args, PROJECT_AGENT_BENCHMARK_EXIT.configuration);
  const outcome = await runStandaloneProjectAgentBenchmarkPhase({
    phase: args.phase as 'baseline' | 'candidate',
    runs: args.runs as number,
    tokenBudget: args.tokenBudget as number,
    output: args.output as string,
    overwrite: args.overwrite,
    provider,
  });
  const artifact = outcome.artifact;
  printJson({
    ok: outcome.exitCode === PROJECT_AGENT_BENCHMARK_EXIT.success,
    phase: artifact.phase,
    eligibility: artifact.eligibility,
    ...(artifact.ineligibleReason ? { ineligibleReason: artifact.ineligibleReason } : {}),
    ...(outcome.writeError ? { writeError: outcome.writeError } : {}),
    outputPath: outcome.outputPath,
    identities: artifact.identities,
    spentTaskTokens: artifact.spentTaskTokens,
    capabilityProbe: artifact.capabilityProbe,
    cache: artifact.cache,
    aggregates: {
      allSampleTokens: artifact.aggregates.allSampleTokens,
      successfulSampleTokens: artifact.aggregates.successfulSampleTokens,
      equalWeightMedian: artifact.aggregates.equalWeightMedian,
      perTask: Object.fromEntries(
        Object.entries(artifact.aggregates.perTask).map(([taskId, aggregate]) => [
          taskId,
          {
            successRate: aggregate.successRate,
            medianTotalTokens: aggregate.medianTotalTokens,
            medianModelRounds: aggregate.medianModelRounds,
          },
        ]),
      ),
    },
  });
  return outcome.exitCode;
}

async function serveCommand(args: AgentBridgeCliArgs): Promise<number> {
  const provider = requireProvider(args);
  const session = createAgentBridgeSession({
    journalDirectory: args.journalDirectory,
    provider,
    ...(args.accessMode ? { accessMode: args.accessMode } : {}),
    ...(args.mounts ? { externalMounts: args.mounts } : {}),
    ...(args.projectDir ? { defaultProjectDir: args.projectDir } : {}),
    ...(args.sceneRelPath ? { defaultSceneRelPath: args.sceneRelPath } : {}),
  });

  const rl = createInterface({ input: process.stdin });
  const writeLine = (message: unknown): void => {
    process.stdout.write(JSON.stringify(message) + '\n');
  };
  session.onStatus = (status) => {
    writeLine({ event: 'status', payload: status });
  };

  await new Promise<void>((resolve) => {
    rl.on('line', async (rawLine: string) => {
      const frame = parseFrame(rawLine);
      if (!frame.ok) {
        writeLine({ ok: false, error: frame.error });
        return;
      }
      const request = frame.message as {
        id?: number | string;
        method?: unknown;
        params?: Record<string, unknown>;
      };
      const id = request.id ?? 0;
      try {
        const result = await handleAgentBridgeServeRequest(session, {
          id,
          method: request.method as 'run',
          params: request.params,
        });
        if (Array.isArray(result)) {
          let lastResult: Record<string, unknown> | undefined;
          for (const event of result) {
            writeLine(event);
            if (event.event === 'result') lastResult = event.payload;
          }
          if (lastResult) writeLine(makeAgentBridgeOkResponse(id, lastResult));
        } else {
          writeLine(result);
        }
        if (request.method === 'close') resolve();
      } catch (error) {
        writeLine({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    rl.on('close', () => resolve());
  });

  return EXIT_OK;
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/** Minimal NDJSON frame pre-check; deep validation is the protocol module's job. */
function parseFrame(line: string): { ok: true; message: unknown } | { ok: false; error: string } {
  if (line.trim().length === 0) return { ok: false, error: 'empty frame' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: 'invalid json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'unrecognized frame' };
  }
  return { ok: true, message: parsed };
}

if (process.argv[1]?.endsWith('agent-bridge.ts')) {
  // Keep stdout a pure machine-readable stream: library debug logs (provider
  // payloads, context budgets) are routed to stderr so run/serve JSON output
  // stays parseable. printJson uses process.stdout.write directly.
  const routeToStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
  };
  console.info = routeToStderr;
  console.log = routeToStderr;

  const parsed = parseAgentBridgeCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    printJson({ ok: false, error: parsed.error });
    process.stderr.write('\n' + agentBridgeUsageText() + '\n');
    process.exit(EXIT_USAGE);
  }
  const args = parsed.args;
  let exited: Promise<number>;
  if (args.command === 'list') exited = listCommand(args);
  else if (args.command === 'show') exited = showCommand(args);
  else if (args.command === 'serve') exited = serveCommand(args);
  else if (args.command === 'benchmark') exited = benchmarkCommand(args);
  else exited = runCommand(args);
  exited.then((code) => process.exit(code));
}

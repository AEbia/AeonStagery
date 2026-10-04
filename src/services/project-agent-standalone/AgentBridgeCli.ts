import { homedir } from 'os';
import { join } from 'path';
import type { ExternalLibraryMount } from '../../api/types/project';
import type { ProjectAgentAccessMode } from '../../api/types/project-agent';
import type { ProjectAgentTaskStatusPayload } from '../../api/types/project-agent-ipc';
import type {
  ProjectAgentJournalPort,
} from '../project-agent/ProjectAgentJournal';
import { FileSystemProjectAgentJournalPort } from '../project-agent-service/FileSystemProjectAgentJournalPort';
import { parseProjectAgentBenchmarkCli } from '../project-agent-benchmark/ProjectAgentBenchmarkCli';
import {
  createAgentBridgeError,
  redactAgentBridgePayload,
  type AgentBridgeEvent,
  type AgentBridgeRequest,
  type AgentBridgeResponse,
} from './AgentBridgeProtocol';
import {
  StandaloneProjectAgentEngine,
  type StandaloneProjectAgentEngineOptions,
  type StandaloneAgentProviderConfig,
  type StandaloneProjectAgentRunResult,
} from './StandaloneProjectAgentEngine';

export interface AgentBridgeCliArgs {
  readonly command: 'run' | 'list' | 'show' | 'serve' | 'benchmark';
  readonly projectDir?: string;
  readonly sceneRelPath?: string;
  readonly message?: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly journalDirectory: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly apiKey?: string;
  /** Provider-reported context window in tokens; overrides the 262144 fallback. */
  readonly contextWindow?: number;
  readonly accessMode?: 'standard' | 'full_access';
  readonly timeoutMs?: number;
  readonly image?: string;
  /** Registered external library mounts (@mount/<id>/... resolution targets). */
  readonly mounts?: readonly ExternalLibraryMount[];
  /** ADR0024 benchmark phase arguments (benchmark command only). */
  readonly phase?: 'baseline' | 'candidate';
  readonly runs?: number;
  readonly tokenBudget?: number;
  readonly output?: string;
  readonly overwrite: boolean;
}

export type AgentBridgeCliParseResult =
  | { ok: true; args: AgentBridgeCliArgs }
  | { ok: false; error: string };

const COMMANDS: readonly AgentBridgeCliArgs['command'][] = ['run', 'list', 'show', 'serve', 'benchmark'];

/** Options that take a following value. Boolean flags have no value. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  'project-dir',
  'scene-rel-path',
  'message',
  'project-id',
  'task-id',
  'journal',
  'endpoint',
  'model',
  'api-key',
  'context-window',
  'access-mode',
  'timeout-ms',
  'image',
  'mount',
  'phase',
  'runs',
  'token-budget',
  'output',
]);

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['full-access', 'overwrite']);

export function defaultAgentBridgeJournalDirectory(): string {
  return join(homedir(), '.config', 'AeonStagery', 'agent-bridge-journal');
}

/**
 * Parse the Agent Bridge CLI argv. Env provides fallbacks for endpoint /
 * model / apiKey. Injectable env keeps the function testable with vi.stubEnv
 * or an injected parameter.
 */
export function parseAgentBridgeCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): AgentBridgeCliParseResult {
  const fail = (error: string): AgentBridgeCliParseResult => ({ ok: false, error });

  const command = argv[0];
  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    return fail(`unknown command "${command ?? ''}"`);
  }

  const rest = argv.slice(1);
  const values: Record<string, string> = {};
  const mountPairs: string[] = [];
  let accessMode: AgentBridgeCliArgs['accessMode'];
  let timeoutMs: number | undefined;
  let contextWindow: number | undefined;
  let overwrite = false;

  let index = 0;
  while (index < rest.length) {
    const raw = rest[index];
    if (!raw.startsWith('--')) return fail(`unexpected positional argument "${raw}"`);
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== undefined) return fail(`boolean option --${name} does not take a value`);
      if (name === 'full-access') accessMode = 'full_access';
      if (name === 'overwrite') overwrite = true;
      index += 1;
      continue;
    }

    if (!VALUE_FLAGS.has(name)) {
      return fail(`unknown option "--${name}"`);
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = rest[index + 1];
      if (next === undefined) return fail(`option --${name} requires a value`);
      value = next;
      index += 1;
    }

    if (name === 'access-mode') {
      if (value !== 'standard' && value !== 'full_access') {
        return fail(`invalid access-mode "${value}"`);
      }
      accessMode = value;
    } else if (name === 'timeout-ms') {
      if (!/^\d+$/.test(value)) return fail(`timeout-ms must be a non-negative integer, got "${value}"`);
      timeoutMs = Number(value);
    } else if (name === 'context-window') {
      if (!/^\d+$/.test(value) || Number(value) <= 0) {
        return fail(`context-window must be a positive integer (tokens), got "${value}"`);
      }
      contextWindow = Number(value);
    } else {
      values[name] = value;
      if (name === 'mount') mountPairs.push(value);
    }
    index += 1;
  }

  const mounts: ExternalLibraryMount[] = [];
  for (const spec of mountPairs) {
    const parsed = parseExternalLibraryMountSpec(spec);
    if (!parsed.ok) return fail(parsed.error);
    mounts.push(parsed.mount);
  }

  const base: AgentBridgeCliArgs = {
    command: command as AgentBridgeCliArgs['command'],
    journalDirectory: values['journal'] ?? defaultAgentBridgeJournalDirectory(),
    overwrite: false,
    ...(values['project-dir'] !== undefined ? { projectDir: values['project-dir'] } : {}),
    ...(values['scene-rel-path'] !== undefined ? { sceneRelPath: values['scene-rel-path'] } : {}),
    ...(values['message'] !== undefined ? { message: values['message'] } : {}),
    ...(values['project-id'] !== undefined ? { projectId: values['project-id'] } : {}),
    ...(values['task-id'] !== undefined ? { taskId: values['task-id'] } : {}),
    ...(accessMode !== undefined ? { accessMode } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(values['image'] !== undefined ? { image: values['image'] } : {}),
    ...(mounts.length > 0 ? { mounts } : {}),
    endpoint: values['endpoint'] ?? env.AEON_AGENT_BRIDGE_ENDPOINT,
    model: values['model'] ?? env.AEON_AGENT_BRIDGE_MODEL,
    apiKey: values['api-key'] ?? env.AEON_AGENT_BRIDGE_API_KEY,
    ...(contextWindow !== undefined
      ? { contextWindow }
      : env.AEON_AGENT_BRIDGE_CONTEXT_WINDOW !== undefined
        && /^\d+$/.test(env.AEON_AGENT_BRIDGE_CONTEXT_WINDOW)
        && Number(env.AEON_AGENT_BRIDGE_CONTEXT_WINDOW) > 0
        ? { contextWindow: Number(env.AEON_AGENT_BRIDGE_CONTEXT_WINDOW) }
        : {}),
  };

  if (command === 'run' && !base.projectDir) {
    return fail('run requires --project-dir');
  }
  if (command === 'run' && !base.sceneRelPath) {
    return fail('run requires --scene-rel-path');
  }
  if (command === 'run' && !base.message) {
    return fail('run requires --message');
  }
  if (command === 'list' && !base.projectId) {
    return fail('list requires --project-id');
  }
  if (command === 'show' && !base.projectId) {
    return fail('show requires --project-id');
  }
  if (command === 'show' && !base.taskId) {
    return fail('show requires --task-id');
  }

  if (command === 'benchmark') {
    const benchmarkArgv: string[] = [];
    for (const flag of ['--phase', '--runs', '--token-budget', '--output'] as const) {
      const value = values[flag.slice(2)];
      if (value !== undefined) benchmarkArgv.push(flag, value);
    }
    if (overwrite) benchmarkArgv.push('--overwrite');
    const parsed = parseProjectAgentBenchmarkCli(benchmarkArgv);
    if (!parsed.ok) return fail(parsed.message);
    return {
      ok: true,
      args: {
        ...base,
        phase: parsed.args.phase,
        runs: parsed.args.runs,
        tokenBudget: parsed.args.tokenBudget,
        output: parsed.args.output,
        overwrite: parsed.args.overwrite,
      },
    };
  }

  return { ok: true, args: base };
}

export function agentBridgeUsageText(): string {
  return [
    'Usage: agent-bridge <command> [options]',
    '',
    'Commands:',
    '  run    Run one task to completion and print its result JSON',
    '  list   List journal records for a project',
    '  show   Print a redacted journal record',
    '  serve  Long-lived NDJSON stdio session for an external Agent',
    '  benchmark  Run one ADR0024 benchmark phase and write its artifact JSON',
    '',
    'Options:',
    '  --project-dir <path>     project root directory (run/serve)',
    '  --scene-rel-path <path>  project-relative scene path (run/serve)',
    '  --message <text>         task text (run)',
    '  --project-id <id>        project id (list/show)',
    '  --task-id <id>           task id (show)',
    '  --journal <dir>          journal directory (default ~/.config/AeonStagery/agent-bridge-journal)',
    '  --endpoint <url>         provider endpoint (env AEON_AGENT_BRIDGE_ENDPOINT)',
    '  --model <name>           provider model (env AEON_AGENT_BRIDGE_MODEL)',
    '  --api-key <key>          provider api key (env AEON_AGENT_BRIDGE_API_KEY)',
    '  --context-window <n>     provider context window in tokens (env AEON_AGENT_BRIDGE_CONTEXT_WINDOW); default 262144',
    '  --access-mode <mode>     standard | full_access',
    '  --full-access            shorthand for --access-mode full_access',
    '  --timeout-ms <ms>        non-negative run timeout (run)',
    '  --image <path>           optional image path (run)',
    '  --mount <id>=<path>      register an external library mount (repeatable; run/serve)',
    '  --phase <name>           benchmark phase: baseline | candidate (benchmark)',
    '  --runs <n>               benchmark sample run count (benchmark)',
    '  --token-budget <n>       cumulative task token budget (benchmark)',
    '  --output <path>          artifact output path (benchmark)',
    '  --overwrite              allow replacing an existing artifact (benchmark)',
  ].join('\n');
}

export function projectAgentRunResultJson(result: StandaloneProjectAgentRunResult): Record<string, unknown> {
  const activities = (result.activities ?? []).map((activity) => ({
    kind: activity.kind,
    toolName: activity.toolName,
    text: activity.text,
  }));
  return {
    ok: result.ok,
    ...(result.taskId !== undefined ? { taskId: result.taskId } : {}),
    ...(result.projectId !== undefined ? { projectId: result.projectId } : {}),
    ...(result.lifecycle !== undefined ? { lifecycle: result.lifecycle } : {}),
    ...(result.pauseReason !== undefined ? { pauseReason: result.pauseReason } : {}),
    ...(result.finalAssistantText !== undefined ? { finalAssistantText: result.finalAssistantText } : {}),
    activities: activities.length > 0 ? activities : undefined,
    committedReceipts: result.committedReceipts?.length ?? 0,
    ...(result.documentVersion !== undefined ? { documentVersion: result.documentVersion } : {}),
  };
}

/* ------------------------------------------------------------------------ *
 * Serve session & request handling (testable, no readline/process IO here).
 * ------------------------------------------------------------------------ */

export type AgentBridgeEngineOpenResult =
  | StandaloneProjectAgentEngine
  | { ok: false; code: string; message: string };

export type AgentBridgeEngineOpener = (
  options: StandaloneProjectAgentEngineOptions,
) => Promise<AgentBridgeEngineOpenResult>;

export interface AgentBridgeServeSession {
  readonly journalDirectory: string;
  readonly journal: ProjectAgentJournalPort;
  readonly provider: StandaloneAgentProviderConfig;
  readonly accessMode?: ProjectAgentAccessMode;
  /** Registered external library mounts shared by every engine this session opens. */
  readonly externalMounts?: readonly ExternalLibraryMount[];
  /** CLI-provided fallbacks for run/send params. */
  readonly defaultProjectDir?: string;
  readonly defaultSceneRelPath?: string;
  readonly openEngine: AgentBridgeEngineOpener;
  /** Real-time status stream hook (wired to readline writer by the serve script). */
  onStatus?: (status: ProjectAgentTaskStatusPayload) => void;
  engine: StandaloneProjectAgentEngine | null;
  engineKey: string | null;
  lastStatus: ProjectAgentTaskStatusPayload | null;
  lastResult: Record<string, unknown> | null;
  closed: boolean;
}

export interface CreateAgentBridgeSessionOptions {
  readonly journalDirectory: string;
  readonly provider: StandaloneAgentProviderConfig;
  readonly accessMode?: ProjectAgentAccessMode;
  readonly externalMounts?: readonly ExternalLibraryMount[];
  readonly defaultProjectDir?: string;
  readonly defaultSceneRelPath?: string;
  readonly journal?: ProjectAgentJournalPort;
  readonly openEngine?: AgentBridgeEngineOpener;
}

export function createAgentBridgeSession(
  options: CreateAgentBridgeSessionOptions,
): AgentBridgeServeSession {
  return {
    journalDirectory: options.journalDirectory,
    journal: options.journal ?? new FileSystemProjectAgentJournalPort(options.journalDirectory),
    provider: options.provider,
    ...(options.accessMode !== undefined ? { accessMode: options.accessMode } : {}),
    ...(options.externalMounts !== undefined
      ? { externalMounts: options.externalMounts }
      : {}),
    ...(options.defaultProjectDir !== undefined
      ? { defaultProjectDir: options.defaultProjectDir }
      : {}),
    ...(options.defaultSceneRelPath !== undefined
      ? { defaultSceneRelPath: options.defaultSceneRelPath }
      : {}),
    openEngine: options.openEngine ?? ((opts) => StandaloneProjectAgentEngine.open(opts)),
    engine: null,
    engineKey: null,
    lastStatus: null,
    lastResult: null,
    closed: false,
  };
}

/** Build the ok response for a run/send round from its last result event. */
export function makeAgentBridgeOkResponse(
  id: number | string,
  result: Record<string, unknown>,
): AgentBridgeOkResponseLike {
  return { id, ok: true, result };
}

type AgentBridgeOkResponseLike = { id: number | string; ok: true; result: Record<string, unknown> };

/** Echo a request id, degrading missing ids to 0. */
function requestIdOf(request: AgentBridgeRequest): number | string {
  return request.id === undefined ? 0 : request.id;
}

function errorResponse(id: number | string, error: string): AgentBridgeResponse {
  return createAgentBridgeError(id, error);
}

/**
 * Handle one Agent Bridge serve request against the shared session state.
 * Returns a single `AgentBridgeResponse` for synchronous commands/errors, or
 * an array of terminal `AgentBridgeEvent`s for a run/send round (status
 * events are streamed live through `session.onStatus`; the last result event
 * feeds the ok response via `makeAgentBridgeOkResponse`).
 */
export async function handleAgentBridgeServeRequest(
  session: AgentBridgeServeSession,
  request: AgentBridgeRequest,
): Promise<AgentBridgeResponse | readonly AgentBridgeEvent[]> {
  const id = requestIdOf(request);
  const error = (message: string) => errorResponse(id, message);

  if (session.closed) return error('session closed');
  if (request.method === 'close') {
    session.closed = true;
    session.engine?.close();
    return { id, ok: true, result: {} };
  }

  if (request.method === 'run' || request.method === 'send') {
    return handleRound(session, id, request);
  }

  if (request.method === 'status') {
    return { id, ok: true, result: { status: session.lastStatus ?? null } };
  }

  if (request.method === 'result') {
    return { id, ok: true, result: { result: session.lastResult } };
  }

  if (request.method === 'pause') {
    return invokeControl(session, id, 'pause');
  }
  if (request.method === 'cancel') {
    return invokeControl(session, id, 'cancel');
  }

  if (request.method === 'list') {
    const projectId = request.params?.projectId;
    if (typeof projectId !== 'string' || projectId.length === 0) {
      return error('list requires params.projectId');
    }
    const records = await session.journal.listByProject(projectId);
    const summary = records.map((record) => ({
      taskId: record.identity.taskId,
      title: record.title ?? undefined,
      lifecycle: record.lifecycle,
      updatedAt: record.updatedAt,
      originalTaskText: truncateText(record.originalTaskText, 120),
    }));
    return { id, ok: true, result: { projectId, records: summary } };
  }

  if (request.method === 'show') {
    const projectId = request.params?.projectId;
    const taskId = request.params?.taskId;
    if (typeof projectId !== 'string' || typeof taskId !== 'string') {
      return error('show requires params.projectId and params.taskId');
    }
    const record = await session.journal.load(projectId, taskId);
    if (!record) return error('not_found');
    return {
      id,
      ok: true,
      result: { record: redactAgentBridgePayload(record) as Record<string, unknown> },
    };
  }

  return error(`unknown method "${request.method}"`);
}

/** Run/send a conversation round and return its terminal events. */
async function handleRound(
  session: AgentBridgeServeSession,
  id: number | string,
  request: AgentBridgeRequest,
): Promise<AgentBridgeResponse | readonly AgentBridgeEvent[]> {
  const error = (message: string) => errorResponse(id, message);
  const params = request.params ?? {};

  const projectDir =
    typeof params.projectDir === 'string' ? params.projectDir : session.defaultProjectDir;
  const sceneRelPath =
    typeof params.sceneRelPath === 'string' ? params.sceneRelPath : session.defaultSceneRelPath;

  if (request.method === 'run') {
    const taskText = params.taskText;
    if (typeof taskText !== 'string' || taskText.length === 0) {
      return error('run requires params.taskText');
    }
    if (!projectDir || !sceneRelPath) {
      return error('run requires a projectDir and sceneRelPath');
    }
    const engine = await ensureEngine(session, projectDir, sceneRelPath);
    if (isEngineFailure(engine)) {
      return error(`open failed ${engine.code}: ${engine.message}`);
    }
    const runResult = await engine.run(taskText);
    return finishRound(session, id, runResult);
  }

  // send
  const text = params.text;
  if (typeof text !== 'string' || text.length === 0) {
    return error('send requires params.text');
  }
  if (!session.engine) return error('send requires an open engine; run first');
  if (!projectDir || !sceneRelPath) {
    return error('send requires a projectDir and sceneRelPath');
  }
  const expectedKey = engineKeyFor(projectDir, sceneRelPath);
  if (session.engineKey !== expectedKey) {
    return error('send must target the same project/scene as the open engine');
  }
  const sendResult = await session.engine.send(text);
  return finishRound(session, id, sendResult);
}

function finishRound(
  session: AgentBridgeServeSession,
  id: number | string,
  result: StandaloneProjectAgentRunResult,
): AgentBridgeResponse | readonly AgentBridgeEvent[] {
  if (!result.ok) {
    return errorResponse(
      id,
      result.message ?? result.code ?? 'round failed',
    );
  }
  const json = projectAgentRunResultJson(result);
  session.lastResult = json;
  return [{ event: 'result', payload: json }];
}

async function ensureEngine(
  session: AgentBridgeServeSession,
  projectDir: string,
  sceneRelPath: string,
): Promise<AgentBridgeEngineOpenResult> {
  const key = engineKeyFor(projectDir, sceneRelPath);
  if (session.engine && session.engineKey === key) return session.engine;
  const result = await session.openEngine({
    projectDir,
    sceneRelPath,
    journalDirectory: session.journalDirectory,
    provider: session.provider,
    ...(session.accessMode !== undefined ? { accessMode: session.accessMode } : {}),
    ...(session.externalMounts !== undefined
      ? { externalMounts: session.externalMounts }
      : {}),
    onStatus: (status) => {
      session.lastStatus = status;
      session.onStatus?.(status);
    },
  });
  if (isEngineFailure(result)) return result;
  session.engine = result;
  session.engineKey = key;
  return result;
}

function isEngineFailure(
  result: AgentBridgeEngineOpenResult,
): result is { ok: false; code: string; message: string } {
  return 'ok' in result && result.ok === false;
}

function engineKeyFor(projectDir: string, sceneRelPath: string): string {
  return `${projectDir}\u0000${sceneRelPath}`;
}

async function invokeControl(
  session: AgentBridgeServeSession,
  id: number | string,
  method: 'pause' | 'cancel',
): Promise<AgentBridgeResponse> {
  if (!session.engine) return errorResponse(id, `${method} requires an open engine`);
  const outcome =
    method === 'pause' ? await session.engine.pause() : await session.engine.cancel();
  return { id, ok: true, result: { ok: outcome.ok, ...(outcome.error ? { error: outcome.error } : {}) } };
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

const MOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

type ParsedMountSpec =
  | { ok: true; mount: ExternalLibraryMount }
  | { ok: false; error: string };

/**
 * Parse one `--mount <id>=<path>` spec. The path may itself contain '='
 * (split on the first one); the id must match the mount reference contract
 * used by @mount/<id>/... paths.
 */
function parseExternalLibraryMountSpec(spec: string): ParsedMountSpec {
  const eq = spec.indexOf('=');
  if (eq <= 0) {
    return { ok: false, error: `invalid --mount spec "${spec}" (expected --mount <id>=<path>)` };
  }
  const id = spec.slice(0, eq).trim();
  const pathValue = spec.slice(eq + 1).trim();
  if (!MOUNT_ID_PATTERN.test(id)) {
    return { ok: false, error: `invalid --mount id "${id}" (must match [a-z0-9][a-z0-9-]{0,63})` };
  }
  if (pathValue.length === 0) {
    return { ok: false, error: `invalid --mount spec "${spec}" (empty path)` };
  }
  return { ok: true, mount: { id, path: pathValue } };
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProjectAgentBenchmarkRound } from '../project-agent-benchmark/ProjectAgentBenchmarkRunner';
import type { ProjectAgentBenchmarkSamplePort } from '../project-agent-benchmark/ProjectAgentBenchmarkRunner';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import { DEFAULT_PROJECT_ASSET_ROOTS } from '../../api/types/project';
import type { AiConversationRequest, AiConversationResponse } from '../../api/types/ai-conversation';
import type { AiConversationTransport } from '../ai-authoring/AiConversationTransport';
import { AI_CAPABILITY_SENTINEL_TOOL_NAME } from '../ai-conversation/ProjectAgentCapabilityProbe';
import {
  validateProjectAgentConversationStoreState,
  type ProjectAgentConversationStoreState,
  type ProjectAgentStoredConversationMessage,
} from '../project-agent/ProjectAgentJournal';
import type { ProjectAgentJournalRecord } from '../project-agent/ProjectAgentJournal';
import {
  StandaloneProjectAgentEngine,
  type StandaloneAgentProviderConfig,
  type StandaloneProjectAgentEngineOptions,
} from './StandaloneProjectAgentEngine';
import { StandaloneAiConversationTransport } from './StandaloneAiConversationTransport';
import { projectAgentBenchmarkTaskPrompt } from '../project-agent-benchmark/ProjectAgentBenchmarkFixture';

const PROJECT_ID = 'project-agent-benchmark';
const PROJECT_NAME = 'Project Agent Benchmark';
const SCENE_PATH = 'scenes/start.json';
const SCENE_ENTRY_ID = 'benchmark';
const TMP_PREFIX = 'aeon-agent-benchmark-';
const JOURNAL_DIR_NAME = '.agent-bridge-journal';

/** The Project Agent write toolset (ADR0024). */
const AGENT_WRITE_TOOL_NAMES = new Set([
  'insertStatement',
  'insertCompanion',
  'updateStatement',
  'updateCompanion',
  'deleteSourceItem',
  'moveSourceItem',
  'reorderCompanions',
  'applyAuthoringTransaction',
]);

export interface StandaloneProjectAgentBenchmarkSamplePortOptions {
  readonly provider: StandaloneAgentProviderConfig;
  /** 测试注入;缺省由引擎按 provider 构造(即不传 transport,引擎内部 new Standalone 版) */
  readonly transport?: AiConversationTransport;
  /** 测试注入用;类型照 ProjectAgentCapabilityService */
  readonly capabilityService?: unknown;
  /** 默认 os.tmpdir() */
  readonly baseTmpDir?: string;
}

interface RecordedRequest {
  readonly isProbe: boolean;
  readonly usage: AiConversationResponse['usage'];
}

/**
 * ADR0024 Benchmark Gate sample port over the shared standalone engine
 * (ADR0023 Agent Bridge). One port owns one benchmark sample: it creates an
 * isolated temp project, drives the engine through the task prompt, projects
 * per-model-request benchmark rounds from the durable journal, and cleans the
 * temp project and its private journal. The final document is re-read from the
 * persisted scene file (authoritative source) — never from assistant text.
 */
export function createStandaloneProjectAgentBenchmarkSamplePort(
  options: StandaloneProjectAgentBenchmarkSamplePortOptions,
): ProjectAgentBenchmarkSamplePort {
  const baseTmpDir = options.baseTmpDir ?? os.tmpdir();

  let engine: StandaloneProjectAgentEngine | null = null;
  let tmpDir: string | null = null;

  return {
    async runTask({ taskId, fixture }) {
      // 1. Build the isolated temp project (project.json + scenes/start.json).
      const dir = fs.mkdtempSync(path.join(baseTmpDir, TMP_PREFIX));
      tmpDir = dir;
      writeProjectFiles(dir, fixture);

      // 2. Journal lives in a private sub-directory of the temp project.
      const journalDirectory = path.join(dir, JOURNAL_DIR_NAME);

      // Wrap the transport so every complete() records its usage; when none is
      // injected, build a Standalone transport from the provider so usage is
      // covered for real providers too.
      const records: RecordedRequest[] = [];
      const transport = wrapTransport(options.transport ?? buildTransport(options.provider), records);

      // 3. Open engine; a failure propagates so the runner records run_failed.
      const openOptions: StandaloneProjectAgentEngineOptions = {
        projectDir: dir,
        sceneRelPath: SCENE_PATH,
        journalDirectory,
        provider: options.provider,
        transport,
        ...(options.capabilityService
          ? { capabilityService: options.capabilityService as StandaloneProjectAgentEngineOptions['capabilityService'] }
          : {}),
      };
      const opened = await StandaloneProjectAgentEngine.open(openOptions);
      if (!(opened instanceof StandaloneProjectAgentEngine)) {
        throw new Error(`Engine open failed: ${opened.code} ${opened.message}`);
      }
      engine = opened;

      // 4. Run the benchmark task prompt.
      const versionAtOpen = opened.documentVersion();
      const result = await opened.run(projectAgentBenchmarkTaskPrompt(taskId));

      // 5. The persisted scene file is the authoritative source of truth.
      const document = JSON.parse(
        fs.readFileSync(path.join(dir, SCENE_PATH), 'utf-8'),
      ) as CurrentSceneDocument;

      // 6. Version increase during THIS task: the open() snapshot bump is not
      // part of the task, so diff against the version captured at open. One
      // atomic commit therefore reports exactly 1.
      const documentVersionIncrease = opened.documentVersion() - versionAtOpen;

      // 7. Project rounds from the durable journal conversation store, pairing
      // each business round with its non-probe usage in request order.
      const rounds = projectRounds(result.journal, records);

      return {
        rounds,
        document,
        documentVersionIncrease,
        capabilityProbe: probeUsage(records),
        ...(firstReadTokens(rounds) === undefined ? {} : { firstReadTokens: firstReadTokens(rounds) }),
      };
    },

    async cleanup() {
      if (engine) {
        engine.close();
        engine = null;
      }
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = null;
      }
    },
  };
}

function writeProjectFiles(dir: string, fixture: CurrentSceneDocument): void {
  const scenePath = path.join(dir, SCENE_PATH);
  fs.mkdirSync(path.dirname(scenePath), { recursive: true });
  fs.writeFileSync(scenePath, JSON.stringify(fixture, null, 2), 'utf-8');

  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, 'project.json'),
    JSON.stringify(
      {
        projectId: PROJECT_ID,
        name: PROJECT_NAME,
        projectVersion: 2,
        createdAt: now,
        updatedAt: now,
        defaultSceneId: SCENE_ENTRY_ID,
        scenes: [{ id: SCENE_ENTRY_ID, name: 'Benchmark', path: SCENE_PATH }],
        assetRoots: DEFAULT_PROJECT_ASSET_ROOTS,
        templates: { enabledTemplateIds: ['aeonstagery.default'] },
      },
      null,
      2,
    ),
    'utf-8',
  );
}

function buildTransport(provider: StandaloneAgentProviderConfig): AiConversationTransport {
  return new StandaloneAiConversationTransport({
    endpoint: provider.endpoint,
    ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
  });
}

function wrapTransport(
  inner: AiConversationTransport,
  records: RecordedRequest[],
): AiConversationTransport {
  return {
    async complete(
      request: AiConversationRequest,
      options?: Parameters<AiConversationTransport['complete']>[1],
    ): Promise<AiConversationResponse> {
      const response = await inner.complete(request, options);
      records.push({ isProbe: isCapabilityProbe(request), usage: response.usage });
      return response;
    },
  };
}

function isCapabilityProbe(request: AiConversationRequest): boolean {
  return (request.tools ?? []).length === 0
    || request.tools!.some((tool) => tool.name === AI_CAPABILITY_SENTINEL_TOOL_NAME);
}

/** Aggregate capability-probe usage: reported separately, never task tokens. */
function probeUsage(records: readonly RecordedRequest[]): {
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
} {
  const probes = records.filter((record) => record.isProbe);
  return {
    requestCount: probes.length,
    inputTokens: probes.reduce((total, record) => total + usageTokens(record.usage, 'inputTokens'), 0),
    outputTokens: probes.reduce((total, record) => total + usageTokens(record.usage, 'outputTokens'), 0),
  };
}

function usageTokens(usage: AiConversationResponse['usage'], field: 'inputTokens' | 'outputTokens'): number {
  if (!usage) return 0;
  const value = usage[field];
  return typeof value === 'number' ? value : 0;
}

/**
 * First-read cost: the input+output tokens of the first business round that
 * invokes the scene read tool. Absent when the task never reads the scene.
 */
function firstReadTokens(rounds: readonly ProjectAgentBenchmarkRound[]): number | undefined {
  const firstRead = rounds.find((round) => round.toolNameSequence.includes('readScene'));
  if (!firstRead?.usage) return undefined;
  return firstRead.usage.inputTokens + firstRead.usage.outputTokens;
}

function projectRounds(
  journal: ProjectAgentJournalRecord | null | undefined,
  records: readonly RecordedRequest[],
): readonly ProjectAgentBenchmarkRound[] {
  if (!journal) return [];

  const businessUsages = records.filter((record) => !record.isProbe).map((record) => record.usage);
  const usageIndex = { value: 0 };

  const validation = validateProjectAgentConversationStoreState(journal.conversationBlob);
  if (!validation.ok) return [];

  // versionConflictRetryCount is an overall counters value that is repeated on
  // every round (ADR0024 benchmark report).
  const versionConflictCount = journal.counters?.versionConflictRetryCount ?? 0;

  const messages = messagesInOrder(validation.state);
  const rounds: ProjectAgentBenchmarkRound[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i]!;
    if (message.role === 'assistant') {
      const consumesTools = message.toolCalls.length > 0;
      if (consumesTools) {
        i += 1;
        const toolMessages: ProjectAgentStoredConversationMessage[] = [];
        while (i < messages.length && messages[i]!.role === 'tool') {
          toolMessages.push(messages[i]!);
          i += 1;
        }
        rounds.push(buildRound(toolMessages, businessUsages, usageIndex, versionConflictCount));
      } else {
        // Plain-text assistant message: terminal round carrying no tool calls.
        i += 1;
        rounds.push({
          usage: nextUsage(businessUsages, usageIndex),
          toolNameSequence: [],
          resultCodes: [],
          writeCount: 0,
          versionConflictCount,
        });
      }
    } else {
      // system / user / orphan tool messages are not round boundaries.
      i += 1;
    }
  }
  return rounds;
}

function messagesInOrder(
  state: ProjectAgentConversationStoreState,
): ProjectAgentStoredConversationMessage[] {
  const byId = new Map(state.messages.map((record) => [record.messageId, record.message]));
  return state.currentMessageIds.flatMap((id) => {
    const message = byId.get(id);
    return message ? [message] : [];
  });
}

function buildRound(
  toolMessages: readonly ProjectAgentStoredConversationMessage[],
  businessUsages: readonly (AiConversationResponse['usage'])[],
  usageIndex: { value: number },
  versionConflictCount: number,
): ProjectAgentBenchmarkRound {
  const toolNameSequence: string[] = [];
  const resultCodes: string[] = [];
  let writeCount = 0;

  for (const toolMessage of toolMessages) {
    if (toolMessage.role !== 'tool') continue;
    toolNameSequence.push(toolMessage.name);
    for (const block of toolMessage.content) {
      if (block.type !== 'json') continue;
      const value = block.value;
      if (isRecord(value) && typeof value.code === 'string') {
        resultCodes.push(value.code);
      }
      if (isRecord(value) && value.ok === true && AGENT_WRITE_TOOL_NAMES.has(toolMessage.name)) {
        writeCount += 1;
      }
    }
  }

  return {
    usage: nextUsage(businessUsages, usageIndex),
    toolNameSequence,
    resultCodes,
    writeCount,
    versionConflictCount,
  };
}

function nextUsage(
  businessUsages: readonly (AiConversationResponse['usage'])[],
  usageIndex: { value: number },
): AiConversationResponse['usage'] {
  if (usageIndex.value >= businessUsages.length) return undefined;
  const usage = businessUsages[usageIndex.value]!;
  usageIndex.value += 1;
  return usage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

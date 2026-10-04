import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AI_CAPABILITY_PROBE_NONCE,
  AI_CAPABILITY_SENTINEL_TOOL_NAME,
} from '../services/ai-conversation/ProjectAgentCapabilityProbe';
import type { AiConversationRequest, AiConversationResponse, JsonObject } from '../api/types/ai-conversation';
import type { AiConversationTransport } from '../services/ai-authoring/AiConversationTransport';
import type { ProjectAgentTaskStatusPayload } from '../api/types/project-agent-ipc';
import { DEFAULT_PROJECT_ASSET_ROOTS } from '../api/types/project';
import {
  StandaloneProjectAgentEngine,
  type StandaloneAgentProviderConfig,
} from '../services/project-agent-standalone/StandaloneProjectAgentEngine';
import { createProjectAgentBenchmarkScene } from '../services/project-agent-benchmark/ProjectAgentBenchmarkFixture';

const PROVIDER: StandaloneAgentProviderConfig = {
  endpoint: 'https://ai.example.test/v1',
  defaultModel: 'default-model',
};

function isCapabilityProbe(request: AiConversationRequest): boolean {
  // Tool-call probe carries the sentinel tool; the image-input probe carries
  // no tools at all. Business rounds always register at least the read-only
  // tool set, so an empty tool list can only be the image probe.
  return (request.tools ?? []).length === 0
    || request.tools!.some((tool) => tool.name === AI_CAPABILITY_SENTINEL_TOOL_NAME);
}

function assistantText(text: string): AiConversationResponse {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
  };
}

function assistantTools(
  calls: readonly { name: string; arguments: JsonObject }[],
): AiConversationResponse {
  return {
    message: {
      role: 'assistant',
      content: [],
      toolCalls: calls.map((call, index) => ({
        status: 'ready' as const,
        toolCallId: `call-${index + 1}`,
        name: call.name,
        arguments: call.arguments,
      })),
    },
  };
}

/**
 * Deterministic scripted transport: capability probes always answer the
 * sentinel tool call (admission), business rounds consume the queue in order.
 */
function createScriptedTransport(
  script: readonly (() => AiConversationResponse)[],
): AiConversationTransport & { readonly requests: number } {
  let index = 0;
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    async complete(request: AiConversationRequest): Promise<AiConversationResponse> {
      requests += 1;
      if (isCapabilityProbe(request)) {
        const isToolProbe = (request.tools ?? []).some(
          (tool) => tool.name === AI_CAPABILITY_SENTINEL_TOOL_NAME,
        );
        if (isToolProbe) {
          return assistantTools([
            {
              name: AI_CAPABILITY_SENTINEL_TOOL_NAME,
              arguments: { nonce: AI_CAPABILITY_PROBE_NONCE },
            },
          ]);
        }
        // Image-input probe: a plain text-only assistant reply validates.
        return assistantText('a tiny test image');
      }
      const responder = script[Math.min(index, script.length - 1)];
      index += 1;
      return responder();
    },
  };
}

interface TempProject {
  readonly dir: string;
  readonly projectFilePath: string;
  readonly sceneRelPath: string;
}

function createTempProject(overrides: {
  sceneDocument?: unknown;
  projectJson?: unknown;
  omitSceneFile?: boolean;
  sceneRelPath?: string;
} = {}): TempProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-engine-'));
  const sceneRelPath = overrides.sceneRelPath ?? 'scenes/start.json';
  const projectFilePath = path.join(dir, 'project.json');
  const projectJson = overrides.projectJson ?? {
    projectId: 'test-project',
    name: 'Test Project',
    projectVersion: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    defaultSceneId: 'start',
    scenes: [{ id: 'start', name: 'Start', path: sceneRelPath }],
    assetRoots: DEFAULT_PROJECT_ASSET_ROOTS,
    templates: { enabledTemplateIds: ['aeonstagery.default'] },
  };
  fs.writeFileSync(projectFilePath, JSON.stringify(projectJson, null, 2), 'utf-8');
  if (!overrides.omitSceneFile) {
    const scenePath = path.join(dir, sceneRelPath);
    fs.mkdirSync(path.dirname(scenePath), { recursive: true });
    fs.writeFileSync(
      scenePath,
      JSON.stringify(overrides.sceneDocument ?? createProjectAgentBenchmarkScene(), null, 2),
      'utf-8',
    );
  }
  return { dir, projectFilePath, sceneRelPath };
}

function readSceneDocument(dir: string, sceneRelPath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(dir, sceneRelPath), 'utf-8'));
}

function dialogueText(document: unknown, statementId: string): string | undefined {
  const candidate = document as { statements?: readonly { id?: string; params?: { text?: string } }[] };
  const statement = candidate.statements?.find((item) => item.id === statementId);
  return statement?.params?.text;
}

const tempProjects: TempProject[] = [];

function trackTempProject(project: TempProject): TempProject {
  tempProjects.push(project);
  return project;
}

beforeEach(() => {
  tempProjects.length = 0;
});

afterEach(() => {
  for (const project of tempProjects) {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

describe('StandaloneProjectAgentEngine.open', () => {
  it('fails with invalid_project when project.json is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-engine-missing-'));
    tempProjects.push({ dir, projectFilePath: path.join(dir, 'project.json'), sceneRelPath: 'scenes/start.json' });
    const result = await StandaloneProjectAgentEngine.open({
      projectDir: dir,
      sceneRelPath: 'scenes/start.json',
      journalDirectory: path.join(dir, 'journal'),
      provider: PROVIDER,
    });
    expect('ok' in result).toBe(true);
    if ('ok' in result) expect(result.code).toBe('invalid_project');
  });

  it('fails with invalid_project when project.json is not valid JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-engine-badjson-'));
    tempProjects.push({ dir, projectFilePath: path.join(dir, 'project.json'), sceneRelPath: 'scenes/start.json' });
    fs.writeFileSync(path.join(dir, 'project.json'), '{ not json', 'utf-8');
    const result = await StandaloneProjectAgentEngine.open({
      projectDir: dir,
      sceneRelPath: 'scenes/start.json',
      journalDirectory: path.join(dir, 'journal'),
      provider: PROVIDER,
    });
    expect('ok' in result).toBe(true);
    if ('ok' in result) expect(result.code).toBe('invalid_project');
  });

  it('fails with scene_not_found when the scene path is not registered', async () => {
    const project = trackTempProject(createTempProject());
    const result = await StandaloneProjectAgentEngine.open({
      projectDir: project.dir,
      sceneRelPath: 'scenes/other.json',
      journalDirectory: path.join(project.dir, 'journal'),
      provider: PROVIDER,
    });
    expect('ok' in result).toBe(true);
    if ('ok' in result) expect(result.code).toBe('scene_not_found');
  });

  it('fails with invalid_scene when the scene file is missing or invalid', async () => {
    const missing = trackTempProject(createTempProject({ omitSceneFile: true }));
    const resultMissing = await StandaloneProjectAgentEngine.open({
      projectDir: missing.dir,
      sceneRelPath: missing.sceneRelPath,
      journalDirectory: path.join(missing.dir, 'journal'),
      provider: PROVIDER,
    });
    expect('ok' in resultMissing).toBe(true);
    if ('ok' in resultMissing) expect(resultMissing.code).toBe('invalid_scene');

    const invalid = trackTempProject(createTempProject({ sceneDocument: { schemaVersion: 999, sceneId: 'x' } }));
    const resultInvalid = await StandaloneProjectAgentEngine.open({
      projectDir: invalid.dir,
      sceneRelPath: invalid.sceneRelPath,
      journalDirectory: path.join(invalid.dir, 'journal'),
      provider: PROVIDER,
    });
    expect('ok' in resultInvalid).toBe(true);
    if ('ok' in resultInvalid) expect(resultInvalid.code).toBe('invalid_scene');
  });
});

describe('StandaloneProjectAgentEngine rounds', () => {
  it('runs a full write round: readScene → updateStatement → scene file persisted with the change', async () => {
    const project = trackTempProject(createTempProject());
    const transport = createScriptedTransport([
      () => assistantTools([{ name: 'readScene', arguments: { startLine: 1, lineCount: 500 } }]),
      () => assistantTools([
        {
          name: 'updateStatement',
          arguments: {
            statementId: 'dlg_update_target',
            patch: { params: { text: '森林深处的回响' } },
          },
        },
      ]),
      () => assistantText('完成'),
    ]);
    const engineResult = await StandaloneProjectAgentEngine.open({
      projectDir: project.dir,
      sceneRelPath: project.sceneRelPath,
      journalDirectory: path.join(project.dir, 'journal'),
      provider: PROVIDER,
      transport,
    });
    expect(engineResult).toBeInstanceOf(StandaloneProjectAgentEngine);
    if (!(engineResult instanceof StandaloneProjectAgentEngine)) return;
    const engine = engineResult;

    const result = await engine.run('把 dlg_update_target 的台词改成 森林深处的回响');
    expect(result.ok).toBe(true);
    expect(result.taskId).toBeTruthy();
    expect(result.projectId).toBe('test-project');
    expect(result.lifecycle).toBe('idle');
    expect(result.finalAssistantText).toBe('完成');
    expect(result.documentVersion).toBeGreaterThan(0);

    const persisted = readSceneDocument(project.dir, project.sceneRelPath);
    expect(dialogueText(persisted, 'dlg_update_target')).toBe('森林深处的回响');
    expect(dialogueText(persisted, 'dlg_batch_target')).toBeTruthy();

    expect(result.activities?.length ?? 0).toBeGreaterThan(0);
    expect(result.committedReceipts?.length ?? 0).toBeGreaterThan(0);
    expect(transport.requests).toBeGreaterThan(2); // probe + at least 2 business rounds

    // Journal record is durable on disk under the independent journal dir.
    const journalFiles = fs.existsSync(path.join(project.dir, 'journal'))
      ? fs.readdirSync(path.join(project.dir, 'journal'))
      : [];
    expect(journalFiles.length).toBeGreaterThan(0);
    engine.close();
  });

  it('zero-write round leaves the scene file untouched and reports no receipts', async () => {
    const project = trackTempProject(createTempProject());
    const before = fs.readFileSync(path.join(project.dir, project.sceneRelPath), 'utf-8');
    const transport = createScriptedTransport([
      () => assistantText('当前场景无需修改。'),
    ]);
    const engineResult = await StandaloneProjectAgentEngine.open({
      projectDir: project.dir,
      sceneRelPath: project.sceneRelPath,
      journalDirectory: path.join(project.dir, 'journal'),
      provider: PROVIDER,
      transport,
    });
    expect(engineResult).toBeInstanceOf(StandaloneProjectAgentEngine);
    if (!(engineResult instanceof StandaloneProjectAgentEngine)) return;
    const engine = engineResult;

    const result = await engine.run('检查当前场景');
    expect(result.ok).toBe(true);
    expect(result.lifecycle).toBe('idle');
    expect(result.finalAssistantText).toBe('当前场景无需修改。');
    expect(result.committedReceipts ?? []).toHaveLength(0);
    // open() itself bumps the store from 0 → 1 when it loads the scene.
    expect(result.documentVersion).toBe(1);
    expect(fs.readFileSync(path.join(project.dir, project.sceneRelPath), 'utf-8')).toBe(before);
    engine.close();
  });

  it('applies the provider context window to the coordinator budget', async () => {
    const project = trackTempProject(createTempProject());
    const transport = createScriptedTransport([
      () => assistantText('当前场景无需修改。'),
    ]);
    const statuses: ProjectAgentTaskStatusPayload[] = [];
    const engineResult = await StandaloneProjectAgentEngine.open({
      projectDir: project.dir,
      sceneRelPath: project.sceneRelPath,
      journalDirectory: path.join(project.dir, 'journal'),
      provider: { ...PROVIDER, contextWindow: 1_000_000 },
      transport,
      onStatus: (status) => {
        statuses.push(status);
      },
    });
    expect(engineResult).toBeInstanceOf(StandaloneProjectAgentEngine);
    if (!(engineResult instanceof StandaloneProjectAgentEngine)) return;
    const engine = engineResult;

    const result = await engine.run('检查当前场景');
    expect(result.ok).toBe(true);

    // The explicit provider context window must reach the coordinator budget
    // (ADR0023) instead of the 262144 conservative fallback.
    const contextUsed = statuses
      .map((status) => status.contextUsed)
      .find((info) => info !== undefined);
    expect(contextUsed).toBeDefined();
    expect(contextUsed?.contextWindow).toBe(1_000_000);
    engine.close();
  });

  it('send() continues the same conversation and persists a second round write', async () => {    const project = trackTempProject(createTempProject());
    const transport = createScriptedTransport([
      () => assistantText('收到,请继续。'),
      // A fresh execution round must re-read the scene before it can write.
      () => assistantTools([{ name: 'readScene', arguments: { startLine: 1, lineCount: 500 } }]),
      () => assistantTools([
        {
          name: 'updateStatement',
          arguments: {
            statementId: 'dlg_update_target',
            patch: { params: { text: '第二回合的台词' } },
          },
        },
      ]),
      () => assistantText('第二回合完成'),
    ]);
    const engineResult = await StandaloneProjectAgentEngine.open({
      projectDir: project.dir,
      sceneRelPath: project.sceneRelPath,
      journalDirectory: path.join(project.dir, 'journal'),
      provider: PROVIDER,
      transport,
    });
    expect(engineResult).toBeInstanceOf(StandaloneProjectAgentEngine);
    if (!(engineResult instanceof StandaloneProjectAgentEngine)) return;
    const engine = engineResult;

    const first = await engine.run('查看场景');
    expect(first.ok).toBe(true);
    expect(first.finalAssistantText).toContain('收到');
    expect(first.documentVersion).toBe(1);

    const second = await engine.send('继续修改台词');
    expect(second.ok).toBe(true);
    expect(second.finalAssistantText).toBe('第二回合完成');
    expect(second.taskId).toBe(first.taskId);
    expect(second.documentVersion).toBeGreaterThan(0);

    const persisted = readSceneDocument(project.dir, project.sceneRelPath);
    expect(dialogueText(persisted, 'dlg_update_target')).toBe('第二回合的台词');
    engine.close();
  });

  it('reports a start failure when the task text is empty', async () => {
    const project = trackTempProject(createTempProject());
    const engineResult = await StandaloneProjectAgentEngine.open({
      projectDir: project.dir,
      sceneRelPath: project.sceneRelPath,
      journalDirectory: path.join(project.dir, 'journal'),
      provider: PROVIDER,
      transport: createScriptedTransport([]),
    });
    expect(engineResult).toBeInstanceOf(StandaloneProjectAgentEngine);
    if (!(engineResult instanceof StandaloneProjectAgentEngine)) return;
    const result = await engineResult.run('   ');
    expect('ok' in result).toBe(true);
    expect(result.code).toBe('invalid_arguments');
    engineResult.close();
  });

  it('defaults the task accessMode to standard and honors an explicit full_access', async () => {
    const project = trackTempProject(createTempProject());

    const defaultResult = await StandaloneProjectAgentEngine.open({
      projectDir: project.dir,
      sceneRelPath: project.sceneRelPath,
      journalDirectory: path.join(project.dir, 'journal'),
      provider: PROVIDER,
      transport: createScriptedTransport([() => assistantText('完成')]),
    });
    expect(defaultResult).toBeInstanceOf(StandaloneProjectAgentEngine);
    if (!(defaultResult instanceof StandaloneProjectAgentEngine)) return;
    const defaultEngine = defaultResult;
    await defaultEngine.run('查看场景');
    // ADR0025: no --access-mode means the conservative app-side default
    // (standard); full_access must be requested explicitly.
    expect(defaultEngine.service?.getTaskSnapshot()?.identity.accessMode).toBe('standard');
    defaultEngine.close();

    const fullResult = await StandaloneProjectAgentEngine.open({
      projectDir: project.dir,
      sceneRelPath: project.sceneRelPath,
      journalDirectory: path.join(project.dir, 'journal-full'),
      provider: PROVIDER,
      transport: createScriptedTransport([() => assistantText('完成')]),
      accessMode: 'full_access',
    });
    expect(fullResult).toBeInstanceOf(StandaloneProjectAgentEngine);
    if (!(fullResult instanceof StandaloneProjectAgentEngine)) return;
    const fullEngine = fullResult;
    await fullEngine.run('查看场景');
    expect(fullEngine.service?.getTaskSnapshot()?.identity.accessMode).toBe('full_access');
    fullEngine.close();
  });

  it('forwards status events through onStatus', async () => {
    const project = trackTempProject(createTempProject());
    const statuses: string[] = [];
    const engineResult = await StandaloneProjectAgentEngine.open({
      projectDir: project.dir,
      sceneRelPath: project.sceneRelPath,
      journalDirectory: path.join(project.dir, 'journal'),
      provider: PROVIDER,
      transport: createScriptedTransport([() => assistantText('完成')]),
      onStatus: (status) => { statuses.push(`${status.lifecycle}:${status.phase}`); },
    });
    expect(engineResult).toBeInstanceOf(StandaloneProjectAgentEngine);
    if (!(engineResult instanceof StandaloneProjectAgentEngine)) return;
    await engineResult.run('查看场景');
    expect(statuses.length).toBeGreaterThan(0);
    engineResult.close();
  });

  it('keeps journal records isolated between independent journal directories', async () => {
    const project = trackTempProject(createTempProject());
    const journalA = path.join(project.dir, 'journal-a');
    const journalB = path.join(project.dir, 'journal-b');
    const engineA = await StandaloneProjectAgentEngine.open({
      projectDir: project.dir,
      sceneRelPath: project.sceneRelPath,
      journalDirectory: journalA,
      provider: PROVIDER,
      transport: createScriptedTransport([() => assistantText('A 完成')]),
    });
    const engineB = await StandaloneProjectAgentEngine.open({
      projectDir: project.dir,
      sceneRelPath: project.sceneRelPath,
      journalDirectory: journalB,
      provider: PROVIDER,
      transport: createScriptedTransport([() => assistantText('B 完成')]),
    });
    expect(engineA).toBeInstanceOf(StandaloneProjectAgentEngine);
    expect(engineB).toBeInstanceOf(StandaloneProjectAgentEngine);
    if (!(engineA instanceof StandaloneProjectAgentEngine) || !(engineB instanceof StandaloneProjectAgentEngine)) return;

    await engineA.run('A 的任务');
    await engineB.run('B 的任务');
    expect(fs.readdirSync(journalA)).toHaveLength(1);
    expect(fs.readdirSync(journalB)).toHaveLength(1);
    engineA.close();
    engineB.close();
  });
});

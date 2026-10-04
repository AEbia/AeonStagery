import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AiConversationIpc, AiConversationIpcResult } from '../api/types/ai-conversation-ipc';
import type { AiConversationRequest, AiConversationResponse } from '../api/types/ai-conversation';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { ProjectAgentTaskStatusPayload } from '../api/types/project-agent-ipc';
import { createAiConversationElectronTransport } from '../services/ai-conversation/AiConversationElectronTransport';
import {
  AI_CAPABILITY_PROBE_NONCE,
  AI_CAPABILITY_SENTINEL_TOOL_NAME,
} from '../services/ai-conversation/ProjectAgentCapabilityProbe';
import { InMemoryProjectAgentLeasePort } from '../services/project-agent/ProjectAgentLease';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import {
  ProjectAgentTaskCoordinator,
  type ProjectAgentWindowController,
} from '../services/project-agent-service/ProjectAgentTaskCoordinator';
import { FileSystemProjectAgentJournalPort } from '../services/project-agent-service/FileSystemProjectAgentJournalPort';
import { createEditorProjectAgentService } from '../services/project-agent-service/createEditorProjectAgentService';

const ENDPOINT = 'https://provider.example.test/v1';
const MODEL = 'model-1m-context';
const PROJECT_ID = 'project-context-window';
const SCENE_ENTRY_ID = 'scene-entry-context-window';
const SCENE_DOCUMENT_ID = 'scene-doc-context-window';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: SCENE_DOCUMENT_ID,
    meta: { title: 'Context Window Scene', characters: [] },
    statements: [],
  };
}

function sentinelProbeResponse(contextWindow: number): AiConversationResponse {
  return {
    message: {
      role: 'assistant',
      content: [],
      toolCalls: [{
        status: 'ready',
        toolCallId: 'probe-1',
        name: AI_CAPABILITY_SENTINEL_TOOL_NAME,
        arguments: { nonce: AI_CAPABILITY_PROBE_NONCE },
      }],
    },
    contextWindow,
  };
}

function plainTextReply(text: string): AiConversationResponse {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
  };
}

function createComposition(responses: Array<AiConversationResponse | Error>): {
  service: ReturnType<typeof createEditorProjectAgentService>;
  requests: AiConversationRequest[];
  statuses: ProjectAgentTaskStatusPayload[];
  tempDirectory: string;
} {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-window-test-'));
  const requests: AiConversationRequest[] = [];
  const statuses: ProjectAgentTaskStatusPayload[] = [];

  const conversationIpc: AiConversationIpc = {
    complete: async ({ requestId, request }): Promise<AiConversationIpcResult> => {
      requests.push(request);
      expect(requestId.length).toBeGreaterThan(0);
      const next = responses.shift();
      if (!next) return { status: 'error', code: 'unknown', message: 'No more responses', retryable: false };
      if (next instanceof Error) throw next;
      return { status: 'ok', response: next };
    },
    cancel: async () => 'alreadySettled',
  };

  const transport = createAiConversationElectronTransport({ conversation: conversationIpc } as never);

  const windowController: ProjectAgentWindowController = {
    openAgentWindow: () => undefined,
    sendToAgentWindow: (status) => {
      statuses.push(status);
    },
  };

  const main = new ProjectAgentTaskCoordinator({
    journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
    lease: new InMemoryProjectAgentLeasePort(),
    window: windowController,
    now: () => 1000,
  });

  const document = makeDocument();
  const readPorts: ProjectAgentReadPorts = {
    overview: {
      getOverview: () => ({
        name: 'Context Window Project',
        projectVersion: 1,
        activeScene: { name: 'Context Window Scene', relativePath: 'scenes/main.scene.json' },
        scenes: [{ name: 'Context Window Scene', relativePath: 'scenes/main.scene.json' }],
        assetRoots: {},
      }),
    },
    files: { listFiles: () => [] },
    text: { readText: () => ({ lines: [], binary: false }) },
    textSearch: { searchText: () => [] },
    resources: { searchResources: () => [] },
    resourceInspect: {
      inspectResource: (reference) => ({
        exists: true,
        reference,
        scope: 'project',
        bindable: true,
      }),
    },
    scene: { getSnapshot: () => ({ document, version: 1 }) },
    validation: { validate: () => [] },
  };
  let authored = document;
  let authoredVersion = 1;
  const writePorts: ProjectAgentWritePorts = {
    scene: { getSnapshot: () => ({ document: authored, version: authoredVersion }) },
    validation: { validate: () => [] },
    authoring: {
      commit: (request) => {
        authored = request.candidate;
        authoredVersion += 1;
        return { version: authoredVersion };
      },
    },
  };

  const service = createEditorProjectAgentService({
    transport,
    host: main,
    readPorts,
    writePorts,
    baseSystemPrompt: 'You are the autonomous project Agent.',
    resolveProvider: () => ({ endpoint: ENDPOINT, defaultModel: MODEL }),
    resolveTargetIdentity: () => ({
      ok: true,
      projectId: PROJECT_ID,
      sceneEntryId: SCENE_ENTRY_ID,
      sceneDocumentId: SCENE_DOCUMENT_ID,
      sceneName: 'Context Window Scene',
    }),
    verifyTargetIdentity: () => ({ ok: true }),
    idFactory: () => `context-window-task-${PROJECT_ID}`,
  });

  return { service, requests, statuses, tempDirectory };
}

describe('editor project agent context-window probing (ADR0023)', () => {
  afterEach(() => {
    // Temp directories are removed per-composition below.
  });

  it('passes the probed provider context window into the coordinator budget', async () => {
    const composition = createComposition([
      // 1. Capability tool probe: the provider reports a 1M context window.
      sentinelProbeResponse(1_000_000),
      // 2. Capability image probe: deterministic text reply.
      plainTextReply('A tiny image.'),
      // 3. Task round 1: a read tool call.
      {
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [{
            status: 'ready',
            toolCallId: 'c1',
            name: 'readProjectOverview',
            arguments: {},
          }],
        },
      },
      // 4. Task round 2: settle with a plain reply.
      plainTextReply('Nothing to change'),
    ]);

    try {
      const started = await composition.service.start({ taskText: 'Verify the scene needs no changes' });
      expect(started.ok).toBe(true);
      await composition.service.whenIdle();

      // The capability probe ran over the transport before any model turn.
      expect(composition.requests.length).toBeGreaterThanOrEqual(4);

      const contextUsed = composition.statuses
        .map((status) => status.contextUsed)
        .find((info) => info !== undefined);
      expect(contextUsed).toBeDefined();
      // Regression: the probed 1M window must reach the coordinator instead of
      // being dropped for the conservative 262144 default.
      expect(contextUsed?.contextWindow).toBe(1_000_000);
    } finally {
      fs.rmSync(composition.tempDirectory, { recursive: true, force: true });
    }
  });

  it('keeps the conservative default when the probe reports no context window', async () => {
    const composition = createComposition([
      // Tool probe without a context window.
      {
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [{
            status: 'ready',
            toolCallId: 'probe-1',
            name: AI_CAPABILITY_SENTINEL_TOOL_NAME,
            arguments: { nonce: AI_CAPABILITY_PROBE_NONCE },
          }],
        },
      },
      plainTextReply('A tiny image.'),
      plainTextReply('Nothing to change'),
    ]);

    try {
      const started = await composition.service.start({ taskText: 'Verify the scene' });
      expect(started.ok).toBe(true);
      await composition.service.whenIdle();

      const contextUsed = composition.statuses
        .map((status) => status.contextUsed)
        .find((info) => info !== undefined);
      expect(contextUsed).toBeDefined();
      expect(contextUsed?.contextWindow).toBe(262144);
    } finally {
      fs.rmSync(composition.tempDirectory, { recursive: true, force: true });
    }
  });
});

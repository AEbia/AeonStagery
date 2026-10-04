import * as fs from 'fs';
import * as path from 'path';
import { sceneDocumentCodec } from '../semantic-scene';
import { projectMetadataCodec } from '../project/ProjectMetadataCodec';
import { DocumentStore } from '../../ui/store/DocumentStore';
import {
  type ExternalLibraryMount,
  type ProjectMetadata,
  type ProjectState,
} from '../../api/types/project';
import type { ProjectAgentAccessMode } from '../../api/types/project-agent';
import type { ProjectAgentHostWriteReceipt } from '../../api/types/project-agent';
import {
  type ProjectAgentJournalRecord,
  validateProjectAgentConversationStoreState,
} from '../project-agent/ProjectAgentJournal';
import type { ProjectAgentActivityRecord } from '../project-agent/ProjectAgentTask';
import type {
  ProjectAgentReadPorts,
  ProjectAgentSceneSnapshot,
  ProjectAgentWritePorts,
} from '../project-agent/ProjectAgentPorts';
import { ProjectAgentNodeProjectFs } from '../project-agent/ProjectAgentNodeProjectFs';
import { createProjectAgentProjectReadPorts } from '../project-agent/ProjectAgentProjectReadPorts';
import { createProjectAgentResourcePorts } from '../project-agent/ProjectAgentResourcePorts';
import { createProjectAgentImageReadPort } from '../project-agent/ProjectAgentImageReadPort';
import {
  createProjectAgentOverviewPort,
  type ProjectAgentOverviewSource,
} from '../project-agent-service/ProjectAgentOverviewPort';
import { runProjectAgentSceneValidation } from '../project-agent-service/ProjectAgentSceneValidation';
import { createProjectAgentAuthoringGate } from '../project-agent-service/ProjectAgentAuthoringGate';
import { createEditorProjectAgentService } from '../project-agent-service/createEditorProjectAgentService';
import type { ProjectAgentCapabilityService } from '../ai-conversation/ProjectAgentCapabilities';
import type { AiConversationTransport } from '../ai-authoring/AiConversationTransport';
import type { ProjectAgentTaskStatusPayload } from '../../api/types/project-agent-ipc';
import type { ProjectAgentService } from '../project-agent-service/ProjectAgentService';
import type { AiConversationFetch } from '../../../electron/aiConversationProvider';
import { StandaloneAiConversationTransport } from './StandaloneAiConversationTransport';
import { StandaloneProjectAgentHost } from './StandaloneProjectAgentHost';

export interface StandaloneAgentProviderConfig {
  readonly endpoint: string;
  readonly defaultModel: string;
  readonly projectAgentModel?: string;
  readonly apiKey?: string;
  readonly contextWindow?: number;
}

export interface StandaloneProjectAgentEngineOptions {
  readonly projectDir: string;
  readonly sceneRelPath: string;
  readonly journalDirectory: string;
  readonly provider: StandaloneAgentProviderConfig;
  readonly accessMode?: ProjectAgentAccessMode;
  readonly externalMounts?: readonly ExternalLibraryMount[];
  readonly transport?: AiConversationTransport;
  readonly capabilityService?: ProjectAgentCapabilityService;
  readonly onStatus?: (status: ProjectAgentTaskStatusPayload) => void;
  readonly fetchImpl?: AiConversationFetch;
}

export interface StandaloneProjectAgentRunResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly lifecycle?: string;
  readonly pauseReason?: string;
  readonly finalAssistantText?: string;
  readonly activities?: readonly ProjectAgentActivityRecord[];
  readonly committedReceipts?: readonly ProjectAgentHostWriteReceipt[];
  readonly documentVersion?: number;
  readonly journal?: ProjectAgentJournalRecord | null;
}

const JOURNAL_POLL_ATTEMPTS = 5;
const JOURNAL_POLL_DELAY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalize a project-relative path to `/` separators without leading/trailing slashes. */
function normalizeProjectRelative(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * Headless "Agent Bridge" engine (ADR0023): assembles the full production
 * `ProjectAgentService` over the filesystem project workspace, a Node fs
 * seam, a fresh `DocumentStore` and the Standalone host/transport, so Node
 * can open a project + scene and drive the project Agent to result.
 */
export class StandaloneProjectAgentEngine {
  readonly service: ProjectAgentService | null;
  readonly projectId: string;
  readonly sceneEntryId: string;
  readonly sceneDocumentId: string;
  readonly sceneName: string;

  private readonly documentStore: DocumentStore;
  private readonly host: StandaloneProjectAgentHost;
  private readonly accessMode: ProjectAgentAccessMode;
  private activeTaskId: string | null = null;

  private constructor(options: {
    service: ProjectAgentService;
    projectId: string;
    sceneEntryId: string;
    sceneDocumentId: string;
    sceneName: string;
    documentStore: DocumentStore;
    host: StandaloneProjectAgentHost;
    accessMode: ProjectAgentAccessMode;
  }) {
    this.service = options.service;
    this.projectId = options.projectId;
    this.sceneEntryId = options.sceneEntryId;
    this.sceneDocumentId = options.sceneDocumentId;
    this.sceneName = options.sceneName;
    this.documentStore = options.documentStore;
    this.host = options.host;
    this.accessMode = options.accessMode;
  }

  static async open(
    options: StandaloneProjectAgentEngineOptions,
  ): Promise<StandaloneProjectAgentEngine | { ok: false; code: string; message: string }> {
    const failed = (code: string, message: string) => ({ ok: false as const, code, message });

    const projectFilePath = path.join(options.projectDir, 'project.json');
    if (!fs.existsSync(projectFilePath)) {
      return failed('invalid_project', `project.json does not exist at ${projectFilePath}`);
    }

    let rawProject: unknown;
    try {
      rawProject = JSON.parse(fs.readFileSync(projectFilePath, 'utf-8'));
    } catch (error) {
      return failed('invalid_project', `project.json is not valid JSON: ${messageOf(error)}`);
    }
    // Use the canonical project metadata codec (same contract as the app's
    // project loader): top-level projectId/name/scenes, v2 schema epoch.
    let metadata: ProjectMetadata;
    try {
      metadata = projectMetadataCodec.parseKnownProjection(rawProject);
    } catch (error) {
      return failed('invalid_project', `project.json is not valid: ${messageOf(error)}`);
    }

    const sceneRel = normalizeProjectRelative(options.sceneRelPath);
    const entry = metadata.scenes.find(
      (candidate) => normalizeProjectRelative(candidate.path) === sceneRel,
    );
    if (!entry) {
      return failed('scene_not_found', `No scene entry registered for path "${options.sceneRelPath}"`);
    }

    // Read + parse the scene file relative to the project root.
    const sceneAbsPath = path.join(options.projectDir, sceneRel);
    let rawScene: string;
    try {
      rawScene = fs.readFileSync(sceneAbsPath, 'utf-8');
    } catch (error) {
      return failed('invalid_scene', `Scene file is unreadable: ${messageOf(error)}`);
    }
    let parsedScene: unknown;
    try {
      parsedScene = JSON.parse(rawScene);
    } catch (error) {
      return failed('invalid_scene', `Scene file is not valid JSON: ${messageOf(error)}`);
    }
    let document;
    try {
      document = sceneDocumentCodec.parseAndValidate(parsedScene);
    } catch (error) {
      return failed('invalid_scene', `Scene document failed validation: ${messageOf(error)}`);
    }

    const projectState: ProjectState = {
      rootPath: options.projectDir,
      projectFilePath,
      metadata,
    };

    // The task spec requires valid assetRoots; default when the loaded
    // project.metadata.assetRoots is incomplete so resource scans work.
    const assetRoots = Object.fromEntries(Object.entries(metadata.assetRoots));

    const documentStore = new DocumentStore();
    documentStore._replaceCurrentSceneDocumentSnapshot(document);
    documentStore._setFilePath(sceneAbsPath);

    const fsAdapter = new ProjectAgentNodeProjectFs();
    const getExternalMounts = () => options.externalMounts ?? [];
    const readPorts = createProjectAgentProjectReadPorts({
      fs: fsAdapter,
      getProjectRoot: () => options.projectDir,
      getExternalMounts,
    });
    const resourcePorts = createProjectAgentResourcePorts({
      fs: fsAdapter,
      getProject: () => projectState,
      getExternalMounts,
      getTemplatePackages: () => [],
    });
    const imagePort = createProjectAgentImageReadPort({
      fs: fsAdapter,
      getProject: () => projectState,
      getExternalMounts,
    });

    const projectAgentReadPorts: ProjectAgentReadPorts = {
      overview: createProjectAgentOverviewPort({
        getSource: (): ProjectAgentOverviewSource => ({
          name: metadata.name,
          projectVersion: metadata.projectVersion,
          activeScene: { name: entry.name, path: entry.path },
          scenes: metadata.scenes,
          assetRoots,
        }),
      }),
      files: readPorts.files,
      text: readPorts.text,
      textSearch: readPorts.textSearch,
      resources: resourcePorts.resources,
      resourceInspect: resourcePorts.resourceInspect,
      image: imagePort,
      scene: {
        getSnapshot: (): ProjectAgentSceneSnapshot | null => {
          const current = documentStore.getCurrentSceneDocumentSnapshot();
          return current ? { document: current, version: documentStore.version } : null;
        },
      },
      validation: {
        validate: (doc) => runProjectAgentSceneValidation(doc),
      },
    };

    const projectAgentWritePorts: ProjectAgentWritePorts = {
      scene: {
        getSnapshot: () => projectAgentReadPorts.scene.getSnapshot(),
      },
      validation: {
        validate: createProjectAgentAuthoringGate({
          validateStructure: runProjectAgentSceneValidation,
          inspectResource: resourcePorts.resourceInspect.inspectResource,
        }),
      },
      authoring: {
        commit: async (request) => {
          documentStore._replaceCurrentSceneDocumentSnapshot(request.candidate);
          await writeSceneFileAtomic(sceneAbsPath, request.candidate);
          return { version: documentStore.version };
        },
      },
    };

    const host = new StandaloneProjectAgentHost({
      journalDirectory: options.journalDirectory,
      onStatus: options.onStatus,
    });
    const transport = options.transport
      ?? new StandaloneAiConversationTransport({
        endpoint: options.provider.endpoint,
        ...(options.provider.apiKey !== undefined ? { apiKey: options.provider.apiKey } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });

    const baseSystemPrompt = 'You are the autonomous project Agent of this AeonStagery project. Complete the user task with controlled tools when needed, then finish with a normal assistant reply.';

    const service = createEditorProjectAgentService({
      transport,
      host,
      readPorts: projectAgentReadPorts,
      writePorts: projectAgentWritePorts,
      baseSystemPrompt,
      resolveProvider: () => ({
        endpoint: options.provider.endpoint,
        defaultModel: options.provider.defaultModel,
        ...(options.provider.projectAgentModel
          ? { projectAgentModel: options.provider.projectAgentModel }
          : {}),
      }),
      resolveTargetIdentity: () => ({
        ok: true,
        projectId: metadata.projectId,
        sceneEntryId: entry.id,
        sceneDocumentId: document.sceneId,
        sceneName: entry.name,
      }),
      verifyTargetIdentity: () => ({ ok: true }),
      ...(options.capabilityService ? { capabilityService: options.capabilityService } : {}),
      ...(options.provider.contextWindow !== undefined
        ? { contextWindow: options.provider.contextWindow }
        : {}),
    });

    return new StandaloneProjectAgentEngine({
      service,
      projectId: metadata.projectId,
      sceneEntryId: entry.id,
      sceneDocumentId: document.sceneId,
      sceneName: entry.name,
      documentStore,
      host,
      // Default to the same conservative accessMode as the app-side task
      // surface (standard): full_access must be requested explicitly via
      // --access-mode/--full-access (ADR0025). The standalone host never
      // wires a terminal, so the only effect is the persisted/status mode.
      accessMode: options.accessMode ?? 'standard',
    });
  }

  documentVersion(): number {
    return this.documentStore.version;
  }

  async run(taskText: string): Promise<StandaloneProjectAgentRunResult> {
    if (!this.service) {
      return { ok: false, code: 'no_service', message: 'Project Agent service is not available' };
    }
    const started = await this.service.start({
      taskText,
      accessMode: this.accessMode,
    });
    if (!started.ok) {
      return {
        ok: false,
        code: started.code,
        message: started.message,
        projectId: this.projectId,
        ...(started.existingTaskId ? { taskId: started.existingTaskId } : {}),
      };
    }
    const taskId = started.task.identity.taskId;
    this.activeTaskId = taskId;
    await this.service.whenIdle();
    return this.projectResult(taskId);
  }

  async send(text: string): Promise<StandaloneProjectAgentRunResult> {
    if (!this.service) {
      return { ok: false, code: 'no_task', message: 'No active project Agent task' };
    }
    const taskId = this.activeTaskId ?? this.service.getTaskSnapshot()?.identity.taskId;
    if (!taskId) {
      return { ok: false, code: 'no_task', message: 'No active project Agent task' };
    }
    this.activeTaskId = taskId;
    const supplemented = await this.service.sendSupplement(text);
    if (!supplemented.ok) {
      return { ok: false, code: 'send_failed', message: supplemented.error };
    }
    await this.service.whenIdle();
    return this.projectResult(taskId);
  }

  async pause(): Promise<{ ok: boolean; error?: string }> {
    if (!this.service) return { ok: false, error: 'No active project Agent task' };
    return this.service.pause();
  }

  async cancel(): Promise<{ ok: boolean; error?: string }> {
    if (!this.service) return { ok: false, error: 'No active project Agent task' };
    return this.service.cancel();
  }

  async whenIdle(): Promise<void> {
    if (this.service) await this.service.whenIdle();
  }

  /** Release service/task references; does not delete the journal. */
  close(): void {
    this.service?.discardTask();
    this.activeTaskId = null;
  }

  private async projectResult(taskId: string): Promise<StandaloneProjectAgentRunResult> {
    const journal = await this.loadJournalWithRetry(taskId);
    const finalAssistantText = journal ? projectFinalAssistantText(journal) : undefined;
    return {
      ok: true,
      projectId: this.projectId,
      taskId,
      ...(journal?.lifecycle ? { lifecycle: journal.lifecycle } : {}),
      ...(journal?.pauseReason ? { pauseReason: journal.pauseReason } : {}),
      ...(finalAssistantText !== undefined ? { finalAssistantText } : {}),
      activities: journal?.activities ?? [],
      committedReceipts: journal?.committedReceipts ?? [],
      documentVersion: this.documentStore.version,
      journal: journal ?? null,
    };
  }

  private async loadJournalWithRetry(taskId: string): Promise<ProjectAgentJournalRecord | null> {
    let journal: ProjectAgentJournalRecord | null = null;
    for (let attempt = 0; attempt < JOURNAL_POLL_ATTEMPTS; attempt += 1) {
      journal = await this.host.journalLoad(this.projectId, taskId);
      if (journal) return journal;
      await sleep(JOURNAL_POLL_DELAY_MS);
    }
    return journal ?? null;
  }
}

/**
 * Project the LAST assistant reply text from the persisted conversation store
 * blob (ADR0023 single-copy store): the text blocks of the final assistant
 * message in current-message order. Earlier tool rounds carry no text and
 * previous replies are superseded by the latest one.
 */
function projectFinalAssistantText(journal: ProjectAgentJournalRecord): string | undefined {
  const validation = validateProjectAgentConversationStoreState(journal.conversationBlob);
  if (!validation.ok) return undefined;
  const { state } = validation;
  const byId = new Map(state.messages.map((record) => [record.messageId, record.message]));
  let lastAssistantText: string | undefined;
  for (const id of state.currentMessageIds) {
    const message = byId.get(id);
    if (!message || message.role !== 'assistant') continue;
    const blocks = message.content.filter((block) => block.type === 'text');
    if (blocks.length > 0) lastAssistantText = blocks.map((block) => block.text).join('\n');
  }
  return lastAssistantText;
}

async function writeSceneFileAtomic(sceneAbsPath: string, snapshot: unknown): Promise<void> {
  const serialized = JSON.stringify(sceneDocumentCodec.prepareForSave(snapshot as never), null, 2);
  const tmpPath = `${sceneAbsPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, serialized, 'utf-8');
  fs.renameSync(tmpPath, sceneAbsPath);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

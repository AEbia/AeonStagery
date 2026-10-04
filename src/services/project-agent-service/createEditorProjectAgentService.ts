import type { AiConversationTransport } from '../ai-authoring/AiConversationTransport';
import type {
  ProjectAgentReadPorts,
  ProjectAgentTerminalPort,
  ProjectAgentWritePorts,
} from '../project-agent/ProjectAgentPorts';
import {
  ProjectAgentCapabilityService,
  evaluateProjectAgentAdmission,
  resolveProjectAgentModelSelection,
  type ProjectAgentModelSelection,
} from '../ai-conversation/ProjectAgentCapabilities';
import type { ProjectAgentImageSessionCache } from '../project-agent/ProjectAgentImageSessionCache';
import type { ProjectAgentPerformanceCatalogResolver } from '../project-agent/ProjectAgentPerformanceCatalog';
import type { ProjectAgentMainHost } from '../../api/types/project-agent-ipc';
import type { SemanticAuthoringApplicationService } from '../timeline-authoring/SemanticAuthoringApplicationService';
import { createProjectAgentOverviewPort, type ProjectAgentOverviewSource } from './ProjectAgentOverviewPort';
import {
  ProjectAgentService,
  type ProjectAgentServiceOptions,
  type ProjectAgentTargetIdentityResolveResult,
  type ProjectAgentTargetVerificationResult,
} from './ProjectAgentService';
import { buildProjectAgentSystemPrompt } from './ProjectAgentSystemPrompt';
import type { ProjectAgentTargetIdentityRef } from './ProjectAgentTargetIdentity';

export interface ProjectAgentEditorContext {
  readonly transport: AiConversationTransport;
  readonly host: ProjectAgentMainHost;
  readonly readPorts: ProjectAgentReadPorts;
  readonly writePorts: ProjectAgentWritePorts;
  /** Shared semantic mutation queue for exact-version authoritative commits. */
  readonly authoring?: SemanticAuthoringApplicationService;
  readonly baseSystemPrompt: string;
  readonly resolveProvider: () => { endpoint: string; defaultModel: string; projectAgentModel?: string };
  readonly resolveTargetIdentity: () => ProjectAgentTargetIdentityResolveResult;
  readonly verifyTargetIdentity?: (target: ProjectAgentTargetIdentityRef) => ProjectAgentTargetVerificationResult;
  readonly capabilityService?: ProjectAgentCapabilityService;
  readonly contextWindow?: number;
  readonly idFactory?: () => string;
  /**
   * Live-memory image payload cache shared with the renderer transport
   * projection; cleared on pause/terminal (ADR0023).
   */
  readonly imageCache?: ProjectAgentImageSessionCache;
  /**
   * Bounded performance catalog resolver (ADR0023): regenerated + directly
   * injected at task start, compaction, resume and fingerprint changes.
   */
  readonly performanceCatalog?: ProjectAgentPerformanceCatalogResolver;
  /** Host terminal adapter; only full-access Conversation registries receive it. */
  readonly terminal?: ProjectAgentTerminalPort;
}

/**
 * Production editor composition (ADR0023): wires the ProjectAgentService to
 * the main host surface, the DocumentStore-backed read/write ports and the
 * ticket-02 capability admission gate. Main never holds DocumentStore state;
 * all scene access flows through the editor renderer ports.
 */
export function createEditorProjectAgentService(
  context: ProjectAgentEditorContext,
): ProjectAgentService {
  const capabilityService = context.capabilityService ?? new ProjectAgentCapabilityService();
  const admission: ProjectAgentServiceOptions['admission'] = {
    resolve: async () => {
      const provider = context.resolveProvider();
      const selection: ProjectAgentModelSelection = resolveProjectAgentModelSelection(provider);
      let capabilities = capabilityService.get(selection.endpoint, selection.model);
      if (!capabilities) {
        capabilities = await capabilityService.probeWithTransport(selection, context.transport);
      }
      const admissionResult = evaluateProjectAgentAdmission(capabilities);
      if (admissionResult.status !== 'ok') {
        return {
          ok: false,
          code: 'capability_required',
          message: admissionResult.message,
        };
      }
      return {
        ok: true,
        endpoint: selection.endpoint,
        model: selection.model,
        // readImage is registered only when imageInput is explicitly
        // supported; unsupported/unknown never surface the tool (ADR0023).
        imageInputSupported: capabilities.imageInput.state === 'supported',
        // Context budget comes from the resolved capability record — provider
        // metadata > user config > active probe > conservative default — NOT
        // from a fresh no-input re-resolution, which could only ever yield the
        // 262144 fallback (ADR0023: the probed window must reach the budget).
        ...(context.contextWindow
          ? { contextWindow: context.contextWindow }
          : { contextWindow: capabilities.contextWindow.tokens }),
      };
    },
  };

  return new ProjectAgentService({
    transport: context.transport,
    host: context.host,
    readPorts: context.readPorts,
    writePorts: context.writePorts,
    ...(context.authoring ? { authoring: context.authoring } : {}),
    systemPrompt: buildProjectAgentSystemPrompt({ baseSystemPrompt: context.baseSystemPrompt }),
    // Capability-aware prompt: the effective system prompt per start/continue
    // includes readImage guidance only when imageInput is explicitly
    // supported, keeping the vision-less tool fully hidden (ADR0023).
    buildSystemPrompt: (imageInputAvailable) => buildProjectAgentSystemPrompt({
      baseSystemPrompt: context.baseSystemPrompt,
      imageInputAvailable,
    }),
    admission,
    resolveTargetIdentity: context.resolveTargetIdentity,
    ...(context.verifyTargetIdentity ? { verifyTargetIdentity: context.verifyTargetIdentity } : {}),
    ...(context.idFactory ? { idFactory: context.idFactory } : {}),
    ...(context.imageCache ? { imageCache: context.imageCache } : {}),
    ...(context.performanceCatalog ? { performanceCatalog: context.performanceCatalog } : {}),
    ...(context.terminal ? { terminal: context.terminal } : {}),
  });
}

export type { ProjectAgentOverviewSource };
export { createProjectAgentOverviewPort };

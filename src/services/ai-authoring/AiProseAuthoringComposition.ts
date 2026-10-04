import {
  DEFAULT_AI_TARGET_BATCH_SIZE,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_EFFORT,
  DEFAULT_AI_MODEL,
  DEFAULT_MAX_CONCURRENT_AI_REQUESTS,
  DEFAULT_SCRIPT_READING_SPEED,
} from '../../api/types/ai-prose-authoring';
import type { AiProseLlmTransport } from './AiProseContracts';
import type {
  AiProseCapabilityProbe,
} from '../../api/types/ai-prose-authoring';
import {
  AiProseGlobalConfiguration,
  type AiProseGlobalConfigurationOptions,
} from './AiProseGlobalConfiguration';
import { AiProseLlmService } from './AiProseLlmService';
import {
  AiProseDraftPersistence,
  type AiProseDraftFileAccess,
  type AiProseDraftPathAccess,
  type AiProseDraftProjectInput,
} from './AiProseDraftPersistence';
import type { DraftSession } from './AiProseDraftSession';
import {
  AiProsePipeline,
  createAiProseDraftPersistenceCheckpoint,
  type AiProseDraftPersistenceCheckpoint,
  type AiProsePipelineOptions,
} from './AiProsePipeline';
import {
  AiProseSceneApplicator,
  type AiProseCompositeCommit,
} from './AiProseSceneApplicator';

export interface AiProseAuthoringCompositionOptions {
  fileAccess: AiProseDraftFileAccess;
  pathAccess?: AiProseDraftPathAccess;
  configuration?: AiProseGlobalConfiguration;
  configurationFactory?: () => AiProseGlobalConfiguration;
  transport?: AiProseLlmTransport;
  transportFactory?: () => AiProseLlmTransport;
  capabilityProbe?: AiProseCapabilityProbe;
  capabilityProbeFactory?: () => AiProseCapabilityProbe;
  draftPersistence?: AiProseDraftPersistence;
  draftPersistenceFactory?: (
    fileAccess: AiProseDraftFileAccess,
    pathAccess?: AiProseDraftPathAccess,
  ) => AiProseDraftPersistence;
  pipelineOptions?: Partial<AiProsePipelineOptions>;
  commitApplied: AiProseCompositeCommit;
}

export interface AiProseAuthoringComposition {
  configuration: AiProseGlobalConfiguration;
  llm: AiProseLlmService;
  transport: AiProseLlmTransport;
  capabilityProbe: AiProseCapabilityProbe;
  pipeline: AiProsePipeline;
  draftPersistence: AiProseDraftPersistence;
  applicator: AiProseSceneApplicator;
  createDraftCheckpoint(
    project: AiProseDraftProjectInput,
    draft: DraftSession,
  ): AiProseDraftPersistenceCheckpoint;
}

export function createAiProseAuthoringComposition(
  options: AiProseAuthoringCompositionOptions,
): AiProseAuthoringComposition {
  const configuration = options.configuration
    ?? options.configurationFactory?.()
    ?? createDefaultAiProseConfiguration();
  const transport = options.transport
    ?? options.transportFactory?.()
    ?? createUnavailableAiProseLlmTransport();
  const capabilityProbe = options.capabilityProbe
    ?? options.capabilityProbeFactory?.()
    ?? (isAiProseCapabilityProbe(transport)
      ? transport
      : createUnavailableAiProseCapabilityProbe());
  const draftPersistence = options.draftPersistence
    ?? options.draftPersistenceFactory?.(options.fileAccess, options.pathAccess)
    ?? new AiProseDraftPersistence(options.fileAccess, options.pathAccess);
  const llm = new AiProseLlmService(configuration, transport);
  const pipeline = new AiProsePipeline(llm, {
    scriptReadingSpeed: DEFAULT_SCRIPT_READING_SPEED,
    ...options.pipelineOptions,
  });
  const applicator = new AiProseSceneApplicator({
    commitApplied: options.commitApplied,
  });

  return {
    configuration,
    llm,
    transport,
    capabilityProbe,
    pipeline,
    draftPersistence,
    applicator,
    createDraftCheckpoint: (project, draft) => createAiProseDraftPersistenceCheckpoint({
      persistence: draftPersistence,
      project,
      draft,
    }),
  };
}

export function createUnavailableAiProseLlmTransport(): AiProseLlmTransport {
  return {
    complete: async () => {
      throw new Error('AI prose provider transport is not configured');
    },
  };
}

export function createUnavailableAiProseCapabilityProbe(): AiProseCapabilityProbe {
  return {
    probe: async () => {
      throw new Error('AI prose capability probe is not configured');
    },
  };
}

function isAiProseCapabilityProbe(value: unknown): value is AiProseCapabilityProbe {
  return !!value && typeof (value as AiProseCapabilityProbe).probe === 'function';
}

function createDefaultAiProseConfiguration(): AiProseGlobalConfiguration {
  const options: AiProseGlobalConfigurationOptions = {
    provider: {
      endpoint: DEFAULT_AI_BASE_URL,
      defaultModel: DEFAULT_AI_MODEL,
    },
    request: {
      targetBatchSize: DEFAULT_AI_TARGET_BATCH_SIZE,
      maxConcurrentAiRequests: DEFAULT_MAX_CONCURRENT_AI_REQUESTS,
      effort: DEFAULT_AI_EFFORT,
    },
  };
  return new AiProseGlobalConfiguration(options);
}

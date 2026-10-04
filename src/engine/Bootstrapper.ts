import { DocumentStore } from '../ui/store/DocumentStore';
import { PlaybackStore } from '../ui/store/PlaybackStore';
import { EditorStore } from '../ui/store/EditorStore';
import { PlaybackAdapter } from '../api/adapters/PlaybackAdapter';
import { CameraAdapter } from '../api/adapters/CameraAdapter';
import { CharacterAdapter } from '../api/adapters/CharacterAdapter';
import { StageAdapter } from '../api/adapters/StageAdapter';
import { TimelineAdapter } from '../api/adapters/TimelineAdapter';
import { ExportAdapter } from '../api/adapters/ExportAdapter';
import { AutoSaveDaemon } from './daemons/AutoSaveDaemon';
import { SceneFileService } from '../services/io/SceneFileService';
import { SceneAssetService } from '../services/io/SceneAssetService';
import { TemplateResourceFileService } from '../services/template-package/TemplateResourceFileService';
import { ProjectWorkspaceService } from '../services/io/ProjectWorkspaceService';
import { ProjectSession } from '../services/io/ProjectSession';
import type { IFileAccess } from '../services/io/IFileAccess';
import type ScriptEngine from './ScriptEngine';
import { scriptEngine as defaultScriptEngine } from './ScriptEngine';
import { ValidationStore } from '../ui/store/ValidationStore';
import { ValidationDaemon } from './daemons/ValidationDaemon';
import { WmdlConfigRegistry } from './WmdlConfigRegistry';
import { live2DManager } from './Live2DManager';
import { lightingSystem as defaultLightingSystem } from './LightingSystem';
import { preBakeDaemon } from './daemons/PreBakeDaemon';
import { ProjectResourceService } from '../services/io/ProjectResourceService';
import { ResourceAuthoringService } from '../services/resource-authoring';
import { ProjectPathResolver } from '../services/io/ProjectPathResolver';
import type { DocumentFilePathPort, EditorSaveStatusPort } from '../services/document/DocumentProjectionPorts';
import { LibraryRoots } from '../services/io/LibraryRoots';
import { LibraryCatalog } from '../services/io/LibraryCatalog';
import {
  PlaybackStoreDurationSink,
  ScriptEngineSemanticRuntimeAdapter,
} from './ScriptEngineSemanticRuntimeAdapter';
import { hookSystem } from '../api/hooks';
import { eventBus } from '../api/events';
import {
  normalizeScriptReadingSpeed,
  settingsManager,
  settingsProjectRecentsPort,
  settingsProjectWorkflowSettingsPort,
} from '../ui/SettingsStore';
import type { AppSettings } from '../ui/SettingsStore';
import { ProjectOpenWorkflow } from '../services/project/ProjectOpenWorkflow';
import {
  createProjectDependencyServices,
  type ProjectDependencyComposition,
} from '../services/project-dependencies/ProjectDependencyComposition';
import { createFileAccessForCapability, getWindowElectronCapability } from '../services/platform/ElectronCapability';
import {
  BUILTIN_TEMPLATE_PACKAGES,
  TemplatePackageCatalog,
  TemplatePackageDiscovery,
  TemplatePerformanceProfileAuthoringService,
} from '../services/template-package';
import {
  createLazyPerformanceProfileProvider,
  createPerformanceProfileProviderFromTemplatePackages,
} from '../services/template-package/TemplatePerformanceProfileProvider';
import {
  SceneMigrationConfirmationPresenterHost,
  SceneMigrationExperience,
  SemanticRawScriptService,
  SemanticScenePipeline,
} from '../services/semantic-scene';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { SemanticVisualCompositionAuthoringService } from '../services/visual-authoring/SemanticVisualCompositionAuthoringService';
import { ElectronVoiceAuthoringAdapter, VoiceAuthoringService, type VoiceAuthoringElectronPort } from '../services/voice/VoiceAuthoringService';
import {
  createAiProseAuthoringComposition,
  createUnavailableAiProseLlmTransport,
  type AiProseAuthoringComposition,
  type AiProseAuthoringCompositionOptions,
} from '../services/ai-authoring/AiProseAuthoringComposition';
import {
  AiProseGlobalConfiguration,
  getAiProseProviderIdentity,
} from '../services/ai-authoring/AiProseGlobalConfiguration';
import { createAiProseElectronTransport } from '../services/ai-authoring/AiProseElectronTransport';
import type { AiProseElectronProviderController } from '../services/ai-authoring/AiProseElectronTransport';
import {
  DEFAULT_AI_TARGET_BATCH_SIZE,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_EFFORT,
  DEFAULT_AI_MODEL,
  DEFAULT_MAX_CONCURRENT_AI_REQUESTS,
  AI_PROSE_EFFORTS,
  type AiProseProviderConfig,
} from '../api/types/ai-prose-authoring';
import { AiProseDraftPersistence } from '../services/ai-authoring/AiProseDraftPersistence';
import type { AiProseCompositeCommit } from '../services/ai-authoring/AiProseSceneApplicator';
import { createAiConversationElectronTransport } from '../services/ai-conversation/AiConversationElectronTransport';
import {
  ProjectAgentCapabilityService,
  resolveProjectAgentModelSelection,
} from '../services/ai-conversation/ProjectAgentCapabilities';
import { createEditorProjectAgentService } from '../services/project-agent-service/createEditorProjectAgentService';
import { createProjectAgentPerformanceCatalogResolver } from '../services/project-agent-service/ProjectAgentPerformanceCatalogResolver';
import { runProjectAgentSceneValidation } from '../services/project-agent-service/ProjectAgentSceneValidation';
import { createProjectAgentAuthoringGate } from '../services/project-agent-service/ProjectAgentAuthoringGate';
import type { ProjectAgentService, ProjectAgentTargetVerificationResult } from '../services/project-agent-service/ProjectAgentService';
import type { ProjectAgentTargetIdentityRef } from '../services/project-agent-service/ProjectAgentTargetIdentity';
import type { ProjectAgentOverviewSource } from '../services/project-agent-service/ProjectAgentOverviewPort';
import { createProjectAgentOverviewPort } from '../services/project-agent-service/ProjectAgentOverviewPort';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import type { ProjectAgentSceneSnapshot } from '../services/project-agent/ProjectAgentPorts';
import { createProjectAgentProjectReadPorts } from '../services/project-agent/ProjectAgentProjectReadPorts';
import { createProjectAgentResourcePorts } from '../services/project-agent/ProjectAgentResourcePorts';
import { createProjectAgentImageReadPort } from '../services/project-agent/ProjectAgentImageReadPort';
import { ProjectAgentImageSessionCache } from '../services/project-agent/ProjectAgentImageSessionCache';
import { ProjectAgentIFileAccessFs } from '../services/project-agent/ProjectAgentProjectFs';
import type { ProjectState } from '../api/types/project';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';

export type BootstrapAiProseOptions = Omit<
  AiProseAuthoringCompositionOptions,
  'fileAccess' | 'commitApplied'
> & {
  commitApplied?: AiProseCompositeCommit;
};

const FALLBACK_AI_PROSE_SETTINGS: AppSettings['aiProse'] = {
  baseUrl: '',
  defaultModel: '',
  jsonOutputSupported: false,
  targetBatchSize: DEFAULT_AI_TARGET_BATCH_SIZE,
  maxConcurrentAiRequests: DEFAULT_MAX_CONCURRENT_AI_REQUESTS,
  effort: DEFAULT_AI_EFFORT,
};

export function createAiProseConfigurationFromSettings(
  settings: AppSettings['aiProse'],
): AiProseGlobalConfiguration {
  let endpoint = settings.baseUrl.trim() || DEFAULT_AI_BASE_URL;
  if (!/^https?:\/\//i.test(endpoint)) {
    endpoint = `https://${endpoint}`;
  }
  const defaultModel = settings.defaultModel.trim() || DEFAULT_AI_MODEL;
  const providerIdentity = getAiProseProviderIdentity(settings);
  return new AiProseGlobalConfiguration({
    provider: {
      endpoint,
      defaultModel,
      ...(settings.projectAgentModel ? { projectAgentModel: settings.projectAgentModel } : {}),
      ...(settings.modelOverrides ? { modelOverrides: { ...settings.modelOverrides } } : {}),
      jsonOutputSupported: settings.jsonOutputSupported
        && settings.capabilityIdentity === providerIdentity,
    },
    request: {
      targetBatchSize: settings.targetBatchSize,
      maxConcurrentAiRequests: settings.maxConcurrentAiRequests,
      ...(settings.effort ? { effort: settings.effort } : {}),
    },
  });
}

function getPersistedAiProseSettings(): AppSettings['aiProse'] {
  const value = settingsManager.get('aiProse') as unknown;
  if (!isRecord(value)
    || typeof value.baseUrl !== 'string'
    || typeof value.defaultModel !== 'string'
    || typeof value.jsonOutputSupported !== 'boolean'
    || typeof value.targetBatchSize !== 'number'
    || !Number.isSafeInteger(value.targetBatchSize)
    || value.targetBatchSize <= 0
    || typeof value.maxConcurrentAiRequests !== 'number'
    || !Number.isSafeInteger(value.maxConcurrentAiRequests)
    || value.maxConcurrentAiRequests <= 0
    || (value.modelOverrides !== undefined && !isRecord(value.modelOverrides))
    || (value.effort !== undefined && !AI_PROSE_EFFORTS.includes(value.effort as typeof AI_PROSE_EFFORTS[number]))) {
    return { ...FALLBACK_AI_PROSE_SETTINGS };
  }
  return value as AppSettings['aiProse'];
}

function getPersistedScriptReadingSpeed(): number {
  return normalizeScriptReadingSpeed(settingsManager.get('scriptReadingSpeed'));
}

function syncAiProseProviderTransport(
  transport: unknown,
  provider: AiProseProviderConfig,
): void {
  const candidate = transport as Partial<AiProseElectronProviderController> | undefined;
  if (typeof candidate?.configureProvider !== 'function') return;
  void candidate.configureProvider(provider).catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * ADR0023 target-identity verification seam (editor side). The target entry
 * still registered in project metadata is the source of truth for what the
 * task may run on:
 * - target entry deleted → confirmed deletion, terminal block;
 * - active entry id differs → user switched scenes, recoverable pause;
 * - same entry but a different loaded document sceneId → same-name/same-path
 *   replacement, terminal block (the new scene must not inherit the task).
 */
export function verifyProjectAgentTargetIdentity(args: {
  readonly project: ProjectState | null;
  readonly activeSceneEntry: { readonly id: string; readonly name: string; readonly path: string } | null;
  readonly document: CurrentSceneDocument | null;
  readonly target: ProjectAgentTargetIdentityRef;
}): ProjectAgentTargetVerificationResult {
  const { project, activeSceneEntry, document, target } = args;
  if (!project) {
    return { ok: false, kind: 'recoverable', code: 'no_active_project', message: 'No active project is open' };
  }
  const entry = project.metadata.scenes.find((scene) => scene.id === target.sceneEntryId);
  if (!entry) {
    return {
      ok: false,
      kind: 'terminal',
      code: 'target_scene_deleted',
      message: 'The target scene is no longer registered in the project metadata (deleted or removed)',
    };
  }
  if (!document) {
    return {
      ok: false,
      kind: 'recoverable',
      code: 'no_active_scene',
      message: 'No scene document is currently loaded',
    };
  }
  if (!activeSceneEntry || activeSceneEntry.id !== target.sceneEntryId) {
    return {
      ok: false,
      kind: 'recoverable',
      code: 'active_scene_mismatch',
      message: 'The active scene has switched away from the task target; reactivate the target scene to continue the task',
    };
  }
  if (document.sceneId !== target.sceneDocumentId) {
    return {
      ok: false,
      kind: 'terminal',
      code: 'target_scene_replaced',
      message: 'The target scene was replaced by a new scene document at the same scene; the task cannot continue on it',
    };
  }
  return { ok: true };
}

export interface BootstrapContext {
  adapters: {
    playback: PlaybackAdapter;
    camera: CameraAdapter;
    character: CharacterAdapter;
    stage: StageAdapter;
    timeline: TimelineAdapter;
    export: ExportAdapter;
  };
  stores: {
    document: DocumentStore;
    playback: PlaybackStore;
    editor: EditorStore;
    validation: ValidationStore;
  };
  services: {
    fileAccess: IFileAccess;
    sceneFile: SceneFileService;
    sceneMigration: SceneMigrationExperience;
    sceneMigrationPresenter: SceneMigrationConfirmationPresenterHost;
    projectOpenWorkflow: ProjectOpenWorkflow;
    sceneAssets: SceneAssetService;
    projectWorkspace: ProjectWorkspaceService;
    projectResources: ProjectResourceService;
    resourceAuthoring: ResourceAuthoringService;
    templateResourceFiles: TemplateResourceFileService;
    projectDependencies: ProjectDependencyComposition;
    libraryRoots: LibraryRoots;
    libraryCatalog: LibraryCatalog;
    voiceAuthoring: VoiceAuthoringService;
    templatePackages: TemplatePackageCatalog;
    templatePerformanceProfiles: TemplatePerformanceProfileAuthoringService;
    semanticDocument: SemanticDocumentCoordinator;
    semanticAuthoring: SemanticAuthoringApplicationService;
    semanticRawScript: SemanticRawScriptService;
    semanticVisualComposition: SemanticVisualCompositionAuthoringService;
    aiProse: AiProseAuthoringComposition;
    projectAgent?: ProjectAgentService;
  };
  dispose: () => void;
}

export function bootstrap(options?: {
  stores?: { document?: DocumentStore; playback?: PlaybackStore; editor?: EditorStore };
  getScriptEngine?: () => ScriptEngine;
  getLightingSystem?: () => any;
  getLive2DManager?: () => any;
  aiProse?: BootstrapAiProseOptions;
}): BootstrapContext {
  const getScriptEngine = options?.getScriptEngine ?? (() => defaultScriptEngine);
  const getLightingSystem = options?.getLightingSystem ?? (() => defaultLightingSystem);
  const getLive2DManager = options?.getLive2DManager ?? (() => live2DManager);

  // 1. Stores — reuse existing or create new
  const documentStore = options?.stores?.document ?? new DocumentStore();
  const playbackStore = options?.stores?.playback ?? new PlaybackStore();
  const editorStore = options?.stores?.editor ?? new EditorStore();
  const validationStore = new ValidationStore();
  const projectSession = new ProjectSession();

  let sceneFileService: SceneFileService;
  const templatePackageCatalog = new TemplatePackageCatalog([...BUILTIN_TEMPLATE_PACKAGES]);

  const projectionRuntime = new ScriptEngineSemanticRuntimeAdapter(getScriptEngine);
  const durationSink = new PlaybackStoreDurationSink((duration) => playbackStore._setDuration(duration));

  const editorSaveStatusPort: EditorSaveStatusPort = {
    setSaveStatus: (status) => editorStore._setSaveStatus(status),
  };

  const electronCapability = getWindowElectronCapability();
  const fileAccess = createFileAccessForCapability(electronCapability);
  const templatePerformanceProfiles = new TemplatePerformanceProfileAuthoringService(
    fileAccess,
    templatePackageCatalog,
    {
      getAuthoringRoot: electronCapability
        ? () => electronCapability.app.getUserDataPath()
        : undefined,
    },
  );
  const projectResources = new ProjectResourceService(
    fileAccess,
    new ProjectPathResolver(electronCapability),
    () => settingsManager.get('externalLibraryMounts') || [],
    () => projectSession.getCurrentProject(),
    () => settingsManager.get('projectExternalLibraryBindings') || {},
  );
  const resourceAuthoring = new ResourceAuthoringService(
    fileAccess,
    projectResources,
    templatePackageCatalog,
  );
  
  // Synchronously instantiate a clean WmdlConfigRegistry instance per session
  const wmdlConfigRegistry = new WmdlConfigRegistry();

  const sceneAssets = new SceneAssetService(
    fileAccess,
    wmdlConfigRegistry,
    projectResources,
    () => getScriptEngine()?.getBasePath() ?? '',
    () => resourceAuthoring.invalidate(),
  );

  const semanticPipeline = new SemanticScenePipeline({
    resolveAsset: (source, assetContext) => sceneAssets.resolveSemanticRuntimeAsset(source, assetContext),
    prepareSource: (source) => sceneAssets.normalizeSemanticSource(source),
  });
  const semanticDocumentCoordinator = new SemanticDocumentCoordinator(
    documentStore,
    semanticPipeline,
    projectionRuntime,
    durationSink,
    async (bundle) => sceneAssets.hydratePreparedRuntimeConfigs(bundle.prepared),
  );
  const semanticAuthoring = new SemanticAuthoringApplicationService(
    documentStore,
    semanticDocumentCoordinator,
    undefined,
    resourceAuthoring,
    { getDialogueFlowMode: () => settingsManager.get('workbenchDialogueFlowMode') },
    { getDialogueDefaults: () => projectSession.getCurrentProject()?.metadata.templates },
  );
  const disposeSemanticHistory = semanticAuthoring.subscribeHistory(() => {
    editorStore._setUndoState(semanticAuthoring.canUndo, semanticAuthoring.canRedo);
  });
  const semanticRawScript = new SemanticRawScriptService(
    semanticDocumentCoordinator,
    semanticAuthoring,
  );
  const semanticVisualComposition = new SemanticVisualCompositionAuthoringService(semanticAuthoring);

  const persistedAiProseSettings = getPersistedAiProseSettings();
  const usesPersistedAiProseConfiguration = !options?.aiProse?.configuration
    && !options?.aiProse?.configurationFactory;
  const aiProseConfiguration = usesPersistedAiProseConfiguration
    ? createAiProseConfigurationFromSettings(persistedAiProseSettings)
    : undefined;
  const aiProseTransport = options?.aiProse?.transport
    ?? options?.aiProse?.transportFactory?.()
    ?? (electronCapability
      ? createAiProseElectronTransport(electronCapability)
      : createUnavailableAiProseLlmTransport());
  const aiProsePipelineOptions = {
    scriptReadingSpeed: getPersistedScriptReadingSpeed(),
    ...options?.aiProse?.pipelineOptions,
  };

  let aiProseDraftPersistence: AiProseDraftPersistence | undefined;
  const defaultAiProseCommit: AiProseCompositeCommit = async ({
    document,
    appliedDraft,
  }) => {
    const project = projectSession.getCurrentProject();
    if (!project) throw new Error('AI prose apply requires an active project');
    if (!aiProseDraftPersistence) throw new Error('AI prose draft persistence is not configured');

    await semanticAuthoring.replaceDocumentWithSideEffect(
      document,
      async () => {
        await aiProseDraftPersistence!.archiveApplied(project, appliedDraft);
      },
    );
  };
  const aiProse = createAiProseAuthoringComposition({
    ...options?.aiProse,
    ...(aiProseConfiguration ? { configuration: aiProseConfiguration } : {}),
    transport: aiProseTransport,
    pipelineOptions: aiProsePipelineOptions,
    fileAccess,
    commitApplied: options?.aiProse?.commitApplied ?? defaultAiProseCommit,
  });
  aiProseDraftPersistence = aiProse.draftPersistence;
  syncAiProseProviderTransport(aiProse.transport, aiProse.configuration.provider);
  const disposeAiProseProviderSettings = usesPersistedAiProseConfiguration
    ? settingsManager.subscribeKey('aiProse', () => {
      const next = getPersistedAiProseSettings();
      try {
        let endpoint = next.baseUrl.trim() || DEFAULT_AI_BASE_URL;
        if (!/^https?:\/\//i.test(endpoint)) {
          endpoint = `https://${endpoint}`;
        }
        const defaultModel = next.defaultModel.trim() || DEFAULT_AI_MODEL;
        const provider = {
          endpoint,
          defaultModel,
          ...(next.projectAgentModel ? { projectAgentModel: next.projectAgentModel } : {}),
          ...(next.modelOverrides ? { modelOverrides: { ...next.modelOverrides } } : {}),
          jsonOutputSupported: next.jsonOutputSupported
            && next.capabilityIdentity === getAiProseProviderIdentity(next),
        } satisfies AiProseProviderConfig;
        aiProse.configuration.updateProviderConfig(provider);
        syncAiProseProviderTransport(aiProse.transport, provider);
        aiProse.configuration.updateRequestSettings({
          targetBatchSize: next.targetBatchSize,
          maxConcurrentAiRequests: next.maxConcurrentAiRequests,
          ...(next.effort ? { effort: next.effort } : {}),
        });
      } catch {
        // Keep the last valid live configuration while the user edits an endpoint.
      }
    })
    : () => undefined;
  const disposeAiProseReadingSpeed = usesPersistedAiProseConfiguration
    ? settingsManager.subscribeKey('scriptReadingSpeed', () => {
      aiProse.pipeline.updateOptions({ scriptReadingSpeed: getPersistedScriptReadingSpeed() });
    })
    : () => undefined;

  const documentFilePath: DocumentFilePathPort = {
    setFilePath: (path) => documentStore._setFilePath(path),
  };

  // ─── Project Agent (ADR0023) — editor composition ───────
  const characterAdapter = new CharacterAdapter();
  const resolveActiveSceneEntry = () => {
    const project = projectSession.getCurrentProject();
    if (!project) return null;
    const filePath = documentStore.filePath;
    if (filePath) {
      const normalizedRoot = project.rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
      const relative = filePath.replace(/\\/g, '/').replace(`${normalizedRoot}/`, '');
      const byPath = project.metadata.scenes.find((scene) => scene.path === relative);
      if (byPath) return byPath;
    }
    return project.metadata.scenes.find((scene) => scene.id === project.metadata.defaultSceneId)
      ?? project.metadata.scenes[0]
      ?? null;
  };

  const boundedProjectReads = createProjectAgentProjectReadPorts({
    fs: new ProjectAgentIFileAccessFs(
      assertFileAccessSupportsBoundedReads(fileAccess),
    ),
    getProjectRoot: () => projectSession.getCurrentProject()?.rootPath ?? null,
    getExternalMounts: () => settingsManager.get('externalLibraryMounts') ?? [],
  });
  const projectAgentResourcePorts = createProjectAgentResourcePorts({
    fs: new ProjectAgentIFileAccessFs(
      assertFileAccessSupportsBoundedReads(fileAccess),
    ),
    getProject: () => projectSession.getCurrentProject(),
    getExternalMounts: () => settingsManager.get('externalLibraryMounts') ?? [],
    getTemplatePackages: () => templatePackageCatalog.getPackages(),
  });
  // Live-memory image session cache shared by the readImage tool and the
  // renderer transport projection (ADR0023): bytes never enter the journal.
  const projectAgentImageCache = new ProjectAgentImageSessionCache();
  // Shared endpoint+model capability facts for the project Agent: admission
  // probes populate the cache; the context publisher reads the imageInput
  // fact from it for window presentation gating.
  const projectAgentCapabilityService = new ProjectAgentCapabilityService();
  const projectAgentImagePort = createProjectAgentImageReadPort({
    fs: new ProjectAgentIFileAccessFs(
      assertFileAccessSupportsBoundedReads(fileAccess),
    ),
    getProject: () => projectSession.getCurrentProject(),
    getExternalMounts: () => settingsManager.get('externalLibraryMounts') ?? [],
  });
  const projectAgentReadPorts: ProjectAgentReadPorts = {
    overview: createProjectAgentOverviewPort({
      getSource: (): ProjectAgentOverviewSource => {
        const project = projectSession.getCurrentProject();
        const activeEntry = resolveActiveSceneEntry();
        return {
          name: project?.metadata.name ?? '',
          projectVersion: project?.metadata.projectVersion ?? 0,
          ...(project && activeEntry
            ? { activeScene: { name: activeEntry.name, path: activeEntry.path } }
            : {}),
          scenes: project?.metadata.scenes ?? [],
          ...(project?.metadata
            ? { assetRoots: Object.fromEntries(Object.entries(project.metadata.assetRoots)) }
            : {}),
          ...(project?.metadata.templates
            ? {
              templates: {
                enabledTemplateIds: project.metadata.templates.enabledTemplateIds,
                ...(project.metadata.templates.defaults
                  ? { defaults: Object.fromEntries(Object.entries(project.metadata.templates.defaults)) }
                  : {}),
              },
            }
            : {}),        };
      },
    }),
    files: boundedProjectReads.files,
    text: boundedProjectReads.text,
    textSearch: boundedProjectReads.textSearch,
    resources: projectAgentResourcePorts.resources,
    resourceInspect: projectAgentResourcePorts.resourceInspect,
    image: projectAgentImagePort,
    scene: {
      getSnapshot: (): ProjectAgentSceneSnapshot | null => {
        const document = documentStore.getCurrentSceneDocumentSnapshot();
        if (!document) return null;
        return { document, version: documentStore.version };
      },
    },
    validation: {
      validate: (document) => runProjectAgentSceneValidation(document),
    },
  };
  const projectAgentWritePorts: ProjectAgentWritePorts = {
    scene: projectAgentReadPorts.scene,
    validation: {
      // Strict authoring gate (ADR0023): source schema + complete semantic
      // validation + compiler + per-transaction strict resource checks. Never
      // the RuntimeAssetPreparer loose degradation path.
      validate: createProjectAgentAuthoringGate({
        validateStructure: runProjectAgentSceneValidation,
        inspectResource: projectAgentResourcePorts.resourceInspect.inspectResource,
      }),
    },
    authoring: {
      commit: async (request) => {
        await semanticAuthoring.replaceDocumentWithSideEffect(request.candidate, async () => undefined);
        return { version: documentStore.version };
      },
    },
  };

  const projectAgent = electronCapability && electronCapability.projectAgent
    ? createEditorProjectAgentService({
      transport: createAiConversationElectronTransport(electronCapability, {
        imagePayloadResolver: projectAgentImageCache,
      }),
      host: electronCapability.projectAgent,
      terminal: {
        async runTerminalCommand(options, signal) {
          const task = projectAgent?.getTaskSnapshot();
          const project = projectSession.getCurrentProject();
          const requestId = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          if (!task || !project || !electronCapability.projectAgent?.runTerminalCommand) {
            throw new Error('Terminal execution is unavailable');
          }
          const cancel = () => { void electronCapability.projectAgent?.cancelTerminalCommand?.(requestId); };
          if (signal?.aborted) cancel();
          signal?.addEventListener('abort', cancel, { once: true });
          try {
            const response = await electronCapability.projectAgent.runTerminalCommand({
              projectId: project.metadata.projectId,
              taskId: task.identity.taskId,
              requestId,
              ...options,
            });
            if (!response.ok || !response.result) {
              throw new Error(response.error ?? 'Terminal command could not be started');
            }
            return response.result;
          } finally {
            signal?.removeEventListener('abort', cancel);
          }
        },
      },
      readPorts: projectAgentReadPorts,
      writePorts: projectAgentWritePorts,
      imageCache: projectAgentImageCache,
      capabilityService: projectAgentCapabilityService,
      // Bounded performance catalog for ALL target-scene characters (ADR0023):
      // profile provider + character/model binding + ACTUAL Live2D motions/
      // expressions intersection, refreshed at start/compaction/resume/fingerprint.
      performanceCatalog: createProjectAgentPerformanceCatalogResolver({
        getSceneSnapshot: () => documentStore.getCurrentSceneDocumentSnapshot(),
        loadModelCapabilities: async (characters) => {
          const entries = await Promise.all(characters.map(async (character) => {
            const paths = [character.model, ...(character.variantModels ?? [])]
              .filter((model): model is string => typeof model === 'string' && model.trim() !== '');
            const motions = new Set<string>();
            const expressions = new Set<string>();
            const primaryMotions = new Set<string>();
            const primaryExpressions = new Set<string>();
            for (let index = 0; index < paths.length; index += 1) {
              const isPrimary = index === 0;
              try {
                const data = await characterAdapter.getModelDataFromPath(paths[index]);
                for (const motion of data.motions) {
                  motions.add(motion);
                  if (isPrimary) primaryMotions.add(motion);
                }
                for (const expression of data.expressions) {
                  expressions.add(expression);
                  if (isPrimary) primaryExpressions.add(expression);
                }
              } catch {
                // A missing/unreadable sub-model must not block the whole character.
              }
            }
            return [character.id, {
              motions: [...motions],
              expressions: [...expressions],
              primaryMotions: [...primaryMotions],
              primaryExpressions: [...primaryExpressions],
            }] as const;
          }));
          return Object.fromEntries(entries);
        },
        // The agent's bounded performance catalog resolves the profile
        // provider lazily so template enablement follows the CURRENT project's
        // configuration even when the provider outlives a project switch.
        profileProvider: createLazyPerformanceProfileProvider(() =>
          createPerformanceProfileProviderFromTemplatePackages(
            templatePackageCatalog.getPackages(),
            projectSession.getCurrentProject()?.metadata.templates?.enabledTemplateIds,
          )),
      }),
      // The agent's authoritative commits flow through the SAME mutation
      // queue as human authoring with an exact DocumentStore version check.
      authoring: semanticAuthoring,
      baseSystemPrompt: 'You are the autonomous project Agent of this AeonStagery project. Complete the user task with controlled tools when needed, then finish with a normal assistant reply.',
      resolveProvider: () => {
        const provider = aiProse.configuration.provider;
        return {
          endpoint: provider.endpoint,
          defaultModel: provider.defaultModel,
          ...(provider.projectAgentModel ? { projectAgentModel: provider.projectAgentModel } : {}),
        };
      },
      resolveTargetIdentity: () => {
        const project = projectSession.getCurrentProject();
        if (!project) {
          return { ok: false, code: 'no_active_project', message: 'No active project' };
        }
        const activeEntry = resolveActiveSceneEntry();
        const document = documentStore.getCurrentSceneDocumentSnapshot();
        if (!activeEntry || !document) {
          return { ok: false, code: 'no_active_scene', message: 'No active scene is loaded' };
        }
        return {
          ok: true,
          projectId: project.metadata.projectId,
          sceneEntryId: activeEntry.id,
          sceneDocumentId: document.sceneId,
          sceneName: activeEntry.name,
        };
      },
      // Verify the task target against the current active scene (ADR0023):
      // target entry removed from metadata → confirmed deletion, blocks as
      // target_scene_unavailable; active entry id differs → user scene switch,
      // recoverable pause (reactivation required); same entry but loaded
      // document with a different sceneId → same-name/same-path replacement,
      // blocks as target_scene_unavailable. Missing project/document keep the
      // task paused.
      verifyTargetIdentity: (target) => verifyProjectAgentTargetIdentity({
        project: projectSession.getCurrentProject(),
        activeSceneEntry: resolveActiveSceneEntry(),
        document: documentStore.getCurrentSceneDocumentSnapshot(),
        target,
      }),
    })
    : undefined;

  // Agent-window supplements are the same task's input (ADR0023): relay them
  // verbatim into the editor-owned service; the window never creates a task.
  const disposeProjectAgentSupplementRelay = electronCapability?.projectAgent?.onSupplement((payload) => {
    void projectAgent?.sendSupplement(payload.text).catch(() => undefined);
  }) ?? (() => undefined);

  // Agent-window task start (ADR0023): the window never holds project/scene
  // state, so it requests a start with task text (and an optional user image)
  // only; the editor renderer resolves the active target, checks admission
  // and begins the task.
  const disposeProjectAgentStartRelay = electronCapability?.projectAgent?.onStartRequest((payload) => {
    void (async () => {
      const result = await projectAgent?.start({
        taskText: payload.taskText,
        accessMode: payload.accessMode,
        ...(payload.image ? { image: payload.image } : {}),
      }).catch((error: unknown) => ({
        ok: false as const,
        code: 'invalid_arguments' as const,
        message: error instanceof Error ? error.message : String(error),
      }));
      if (!payload.requestId) return;
      if (!result) {
        await electronCapability?.projectAgent?.publishStartResult({
          requestId: payload.requestId,
          ok: false,
          error: '项目 Agent 服务不可用。',
        }).catch(() => undefined);
        return;
      }
      await electronCapability?.projectAgent?.publishStartResult({
        requestId: payload.requestId,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.message }),
      }).catch(() => undefined);
    })();
  }) ?? (() => undefined);

  // Agent-window model switch (window → main → editor): the editor updates the
  // shared settings store; Bootstrapper's existing aiProse settings
  // subscription applies the change to the live provider config.
  const disposeProjectAgentSetModelRelay = electronCapability?.projectAgent?.onSetModel((model) => {
    const current = settingsManager.get('aiProse');
    settingsManager.set('aiProse', { ...current, projectAgentModel: model });
  }) ?? (() => undefined);

  // Agent-window effort switch (window → main → editor): same relay chain as
  // the model switch; the aiProse settings subscription hot-updates the live
  // request settings.
  const disposeProjectAgentSetEffortRelay = electronCapability?.projectAgent?.onSetEffort((effort) => {
    const current = settingsManager.get('aiProse');
    settingsManager.set('aiProse', { ...current, effort: effort as AppSettings['aiProse']['effort'] });
  }) ?? (() => undefined);

  // Agent-window commands (pause/cancel/continue/discard/open-settings) and
  // the window-close pause are relayed by main; the editor renderer owns the
  // lifecycle and the DocumentStore, so all commands settle here at the
  // editor's safe points.
  const disposeProjectAgentCommandRelay = electronCapability?.projectAgent?.onCommand((command) => {
    if (command.type === 'pause') {
      void projectAgent?.pause(command.pauseReason ?? 'user_requested').catch(() => undefined);
    } else if (command.type === 'cancel') {
      void projectAgent?.cancel().catch(() => undefined);
    } else if (command.type === 'continue') {
      void projectAgent?.continueTask().catch(() => undefined);
    } else if (command.type === 'discard') {
      projectAgent?.discardTask();
    } else if (command.type === 'switch-conversation') {
      // Agent-window conversation switch (ADR0023): the window never holds
      // project state, so the editor resolves the current project and
      // re-hydrates its single coordinator slot from the target record.
      const currentProject = projectSession.getCurrentProject();
      const taskId = command.taskId;
      if (currentProject && taskId) {
        void projectAgent?.switchConversation(currentProject.metadata.projectId, taskId)
          .catch(() => undefined);
      }
    } else if (command.type === 'open-settings') {
      eventBus.emit('ui:openSettings', {});
    }
  }) ?? (() => undefined);

  // Reopen recovery (ADR0023): restore unfinished tasks and unseen terminal
  // reports from the main-process local journal for the CURRENT project.
  // State is restored only — no model call, no tool execution, no lease; an
  // explicit user continue reactivates and verifies the target before the
  // global lease is re-acquired.
  const disposeProjectAgentRestore = (() => {
    const host = electronCapability?.projectAgent;
    const currentProjectId = projectSession.getCurrentProject()?.metadata.projectId;
    if (!host || !projectAgent || !currentProjectId) return () => undefined;
    void (async () => {
      try {
        await host.publishRestoredProject(currentProjectId);
        const records = await host.journalListByProject(currentProjectId);
        for (const record of records) {
          await projectAgent.restoreTask(record);
        }
      } catch (error) {
        console.warn('[ProjectAgent] Reopen restore failed:', error);
      }
    })();
    return () => undefined;
  })();

  // Editor → Agent window presentation context (ADR0023): project name, scene
  // name and project root are presentation facts; UUID identity and sensitive
  // local paths never cross this surface. Republished on project or scene
  // changes so the window's greeting/placeholder/context label stay in sync.
  const disposeProjectAgentContextPublisher = (() => {
    const host = electronCapability?.projectAgent;
    if (!host) return () => undefined;
    const publish = () => {
      const project = projectSession.getCurrentProject();
      if (!project) return;
      const provider = aiProse.configuration.provider;
      const selection = resolveProjectAgentModelSelection({
        endpoint: provider.endpoint,
        defaultModel: provider.defaultModel,
        ...(provider.projectAgentModel ? { projectAgentModel: provider.projectAgentModel } : {}),
      });
      // Image-input presentation fact from the capability cache; absent while
      // unknown — the authoritative gate stays the task-start admission.
      const imageInputSupported = projectAgentCapabilityService
        .get(selection.endpoint, selection.model) === undefined
        ? undefined
        : projectAgentCapabilityService.readImageEligible(selection.endpoint, selection.model);
      void host.publishProjectContext({
        projectId: project.metadata.projectId,
        projectName: project.metadata.name,
        projectRoot: project.rootPath,
        ...(resolveActiveSceneEntry()?.name
          ? { sceneName: resolveActiveSceneEntry()?.name }
          : {}),
        ...(imageInputSupported !== undefined ? { imageInputSupported } : {}),
      }).catch(() => undefined);
    };
    const disposeProject = projectSession.subscribe(publish);
    const disposeDocument = documentStore.subscribe(publish);
    const disposeSettings = settingsManager.subscribeKey('aiProse', publish);
    publish();
    return () => {
      disposeProject();
      disposeDocument();
      disposeSettings();
    };
  })();

  const sceneMigrationPresenter = new SceneMigrationConfirmationPresenterHost();
  const sceneMigrationExperience = new SceneMigrationExperience({
    fileAccess,
    projectResources,
    confirmationPresenter: sceneMigrationPresenter,
  });

  sceneFileService = new SceneFileService(
    fileAccess,
    documentStore,
    documentFilePath,
    editorSaveStatusPort,
    semanticDocumentCoordinator,
    sceneMigrationExperience,
  );

  const projectWorkspace = new ProjectWorkspaceService(
    fileAccess,
    projectResources,
    projectSession,
    (path: string) => {
      const engine = getScriptEngine();
      if (engine) engine.setBasePath(path);
      playbackStore._setDuration(engine?.getDuration() ?? 0);
    },
    () => [...templatePackageCatalog.getPackages()],
    sceneAssets,
  );
  const libraryRoots = new LibraryRoots(
    projectWorkspace,
    () => (settingsManager.get('externalLibraryMounts') || []).map((mount) => mount.path),
    (listener) => settingsManager.subscribeKey('externalLibraryMounts', listener),
  );
  const libraryCatalog = new LibraryCatalog(fileAccess);
  const templateResourceFiles = new TemplateResourceFileService(fileAccess, templatePackageCatalog, projectWorkspace, sceneAssets);
  const unavailableVoicePort: VoiceAuthoringElectronPort = {
    scanCatalog: async () => ({ models: [], references: [], issues: [{ code: 'unreadable-root', root: '', message: '语音工作台仅在桌面应用中可用。' }], truncated: false }),
    pickReferenceAudio: async () => [],
    listPresets: async () => ({ success: false, error: '语音工作台仅在桌面应用中可用。' }),
    resolveReference: async () => ({ success: false, error: '语音工作台仅在桌面应用中可用。' }),
    savePreset: async () => ({ success: false, error: '语音工作台仅在桌面应用中可用。' }),
    renamePreset: async () => ({ success: false, error: '语音工作台仅在桌面应用中可用。' }),
    duplicatePreset: async () => ({ success: false, error: '语音工作台仅在桌面应用中可用。' }),
    deletePreset: async () => ({ success: false, error: '语音工作台仅在桌面应用中可用。' }),
    publishTemplateProfile: async () => ({ success: false, error: '语音工作台仅在桌面应用中可用。' }),
    generateCandidate: async () => ({ success: false, error: '语音工作台仅在桌面应用中可用。' }),
    clearSession: async () => ({ success: true }),
  };
  const voiceAuthoring = new VoiceAuthoringService(
    new ElectronVoiceAuthoringAdapter(electronCapability?.voiceAuthoring ?? unavailableVoicePort),
    projectResources,
    semanticAuthoring,
    projectWorkspace,
  );
  const templateDiscovery = new TemplatePackageDiscovery(fileAccess);
  const refreshDiscoveredTemplates = async () => {
    try {
      const userDataRoot = electronCapability ? await electronCapability.app.getUserDataPath() : '';
      const projectRoot = projectWorkspace.getCurrentProject()?.rootPath;
      const configuredRoots = libraryRoots.getRoots();
      const normalizeRoot = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const orderedRoots = [
        ...(projectRoot ? [projectRoot] : []),
        ...(userDataRoot ? [userDataRoot] : []),
        ...configuredRoots.filter((root) => (
          normalizeRoot(root) !== normalizeRoot(projectRoot ?? '')
          && normalizeRoot(root) !== normalizeRoot(userDataRoot)
        )),
      ];
      const result = await templateDiscovery.discoverFromLibraryRoots({
        libraryRoots: orderedRoots,
        projectRoot,
      });
      if (result.issues.length > 0) {
        console.warn('[templates] Some template packages could not be loaded:', result.issues);
      }
      templatePackageCatalog.setPackages([
        ...BUILTIN_TEMPLATE_PACKAGES,
        ...result.packages.filter((templatePackage) => templatePackage.manifest.manifestSchemaVersion === 2),
      ]);
    } catch (error) {
      console.warn('[templates] Failed to discover template packages:', error);
      templatePackageCatalog.setPackages([...BUILTIN_TEMPLATE_PACKAGES]);
    }
  };
  const disposeTemplateDiscovery = libraryRoots.subscribe(() => {
    void refreshDiscoveredTemplates();
  });
  templatePackageCatalog.setRefreshHandler(refreshDiscoveredTemplates);
  void templatePackageCatalog.refresh();
  // Inject wmdlConfigRegistry directly to Live2DManager and PreBakeDaemon
  const live2DManagerInstance = getLive2DManager();
  if (live2DManagerInstance) {
    live2DManagerInstance.setWmdlConfigRegistry(wmdlConfigRegistry);
  } else {
    live2DManager.setWmdlConfigRegistry(wmdlConfigRegistry);
  }

  preBakeDaemon.setWmdlConfigRegistry(wmdlConfigRegistry);

  // PlaybackAdapter: bridged to the unified ScriptEngine.
  const playbackAdapter = new PlaybackAdapter(playbackStore, {
    play: () => getScriptEngine()?.play(),
    pause: () => getScriptEngine()?.pause(),
    seek: (t: number, forceReconstruct?: boolean) => getScriptEngine()?.seek(t, forceReconstruct),
    setLoop: (s: number, e: number) => getScriptEngine()?.setLoopRegion(s, e),
    setLoopEnabled: (v: boolean) => getScriptEngine()?.setLoopEnabled(v),
    setSpeed: (s: number) => getScriptEngine()?.setPlaybackSpeed(s),
    getCurrentTime: () => getScriptEngine()?.getCurrentTime() ?? 0,
    previewTransform: (id: string, updates: any) => getScriptEngine()?.previewTransform(id, updates),
    getDuration: () => getScriptEngine()?.getDuration() ?? 0,
    setSilentMode: (v: boolean) => getScriptEngine()?.setSilentMode(v),
    getBasePath: () => getScriptEngine()?.getBasePath() ?? '',
    getMasterTimeline: () => getScriptEngine()?.getMasterTimeline(),
    setBasePath: (path: string) => getScriptEngine()?.setBasePath(path),
  });

  const cameraAdapter = new CameraAdapter();
  const stageAdapter = new StageAdapter();
  const timelineAdapter = new TimelineAdapter(editorStore);

  const exportAdapter = new ExportAdapter(
    stageAdapter,
    cameraAdapter,
    playbackAdapter,
    getLightingSystem,
    getLive2DManager,
    documentStore,
    electronCapability,
    projectResources,
  );

  // 4. Daemons & Sync
  const autoSaveDaemon = new AutoSaveDaemon();
  const disposeDaemon = autoSaveDaemon.attach(documentStore as any, {
    forceSave: async () => {
      const result = await sceneFileService.save();
      if (!result.success && 'error' in result) throw new Error(result.error);
    },
  });

  const validationDaemon = new ValidationDaemon(
    documentStore,
    validationStore,
    projectResources,
    () => getScriptEngine()?.getBasePath() ?? '',
    (modelPath: string) => characterAdapter.getModelDataFromPath(modelPath)
  );
  validationDaemon.start();

  // ─── Project dependency diagnostics (ADR-0021) ───
  // Missing external libraries degrade a successful open into a diagnosable
  // state; they never roll the opened project back.
  const projectDependencies = createProjectDependencyServices({
    projectResources,
    fileAccess,
    issueSink: {
      setProjectDependencyIssues: (issues) =>
        validationStore._setSourceIssues('project-dependencies', issues),
    },
    getBindings: () => settingsManager.get('projectExternalLibraryBindings') || {},
    setBindings: (next) => settingsManager.set('projectExternalLibraryBindings', next),
    getUnsavedDocument: () => {
      const document = documentStore.getCurrentSceneDocumentSnapshot();
      if (!document) return null;
      const entry = resolveActiveSceneEntry();
      return entry ? { path: entry.path, document } : null;
    },
    readSceneDocumentFromPath: async (absolutePath) => {
      try {
        const { data } = await fileAccess.readFile(absolutePath);
        const parsed = await sceneFileService.parseCurrentSceneDocumentFromRawJson?.(data, absolutePath);
        return parsed?.success ? parsed.document : null;
      } catch {
        return null;
      }
    },
    clearResolutionCaches: () => {
      projectResources.invalidateReadResolution();
      validationDaemon.clearAssetCache();
    },
    reprojectCurrentScene: async () => {
      const document = documentStore.getCurrentSceneDocumentSnapshot();
      if (!document) return;
      await semanticDocumentCoordinator.applyDocument(document, documentStore.filePath ?? undefined);
    },
  });

  // A scan report belongs to the project it was produced for.
  const disposeProjectDependencyReset = projectSession.subscribe(() => {
    projectDependencies.scanner.invalidateLastReport();
    validationStore._setSourceIssues('project-dependencies', []);
  });

  const projectOpenWorkflow = new ProjectOpenWorkflow(
    projectWorkspace,
    sceneFileService,
    settingsProjectRecentsPort,
    settingsProjectWorkflowSettingsPort,
    projectDependencies.scanService,
  );

  if (typeof window !== 'undefined') {
    const publicApi = (window.AeonStagery || {}) as any;
    publicApi.character = characterAdapter;
    publicApi.camera = cameraAdapter;
    publicApi.scene = playbackAdapter;
    publicApi.export = exportAdapter;
    publicApi.hooks = hookSystem;
    publicApi.stage = stageAdapter;
    publicApi.adapters = {
      playback: playbackAdapter,
      camera: cameraAdapter,
      character: characterAdapter,
      stage: stageAdapter,
      timeline: timelineAdapter,
      export: exportAdapter,
    };
    publicApi.stores = {
      document: documentStore,
      playback: playbackStore,
      editor: editorStore,
      validation: validationStore,
    };
    publicApi.services = {
      fileAccess,
      sceneFile: sceneFileService,
      projectOpenWorkflow,
      sceneAssets,
      projectWorkspace,
      projectResources,
      resourceAuthoring,
      projectDependencies,
      libraryRoots,
      libraryCatalog,
      templateResourceFiles,
      voiceAuthoring,
      templatePackages: templatePackageCatalog,
      templatePerformanceProfiles,
      semanticDocument: semanticDocumentCoordinator,
      semanticAuthoring,
      semanticRawScript,
      semanticVisualComposition,
      aiProse,
      ...(projectAgent ? { projectAgent } : {}),
    };
    window.AeonStagery = publicApi;
  }

  return {
    adapters: {
      playback: playbackAdapter,
      camera: cameraAdapter,
      character: characterAdapter,
      stage: stageAdapter,
      timeline: timelineAdapter,
      export: exportAdapter,
    },
    stores: {
      document: documentStore,
      playback: playbackStore,
      editor: editorStore,
      validation: validationStore,
    },
    services: {
      fileAccess,
      sceneFile: sceneFileService,
      sceneMigration: sceneMigrationExperience,
      sceneMigrationPresenter,
      projectOpenWorkflow,
      sceneAssets,
      projectWorkspace,
      projectResources,
      resourceAuthoring,
      projectDependencies,
      libraryRoots,
      libraryCatalog,
      templateResourceFiles,
      voiceAuthoring,
      templatePackages: templatePackageCatalog,
      templatePerformanceProfiles,
      semanticDocument: semanticDocumentCoordinator,
      semanticAuthoring,
      semanticRawScript,
      semanticVisualComposition,
      aiProse,
      ...(projectAgent ? { projectAgent } : {}),
    },
    dispose: () => {
      playbackAdapter.dispose();
      disposeProjectAgentSupplementRelay();
      disposeProjectAgentStartRelay();
      disposeProjectAgentSetModelRelay();
      disposeProjectAgentSetEffortRelay();
      disposeProjectAgentCommandRelay();
      disposeProjectAgentRestore();
      disposeProjectAgentContextPublisher();
      disposeAiProseProviderSettings();
      disposeAiProseReadingSpeed();
      disposeTemplateDiscovery();
      disposeDaemon();
      validationDaemon.dispose();
      disposeProjectDependencyReset();
      resourceAuthoring.dispose();
      templateResourceFiles.dispose();
      disposeSemanticHistory();
    },
  };
}

/**
 * The bounded project read ports require canonical containment and size/binary
 * checks, so the file access host MUST provide stat and realpath. Fail fast at
 * wiring time instead of silently running without containment checks.
 */
function assertFileAccessSupportsBoundedReads(fileAccess: IFileAccess): IFileAccess {
  if (!fileAccess.stat || !fileAccess.realpath) {
    throw new Error('Project agent bounded reads require fs.stat and fs.realpath on the file access host');
  }
  return fileAccess;
}

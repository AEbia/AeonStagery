import React, { createContext, useContext, useSyncExternalStore } from 'react';
import { TimelineDragProvider } from './TimelineDragContext';
import type {
  IPlaybackAdapter,
  ICameraAdapter,
  ICharacterAdapter,
  IStageAdapter,
  ITimelineAdapter,
  IExportAdapter,
  IReadonlyDocumentStore,
  IReadonlyPlaybackStore,
  IReadonlyEditorStore,
  IPlaybackStore,
  IEditorStore,
  ISceneFileService,
  IProjectOpenWorkflow,
  IProjectWorkspaceService,
  ILibraryRoots,
} from '../../api/interfaces';
import type { ProjectResourceService } from '../../services/io/ProjectResourceService';
import type { SceneAssetService } from '../../services/io/SceneAssetService';
import type { TemplateResourceFileService } from '../../services/template-package/TemplateResourceFileService';
import type { LibraryCatalog } from '../../services/io/LibraryCatalog';
import type { IFileAccess } from '../../services/io/IFileAccess';
import type { VoiceAuthoringService } from '../../services/voice/VoiceAuthoringService';
import type { TemplatePackageCatalog } from '../../services/template-package';
import type { TemplatePerformanceProfileAuthoringService } from '../../services/template-package';
import type { SemanticAuthoringApplicationService } from '../../services/timeline-authoring/SemanticAuthoringApplicationService';
import type { AiProseAuthoringComposition } from '../../services/ai-authoring/AiProseAuthoringComposition';
import type { ProjectAgentService } from '../../services/project-agent-service/ProjectAgentService';
import type { ResourceAuthoringService } from '../../services/resource-authoring';
import type {
  CollaborationConnectionStatus,
  CollaborationIdentity,
  CollaborationPresencePatchV2,
  CollaborationPresencePeerV2,
} from '../../api/types/collaboration';

import type { ValidationStore } from '../store/ValidationStore';
import type { CustomMotionEditLeaseGate } from '../../services/timeline-authoring/CustomMotionEditLeaseGate';

interface AppContextValue {
  adapters: {
    playback: IPlaybackAdapter;
    camera: ICameraAdapter;
    character: ICharacterAdapter;
    stage: IStageAdapter;
    timeline: ITimelineAdapter;
    export: IExportAdapter;
  };
  stores: {
    document: IReadonlyDocumentStore;
    playback: IPlaybackStore;          // 操作接口 — storeHooks 需要 setDuration 等
    editor: IEditorStore;              // 操作接口 — storeHooks 需要 setPixelsPerSecond 等
    validation: ValidationStore;
  };
  services?: {
    fileAccess?: IFileAccess;
    sceneFile: ISceneFileService;
    projectOpenWorkflow?: IProjectOpenWorkflow;
    projectWorkspace?: IProjectWorkspaceService;
    projectResources?: ProjectResourceService;
    resourceAuthoring?: ResourceAuthoringService;
    templateResourceFiles?: TemplateResourceFileService;
    libraryRoots?: ILibraryRoots;
    libraryCatalog?: LibraryCatalog;
    templatePackages?: TemplatePackageCatalog;
    templatePerformanceProfiles?: TemplatePerformanceProfileAuthoringService;
    sceneAssets?: SceneAssetService;
    voiceAuthoring?: VoiceAuthoringService;
    semanticAuthoring?: SemanticAuthoringApplicationService;
    aiProse?: AiProseAuthoringComposition;
    projectAgent?: ProjectAgentService;
  };
  collaboration?: {
    status: CollaborationConnectionStatus;
    self?: CollaborationIdentity | null;
    peers?: CollaborationPresencePeerV2[];
    publishPresence?: (patch?: Partial<CollaborationPresencePatchV2>) => void;
    customMotionEditLeaseGate?: CustomMotionEditLeaseGate | null;
  };
}

const AppCtx = createContext<AppContextValue | null>(null);

export function AppProvider({
  adapters,
  stores,
  services,
  collaboration,
  children,
}: AppContextValue & { children: React.ReactNode }) {
  return (
    <AppCtx.Provider value={{ adapters, stores, services, collaboration }}>
      <TimelineDragProvider>
        {children}
      </TimelineDragProvider>
    </AppCtx.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppCtx);
  if (!ctx) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return ctx;
}

export function useOptionalApp(): AppContextValue | null {
  return useContext(AppCtx);
}

export function usePlaybackAdapter(): IPlaybackAdapter { return useApp().adapters.playback; }
export function useCameraAdapter(): ICameraAdapter { return useApp().adapters.camera; }
export function useCharacterAdapter(): ICharacterAdapter { return useApp().adapters.character; }
export function useStageAdapter(): IStageAdapter { return useApp().adapters.stage; }
export function useTimelineAdapter(): ITimelineAdapter { return useApp().adapters.timeline; }
export function useExportAdapter(): IExportAdapter { return useApp().adapters.export; }

export function useDocumentStore(): IReadonlyDocumentStore { return useApp().stores.document; }
export function usePlaybackStore(): IReadonlyPlaybackStore { return useApp().stores.playback; }
export function useEditorStore(): IReadonlyEditorStore { return useApp().stores.editor; }
export function useValidationStore(): ValidationStore { return useApp().stores.validation; }
export function useFileAccessService(): IFileAccess | undefined { return useApp().services?.fileAccess; }
export function useSceneFileService(): ISceneFileService | undefined { return useApp().services?.sceneFile; }
export function useProjectOpenWorkflow(): IProjectOpenWorkflow | undefined { return useApp().services?.projectOpenWorkflow; }
export function useProjectWorkspaceService(): IProjectWorkspaceService | undefined { return useApp().services?.projectWorkspace; }
export function useProjectResourceService(): ProjectResourceService | undefined { return useApp().services?.projectResources; }
export function useResourceAuthoringService(): ResourceAuthoringService | undefined { return useApp().services?.resourceAuthoring; }
export function useLibraryRootsService(): ILibraryRoots | undefined { return useApp().services?.libraryRoots; }
export function useLibraryCatalogService(): LibraryCatalog | undefined { return useApp().services?.libraryCatalog; }
export function useTemplatePackageCatalog(): TemplatePackageCatalog | undefined { return useApp().services?.templatePackages; }
export function useSceneAssetService(): SceneAssetService | undefined { return useApp().services?.sceneAssets; }
export function useSemanticAuthoringService(): SemanticAuthoringApplicationService | undefined { return useApp().services?.semanticAuthoring; }
export function useAiProseAuthoringComposition(): AiProseAuthoringComposition | undefined { return useApp().services?.aiProse; }
export function useProjectAgentService(): ProjectAgentService | undefined { return useApp().services?.projectAgent; }

export function isCollaborationUndoDisabled(status: CollaborationConnectionStatus): boolean {
  return status === 'connecting'
    || status === 'reconnecting'
    || status === 'seeding'
    || status === 'connected'
    || status === 'offline';
}

export function useCollaborationStatus(): CollaborationConnectionStatus {
  return useApp().collaboration?.status ?? 'disconnected';
}

export function useCollaborationPresence(): { self: CollaborationIdentity | null; peers: CollaborationPresencePeerV2[] } {
  const collaboration = useApp().collaboration;
  return {
    self: collaboration?.self ?? null,
    peers: collaboration?.peers ?? [],
  };
}

export function useCollaborationPresencePublisher(): (patch?: Partial<CollaborationPresencePatchV2>) => void {
  return useApp().collaboration?.publishPresence ?? (() => {});
}

export function useIsCollaborationUndoDisabled(): boolean {
  return isCollaborationUndoDisabled(useCollaborationStatus());
}

export function useLibraryRoots(): string[] {
  const service = useLibraryRootsService();
  return useSyncExternalStore(
    service ? (listener) => service.subscribe(listener) : () => () => {},
    service ? () => service.getRoots() : () => [],
    () => [],
  );
}

export { TimelineDragProvider, useTimelineDrag } from './TimelineDragContext';

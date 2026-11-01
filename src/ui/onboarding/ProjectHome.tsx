import React, { useCallback, useRef, useState } from 'react';
import type { CollaborationConnectionStatus } from '../../api/types/collaboration';
import type { ProjectTemplateConfiguration } from '../../api/types/project';
import type { CollaborationAssetHandshakeState } from '../../services/collaboration/CollaborationAssetHandshake';
import type { TemplatePackageSummary } from '../../services/template-package';
import type { RecentProjectEntry } from '../SettingsStore';
import type { WebGalImportInput } from '../../services/import/webgal';
import type { ProjectVideoFormat } from '../../api/types/video-format';
import { HomeShell } from './home/HomeShell';
import { HomeCommandRail } from './home/HomeCommandRail';
import { SourceDock } from './home/SourceDock';
import { StartView } from './home/StartView';
import { CreateProjectView } from './home/CreateProjectView';
import { CollaborationView } from './home/CollaborationView';
import { useCreateProjectDraft } from './home/useCreateProjectDraft';
import { useCollaborationDraft } from './home/useCollaborationDraft';
import { useHomeNavigation } from './home/useHomeNavigation';
import './projectHome.css';

interface WebGalAssetSource {
  mountId: string;
  path: string;
}

export interface ProjectHomeProps {
  defaultProjectName: string;
  defaultProjectLocation: string;
  collaborationEndpoint: string;
  collaborationDisplayName: string;
  collaborationStatus: CollaborationConnectionStatus;
  assetHandshake: CollaborationAssetHandshakeState;
  onCancelResourceTransfer?: () => void;
  collaborationServerStatus: {
    running: boolean;
    host: string;
    port: number;
    dataDir: string;
    localUrl: string;
    lanUrls: string[];
    connectionPassword?: string;
    accessToken?: string;
    inviteUrls?: string[];
    assetRoot: string;
    hasState: boolean;
  } | null;
  shouldPromptExternalLibrary: boolean;
  externalLibraryPaths: string[];
  templatePackages?: TemplatePackageSummary[];
  recentProjects: RecentProjectEntry[];
  onCreateProject: (payload: { name: string; rootPath: string; videoFormat?: ProjectVideoFormat; templates?: ProjectTemplateConfiguration; webgal?: WebGalImportInput }) => void | Promise<void>;
  onBrowseCreateLocation: (currentPath: string) => Promise<string | null>;
  onRegisterWebGalAssetSource: () => Promise<WebGalAssetSource | null>;
  onBrowseCollaborationDirectory: (currentPath: string) => Promise<string | null>;
  onOpenProject: () => void | Promise<void>;
  onImportTemplatePackage: () => void | Promise<void>;
  onDeleteTemplatePackage?: (templatePackage: TemplatePackageSummary) => Promise<void>;
  onOpenRecentProject: (projectFilePath: string) => void | Promise<void>;
  onRenameRecentProject: (project: RecentProjectEntry) => void;
  onRemoveRecentProject: (projectFilePath: string) => void;
  onHostNewCollaboration: (payload: { name: string; rootPath: string; videoFormat?: ProjectVideoFormat; displayName: string; port: number; allowNetwork?: boolean; password?: string }) => void | Promise<void>;
  onHostExistingCollaboration: (payload: { displayName: string; port: number; allowNetwork?: boolean; password?: string }) => void | Promise<void>;
  onJoinCollaboration: (payload: { endpoint: string; displayName: string; rootPath: string; password?: string }) => void | Promise<void>;
  onStopCollaborationServer: () => void | Promise<void>;
  onStartTutorial: () => void;
  onChooseExternalLibrary: () => void | Promise<void>;
  onReplaceExternalLibrary: (index: number) => void | Promise<void>;
  onRemoveExternalLibrary: (index: number) => void | Promise<void>;
  onSkipExternalLibrary: () => void | Promise<void>;
  projectWorkflowBusy?: boolean;
  runProjectWorkflow?: (operation: () => void | Promise<void>) => Promise<void>;
}

export type CollaborationMode = 'menu' | 'host-new' | 'host-existing' | 'join';
export type CreateView = 'form' | 'template-capabilities';

export type NavigationTarget =
  | 'start'
  | 'create-form'
  | 'create-capabilities'
  | 'collab-menu'
  | 'collab-host-new'
  | 'collab-host-existing'
  | 'collab-join';

const EMPTY_TEMPLATE_PACKAGES: TemplatePackageSummary[] = [];

export const ProjectHome: React.FC<ProjectHomeProps> = ({
  defaultProjectName,
  defaultProjectLocation,
  collaborationEndpoint,
  collaborationDisplayName,
  collaborationStatus,
  assetHandshake,
  onCancelResourceTransfer,
  collaborationServerStatus,
  shouldPromptExternalLibrary,
  externalLibraryPaths,
  templatePackages = EMPTY_TEMPLATE_PACKAGES,
  recentProjects,
  onCreateProject,
  onBrowseCreateLocation,
  onRegisterWebGalAssetSource,
  onBrowseCollaborationDirectory,
  onOpenProject,
  onImportTemplatePackage,
  onDeleteTemplatePackage,
  onOpenRecentProject,
  onRenameRecentProject,
  onRemoveRecentProject,
  onHostNewCollaboration,
  onHostExistingCollaboration,
  onJoinCollaboration,
  onStopCollaborationServer,
  onStartTutorial,
  onChooseExternalLibrary,
  onReplaceExternalLibrary,
  onRemoveExternalLibrary,
  onSkipExternalLibrary,
  projectWorkflowBusy: externalProjectWorkflowBusy = false,
  runProjectWorkflow: runExternalProjectWorkflow,
}) => {
  const { view: currentViewKey, stageRef, navigateTo } = useHomeNavigation();
  const storyboardSelection = useRef<{ path: string | null } | null>(null);
  const [localProjectWorkflowBusy, setLocalProjectWorkflowBusy] = useState(false);
  const localProjectWorkflowRunning = useRef(false);
  const runProjectWorkflow = useCallback(async (operation: () => void | Promise<void>) => {
    if (runExternalProjectWorkflow) {
      await runExternalProjectWorkflow(operation);
      return;
    }
    if (localProjectWorkflowRunning.current) return;
    localProjectWorkflowRunning.current = true;
    setLocalProjectWorkflowBusy(true);
    try {
      await operation();
    } finally {
      localProjectWorkflowRunning.current = false;
      setLocalProjectWorkflowBusy(false);
    }
  }, [runExternalProjectWorkflow]);
  const isProjectWorkflowBusy = externalProjectWorkflowBusy || localProjectWorkflowBusy;
  const handleOpenProject = useCallback(
    () => runProjectWorkflow(onOpenProject),
    [onOpenProject, runProjectWorkflow],
  );
  const handleCreateProject = useCallback(
    (payload: Parameters<ProjectHomeProps['onCreateProject']>[0]) => runProjectWorkflow(() => onCreateProject(payload)),
    [onCreateProject, runProjectWorkflow],
  );
  const handleHostNewCollaboration = useCallback(
    (payload: Parameters<ProjectHomeProps['onHostNewCollaboration']>[0]) => runProjectWorkflow(() => onHostNewCollaboration(payload)),
    [onHostNewCollaboration, runProjectWorkflow],
  );
  const handleHostExistingCollaboration = useCallback(
    (payload: Parameters<ProjectHomeProps['onHostExistingCollaboration']>[0]) => runProjectWorkflow(() => onHostExistingCollaboration(payload)),
    [onHostExistingCollaboration, runProjectWorkflow],
  );
  const handleJoinCollaboration = useCallback(
    (payload: Parameters<ProjectHomeProps['onJoinCollaboration']>[0]) => runProjectWorkflow(() => onJoinCollaboration(payload)),
    [onJoinCollaboration, runProjectWorkflow],
  );
  const handleImportTemplatePackage = useCallback(
    () => runProjectWorkflow(onImportTemplatePackage),
    [onImportTemplatePackage, runProjectWorkflow],
  );
  const handleDeleteTemplatePackage = useCallback(async (templatePackage: TemplatePackageSummary) => {
    if (onDeleteTemplatePackage) await runProjectWorkflow(() => onDeleteTemplatePackage(templatePackage));
  }, [onDeleteTemplatePackage, runProjectWorkflow]);
  // Keep the open operation's lifetime independent of the routed StartView.
  const [openingRecentPath, setOpeningRecentPath] = useState<string | null>(null);
  const openingRecent = useRef(false);
  const handleOpenRecentProject = useCallback(async (path: string) => {
    if (openingRecent.current || localProjectWorkflowRunning.current || externalProjectWorkflowBusy) return;
    openingRecent.current = true;
    setOpeningRecentPath(path);
    try {
      await runProjectWorkflow(() => onOpenRecentProject(path));
    } finally {
      openingRecent.current = false;
      setOpeningRecentPath(null);
    }
  }, [onOpenRecentProject, runProjectWorkflow]);
  const navigateHomeTo = (target: NavigationTarget) => {
    if (localProjectWorkflowRunning.current || externalProjectWorkflowBusy) return;
    navigateTo(target);
  };
  const mode = currentViewKey === 'start' ? 'start' : currentViewKey.startsWith('create-') ? 'create' : 'collaboration';
  const createView: CreateView = currentViewKey === 'create-capabilities' ? 'template-capabilities' : 'form';
  const collaborationMode: CollaborationMode = currentViewKey === 'collab-host-new' ? 'host-new'
    : currentViewKey === 'collab-host-existing' ? 'host-existing' : currentViewKey === 'collab-join' ? 'join' : 'menu';
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isChoosingLibrary, setIsChoosingLibrary] = useState(false);
  const handleChooseExternalLibrary = async () => {
    if (isChoosingLibrary || localProjectWorkflowRunning.current || externalProjectWorkflowBusy) return;
    setIsChoosingLibrary(true);
    try {
      await runProjectWorkflow(onChooseExternalLibrary);
    } finally {
      setIsChoosingLibrary(false);
    }
  };

  const handleReplaceExternalLibrary = async (index: number) => {
    if (isChoosingLibrary || localProjectWorkflowRunning.current || externalProjectWorkflowBusy) return;
    setIsChoosingLibrary(true);
    try {
      await runProjectWorkflow(() => onReplaceExternalLibrary(index));
    } finally {
      setIsChoosingLibrary(false);
    }
  };

  const handleRemoveExternalLibrary = async (index: number) => {
    if (isChoosingLibrary || localProjectWorkflowRunning.current || externalProjectWorkflowBusy) return;
    setIsChoosingLibrary(true);
    try {
      await runProjectWorkflow(() => onRemoveExternalLibrary(index));
    } finally {
      setIsChoosingLibrary(false);
    }
  };

  const handleSkipExternalLibrary = async () => {
    if (isChoosingLibrary || localProjectWorkflowRunning.current || externalProjectWorkflowBusy) return;
    setIsChoosingLibrary(true);
    try {
      await runProjectWorkflow(onSkipExternalLibrary);
    } finally {
      setIsChoosingLibrary(false);
    }
  };

  const createDraft = useCreateProjectDraft({ defaultProjectName, defaultProjectLocation, templatePackages,
    onCreateProject: handleCreateProject, onBrowseCreateLocation, onRegisterWebGalAssetSource, isSubmitting, setIsSubmitting });
  const collabDraft = useCollaborationDraft({ defaultProjectName, defaultProjectLocation, collaborationEndpoint,
    collaborationDisplayName, onBrowseCreateLocation, onBrowseCollaborationDirectory, onHostNewCollaboration: handleHostNewCollaboration,
    onHostExistingCollaboration: handleHostExistingCollaboration, onJoinCollaboration: handleJoinCollaboration, isSubmitting, setIsSubmitting,
    videoFormat: createDraft.videoFormat, setVideoFormat: createDraft.setVideoFormat });

  return <HomeShell
    busy={isProjectWorkflowBusy}
    rail={<HomeCommandRail activeTarget={mode === 'create' ? 'create' : mode === 'collaboration' ? 'collaboration' : undefined}
      busy={isProjectWorkflowBusy} onGoHome={() => navigateHomeTo('start')} onCreate={() => navigateHomeTo('create-form')} onOpen={handleOpenProject}
      onCollaborate={() => navigateHomeTo('collab-menu')} onStartTutorial={onStartTutorial} />}
    sources={<SourceDock paths={externalLibraryPaths} shouldPrompt={shouldPromptExternalLibrary}
      isBusy={isChoosingLibrary} disabled={isProjectWorkflowBusy} onAdd={handleChooseExternalLibrary} onReplace={handleReplaceExternalLibrary}
      onRemove={handleRemoveExternalLibrary} onSkip={handleSkipExternalLibrary} />}>
    <div ref={stageRef} className="ph-view-stage">
      <React.Fragment key={currentViewKey}>
      {mode === 'start' ? <StartView recentProjects={recentProjects} selectionMemory={storyboardSelection}
        openingRecentPath={openingRecentPath} workflowBusy={isProjectWorkflowBusy} onOpenRecentProject={handleOpenRecentProject}
        onRenameRecentProject={onRenameRecentProject} onRemoveRecentProject={onRemoveRecentProject}
        templatePackages={templatePackages} onImportTemplatePackage={handleImportTemplatePackage}
        onDeleteTemplatePackage={handleDeleteTemplatePackage} onCreate={() => navigateHomeTo('create-form')}
        onStartTutorial={onStartTutorial} />
        : mode === 'create' ? <CreateProjectView draft={createDraft} createView={createView}
          workflowBusy={isProjectWorkflowBusy} navigateTo={navigateHomeTo} templatePackages={templatePackages} onDeleteTemplatePackage={handleDeleteTemplatePackage} />
          : <CollaborationView draft={collabDraft} collaborationMode={collaborationMode} navigateTo={navigateHomeTo}
            collaborationStatus={collaborationStatus} collaborationEndpoint={collaborationEndpoint}
            collaborationServerStatus={collaborationServerStatus} assetHandshake={assetHandshake}
            onCancelResourceTransfer={onCancelResourceTransfer} onStopCollaborationServer={onStopCollaborationServer}
            workflowBusy={isProjectWorkflowBusy} />}
      </React.Fragment>
    </div>
  </HomeShell>;
};

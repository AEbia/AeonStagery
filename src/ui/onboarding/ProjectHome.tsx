import React, { useRef, useState } from 'react';
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
}) => {
  const { view: currentViewKey, stageRef, navigateTo } = useHomeNavigation();
  const storyboardSelection = useRef<{ path: string | null } | null>(null);
  const mode = currentViewKey === 'start' ? 'start' : currentViewKey.startsWith('create-') ? 'create' : 'collaboration';
  const createView: CreateView = currentViewKey === 'create-capabilities' ? 'template-capabilities' : 'form';
  const collaborationMode: CollaborationMode = currentViewKey === 'collab-host-new' ? 'host-new'
    : currentViewKey === 'collab-host-existing' ? 'host-existing' : currentViewKey === 'collab-join' ? 'join' : 'menu';
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isChoosingLibrary, setIsChoosingLibrary] = useState(false);
  const handleChooseExternalLibrary = async () => {
    if (isChoosingLibrary) return;
    setIsChoosingLibrary(true);
    try {
      await onChooseExternalLibrary();
    } finally {
      setIsChoosingLibrary(false);
    }
  };

  const handleReplaceExternalLibrary = async (index: number) => {
    if (isChoosingLibrary) return;
    setIsChoosingLibrary(true);
    try {
      await onReplaceExternalLibrary(index);
    } finally {
      setIsChoosingLibrary(false);
    }
  };

  const handleRemoveExternalLibrary = async (index: number) => {
    if (isChoosingLibrary) return;
    setIsChoosingLibrary(true);
    try {
      await onRemoveExternalLibrary(index);
    } finally {
      setIsChoosingLibrary(false);
    }
  };

  const handleSkipExternalLibrary = async () => {
    if (isChoosingLibrary) return;
    setIsChoosingLibrary(true);
    try {
      await onSkipExternalLibrary();
    } finally {
      setIsChoosingLibrary(false);
    }
  };

  const createDraft = useCreateProjectDraft({ defaultProjectName, defaultProjectLocation, templatePackages,
    onCreateProject, onBrowseCreateLocation, onRegisterWebGalAssetSource, isSubmitting, setIsSubmitting });
  const collabDraft = useCollaborationDraft({ defaultProjectName, defaultProjectLocation, collaborationEndpoint,
    collaborationDisplayName, onBrowseCreateLocation, onBrowseCollaborationDirectory, onHostNewCollaboration,
    onHostExistingCollaboration, onJoinCollaboration, isSubmitting, setIsSubmitting,
    videoFormat: createDraft.videoFormat, setVideoFormat: createDraft.setVideoFormat });

  return <HomeShell
    rail={<HomeCommandRail activeTarget={mode === 'create' ? 'create' : mode === 'collaboration' ? 'collaboration' : undefined}
      onGoHome={() => navigateTo('start')} onCreate={() => navigateTo('create-form')} onOpen={onOpenProject}
      onCollaborate={() => navigateTo('collab-menu')} onStartTutorial={onStartTutorial} />}
    sources={<SourceDock paths={externalLibraryPaths} shouldPrompt={shouldPromptExternalLibrary}
      isBusy={isChoosingLibrary} onAdd={handleChooseExternalLibrary} onReplace={handleReplaceExternalLibrary}
      onRemove={handleRemoveExternalLibrary} onSkip={handleSkipExternalLibrary} />}>
    <div ref={stageRef} className="ph-view-stage">
      <React.Fragment key={currentViewKey}>
      {mode === 'start' ? <StartView recentProjects={recentProjects} selectionMemory={storyboardSelection} onOpenRecentProject={onOpenRecentProject}
        onRenameRecentProject={onRenameRecentProject} onRemoveRecentProject={onRemoveRecentProject}
        templatePackages={templatePackages} onImportTemplatePackage={onImportTemplatePackage}
        onDeleteTemplatePackage={onDeleteTemplatePackage} onCreate={() => navigateTo('create-form')}
        onStartTutorial={onStartTutorial} />
        : mode === 'create' ? <CreateProjectView draft={createDraft} createView={createView}
          navigateTo={navigateTo} templatePackages={templatePackages} onDeleteTemplatePackage={onDeleteTemplatePackage} />
          : <CollaborationView draft={collabDraft} collaborationMode={collaborationMode} navigateTo={navigateTo}
            collaborationStatus={collaborationStatus} collaborationEndpoint={collaborationEndpoint}
            collaborationServerStatus={collaborationServerStatus} assetHandshake={assetHandshake}
            onCancelResourceTransfer={onCancelResourceTransfer} onStopCollaborationServer={onStopCollaborationServer} />}
      </React.Fragment>
    </div>
  </HomeShell>;
};

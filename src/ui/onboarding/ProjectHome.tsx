import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IconArrowLeft, IconCheck, IconCopy, IconEye, IconEyeOff, IconFile, IconFolder, IconInfo, IconPlus, IconTarget, IconTrash, IconUsers } from '../icons';
import { MAX_RECENT_PROJECTS } from '../SettingsStore';
import type { CollaborationConnectionStatus } from '../../api/types/collaboration';
import type {
  CharacterVariantImportMode,
  ProjectTemplateConfiguration,
  ProjectTemplateDefaults,
} from '../../api/types/project';
import type { CollaborationAssetHandshakeState } from '../../services/collaboration/CollaborationAssetHandshake';
import type { TemplatePackageSummary } from '../../services/template-package';
import type { RecentProjectEntry } from '../SettingsStore';
import { CollaborationAssetHandshakePanel } from '../CollaborationAssetHandshakePanel';
import {
  buildAvailableCharacterPresets,
  buildAvailableDialogueStyles,
  resolveTemplateDefaultValue,
  TemplateCapabilityConfig,
  TemplatePackageSelector,
} from '../templates/TemplateCapabilityConfig';
import {
  convertWebGalToSceneDocument,
  joinWebGalScriptTexts,
  type WebGalChapterTransition,
  type WebGalImportInput,
  type WebGalImportReport,
} from '../../services/import/webgal';
import { InfoTip, Tooltip } from '../Tooltip';
import { useModalDialog } from '../hooks/useModalDialog';
import './projectHome.css';

interface WebGalAssetSource {
  mountId: string;
  path: string;
}

interface WebGalScriptFile {
  name: string;
  text: string;
}

interface ProjectHomeProps {
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
  onCreateProject: (payload: { name: string; rootPath: string; templates?: ProjectTemplateConfiguration; webgal?: WebGalImportInput }) => void | Promise<void>;
  onBrowseCreateLocation: (currentPath: string) => Promise<string | null>;
  onRegisterWebGalAssetSource: () => Promise<WebGalAssetSource | null>;
  onBrowseCollaborationDirectory: (currentPath: string) => Promise<string | null>;
  onOpenProject: () => void | Promise<void>;
  onImportTemplatePackage: () => void | Promise<void>;
  onOpenRecentProject: (projectFilePath: string) => void | Promise<void>;
  onRemoveRecentProject: (projectFilePath: string) => void;
  onHostNewCollaboration: (payload: { name: string; rootPath: string; displayName: string; port: number; allowNetwork?: boolean; password?: string }) => void | Promise<void>;
  onHostExistingCollaboration: (payload: { displayName: string; port: number; allowNetwork?: boolean; password?: string }) => void | Promise<void>;
  onJoinCollaboration: (payload: { endpoint: string; displayName: string; rootPath: string; password?: string }) => void | Promise<void>;
  onStopCollaborationServer: () => void | Promise<void>;
  onStartTutorial: () => void;
  onChooseExternalLibrary: () => void | Promise<void>;
  onReplaceExternalLibrary: (index: number) => void | Promise<void>;
  onRemoveExternalLibrary: (index: number) => void | Promise<void>;
  onSkipExternalLibrary: () => void | Promise<void>;
}

type HomeMode = 'start' | 'create' | 'collaboration';
type CollaborationMode = 'menu' | 'host-new' | 'host-existing' | 'join';
type CreateView = 'form' | 'template-capabilities';

type NavigationTarget =
  | 'start'
  | 'create-form'
  | 'create-capabilities'
  | 'collab-menu'
  | 'collab-host-new'
  | 'collab-host-existing'
  | 'collab-join';

const VIEW_DEPTH: Record<NavigationTarget, number> = {
  'start': 0,
  'create-form': 1,
  'create-capabilities': 2,
  'collab-menu': 1,
  'collab-host-new': 2,
  'collab-host-existing': 2,
  'collab-join': 2,
};

const EMPTY_TEMPLATE_PACKAGES: TemplatePackageSummary[] = [];

const buildProjectPath = (location: string, name: string) => {
  const cleanLocation = location.trim().replace(/[\\/]+$/, '');
  const cleanName = name.trim();
  if (!cleanLocation) return cleanName;
  if (!cleanName) return cleanLocation;
  return `${cleanLocation}/${cleanName}`;
};

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
  onOpenRecentProject,
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
  const defaultRootPath = useMemo(
    () => buildProjectPath(defaultProjectLocation, defaultProjectName),
    [defaultProjectLocation, defaultProjectName],
  );
  const [mode, setMode] = useState<HomeMode>('start');
  const [collaborationMode, setCollaborationMode] = useState<CollaborationMode>('menu');
  const [createView, setCreateView] = useState<CreateView>('form');
  const [transitionDirection, setTransitionDirection] = useState<'forward' | 'backward'>('forward');
  const [projectName, setProjectName] = useState(defaultProjectName);
  const [projectRootPath, setProjectRootPath] = useState(defaultRootPath);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>(() => templatePackages.map((templatePackage) => templatePackage.id));
  const hasCustomizedTemplateSelectionRef = useRef(false);
  const [selectedCharacterPresetIds, setSelectedCharacterPresetIds] = useState<string[]>([]);
  const [characterVariantImportMode, setCharacterVariantImportMode] = useState<CharacterVariantImportMode>('primary-only');
  const [defaultOverrides, setDefaultOverrides] = useState<ProjectTemplateDefaults>({});
  const [isRootPathDirty, setIsRootPathDirty] = useState(false);
  const [hostProjectName, setHostProjectName] = useState(`${defaultProjectName} 协作`);
  const [hostProjectRootPath, setHostProjectRootPath] = useState(buildProjectPath(defaultProjectLocation, `${defaultProjectName} 协作`));
  const [isHostRootPathDirty, setIsHostRootPathDirty] = useState(false);
  const [joinEndpoint, setJoinEndpoint] = useState(collaborationEndpoint);
  const [collaborationName, setCollaborationName] = useState(collaborationDisplayName);
  const [collaborationPort, setCollaborationPort] = useState('12345');
  const [allowNetwork, setAllowNetwork] = useState(true);
  const [hostPassword, setHostPassword] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [joinRootPath, setJoinRootPath] = useState(buildProjectPath(defaultProjectLocation, 'AeonStagery Collaboration Session'));
  const [isJoinRootPathDirty, setIsJoinRootPathDirty] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isChoosingLibrary, setIsChoosingLibrary] = useState(false);
  const [openingRecentPath, setOpeningRecentPath] = useState<string | null>(null);
  const [projectToRemove, setProjectToRemove] = useState<RecentProjectEntry | null>(null);
  const [webgalScriptFiles, setWebgalScriptFiles] = useState<WebGalScriptFile[]>([]);
  const [webgalScriptReport, setWebgalScriptReport] = useState<WebGalImportReport | null>(null);
  const [webgalChapterTransition, setWebgalChapterTransition] = useState<WebGalChapterTransition>('black');
  const [webgalAssetSource, setWebgalAssetSource] = useState<WebGalAssetSource | null>(null);
  const [webgalSpeed, setWebgalSpeed] = useState(1.5);
  const [isReadingWebgalScript, setIsReadingWebgalScript] = useState(false);
  const [isImportingTemplate, setIsImportingTemplate] = useState(false);
  const [copiedServerField, setCopiedServerField] = useState<string | null>(null);
  const [showServerDetails, setShowServerDetails] = useState(false);
  const [showHostPassword, setShowHostPassword] = useState(false);
  const [showJoinPassword, setShowJoinPassword] = useState(false);
  const [showServerPassword, setShowServerPassword] = useState(false);
  const [showServerToken, setShowServerToken] = useState(false);

  const handleCopyServerInfo = async (text: string, fieldId: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedServerField(fieldId);
      setTimeout(() => {
        setCopiedServerField((curr) => (curr === fieldId ? null : curr));
      }, 1800);
    } catch {
      // fallback
    }
  };

  const removeRecentDialogRef = useModalDialog(
    () => setProjectToRemove(null),
    projectToRemove !== null,
  );

  const currentViewKey: NavigationTarget = useMemo(() => {
    if (mode === 'start') return 'start';
    if (mode === 'create') {
      return createView === 'form' ? 'create-form' : 'create-capabilities';
    }
    if (mode === 'collaboration') {
      if (collaborationMode === 'host-new') return 'collab-host-new';
      if (collaborationMode === 'host-existing') return 'collab-host-existing';
      if (collaborationMode === 'join') return 'collab-join';
      return 'collab-menu';
    }
    return 'start';
  }, [mode, createView, collaborationMode]);

  const navigateTo = (target: NavigationTarget) => {
    const currentDepth = VIEW_DEPTH[currentViewKey];
    const targetDepth = VIEW_DEPTH[target];
    setTransitionDirection(targetDepth < currentDepth ? 'backward' : 'forward');

    switch (target) {
      case 'start':
        setMode('start');
        setCollaborationMode('menu');
        setCreateView('form');
        break;
      case 'create-form':
        setMode('create');
        setCreateView('form');
        break;
      case 'create-capabilities':
        setMode('create');
        setCreateView('template-capabilities');
        break;
      case 'collab-menu':
        setMode('collaboration');
        setCollaborationMode('menu');
        break;
      case 'collab-host-new':
        setMode('collaboration');
        setCollaborationMode('host-new');
        break;
      case 'collab-host-existing':
        setMode('collaboration');
        setCollaborationMode('host-existing');
        break;
      case 'collab-join':
        setMode('collaboration');
        setCollaborationMode('join');
        break;
    }
  };

  const headerTitle = useMemo(() => {
    if (mode === 'create') {
      return createView === 'form' ? '新建项目' : '模板能力配置';
    }
    if (mode === 'collaboration') {
      if (collaborationMode === 'host-new') return '主持新剧本';
      if (collaborationMode === 'host-existing') return '主持已有剧本';
      if (collaborationMode === 'join') return '加入房间';
      return '协作';
    }
    return '开始制作';
  }, [mode, createView, collaborationMode]);

  const headerEyebrow = useMemo(() => {
    if (mode === 'create') return 'AeonStagery · 项目创建';
    if (mode === 'collaboration') return 'AeonStagery · 实时协作';
    return 'AeonStagery';
  }, [mode]);

  useEffect(() => {
    setProjectName(defaultProjectName);
    setHostProjectName(`${defaultProjectName} 协作`);
  }, [defaultProjectName]);

  useEffect(() => {
    if (!isRootPathDirty) {
      setProjectRootPath(defaultRootPath);
    }
  }, [defaultRootPath, isRootPathDirty]);

  useEffect(() => {
    const availableIds = new Set(templatePackages.map((templatePackage) => templatePackage.id));
    setSelectedTemplateIds((current) => {
      if (!hasCustomizedTemplateSelectionRef.current) {
        return templatePackages.map((templatePackage) => templatePackage.id);
      }
      const filtered = current.filter((id) => availableIds.has(id));
      return filtered.length === current.length && filtered.every((id, index) => id === current[index])
        ? current
        : filtered;
    });
  }, [templatePackages]);

  const availableCharacterPresets = useMemo(() => {
    return buildAvailableCharacterPresets(templatePackages, selectedTemplateIds);
  }, [selectedTemplateIds, templatePackages]);
  const availableDialogueStyles = useMemo(
    () => buildAvailableDialogueStyles(templatePackages, selectedTemplateIds),
    [selectedTemplateIds, templatePackages],
  );
  const resolvedDialogueStyle = useMemo(
    () => resolveTemplateDefaultValue(
      'dialogueStyleId',
      templatePackages,
      selectedTemplateIds,
      defaultOverrides,
      'glass',
    ),
    [defaultOverrides, selectedTemplateIds, templatePackages],
  );

  useEffect(() => {
    const availableIds = new Set(availableCharacterPresets.map((preset) => preset.id));
    setSelectedCharacterPresetIds((current) => current.filter((id) => availableIds.has(id)));
  }, [availableCharacterPresets]);

  useEffect(() => {
    if (!isHostRootPathDirty) {
      setHostProjectRootPath(buildProjectPath(defaultProjectLocation, hostProjectName));
    }
  }, [defaultProjectLocation, hostProjectName, isHostRootPathDirty]);

  useEffect(() => {
    if (!isJoinRootPathDirty) {
      setJoinRootPath(buildProjectPath(defaultProjectLocation, 'AeonStagery Collaboration Session'));
    }
  }, [defaultProjectLocation, isJoinRootPathDirty]);

  useEffect(() => {
    setJoinEndpoint(collaborationEndpoint);
  }, [collaborationEndpoint]);

  useEffect(() => {
    setCollaborationName(collaborationDisplayName);
  }, [collaborationDisplayName]);

  const handleNameChange = (nextName: string) => {
    setProjectName(nextName);
    if (!isRootPathDirty) {
      setProjectRootPath(buildProjectPath(defaultProjectLocation, nextName));
    }
  };

  const handleBrowseLocation = async () => {
    const nextPath = await onBrowseCreateLocation(projectRootPath);
    if (nextPath) {
      setIsRootPathDirty(true);
      setProjectRootPath(nextPath);
    }
  };

  const handleHostNameChange = (nextName: string) => {
    setHostProjectName(nextName);
    if (!isHostRootPathDirty) {
      setHostProjectRootPath(buildProjectPath(defaultProjectLocation, nextName));
    }
  };

  const handleBrowseHostLocation = async () => {
    const nextPath = await onBrowseCreateLocation(hostProjectRootPath);
    if (nextPath) {
      setIsHostRootPathDirty(true);
      setHostProjectRootPath(nextPath);
    }
  };

  const handleBrowseJoinLocation = async () => {
    const nextPath = await onBrowseCollaborationDirectory(joinRootPath);
    if (nextPath) {
      setIsJoinRootPathDirty(true);
      setJoinRootPath(nextPath);
    }
  };

  const handleCreate = async () => {
    const trimmedName = projectName.trim();
    const trimmedRootPath = projectRootPath.trim().replace(/[\\/]+$/, '');
    if (!trimmedName || !trimmedRootPath || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onCreateProject({
        name: trimmedName,
        rootPath: trimmedRootPath,
        templates: {
          enabledTemplateIds: selectedTemplateIds,
          defaults: Object.keys(defaultOverrides).length > 0 ? defaultOverrides : undefined,
          selectedCharacterPresetIds,
          characterVariantImportMode,
        },
        ...(webgalScriptFiles.length > 0
          ? {
            webgal: {
              scriptText: webgalScriptFiles[0].text,
              scriptName: webgalScriptFiles[0].name,
              ...(webgalScriptFiles.length > 1
                ? {
                  additionalScripts: webgalScriptFiles.slice(1).map((file) => ({
                    scriptText: file.text,
                    scriptName: file.name,
                  })),
                }
                : {}),
              mountId: webgalAssetSource?.mountId,
              speed: webgalSpeed,
              chapterTransition: webgalChapterTransition,
            },
          }
          : {}),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChooseWebGalScript = async () => {
    if (isReadingWebgalScript) return;
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '选择 WebGAL 剧本文件（可多选，按选择顺序连续演出）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'WebGAL 剧本', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePaths?.length) return;
    setIsReadingWebgalScript(true);
    try {
      const loaded: WebGalScriptFile[] = [];
      for (const filePath of result.filePaths) {
        const fileResult = await window.aeonStageryAPI.fs.readTextFile(filePath);
        if (!fileResult.success || typeof fileResult.data !== 'string') {
          throw new Error(fileResult.error ?? '无法读取剧本文件');
        }
        loaded.push({
          name: filePath.split(/[\\/]/).pop() ?? '剧本',
          text: fileResult.data,
        });
      }
      const next = [...webgalScriptFiles, ...loaded];
      setWebgalScriptFiles(next);
      setWebgalScriptReport(mergeScriptsReport(next, webgalSpeed, webgalChapterTransition));
    } catch (error: any) {
      window.alert(`读取 WebGAL 剧本失败：${error?.message || String(error)}`);
    } finally {
      setIsReadingWebgalScript(false);
    }
  };

  const handleImportTemplatePackage = async () => {
    if (isImportingTemplate) return;
    setIsImportingTemplate(true);
    try {
      await onImportTemplatePackage();
    } finally {
      setIsImportingTemplate(false);
    }
  };

  const handleRemoveWebGalScript = (index: number) => {
    const next = webgalScriptFiles.filter((_, currentIndex) => currentIndex !== index);
    setWebgalScriptFiles(next);
    setWebgalScriptReport(next.length > 0 ? mergeScriptsReport(next, webgalSpeed, webgalChapterTransition) : null);
  };

  const handleMoveWebGalScript = (index: number, delta: -1 | 1) => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= webgalScriptFiles.length) return;
    const next = [...webgalScriptFiles];
    const [removed] = next.splice(index, 1);
    next.splice(targetIndex, 0, removed);
    setWebgalScriptFiles(next);
    setWebgalScriptReport(next.length > 0 ? mergeScriptsReport(next, webgalSpeed, webgalChapterTransition) : null);
  };

  const handleClearWebGalScripts = () => {
    setWebgalScriptFiles([]);
    setWebgalScriptReport(null);
  };

  const mergeScriptsReport = (
    files: WebGalScriptFile[],
    speed: number,
    transition: WebGalChapterTransition,
  ): WebGalImportReport | null => {
    if (files.length === 0) return null;
    return convertWebGalToSceneDocument(
      joinWebGalScriptTexts({
        scriptText: files[0].text,
        additionalScripts: files.slice(1).map((file) => ({
          scriptText: file.text,
          scriptName: file.name,
        })),
        chapterTransition: transition,
      }),
      { duration: { speed } },
    ).report;
  };

  const handleWebgalSpeedChange = (speed: number) => {
    setWebgalSpeed(speed);
    if (webgalScriptFiles.length > 0) {
      setWebgalScriptReport(mergeScriptsReport(webgalScriptFiles, speed, webgalChapterTransition));
    }
  };

  const handleWebgalChapterTransitionChange = (transition: WebGalChapterTransition) => {
    setWebgalChapterTransition(transition);
    if (webgalScriptFiles.length > 0) {
      setWebgalScriptReport(mergeScriptsReport(webgalScriptFiles, webgalSpeed, transition));
    }
  };

  const handleChooseWebGalAssetSource = async () => {
    const source = await onRegisterWebGalAssetSource();
    if (source) setWebgalAssetSource(source);
  };

  const handleClearWebGalAssetSource = () => {
    setWebgalAssetSource(null);
  };

  const toggleTemplate = (templateId: string) => {
    const isSelected = selectedTemplateIds.includes(templateId);
    if (isSelected && selectedTemplateIds.length === 1) return;
    hasCustomizedTemplateSelectionRef.current = true;
    setSelectedTemplateIds((current) => {
      if (current.includes(templateId)) {
        return current.filter((id) => id !== templateId);
      }
      const availableOrder = templatePackages.map((templatePackage) => templatePackage.id);
      return [...current, templateId].sort((left, right) =>
        availableOrder.indexOf(left) - availableOrder.indexOf(right),
      );
    });
  };

  const moveTemplate = (templateId: string, direction: -1 | 1) => {
    const selectedIndex = selectedTemplateIds.indexOf(templateId);
    if (selectedIndex < 0 || selectedIndex + direction < 0 || selectedIndex + direction >= selectedTemplateIds.length) return;
    hasCustomizedTemplateSelectionRef.current = true;
    setSelectedTemplateIds((current) => {
      const index = current.indexOf(templateId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const toggleCharacterPreset = (presetId: string) => {
    setSelectedCharacterPresetIds((current) => (
      current.includes(presetId)
        ? current.filter((id) => id !== presetId)
        : [...current, presetId]
    ));
  };

  const handleChangeDialogueStyleOverride = (styleId: string | undefined) => {
    updateDefaultOverride('dialogueStyleId', styleId);
  };

  const updateDefaultOverride = (key: keyof ProjectTemplateDefaults, value: string | undefined) => {
    setDefaultOverrides((current) => {
      const next = { ...current };
      if (!value) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const parseCollaborationPort = () => {
    const port = Number(collaborationPort);
    return Number.isFinite(port) && port > 0 ? Math.floor(port) : 12345;
  };

  const handleHostNew = async () => {
    const trimmedName = hostProjectName.trim();
    const trimmedRootPath = hostProjectRootPath.trim().replace(/[\\/]+$/, '');
    if (!trimmedName || !trimmedRootPath || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onHostNewCollaboration({
        name: trimmedName,
        rootPath: trimmedRootPath,
        displayName: collaborationName.trim() || '导演',
        port: parseCollaborationPort(),
        allowNetwork,
        ...(hostPassword ? { password: hostPassword } : {}),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleHostExisting = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onHostExistingCollaboration({
        displayName: collaborationName.trim() || '导演',
        port: parseCollaborationPort(),
        allowNetwork,
        ...(hostPassword ? { password: hostPassword } : {}),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleJoinCollaboration = async () => {
    const trimmedEndpoint = joinEndpoint.trim();
    const trimmedRootPath = joinRootPath.trim().replace(/[\\/]+$/, '');
    if (!trimmedEndpoint || !trimmedRootPath || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onJoinCollaboration({
        endpoint: trimmedEndpoint,
        ...(joinPassword ? { password: joinPassword } : {}),
        displayName: collaborationName.trim() || '导演',
        rootPath: trimmedRootPath,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

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

  const handleOpenRecent = async (projectFilePath: string) => {
    if (openingRecentPath) return;
    setOpeningRecentPath(projectFilePath);
    try {
      await onOpenRecentProject(projectFilePath);
    } finally {
      setOpeningRecentPath(null);
    }
  };

  const handleConfirmRecentRemoval = () => {
    if (!projectToRemove) return;
    onRemoveRecentProject(projectToRemove.projectFilePath);
    setProjectToRemove(null);
  };

  const collaborationProgressLabel = collaborationStatus === 'connecting'
    ? '连接中'
    : collaborationStatus === 'seeding'
      ? '准备协作'
      : null;
  const collaborationServerAddress = collaborationEndpoint.trim()
    || collaborationServerStatus?.localUrl
    || '未设置';

  return (
    <div className="ph-overlay">
      <div className="ph-ambient-glow" aria-hidden="true">
        <div className="ph-ambient-orb ph-ambient-orb--1" />
        <div className="ph-ambient-orb ph-ambient-orb--2" />
        <div className="ph-ambient-orb ph-ambient-orb--3" />
      </div>

      <div className="ph-launcher">
        <header className="ph-header">
          <div key={headerTitle} className="ph-header-content">
            <div className="ph-eyebrow">{headerEyebrow}</div>
            <h1 className="ph-title">{headerTitle}</h1>
          </div>
        </header>

        {mode === 'create' ? (
          <section className={`ph-surface ph-view-stage ph-view-${transitionDirection}`} key={currentViewKey}>
            <div className="ph-section-header ph-stagger-1">
              <div className="ph-header-titles">
                <nav className="ph-breadcrumbs" aria-label="页面导航">
                  <button
                    type="button"
                    className="ph-breadcrumb-btn"
                    onClick={() => navigateTo('start')}
                  >
                    开始制作
                  </button>
                  <span className="ph-breadcrumb-sep" aria-hidden="true">›</span>
                  {createView === 'template-capabilities' ? (
                    <>
                      <button
                        type="button"
                        className="ph-breadcrumb-btn"
                        onClick={() => navigateTo('create-form')}
                      >
                        新建项目
                      </button>
                      <span className="ph-breadcrumb-sep" aria-hidden="true">›</span>
                      <span className="ph-breadcrumb-current">模板能力配置</span>
                    </>
                  ) : (
                    <span className="ph-breadcrumb-current">新建项目</span>
                  )}
                </nav>
                <div className="ph-section-title">
                  {createView === 'form' ? '新建项目' : '模板能力配置'}
                  <InfoTip
                    content={createView === 'form'
                      ? '选择模板包和优先级；角色等细项进入模板能力配置。'
                      : '配置会应用到项目初始化的模板能力。'}
                  />
                </div>
              </div>
              <button
                className="btn ph-btn-compact ph-back-btn"
                onClick={() => {
                  if (createView === 'template-capabilities') {
                    navigateTo('create-form');
                    return;
                  }
                  navigateTo('start');
                }}
              >
                <IconArrowLeft width={13} height={13} className="ph-back-icon" /> 返回
              </button>
            </div>

            {createView === 'form' ? (
              <>
                <div className="ph-form-grid ph-stagger-2">
                  <Field label="项目名称">
                    <input
                      className="ph-input"
                      value={projectName}
                      onChange={(event) => handleNameChange(event.target.value)}
                      placeholder="例如：第 1 话演出稿"
                    />
                  </Field>

                  <Field label="项目位置">
                    <div className="ph-browse-row">
                      <input
                        className="ph-input"
                        value={projectRootPath}
                        onChange={(event) => {
                          setIsRootPathDirty(true);
                          setProjectRootPath(event.target.value);
                        }}
                        placeholder="例如：Documents/AeonStagery Projects/第 1 话演出稿"
                      />
                      <button className="btn ph-btn-compact" onClick={() => { void handleBrowseLocation(); }}>
                        浏览
                      </button>
                    </div>
                  </Field>
                </div>

                <div className="ph-stagger-3">
                  <TemplatePackageSelector
                    packages={templatePackages}
                    selectedIds={selectedTemplateIds}
                    onToggle={toggleTemplate}
                    onMove={moveTemplate}
                  />
                </div>

                <div className="ph-capability-card ph-stagger-4">
                  <div>
                    <div className="ph-field-label">
                      模板能力
                      <InfoTip content="已选择初始角色。角色、对白样式和后续模板能力会在这里集中配置。" />
                    </div>
                    <div className="ph-capability-count">
                      已选择 {selectedCharacterPresetIds.length} 个初始角色
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn ph-btn-compact"
                    onClick={() => navigateTo('create-capabilities')}
                  >
                    配置模板能力
                  </button>
                </div>

                <div className="ph-webgal-card ph-stagger-4">
                  <div>
                    <div className="ph-field-label">
                      导入 WebGAL 剧本（可选）
                      <InfoTip content="可以一次选择多个 WebGAL 剧本文件（例如按章节拆分的多个 .txt）。创建项目时会按选择顺序合并成一条连续时间线：对白、旁白、背景、立绘登场/退场与移动，中间不会中断。" />
                    </div>
                  </div>

                  {webgalScriptFiles.length > 0 ? (
                    <div style={webgalScriptListStyle}>
                      {webgalScriptFiles.map((file, index) => (
                        <div key={`${file.name}:${index}`} style={webgalScriptItemStyle}>
                          <span style={webgalScriptOrderStyle}>{index + 1}</span>
                          <span style={webgalScriptNameTextStyle} title={file.name}>{file.name}</span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              type="button"
                              className="btn ph-btn-compact"
                              onClick={() => handleMoveWebGalScript(index, -1)}
                              disabled={index === 0 || isReadingWebgalScript}
                              title="上移"
                              style={tinyButtonStyle}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="btn ph-btn-compact"
                              onClick={() => handleMoveWebGalScript(index, 1)}
                              disabled={index === webgalScriptFiles.length - 1 || isReadingWebgalScript}
                              title="下移"
                              style={tinyButtonStyle}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="btn ph-btn-compact"
                              onClick={() => handleRemoveWebGalScript(index)}
                              disabled={isReadingWebgalScript}
                              style={tinyButtonStyle}
                            >
                              移除
                            </button>
                          </div>
                        </div>
                      ))}
                      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                        <button
                          type="button"
                          className="btn ph-btn-compact"
                          onClick={() => { void handleChooseWebGalScript(); }}
                          disabled={isReadingWebgalScript}
                        >
                          {isReadingWebgalScript ? '正在读取...' : '继续添加剧本'}
                        </button>
                        <button
                          type="button"
                          className="btn ph-btn-compact"
                          onClick={handleClearWebGalScripts}
                          disabled={isReadingWebgalScript}
                        >
                          全部移除
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="ph-browse-row">
                      <div className="ph-webgal-file-name">
                        {isReadingWebgalScript ? '正在读取...' : '未选择剧本文件'}
                      </div>
                      <button
                        type="button"
                        className="btn ph-btn-compact"
                        onClick={() => { void handleChooseWebGalScript(); }}
                        disabled={isReadingWebgalScript}
                      >
                        选择剧本文件
                      </button>
                    </div>
                  )}

                  <div>
                    <div className="ph-field-label">
                      阅读速度
                      <InfoTip content="决定没有配音的台词停留多久；有配音的台词以音频实际时长为准。" />
                    </div>
                  </div>
                  <div className="ph-speed-row">
                    {[1.125, 1.5, 2.25].map((speed) => (
                      <button
                        key={speed}
                        type="button"
                        className={`btn ph-speed-btn ${webgalSpeed === speed ? 'ph-speed-btn--active' : ''}`}
                        onClick={() => handleWebgalSpeedChange(speed)}
                      >
                        {speed === 1.125 ? '慢速' : speed === 1.5 ? '标准' : '快速'}
                      </button>
                    ))}
                  </div>

                  <div>
                    <div className="ph-field-label">
                      衔接处处理（多个剧本时生效）
                      <InfoTip content="每个衔接处都会先让前一个剧本中仍登场的角色全部退场（固定行为）。背景的处理方式可以三选一。" />
                    </div>
                  </div>
                  <div className="ph-speed-row">
                    {[
                      { value: 'black' as const, label: '黑场', hint: '背景淡出为黑并停留片刻，下一剧本再淡入' },
                      { value: 'fade' as const, label: '淡入再淡出', hint: '背景快速淡出，下一剧本的背景淡入' },
                      { value: 'none' as const, label: '不做任何改动', hint: '背景无缝衔接（只执行角色退场）' },
                    ].map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`btn ph-speed-btn ${webgalChapterTransition === option.value ? 'ph-speed-btn--active' : ''}`}
                        onClick={() => handleWebgalChapterTransitionChange(option.value)}
                        title={option.hint}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>

                  {webgalScriptReport && (
                    <div className="ph-webgal-summary">
                      <div className="ph-webgal-stats">
                        {webgalScriptFiles.length > 1 && `已合并 ${webgalScriptFiles.length} 个剧本，按选择顺序连续演出 · `}
                        {(() => {
                          const { stats, characters } = webgalScriptReport;
                          const parts = [
                            `对白 ${stats.dialogueCount + stats.narrationCount} 句`,
                            `角色 ${characters.length} 个`,
                            `背景 ${stats.backgroundChanges} 处`,
                            `登场 ${stats.figureEnters} 次`,
                            `退场 ${stats.figureExits} 次`,
                            `移动 ${stats.transforms} 次`,
                          ];
                          if (stats.bgmCount > 0) parts.push(`音乐 ${stats.bgmCount} 首`);
                          if (stats.sfxCount > 0) parts.push(`音效 ${stats.sfxCount} 处`);
                          return parts.join(' · ');
                        })()}
                      </div>
                      {webgalScriptReport.unsupportedCommands.length > 0 && (
                        <div className="ph-webgal-warning">
                          未识别指令 {webgalScriptReport.unsupportedCommands.length} 条（已跳过）
                        </div>
                      )}
                    </div>
                  )}

                  <div>
                    <div className="ph-field-label">
                      素材目录（可选）
                      <InfoTip content="选择 WebGAL 工程里直接包含 figure、background 等素材子目录的目录，剧本里的立绘和背景就会引用该素材库；不选则引用会暂时保留为项目相对路径。" />
                    </div>
                    {webgalAssetSource && (
                      <div className="ph-webgal-source-info">
                        已连接：{webgalAssetSource.path}（@mount/{webgalAssetSource.mountId}）
                      </div>
                    )}
                  </div>

                  <div className="ph-browse-row">
                    <div className="ph-webgal-file-name">
                      {webgalAssetSource ? webgalAssetSource.path : '未选择素材目录'}
                    </div>
                    {webgalAssetSource ? (
                      <button className="btn ph-btn-compact" onClick={handleClearWebGalAssetSource}>
                        移除
                      </button>
                    ) : (
                      <button
                        className="btn ph-btn-compact"
                        onClick={() => { void handleChooseWebGalAssetSource(); }}
                      >
                        选择素材目录
                      </button>
                    )}
                  </div>
                </div>

                <div className="ph-footer-row ph-stagger-5">
                  <div className="ph-hint-text">
                    <InfoTip content="会生成 project.json、默认场景入口和资源目录。" ariaLabel="创建项目说明" />
                  </div>
                  <button
                    className="btn btn--primary ph-btn-primary-compact"
                    onClick={() => { void handleCreate(); }}
                    disabled={!projectName.trim() || !projectRootPath.trim() || isSubmitting}
                  >
                    {isSubmitting ? '正在创建...' : '创建项目'}
                  </button>
                </div>
              </>
            ) : (
              <div className="ph-stagger-2">
                <TemplateCapabilityConfig
                  dialogueStyles={availableDialogueStyles}
                  resolvedDialogueStyle={resolvedDialogueStyle}
                  onChangeDialogueStyleOverride={handleChangeDialogueStyleOverride}
                  characterPresets={availableCharacterPresets}
                  selectedCharacterPresetIds={selectedCharacterPresetIds}
                  onToggleCharacterPreset={toggleCharacterPreset}
                  characterVariantImportMode={characterVariantImportMode}
                  onChangeCharacterVariantImportMode={setCharacterVariantImportMode}
                />
              </div>
            )}
          </section>
        ) : mode === 'collaboration' ? (
          <section className={`ph-surface ph-view-stage ph-view-${transitionDirection}`} key={currentViewKey}>
            <div className="ph-section-header ph-stagger-1">
              <div className="ph-header-titles">
                <nav className="ph-breadcrumbs" aria-label="页面导航">
                  <button
                    type="button"
                    className="ph-breadcrumb-btn"
                    onClick={() => navigateTo('start')}
                  >
                    开始制作
                  </button>
                  <span className="ph-breadcrumb-sep" aria-hidden="true">›</span>
                  {collaborationMode !== 'menu' ? (
                    <>
                      <button
                        type="button"
                        className="ph-breadcrumb-btn"
                        onClick={() => navigateTo('collab-menu')}
                      >
                        协作
                      </button>
                      <span className="ph-breadcrumb-sep" aria-hidden="true">›</span>
                      <span className="ph-breadcrumb-current">
                        {collaborationMode === 'host-new'
                          ? '主持新剧本'
                          : collaborationMode === 'host-existing'
                            ? '主持已有剧本'
                            : '加入房间'}
                      </span>
                    </>
                  ) : (
                    <span className="ph-breadcrumb-current">协作</span>
                  )}
                </nav>
                <div className="ph-section-title">协作</div>
              </div>
              <button className="btn ph-btn-compact ph-back-btn" onClick={() => navigateTo('start')}>
                <IconArrowLeft width={13} height={13} className="ph-back-icon" /> 返回
              </button>
            </div>

            {collaborationServerStatus && (
              <div className="ph-server-credentials-card ph-server-capsule ph-stagger-2">
                <div className="ph-server-capsule-bar">
                  <div className="ph-server-capsule-main">
                    <span className="ph-live-dot ph-live-dot--success" />
                    <span className="ph-server-capsule-label">
                      本机服务器 {collaborationServerStatus.running ? '运行中' : '已停止'}
                    </span>
                    <strong className="ph-server-capsule-url">{collaborationServerStatus.localUrl}</strong>
                    <button
                      type="button"
                      className="btn ph-btn-micro"
                      onClick={() => { void handleCopyServerInfo(collaborationServerStatus.localUrl, 'url'); }}
                      title="复制服务地址"
                    >
                      {copiedServerField === 'url' ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
                      <span>{copiedServerField === 'url' ? '已复制' : '复制'}</span>
                    </button>
                  </div>

                  <div className="ph-server-capsule-actions">
                    <button
                      type="button"
                      className="btn ph-btn-micro"
                      onClick={() => setShowServerDetails((v) => !v)}
                      title="展开或折叠详细网络与资源信息"
                    >
                      {showServerDetails ? '收起详情' : '连接详情'}
                    </button>
                    <button
                      type="button"
                      className="btn ph-btn-micro ph-btn-danger-outline"
                      onClick={() => { void onStopCollaborationServer(); }}
                    >
                      停止服务器
                    </button>
                  </div>
                </div>

                <div className="ph-credentials-grid">
                  {collaborationServerStatus.inviteUrls && collaborationServerStatus.inviteUrls.length > 0 && (
                    <div className="ph-credential-item ph-credential-item--featured">
                      <div className="ph-credential-header">
                        <span className="ph-credential-label">邀请链接（包含访问凭证，协作者直接粘贴即可加入）</span>
                        <button
                          type="button"
                          className="btn ph-btn-micro ph-btn-copy"
                          onClick={() => { void handleCopyServerInfo(collaborationServerStatus.inviteUrls![0], 'server-invite'); }}
                          title="复制完整邀请链接"
                        >
                          {copiedServerField === 'server-invite' ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
                          <span>{copiedServerField === 'server-invite' ? '已复制' : '复制链接'}</span>
                        </button>
                      </div>
                      <div className="ph-credential-input-wrapper">
                        <input
                          className="ph-input ph-font-mono ph-credential-input"
                          readOnly
                          value={collaborationServerStatus.inviteUrls[0]}
                          aria-label="协作邀请链接"
                        />
                      </div>
                    </div>
                  )}

                  {collaborationServerStatus.connectionPassword && (
                    <div className="ph-credential-item">
                      <div className="ph-credential-header">
                        <span className="ph-credential-label">房间密码</span>
                        <button
                          type="button"
                          className="btn ph-btn-micro ph-btn-copy"
                          onClick={() => { void handleCopyServerInfo(collaborationServerStatus.connectionPassword!, 'server-pwd'); }}
                          title="复制连接密码"
                        >
                          {copiedServerField === 'server-pwd' ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
                          <span>{copiedServerField === 'server-pwd' ? '已复制' : '复制密码'}</span>
                        </button>
                      </div>
                      <div className="ph-credential-input-wrapper ph-password-input-row">
                        <input
                          className="ph-input ph-font-mono ph-credential-input"
                          type={showServerPassword ? 'text' : 'password'}
                          readOnly
                          value={collaborationServerStatus.connectionPassword}
                          aria-label="协作连接密码"
                        />
                        <button
                          type="button"
                          className="ph-input-eye-btn"
                          onClick={() => setShowServerPassword((v) => !v)}
                          title={showServerPassword ? '隐藏密码' : '显示密码'}
                          aria-label={showServerPassword ? '隐藏密码' : '显示密码'}
                        >
                          {showServerPassword ? <IconEyeOff width={13} height={13} /> : <IconEye width={13} height={13} />}
                        </button>
                      </div>
                    </div>
                  )}

                  {collaborationServerStatus.accessToken && (
                    <div className="ph-credential-item">
                      <div className="ph-credential-header">
                        <span className="ph-credential-label">访问 Token</span>
                        <button
                          type="button"
                          className="btn ph-btn-micro ph-btn-copy"
                          onClick={() => { void handleCopyServerInfo(collaborationServerStatus.accessToken!, 'server-token'); }}
                          title="复制访问 Token"
                        >
                          {copiedServerField === 'server-token' ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
                          <span>{copiedServerField === 'server-token' ? '已复制' : '复制 Token'}</span>
                        </button>
                      </div>
                      <div className="ph-credential-input-wrapper ph-password-input-row">
                        <input
                          className="ph-input ph-font-mono ph-credential-input"
                          type={showServerToken ? 'text' : 'password'}
                          readOnly
                          value={collaborationServerStatus.accessToken}
                          aria-label="协作访问 Token"
                        />
                        <button
                          type="button"
                          className="ph-input-eye-btn"
                          onClick={() => setShowServerToken((v) => !v)}
                          title={showServerToken ? '隐藏 Token' : '显示 Token'}
                          aria-label={showServerToken ? '隐藏 Token' : '显示 Token'}
                        >
                          {showServerToken ? <IconEyeOff width={13} height={13} /> : <IconEye width={13} height={13} />}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="ph-credential-item">
                    <div className="ph-credential-header">
                      <span className="ph-credential-label">服务地址（局域网 / 本机）</span>
                      <button
                        type="button"
                        className="btn ph-btn-micro ph-btn-copy"
                        onClick={() => {
                          const endpoint = collaborationServerStatus.lanUrls[0] || collaborationServerStatus.localUrl;
                          void handleCopyServerInfo(endpoint, 'server-endpoint');
                        }}
                        title="复制服务地址"
                      >
                        {copiedServerField === 'server-endpoint' ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
                        <span>{copiedServerField === 'server-endpoint' ? '已复制' : '复制地址'}</span>
                      </button>
                    </div>
                    <div className="ph-credential-input-wrapper">
                      <input
                        className="ph-input ph-font-mono ph-credential-input"
                        readOnly
                        value={collaborationServerStatus.lanUrls[0] || collaborationServerStatus.localUrl}
                        aria-label="协作服务地址"
                      />
                    </div>
                  </div>
                </div>

                {showServerDetails && (
                  <div className="ph-server-details-panel">
                    <div className="ph-server-resource-status">
                      <span>资源目录</span>
                      <strong title={collaborationServerStatus.assetRoot}>{collaborationServerStatus.assetRoot}</strong>
                      <span>{collaborationServerStatus.hasState ? '已有房间状态' : '等待首次发布'}</span>
                    </div>
                    {collaborationServerStatus.lanUrls.length > 0 && (
                      <div className="ph-server-urls">
                        <span style={{ alignSelf: 'center', opacity: 0.7 }}>局域网：</span>
                        {collaborationServerStatus.lanUrls.map((url) => (
                          <span
                            key={url}
                            onClick={() => { void handleCopyServerInfo(url, url); }}
                            title="点击复制该地址"
                            style={{ cursor: 'pointer' }}
                          >
                            {url}
                          </span>
                        ))}
                      </div>
                    )}
                    {collaborationServerStatus.connectionPassword && (
                      <Field label="连接密码（仅分享给协作者）">
                        <input className="ph-input" readOnly value={collaborationServerStatus.connectionPassword} />
                      </Field>
                    )}
                  </div>
                )}
              </div>
            )}

            {collaborationProgressLabel ? (
              <div role="status" className="ph-collab-progress ph-stagger-2">
                <div className="ph-collab-progress-main">
                  <strong>{collaborationProgressLabel}</strong>
                  <span>{collaborationStatus === 'connecting' ? '正在连接协作服务器...' : '正在准备协作资源...'}</span>
                </div>
                <div className="ph-collab-progress-endpoint">
                  <span>服务器地址</span>
                  <strong>{collaborationServerAddress}</strong>
                </div>
              </div>
            ) : null}

            <CollaborationAssetHandshakePanel
              state={assetHandshake}
              onCancelTransfer={onCancelResourceTransfer}
            />

            {collaborationMode === 'menu' && (
              <div className="ph-collab-choice-grid ph-stagger-3">
                <Tooltip content="新建项目并立即播种协作房间" title="主持新剧本">
                  <button className="btn ph-action-card ph-action-card--collab" onClick={() => navigateTo('collab-host-new')}>
                    <span className="ph-action-icon"><IconPlus width={21} height={21} /></span>
                    <span className="ph-action-copy">
                      <span className="ph-action-title">主持新剧本</span>
                      <span className="ph-action-desc">新建本地项目并启动房间</span>
                    </span>
                  </button>
                </Tooltip>
                <Tooltip content="选择 project.json 或项目目录后主持" title="主持已有剧本">
                  <button className="btn ph-action-card ph-action-card--collab" onClick={() => navigateTo('collab-host-existing')}>
                    <span className="ph-action-icon"><IconFolder width={21} height={21} /></span>
                    <span className="ph-action-copy">
                      <span className="ph-action-title">主持已有剧本</span>
                      <span className="ph-action-desc">复用本地项目播种协作</span>
                    </span>
                  </button>
                </Tooltip>
                <Tooltip content="输入服务器地址并选择本地目录" title="加入房间">
                  <button className="btn ph-action-card ph-action-card--collab ph-action-card--featured" onClick={() => navigateTo('collab-join')}>
                    <span className="ph-action-icon"><IconUsers width={21} height={21} /></span>
                    <span className="ph-action-copy">
                      <span className="ph-action-title">加入房间</span>
                      <span className="ph-action-desc">连接服务器并同步场景剧本</span>
                    </span>
                  </button>
                </Tooltip>
              </div>
            )}

            {collaborationMode === 'host-new' && (
              <div className="ph-collab-form-stack ph-stagger-3">
                <div className="ph-section-header">
                  <div className="ph-header-titles">
                    <div className="ph-section-title">主持新剧本</div>
                  </div>
                  <button className="btn ph-btn-compact ph-back-btn" onClick={() => navigateTo('collab-menu')}>
                    <IconArrowLeft width={13} height={13} className="ph-back-icon" /> 返回
                  </button>
                </div>

                <CollabModeTabs currentMode="host-new" onSelectMode={navigateTo} />

                <div className="ph-form-grid">
                  <Field label="项目名称">
                    <input
                      className="ph-input"
                      value={hostProjectName}
                      onChange={(event) => handleHostNameChange(event.target.value)}
                      placeholder="例如：第 1 话协作"
                    />
                  </Field>
                  <Field label="昵称">
                    <input
                      className="ph-input"
                      value={collaborationName}
                      onChange={(event) => setCollaborationName(event.target.value)}
                      placeholder="导演"
                    />
                  </Field>
                  <div className="ph-field-full">
                    <Field label="项目位置">
                      <div className="ph-browse-row">
                        <input
                          className="ph-input"
                          value={hostProjectRootPath}
                          onChange={(event) => {
                            setIsHostRootPathDirty(true);
                            setHostProjectRootPath(event.target.value);
                          }}
                          placeholder="选择新项目目录"
                        />
                        <button className="btn ph-btn-compact" onClick={() => { void handleBrowseHostLocation(); }}>
                          浏览
                        </button>
                      </div>
                    </Field>
                  </div>
                  <Field label="端口">
                    <input
                      className="ph-input"
                      value={collaborationPort}
                      onChange={(event) => setCollaborationPort(event.target.value.replace(/[^\d]/g, ''))}
                      placeholder="12345"
                    />
                  </Field>
                  <Field label="协作密码（选填，任意长度）">
                    <div className="ph-password-input-row">
                      <input
                        className="ph-input"
                        type={showHostPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        value={hostPassword}
                        onChange={(event) => setHostPassword(event.target.value)}
                        placeholder="留空自动生成随机密码"
                      />
                      <button
                        type="button"
                        className="ph-input-eye-btn"
                        onClick={() => setShowHostPassword((v) => !v)}
                        title={showHostPassword ? '隐藏密码' : '显示密码'}
                        aria-label={showHostPassword ? '隐藏密码' : '显示密码'}
                      >
                        {showHostPassword ? <IconEyeOff width={13} height={13} /> : <IconEye width={13} height={13} />}
                      </button>
                    </div>
                  </Field>
                  <div className="ph-field-full">
                    <label className="ph-hint-text ph-checkbox-row">
                      <input type="checkbox" checked={allowNetwork} onChange={(event) => setAllowNetwork(event.target.checked)} />
                      <span>允许其他设备连接（局域网 / 公网）</span>
                    </label>
                  </div>
                </div>
                <div className="ph-footer-row">
                  <div className="ph-hint-text">
                    <span>{allowNetwork ? '允许其他设备连接' : '仅本机连接'}</span>
                  </div>
                  <button
                    className="btn btn--primary ph-btn-primary-compact"
                    onClick={() => { void handleHostNew(); }}
                    disabled={!hostProjectName.trim() || !hostProjectRootPath.trim() || isSubmitting}
                  >
                    {isSubmitting ? '正在主持...' : '创建并主持'}
                  </button>
                </div>
              </div>
            )}

            {collaborationMode === 'host-existing' && (
              <div className="ph-collab-form-stack ph-stagger-3">
                <div className="ph-section-header">
                  <div className="ph-header-titles">
                    <div className="ph-section-title">主持已有剧本</div>
                  </div>
                  <button className="btn ph-btn-compact ph-back-btn" onClick={() => navigateTo('collab-menu')}>
                    <IconArrowLeft width={13} height={13} className="ph-back-icon" /> 返回
                  </button>
                </div>

                <CollabModeTabs currentMode="host-existing" onSelectMode={navigateTo} />

                <div className="ph-form-grid">
                  <Field label="昵称">
                    <input
                      className="ph-input"
                      value={collaborationName}
                      onChange={(event) => setCollaborationName(event.target.value)}
                      placeholder="导演"
                    />
                  </Field>
                  <Field label="端口">
                    <input
                      className="ph-input"
                      value={collaborationPort}
                      onChange={(event) => setCollaborationPort(event.target.value.replace(/[^\d]/g, ''))}
                      placeholder="12345"
                    />
                  </Field>
                  <Field label="协作密码（选填，任意长度）">
                    <div className="ph-password-input-row">
                      <input
                        className="ph-input"
                        type={showHostPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        value={hostPassword}
                        onChange={(event) => setHostPassword(event.target.value)}
                        placeholder="留空自动生成随机密码"
                      />
                      <button
                        type="button"
                        className="ph-input-eye-btn"
                        onClick={() => setShowHostPassword((v) => !v)}
                        title={showHostPassword ? '隐藏密码' : '显示密码'}
                        aria-label={showHostPassword ? '隐藏密码' : '显示密码'}
                      >
                        {showHostPassword ? <IconEyeOff width={13} height={13} /> : <IconEye width={13} height={13} />}
                      </button>
                    </div>
                  </Field>
                  <div className="ph-field-full">
                    <label className="ph-hint-text ph-checkbox-row">
                      <input type="checkbox" checked={allowNetwork} onChange={(event) => setAllowNetwork(event.target.checked)} />
                      <span>允许其他设备连接（局域网 / 公网）</span>
                    </label>
                  </div>
                </div>
                <div className="ph-footer-row">
                  <div className="ph-hint-text">
                    <span>复用原房间及资源</span>
                  </div>
                  <button
                    className="btn btn--primary ph-btn-primary-compact"
                    onClick={() => { void handleHostExisting(); }}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? '正在主持...' : '选择项目并主持'}
                  </button>
                </div>
              </div>
            )}

            {collaborationMode === 'join' && (
              <div className="ph-collab-form-stack ph-stagger-3">
                <div className="ph-section-header">
                  <div className="ph-header-titles">
                    <div className="ph-section-title">加入房间</div>
                  </div>
                  <button className="btn ph-btn-compact ph-back-btn" onClick={() => navigateTo('collab-menu')}>
                    <IconArrowLeft width={13} height={13} className="ph-back-icon" /> 返回
                  </button>
                </div>

                <CollabModeTabs currentMode="join" onSelectMode={navigateTo} />

                <div className="ph-form-grid">
                  <Field label="服务器">
                    <input
                      className="ph-input"
                      value={joinEndpoint}
                      onChange={(event) => setJoinEndpoint(event.target.value)}
                      placeholder="127.0.0.1:12345"
                    />
                  </Field>
                  <Field label="连接密码（使用完整邀请链接时可留空）">
                    <div className="ph-password-input-row">
                      <input
                        className="ph-input"
                        type={showJoinPassword ? 'text' : 'password'}
                        autoComplete="off"
                        value={joinPassword}
                        onChange={(event) => setJoinPassword(event.target.value)}
                        placeholder="输入主持人提供的密码"
                      />
                      <button
                        type="button"
                        className="ph-input-eye-btn"
                        onClick={() => setShowJoinPassword((v) => !v)}
                        title={showJoinPassword ? '隐藏密码' : '显示密码'}
                        aria-label={showJoinPassword ? '隐藏密码' : '显示密码'}
                      >
                        {showJoinPassword ? <IconEyeOff width={13} height={13} /> : <IconEye width={13} height={13} />}
                      </button>
                    </div>
                  </Field>
                  <Field label="昵称">
                    <input
                      className="ph-input"
                      value={collaborationName}
                      onChange={(event) => setCollaborationName(event.target.value)}
                      placeholder="导演"
                    />
                  </Field>
                  <div className="ph-field-full">
                    <Field label="本地协作工作区">
                      <div className="ph-browse-row">
                        <input
                          className="ph-input"
                          value={joinRootPath}
                          onChange={(event) => {
                            setIsJoinRootPathDirty(true);
                            setJoinRootPath(event.target.value);
                          }}
                          placeholder="选择空目录或已有项目目录"
                        />
                        <button className="btn ph-btn-compact" onClick={() => { void handleBrowseJoinLocation(); }}>
                          浏览
                        </button>
                      </div>
                    </Field>
                  </div>
                </div>
                <div className="ph-footer-row">
                  <div />
                  <button
                    className="btn btn--primary ph-btn-primary-compact"
                    onClick={() => { void handleJoinCollaboration(); }}
                    disabled={!joinEndpoint.trim() || !joinRootPath.trim() || isSubmitting || collaborationStatus === 'connecting' || collaborationStatus === 'seeding'}
                  >
                    {isSubmitting ? '正在加入...' : '加入房间'}
                  </button>
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className={`ph-start-surface ph-view-stage ph-view-${transitionDirection}`} key="start">
            <div className="ph-action-grid ph-stagger-1">
              <Tooltip content="完成角色登场、环境画面、对白、动作与镜头，并播放预览" title="开始教程">
                <button className="btn ph-action-card ph-action-card--featured" onClick={onStartTutorial}>
                  <span className="ph-action-icon"><IconTarget width={21} height={21} /></span>
                  <span className="ph-action-copy">
                    <span className="ph-action-title">开始教程</span>
                  </span>
                </button>
              </Tooltip>
              <Tooltip content="创建可迁移的 AeonStagery 项目目录" title="新建项目">
                <button className="btn ph-action-card" onClick={() => navigateTo('create-form')}>
                  <span className="ph-action-icon"><IconPlus width={21} height={21} /></span>
                  <span className="ph-action-copy">
                    <span className="ph-action-title">新建项目</span>
                  </span>
                </button>
              </Tooltip>
              <Tooltip content="选择项目目录或 project.json" title="打开项目">
                <button className="btn ph-action-card" onClick={() => { void onOpenProject(); }}>
                  <span className="ph-action-icon"><IconFolder width={21} height={21} /></span>
                  <span className="ph-action-copy">
                    <span className="ph-action-title">打开项目</span>
                  </span>
                </button>
              </Tooltip>
              <Tooltip content="主持或加入实时协作房间" title="协作">
                <button className="btn ph-action-card" onClick={() => navigateTo('collab-menu')}>
                  <span className="ph-action-icon"><IconUsers width={21} height={21} /></span>
                  <span className="ph-action-copy">
                    <span className="ph-action-title">协作</span>
                  </span>
                </button>
              </Tooltip>
            </div>

            <div className="ph-content-grid ph-stagger-2">
              <section className="ph-surface">
                <div className="ph-section-header">
                  <div>
                    <div className="ph-section-title">
                      最近项目
                    </div>
                  </div>
                  <IconFile width={18} height={18} />
                </div>
                {recentProjects.length > 0 ? (
                  <div className="ph-recent-list">
                    {recentProjects.slice(0, MAX_RECENT_PROJECTS).map((project) => (
                      <div
                        key={`${project.projectFilePath}:${project.lastOpenedAt}`}
                        className="ph-recent-item"
                      >
                        <button
                          type="button"
                          className="btn ph-recent-open"
                          onClick={() => { void handleOpenRecent(project.projectFilePath); }}
                          disabled={openingRecentPath === project.projectFilePath}
                          aria-label={`打开最近项目：${project.name}`}
                          title={project.rootPath}
                        >
                          <IconFile width={16} height={16} className="ph-recent-icon" />
                          <span className="ph-recent-text">
                            <span className="ph-recent-name">{project.name}</span>
                            <span className="ph-recent-path">{project.rootPath}</span>
                          </span>
                          <span className="ph-recent-time">{formatRecentTime(project.lastOpenedAt)}</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn--icon btn--danger ph-recent-delete"
                          onClick={() => setProjectToRemove(project)}
                          aria-label={`移除最近项目：${project.name}`}
                          title="移除最近项目"
                        >
                          <IconTrash width={14} height={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="ph-recent-empty">暂无最近项目</div>
                )}
              </section>

              <ExternalLibraryManager
                paths={externalLibraryPaths}
                shouldPrompt={shouldPromptExternalLibrary}
                isBusy={isChoosingLibrary}
                isImportingTemplate={isImportingTemplate}
                onImportTemplate={handleImportTemplatePackage}
                onAdd={handleChooseExternalLibrary}
                onReplace={handleReplaceExternalLibrary}
                onRemove={handleRemoveExternalLibrary}
                onSkip={handleSkipExternalLibrary}
              />
            </div>
          </section>
        )}

      </div>

      {projectToRemove && (
        <div
          className="modal-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) setProjectToRemove(null);
          }}
        >
          <div
            ref={removeRecentDialogRef}
            className="modal ph-recent-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recent-project-delete-title"
            tabIndex={-1}
          >
            <div className="modal__header">
              <IconTrash width={18} height={18} style={{ color: 'var(--error)' }} />
              <span id="recent-project-delete-title">移除最近项目？</span>
            </div>
            <div className="ph-recent-delete-project" title={projectToRemove.rootPath}>
              {projectToRemove.name}
            </div>
            <div className="modal__footer">
              <button type="button" className="btn" onClick={() => setProjectToRemove(null)}>取消</button>
              <button type="button" className="btn btn--danger" onClick={handleConfirmRecentRemoval}>移除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const ExternalLibraryManager = ({
  paths,
  shouldPrompt,
  isBusy,
  isImportingTemplate,
  onImportTemplate,
  onAdd,
  onReplace,
  onRemove,
  onSkip,
}: {
  paths: string[];
  shouldPrompt: boolean;
  isBusy: boolean;
  isImportingTemplate?: boolean;
  onImportTemplate?: () => void | Promise<void>;
  onAdd: () => void | Promise<void>;
  onReplace: (index: number) => void | Promise<void>;
  onRemove: (index: number) => void | Promise<void>;
  onSkip: () => void | Promise<void>;
}) => (
  <section className="ph-surface">
    <div className="ph-section-header">
      <div>
        <div className="ph-section-title">
          外部库与模板
          <InfoTip content="管理只读素材来源与应用专用模板包。" />
        </div>
      </div>
      <div className="ph-header-actions">
        {onImportTemplate && (
          <button
            className="btn ph-btn-compact"
            onClick={() => { void onImportTemplate(); }}
            disabled={isImportingTemplate}
            title="安装 ZIP 到应用专用模板库"
          >
            <IconPlus width={13} height={13} /> {isImportingTemplate ? '正在导入模板…' : '导入模板包'}
          </button>
        )}
        <button
          className="btn btn--primary ph-btn-compact"
          data-tutorial-target="external-library-add"
          onClick={() => { void onAdd(); }}
          disabled={isBusy}
        >
          <IconPlus width={13} height={13} /> 添加外部库
        </button>
      </div>
    </div>

    <div className="ph-library-list">
      {paths.length > 0 ? (
        paths.map((path, index) => (
          <div key={`${path}:${index}`} className="ph-library-item">
            <IconFolder width={16} height={16} style={{ flexShrink: 0, color: 'var(--text-secondary)' }} />
            <div className="ph-library-path" title={path}>{path}</div>
            <button
              className="btn ph-btn-tiny"
              data-tutorial-target={`external-library-replace-${index}`}
              onClick={() => { void onReplace(index); }}
              disabled={isBusy}
            >
              修改
            </button>
            <button className="btn ph-btn-tiny" onClick={() => { void onRemove(index); }} disabled={isBusy}>移除</button>
          </div>
        ))
      ) : (
        <div className="ph-library-empty">
          <IconInfo width={16} height={16} />
          <span>{shouldPrompt ? '还没有连接外部素材库。' : '未配置外部素材库。'}</span>
          {shouldPrompt && (
            <button className="btn ph-btn-tiny" onClick={() => { void onSkip(); }} disabled={isBusy}>
              暂不配置
            </button>
          )}
        </div>
      )}
    </div>
  </section>
);

const CollabModeTabs: React.FC<{
  currentMode: CollaborationMode;
  onSelectMode: (target: NavigationTarget) => void;
}> = ({ currentMode, onSelectMode }) => (
  <div className="ph-collab-mode-tabs" role="tablist" aria-label="协作模式选择">
    <button
      type="button"
      role="tab"
      aria-selected={currentMode === 'join'}
      aria-label="切换到加入房间"
      className={`ph-collab-mode-tab ${currentMode === 'join' ? 'ph-collab-mode-tab--active' : ''}`}
      onClick={() => onSelectMode('collab-join')}
    >
      <IconUsers width={14} height={14} />
      <span>加入房间</span>
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={currentMode === 'host-existing'}
      aria-label="切换到主持已有剧本"
      className={`ph-collab-mode-tab ${currentMode === 'host-existing' ? 'ph-collab-mode-tab--active' : ''}`}
      onClick={() => onSelectMode('collab-host-existing')}
    >
      <IconFolder width={14} height={14} />
      <span>主持已有剧本</span>
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={currentMode === 'host-new'}
      aria-label="切换到主持新剧本"
      className={`ph-collab-mode-tab ${currentMode === 'host-new' ? 'ph-collab-mode-tab--active' : ''}`}
      onClick={() => onSelectMode('collab-host-new')}
    >
      <IconPlus width={14} height={14} />
      <span>主持新剧本</span>
    </button>
  </div>
);


const formatRecentTime = (iso: string) => {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return '';
  return time.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  });
};

const webgalScriptListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
};

const webgalScriptItemStyle: React.CSSProperties = {
  minWidth: 0,
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 8,
  minHeight: 38,
  padding: '4px 8px',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-secondary)',
};

const webgalScriptOrderStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '50%',
  background: 'var(--accent-glow)',
  color: 'var(--accent-primary)',
  fontSize: 10,
  fontWeight: 800,
  flexShrink: 0,
};

const webgalScriptNameTextStyle: React.CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-primary)',
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
};

const tinyButtonStyle: React.CSSProperties = {
  minHeight: 28,
  padding: '2px 8px',
  fontSize: 11,
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="ph-field">
    <span className="ph-field-label">{label}</span>
    {children}
  </label>
);

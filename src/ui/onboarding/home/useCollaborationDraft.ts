import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { validateVideoFormat, type ProjectVideoFormat } from '../../../api/types/video-format';
import type { ProjectHomeProps } from '../ProjectHome';
import { buildProjectPath } from './buildProjectPath';

type Options = Pick<ProjectHomeProps,
  'defaultProjectName'
  | 'defaultProjectLocation'
  | 'collaborationEndpoint'
  | 'collaborationDisplayName'
  | 'onBrowseCreateLocation'
  | 'onBrowseCollaborationDirectory'
  | 'onHostNewCollaboration'
  | 'onHostExistingCollaboration'
  | 'onJoinCollaboration'
> & {
  isSubmitting: boolean;
  setIsSubmitting: Dispatch<SetStateAction<boolean>>;
  videoFormat: ProjectVideoFormat;
  setVideoFormat: Dispatch<SetStateAction<ProjectVideoFormat>>;
};

export function useCollaborationDraft({
  defaultProjectName,
  defaultProjectLocation,
  collaborationEndpoint,
  collaborationDisplayName,
  onBrowseCreateLocation,
  onBrowseCollaborationDirectory,
  onHostNewCollaboration,
  onHostExistingCollaboration,
  onJoinCollaboration,
  isSubmitting,
  setIsSubmitting,
  videoFormat,
  setVideoFormat,
}: Options) {
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
  const [copiedServerField, setCopiedServerField] = useState<string | null>(null);
  const [showServerDetails, setShowServerDetails] = useState(false);
  const [showHostPassword, setShowHostPassword] = useState(false);
  const [showJoinPassword, setShowJoinPassword] = useState(false);
  const [showServerPassword, setShowServerPassword] = useState(false);

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

  const videoFormatError = validateVideoFormat(videoFormat);
  useEffect(() => {
    setHostProjectName(`${defaultProjectName} 协作`);
  }, [defaultProjectName]);

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

  const parseCollaborationPort = () => {
    const port = Number(collaborationPort);
    return Number.isFinite(port) && port > 0 ? Math.floor(port) : 12345;
  };

  const handleHostNew = async () => {
    const trimmedName = hostProjectName.trim();
    const trimmedRootPath = hostProjectRootPath.trim().replace(/[\\/]+$/, '');
    if (!trimmedName || !trimmedRootPath || isSubmitting || videoFormatError) return;

    setIsSubmitting(true);
    try {
      await onHostNewCollaboration({
        name: trimmedName,
        rootPath: trimmedRootPath,
        videoFormat,
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

  return {
    hostProjectName,
    hostProjectRootPath,
    setHostProjectRootPath,
    setIsHostRootPathDirty,
    joinEndpoint,
    setJoinEndpoint,
    collaborationName,
    setCollaborationName,
    collaborationPort,
    setCollaborationPort,
    allowNetwork,
    setAllowNetwork,
    hostPassword,
    setHostPassword,
    joinPassword,
    setJoinPassword,
    joinRootPath,
    setJoinRootPath,
    setIsJoinRootPathDirty,
    copiedServerField,
    showServerDetails,
    setShowServerDetails,
    showHostPassword,
    setShowHostPassword,
    showJoinPassword,
    setShowJoinPassword,
    showServerPassword,
    setShowServerPassword,
    handleCopyServerInfo,
    videoFormatError,
    handleHostNameChange,
    handleBrowseHostLocation,
    handleBrowseJoinLocation,
    handleHostNew,
    handleHostExisting,
    handleJoinCollaboration,
    isSubmitting,
    videoFormat,
    setVideoFormat,
  };
}

export type CollaborationDraft = ReturnType<typeof useCollaborationDraft>;

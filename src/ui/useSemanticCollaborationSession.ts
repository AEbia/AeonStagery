import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CollaborationConnectionStatus,
  CollaborationIdentity,
  CollaborationPresencePatchV2,
  CollaborationPresencePeerV2,
  CollaborativeAssetManifest,
} from '../api/types/collaboration';
import type { ProjectState } from '../api/types/project';
import type { BootstrapContext } from '../engine/Bootstrapper';
import type { SceneDocumentV5 } from '../api/types/semantic-scene';
import {
  createAssetHandshakeState,
  createEmptyAssetHandshakeState,
  getCollaborativeAssetManifestAgreementSignature,
  type CollaborationAssetAgreementItemPlan,
  type CollaborationAssetAgreementProposal,
  type CollaborationAssetHandshakeDirection,
  type CollaborationAssetHandshakeStatus,
  type CollaborationAssetHandshakeState,
} from '../services/collaboration/CollaborationAssetHandshake';
import type { CollaborativeAssetTransferProgress } from '../services/collaboration/CollaborativeAssetTransfer';
import { CollaborativeAssetManifestBuilder, hasUnchangedCollaborativeSceneDocumentV5AssetReferences } from '../services/collaboration/CollaborativeAssetManifestBuilder';
import { CollaborativeAssetReadinessGate } from '../services/collaboration/CollaborativeAssetReadinessGate';
import { CollaborativeAssetUploader } from '../services/collaboration/CollaborativeAssetUploader';
import { CollaborativeAssetDownloader } from '../services/collaboration/CollaborativeAssetDownloader';
import { CollaborationClientV3 } from '../services/collaboration/CollaborationClientV3';
import {
  CollaborationClientCustomMotionEditLeaseGate,
  type CustomMotionEditLeaseGate,
} from '../services/timeline-authoring/CustomMotionEditLeaseGate';
import { CollaborativeDocumentLayerV3 } from '../services/collaboration/CollaborativeDocumentLayerV3';
import { CollaborativeSessionOrchestratorV3 } from '../services/collaboration/CollaborativeSessionOrchestratorV3';
import {
  CollaborativeResourceAgreementAdapter,
  CollaborativeServerSceneAgreementAdapterV3,
  CollaborativeServerSceneSafetyPathAdapterV3,
  type CollaborativeServerSceneAgreementRequestV3,
} from '../services/collaboration/CollaborativeAgreementAdapters';
import {
  CollaborativeSceneAdmissionGate,
} from '../services/collaboration/CollaborativeSceneAdmissionGate';
import {
  reducePresenceMessage,
} from '../services/collaboration/CollaborationPresence';
import { deriveCollaborationResourceUx } from '../services/collaboration/CollaborationResourceUxModel';
import { deriveCollaborationStatusUx } from '../services/collaboration/CollaborationStatusUxModel';
import { useEditorSelection } from './store/storeHooks';
import { showToast } from './Toast';

export type CollaborationStartMode = 'host-or-join' | 'host' | 'join-existing';

export interface CollaborationStartOptions {
  endpoint?: string;
  displayName?: string;
  project?: ProjectState | null;
}

export interface ResourceAgreementDialogState {
  proposal: CollaborationAssetAgreementProposal;
  title: string;
  message: string;
}

export type SemanticServerSceneAgreementDialogState = CollaborativeServerSceneAgreementRequestV3;

export interface SemanticCollaborationSessionController {
  endpoint: string;
  setEndpoint: (endpoint: string) => void;
  displayName: string;
  setDisplayName: (displayName: string) => void;
  lastError: string | null;
  assetHandshake: CollaborationAssetHandshakeState;
  resourceAgreement: ResourceAgreementDialogState | null;
  lastResourceAgreementProposal: CollaborationAssetAgreementProposal | null;
  serverSceneAgreement: SemanticServerSceneAgreementDialogState | null;
  isRefreshingResources: boolean;
  isResourceTransferActive: boolean;
  isBusy: boolean;
  isConnected: boolean;
  isOffline: boolean;
  statusHint: string;
  selfIdentity: CollaborationIdentity | null;
  connectCurrentProject: () => Promise<boolean>;
  hostCurrentScene: (options?: CollaborationStartOptions) => Promise<boolean>;
  joinExistingRoom: (options?: CollaborationStartOptions) => Promise<boolean>;
  retryConnection: () => void;
  refreshCollaborativeResources: () => Promise<void>;
  disconnect: () => void;
  completeResourceAgreement: (confirmed: boolean) => void;
  completeServerSceneAgreement: (confirmed: boolean) => void;
  cancelResourceTransfer: () => void;
}

export const STATUS_LABELS: Record<CollaborationConnectionStatus, string> = {
  disconnected: '未连接',
  connecting: '连接中',
  reconnecting: '正在重连',
  connected: '已连接',
  offline: '已断开',
  seeding: '准备协作',
  error: '连接异常',
};

export function getCollaborationStatusHint(
  status: CollaborationConnectionStatus,
  assetHandshake: CollaborationAssetHandshakeState,
): string {
  return deriveCollaborationStatusUx({ status, assetHandshake }).detail;
}

function readStoredInput(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return window.localStorage.getItem(key) || fallback;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createClientId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `client_${crypto.randomUUID()}`;
  return `client_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export type SelectedActionIdCollection = Iterable<string> | Readonly<Record<string, boolean>> | null | undefined;

function isIterableSelection(value: unknown): value is Iterable<unknown> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

export function actionIdListFromSelection(selection: SelectedActionIdCollection): string[] {
  if (!selection) return [];
  if (isIterableSelection(selection)) {
    return Array.from(selection).filter((id): id is string => typeof id === 'string' && id.length > 0);
  }
  return Object.entries(selection)
    .filter(([, selected]) => selected)
    .map(([id]) => id);
}

function sourceLocatorsForActionIds(
  contextValue: BootstrapContext,
  actionIds: SelectedActionIdCollection,
): Array<{ statementId: string; companionId?: string }> {
  const compiled = contextValue.stores.document.getCompiledSceneSnapshot();
  const wanted = new Set(actionIdListFromSelection(actionIds));
  const locators: Array<{ statementId: string; companionId?: string }> = [];
  for (const action of compiled?.actions ?? []) {
    if (!wanted.has(action.id)) continue;
    locators.push({
      statementId: action.source.statementId,
      ...(action.source.companionId ? { companionId: action.source.companionId } : {}),
    });
  }
  return locators;
}

export function buildSemanticCollaborationPresencePatch(input: {
  selectedStatementIds: string[];
  currentPlayheadTime: number;
  patch?: Partial<CollaborationPresencePatchV2>;
}): CollaborationPresencePatchV2 {
  const patch = input.patch ?? {};
  const hasPointerPatch = Object.prototype.hasOwnProperty.call(patch, 'pointer');
  return {
    selectedStatementIds: input.selectedStatementIds,
    editingTarget: patch.editingTarget ?? null,
    playheadTime: patch.playheadTime ?? input.currentPlayheadTime,
    ...(hasPointerPatch ? { pointer: patch.pointer ?? null } : {}),
  };
}

export function normalizePresencePlayheadTime(time: number): number {
  if (!Number.isFinite(time) || time < 0) return 0;
  return Math.round(time * 10) / 10;
}

export function shouldPublishPresencePlayhead(input: {
  previous: { time: number; sentAt: number } | null;
  nextTime: number;
  now: number;
}): boolean {
  if (!input.previous) return true;
  return Math.abs(input.nextTime - input.previous.time) >= 0.1
    || input.now - input.previous.sentAt >= 1000;
}

function getDefaultSceneRelativePath(project: ProjectState): string {
  const sceneEntry = project.metadata.scenes.find((scene) => scene.id === project.metadata.defaultSceneId)
    ?? project.metadata.scenes[0];
  return sceneEntry?.path || 'project/main.scene.json';
}

function collectBlockingAssetIssues(proposal: CollaborationAssetAgreementProposal | undefined): string[] {
  if (!proposal) return [];
  const issues: string[] = [];
  for (const item of proposal.items) {
    if (item.problem?.severity === 'blocking') {
      issues.push(`${item.projectRelativePath}: ${item.problem.message}`);
    }
    for (const filePlan of item.filePlans ?? []) {
      if (filePlan.problem?.severity === 'blocking') {
        issues.push(`${filePlan.relativePath}: ${filePlan.problem.message}`);
      }
    }
  }
  return issues;
}

export function itemPlansFromAgreementProposal(
  proposal: CollaborationAssetAgreementProposal | undefined,
): Record<string, CollaborationAssetAgreementItemPlan> | undefined {
  if (!proposal) return undefined;
  const plans: Record<string, CollaborationAssetAgreementItemPlan> = {};
  for (const item of proposal.items) {
    if (!item.operation && !item.problem && !item.filePlans) continue;
    plans[item.assetKey] = {
      sourceKind: item.sourceKind ?? 'unknown',
      operation: item.operation ?? (item.problem ? 'blocked' : 'reuse'),
      ...(item.problem ? { problem: item.problem } : {}),
      ...(item.filePlans ? { filePlans: item.filePlans } : {}),
    };
  }
  return plans;
}

export function useSemanticCollaborationSession({
  contextValue,
  currentProject,
  status,
  peers,
  onStatusChange,
  onSelfChange,
  onPeersChange,
  onPresencePublisherChange,
  onLeaseGateChange,
}: {
  contextValue: BootstrapContext;
  currentProject: ProjectState | null;
  status: CollaborationConnectionStatus;
  peers: CollaborationPresencePeerV2[];
  onStatusChange: (status: CollaborationConnectionStatus) => void;
  onSelfChange: (self: CollaborationIdentity | null) => void;
  onPeersChange: (peers: CollaborationPresencePeerV2[]) => void;
  onPresencePublisherChange?: (publisher: ((patch?: Partial<CollaborationPresencePatchV2>) => void) | null) => void;
  onLeaseGateChange?: (gate: CustomMotionEditLeaseGate | null) => void;
}): SemanticCollaborationSessionController {
  const [endpoint, setEndpoint] = useState(() => readStoredInput('aeonstagery.collaboration.endpoint', '127.0.0.1:12345'));
  const [displayName, setDisplayName] = useState(() => readStoredInput('aeonstagery.collaboration.displayName', '导演'));
  const [lastError, setLastError] = useState<string | null>(null);
  const [assetHandshake, setAssetHandshake] = useState(() => createEmptyAssetHandshakeState());
  const [resourceAgreement, setResourceAgreement] = useState<ResourceAgreementDialogState | null>(null);
  const [lastResourceAgreementProposal, setLastResourceAgreementProposal] = useState<CollaborationAssetAgreementProposal | null>(null);
  const [serverSceneAgreement, setServerSceneAgreement] = useState<SemanticServerSceneAgreementDialogState | null>(null);
  const [isRefreshingResources, setIsRefreshingResources] = useState(false);
  const { selectedActionIds } = useEditorSelection();
  const layerRef = useRef<CollaborativeDocumentLayerV3 | null>(null);
  const clientRef = useRef<CollaborationClientV3 | null>(null);
  const leaseGateRef = useRef<CollaborationClientCustomMotionEditLeaseGate | null>(null);
  const gateRef = useRef<CollaborativeAssetReadinessGate | null>(null);
  const resourceAgreementRef = useRef<CollaborativeResourceAgreementAdapter | null>(null);
  const serverSceneAgreementRef = useRef<CollaborativeServerSceneAgreementAdapterV3 | null>(null);
  const unsubscribePresenceRef = useRef<(() => void) | null>(null);
  const peersV2Ref = useRef<CollaborationPresencePeerV2[]>([]);
  const selectedActionIdsRef = useRef<SelectedActionIdCollection>(selectedActionIds);
  const selfRef = useRef<CollaborationIdentity | null>(null);
  const forceResourceRefreshRef = useRef(false);
  const remoteTargetScenePathRef = useRef<string | undefined>(undefined);
  const lastPublishedPlayheadRef = useRef<{ time: number; sentAt: number } | null>(null);

  useEffect(() => { selectedActionIdsRef.current = selectedActionIds; }, [selectedActionIds]);
  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem('aeonstagery.collaboration.endpoint', endpoint);
  }, [endpoint]);
  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem('aeonstagery.collaboration.displayName', displayName);
  }, [displayName]);

  const isBusy = status === 'connecting' || status === 'seeding';
  const isConnected = status === 'connected';
  const isOffline = status === 'offline';
  const isResourceTransferActive = assetHandshake.status === 'uploading'
    || assetHandshake.status === 'downloading'
    || assetHandshake.status === 'preparing';
  const statusHint = useMemo(() => deriveCollaborationStatusUx({
    status,
    assetHandshake,
    lastError,
    self: selfRef.current,
    peers,
  }).detail, [assetHandshake, lastError, peers, status]);

  const showAssetHandshake = useCallback((
    manifest: CollaborativeAssetManifest | undefined,
    handshakeStatus: CollaborationAssetHandshakeStatus,
    direction: CollaborationAssetHandshakeDirection,
    error?: string,
    proposal?: CollaborationAssetAgreementProposal,
    transfer?: CollaborativeAssetTransferProgress,
  ) => {
    const itemPlans = itemPlansFromAgreementProposal(proposal);
    const nextHandshake = createAssetHandshakeState(manifest, handshakeStatus, direction, {
      error,
      transfer,
      itemPlans,
    });
    setAssetHandshake(nextHandshake);
    if (proposal && handshakeStatus === 'verified') {
      setLastResourceAgreementProposal(proposal);
      const ux = deriveCollaborationResourceUx(
        nextHandshake,
        { proposal },
      );
      showToast(ux.riskSummary.hasOnlyReuse ? '协作资源已校验，无需额外同步' : ux.headline, 'success');
    }
  }, []);

  const disconnect = useCallback(() => {
    gateRef.current?.cancelActiveTransfer();
    leaseGateRef.current?.dispose();
    leaseGateRef.current = null;
    onLeaseGateChange?.(null);
    resourceAgreementRef.current?.cancelPending();
    serverSceneAgreementRef.current?.reset();
    unsubscribePresenceRef.current?.();
    unsubscribePresenceRef.current = null;
    layerRef.current?.dispose();
    clientRef.current = null;
    layerRef.current = null;
    gateRef.current = null;
    resourceAgreementRef.current = null;
    serverSceneAgreementRef.current = null;
    peersV2Ref.current = [];
    selfRef.current = null;
    remoteTargetScenePathRef.current = undefined;
    setResourceAgreement(null);
    setLastResourceAgreementProposal(null);
    setServerSceneAgreement(null);
    setAssetHandshake(createEmptyAssetHandshakeState());
    setLastError(null);
    onSelfChange(null);
    onPeersChange([]);
    onPresencePublisherChange?.(null);
    onStatusChange('disconnected');
  }, [onLeaseGateChange, onPeersChange, onPresencePublisherChange, onSelfChange, onStatusChange]);

  const publishPresence = useCallback((patch: Partial<CollaborationPresencePatchV2> = {}) => {
    if (status !== 'connected') return;
    const locators = sourceLocatorsForActionIds(contextValue, selectedActionIdsRef.current);
    const selectedStatementIds = [...new Set(locators.map((locator) => locator.statementId))];
    const semanticPatch = buildSemanticCollaborationPresencePatch({
      selectedStatementIds,
      currentPlayheadTime: contextValue.adapters.playback.getCurrentTime(),
      patch,
    });
    clientRef.current?.updatePresence(semanticPatch);
  }, [contextValue, status]);

  useEffect(() => {
    lastPublishedPlayheadRef.current = null;
    if (status !== 'connected') return undefined;

    const publishPlayhead = (time: number) => {
      const nextTime = normalizePresencePlayheadTime(time);
      const now = Date.now();
      if (!shouldPublishPresencePlayhead({
        previous: lastPublishedPlayheadRef.current,
        nextTime,
        now,
      })) {
        return;
      }
      lastPublishedPlayheadRef.current = { time: nextTime, sentAt: now };
      publishPresence({ playheadTime: nextTime });
    };

    publishPlayhead(contextValue.adapters.playback.getCurrentTime());
    return contextValue.adapters.playback.subscribeTime(publishPlayhead);
  }, [contextValue.adapters.playback, publishPresence, status]);

  useEffect(() => {
    if (status !== 'connected') {
      onPresencePublisherChange?.(null);
      return;
    }
    onPresencePublisherChange?.(publishPresence);
    publishPresence();
    return () => onPresencePublisherChange?.(null);
  }, [onPresencePublisherChange, publishPresence, selectedActionIds, status]);

  const startSession = useCallback(async (
    mode: CollaborationStartMode,
    options: CollaborationStartOptions = {},
  ): Promise<boolean> => {
    const cleanEndpoint = (options.endpoint ?? endpoint).trim();
    const project = options.project ?? currentProject;
    const fileAccess = contextValue.services.fileAccess;
    const projectResources = contextValue.services.projectResources;
    const rawDocument = contextValue.stores.document.getCurrentSceneDocumentSnapshot();
    if (!cleanEndpoint) { showToast('请输入协作服务器 IP 和端口', 'warning'); return false; }
    if (!project) { showToast('请先创建或打开一个项目', 'warning'); return false; }
    if (!fileAccess || !projectResources || !rawDocument) {
      showToast('当前运行环境缺少语义场景或协作素材能力', 'error');
      return false;
    }

    const admissionGate = new CollaborativeSceneAdmissionGate();
    const admissionOutcome = admissionGate.checkAdmission(rawDocument);
    if (!admissionOutcome.ok) {
      const message = `无法进入协作: ${admissionOutcome.reason}`;
      setLastError(admissionOutcome.reason);
      showToast(message, 'error');
      return false;
    }

    disconnect();
    onStatusChange('connecting');
    const self = {
      clientId: createClientId(),
      displayName: (options.displayName ?? displayName).trim() || '导演',
    };
    selfRef.current = self;
    onSelfChange(self);
    setEndpoint(cleanEndpoint);
    if (options.displayName !== undefined) setDisplayName(options.displayName);
    setLastError(null);

    const client = new CollaborationClientV3({ endpoint: cleanEndpoint, identity: self });
    const leaseClient = client as unknown as {
      subscribeLease?: unknown;
      acquireLease?: unknown;
      renewLease?: unknown;
      releaseLease?: unknown;
    };
    const leaseGate = typeof leaseClient.subscribeLease === 'function'
      && typeof leaseClient.acquireLease === 'function'
      && typeof leaseClient.renewLease === 'function'
      && typeof leaseClient.releaseLease === 'function'
      ? new CollaborationClientCustomMotionEditLeaseGate(client)
      : null;
    leaseGateRef.current = leaseGate;
    onLeaseGateChange?.(leaseGate);
    const resourceAgreement = new CollaborativeResourceAgreementAdapter({
      show: (request) => setResourceAgreement(request),
      clear: () => setResourceAgreement(null),
    });
    resourceAgreementRef.current = resourceAgreement;
    const serverSceneAgreement = new CollaborativeServerSceneAgreementAdapterV3({
      presenter: {
        show: (request) => setServerSceneAgreement(request),
        clear: () => setServerSceneAgreement(null),
      },
      safetyPaths: new CollaborativeServerSceneSafetyPathAdapterV3({
        fileAccess,
        projectResources,
        targetSceneRelativePath: getDefaultSceneRelativePath(project),
      }),
      getLocalDocument: () => {
        const snap = contextValue.stores.document.getCurrentSceneDocumentSnapshot();
        return (snap && snap.schemaVersion === 5) ? snap as SceneDocumentV5 : null;
      },
      onAcceptedTargetScenePath: (path) => {
        remoteTargetScenePathRef.current = path;
      },
    });
    serverSceneAgreementRef.current = serverSceneAgreement;
    const manifestBuilder = new CollaborativeAssetManifestBuilder({ fileAccess, projectResources });
    const gate = new CollaborativeAssetReadinessGate({
      fileAccess,
      projectResources,
      sceneProjectizer: contextValue.services.sceneAssets,
      manifestBuilder,
      manifestReuseChecker: {
        hasUnchangedReferences: () => false,
        hasUnchangedSceneDocumentV5References: (document, previousManifest) => (
          hasUnchangedCollaborativeSceneDocumentV5AssetReferences(document, previousManifest, { fileAccess, projectResources })
        ),
      },
      uploader: new CollaborativeAssetUploader({ fileAccess, projectResources, client }),
      downloader: new CollaborativeAssetDownloader({ fileAccess, projectResources, client }),
      confirmAgreement: async (request) => resourceAgreement.request(request),
      onHandshake: (event) => showAssetHandshake(event.manifest, event.status, event.direction, event.error, event.proposal, event.transfer),
    });
    gateRef.current = gate;
    clientRef.current = client;
    unsubscribePresenceRef.current = client.subscribePresence((message) => {
      peersV2Ref.current = reducePresenceMessage(peersV2Ref.current, message, self.clientId);
      onPeersChange(peersV2Ref.current);
    });
    const orchestrator = new CollaborativeSessionOrchestratorV3(admissionGate);
    const collaborationProjectId = project.metadata.projectId;
    const roomId = `${collaborationProjectId}:main`;
    try {
      const layer = await orchestrator.start({
        endpoint: cleanEndpoint,
        identity: self,
        client,
        documentStore: contextValue.stores.document,
        coordinator: contextValue.services.semanticDocument,
        collaborationProjectId,
        roomId,
        allowSeed: mode !== 'join-existing',
        prepareSeedState: async (document) => {
          const result = await gate.prepareLocalPublishV5({
            document,
            previousManifest: {},
            reason: 'initial-host',
            forceAgreement: true,
            title: '确认本地协作资源',
            message: '这些项目资源文件将作为本次协作房间的资源约定。',
          });
          return { document: result.document, assets: result.assets };
        },
        prepareLocalState: async (document, previousState) => {
          const result = await gate.prepareLocalPublishV5({
            document,
            previousManifest: previousState.assets,
            reason: forceResourceRefreshRef.current ? 'manual-refresh' : 'local-asset-changed',
            forceAgreement: forceResourceRefreshRef.current,
            title: '确认本地协作资源',
            message: '项目资源将按当前语义场景 source facts 同步到协作房间。',
          });
          return { document: result.document, assets: result.assets };
        },
        beforeApplyState: async (state, applyOptions) => {
          let acceptedJoinProposal: CollaborationAssetAgreementProposal | undefined;
          if (applyOptions.requireServerSceneAgreement && !serverSceneAgreement.hasAcceptedServerScene) {
            acceptedJoinProposal = await gate.buildAgreementProposal(
              state.assets ?? {},
              'remote',
              'join-room',
            );
            await serverSceneAgreement.request(state, {
              assetAgreementProposal: acceptedJoinProposal,
              blockingIssues: collectBlockingAssetIssues(acceptedJoinProposal),
            });
          }

          if (!applyOptions.prepareAssets || !state.assets || Object.keys(state.assets).length === 0) {
            gate.reset('remote');
          } else {
            await gate.prepareRemoteApply({
              manifest: state.assets,
              reason: 'join-room',
              title: '确认服务器协作资源',
              message: '加入房间前需要确认服务器约定的项目资源文件。',
              acceptedProposal: acceptedJoinProposal,
            });
          }
        },
        getApplyScenePath: () => remoteTargetScenePathRef.current,
        afterApplyState: async (_state, document, path) => {
          const targetPath = path ?? remoteTargetScenePathRef.current;
          if (!targetPath) return;
          try {
            const committedPaths = await serverSceneAgreement.commitAcceptedServerDocument(document);
            if (committedPaths) return;
          } catch (error) {
            throw new Error(`协作保存错误: ${formatError(error)}`);
          }
          if (contextValue.services.sceneFile.saveCurrentSceneDocument) {
            const result = await contextValue.services.sceneFile.saveCurrentSceneDocument(document as any, targetPath);
            if (!result.success) {
              throw new Error(`协作保存错误: ${'error' in result ? result.error : '未知错误'}`);
            }
            return;
          }
          try {
            await fileAccess.writeFile(targetPath, JSON.stringify(document, null, 2));
          } catch (error) {
            throw new Error(`协作保存错误: ${formatError(error)}`);
          }
        },
        onStatusChange: (nextStatus) => {
          onStatusChange(nextStatus);
          if (nextStatus === 'connected') setLastError(null);
        },
        onSynchronizedState: () => contextValue.stores.editor._setSaveStatus('idle'),
        onError: (error) => {
          const message = formatError(error);
          setLastError(message);
          showToast(`协作同步失败: ${message}`, 'error');
        },
      });
      layerRef.current = layer;
      showToast('已连接语义协作房间', 'success');
      return true;
    } catch (error) {
      const message = formatError(error);
      setLastError(message);
      unsubscribePresenceRef.current?.();
      unsubscribePresenceRef.current = null;
      client.dispose();
      leaseGate?.dispose();
      leaseGateRef.current = null;
      onLeaseGateChange?.(null);
      clientRef.current = null;
      layerRef.current = null;
      gateRef.current = null;
      resourceAgreementRef.current = null;
      serverSceneAgreementRef.current?.reset();
      serverSceneAgreementRef.current = null;
      remoteTargetScenePathRef.current = undefined;
      setServerSceneAgreement(null);
      onSelfChange(null);
      onPeersChange([]);
      onStatusChange('error');
      showToast(`协作连接失败: ${message}`, 'error');
      return false;
    }
  }, [contextValue, currentProject, disconnect, displayName, endpoint, onLeaseGateChange, onPeersChange, onSelfChange, onStatusChange, showAssetHandshake]);

  const refreshCollaborativeResources = useCallback(async () => {
    if (!layerRef.current || status !== 'connected') return;
    forceResourceRefreshRef.current = true;
    setIsRefreshingResources(true);
    try {
      await layerRef.current.publishCurrentSceneNow(true);
      showToast('已请求重新校验协作资源', 'success');
    } catch (error) {
      setLastError(formatError(error));
    } finally {
      forceResourceRefreshRef.current = false;
      setIsRefreshingResources(false);
    }
  }, [status]);

  const completeResourceAgreement = useCallback((confirmed: boolean) => {
    resourceAgreementRef.current?.complete(confirmed);
  }, []);

  const completeServerSceneAgreement = useCallback((confirmed: boolean) => {
    serverSceneAgreementRef.current?.complete(confirmed);
  }, []);

  const retryConnection = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;
    setLastError(null);
    client.reconnectRealtime();
  }, []);

  useEffect(() => () => {
    unsubscribePresenceRef.current?.();
    unsubscribePresenceRef.current = null;
    layerRef.current?.dispose();
    clientRef.current?.dispose();
    leaseGateRef.current?.dispose();
  }, []);

  return {
    endpoint,
    setEndpoint,
    displayName,
    setDisplayName,
    lastError,
    assetHandshake,
    resourceAgreement,
    lastResourceAgreementProposal,
    serverSceneAgreement,
    isRefreshingResources,
    isResourceTransferActive,
    isBusy,
    isConnected,
    isOffline,
    statusHint,
    selfIdentity: selfRef.current,
    connectCurrentProject: () => startSession('host-or-join'),
    hostCurrentScene: (options?: CollaborationStartOptions) => startSession('host', options),
    joinExistingRoom: (options?: CollaborationStartOptions) => startSession('join-existing', options),
    retryConnection,
    refreshCollaborativeResources,
    disconnect,
    completeResourceAgreement,
    completeServerSceneAgreement,
    cancelResourceTransfer: () => gateRef.current?.cancelActiveTransfer(),
  };
}

export { getCollaborativeAssetManifestAgreementSignature };

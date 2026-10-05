import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CollaborationConnectionStatus,
  CollaborationPresencePeerV2,
} from '../api/types/collaboration';
import type { ProjectState } from '../api/types/project';
import type { CurrentSceneDocument, SceneDocumentV5 } from '../api/types/semantic-scene';
import {
  createHandshakeReviewProposal,
  formatAssetHandshakeBytes,
} from '../services/collaboration/CollaborationAssetHandshake';
import {
  getPeerPresenceFacts,
  summarizePeerPresence,
} from '../services/collaboration/CollaborationPresence';
import { deriveCollaborationResourceUx } from '../services/collaboration/CollaborationResourceUxModel';
import { deriveCollaborationStatusUx } from '../services/collaboration/CollaborationStatusUxModel';
import { IconCheck, IconCopy, IconEye, IconEyeOff, IconUsers, IconX } from './icons';
import { CollaborationAssetHandshakePanel } from './CollaborationAssetHandshakePanel';
import { CollaborationResourceAgreementDialog } from './CollaborationResourceAgreementDialog';
import { CollaborationServerSceneAgreementDialogV2 } from './CollaborationServerSceneAgreementDialogV2';
import { withCollaborationAccessToken } from '../services/collaboration/CollaborationTransport';
import { useOutsidePointerDown } from './hooks/useOutsidePointerDown';
import type { SemanticCollaborationSessionController } from './useSemanticCollaborationSession';

export {
  derivePresencePatchFromSelection,
  getPeerPresenceFacts,
  getPeersEditingLocator,
  reducePresenceMessage,
  summarizeLocatorEditingPeers,
  summarizePeerPresence,
} from '../services/collaboration/CollaborationPresence';

export {
  getCollaborationStatusHint,
  getCollaborativeAssetManifestAgreementSignature,
} from './useSemanticCollaborationSession';

export interface CollaborationServerCredentials {
  connectionPassword?: string;
  accessToken?: string;
  inviteUrls?: string[];
  localUrl?: string;
  lanUrls?: string[];
  serverAddress?: string;
}

interface CollaborationConnectPanelProps {
  currentProject: ProjectState | null;
  sceneDocument: CurrentSceneDocument | SceneDocumentV5 | null;
  status: CollaborationConnectionStatus;
  peers: CollaborationPresencePeerV2[];
  controller: SemanticCollaborationSessionController;
  serverCredentials?: CollaborationServerCredentials | null;
  disabled?: boolean;
}

type CollaborationTab = 'status' | 'members' | 'resources';

const COLLABORATION_TABS: Array<{ key: CollaborationTab; label: string }> = [
  { key: 'status', label: '状态' },
  { key: 'members', label: '成员' },
  { key: 'resources', label: '资源' },
];

function countSemanticStatements(sceneDocument: CurrentSceneDocument | SceneDocumentV5 | null): string {
  if (!sceneDocument) return '无本地场景';
  return `${sceneDocument.statements.length} 个语义语句`;
}

function formatPeerPing(pingMs: number | undefined): string {
  return typeof pingMs === 'number' && Number.isFinite(pingMs) && pingMs >= 0
    ? `Ping ${Math.round(pingMs)} ms`
    : 'Ping --';
}

function formatHandshakeStatus(status: string): string {
  const labels: Record<string, string> = {
    idle: '未开始',
    confirming: '等待确认',
    checking: '检查资源',
    preparing: '准备资源',
    downloading: '下载资源',
    uploading: '上传资源',
    verified: '资源已就绪',
    error: '资源异常',
  };
  return labels[status] || status;
}

function CollaborationLedgerRow({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}) {
  return (
    <div className={`collaboration-ledger__row collaboration-ledger__row--${tone}`}>
      <span className="collaboration-ledger__label">{label}</span>
      <span className="collaboration-ledger__value">{value}</span>
      <span className="collaboration-ledger__detail">{detail}</span>
    </div>
  );
}

export function CollaborationConnectPanel({
  currentProject,
  sceneDocument,
  status,
  peers,
  controller,
  serverCredentials,
  disabled,
}: CollaborationConnectPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<CollaborationTab>('status');
  const [isResourceReviewOpen, setIsResourceReviewOpen] = useState(false);
  const [showCredentialPassword, setShowCredentialPassword] = useState(false);
  const [showCredentialToken, setShowCredentialToken] = useState(false);
  const [copiedCredentialField, setCopiedCredentialField] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const isBusy = controller.isBusy;
  const isConnected = controller.isConnected;
  const isOffline = controller.isOffline;
  const lastError = controller.lastError;
  const statusUx = useMemo(() => deriveCollaborationStatusUx({
    status,
    assetHandshake: controller.assetHandshake,
    lastError,
    self: controller.selfIdentity,
    peers,
  }), [controller.assetHandshake, controller.selfIdentity, lastError, peers, status]);
  const handshakeUx = useMemo(() => deriveCollaborationResourceUx(controller.assetHandshake), [controller.assetHandshake]);
  const visiblePeers = peers.slice(0, 5);
  const overflowPeerCount = Math.max(0, peers.length - visiblePeers.length);
  const memberCount = (controller.selfIdentity ? 1 : 0) + peers.length;
  const resourceStats = useMemo(() => {
    const items = controller.assetHandshake.items;
    return {
      assetCount: items.length,
      fileCount: items.reduce((sum, item) => sum + item.fileCount, 0),
      totalSizeBytes: items.reduce((sum, item) => sum + item.totalSizeBytes, 0),
    };
  }, [controller.assetHandshake.items]);
  const transferSummary = useMemo(() => {
    const transfer = controller.assetHandshake.transfer;
    if (!transfer) return formatHandshakeStatus(controller.assetHandshake.status);
    const transferredBytes = transfer.completedBytes + transfer.currentFileBytes;
    const percent = transfer.totalBytes > 0
      ? Math.min(100, Math.round((transferredBytes / transfer.totalBytes) * 100))
      : null;
    return `${formatHandshakeStatus(controller.assetHandshake.status)}${percent === null ? '' : ` · ${percent}%`} · ${formatAssetHandshakeBytes(transferredBytes)} / ${formatAssetHandshakeBytes(transfer.totalBytes)}`;
  }, [controller.assetHandshake]);
  const reviewProposal = controller.lastResourceAgreementProposal
    ?? (controller.assetHandshake.items.length > 0 ? createHandshakeReviewProposal(controller.assetHandshake) : null);

  const roomLabel = useMemo(() => {
    if (!currentProject) return '无项目';
    return `${currentProject.metadata.name} / main`;
  }, [currentProject]);

  const closePanel = useCallback(() => {
    setIsOpen(false);
    setActiveTab('status');
  }, []);
  useOutsidePointerDown(panelRef, closePanel);

  const handleCopyCredential = useCallback(async (text: string, fieldId: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedCredentialField(fieldId);
      setTimeout(() => {
        setCopiedCredentialField((curr) => (curr === fieldId ? null : curr));
      }, 1800);
    } catch {
      // clipboard fallback – silent
    }
  }, []);

  const effectiveServerAddress = serverCredentials?.serverAddress || serverCredentials?.lanUrls?.[0] || serverCredentials?.localUrl;
  const effectiveInviteUrls = useMemo(() => {
    if (serverCredentials?.inviteUrls && serverCredentials.inviteUrls.length > 0) {
      return serverCredentials.inviteUrls;
    }
    if (serverCredentials?.accessToken && (effectiveServerAddress || controller.endpoint)) {
      const base = effectiveServerAddress || controller.endpoint;
      return [withCollaborationAccessToken(base, serverCredentials.accessToken)];
    }
    return [];
  }, [controller.endpoint, effectiveServerAddress, serverCredentials]);

  const hasCredentials = Boolean(
    serverCredentials && (
      effectiveInviteUrls.length > 0
      || serverCredentials.connectionPassword
      || serverCredentials.accessToken
      || effectiveServerAddress
    ),
  );

  const renderCredentials = () => {
    if (!hasCredentials || !serverCredentials) return null;
    return (
      <div className="collaboration-credentials" data-testid="collaboration-credentials">
        {effectiveInviteUrls.length > 0 && (
          <div className="collaboration-credential-row">
            <span className="collaboration-credential-label">邀请链接</span>
            <div className="collaboration-credential-value-row">
              <input
                className="collaboration-credential-input"
                readOnly
                value={effectiveInviteUrls[0]}
                aria-label="协作邀请链接"
              />
              <button
                type="button"
                className="btn btn--sm collaboration-credential-copy"
                onClick={() => { void handleCopyCredential(effectiveInviteUrls[0], 'invite'); }}
                title="复制邀请链接"
              >
                {copiedCredentialField === 'invite' ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
                <span>{copiedCredentialField === 'invite' ? '已复制' : '复制'}</span>
              </button>
            </div>
          </div>
        )}

        {serverCredentials.connectionPassword && (
          <div className="collaboration-credential-row">
            <span className="collaboration-credential-label">房间密码</span>
            <div className="collaboration-credential-value-row">
              <input
                className="collaboration-credential-input"
                type={showCredentialPassword ? 'text' : 'password'}
                readOnly
                value={serverCredentials.connectionPassword}
                aria-label="协作房间密码"
              />
              <button
                type="button"
                className="btn btn--sm collaboration-credential-toggle"
                onClick={() => setShowCredentialPassword((v) => !v)}
                title={showCredentialPassword ? '隐藏密码' : '显示密码'}
                aria-label={showCredentialPassword ? '隐藏密码' : '显示密码'}
              >
                {showCredentialPassword ? <IconEyeOff width={13} height={13} /> : <IconEye width={13} height={13} />}
              </button>
              <button
                type="button"
                className="btn btn--sm collaboration-credential-copy"
                onClick={() => { void handleCopyCredential(serverCredentials.connectionPassword!, 'password'); }}
                title="复制密码"
              >
                {copiedCredentialField === 'password' ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
                <span>{copiedCredentialField === 'password' ? '已复制' : '复制'}</span>
              </button>
            </div>
          </div>
        )}

        {effectiveServerAddress && (
          <div className="collaboration-credential-row">
            <span className="collaboration-credential-label">服务地址</span>
            <div className="collaboration-credential-value-row">
              <input
                className="collaboration-credential-input"
                readOnly
                value={effectiveServerAddress}
                aria-label="协作服务地址"
              />
              <button
                type="button"
                className="btn btn--sm collaboration-credential-copy"
                onClick={() => { void handleCopyCredential(effectiveServerAddress, 'server-address'); }}
                title="复制服务地址"
              >
                {copiedCredentialField === 'server-address' ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
                <span>{copiedCredentialField === 'server-address' ? '已复制' : '复制'}</span>
              </button>
            </div>
          </div>
        )}

        {serverCredentials.accessToken && (
          <div className="collaboration-credential-row">
            <span className="collaboration-credential-label">访问 Token</span>
            <div className="collaboration-credential-value-row">
              <input
                className="collaboration-credential-input"
                type={showCredentialToken ? 'text' : 'password'}
                readOnly
                value={serverCredentials.accessToken}
                aria-label="协作访问 Token"
              />
              <button
                type="button"
                className="btn btn--sm collaboration-credential-toggle"
                onClick={() => setShowCredentialToken((v) => !v)}
                title={showCredentialToken ? '隐藏 Token' : '显示 Token'}
                aria-label={showCredentialToken ? '隐藏 Token' : '显示 Token'}
              >
                {showCredentialToken ? <IconEyeOff width={13} height={13} /> : <IconEye width={13} height={13} />}
              </button>
              <button
                type="button"
                className="btn btn--sm collaboration-credential-copy"
                onClick={() => { void handleCopyCredential(serverCredentials.accessToken!, 'token'); }}
                title="复制 Token"
              >
                {copiedCredentialField === 'token' ? <IconCheck width={12} height={12} /> : <IconCopy width={12} height={12} />}
                <span>{copiedCredentialField === 'token' ? '已复制' : '复制'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement;
    popoverRef.current?.focus({ preventScroll: true });
    return () => {
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

  const resourceBadgeTone = handshakeUx.phase === 'blocked' || handshakeUx.phase === 'failed'
    ? 'danger'
    : handshakeUx.phase === 'needs-review'
      ? 'warning'
      : handshakeUx.phase === 'transferring' || handshakeUx.phase === 'checking'
        ? 'info'
        : null;
  const autoSwitchToResources = handshakeUx.phase === 'blocked'
    || handshakeUx.phase === 'failed'
    || handshakeUx.phase === 'transferring';

  useEffect(() => {
    if (isOpen && autoSwitchToResources && activeTab !== 'resources') {
      setActiveTab('resources');
    }
  }, [activeTab, autoSwitchToResources, isOpen]);

  const handleTabListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const currentIndex = COLLABORATION_TABS.findIndex((tab) => tab.key === activeTab);
    if (currentIndex < 0) return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (currentIndex + direction + COLLABORATION_TABS.length) % COLLABORATION_TABS.length;
    setActiveTab(COLLABORATION_TABS[nextIndex].key);
    const buttons = tabListRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [];
    buttons[nextIndex]?.focus();
  };

  return (
    <div className="collaboration-panel" ref={panelRef}>
      <button
        className={`btn btn--sm collaboration-trigger ${isConnected ? 'collaboration-trigger--connected' : ''}`}
        onClick={() => setIsOpen((open) => !open)}
        disabled={disabled}
        title="协作连接"
        aria-expanded={isOpen}
        aria-controls="collaboration-popover"
        aria-haspopup="dialog"
      >
        <IconUsers width={14} height={14} />
        协作
        <span className={`collaboration-dot collaboration-dot--${status}`} aria-hidden="true" />
        <span className="sr-only">{statusUx.shortLabel}</span>
      </button>

      {isOpen && (
        <div
          ref={popoverRef}
          id="collaboration-popover"
          className="collaboration-popover"
          role="dialog"
          aria-label="实时协作"
          tabIndex={-1}
        >
          <div className="collaboration-popover__header">
            <div>
              <div className="collaboration-popover__title">实时协作</div>
              <div className="collaboration-popover__subtitle">{statusUx.shortLabel} · {roomLabel}</div>
            </div>
            <button className="btn btn--icon collaboration-popover__close" onClick={closePanel} title="关闭" aria-label="关闭">
              <IconX width={14} height={14} />
            </button>
          </div>

          <div
            ref={tabListRef}
            className="collaboration-tabs"
            role="tablist"
            aria-label="协作面板"
            onKeyDown={handleTabListKeyDown}
          >
            {COLLABORATION_TABS.map((tab) => (
              <button
                key={tab.key}
                id={`collaboration-tab-${tab.key}`}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.key}
                aria-controls={`collaboration-tabpanel-${tab.key}`}
                className={`collaboration-tab ${activeTab === tab.key ? 'collaboration-tab--active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
                {tab.key === 'resources' && resourceBadgeTone && (
                  <span
                    className={`collaboration-tab__badge collaboration-tab__badge--${resourceBadgeTone}`}
                    aria-hidden="true"
                  />
                )}
              </button>
            ))}
          </div>

          <div
            id={`collaboration-tabpanel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`collaboration-tab-${activeTab}`}
            className="collaboration-form collaboration-tabpanel"
          >
            {activeTab === 'status' && (
              <>
                <div className={`collaboration-gate collaboration-gate--${status}`} role="status">
                  <strong className="collaboration-gate__title">{statusUx.headline}</strong>
                  {!lastError && <span>{statusUx.detail}</span>}
                </div>

                {renderCredentials()}

                <div className="collaboration-summary">
                  <span>连接目标</span>
                  <strong>{controller.endpoint}</strong>
                </div>
                <div className="collaboration-summary">
                  <span>房间</span>
                  <strong>{roomLabel}</strong>
                </div>
                <div className="collaboration-summary">
                  <span>在线成员</span>
                  <strong>{memberCount} 人</strong>
                </div>
                <div className="collaboration-summary">
                  <span>本地场景</span>
                  <strong>{countSemanticStatements(sceneDocument)}</strong>
                </div>
                <div className="collaboration-summary">
                  <span>协作资源</span>
                  <strong>{resourceStats.assetCount} 个资源 · {resourceStats.fileCount} 个文件 · {formatAssetHandshakeBytes(resourceStats.totalSizeBytes)}</strong>
                </div>
                <div className="collaboration-summary">
                  <span>资源同步</span>
                  <strong>{transferSummary}</strong>
                </div>

                {lastError && (
                  <div className="collaboration-error" title={lastError}>
                    {lastError}
                  </div>
                )}

                {isConnected ? (
                  <button className="btn btn--danger collaboration-submit" onClick={controller.disconnect}>
                    断开连接
                  </button>
                ) : (
                  <div className="collaboration-actions">
                    {isBusy ? (
                      <div className="collaboration-gate collaboration-gate--disconnected" role="note">
                        协作正在处理中。
                      </div>
                    ) : (
                      <>
                        <div className="collaboration-gate collaboration-gate--disconnected" role="note">
                          {status === 'reconnecting'
                            ? '共享编辑已暂停，正在自动重连；恢复同步前不会提交共享编辑。'
                            : isOffline
                              ? '共享编辑已暂停，自动重试次数已用完；可立即重试连接。'
                              : status === 'error'
                                ? controller.selfIdentity
                                  ? '远端协作状态未能在本地解析；自动重试已停止，可手动重试。'
                                  : '连接异常，重新加入请回到首页选择本地协作工作区。'
                                : '加入协作请回到首页选择本地协作工作区。'}
                        </div>
                        {(isOffline || status === 'error') && controller.selfIdentity && (
                          <button className="btn btn--primary collaboration-submit" onClick={controller.retryConnection}>
                            立即重连
                          </button>
                        )}
                        {(isOffline || status === 'error' || status === 'reconnecting') && (
                          <button className="btn btn--danger collaboration-submit" onClick={controller.disconnect}>
                            结束协作
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </>
            )}

            {activeTab === 'members' && (
              <>
                <CollaborationLedgerRow label="成员提示" value={statusUx.presenceFact.label} detail={statusUx.presenceFact.detail} tone={statusUx.presenceFact.tone} />
                <div className="collaboration-peers">
                  <div className="collaboration-peers__header">
                    <span>在线成员</span>
                    <strong>{memberCount}</strong>
                  </div>
                  {controller.selfIdentity && (
                    <div className="collaboration-peer collaboration-peer--self">
                      <span className="collaboration-peer__avatar">{(controller.selfIdentity.displayName.trim() || '我').slice(0, 1)}</span>
                      <span className="collaboration-peer__name">{controller.selfIdentity.displayName} · 你</span>
                      <span className="collaboration-peer__status">本机</span>
                      <span className="collaboration-peer__ping">Ping --</span>
                    </div>
                  )}
                  {peers.length === 0 ? (
                    <div className="collaboration-peers__empty">{controller.selfIdentity ? '只有你在线' : '未加入协作房间'}</div>
                  ) : (
                    <>
                      {visiblePeers.map((peer) => (
                        <div key={peer.clientId} className="collaboration-peer">
                          <span className="collaboration-peer__avatar">{(peer.displayName.trim() || peer.clientId).slice(0, 1)}</span>
                          <span className="collaboration-peer__name">{peer.displayName}</span>
                          <span className="collaboration-peer__status">{summarizePeerPresence(peer)}</span>
                          <span className="collaboration-peer__ping">{formatPeerPing(peer.pingMs)}</span>
                          {getPeerPresenceFacts(peer).length > 0 && (
                            <span className="collaboration-peer__facts">
                              {getPeerPresenceFacts(peer).slice(0, 3).map((fact) => (
                                <span key={fact.key} title={fact.title}>{fact.label}</span>
                              ))}
                            </span>
                          )}
                        </div>
                      ))}
                      {overflowPeerCount > 0 && (
                        <div className="collaboration-peers__empty">另有 {overflowPeerCount} 人在线</div>
                      )}
                    </>
                  )}
                </div>
                {renderCredentials()}
              </>
            )}

            {activeTab === 'resources' && (
              <>
                {!handshakeUx.shouldSurfacePanel && (
                  <CollaborationLedgerRow label="资源约定" value={statusUx.resourceFact.label} detail={statusUx.resourceFact.detail} tone={statusUx.resourceFact.tone} />
                )}

                <CollaborationAssetHandshakePanel
                  state={controller.assetHandshake}
                  onCancelTransfer={controller.isResourceTransferActive ? controller.cancelResourceTransfer : undefined}
                />

                {isConnected && (
                  <div className="collaboration-resource-actions">
                    {reviewProposal && (
                      <button
                        className="btn btn--sm"
                        onClick={() => setIsResourceReviewOpen(true)}
                      >
                        查看同步计划
                      </button>
                    )}
                    <button
                      className="btn btn--sm"
                      onClick={controller.refreshCollaborativeResources}
                      disabled={controller.isRefreshingResources}
                    >
                      {controller.isRefreshingResources ? '正在校验资源' : '重新校验资源'}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {controller.resourceAgreement && (
        <CollaborationResourceAgreementDialog
          proposal={controller.resourceAgreement.proposal}
          title={controller.resourceAgreement.title}
          message={controller.resourceAgreement.message}
          onConfirm={() => controller.completeResourceAgreement(true)}
          onCancel={() => controller.completeResourceAgreement(false)}
        />
      )}

      {isResourceReviewOpen && reviewProposal && (
        <CollaborationResourceAgreementDialog
          proposal={reviewProposal}
          title={controller.lastResourceAgreementProposal ? '协作资源同步计划' : '当前资源同步计划'}
          message={controller.lastResourceAgreementProposal
            ? '这是当前会话最近一次已通过校验的项目资源同步计划，可用于确认下载、上传、复制或替换行为。'
            : '这是当前资源握手的实时快照，只读展示本次会话已约定或正在进行的资源动作。'}
          readOnly
          onCancel={() => setIsResourceReviewOpen(false)}
        />
      )}

      {controller.serverSceneAgreement && (
        <CollaborationServerSceneAgreementDialogV2
          localDocument={controller.serverSceneAgreement.localDocument}
          serverDocument={controller.serverSceneAgreement.serverDocument}
          serverState={controller.serverSceneAgreement.serverState}
          assetAgreementProposal={controller.serverSceneAgreement.assetAgreementProposal}
          blockingIssues={controller.serverSceneAgreement.blockingIssues}
          jsonBackupPath={controller.serverSceneAgreement.jsonBackupPath}
          backupPath={controller.serverSceneAgreement.backupPath}
          targetScenePath={controller.serverSceneAgreement.targetScenePath}
          onConfirm={() => controller.completeServerSceneAgreement(true)}
          onCancel={() => controller.completeServerSceneAgreement(false)}
        />
      )}
    </div>
  );
}

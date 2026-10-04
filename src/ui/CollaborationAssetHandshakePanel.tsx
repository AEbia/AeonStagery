import {
  type CollaborationAssetHandshakeState,
  formatAssetHandshakeBytes,
  formatAssetHandshakeHash,
  getAssetAgreementOperationLabel,
  getAssetHandshakeKindLabel,
  summarizeAssetHandshake,
} from '../services/collaboration/CollaborationAssetHandshake';
import {
  deriveCollaborationResourceUx,
  getCollaborationResourceOperationTone,
  groupAgreementItemsByOperation,
} from '../services/collaboration/CollaborationResourceUxModel';

const STATUS_LABELS: Record<CollaborationAssetHandshakeState['status'], string> = {
  idle: '未开始',
  confirming: '等待确认',
  checking: '检查资源',
  preparing: '准备资源',
  downloading: '下载资源',
  uploading: '上传资源',
  verified: '资源就绪',
  error: '资源异常',
};

const DIRECTION_LABELS: Record<CollaborationAssetHandshakeState['direction'], string> = {
  remote: '服务器资源',
  local: '本地资源',
};

export function CollaborationAssetHandshakePanel({
  state,
  onCancelTransfer,
}: {
  state: CollaborationAssetHandshakeState;
  onCancelTransfer?: () => void;
}) {
  const ux = deriveCollaborationResourceUx(state);
  if (!ux.shouldSurfacePanel) {
    return null;
  }

  const summary = summarizeAssetHandshake(state);
  const operationGroups = groupAgreementItemsByOperation(state.items, state.direction);
  const visibleItems = state.items.slice(0, 4);
  const hiddenCount = Math.max(0, state.items.length - visibleItems.length);
  const transfer = state.transfer;
  const transferredBytes = transfer
    ? transfer.completedBytes + transfer.currentFileBytes
    : 0;
  const transferPercent = transfer && transfer.totalBytes > 0
    ? Math.min(100, Math.round((transferredBytes / transfer.totalBytes) * 100))
    : transfer && transfer.totalFiles > 0
      ? Math.min(100, Math.round((transfer.completedFiles / transfer.totalFiles) * 100))
      : null;
  const currentFilePercent = transfer && transfer.currentFileSizeBytes > 0
    ? Math.min(100, Math.round((transfer.currentFileBytes / transfer.currentFileSizeBytes) * 100))
    : null;
  const canCancelTransfer = !!transfer && (
    state.status === 'uploading'
    || state.status === 'downloading'
    || state.status === 'preparing'
  );

  return (
    <div className={`collaboration-assets collaboration-assets--${state.status} collaboration-assets--ux-${ux.severity}`} data-testid="collaboration-asset-handshake">
      <div className="collaboration-assets__header">
        <span>{ux.headline}</span>
        <strong>{STATUS_LABELS[state.status]}</strong>
      </div>
      <div className="collaboration-assets__detail">{ux.detail}</div>
      <div className="collaboration-assets__meta">
        <span>{DIRECTION_LABELS[state.direction]}</span>
        <span>{summary.assetCount} 个资源</span>
        <span>{summary.fileCount} 个文件</span>
        <span>{formatAssetHandshakeBytes(summary.totalSizeBytes)}</span>
      </div>
      <div className="collaboration-assets__risk">
        <span>{ux.riskSummary.detail}</span>
        <strong>{ux.nextAction}</strong>
      </div>
      {operationGroups.length > 0 && (
        <div className="collaboration-assets__operations" aria-label="资源同步操作摘要">
          {operationGroups.map((group) => (
            <span
              key={group.operation}
              className={`collaboration-assets__operation collaboration-assets__operation--${group.tone}`}
            >
              {group.label} · {group.items.length}
            </span>
          ))}
        </div>
      )}

      {state.error && (
        <div className="collaboration-assets__error" title={state.error}>
          {state.error}
        </div>
      )}

      {transfer && (
        <div className="collaboration-assets__transfer" role="status">
          <div className="collaboration-assets__transfer-row">
            <span title={transfer.currentFilePath}>
              {transfer.currentFilePath || '准备资源传输'}
            </span>
            <strong>
              <span>{state.status === 'uploading' ? '上传' : '下载'}</span>
              {' · '}
              <span>{transferPercent === null ? '准备中' : `${transferPercent}%`}</span>
            </strong>
          </div>
          <div className="collaboration-assets__progress" aria-hidden="true">
            <div
              className={`collaboration-assets__progress-fill${transferPercent === null ? ' collaboration-assets__progress-fill--indeterminate' : ''}`}
              style={transferPercent === null ? undefined : { width: `${transferPercent}%` }}
            />
          </div>
          <div className="collaboration-assets__transfer-row collaboration-assets__transfer-row--meta">
            <span>
              {formatAssetHandshakeBytes(transferredBytes)} / {formatAssetHandshakeBytes(transfer.totalBytes)}
              {' · '}
              {transfer.completedFiles}/{transfer.totalFiles} 文件
              {currentFilePercent === null ? '' : ` · 当前文件 ${currentFilePercent}%`}
            </span>
            {canCancelTransfer && onCancelTransfer && (
              <button className="btn btn--sm" onClick={onCancelTransfer}>
                取消传输
              </button>
            )}
          </div>
        </div>
      )}

      {visibleItems.length > 0 && (
        <div className="collaboration-assets__list">
          {visibleItems.map((item) => (
            <div key={item.assetKey} className="collaboration-assets__item">
              <span className="collaboration-assets__kind">{getAssetHandshakeKindLabel(item.kind)}</span>
              <span className="collaboration-assets__body">
                <span className="collaboration-assets__path" title={item.projectRelativePath}>
                  {item.projectRelativePath}
                </span>
                <span className="collaboration-assets__fingerprint" title={item.contentHash}>
                  {formatAssetHandshakeHash(item.contentHash)} · {item.fileCount} 文件
                </span>
              </span>
              {item.operation && (
                <span className={`collaboration-assets__operation collaboration-assets__operation--${getCollaborationResourceOperationTone(item.operation)}`}>
                  {getAssetAgreementOperationLabel(item.operation, state.direction)}
                </span>
              )}
              <span className="collaboration-assets__size">{formatAssetHandshakeBytes(item.totalSizeBytes)}</span>
            </div>
          ))}
          {hiddenCount > 0 && (
            <div className="collaboration-assets__more">还有 {hiddenCount} 个资源</div>
          )}
        </div>
      )}
    </div>
  );
}

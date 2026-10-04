import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type CollaborationAssetAgreementProposal,
  formatAssetHandshakeBytes,
  getAssetAgreementReasonLabel,
  summarizeAssetHandshake,
} from '../services/collaboration/CollaborationAssetHandshake';
import {
  deriveCollaborationResourceUx,
  groupAgreementItemsByOperation,
} from '../services/collaboration/CollaborationResourceUxModel';
import { IconX } from './icons';
import { useModalDialog } from './hooks/useModalDialog';
import { CollaborationResourcePlanList, hasAgreementItemProblem } from './CollaborationResourcePlanList';

const DIRECTION_LABELS: Record<CollaborationAssetAgreementProposal['direction'], string> = {
  local: '本地资源',
  remote: '服务器资源',
};

export function CollaborationResourceAgreementDialog({
  proposal,
  title,
  message,
  onConfirm,
  onCancel,
  readOnly = false,
}: {
  proposal: CollaborationAssetAgreementProposal;
  title: string;
  message: string;
  onConfirm?: () => void;
  onCancel: () => void;
  readOnly?: boolean;
}) {
  const state = {
    direction: proposal.direction,
    status: 'confirming' as const,
    items: proposal.items,
    updatedAt: proposal.createdAt,
  };
  const ux = deriveCollaborationResourceUx(state, { proposal });
  const summary = summarizeAssetHandshake(state);
  const operationGroups = groupAgreementItemsByOperation(proposal.items, proposal.direction);
  const confirmDisabled = proposal.blockingProblemCount > 0;
  const [showProblemsOnly, setShowProblemsOnly] = useState(false);
  const visibleItems = useMemo(() => (
    showProblemsOnly ? proposal.items.filter(hasAgreementItemProblem) : proposal.items
  ), [proposal.items, showProblemsOnly]);
  const dialogRef = useModalDialog(onCancel);

  return createPortal(
    <div ref={dialogRef} className="collaboration-resource-dialog" role="dialog" aria-modal="true" aria-labelledby="collaboration-resource-dialog-title" aria-describedby="collaboration-resource-dialog-message">
      <div className="collaboration-resource-dialog__surface">
        <div className="collaboration-resource-dialog__header">
          <div>
            <div id="collaboration-resource-dialog-title" className="collaboration-resource-dialog__title">{title}</div>
            <div className="collaboration-resource-dialog__subtitle">
              {getAssetAgreementReasonLabel(proposal.reason)} · {DIRECTION_LABELS[proposal.direction]} · {summary.assetCount} 个资源 · {summary.fileCount} 个文件
            </div>
          </div>
          <button className="btn btn--icon collaboration-resource-dialog__close" onClick={onCancel} title={readOnly ? '关闭资源约定' : '取消资源约定'} aria-label={readOnly ? '关闭资源约定' : '取消资源约定'}>
            <IconX width={14} height={14} />
          </button>
          </div>

        <div className="collaboration-resource-dialog__body">
          <div id="collaboration-resource-dialog-message" className="collaboration-resource-dialog__message">{message}</div>
          <div className={`collaboration-resource-dialog__outcome collaboration-resource-dialog__outcome--${ux.severity} ${confirmDisabled ? 'collaboration-resource-dialog__outcome--blocked' : ''}`}>
            <strong>{ux.headline}</strong>
            <span>{ux.riskSummary.detail}</span>
          </div>
          <div className="collaboration-resource-dialog__totals">
            <span>{summary.assetCount} 个资源</span>
            <span>{summary.fileCount} 个文件</span>
            <span>{formatAssetHandshakeBytes(summary.totalSizeBytes)}</span>
            {proposal.warningCount > 0 && <span>{proposal.warningCount} 个提醒</span>}
          </div>
          {operationGroups.length > 0 && (
            <div className="collaboration-resource-dialog__operations">
              {operationGroups.map((group) => (
                <span key={group.operation} className={`collaboration-resource-dialog__operation collaboration-resource-dialog__operation--${group.tone}`}>
                  {group.label} · {group.items.length}
                </span>
              ))}
            </div>
          )}
          {(proposal.warningCount > 0 || proposal.blockingProblemCount > 0) && (
            <div className="collaboration-resource-dialog__filters">
              <label>
                <input
                  type="checkbox"
                  checked={showProblemsOnly}
                  onChange={(event) => setShowProblemsOnly(event.target.checked)}
                />
                只看问题资源
              </label>
            </div>
          )}

          <div className="collaboration-resource-dialog__list">
            <CollaborationResourcePlanList
              items={visibleItems}
              direction={proposal.direction}
              manifest={proposal.manifest}
              fileListLabel="文件清单"
              emptyLabel="当前没有需要处理的资源问题"
            />
          </div>
        </div>

        <div className="collaboration-resource-dialog__footer">
          <button className="btn" onClick={onCancel}>{readOnly ? '关闭' : '取消'}</button>
          {!readOnly && (
            <button
              className="btn btn--primary"
              onClick={onConfirm}
              disabled={confirmDisabled}
              title={confirmDisabled ? '请先处理资源问题' : '确认资源并继续'}
            >
              确认并继续
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

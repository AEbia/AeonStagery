import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  CollaborativeSceneStateV2,
  CollaborativeSceneStateV3,
} from '../api/types/collaboration';
import type {
  HistoricalSceneDocumentV4,
  SceneDocumentV5,
} from '../api/types/semantic-scene';
import {
  formatAssetHandshakeBytes,
  getAssetAgreementOperationLabel,
  summarizeAssetAgreementOperations,
  summarizeAssetHandshake,
  type CollaborationAssetAgreementProposal,
} from '../services/collaboration/CollaborationAssetHandshake';
import { IconX } from './icons';
import { useModalDialog } from './hooks/useModalDialog';
import { CollaborationResourcePlanList, hasAgreementItemProblem } from './CollaborationResourcePlanList';

function documentTitle(document: HistoricalSceneDocumentV4 | SceneDocumentV5 | null): string {
  return document?.meta?.title || document?.sceneId || '未命名场景';
}

function serverSceneTitle(state: CollaborativeSceneStateV2 | CollaborativeSceneStateV3): string {
  return state.meta?.title || state.sceneId || '服务器场景';
}

export function CollaborationServerSceneAgreementDialogV2({
  localDocument,
  serverDocument,
  serverState,
  assetAgreementProposal,
  blockingIssues,
  jsonBackupPath,
  backupPath,
  targetScenePath,
  onConfirm,
  onCancel,
}: {
  localDocument: HistoricalSceneDocumentV4 | SceneDocumentV5 | null;
  serverDocument: HistoricalSceneDocumentV4 | SceneDocumentV5;
  serverState: CollaborativeSceneStateV2 | CollaborativeSceneStateV3;
  assetAgreementProposal?: CollaborationAssetAgreementProposal;
  blockingIssues?: string[];
  jsonBackupPath?: string;
  backupPath?: string;
  targetScenePath: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useModalDialog(onCancel);
  const backupDisplayPath = jsonBackupPath ?? backupPath;
  const resourceState = assetAgreementProposal
    ? {
        direction: assetAgreementProposal.direction,
        status: 'confirming' as const,
        items: assetAgreementProposal.items,
        updatedAt: assetAgreementProposal.createdAt,
      }
    : null;
  const resourceSummary = resourceState ? summarizeAssetHandshake(resourceState) : null;
  const resourceDirection = resourceState?.direction;
  const operationSummary = assetAgreementProposal
    ? summarizeAssetAgreementOperations(assetAgreementProposal.items)
    : null;
  const visibleOperations = operationSummary
    ? (Object.entries(operationSummary) as Array<[keyof typeof operationSummary, number]>)
        .filter(([, count]) => count > 0)
    : [];
  const resolvedBlockingIssues = blockingIssues ?? [];
  const confirmDisabled = resolvedBlockingIssues.length > 0
    || (assetAgreementProposal?.blockingProblemCount ?? 0) > 0;
  const [showProblemsOnly, setShowProblemsOnly] = useState(false);
  const visibleItems = useMemo(() => {
    const items = assetAgreementProposal?.items ?? [];
    return showProblemsOnly ? items.filter(hasAgreementItemProblem) : items;
  }, [assetAgreementProposal, showProblemsOnly]);

  return createPortal(
    <div ref={dialogRef} className="collaboration-server-dialog" role="dialog" aria-modal="true" aria-labelledby="collaboration-server-dialog-v2-title" aria-describedby="collaboration-server-dialog-v2-warning">
      <div className="collaboration-server-dialog__surface">
        <div className="collaboration-server-dialog__header">
          <div>
            <div id="collaboration-server-dialog-v2-title" className="collaboration-server-dialog__title">确认覆写本地主剧本</div>
            <div className="collaboration-server-dialog__subtitle">服务器剧本会成为这个协作工作区的当前主剧本</div>
          </div>
          <button className="btn btn--icon collaboration-server-dialog__close" onClick={onCancel} title="取消加入" aria-label="取消加入">
            <IconX width={14} height={14} />
          </button>
        </div>

        <div className="collaboration-server-dialog__body">
          <div id="collaboration-server-dialog-v2-warning" className="collaboration-server-dialog__warning">
            加入已有房间前必须确认服务器剧本。本地协作工作区不会作为合并来源；资源准备通过后会用服务器版本覆写本地主剧本 JSON，资源只按服务器清单复用本地同内容文件、从外部库复制、从服务器下载或用服务器版替换，本地多余文件不会删除。
          </div>

          <div className="collaboration-server-dialog__compare">
            <div className="collaboration-server-dialog__card">
              <span>本地主剧本</span>
              <strong title={documentTitle(localDocument)}>{documentTitle(localDocument)}</strong>
              <em>{localDocument?.statements.length ?? 0} 条语句</em>
            </div>
            <div className="collaboration-server-dialog__card collaboration-server-dialog__card--server">
              <span>服务器剧本</span>
              <strong title={documentTitle(serverDocument)}>{serverSceneTitle(serverState)}</strong>
              <em>{serverDocument.statements.length} 条语句</em>
            </div>
          </div>

          <div className="collaboration-server-dialog__paths">
            <span title={targetScenePath}>本地主剧本: {targetScenePath}</span>
            {backupDisplayPath
              ? <span title={backupDisplayPath}>JSON 备份: {backupDisplayPath}</span>
              : <span>JSON 备份: 目标 JSON 不存在，无需备份</span>}
            <span>服务器剧本将覆写该 JSON。</span>
          </div>

          <div className="collaboration-server-dialog__paths">
            <span>
              资源计划:
              {' '}
              {resourceSummary
                ? `${resourceSummary.assetCount} 个资源 / ${resourceSummary.fileCount} 个文件 / ${formatAssetHandshakeBytes(resourceSummary.totalSizeBytes)}`
                : '无资源清单'}
            </span>
            {assetAgreementProposal && visibleOperations.length > 0 && (
              <span>
                {visibleOperations
                  .map(([operation, count]) => `${getAssetAgreementOperationLabel(operation, resourceDirection)} ${count}`)
                  .join(' · ')}
              </span>
            )}
            {assetAgreementProposal && assetAgreementProposal.warningCount > 0 && (
              <span>{assetAgreementProposal.warningCount} 个替换或路径提醒，确认后才会执行。</span>
            )}
            {resolvedBlockingIssues.length > 0 && (
              <span>阻塞问题: {resolvedBlockingIssues.length} 个，需要先处理。</span>
            )}
          </div>

          {resolvedBlockingIssues.length > 0 && (
            <div className="collaboration-server-dialog__issues">
              <strong>阻塞问题({resolvedBlockingIssues.length})</strong>
              {resolvedBlockingIssues.map((issue, index) => (
                <div key={index} className="collaboration-server-dialog__issue">{issue}</div>
              ))}
            </div>
          )}

          {assetAgreementProposal && (
            <>
              {(assetAgreementProposal.warningCount > 0 || assetAgreementProposal.blockingProblemCount > 0) && (
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
              <CollaborationResourcePlanList
                items={visibleItems}
                direction={assetAgreementProposal.direction}
                manifest={assetAgreementProposal.manifest}
                fileListLabel="文件计划"
                emptyLabel={assetAgreementProposal.items.length === 0
                  ? '服务器没有声明需要同步的资源'
                  : '当前没有需要处理的资源问题'}
              />
            </>
          )}
        </div>

        <div className="collaboration-server-dialog__footer">
          <button className="btn" onClick={onCancel}>取消</button>
          <button
            className="btn btn--danger"
            onClick={onConfirm}
            disabled={confirmDisabled}
            title={confirmDisabled ? '资源计划存在阻塞问题，不能覆写本地主剧本' : '确认后先准备资源，再备份 JSON 并覆写本地主剧本'}
          >
            确认资源计划并加入
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const CollaborationServerSceneAgreementDialogV3 = CollaborationServerSceneAgreementDialogV2;

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
import { IconCheckCircle, IconUsers, IconX } from './icons';
import { useModalDialog } from './hooks/useModalDialog';
import { CollaborationResourcePlanList, hasAgreementItemProblem } from './CollaborationResourcePlanList';

function documentTitle(document: HistoricalSceneDocumentV4 | SceneDocumentV5 | null): string {
  return document?.meta?.title || document?.sceneId || '未命名场景';
}

function serverSceneTitle(state: CollaborativeSceneStateV2 | CollaborativeSceneStateV3): string {
  return state.meta?.title || state.sceneId || '服务器场景';
}

export function CollaborationServerSceneAgreementDialogV2({
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

  const sceneStatementsCount = serverDocument.statements.length;

  return createPortal(
    <div
      ref={dialogRef}
      className="collaboration-server-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="collaboration-server-dialog-v2-title"
    >
      <div className="collaboration-server-dialog__surface">
        <div className="collaboration-server-dialog__header">
          <div className="collaboration-server-dialog__header-main">
            <span className="collaboration-server-dialog__header-icon">
              <IconUsers width={18} height={18} />
            </span>
            <div>
              <div id="collaboration-server-dialog-v2-title" className="collaboration-server-dialog__title">
                加入协作房间
              </div>
              <div className="collaboration-server-dialog__subtitle">
                同步房间剧本与素材，进入实时协作
              </div>
            </div>
          </div>
          <button
            className="btn btn--icon collaboration-server-dialog__close"
            onClick={onCancel}
            title="取消加入"
            aria-label="取消加入"
          >
            <IconX width={14} height={14} />
          </button>
        </div>

        <div className="collaboration-server-dialog__body">
          {/* 房间与剧本信息卡片 */}
          <div className="collaboration-server-dialog__hero">
            <div className="collaboration-server-dialog__hero-top">
              <div className="collaboration-server-dialog__scene-name" title={documentTitle(serverDocument)}>
                {serverSceneTitle(serverState)}
              </div>
              <span className="collaboration-server-dialog__badge">实时协作</span>
            </div>

            <div className="collaboration-server-dialog__stats">
              <span className="collaboration-server-dialog__stat-chip">
                {sceneStatementsCount} 条语句
              </span>
              {resourceSummary && (
                <span className="collaboration-server-dialog__stat-chip">
                  {resourceSummary.assetCount} 个素材文件 · {formatAssetHandshakeBytes(resourceSummary.totalSizeBytes)}
                </span>
              )}
            </div>

            {/* 自动安全备份提示 */}
            <div className="collaboration-server-dialog__backup-banner">
              <div className="collaboration-server-dialog__backup-header">
                <span className="collaboration-server-dialog__backup-icon">
                  <IconCheckCircle width={14} height={14} />
                </span>
                <span className="collaboration-server-dialog__backup-text">
                  本地原剧本已自动备份，同步后可随时还原
                </span>
              </div>
              <details className="collaboration-server-dialog__path-details">
                <summary>工作区与备份详情</summary>
                <div className="collaboration-server-dialog__path-content">
                  <div>
                    <span>工作区：</span>
                    <code title={targetScenePath}>{targetScenePath}</code>
                  </div>
                  <div>
                    <span>备份位置：</span>
                    <code title={backupDisplayPath ?? '目标无需备份'}>
                      {backupDisplayPath ?? '目标文件不存在，无需备份'}
                    </code>
                  </div>
                </div>
              </details>
            </div>
          </div>

          {/* 阻塞问题提示（仅存在时显示） */}
          {resolvedBlockingIssues.length > 0 && (
            <div className="collaboration-server-dialog__issues" role="alert">
              <strong>需要先处理以下问题才能加入：</strong>
              {resolvedBlockingIssues.map((issue, index) => (
                <div key={index} className="collaboration-server-dialog__issue">• {issue}</div>
              ))}
            </div>
          )}

          {/* 资源计划 */}
          {assetAgreementProposal && (
            <div className="collaboration-server-dialog__resources-section">
              <div className="collaboration-server-dialog__resources-header">
                <div className="collaboration-server-dialog__resources-summary">
                  <span>资源同步计划</span>
                  {visibleOperations.length > 0 && (
                    <div className="collaboration-server-dialog__operations">
                      {visibleOperations.map(([operation, count]) => (
                        <span key={operation} className="collaboration-server-dialog__op-tag">
                          {getAssetAgreementOperationLabel(operation, resourceDirection)} {count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {(assetAgreementProposal.warningCount > 0 || assetAgreementProposal.blockingProblemCount > 0) && (
                  <label className="collaboration-server-dialog__filter-checkbox">
                    <input
                      type="checkbox"
                      checked={showProblemsOnly}
                      onChange={(event) => setShowProblemsOnly(event.target.checked)}
                    />
                    <span>只看需处理项</span>
                  </label>
                )}
              </div>

              <CollaborationResourcePlanList
                items={visibleItems}
                direction={assetAgreementProposal.direction}
                manifest={assetAgreementProposal.manifest}
                fileListLabel="文件计划"
                emptyLabel={assetAgreementProposal.items.length === 0
                  ? '服务器没有声明需要同步的资源'
                  : '当前没有需要处理的资源问题'}
              />
            </div>
          )}
        </div>

        <div className="collaboration-server-dialog__footer">
          <button className="btn" onClick={onCancel}>取消</button>
          <button
            className="btn btn--primary"
            onClick={onConfirm}
            disabled={confirmDisabled}
            title={confirmDisabled ? '资源计划存在阻塞问题，暂无法加入' : '同步房间内容并加入协作'}
          >
            同步并加入
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const CollaborationServerSceneAgreementDialogV3 = CollaborationServerSceneAgreementDialogV2;

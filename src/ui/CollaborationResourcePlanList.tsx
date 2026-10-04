import type { CollaborativeAssetManifest } from '../api/types/collaboration';
import {
  type CollaborationAssetAgreementFilePlan,
  type CollaborationAssetHandshakeDirection,
  type CollaborationAssetHandshakeItem,
  formatAssetHandshakeBytes,
  formatAssetHandshakeHash,
  getAssetAgreementOperationLabel,
  getAssetAgreementSourceLabel,
  getAssetHandshakeKindLabel,
} from '../services/collaboration/CollaborationAssetHandshake';
import { getCollaborationResourceOperationTone } from '../services/collaboration/CollaborationResourceUxModel';

export function hasAgreementItemProblem(
  item: CollaborationAssetHandshakeItem,
): boolean {
  return !!item.problem || !!item.filePlans?.some((file) => file.problem);
}

export function CollaborationResourcePlanList({
  items,
  direction,
  manifest,
  fileListLabel = '文件清单',
  emptyLabel = '当前没有需要处理的资源问题',
}: {
  items: CollaborationAssetHandshakeItem[];
  direction: CollaborationAssetHandshakeDirection;
  manifest?: CollaborativeAssetManifest;
  fileListLabel?: string;
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return <div className="collaboration-resource-dialog__empty">{emptyLabel}</div>;
  }

  return (
    <div className="collaboration-resource-dialog__list">
      {items.map((item) => {
        const entry = manifest?.[item.assetKey];
        const entryFileByPath = new Map((entry?.files ?? []).map((file) => [file.relativePath, file]));
        const filePlans: CollaborationAssetAgreementFilePlan[] = item.filePlans?.length
          ? item.filePlans
          : (entry?.files ?? []).map((file) => ({
              relativePath: file.relativePath,
              sourceKind: 'unknown',
              operation: item.operation ?? 'reuse',
            }));
        return (
          <div
            key={item.assetKey}
            className={`collaboration-resource-dialog__asset collaboration-resource-dialog__asset--${getCollaborationResourceOperationTone(item.operation)}`}
          >
            <div className="collaboration-resource-dialog__asset-main">
              <span className="collaboration-resource-dialog__kind">{getAssetHandshakeKindLabel(item.kind)}</span>
              <span className="collaboration-resource-dialog__path" title={item.projectRelativePath}>{item.projectRelativePath}</span>
              <span className={`collaboration-resource-dialog__operation collaboration-resource-dialog__operation--${getCollaborationResourceOperationTone(item.operation)}`}>
                {getAssetAgreementOperationLabel(item.operation, direction)}
              </span>
              <span className="collaboration-resource-dialog__file-count">{item.fileCount} 文件 · {formatAssetHandshakeBytes(item.totalSizeBytes)}</span>
            </div>
            <div className="collaboration-resource-dialog__asset-meta">
              <span>{getAssetAgreementSourceLabel(item.sourceKind)}</span>
              <span title={item.entrypointPath}>入口 {item.entrypointPath}</span>
              <span title={item.contentHash}>指纹 {formatAssetHandshakeHash(item.contentHash)}</span>
            </div>
            {item.problem && (
              <div className={`collaboration-resource-dialog__problem collaboration-resource-dialog__problem--${item.problem.severity}`} title={item.problem.filePath}>
                {item.problem.message}
              </div>
            )}
            {filePlans.length > 0 && (
              <details className="collaboration-resource-dialog__files">
                <summary>{fileListLabel}</summary>
                {filePlans.slice(0, 8).map((filePlan) => {
                  const file = entryFileByPath.get(filePlan.relativePath);
                  const detail = filePlan.problem?.message && !item.problem
                    ? filePlan.problem.message
                    : (file ? formatAssetHandshakeHash(file.contentHash) : '');
                  return (
                    <span
                      key={filePlan.relativePath}
                      title={`${filePlan.relativePath}${detail ? ` · ${detail}` : ''}`}
                    >
                      <strong className={`collaboration-resource-dialog__file-operation collaboration-resource-dialog__operation--${getCollaborationResourceOperationTone(filePlan.operation)}`}>
                        {getAssetAgreementOperationLabel(filePlan.operation, direction)}
                      </strong>
                      <em>{filePlan.relativePath}{detail ? ` · ${detail}` : ''}</em>
                    </span>
                  );
                })}
                {filePlans.length > 8 && <strong>还有 {filePlans.length - 8} 个文件</strong>}
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

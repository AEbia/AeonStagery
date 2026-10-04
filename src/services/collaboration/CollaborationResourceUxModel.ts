import type { CollaborationConnectionStatus } from '../../api/types/collaboration';
import {
  type CollaborationAssetAgreementOperation,
  type CollaborationAssetAgreementProposal,
  type CollaborationAssetHandshakeItem,
  type CollaborationAssetHandshakeDirection,
  type CollaborationAssetHandshakeState,
  formatAssetHandshakeBytes,
  getAssetAgreementOperationLabel,
  countAgreementProblems,
  summarizeAssetAgreementOperations,
  summarizeAssetHandshake,
} from './CollaborationAssetHandshake';

export type CollaborationResourceUxPhase =
  | 'idle'
  | 'checking'
  | 'needs-review'
  | 'transferring'
  | 'ready'
  | 'blocked'
  | 'failed';

export type CollaborationResourceUxSeverity = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface CollaborationAgreementRiskSummary {
  blockingCount: number;
  warningCount: number;
  operationCounts: Record<CollaborationAssetAgreementOperation, number>;
  hasReplacement: boolean;
  hasUpload: boolean;
  hasDownload: boolean;
  hasCopy: boolean;
  hasOnlyReuse: boolean;
  headline: string;
  detail: string;
}

export interface CollaborationAgreementOperationGroup {
  operation: CollaborationAssetAgreementOperation;
  label: string;
  tone: CollaborationResourceUxSeverity;
  items: CollaborationAssetHandshakeItem[];
}

export interface CollaborationResourceUxModel {
  phase: CollaborationResourceUxPhase;
  severity: CollaborationResourceUxSeverity;
  headline: string;
  detail: string;
  nextAction: string;
  riskSummary: CollaborationAgreementRiskSummary;
  transferSummary: string | null;
  shouldSurfacePanel: boolean;
}

export const COLLABORATION_RESOURCE_OPERATION_ORDER: CollaborationAssetAgreementOperation[] = [
  'blocked',
  'replace',
  'copy-and-upload',
  'upload',
  'download',
  'copy',
  'reuse',
];

export function getCollaborationResourceOperationTone(
  operation: CollaborationAssetAgreementOperation | undefined,
): CollaborationResourceUxSeverity {
  switch (operation) {
    case 'blocked':
      return 'danger';
    case 'replace':
      return 'warning';
    case 'copy-and-upload':
    case 'upload':
    case 'download':
    case 'copy':
      return 'info';
    case 'reuse':
      return 'success';
    default:
      return 'neutral';
  }
}

export function groupAgreementItemsByOperation(
  items: CollaborationAssetHandshakeItem[],
  direction?: CollaborationAssetHandshakeDirection,
): CollaborationAgreementOperationGroup[] {
  return COLLABORATION_RESOURCE_OPERATION_ORDER
    .map((operation) => ({
      operation,
      label: getAssetAgreementOperationLabel(operation, direction),
      tone: getCollaborationResourceOperationTone(operation),
      items: items.filter((item) => (item.operation ?? 'reuse') === operation),
    }))
    .filter((group) => group.items.length > 0);
}

export function summarizeAgreementRisk(
  proposalOrItems: CollaborationAssetAgreementProposal | CollaborationAssetHandshakeItem[],
  direction?: CollaborationAssetHandshakeDirection,
): CollaborationAgreementRiskSummary {
  const items = Array.isArray(proposalOrItems) ? proposalOrItems : proposalOrItems.items;
  const resolvedDirection = Array.isArray(proposalOrItems) ? direction : proposalOrItems.direction;
  const operationCounts = summarizeAssetAgreementOperations(items);
  const blockingCount = Array.isArray(proposalOrItems)
    ? countAgreementProblems(items, 'blocking')
    : proposalOrItems.blockingProblemCount;
  const warningCount = Array.isArray(proposalOrItems)
    ? countAgreementProblems(items, 'warning')
    : proposalOrItems.warningCount;
  const hasReplacement = operationCounts.replace > 0;
  const hasUpload = operationCounts.upload > 0 || operationCounts['copy-and-upload'] > 0;
  const hasDownload = operationCounts.download > 0;
  const hasCopy = operationCounts.copy > 0 || (resolvedDirection !== 'remote' && operationCounts['copy-and-upload'] > 0);
  const activeOperations = COLLABORATION_RESOURCE_OPERATION_ORDER
    .filter((operation) => operation !== 'reuse' && operationCounts[operation] > 0);
  const hasOnlyReuse = activeOperations.length === 0 && operationCounts.reuse > 0;

  if (blockingCount > 0) {
    return {
      blockingCount,
      warningCount,
      operationCounts,
      hasReplacement,
      hasUpload,
      hasDownload,
      hasCopy,
      hasOnlyReuse,
      headline: `有 ${blockingCount} 个资源问题需要先处理`,
      detail: '这些资源不会被写入或同步；解决阻塞问题后才能继续协作。',
    };
  }

  if (resolvedDirection === 'remote' && hasUpload) {
    return {
      blockingCount,
      warningCount,
      operationCounts,
      hasReplacement,
      hasUpload,
      hasDownload,
      hasCopy,
      hasOnlyReuse,
      headline: '资源同步计划方向错误',
      detail: '加入端只接收和准备服务器资源；请重新生成服务器资源计划后再继续。',
    };
  }

  if (hasReplacement) {
    return {
      blockingCount,
      warningCount,
      operationCounts,
      hasReplacement,
      hasUpload,
      hasDownload,
      hasCopy,
      hasOnlyReuse,
      headline: `将替换 ${operationCounts.replace} 个本地资源`,
      detail: '确认后会用服务器版本写入同路径文件；请先确认本地改动已经可丢弃或另存。',
    };
  }

  if (hasUpload && hasDownload) {
    return {
      blockingCount,
      warningCount,
      operationCounts,
      hasReplacement,
      hasUpload,
      hasDownload,
      hasCopy,
      hasOnlyReuse,
      headline: '将上传并获取协作资源',
      detail: formatOperationDetail(operationCounts, resolvedDirection),
    };
  }

  if (hasUpload) {
    return {
      blockingCount,
      warningCount,
      operationCounts,
      hasReplacement,
      hasUpload,
      hasDownload,
      hasCopy,
      hasOnlyReuse,
      headline: '将发布本地资源到协作房间',
      detail: formatOperationDetail(operationCounts, resolvedDirection),
    };
  }

  if (hasDownload || hasCopy) {
    return {
      blockingCount,
      warningCount,
      operationCounts,
      hasReplacement,
      hasUpload,
      hasDownload,
      hasCopy,
      hasOnlyReuse,
      headline: '将准备服务器协作资源',
      detail: formatOperationDetail(operationCounts, resolvedDirection),
    };
  }

  if (warningCount > 0) {
    return {
      blockingCount,
      warningCount,
      operationCounts,
      hasReplacement,
      hasUpload,
      hasDownload,
      hasCopy,
      hasOnlyReuse,
      headline: `有 ${warningCount} 个资源提醒`,
      detail: '这些提醒不会阻止协作，但建议确认路径和来源后继续。',
    };
  }

  return {
    blockingCount,
    warningCount,
    operationCounts,
    hasReplacement,
    hasUpload,
    hasDownload,
    hasCopy,
    hasOnlyReuse,
    headline: hasOnlyReuse ? '资源已可直接复用' : '没有需要同步的资源',
    detail: hasOnlyReuse ? '本地资源与协作约定一致，不需要额外传输。' : '当前场景没有资源变更需要处理。',
  };
}

export function deriveCollaborationResourceUx(
  state: CollaborationAssetHandshakeState,
  options: {
    connectionStatus?: CollaborationConnectionStatus;
    proposal?: CollaborationAssetAgreementProposal | null;
    lastError?: string | null;
  } = {},
): CollaborationResourceUxModel {
  const proposal = options.proposal ?? null;
  const riskSummary = summarizeAgreementRisk(proposal ?? state.items, proposal?.direction ?? state.direction);
  const summary = summarizeAssetHandshake(state);
  const transferSummary = formatTransferSummary(state);
  const directionLabel = state.direction === 'local' ? '本地资源' : '服务器资源';
  const totalLabel = `${summary.assetCount} 个资源 · ${summary.fileCount} 个文件 · ${formatAssetHandshakeBytes(summary.totalSizeBytes)}`;

  if (state.status === 'idle' && state.items.length === 0 && !proposal) {
    return {
      phase: 'idle',
      severity: 'neutral',
      headline: '资源尚未校验',
      detail: '加入或主持协作时会自动校验场景引用的素材。',
      nextAction: '等待协作开始',
      riskSummary,
      transferSummary,
      shouldSurfacePanel: false,
    };
  }

  if (state.status === 'error') {
    return {
      phase: 'failed',
      severity: 'danger',
      headline: '资源同步失败',
      detail: '请检查资源路径、文件权限或服务器连接后重试。',
      nextAction: '修复资源后重试',
      riskSummary,
      transferSummary,
      shouldSurfacePanel: true,
    };
  }

  if (riskSummary.blockingCount > 0) {
    return {
      phase: 'blocked',
      severity: 'danger',
      headline: riskSummary.headline,
      detail: riskSummary.detail,
      nextAction: '打开同步计划查看问题资源',
      riskSummary,
      transferSummary,
      shouldSurfacePanel: true,
    };
  }

  if (state.status === 'confirming' || proposal) {
    return {
      phase: 'needs-review',
      severity: riskSummary.hasReplacement || riskSummary.warningCount > 0 ? 'warning' : 'info',
      headline: riskSummary.headline,
      detail: `${directionLabel} · ${totalLabel}`,
      nextAction: '确认同步计划后继续',
      riskSummary,
      transferSummary,
      shouldSurfacePanel: true,
    };
  }

  if (state.status === 'checking' || state.status === 'preparing') {
    return {
      phase: 'checking',
      severity: 'info',
      headline: state.status === 'checking' ? '正在校验协作资源' : '正在准备协作资源',
      detail: `${directionLabel} · ${totalLabel}`,
      nextAction: '等待校验完成',
      riskSummary,
      transferSummary,
      shouldSurfacePanel: true,
    };
  }

  if (state.status === 'uploading' || state.status === 'downloading') {
    return {
      phase: 'transferring',
      severity: 'info',
      headline: state.status === 'uploading' ? '正在上传协作资源' : '正在下载协作资源',
      detail: transferSummary ?? `${directionLabel} · ${totalLabel}`,
      nextAction: '保持窗口打开直到传输完成',
      riskSummary,
      transferSummary,
      shouldSurfacePanel: true,
    };
  }

  const completedOperationDetail = formatCompletedOperationDetail(riskSummary.operationCounts, state.direction);
  return {
    phase: 'ready',
    severity: 'success',
    headline: riskSummary.hasOnlyReuse ? '资源已就绪' : '资源同步已完成',
    detail: `${directionLabel} · ${totalLabel}${completedOperationDetail}`,
    nextAction: '可以继续实时协作',
    riskSummary: {
      ...riskSummary,
      headline: riskSummary.hasOnlyReuse ? '资源已就绪' : '资源同步已完成',
      detail: riskSummary.hasOnlyReuse
        ? '本地资源与协作约定一致，不需要额外传输。'
        : formatCompletedOperationDetail(riskSummary.operationCounts, state.direction).replace(/^；/, ''),
    },
    transferSummary,
    shouldSurfacePanel: !riskSummary.hasOnlyReuse,
  };
}

function formatOperationDetail(
  counts: Record<CollaborationAssetAgreementOperation, number>,
  direction?: CollaborationAssetHandshakeDirection,
): string {
  const parts = COLLABORATION_RESOURCE_OPERATION_ORDER
    .filter((operation) => counts[operation] > 0 && operation !== 'reuse')
    .map((operation) => `${counts[operation]} 个${getAssetAgreementOperationLabel(operation, direction)}`);
  return parts.length > 0 ? `确认后执行：${parts.join('、')}。` : '不需要额外传输。';
}

function formatCompletedOperationDetail(
  counts: Record<CollaborationAssetAgreementOperation, number>,
  direction?: CollaborationAssetHandshakeDirection,
): string {
  const parts = COLLABORATION_RESOURCE_OPERATION_ORDER
    .filter((operation) => counts[operation] > 0 && operation !== 'reuse')
    .map((operation) => `${counts[operation]} 个${getAssetAgreementOperationLabel(operation, direction)}`);
  return parts.length > 0 ? `；已完成：${parts.join('、')}` : '';
}

function formatTransferSummary(state: CollaborationAssetHandshakeState): string | null {
  const transfer = state.transfer;
  if (!transfer) return null;
  const percent = transfer.totalBytes > 0
    ? Math.min(100, Math.round((transfer.completedBytes / transfer.totalBytes) * 100))
    : transfer.totalFiles > 0
      ? Math.min(100, Math.round((transfer.completedFiles / transfer.totalFiles) * 100))
      : 0;
  const fileLabel = `${transfer.completedFiles}/${transfer.totalFiles} 文件`;
  const byteLabel = transfer.totalBytes > 0
    ? `${formatAssetHandshakeBytes(transfer.completedBytes)} / ${formatAssetHandshakeBytes(transfer.totalBytes)}`
    : null;
  return [transfer.currentFilePath || '准备资源传输', `${percent}%`, fileLabel, byteLabel]
    .filter(Boolean)
    .join(' · ');
}

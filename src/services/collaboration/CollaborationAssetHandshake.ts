import type {
  CollaborativeAssetKind,
  CollaborativeAssetManifest,
  CollaborativeAssetManifestEntry,
} from '../../api/types/collaboration';
import type { CollaborativeAssetTransferProgress } from './CollaborativeAssetTransfer';

export type CollaborationAssetHandshakeDirection = 'remote' | 'local';

export type CollaborationAssetAgreementReason =
  | 'initial-host'
  | 'join-room'
  | 'manual-refresh'
  | 'remote-manifest-changed'
  | 'local-asset-changed';

export type CollaborationAssetSourceKind =
  | 'project'
  | 'external-library'
  | 'server'
  | 'unknown';

export type CollaborationAssetAgreementOperation =
  | 'upload'
  | 'copy-and-upload'
  | 'download'
  | 'copy'
  | 'reuse'
  | 'replace'
  | 'blocked';

export type CollaborationAssetAgreementProblemSeverity = 'warning' | 'blocking';

export interface CollaborationAssetAgreementProblem {
  severity: CollaborationAssetAgreementProblemSeverity;
  message: string;
  filePath?: string;
}

export interface CollaborationAssetAgreementFilePlan {
  relativePath: string;
  sourceKind: CollaborationAssetSourceKind;
  operation: CollaborationAssetAgreementOperation;
  problem?: CollaborationAssetAgreementProblem;
}

export type CollaborationAssetHandshakeStatus =
  | 'idle'
  | 'confirming'
  | 'checking'
  | 'preparing'
  | 'downloading'
  | 'uploading'
  | 'verified'
  | 'error';

export interface CollaborationAssetHandshakeItem {
  assetKey: string;
  assetId: string;
  kind: CollaborativeAssetKind;
  projectRelativePath: string;
  entrypointPath: string;
  fileCount: number;
  totalSizeBytes: number;
  contentHash: string;
  status: CollaborationAssetHandshakeStatus;
  sourceKind?: CollaborationAssetSourceKind;
  operation?: CollaborationAssetAgreementOperation;
  problem?: CollaborationAssetAgreementProblem;
  filePlans?: CollaborationAssetAgreementFilePlan[];
}

export interface CollaborationAssetAgreementItemPlan {
  sourceKind: CollaborationAssetSourceKind;
  operation: CollaborationAssetAgreementOperation;
  problem?: CollaborationAssetAgreementProblem;
  filePlans?: CollaborationAssetAgreementFilePlan[];
}

export interface CollaborationAssetHandshakeState {
  direction: CollaborationAssetHandshakeDirection;
  status: CollaborationAssetHandshakeStatus;
  items: CollaborationAssetHandshakeItem[];
  updatedAt: string;
  error?: string;
  transfer?: CollaborativeAssetTransferProgress;
}

export interface CollaborationAssetAgreementProposal {
  proposalId: string;
  direction: CollaborationAssetHandshakeDirection;
  reason: CollaborationAssetAgreementReason;
  manifest: CollaborativeAssetManifest;
  proposedSignature: string;
  baseSignature?: string;
  items: CollaborationAssetHandshakeItem[];
  createdAt: string;
  blockingProblemCount: number;
  warningCount: number;
}

export function formatAssetHandshakeBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return '0 B';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getAssetHandshakeKindLabel(kind: CollaborativeAssetKind): string {
  switch (kind) {
    case 'live2d-bundle':
      return 'Live2D';
    case 'background-image':
      return '背景';
    case 'audio-file':
      return '音频';
    case 'image-file':
      return '图片';
    case 'animation-file':
      return '动画';
    case 'generic-file':
      return '文件';
  }
}

export function formatAssetHandshakeHash(contentHash: string): string {
  const normalized = contentHash.trim();
  if (!normalized) return '无指纹';
  const separatorIndex = normalized.indexOf(':');
  const algorithm = separatorIndex === -1 ? 'hash' : normalized.slice(0, separatorIndex);
  const hash = separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1);
  if (!hash) return normalized;
  return `${algorithm}:${hash.slice(0, 10)}`;
}

export function getAssetAgreementSourceLabel(sourceKind: CollaborationAssetSourceKind | undefined): string {
  switch (sourceKind) {
    case 'project':
      return '项目内';
    case 'external-library':
      return '外部库';
    case 'server':
      return '服务器';
    default:
      return '来源未知';
  }
}

export function isAssetAgreementOperationAllowedForDirection(
  operation: CollaborationAssetAgreementOperation | undefined,
  direction: CollaborationAssetHandshakeDirection,
): boolean {
  if (!operation) return true;
  if (operation === 'blocked') return true;
  if (direction === 'remote') {
    return operation !== 'upload' && operation !== 'copy-and-upload';
  }
  return operation !== 'download' && operation !== 'copy' && operation !== 'replace';
}

export function getAssetAgreementOperationLabel(
  operation: CollaborationAssetAgreementOperation | undefined,
  direction?: CollaborationAssetHandshakeDirection,
): string {
  if (direction && !isAssetAgreementOperationAllowedForDirection(operation, direction)) {
    return '同步方向错误';
  }
  switch (operation) {
    case 'upload':
      return '上传到服务器';
    case 'copy-and-upload':
      return '复制到项目并上传';
    case 'download':
      return '从服务器下载';
    case 'copy':
      return '从外部库复制';
    case 'reuse':
      return '本地已有，无需下载';
    case 'replace':
      return '用服务器版替换';
    case 'blocked':
      return '需要处理';
    default:
      return '待确认';
  }
}

export function getAssetAgreementReasonLabel(reason: CollaborationAssetAgreementReason): string {
  switch (reason) {
    case 'initial-host':
      return '主持房间';
    case 'join-room':
      return '加入房间';
    case 'manual-refresh':
      return '手动重新约定';
    case 'remote-manifest-changed':
      return '服务器资源变更';
    case 'local-asset-changed':
      return '本地资源变更';
  }
}

export function getCollaborativeAssetManifestAgreementSignature(manifest: CollaborativeAssetManifest | undefined): string {
  const normalized = Object.entries(manifest ?? {})
    .map(([assetKey, entry]) => ({
      assetKey,
      kind: entry.kind,
      importKind: entry.importKind,
      projectRelativePath: entry.projectRelativePath,
      entrypointPath: entry.entrypointPath,
      contentHash: entry.contentHash,
      files: [...entry.files]
        .map((file) => ({
          relativePath: file.relativePath,
          contentHash: file.contentHash,
          sizeBytes: file.sizeBytes,
        }))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    }))
    .sort((left, right) => left.assetKey.localeCompare(right.assetKey));
  return JSON.stringify(normalized);
}

export function createEmptyAssetHandshakeState(now = new Date().toISOString()): CollaborationAssetHandshakeState {
  return {
    direction: 'remote',
    status: 'idle',
    items: [],
    updatedAt: now,
  };
}

function toItem(
  assetKey: string,
  entry: CollaborativeAssetManifestEntry,
  status: CollaborationAssetHandshakeStatus,
  direction: CollaborationAssetHandshakeDirection,
  plan?: CollaborationAssetAgreementItemPlan,
): CollaborationAssetHandshakeItem {
  const normalizedPlan = normalizeAgreementItemPlanForDirection(plan, direction);
  return {
    assetKey,
    assetId: entry.assetId,
    kind: entry.kind,
    projectRelativePath: entry.projectRelativePath,
    entrypointPath: entry.entrypointPath,
    fileCount: entry.files.length,
    totalSizeBytes: entry.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    contentHash: entry.contentHash,
    status,
    ...(normalizedPlan?.sourceKind ? { sourceKind: normalizedPlan.sourceKind } : {}),
    ...(normalizedPlan?.operation ? { operation: normalizedPlan.operation } : {}),
    ...(normalizedPlan?.problem ? { problem: normalizedPlan.problem } : {}),
    ...(normalizedPlan?.filePlans ? { filePlans: normalizedPlan.filePlans } : {}),
  };
}

function createInvalidDirectionProblem(
  direction: CollaborationAssetHandshakeDirection,
  filePath?: string,
): CollaborationAssetAgreementProblem {
  return {
    severity: 'blocking',
    message: direction === 'remote'
      ? '加入端只接收和准备服务器资源；该资源计划方向不正确，需要重新生成资源约定。'
      : '主持端不会下载或替换服务器资源；该资源计划方向不正确，需要重新生成资源约定。',
    ...(filePath ? { filePath } : {}),
  };
}

function normalizeAgreementFilePlanForDirection(
  filePlan: CollaborationAssetAgreementFilePlan,
  direction: CollaborationAssetHandshakeDirection,
): CollaborationAssetAgreementFilePlan {
  if (isAssetAgreementOperationAllowedForDirection(filePlan.operation, direction)) {
    return filePlan;
  }
  return {
    ...filePlan,
    sourceKind: 'unknown',
    operation: 'blocked',
    problem: filePlan.problem?.severity === 'blocking'
      ? filePlan.problem
      : createInvalidDirectionProblem(direction, filePlan.relativePath),
  };
}

function normalizeAgreementItemPlanForDirection(
  plan: CollaborationAssetAgreementItemPlan | undefined,
  direction: CollaborationAssetHandshakeDirection,
): CollaborationAssetAgreementItemPlan | undefined {
  if (!plan) return undefined;
  const filePlans = plan.filePlans?.map((filePlan) => normalizeAgreementFilePlanForDirection(filePlan, direction));
  const invalidOperation = !isAssetAgreementOperationAllowedForDirection(plan.operation, direction);
  const blockingFilePlan = filePlans?.find((filePlan) => filePlan.problem?.severity === 'blocking');
  if (!invalidOperation && !blockingFilePlan) {
    return filePlans ? { ...plan, filePlans } : plan;
  }
  return {
    sourceKind: 'unknown',
    operation: 'blocked',
    problem: blockingFilePlan?.problem
      ?? (invalidOperation ? createInvalidDirectionProblem(direction) : plan.problem)
      ?? createInvalidDirectionProblem(direction),
    ...(filePlans ? { filePlans } : {}),
  };
}

export function createAssetHandshakeState(
  manifest: CollaborativeAssetManifest | undefined,
  status: CollaborationAssetHandshakeStatus,
  direction: CollaborationAssetHandshakeDirection,
  options: {
    error?: string;
    now?: string;
    itemPlans?: Record<string, CollaborationAssetAgreementItemPlan>;
    transfer?: CollaborativeAssetTransferProgress;
  } = {},
): CollaborationAssetHandshakeState {
  const items = Object.entries(manifest ?? {})
    .map(([assetKey, entry]) => toItem(
      assetKey,
      entry,
      status === 'error' ? 'error' : status,
      direction,
      options.itemPlans?.[assetKey],
    ))
    .sort((left, right) => left.projectRelativePath.localeCompare(right.projectRelativePath));

  return {
    direction,
    status,
    items,
    updatedAt: options.now ?? new Date().toISOString(),
    ...(options.error ? { error: options.error } : {}),
    ...(options.transfer ? { transfer: options.transfer } : {}),
  };
}

export function summarizeAssetHandshake(state: CollaborationAssetHandshakeState): {
  assetCount: number;
  fileCount: number;
  totalSizeBytes: number;
} {
  return {
    assetCount: state.items.length,
    fileCount: state.items.reduce((sum, item) => sum + item.fileCount, 0),
    totalSizeBytes: state.items.reduce((sum, item) => sum + item.totalSizeBytes, 0),
  };
}

export function countAgreementProblems(
  items: readonly CollaborationAssetHandshakeItem[],
  severity: CollaborationAssetAgreementProblemSeverity,
): number {
  return items.reduce((count, item) => {
    const itemProblemCount = item.problem?.severity === severity ? 1 : 0;
    const fileProblemCount = item.filePlans?.filter((file) => file.problem?.severity === severity).length ?? 0;
    return count + Math.max(itemProblemCount, fileProblemCount);
  }, 0);
}

export function createHandshakeReviewProposal(
  state: CollaborationAssetHandshakeState,
): CollaborationAssetAgreementProposal {
  return {
    proposalId: `review:${state.status}:${state.updatedAt}`,
    direction: state.direction,
    reason: 'manual-refresh',
    manifest: {},
    proposedSignature: '',
    items: state.items,
    createdAt: state.updatedAt,
    blockingProblemCount: countAgreementProblems(state.items, 'blocking'),
    warningCount: countAgreementProblems(state.items, 'warning'),
  };
}

export function summarizeAssetAgreementOperations(
  items: Pick<CollaborationAssetHandshakeItem, 'operation'>[],
): Record<CollaborationAssetAgreementOperation, number> {
  return items.reduce<Record<CollaborationAssetAgreementOperation, number>>((counts, item) => {
    const operation = item.operation ?? 'reuse';
    counts[operation] += 1;
    return counts;
  }, {
    upload: 0,
    'copy-and-upload': 0,
    download: 0,
    copy: 0,
    reuse: 0,
    replace: 0,
    blocked: 0,
  });
}

export function hasNonReuseAssetAgreementOperations(
  items: Pick<CollaborationAssetHandshakeItem, 'operation'>[],
): boolean {
  const counts = summarizeAssetAgreementOperations(items);
  return counts.upload > 0
    || counts['copy-and-upload'] > 0
    || counts.download > 0
    || counts.copy > 0
    || counts.replace > 0
    || counts.blocked > 0;
}

export function hasServerTransferAssetAgreementOperations(
  items: Pick<CollaborationAssetHandshakeItem, 'operation'>[],
): boolean {
  const counts = summarizeAssetAgreementOperations(items);
  return counts.download > 0 || counts.replace > 0;
}

export function shouldPromptForAssetAgreement(proposal: CollaborationAssetAgreementProposal): boolean {
  if (proposal.blockingProblemCount > 0 || proposal.warningCount > 0) return true;
  return proposal.items.some((item) => (
    item.operation === 'copy-and-upload' || item.operation === 'replace'
  ));
}

export function createAssetAgreementProposal(
  manifest: CollaborativeAssetManifest,
  direction: CollaborationAssetHandshakeDirection,
  options: {
    reason: CollaborationAssetAgreementReason;
    baseSignature?: string;
    itemPlans?: Record<string, CollaborationAssetAgreementItemPlan>;
    now?: string;
  },
): CollaborationAssetAgreementProposal {
  const createdAt = options.now ?? new Date().toISOString();
  const state = createAssetHandshakeState(manifest, 'confirming', direction, {
    itemPlans: options.itemPlans,
    now: createdAt,
  });
  const proposedSignature = getCollaborativeAssetManifestAgreementSignature(manifest);
  const blockingProblemCount = countAgreementProblems(state.items, 'blocking');
  const warningCount = countAgreementProblems(state.items, 'warning');

  return {
    proposalId: `${options.reason}:${direction}:${proposedSignature}`,
    direction,
    reason: options.reason,
    manifest,
    proposedSignature,
    ...(options.baseSignature ? { baseSignature: options.baseSignature } : {}),
    items: state.items,
    createdAt,
    blockingProblemCount,
    warningCount,
  };
}

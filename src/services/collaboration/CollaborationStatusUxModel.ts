import type {
  CollaborationConnectionStatus,
  CollaborationIdentity,
} from '../../api/types/collaboration';
import type { CollaborationAssetHandshakeState } from './CollaborationAssetHandshake';
import { deriveCollaborationResourceUx } from './CollaborationResourceUxModel';

export type CollaborationStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface CollaborationStatusTrustFact {
  key: string;
  label: string;
  detail: string;
  tone?: CollaborationStatusTone;
}

export interface CollaborationStatusUxInput {
  status: CollaborationConnectionStatus;
  assetHandshake?: CollaborationAssetHandshakeState;
  lastError?: string | null;
  self?: CollaborationIdentity | null;
  peers?: readonly CollaborationPresenceDisplayPeer[];
}

export interface CollaborationPresenceDisplayPeer {
  clientId: string;
  displayName: string;
}

export interface CollaborationStatusUxModel {
  label: string;
  shortLabel: string;
  footerLabel: string;
  headline: string;
  detail: string;
  tooltip: string;
  offlineEditMessage: string | null;
  memberSummary: string;
  sourceOfTruthFact: CollaborationStatusTrustFact;
  resourceFact: CollaborationStatusTrustFact;
  editFact: CollaborationStatusTrustFact;
  presenceFact: CollaborationStatusTrustFact;
  trustFacts: CollaborationStatusTrustFact[];
}

const STATUS_LABELS: Record<CollaborationConnectionStatus, string> = {
  disconnected: '未连接',
  connecting: '连接中',
  reconnecting: '正在重连',
  connected: '已连接',
  offline: '已断开',
  seeding: '准备协作',
  error: '连接异常',
};

const STATUS_FOOTER_LABELS: Record<CollaborationConnectionStatus, string> = {
  disconnected: '协作 · 未连接',
  connecting: '协作 · 连接中',
  reconnecting: '协作 · 正在重连',
  connected: '协作 · 已同步',
  offline: '协作 · 已断开',
  seeding: '协作 · 准备中',
  error: '协作 · 异常',
};

const STATUS_TONES: Record<CollaborationConnectionStatus, CollaborationStatusTone> = {
  disconnected: 'neutral',
  connecting: 'info',
  reconnecting: 'info',
  connected: 'success',
  offline: 'warning',
  seeding: 'info',
  error: 'danger',
};

export function deriveCollaborationStatusUx(input: CollaborationStatusUxInput): CollaborationStatusUxModel {
  const peers = input.peers ?? [];
  const label = STATUS_LABELS[input.status];
  const memberSummary = formatMemberSummary(input.self, peers);
  const sourceOfTruthFact = buildSourceOfTruthFact(input.status);
  const resourceFact = buildResourceFact(input);
  const editFact = buildEditFact(input.status);
  const presenceFact = buildPresenceFact(peers);
  const base = buildStatusCopy(input, resourceFact);
  const trustFacts = [sourceOfTruthFact, resourceFact, editFact, presenceFact];

  return {
    label,
    shortLabel: label,
    footerLabel: formatFooterLabel(input.status, input.self, peers),
    headline: base.headline,
    detail: base.detail,
    tooltip: base.tooltip,
    offlineEditMessage: input.status === 'offline'
      ? '共享编辑已暂停；请手动重连后才能继续编辑。'
      : input.status === 'reconnecting'
        ? '共享编辑已暂停；等待协作实时通道恢复后才能继续编辑。'
        : null,
    memberSummary,
    sourceOfTruthFact,
    resourceFact,
    editFact,
    presenceFact,
    trustFacts,
  };
}

function buildStatusCopy(
  input: CollaborationStatusUxInput,
  resourceFact: CollaborationStatusTrustFact,
): Pick<CollaborationStatusUxModel, 'headline' | 'detail' | 'tooltip'> {
  switch (input.status) {
    case 'disconnected':
      return {
        headline: '未加入协作房间',
        detail: '当前不在协作房间内，按单人编辑流程继续。',
        tooltip: '连接到协作服务器后会拉取服务器状态并进入共享编辑。',
      };
    case 'connecting':
      return {
        headline: '正在连接协作服务器',
        detail: '正在连接集中式协作服务器，并在共享编辑前拉取服务器状态。',
        tooltip: '等待服务器状态完成同步后再开始协作编辑。',
      };
    case 'reconnecting':
      return {
        headline: '协作正在重连',
        detail: '网络连接中断，系统正在自动重试；恢复服务器状态前共享编辑已暂停。',
        tooltip: '正在重新连接协作实时通道；同步恢复前不会提交共享编辑。',
      };
    case 'seeding':
      return {
        headline: resourceFact.label,
        detail: resourceFact.detail,
        tooltip: `${resourceFact.label}：${resourceFact.detail}`,
      };
    case 'connected':
      return {
        headline: '协作已连接',
        detail: '实时通道已连接，可以继续编辑并同步协作房间数据。',
        tooltip: '实时通道已连接，编辑和资源状态会在协作房间内同步。',
      };
    case 'offline':
      return {
        headline: '共享编辑已暂停',
        detail: '实时通道已断开；自动重试次数已用完，可从协作面板手动重连。',
        tooltip: '共享编辑已暂停，可从协作面板手动重连。',
      };
    case 'error': {
      const retryGuidance = input.self
        ? '自动重试已停止，可从协作面板手动重连。'
        : '请检查服务器连接后重试。';
      const lastError = input.lastError?.trim();
      const detail = lastError ? `${lastError}；${retryGuidance}` : retryGuidance;
      return {
        headline: '协作连接异常',
        detail,
        tooltip: detail,
      };
    }
  }
}

function buildSourceOfTruthFact(status: CollaborationConnectionStatus): CollaborationStatusTrustFact {
  if (status === 'connected') {
    return {
      key: 'source-of-truth',
      label: '事实来源',
      detail: '服务器协作状态是共享编辑依据；当前场景只是会话中的投影。',
      tone: 'success',
    };
  }

  if (status === 'connecting' || status === 'seeding') {
    return {
      key: 'source-of-truth',
      label: '事实来源',
      detail: '加入协作前会先拉取服务器状态，场景视图只是会话中的投影。',
      tone: 'info',
    };
  }

  if (status === 'reconnecting') {
    return {
      key: 'source-of-truth',
      label: '事实来源',
      detail: '实时通道恢复前只保留已应用的会话投影；重连后以服务器状态继续。',
      tone: 'warning',
    };
  }

  if (status === 'offline') {
    return {
      key: 'source-of-truth',
      label: '事实来源',
      detail: '实时通道断开后只保留已应用的会话投影；手动重连后以服务器状态继续。',
      tone: 'warning',
    };
  }

  if (status === 'error') {
    return {
      key: 'source-of-truth',
      label: '事实来源',
      detail: '连接恢复前不会开始共享编辑；重试成功后以服务器状态继续。',
      tone: 'danger',
    };
  }

  return {
    key: 'source-of-truth',
    label: '事实来源',
    detail: '未加入协作房间时使用单人编辑流程；加入后以服务器状态进行共享编辑。',
    tone: 'neutral',
  };
}

function buildResourceFact(input: CollaborationStatusUxInput): CollaborationStatusTrustFact {
  if (input.status === 'seeding' && input.assetHandshake) {
    const resourceUx = deriveCollaborationResourceUx(input.assetHandshake, { connectionStatus: input.status });
    const parts = [resourceUx.headline, resourceUx.detail, resourceUx.nextAction]
      .filter((part, index, array) => part && array.indexOf(part) === index);
    return {
      key: 'resource',
      label: resourceUx.headline,
      detail: parts.join('；'),
      tone: resourceUx.severity,
    };
  }

  if (input.status === 'connected') {
    if (input.assetHandshake && input.assetHandshake.items.length > 0) {
      const resourceUx = deriveCollaborationResourceUx(input.assetHandshake, { connectionStatus: input.status });
      return {
        key: 'resource',
        label: resourceUx.headline,
        detail: resourceUx.detail,
        tone: resourceUx.severity,
      };
    }
    return {
      key: 'resource',
      label: '资源状态',
      detail: '资源校验已完成，可以继续协作编辑。',
      tone: 'success',
    };
  }

  if (input.status === 'offline' || input.status === 'reconnecting') {
    return {
      key: 'resource',
      label: '资源状态',
      detail: input.status === 'reconnecting'
        ? '可查看或预览已应用的资源状态；实时通道恢复后继续共享编辑。'
        : '可查看或预览已应用的资源状态；可手动重试连接后继续共享编辑。',
      tone: 'warning',
    };
  }

  if (input.status === 'error') {
    return {
      key: 'resource',
      label: '资源状态',
      detail: '连接异常时不会扩展资源范围；修复连接后重试。',
      tone: 'danger',
    };
  }

  return {
    key: 'resource',
    label: '资源状态',
    detail: input.status === 'connecting'
      ? '连接时会检查协作资源并准备共享编辑。'
      : '未加入协作房间时不进行协作资源同步。',
    tone: STATUS_TONES[input.status],
  };
}

function buildEditFact(status: CollaborationConnectionStatus): CollaborationStatusTrustFact {
  if (status === 'connected') {
    return {
      key: 'edit',
      label: '编辑方式',
      detail: '提交的编辑会通过既有 authoring/collaboration seam 写入协作通道。',
      tone: 'success',
    };
  }

  if (status === 'offline') {
    return {
      key: 'edit',
      label: '编辑方式',
      detail: '共享编辑已暂停；手动重连并完成同步后才能继续编辑。',
      tone: 'warning',
    };
  }

  if (status === 'reconnecting') {
    return {
      key: 'edit',
      label: '编辑方式',
      detail: '共享编辑已暂停；实时通道恢复并完成同步后才能继续编辑。',
      tone: 'warning',
    };
  }

  if (status === 'error') {
    return {
      key: 'edit',
      label: '编辑方式',
      detail: '修复连接并重试前不会提交共享编辑。',
      tone: 'danger',
    };
  }

  return {
    key: 'edit',
    label: '编辑方式',
    detail: status === 'disconnected'
      ? '当前按单人编辑流程工作。'
      : '共享编辑会在服务器状态准备完成后开启。',
    tone: STATUS_TONES[status],
  };
}

function buildPresenceFact(peers: readonly CollaborationPresenceDisplayPeer[]): CollaborationStatusTrustFact {
  const peerLabel = peers.length > 0 ? `当前可见 ${peers.length} 位在线成员。` : '当前没有其他在线成员。';
  return {
    key: 'presence',
    label: '成员感知',
    detail: `${peerLabel} 在线成员的选择和编辑位置仅用于协作感知，只提示他人正在关注的位置，不限制你的操作。`,
    tone: 'info',
  };
}

function formatFooterLabel(
  status: CollaborationConnectionStatus,
  self: CollaborationIdentity | null | undefined,
  peers: readonly CollaborationPresenceDisplayPeer[],
): string {
  if (status === 'connected') {
    const memberCount = (self ? 1 : 0) + peers.length;
    return `${STATUS_FOOTER_LABELS.connected} · ${Math.max(1, memberCount)} 人`;
  }
  return STATUS_FOOTER_LABELS[status];
}

function formatMemberSummary(self: CollaborationIdentity | null | undefined, peers: readonly CollaborationPresenceDisplayPeer[]): string {
  const selfLabel = self?.displayName?.trim() || '你';
  if (peers.length === 0) return `${selfLabel} · 无其他在线成员`;
  const peerNames = peers.map((peer) => peer.displayName.trim()).filter(Boolean);
  const visibleNames = peerNames.slice(0, 2).join('、');
  const remainingCount = Math.max(0, peerNames.length - 2);
  const peerLabel = remainingCount > 0 ? `${visibleNames} 等 ${peers.length} 人` : `${visibleNames} ${peers.length} 人`;
  return `${selfLabel} · ${peerLabel}`;
}

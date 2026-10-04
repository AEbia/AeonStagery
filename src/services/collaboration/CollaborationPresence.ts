import type {
  CollaborationPresencePatchV2,
  CollaborationPresencePeerV2,
  CollaborationPresenceServerMessageV2,
  CollaborationPresenceServerMessageV3,
} from '../../api/types/collaboration';

export interface CollaborationPeerPresenceFact {
  key: string;
  label: string;
  title?: string;
}

export interface CollaborationPresenceLocator {
  statementId: string;
  companionId?: string;
}

export function reducePresenceMessage(
  peers: CollaborationPresencePeerV2[],
  message: CollaborationPresenceServerMessageV2 | CollaborationPresenceServerMessageV3,
  selfClientId: string,
): CollaborationPresencePeerV2[] {
  if (message.type === 'presence:snapshot') {
    return message.peers.filter((peer) => peer.clientId !== selfClientId);
  }

  if (message.type === 'presence:update') {
    if (message.peer.clientId === selfClientId) return peers;
    return [...peers.filter((peer) => peer.clientId !== message.peer.clientId), message.peer];
  }

  return peers.filter((peer) => peer.clientId !== message.clientId);
}

export function derivePresencePatchFromSelection(
  selectedStatementIds: Record<string, boolean>,
): Pick<CollaborationPresencePatchV2, 'selectedStatementIds' | 'editingTarget'> {
  const selected = Object.keys(selectedStatementIds).filter((id) => selectedStatementIds[id]);
  return {
    selectedStatementIds: selected,
    editingTarget: selected.length === 1
      ? { kind: 'statement', statementId: selected[0] }
      : null,
  };
}

export function formatPresencePlayheadTime(time: number): string {
  if (!Number.isFinite(time) || time < 0) return '0.00s';
  return `${time.toFixed(time >= 10 ? 1 : 2)}s`;
}

export function summarizePeerPresence(peer: CollaborationPresencePeerV2): string {
  if (peer.editingTarget?.kind === 'statement') return `正在编辑语句 ${peer.editingTarget.statementId}`;
  if (peer.editingTarget?.kind === 'companion') return `正在编辑 companion ${peer.editingTarget.companionId}`;
  if (peer.editingTarget?.kind === 'scene') return '正在编辑场景';
  if (peer.selectedStatementIds.length > 0) return `选中 ${peer.selectedStatementIds.length} 条语句`;
  if (peer.pointer?.surface === 'timeline') return `指向 ${formatPresencePlayheadTime(peer.pointer.time)}`;
  if (typeof peer.playheadTime === 'number') return `看到 ${formatPresencePlayheadTime(peer.playheadTime)}`;
  return '在线';
}

export function getPeerPresenceFacts(peer: CollaborationPresencePeerV2): CollaborationPeerPresenceFact[] {
  const facts: CollaborationPeerPresenceFact[] = [];
  if (typeof peer.playheadTime === 'number' && Number.isFinite(peer.playheadTime) && peer.playheadTime >= 0) {
    facts.push({
      key: 'playhead',
      label: `CTI ${formatPresencePlayheadTime(peer.playheadTime)}`,
      title: `时间指针 ${formatPresencePlayheadTime(peer.playheadTime)}`,
    });
  }
  if (peer.pointer?.surface === 'timeline') {
    const pointerLabel = `指针 ${formatPresencePlayheadTime(peer.pointer.time)}`;
    facts.push({
      key: 'pointer',
      label: peer.pointer.trackId ? `${pointerLabel} · ${peer.pointer.trackId}` : pointerLabel,
      title: peer.pointer.trackId
        ? `时间轴指针 ${formatPresencePlayheadTime(peer.pointer.time)} / ${peer.pointer.trackId}`
        : `时间轴指针 ${formatPresencePlayheadTime(peer.pointer.time)}`,
    });
  }
  if (peer.selectedStatementIds.length > 0) {
    facts.push({
      key: 'selection',
      label: `选中 ${peer.selectedStatementIds.length}`,
      title: peer.selectedStatementIds.join('、'),
    });
  }
  if (peer.editingTarget?.kind === 'statement') {
    facts.push({ key: 'editing', label: '编辑语句', title: peer.editingTarget.statementId });
  } else if (peer.editingTarget?.kind === 'companion') {
    facts.push({
      key: 'editing',
      label: '编辑 companion',
      title: `${peer.editingTarget.statementId}/${peer.editingTarget.companionId}`,
    });
  } else if (peer.editingTarget?.kind === 'scene') {
    facts.push({ key: 'editing', label: '编辑场景' });
  }
  return facts;
}

export function getPeersEditingLocator(
  peers: CollaborationPresencePeerV2[],
  locator: CollaborationPresenceLocator,
): CollaborationPresencePeerV2[] {
  return peers.filter((peer) => {
    const target = peer.editingTarget;
    if (!target || (target.kind !== 'statement' && target.kind !== 'companion')) return false;
    if (target.statementId !== locator.statementId) return false;
    return target.kind === 'companion'
      ? target.companionId === locator.companionId
      : !locator.companionId;
  });
}

function formatPeerNames(peers: CollaborationPresencePeerV2[]): string {
  const names = peers.map((peer) => peer.displayName.trim() || peer.clientId);
  if (names.length <= 2) return names.join('、');
  return `${names.slice(0, 2).join('、')} 等 ${names.length} 人`;
}

export function summarizeLocatorEditingPeers(
  peers: CollaborationPresencePeerV2[],
  locator: CollaborationPresenceLocator,
): string | null {
  const editingPeers = getPeersEditingLocator(peers, locator);
  if (editingPeers.length === 0) return null;
  const targetLabel = locator.companionId ? '此 companion' : '此语句';
  return `${formatPeerNames(editingPeers)} 正在编辑${targetLabel}`;
}

import { describe, expect, it } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  type CollaborationPresencePeerV2,
} from '../api/types/collaboration';
import {
  derivePresencePatchFromSelection,
  getPeerPresenceFacts,
  getPeersEditingLocator,
  reducePresenceMessage,
  summarizeLocatorEditingPeers,
  summarizePeerPresence,
} from '../ui/CollaborationConnectPanel';

describe('semantic collaboration presence UI helpers', () => {
  const self = { clientId: 'self-1', displayName: '导演' };
  const peerA: CollaborationPresencePeerV2 = {
    clientId: 'peer-a',
    displayName: '分镜师',
    selectedStatementIds: ['line-1'],
    editingTarget: { kind: 'statement', statementId: 'line-1' },
    playheadTime: 1.25,
  };
  const peerB: CollaborationPresencePeerV2 = {
    clientId: 'peer-b',
    displayName: '灯光',
    selectedStatementIds: [],
    editingTarget: null,
    playheadTime: 12,
  };

  it('reduces v2 snapshot/update/remove messages while excluding self', () => {
    const snapshot = reducePresenceMessage([], {
      type: 'presence:snapshot',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      peers: [selfPeer(), peerA],
    }, self.clientId);
    expect(snapshot).toEqual([peerA]);

    const updated = reducePresenceMessage(snapshot, {
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      peer: peerB,
    }, self.clientId);
    expect(updated).toEqual([peerA, peerB]);

    const ignoresSelf = reducePresenceMessage(updated, {
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      peer: selfPeer(['line-self']),
    }, self.clientId);
    expect(ignoresSelf).toEqual([peerA, peerB]);

    const removed = reducePresenceMessage(ignoresSelf, {
      type: 'presence:remove',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      clientId: peerA.clientId,
    }, self.clientId);
    expect(removed).toEqual([peerB]);
  });

  it('derives statement presence from selected statement ids', () => {
    expect(derivePresencePatchFromSelection({ line1: true, line2: false, line3: true })).toEqual({
      selectedStatementIds: ['line1', 'line3'],
      editingTarget: null,
    });
    expect(derivePresencePatchFromSelection({ line1: true })).toEqual({
      selectedStatementIds: ['line1'],
      editingTarget: { kind: 'statement', statementId: 'line1' },
    });
  });

  it('summarizes statement and companion presence in Chinese', () => {
    expect(summarizePeerPresence(peerA)).toBe('正在编辑语句 line-1');
    expect(summarizePeerPresence({ ...peerA, editingTarget: null, selectedStatementIds: ['a', 'b'] })).toBe('选中 2 条语句');
    expect(summarizePeerPresence(peerB)).toBe('看到 12.0s');
  });

  it('formats compact semantic presence facts', () => {
    expect(getPeerPresenceFacts({
      ...peerA,
      pointer: { surface: 'timeline', time: 3.5, trackId: 'character:rana' },
    }).map((fact) => fact.label)).toEqual([
      'CTI 1.25s',
      '指针 3.50s · character:rana',
      '选中 1',
      '编辑语句',
    ]);
  });

  it('resolves peers by semantic statement or companion locator', () => {
    const companionPeer: CollaborationPresencePeerV2 = {
      clientId: 'peer-c',
      displayName: '剪辑',
      selectedStatementIds: ['line-1'],
      editingTarget: { kind: 'companion', statementId: 'line-1', companionId: 'focus' },
      playheadTime: 2,
    };
    expect(getPeersEditingLocator([peerA, peerB, companionPeer], { statementId: 'line-1' })).toEqual([peerA]);
    expect(getPeersEditingLocator([peerA, peerB, companionPeer], { statementId: 'line-1', companionId: 'focus' })).toEqual([companionPeer]);
    expect(summarizeLocatorEditingPeers([peerA, companionPeer], { statementId: 'line-1' })).toBe('分镜师 正在编辑此语句');
    expect(summarizeLocatorEditingPeers([peerB], { statementId: 'missing' })).toBeNull();
  });

  function selfPeer(selectedStatementIds: string[] = []): CollaborationPresencePeerV2 {
    return {
      clientId: self.clientId,
      displayName: self.displayName,
      selectedStatementIds,
      editingTarget: selectedStatementIds.length === 1
        ? { kind: 'statement', statementId: selectedStatementIds[0] }
        : null,
      playheadTime: 0,
    };
  }
});

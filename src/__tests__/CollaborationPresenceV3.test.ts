import { describe, expect, it, vi } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborationPresencePeerV2,
  type CollaborationPresenceServerMessageV3,
} from '../api/types/collaboration';
import {
  reducePresenceMessage,
  getPeerPresenceFacts,
  getPeersEditingLocator,
  summarizeLocatorEditingPeers,
  summarizePeerPresence,
} from '../services/collaboration/CollaborationPresence';
import { CollaborationClientV3 } from '../services/collaboration/CollaborationClientV3';
import type { CollaborationWebSocketLike } from '../services/collaboration/CollaborationTransport';

function createSocketStub(readyState = 1): CollaborationWebSocketLike {
  return {
    binaryType: 'blob',
    readyState,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(),
  };
}

describe('Collaboration V3 Presence', () => {
  describe('reducePresenceMessage', () => {
    it('handles presence:snapshot by filtering out self identity', () => {
      const selfId = 'client-self';
      const initialPeers: CollaborationPresencePeerV2[] = [
        {
          clientId: 'stale-peer',
          displayName: 'Stale',
          selectedStatementIds: [],
          editingTarget: null,
        },
      ];

      const snapshotMessage: CollaborationPresenceServerMessageV3 = {
        type: 'presence:snapshot',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        peers: [
          {
            clientId: 'client-self',
            displayName: 'Self Director',
            selectedStatementIds: ['stmt-1'],
            editingTarget: null,
          },
          {
            clientId: 'client-peer-1',
            displayName: 'Alice',
            selectedStatementIds: ['stmt-2'],
            editingTarget: { kind: 'statement', statementId: 'stmt-2' },
          },
          {
            clientId: 'client-peer-2',
            displayName: 'Bob',
            selectedStatementIds: [],
            editingTarget: null,
            playheadTime: 3.5,
          },
        ],
      };

      const result = reducePresenceMessage(initialPeers, snapshotMessage, selfId);

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.clientId)).toEqual(['client-peer-1', 'client-peer-2']);
      expect(result.find((p) => p.clientId === 'client-peer-1')?.displayName).toBe('Alice');
    });

    it('handles presence:update by adding a new peer or updating an existing peer', () => {
      const selfId = 'client-self';
      const currentPeers: CollaborationPresencePeerV2[] = [
        {
          clientId: 'peer-1',
          displayName: 'Alice',
          selectedStatementIds: ['stmt-1'],
          editingTarget: null,
          playheadTime: 1.0,
        },
      ];

      // Update existing peer
      const updateAlice: CollaborationPresenceServerMessageV3 = {
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        peer: {
          clientId: 'peer-1',
          displayName: 'Alice',
          selectedStatementIds: ['stmt-1', 'stmt-2'],
          editingTarget: { kind: 'statement', statementId: 'stmt-2' },
          playheadTime: 2.5,
        },
      };
      const afterAliceUpdate = reducePresenceMessage(currentPeers, updateAlice, selfId);
      expect(afterAliceUpdate).toHaveLength(1);
      expect(afterAliceUpdate[0].selectedStatementIds).toEqual(['stmt-1', 'stmt-2']);
      expect(afterAliceUpdate[0].playheadTime).toBe(2.5);

      // Add new peer
      const updateBob: CollaborationPresenceServerMessageV3 = {
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        peer: {
          clientId: 'peer-2',
          displayName: 'Bob',
          selectedStatementIds: ['stmt-3'],
          editingTarget: { kind: 'companion', statementId: 'stmt-3', companionId: 'comp-1' },
          playheadTime: 0,
        },
      };
      const afterBobUpdate = reducePresenceMessage(afterAliceUpdate, updateBob, selfId);
      expect(afterBobUpdate).toHaveLength(2);
      expect(afterBobUpdate.find((p) => p.clientId === 'peer-2')?.displayName).toBe('Bob');

      // Ignore update for self
      const updateSelf: CollaborationPresenceServerMessageV3 = {
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        peer: {
          clientId: 'client-self',
          displayName: 'Self Director',
          selectedStatementIds: [],
          editingTarget: null,
        },
      };
      const afterSelfUpdate = reducePresenceMessage(afterBobUpdate, updateSelf, selfId);
      expect(afterSelfUpdate).toBe(afterBobUpdate);
    });

    it('handles presence:remove by deleting peer', () => {
      const selfId = 'client-self';
      const currentPeers: CollaborationPresencePeerV2[] = [
        { clientId: 'peer-1', displayName: 'Alice', selectedStatementIds: [], editingTarget: null },
        { clientId: 'peer-2', displayName: 'Bob', selectedStatementIds: [], editingTarget: null },
      ];

      const removeAlice: CollaborationPresenceServerMessageV3 = {
        type: 'presence:remove',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        clientId: 'peer-1',
      };
      const result = reducePresenceMessage(currentPeers, removeAlice, selfId);
      expect(result).toHaveLength(1);
      expect(result[0].clientId).toBe('peer-2');
    });

    it('resyncs peers after reconnection via presence:snapshot', () => {
      const selfId = 'client-self';
      // Peers before disconnect
      const peersBeforeDisconnect: CollaborationPresencePeerV2[] = [
        { clientId: 'peer-old-1', displayName: 'Alice', selectedStatementIds: [], editingTarget: null },
        { clientId: 'peer-old-2', displayName: 'Bob', selectedStatementIds: [], editingTarget: null },
      ];

      // Reconnect snapshot with updated room roster
      const reconnectSnapshot: CollaborationPresenceServerMessageV3 = {
        type: 'presence:snapshot',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        peers: [
          { clientId: 'peer-old-1', displayName: 'Alice', selectedStatementIds: ['stmt-9'], editingTarget: null },
          { clientId: 'peer-new-3', displayName: 'Charlie', selectedStatementIds: [], editingTarget: null },
        ],
      };

      const reconnectedPeers = reducePresenceMessage(peersBeforeDisconnect, reconnectSnapshot, selfId);
      expect(reconnectedPeers).toHaveLength(2);
      expect(reconnectedPeers.map((p) => p.clientId)).toEqual(['peer-old-1', 'peer-new-3']);
      expect(reconnectedPeers[0].selectedStatementIds).toEqual(['stmt-9']);
    });
  });

  describe('Presence UX summarizers and facts in v3', () => {
    it('summarizes peer editing targets and pointers', () => {
      const peerStmt: CollaborationPresencePeerV2 = {
        clientId: 'p1',
        displayName: 'Alice',
        selectedStatementIds: ['s1'],
        editingTarget: { kind: 'statement', statementId: 's1' },
      };
      expect(summarizePeerPresence(peerStmt)).toBe('正在编辑语句 s1');

      const peerCompanion: CollaborationPresencePeerV2 = {
        clientId: 'p2',
        displayName: 'Bob',
        selectedStatementIds: ['s1'],
        editingTarget: { kind: 'companion', statementId: 's1', companionId: 'c1' },
      };
      expect(summarizePeerPresence(peerCompanion)).toBe('正在编辑 companion c1');

      const peerTimeline: CollaborationPresencePeerV2 = {
        clientId: 'p3',
        displayName: 'Charlie',
        selectedStatementIds: [],
        editingTarget: null,
        pointer: { surface: 'timeline', time: 4.2 },
      };
      expect(summarizePeerPresence(peerTimeline)).toBe('指向 4.20s');
    });

    it('identifies peers editing specific locators and summarizes them', () => {
      const peers: CollaborationPresencePeerV2[] = [
        {
          clientId: 'p1',
          displayName: 'Alice',
          selectedStatementIds: ['s1'],
          editingTarget: { kind: 'statement', statementId: 's1' },
        },
        {
          clientId: 'p2',
          displayName: 'Bob',
          selectedStatementIds: ['s1'],
          editingTarget: { kind: 'companion', statementId: 's1', companionId: 'c1' },
        },
        {
          clientId: 'p3',
          displayName: 'Charlie',
          selectedStatementIds: ['s2'],
          editingTarget: { kind: 'statement', statementId: 's2' },
        },
      ];

      expect(getPeersEditingLocator(peers, { statementId: 's1' })).toHaveLength(1);
      expect(getPeersEditingLocator(peers, { statementId: 's1' })[0].clientId).toBe('p1');

      expect(getPeersEditingLocator(peers, { statementId: 's1', companionId: 'c1' })).toHaveLength(1);
      expect(getPeersEditingLocator(peers, { statementId: 's1', companionId: 'c1' })[0].clientId).toBe('p2');

      expect(summarizeLocatorEditingPeers(peers, { statementId: 's1' })).toBe('Alice 正在编辑此语句');
      expect(summarizeLocatorEditingPeers(peers, { statementId: 's1', companionId: 'c1' })).toBe('Bob 正在编辑此 companion');

      const factsAlice = getPeerPresenceFacts(peers[0]);
      expect(factsAlice.map((f) => f.key)).toContain('selection');
      expect(factsAlice.map((f) => f.key)).toContain('editing');
    });
  });

  describe('CollaborationClientV3 presence messaging', () => {
    it('sends v3 presence update over realtime socket and handles incoming v3 presence messages', async () => {
      const socket = createSocketStub();
      const client = new CollaborationClientV3({
        endpoint: '127.0.0.1:12345',
        identity: { clientId: 'self-1', displayName: 'Me' },
        fetchImpl: vi.fn() as any,
        webSocketFactory: () => socket,
      });

      const messages: CollaborationPresenceServerMessageV3[] = [];
      client.subscribePresence((msg) => messages.push(msg));

      client.connectRealtime();
      await vi.waitFor(() => expect(client.isRealtimeConnected()).toBe(true));

      client.updatePresence({
        selectedStatementIds: ['stmt-100'],
        editingTarget: { kind: 'statement', statementId: 'stmt-100' },
        playheadTime: 5.5,
      });

      expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        selectedStatementIds: ['stmt-100'],
        editingTarget: { kind: 'statement', statementId: 'stmt-100' },
        playheadTime: 5.5,
      }));

      // Inbound v3 presence update
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'presence:update',
          schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
          peer: {
            clientId: 'peer-3',
            displayName: 'Dave',
            selectedStatementIds: ['stmt-200'],
            editingTarget: null,
            playheadTime: 1.0,
          },
        }),
      } as MessageEvent);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        peer: {
          clientId: 'peer-3',
          displayName: 'Dave',
          selectedStatementIds: ['stmt-200'],
          editingTarget: null,
          playheadTime: 1.0,
        },
      });
    });
  });
});

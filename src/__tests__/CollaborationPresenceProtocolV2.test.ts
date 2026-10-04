import { describe, expect, it } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  type CollaborationPresenceServerMessageV2,
} from '../api/types/collaboration';
import {
  encodeCollaborationPresenceClientMessageV2,
  parseCollaborationPresenceServerMessageV2,
} from '../services/collaboration/CollaborationPresenceProtocol';
import {
  applyPresenceJoinV2,
  applyPresencePingV2,
  applyPresenceRemoveV2,
  applyPresenceUpdateV2,
  createPresenceRegistryV2,
  handlePresenceSocketMessageV2,
} from '../../server/collaboration/presence';

describe('collaboration presence protocol v2', () => {
  it('encodes statement-backed client messages with collaboration schema version 2', () => {
    expect(encodeCollaborationPresenceClientMessageV2({
      selectedStatementIds: ['line_1'],
      editingTarget: { kind: 'statement', statementId: 'line_1' },
      playheadTime: 1.5,
    })).toBe(JSON.stringify({
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      selectedStatementIds: ['line_1'],
      editingTarget: { kind: 'statement', statementId: 'line_1' },
      playheadTime: 1.5,
    }));
  });

  it('parses v2 server messages with statement and companion editing targets', () => {
    const message: CollaborationPresenceServerMessageV2 = {
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      peer: {
        clientId: 'client-1',
        displayName: 'Rana',
        selectedStatementIds: ['line_1'],
        editingTarget: { kind: 'companion', statementId: 'line_1', companionId: 'focus' },
        playheadTime: 2,
      },
    };

    expect(parseCollaborationPresenceServerMessageV2(JSON.stringify(message))).toEqual(message);
  });

  it('rejects legacy action-centric presence server messages in v2 parser', () => {
    expect(parseCollaborationPresenceServerMessageV2(JSON.stringify({
      type: 'presence:update',
      peer: {
        clientId: 'client-1',
        displayName: 'Rana',
        selectedActionIds: ['a1'],
        editingTarget: { kind: 'action', id: 'a1' },
      },
    }))).toBeNull();
  });

  it('tracks joining, updating, and leaving peers with v2 statement locators', () => {
    const registry = createPresenceRegistryV2();
    const socket = Symbol('socket');

    expect(applyPresenceJoinV2(registry, socket, {
      clientId: 'client-1',
      displayName: 'Rana',
    })).toEqual({
      snapshot: {
        type: 'presence:snapshot',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
        peers: [],
      },
      update: {
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
        peer: {
          clientId: 'client-1',
          displayName: 'Rana',
          selectedStatementIds: [],
          editingTarget: null,
          playheadTime: 0,
        },
      },
    });

    expect(applyPresenceUpdateV2(registry, socket, {
      selectedStatementIds: ['line_1'],
      editingTarget: { kind: 'companion', statementId: 'line_1', companionId: 'focus' },
      playheadTime: 2.5,
    })).toEqual({
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      peer: {
        clientId: 'client-1',
        displayName: 'Rana',
        selectedStatementIds: ['line_1'],
        editingTarget: { kind: 'companion', statementId: 'line_1', companionId: 'focus' },
        playheadTime: 2.5,
      },
    });

    expect(applyPresenceRemoveV2(registry, socket)).toEqual({
      type: 'presence:remove',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      clientId: 'client-1',
    });
    expect(registry.peersBySocket.has(socket)).toBe(false);
  });

  it('handles v2 text messages but ignores legacy v1 action payloads without mutating peers', () => {
    const registry = createPresenceRegistryV2();
    const socket = Symbol('socket');
    applyPresenceJoinV2(registry, socket, {
      clientId: 'client-1',
      displayName: 'Rana',
    });

    const v2Result = handlePresenceSocketMessageV2(registry, socket, false, {
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      selectedStatementIds: ['line_1'],
      editingTarget: { kind: 'statement', statementId: 'line_1' },
      playheadTime: 3,
    });
    expect(v2Result.broadcastMessages[0]).toMatchObject({
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      peer: {
        selectedStatementIds: ['line_1'],
        editingTarget: { kind: 'statement', statementId: 'line_1' },
      },
    });

    const legacyResult = handlePresenceSocketMessageV2(registry, socket, false, {
      type: 'presence:update',
      selectedActionIds: ['a1'],
      editingTarget: { kind: 'action', id: 'a1' },
    });
    expect(legacyResult).toEqual({
      handled: false,
      socketMessages: [],
      broadcastMessages: [],
    });
    expect(registry.peersBySocket.get(socket)?.selectedStatementIds).toEqual(['line_1']);
    expect(registry.peersBySocket.get(socket)?.editingTarget).toEqual({
      kind: 'statement',
      statementId: 'line_1',
    });
  });

  it('stores measured server ping on the peer presence record', () => {
    const registry = createPresenceRegistryV2();
    const socket = Symbol('socket');
    applyPresenceJoinV2(registry, socket, { clientId: 'client-1', displayName: 'Rana' });

    expect(applyPresencePingV2(registry, socket, 12.6)).toMatchObject({
      type: 'presence:update',
      peer: { clientId: 'client-1', pingMs: 13 },
    });
    expect(registry.peersBySocket.get(socket)?.pingMs).toBe(13);
  });

  it('leaves binary frames for v2 Yjs handling', () => {
    const registry = createPresenceRegistryV2();

    expect(handlePresenceSocketMessageV2(registry, Symbol('socket'), true, {
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      selectedStatementIds: ['line_1'],
      editingTarget: null,
    })).toEqual({
      handled: false,
      socketMessages: [],
      broadcastMessages: [],
    });
  });
});

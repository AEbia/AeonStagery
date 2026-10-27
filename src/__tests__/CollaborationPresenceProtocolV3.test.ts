import { describe, expect, it } from 'vitest';
import {
  applyPresenceJoinV3,
  applyPresencePingV3,
  applyPresenceRemoveV3,
  applyPresenceUpdateV3,
  createPresenceRegistryV3,
  handlePresenceSocketMessageV3,
} from '../../server/collaboration/presence';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborationPresenceServerMessageV3,
} from '../api/types/collaboration';
import {
  encodeCollaborationPresenceClientMessageV3,
  parseCollaborationPresenceServerMessageV3,
} from '../services/collaboration/CollaborationPresenceProtocol';

describe('collaboration presence protocol v3', () => {
  it('encodes statement-backed client messages with collaboration schema version 3', () => {
    expect(encodeCollaborationPresenceClientMessageV3({
      selectedStatementIds: ['line_1'],
      editingTarget: { kind: 'statement', statementId: 'line_1' },
      playheadTime: 1.5,
    })).toBe(JSON.stringify({
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
      selectedStatementIds: ['line_1'],
      editingTarget: { kind: 'statement', statementId: 'line_1' },
      playheadTime: 1.5,
    }));
  });

  it('parses v3 server messages with statement and companion editing targets', () => {
    const message: CollaborationPresenceServerMessageV3 = {
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
      peer: {
        clientId: 'client-1',
        displayName: 'Rana',
        selectedStatementIds: ['line_1'],
        editingTarget: { kind: 'companion', statementId: 'line_1', companionId: 'focus' },
        playheadTime: 2,
      },
    };

    expect(parseCollaborationPresenceServerMessageV3(JSON.stringify(message))).toEqual(message);
  });

  it('rejects legacy action-centric presence server messages in v3 parser', () => {
    expect(parseCollaborationPresenceServerMessageV3(JSON.stringify({
      type: 'presence:update',
      peer: {
        clientId: 'client-1',
        displayName: 'Rana',
        selectedActionIds: ['a1'],
        editingTarget: { kind: 'action', id: 'a1' },
      },
    }))).toBeNull();
  });

  it('tracks joining, updating, and leaving peers with v3 statement locators', () => {
    const registry = createPresenceRegistryV3();
    const socket = Symbol('socket');

    expect(applyPresenceJoinV3(registry, socket, {
      clientId: 'client-1',
      displayName: 'Rana',
    })).toEqual({
      snapshot: {
        type: 'presence:snapshot',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        peers: [],
      },
      update: {
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        peer: {
          clientId: 'client-1',
          displayName: 'Rana',
          selectedStatementIds: [],
          editingTarget: null,
          playheadTime: 0,
        },
      },
    });

    expect(applyPresenceUpdateV3(registry, socket, {
      selectedStatementIds: ['line_1'],
      editingTarget: { kind: 'companion', statementId: 'line_1', companionId: 'focus' },
      playheadTime: 2.5,
    })).toEqual({
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
      peer: {
        clientId: 'client-1',
        displayName: 'Rana',
        selectedStatementIds: ['line_1'],
        editingTarget: { kind: 'companion', statementId: 'line_1', companionId: 'focus' },
        playheadTime: 2.5,
      },
    });

    expect(applyPresenceRemoveV3(registry, socket)).toEqual({
      type: 'presence:remove',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
      clientId: 'client-1',
    });
    expect(registry.peersBySocket.has(socket)).toBe(false);
  });

  it('handles v3 text messages but ignores legacy v1 action payloads without mutating peers', () => {
    const registry = createPresenceRegistryV3();
    const socket = Symbol('socket');
    applyPresenceJoinV3(registry, socket, {
      clientId: 'client-1',
      displayName: 'Rana',
    });

    const v3Result = handlePresenceSocketMessageV3(registry, socket, false, {
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
      selectedStatementIds: ['line_1'],
      editingTarget: { kind: 'statement', statementId: 'line_1' },
      playheadTime: 3,
    });
    expect(v3Result.broadcastMessages[0]).toMatchObject({
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
      peer: {
        selectedStatementIds: ['line_1'],
        editingTarget: { kind: 'statement', statementId: 'line_1' },
      },
    });

    const legacyResult = handlePresenceSocketMessageV3(registry, socket, false, {
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
    const registry = createPresenceRegistryV3();
    const socket = Symbol('socket');
    applyPresenceJoinV3(registry, socket, { clientId: 'client-1', displayName: 'Rana' });

    expect(applyPresencePingV3(registry, socket, 12.6)).toMatchObject({
      type: 'presence:update',
      peer: { clientId: 'client-1', pingMs: 13 },
    });
    expect(registry.peersBySocket.get(socket)?.pingMs).toBe(13);
  });

  it('leaves binary frames for v3 Yjs handling', () => {
    const registry = createPresenceRegistryV3();

    expect(handlePresenceSocketMessageV3(registry, Symbol('socket'), true, {
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
      selectedStatementIds: ['line_1'],
      editingTarget: null,
    })).toEqual({
      handled: false,
      socketMessages: [],
      broadcastMessages: [],
    });
  });
});

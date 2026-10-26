import type {
  CollaborationIdentity,
  CollaborationPresencePatchV3,
  CollaborationPresencePeerV3,
  CollaborationPresenceServerMessageV3,
} from '../../src/api/types/collaboration';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
} from '../../src/api/types/collaboration';
import { isCollaborationPresenceClientMessage } from '../../src/services/collaboration/CollaborationPresenceProtocol';

export type CollaborationPresenceServerMessage =
  CollaborationPresenceServerMessageV3;

export interface PresenceRegistryV3<SocketKey = unknown> {
  peersBySocket: Map<SocketKey, CollaborationPresencePeerV3>;
}

export interface PresenceJoinResultV3 {
  snapshot: Extract<CollaborationPresenceServerMessage, { type: 'presence:snapshot' }>;
  update: Extract<CollaborationPresenceServerMessage, { type: 'presence:update' }>;
}

export interface PresenceSocketProtocolEventsV3 {
  socketMessages: CollaborationPresenceServerMessage[];
  broadcastMessages: CollaborationPresenceServerMessage[];
}

export interface PresenceSocketMessageResultV3 extends PresenceSocketProtocolEventsV3 {
  handled: boolean;
}

export function createPresenceRegistryV3<SocketKey = unknown>(): PresenceRegistryV3<SocketKey> {
  return { peersBySocket: new Map<SocketKey, CollaborationPresencePeerV3>() };
}

export function createPresenceIdentity(url: URL): CollaborationIdentity | null {
  const clientId = url.searchParams.get('clientId');
  const displayName = url.searchParams.get('displayName');
  if (!clientId || !displayName) return null;
  if (clientId.length > 128 || displayName.length > 128 || /[\u0000-\u001f\u007f]/.test(clientId + displayName)) {
    throw new Error('Invalid collaboration presence identity');
  }
  return { clientId, displayName };
}

export function connectPresenceSocketV3<SocketKey>(
  registry: PresenceRegistryV3<SocketKey>,
  socket: SocketKey,
  identity: CollaborationIdentity | null,
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V3,
): PresenceSocketProtocolEventsV3 {
  const snapshot = {
    type: 'presence:snapshot' as const,
    schemaVersion,
    peers: Array.from(registry.peersBySocket.values()),
  };
  if (!identity) {
    return { socketMessages: [snapshot], broadcastMessages: [] };
  }

  const peer: CollaborationPresencePeerV3 = {
    ...identity,
    selectedStatementIds: [],
    editingTarget: null,
    playheadTime: 0,
  };
  registry.peersBySocket.set(socket, peer);
  return {
    socketMessages: [snapshot],
    broadcastMessages: [{ type: 'presence:update' as const, schemaVersion, peer }],
  };
}

export function applyPresenceJoinV3<SocketKey>(
  registry: PresenceRegistryV3<SocketKey>,
  socket: SocketKey,
  identity: CollaborationIdentity,
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V3,
): PresenceJoinResultV3 {
  const snapshot = {
    type: 'presence:snapshot' as const,
    schemaVersion,
    peers: Array.from(registry.peersBySocket.values()),
  };
  const peer: CollaborationPresencePeerV3 = {
    ...identity,
    selectedStatementIds: [],
    editingTarget: null,
    playheadTime: 0,
  };
  registry.peersBySocket.set(socket, peer);
  return {
    snapshot,
    update: { type: 'presence:update' as const, schemaVersion, peer },
  };
}

export function applyPresenceUpdateV3<SocketKey>(
  registry: PresenceRegistryV3<SocketKey>,
  socket: SocketKey,
  patch: CollaborationPresencePatchV3,
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V3,
): Extract<CollaborationPresenceServerMessage, { type: 'presence:update' }> | null {
  const current = registry.peersBySocket.get(socket);
  if (!current) return null;
  const hasPointerPatch = Object.prototype.hasOwnProperty.call(patch, 'pointer');
  const peer: CollaborationPresencePeerV3 = {
    ...current,
    selectedStatementIds: patch.selectedStatementIds,
    editingTarget: patch.editingTarget ?? null,
    playheadTime: patch.playheadTime ?? current.playheadTime,
    pointer: hasPointerPatch ? (patch.pointer ?? null) : current.pointer,
  };
  registry.peersBySocket.set(socket, peer);
  return { type: 'presence:update' as const, schemaVersion, peer };
}

export function applyPresencePingV3<SocketKey>(
  registry: PresenceRegistryV3<SocketKey>,
  socket: SocketKey,
  pingMs: number,
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V3,
): Extract<CollaborationPresenceServerMessage, { type: 'presence:update' }> | null {
  const current = registry.peersBySocket.get(socket);
  if (!current || !Number.isFinite(pingMs) || pingMs < 0) return null;
  const peer: CollaborationPresencePeerV3 = { ...current, pingMs: Math.round(pingMs) };
  registry.peersBySocket.set(socket, peer);
  return { type: 'presence:update' as const, schemaVersion, peer };
}

export function handlePresenceSocketMessageV3<SocketKey>(
  registry: PresenceRegistryV3<SocketKey>,
  socket: SocketKey,
  isBinary: boolean,
  message?: unknown,
  defaultSchemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V3,
): PresenceSocketMessageResultV3 {
  if (isBinary) {
    return { handled: false, socketMessages: [], broadcastMessages: [] };
  }
  if (!isCollaborationPresenceClientMessage(message)) {
    // Not a presence message: let the socket adapter route it (e.g. leases).
    return { handled: false, socketMessages: [], broadcastMessages: [] };
  }

  const schemaVersion = message.schemaVersion ?? defaultSchemaVersion;
  if (schemaVersion !== defaultSchemaVersion) {
    // Exact-version collaboration: reject presence messages from the other
    // wire protocol instead of silently re-branding them.
    return { handled: true, socketMessages: [], broadcastMessages: [] };
  }

  const update = applyPresenceUpdateV3(registry, socket, message, schemaVersion);
  return {
    handled: true,
    socketMessages: [],
    broadcastMessages: update ? [update] : [],
  };
}

export function applyPresenceRemoveV3<SocketKey>(
  registry: PresenceRegistryV3<SocketKey>,
  socket: SocketKey,
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V3,
): Extract<CollaborationPresenceServerMessage, { type: 'presence:remove' }> | null {
  const current = registry.peersBySocket.get(socket);
  if (!current) return null;
  registry.peersBySocket.delete(socket);
  return { type: 'presence:remove' as const, schemaVersion, clientId: current.clientId };
}

export function disconnectPresenceSocketV3<SocketKey>(
  registry: PresenceRegistryV3<SocketKey>,
  socket: SocketKey,
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V3,
): PresenceSocketProtocolEventsV3 {
  const remove = applyPresenceRemoveV3(registry, socket, schemaVersion);
  return {
    socketMessages: [],
    broadcastMessages: remove ? [remove] : [],
  };
}

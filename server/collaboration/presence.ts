import type {
  CollaborationIdentity,
  CollaborationPresencePatchV2,
  CollaborationPresencePeerV2,
  CollaborationPresenceServerMessageV2,
  CollaborationPresenceServerMessageV3,
} from '../../src/api/types/collaboration';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  COLLABORATION_SCHEMA_VERSION_V3,
} from '../../src/api/types/collaboration';
import { isCollaborationPresenceClientMessage } from '../../src/services/collaboration/CollaborationPresenceProtocol';

export type CollaborationPresenceServerMessage =
  | CollaborationPresenceServerMessageV2
  | CollaborationPresenceServerMessageV3;

export interface PresenceRegistryV2<SocketKey = unknown> {
  peersBySocket: Map<SocketKey, CollaborationPresencePeerV2>;
}

export interface PresenceJoinResultV2 {
  snapshot: Extract<CollaborationPresenceServerMessage, { type: 'presence:snapshot' }>;
  update: Extract<CollaborationPresenceServerMessage, { type: 'presence:update' }>;
}

export interface PresenceSocketProtocolEventsV2 {
  socketMessages: CollaborationPresenceServerMessage[];
  broadcastMessages: CollaborationPresenceServerMessage[];
}

export interface PresenceSocketMessageResultV2 extends PresenceSocketProtocolEventsV2 {
  handled: boolean;
}

export function createPresenceRegistryV2<SocketKey = unknown>(): PresenceRegistryV2<SocketKey> {
  return { peersBySocket: new Map<SocketKey, CollaborationPresencePeerV2>() };
}

export function createPresenceIdentity(url: URL): CollaborationIdentity | null {
  const clientId = url.searchParams.get('clientId');
  const displayName = url.searchParams.get('displayName');
  if (!clientId || !displayName) return null;
  return { clientId, displayName };
}

export function connectPresenceSocketV2<SocketKey>(
  registry: PresenceRegistryV2<SocketKey>,
  socket: SocketKey,
  identity: CollaborationIdentity | null,
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2 | typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V2,
): PresenceSocketProtocolEventsV2 {
  const snapshot = {
    type: 'presence:snapshot' as const,
    schemaVersion,
    peers: Array.from(registry.peersBySocket.values()),
  };
  if (!identity) {
    return { socketMessages: [snapshot], broadcastMessages: [] };
  }

  const peer: CollaborationPresencePeerV2 = {
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

export function applyPresenceJoinV2<SocketKey>(
  registry: PresenceRegistryV2<SocketKey>,
  socket: SocketKey,
  identity: CollaborationIdentity,
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2 | typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V2,
): PresenceJoinResultV2 {
  const snapshot = {
    type: 'presence:snapshot' as const,
    schemaVersion,
    peers: Array.from(registry.peersBySocket.values()),
  };
  const peer: CollaborationPresencePeerV2 = {
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

export function applyPresenceUpdateV2<SocketKey>(
  registry: PresenceRegistryV2<SocketKey>,
  socket: SocketKey,
  patch: CollaborationPresencePatchV2,
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2 | typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V2,
): Extract<CollaborationPresenceServerMessage, { type: 'presence:update' }> | null {
  const current = registry.peersBySocket.get(socket);
  if (!current) return null;
  const hasPointerPatch = Object.prototype.hasOwnProperty.call(patch, 'pointer');
  const peer: CollaborationPresencePeerV2 = {
    ...current,
    selectedStatementIds: patch.selectedStatementIds,
    editingTarget: patch.editingTarget ?? null,
    playheadTime: patch.playheadTime ?? current.playheadTime,
    pointer: hasPointerPatch ? (patch.pointer ?? null) : current.pointer,
  };
  registry.peersBySocket.set(socket, peer);
  return { type: 'presence:update' as const, schemaVersion, peer };
}

export function applyPresencePingV2<SocketKey>(
  registry: PresenceRegistryV2<SocketKey>,
  socket: SocketKey,
  pingMs: number,
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2 | typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V2,
): Extract<CollaborationPresenceServerMessage, { type: 'presence:update' }> | null {
  const current = registry.peersBySocket.get(socket);
  if (!current || !Number.isFinite(pingMs) || pingMs < 0) return null;
  const peer: CollaborationPresencePeerV2 = { ...current, pingMs: Math.round(pingMs) };
  registry.peersBySocket.set(socket, peer);
  return { type: 'presence:update' as const, schemaVersion, peer };
}

export function handlePresenceSocketMessageV2<SocketKey>(
  registry: PresenceRegistryV2<SocketKey>,
  socket: SocketKey,
  isBinary: boolean,
  message?: unknown,
  defaultSchemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2 | typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V2,
): PresenceSocketMessageResultV2 {
  if (isBinary) {
    return { handled: false, socketMessages: [], broadcastMessages: [] };
  }
  if (!isCollaborationPresenceClientMessage(message)) {
    // Not a presence message: let the socket adapter route it (e.g. leases).
    return { handled: false, socketMessages: [], broadcastMessages: [] };
  }

  const schemaVersion = (message as any).schemaVersion ?? defaultSchemaVersion;
  if (schemaVersion !== defaultSchemaVersion) {
    // Exact-version collaboration: reject presence messages from the other
    // wire protocol instead of silently re-branding them.
    return { handled: true, socketMessages: [], broadcastMessages: [] };
  }

  const update = applyPresenceUpdateV2(registry, socket, message, schemaVersion);
  return {
    handled: true,
    socketMessages: [],
    broadcastMessages: update ? [update] : [],
  };
}

export function applyPresenceRemoveV2<SocketKey>(
  registry: PresenceRegistryV2<SocketKey>,
  socket: SocketKey,
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2 | typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V2,
): Extract<CollaborationPresenceServerMessage, { type: 'presence:remove' }> | null {
  const current = registry.peersBySocket.get(socket);
  if (!current) return null;
  registry.peersBySocket.delete(socket);
  return { type: 'presence:remove' as const, schemaVersion, clientId: current.clientId };
}

export function disconnectPresenceSocketV2<SocketKey>(
  registry: PresenceRegistryV2<SocketKey>,
  socket: SocketKey,
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2 | typeof COLLABORATION_SCHEMA_VERSION_V3 = COLLABORATION_SCHEMA_VERSION_V2,
): PresenceSocketProtocolEventsV2 {
  const remove = applyPresenceRemoveV2(registry, socket, schemaVersion);
  return {
    socketMessages: [],
    broadcastMessages: remove ? [remove] : [],
  };
}

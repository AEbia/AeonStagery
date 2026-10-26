import type {
  CollaborationClientId,
  CollaborationLeaseTargetV3,
} from '../../src/api/types/collaboration';

/**
 * Server-adjudicated scoped edit leases for custom motion authoring
 * (ADR-0028). The server is the single arbiter: it grants at most one holder
 * per characterPerformance source entity, renews leases on a heartbeat, and
 * auto-releases after a disconnect timeout. Presence only displays the
 * holder; it never authorizes writes.
 */

export const COLLABORATION_LEASE_DEFAULT_TIMEOUT_MS = 30_000;

export type CollaborationLeaseTargetKey = string;

export interface CollaborationLeaseRecord {
  readonly clientId: CollaborationClientId;
  readonly requestId: string;
  readonly target: CollaborationLeaseTargetV3;
  lastRenewedAt: number;
}

export interface CollaborationLeaseRegistryV3<SocketKey = unknown> {
  leasesBySocket: Map<SocketKey, Set<CollaborationLeaseTargetKey>>;
  leasesByTarget: Map<CollaborationLeaseTargetKey, CollaborationLeaseRecord>;
  socketsByTarget: Map<CollaborationLeaseTargetKey, SocketKey>;
}

export function encodeCollaborationLeaseTargetV3(target: CollaborationLeaseTargetV3): CollaborationLeaseTargetKey {
  return target.kind === 'companion'
    ? `companion:${target.statementId}:${target.companionId}`
    : `statement:${target.statementId}`;
}

export function decodeCollaborationLeaseTargetV3(key: CollaborationLeaseTargetKey): CollaborationLeaseTargetV3 | null {
  if (key.startsWith('statement:')) {
    const statementId = key.slice('statement:'.length);
    return statementId ? { kind: 'statement', statementId } : null;
  }
  if (key.startsWith('companion:')) {
    const parts = key.slice('companion:'.length).split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { kind: 'companion', statementId: parts[0], companionId: parts[1] };
  }
  return null;
}

export function createCollaborationLeaseRegistryV3<SocketKey = unknown>(): CollaborationLeaseRegistryV3<SocketKey> {
  return {
    leasesBySocket: new Map<SocketKey, Set<CollaborationLeaseTargetKey>>(),
    leasesByTarget: new Map<CollaborationLeaseTargetKey, CollaborationLeaseRecord>(),
    socketsByTarget: new Map<CollaborationLeaseTargetKey, SocketKey>(),
  };
}

export type CollaborationLeaseGrantResultV3 =
  | { granted: true; record: CollaborationLeaseRecord }
  | { granted: false; heldByClientId: CollaborationClientId };

/**
 * Atomically request the lease for a target. A different client is denied;
 * the same client may replace its ownership with a new acquisition request.
 */
export function acquireCollaborationLeaseV3<SocketKey>(
  registry: CollaborationLeaseRegistryV3<SocketKey>,
  socket: SocketKey,
  clientId: CollaborationClientId,
  requestId: string,
  target: CollaborationLeaseTargetV3,
  now = Date.now(),
): CollaborationLeaseGrantResultV3 {
  const key = encodeCollaborationLeaseTargetV3(target);
  const existing = registry.leasesByTarget.get(key);
  if (existing && (existing.clientId !== clientId
    || (existing.requestId === requestId && registry.socketsByTarget.get(key) !== socket))) {
    return { granted: false, heldByClientId: existing.clientId };
  }

  if (existing) {
    const previousSocket = registry.socketsByTarget.get(key);
    if (previousSocket !== undefined) registry.leasesBySocket.get(previousSocket)?.delete(key);
  }
  const record: CollaborationLeaseRecord = {
    clientId,
    requestId,
    target,
    lastRenewedAt: now,
  };
  registry.leasesByTarget.set(key, record);
  registry.socketsByTarget.set(key, socket);
  let bySocket = registry.leasesBySocket.get(socket);
  if (!bySocket) {
    bySocket = new Set();
    registry.leasesBySocket.set(socket, bySocket);
  }
  bySocket.add(key);
  return { granted: true, record };
}

export function renewCollaborationLeaseV3<SocketKey>(
  registry: CollaborationLeaseRegistryV3<SocketKey>,
  socket: SocketKey,
  clientId: CollaborationClientId,
  requestId: string,
  target: CollaborationLeaseTargetV3,
  now = Date.now(),
): boolean {
  const key = encodeCollaborationLeaseTargetV3(target);
  const record = registry.leasesByTarget.get(key);
  if (!record || record.clientId !== clientId || record.requestId !== requestId
    || registry.socketsByTarget.get(key) !== socket) return false;
  record.lastRenewedAt = now;
  let bySocket = registry.leasesBySocket.get(socket);
  if (!bySocket) {
    bySocket = new Set();
    registry.leasesBySocket.set(socket, bySocket);
  }
  bySocket.add(key);
  return true;
}

export function releaseCollaborationLeaseV3<SocketKey>(
  registry: CollaborationLeaseRegistryV3<SocketKey>,
  socket: SocketKey,
  clientId: CollaborationClientId,
  target: CollaborationLeaseTargetV3,
  requestId: string,
): boolean {
  const key = encodeCollaborationLeaseTargetV3(target);
  const record = registry.leasesByTarget.get(key);
  if (!record || record.clientId !== clientId || record.requestId !== requestId
    || registry.socketsByTarget.get(key) !== socket) return false;
  registry.leasesByTarget.delete(key);
  registry.socketsByTarget.delete(key);
  registry.leasesBySocket.get(socket)?.delete(key);
  return true;
}

/**
 * Release every lease held by a socket (disconnect, crash, session end).
 * Returns the released lease records so the adapter can broadcast.
 */
export function releaseAllCollaborationLeasesV3<SocketKey>(
  registry: CollaborationLeaseRegistryV3<SocketKey>,
  socket: SocketKey,
): CollaborationLeaseRecord[] {
  const keys = registry.leasesBySocket.get(socket);
  if (!keys || keys.size === 0) return [];
  const released: CollaborationLeaseRecord[] = [];
  for (const key of keys) {
    const record = registry.leasesByTarget.get(key);
    if (record && registry.socketsByTarget.get(key) === socket) {
      registry.leasesByTarget.delete(key);
      registry.socketsByTarget.delete(key);
      released.push(record);
    }
  }
  registry.leasesBySocket.delete(socket);
  return released;
}

/**
 * Auto-release leases whose holder has not renewed within the timeout
 * (disconnect, crash, sleep). Returns expired leases for broadcasting.
 */
export function expireCollaborationLeasesV3<SocketKey>(
  registry: CollaborationLeaseRegistryV3<SocketKey>,
  now = Date.now(),
  timeoutMs = COLLABORATION_LEASE_DEFAULT_TIMEOUT_MS,
): CollaborationLeaseRecord[] {
  const expired: CollaborationLeaseRecord[] = [];
  const expiredKeys = new Set<CollaborationLeaseTargetKey>();
  for (const [key, record] of registry.leasesByTarget) {
    if (now - record.lastRenewedAt >= timeoutMs) {
      registry.leasesByTarget.delete(key);
      registry.socketsByTarget.delete(key);
      expiredKeys.add(key);
      expired.push(record);
    }
  }
  if (expiredKeys.size > 0) {
    for (const [socket, keys] of registry.leasesBySocket) {
      for (const key of expiredKeys) {
        keys.delete(key);
      }
      if (keys.size === 0) {
        registry.leasesBySocket.delete(socket);
      }
    }
  }
  return expired;
}

export function listCollaborationLeaseTargetsV3<SocketKey>(
  registry: CollaborationLeaseRegistryV3<SocketKey>,
): readonly CollaborationLeaseRecord[] {
  return Array.from(registry.leasesByTarget.values());
}

import type {
  CollaborationClientId,
  CollaborationLeaseTargetV2,
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
  readonly target: CollaborationLeaseTargetV2;
  lastRenewedAt: number;
}

export interface CollaborationLeaseRegistryV2<SocketKey = unknown> {
  leasesBySocket: Map<SocketKey, Set<CollaborationLeaseTargetKey>>;
  leasesByTarget: Map<CollaborationLeaseTargetKey, CollaborationLeaseRecord>;
}

export function encodeCollaborationLeaseTargetV2(target: CollaborationLeaseTargetV2): CollaborationLeaseTargetKey {
  return target.kind === 'companion'
    ? `companion:${target.statementId}:${target.companionId}`
    : `statement:${target.statementId}`;
}

export function decodeCollaborationLeaseTargetV2(key: CollaborationLeaseTargetKey): CollaborationLeaseTargetV2 | null {
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

export function createCollaborationLeaseRegistryV2<SocketKey = unknown>(): CollaborationLeaseRegistryV2<SocketKey> {
  return {
    leasesBySocket: new Map<SocketKey, Set<CollaborationLeaseTargetKey>>(),
    leasesByTarget: new Map<CollaborationLeaseTargetKey, CollaborationLeaseRecord>(),
  };
}

export type CollaborationLeaseGrantResultV2 =
  | { granted: true; record: CollaborationLeaseRecord }
  | { granted: false; heldByClientId: CollaborationClientId };

/**
 * Atomically request the lease for a target. The current holder (even if it
 * is the same client) keeps the lease; a different client is denied.
 */
export function acquireCollaborationLeaseV2<SocketKey>(
  registry: CollaborationLeaseRegistryV2<SocketKey>,
  socket: SocketKey,
  clientId: CollaborationClientId,
  requestId: string,
  target: CollaborationLeaseTargetV2,
  now = Date.now(),
): CollaborationLeaseGrantResultV2 {
  const key = encodeCollaborationLeaseTargetV2(target);
  const existing = registry.leasesByTarget.get(key);
  if (existing && existing.clientId !== clientId) {
    return { granted: false, heldByClientId: existing.clientId };
  }

  const record: CollaborationLeaseRecord = {
    clientId,
    requestId,
    target,
    lastRenewedAt: now,
  };
  registry.leasesByTarget.set(key, record);
  let bySocket = registry.leasesBySocket.get(socket);
  if (!bySocket) {
    bySocket = new Set();
    registry.leasesBySocket.set(socket, bySocket);
  }
  bySocket.add(key);
  return { granted: true, record };
}

export function renewCollaborationLeaseV2<SocketKey>(
  registry: CollaborationLeaseRegistryV2<SocketKey>,
  socket: SocketKey,
  clientId: CollaborationClientId,
  requestId: string,
  target: CollaborationLeaseTargetV2,
  now = Date.now(),
): boolean {
  const key = encodeCollaborationLeaseTargetV2(target);
  const record = registry.leasesByTarget.get(key);
  if (!record || record.clientId !== clientId || record.requestId !== requestId) return false;
  record.lastRenewedAt = now;
  let bySocket = registry.leasesBySocket.get(socket);
  if (!bySocket) {
    bySocket = new Set();
    registry.leasesBySocket.set(socket, bySocket);
  }
  bySocket.add(key);
  return true;
}

export function releaseCollaborationLeaseV2<SocketKey>(
  registry: CollaborationLeaseRegistryV2<SocketKey>,
  socket: SocketKey,
  clientId: CollaborationClientId,
  target: CollaborationLeaseTargetV2,
): boolean {
  const key = encodeCollaborationLeaseTargetV2(target);
  const record = registry.leasesByTarget.get(key);
  if (!record || record.clientId !== clientId) return false;
  registry.leasesByTarget.delete(key);
  registry.leasesBySocket.get(socket)?.delete(key);
  return true;
}

/**
 * Release every lease held by a socket (disconnect, crash, session end).
 * Returns the released lease records so the adapter can broadcast.
 */
export function releaseAllCollaborationLeasesV2<SocketKey>(
  registry: CollaborationLeaseRegistryV2<SocketKey>,
  socket: SocketKey,
): CollaborationLeaseRecord[] {
  const keys = registry.leasesBySocket.get(socket);
  if (!keys || keys.size === 0) return [];
  const released: CollaborationLeaseRecord[] = [];
  for (const key of keys) {
    const record = registry.leasesByTarget.get(key);
    if (record) {
      registry.leasesByTarget.delete(key);
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
export function expireCollaborationLeasesV2<SocketKey>(
  registry: CollaborationLeaseRegistryV2<SocketKey>,
  now = Date.now(),
  timeoutMs = COLLABORATION_LEASE_DEFAULT_TIMEOUT_MS,
): CollaborationLeaseRecord[] {
  const expired: CollaborationLeaseRecord[] = [];
  const expiredKeys = new Set<CollaborationLeaseTargetKey>();
  for (const [key, record] of registry.leasesByTarget) {
    if (now - record.lastRenewedAt >= timeoutMs) {
      registry.leasesByTarget.delete(key);
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

export function listCollaborationLeaseTargetsV2<SocketKey>(
  registry: CollaborationLeaseRegistryV2<SocketKey>,
): readonly CollaborationLeaseRecord[] {
  return Array.from(registry.leasesByTarget.values());
}

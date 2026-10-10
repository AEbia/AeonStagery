import { describe, expect, it } from 'vitest';
import {
  acquireCollaborationLeaseV2,
  createCollaborationLeaseRegistryV2,
  decodeCollaborationLeaseTargetV2,
  encodeCollaborationLeaseTargetV2,
  expireCollaborationLeasesV2,
  releaseAllCollaborationLeasesV2,
  releaseCollaborationLeaseV2,
  renewCollaborationLeaseV2,
} from '../../server/collaboration/lease';
import {
  encodeCollaborationLeaseClientMessageV2,
  isCollaborationLeaseClientMessageV2,
  isCollaborationLeaseTargetV2,
  parseCollaborationLeaseServerMessageV2,
} from '../services/collaboration/CollaborationLeaseProtocol';

const statementTarget = { kind: 'statement' as const, statementId: 'perf_1' };
const companionTarget = { kind: 'companion' as const, statementId: 'line_1', companionId: 'cmp_motion' };

describe('collaboration lease registry', () => {
  it('grants a lease to the first requester and denies a different client', () => {
    const registry = createCollaborationLeaseRegistryV2<number>();
    const first = acquireCollaborationLeaseV2(registry, 1, 'alice', 'req-1', statementTarget, 1000);
    expect(first.granted).toBe(true);

    const second = acquireCollaborationLeaseV2(registry, 2, 'bob', 'req-2', statementTarget, 1001);
    expect(second.granted).toBe(false);
    if (!second.granted) expect(second.heldByClientId).toBe('alice');
  });

  it('re-acquires the lease for the same client (renewal style)', () => {
    const registry = createCollaborationLeaseRegistryV2<number>();
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'req-1', statementTarget, 1000);
    const again = acquireCollaborationLeaseV2(registry, 1, 'alice', 'req-2', statementTarget, 1001);
    expect(again.granted).toBe(true);
  });

  it('renews only the matching holder and request id', () => {
    const registry = createCollaborationLeaseRegistryV2<number>();
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'req-1', statementTarget, 1000);

    expect(renewCollaborationLeaseV2(registry, 1, 'alice', 'req-1', statementTarget, 2000)).toBe(true);
    expect(renewCollaborationLeaseV2(registry, 1, 'alice', 'wrong-req', statementTarget, 2001)).toBe(false);
    expect(renewCollaborationLeaseV2(registry, 2, 'bob', 'req-1', statementTarget, 2002)).toBe(false);
  });

  it('releases only the holding client and acquisition request', () => {
    const registry = createCollaborationLeaseRegistryV2<number>();
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'req-1', statementTarget, 1000);

    expect(releaseCollaborationLeaseV2(registry, 2, 'bob', statementTarget, 'req-1')).toBe(false);
    expect(releaseCollaborationLeaseV2(registry, 1, 'alice', statementTarget, 'wrong-req')).toBe(false);
    expect(releaseCollaborationLeaseV2(registry, 1, 'alice', statementTarget, 'req-1')).toBe(true);
    expect(releaseCollaborationLeaseV2(registry, 1, 'alice', statementTarget, 'req-1')).toBe(false);
  });

  it.each([statementTarget, companionTarget])('keeps a new request held after a cancelled request releases late: %j', (target) => {
    const registry = createCollaborationLeaseRegistryV2<number>();
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'request-A', target, 1000);
    expect(releaseCollaborationLeaseV2(registry, 1, 'alice', target, 'request-A')).toBe(true);
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'request-B', target, 2000);

    expect(releaseCollaborationLeaseV2(registry, 1, 'alice', target, 'request-A')).toBe(false);
    expect(renewCollaborationLeaseV2(registry, 1, 'alice', 'request-A', target, 3000)).toBe(false);
    const key = encodeCollaborationLeaseTargetV2(target);
    expect(registry.leasesByTarget.get(key)).toMatchObject({ requestId: 'request-B', lastRenewedAt: 2000 });
    expect(registry.leasesBySocket.get(1)?.has(key)).toBe(true);
    expect(acquireCollaborationLeaseV2(registry, 2, 'bob', 'request-C', target, 3001))
      .toEqual({ granted: false, heldByClientId: 'alice' });
    expect(renewCollaborationLeaseV2(registry, 1, 'alice', 'request-B', target, 4000)).toBe(true);
    expect(releaseCollaborationLeaseV2(registry, 1, 'alice', target, 'request-B')).toBe(true);
  });

  it('updates ownership when the same client supersedes its acquisition request', () => {
    const registry = createCollaborationLeaseRegistryV2<number>();
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'request-A', statementTarget, 1000);
    const next = acquireCollaborationLeaseV2(registry, 1, 'alice', 'request-B', statementTarget, 2000);
    expect(next.granted).toBe(true);
    expect(registry.leasesByTarget.get(encodeCollaborationLeaseTargetV2(statementTarget)))
      .toMatchObject({ requestId: 'request-B', lastRenewedAt: 2000 });
    expect(releaseCollaborationLeaseV2(registry, 1, 'alice', statementTarget, 'request-A')).toBe(false);
    expect(renewCollaborationLeaseV2(registry, 1, 'alice', 'request-A', statementTarget, 3000)).toBe(false);
    expect(renewCollaborationLeaseV2(registry, 1, 'alice', 'request-B', statementTarget, 4000)).toBe(true);
  });

  it('releases all leases held by a disconnected socket', () => {
    const registry = createCollaborationLeaseRegistryV2<number>();
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'req-1', statementTarget, 1000);
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'req-2', companionTarget, 1000);

    const released = releaseAllCollaborationLeasesV2(registry, 1);
    expect(released).toHaveLength(2);

    const retry = acquireCollaborationLeaseV2(registry, 2, 'bob', 'req-3', statementTarget, 1001);
    expect(retry.granted).toBe(true);
  });

  it.each([statementTarget, companionTarget])('transfers socket ownership so an old disconnect cannot release the replacement: %j', (target) => {
    const registry = createCollaborationLeaseRegistryV2<number>();
    const other = target.kind === 'statement' ? companionTarget : statementTarget;
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'request-A', target, 1000);
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'other-request', other, 1000);
    acquireCollaborationLeaseV2(registry, 2, 'alice', 'request-B', target, 2000);
    const key = encodeCollaborationLeaseTargetV2(target);
    expect(registry.leasesBySocket.get(1)?.has(key)).toBe(false);
    expect(registry.leasesBySocket.get(2)?.has(key)).toBe(true);

    expect(releaseAllCollaborationLeasesV2(registry, 1).map((record) => record.target)).toEqual([other]);
    expect(registry.leasesByTarget.get(key)).toMatchObject({ requestId: 'request-B', lastRenewedAt: 2000 });
    expect(acquireCollaborationLeaseV2(registry, 3, 'bob', 'request-C', target, 3000))
      .toEqual({ granted: false, heldByClientId: 'alice' });
    expect(releaseAllCollaborationLeasesV2(registry, 2).map((record) => record.target)).toEqual([target]);
  });

  it('ignores stale socket-index entries when releasing all leases', () => {
    const registry = createCollaborationLeaseRegistryV2<number>();
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'request-A', statementTarget, 1000);
    acquireCollaborationLeaseV2(registry, 2, 'alice', 'request-B', statementTarget, 2000);
    const key = encodeCollaborationLeaseTargetV2(statementTarget);
    registry.leasesBySocket.set(1, new Set([key]));
    expect(releaseAllCollaborationLeasesV2(registry, 1)).toEqual([]);
    expect(registry.leasesByTarget.get(key)).toMatchObject({ requestId: 'request-B' });
    expect(registry.leasesBySocket.get(2)?.has(key)).toBe(true);
  });

  it('rejects acquire, renew and release from a different socket even with matching client and request IDs', () => {
    const registry = createCollaborationLeaseRegistryV2<number>();
    acquireCollaborationLeaseV2(registry, 2, 'alice', 'request-B', statementTarget, 2000);
    expect(acquireCollaborationLeaseV2(registry, 1, 'alice', 'request-B', statementTarget, 3000))
      .toEqual({ granted: false, heldByClientId: 'alice' });
    expect(renewCollaborationLeaseV2(registry, 1, 'alice', 'request-B', statementTarget, 4000)).toBe(false);
    expect(releaseCollaborationLeaseV2(registry, 1, 'alice', statementTarget, 'request-B')).toBe(false);
    expect(registry.leasesByTarget.get(encodeCollaborationLeaseTargetV2(statementTarget)))
      .toMatchObject({ requestId: 'request-B', lastRenewedAt: 2000 });
    expect(renewCollaborationLeaseV2(registry, 2, 'alice', 'request-B', statementTarget, 5000)).toBe(true);
    expect(releaseCollaborationLeaseV2(registry, 2, 'alice', statementTarget, 'request-B')).toBe(true);
  });

  it('expires leases after the disconnect timeout and keeps fresh ones', () => {
    const registry = createCollaborationLeaseRegistryV2<number>();
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'req-1', statementTarget, 1000);
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'req-2', companionTarget, 2000);

    const expired = expireCollaborationLeasesV2(registry, 1000 + 30_000, 30_000);
    expect(expired.map((record) => record.target.kind)).toEqual(['statement']);
    expect(registry.leasesByTarget.has(encodeCollaborationLeaseTargetV2(companionTarget))).toBe(true);
  });

  it('encodes and decodes lease target keys', () => {
    expect(encodeCollaborationLeaseTargetV2(statementTarget)).toBe('statement:perf_1');
    expect(encodeCollaborationLeaseTargetV2(companionTarget)).toBe('companion:line_1:cmp_motion');
    expect(decodeCollaborationLeaseTargetV2('statement:perf_1')).toEqual(statementTarget);
    expect(decodeCollaborationLeaseTargetV2('companion:line_1:cmp_motion')).toEqual(companionTarget);
    expect(decodeCollaborationLeaseTargetV2('bogus')).toBeNull();
  });
});

describe('collaboration lease protocol', () => {
  it('validates lease targets', () => {
    expect(isCollaborationLeaseTargetV2(statementTarget)).toBe(true);
    expect(isCollaborationLeaseTargetV2(companionTarget)).toBe(true);
    expect(isCollaborationLeaseTargetV2({ kind: 'statement', statementId: '' })).toBe(false);
    expect(isCollaborationLeaseTargetV2({ kind: 'companion', statementId: 'a', companionId: '' })).toBe(false);
    expect(isCollaborationLeaseTargetV2({ kind: 'scene' })).toBe(false);
  });

  it('validates client messages', () => {
    const acquire = encodeCollaborationLeaseClientMessageV2({
      type: 'lease:acquire',
      requestId: 'req-1',
      target: statementTarget,
    });
    expect(isCollaborationLeaseClientMessageV2(JSON.parse(acquire))).toBe(true);

    expect(isCollaborationLeaseClientMessageV2({ type: 'lease:bogus', requestId: 'r', target: statementTarget, schemaVersion: 2 })).toBe(false);
    expect(isCollaborationLeaseClientMessageV2({ type: 'lease:acquire', requestId: '', target: statementTarget, schemaVersion: 2 })).toBe(false);
    expect(isCollaborationLeaseClientMessageV2({ type: 'lease:acquire', requestId: 'r', target: { kind: 'scene' }, schemaVersion: 2 })).toBe(false);
  });

  it('parses server responses', () => {
    const acquired = parseCollaborationLeaseServerMessageV2(JSON.stringify({
      type: 'lease:acquired',
      schemaVersion: 2,
      requestId: 'req-1',
      target: statementTarget,
    }));
    expect(acquired).toEqual({
      type: 'lease:acquired',
      schemaVersion: 2,
      requestId: 'req-1',
      target: statementTarget,
    });

    const denied = parseCollaborationLeaseServerMessageV2(JSON.stringify({
      type: 'lease:denied',
      schemaVersion: 2,
      requestId: 'req-2',
      target: companionTarget,
      heldByClientId: 'alice',
    }));
    expect(denied?.type).toBe('lease:denied');
    if (denied?.type === 'lease:denied') expect(denied.heldByClientId).toBe('alice');

    expect(parseCollaborationLeaseServerMessageV2('not json')).toBeNull();
    expect(parseCollaborationLeaseServerMessageV2(JSON.stringify({ type: 'lease:acquired', schemaVersion: 2 }))).toBeNull();
  });
});

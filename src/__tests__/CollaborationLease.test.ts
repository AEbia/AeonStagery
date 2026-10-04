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

  it('releases only the holding client', () => {
    const registry = createCollaborationLeaseRegistryV2<number>();
    acquireCollaborationLeaseV2(registry, 1, 'alice', 'req-1', statementTarget, 1000);

    expect(releaseCollaborationLeaseV2(registry, 2, 'bob', statementTarget)).toBe(false);
    expect(releaseCollaborationLeaseV2(registry, 1, 'alice', statementTarget)).toBe(true);
    expect(releaseCollaborationLeaseV2(registry, 1, 'alice', statementTarget)).toBe(false);
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

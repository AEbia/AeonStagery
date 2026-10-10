import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CollaborationConnectionStatus,
  CollaborationLeaseServerMessageV3,
  CollaborationLeaseTargetV3,
} from '../api/types/collaboration';
import {
  CollaborationClientCustomMotionEditAuthority,
  InMemoryCustomMotionEditAuthority,
  type CustomMotionEditAuthority,
  type CustomMotionLeaseClient,
  type HeldCustomMotionLease,
  type LeaseDecision,
} from '../services/timeline-authoring/CustomMotionEditAuthority';

const target = (statementId = 'perf-1'): CollaborationLeaseTargetV3 => ({ kind: 'statement', statementId });
const companion = (statementId = 'dialogue-1', companionId = 'perf-2'): CollaborationLeaseTargetV3 => (
  { kind: 'companion', statementId, companionId }
);

function granted(decision: LeaseDecision): HeldCustomMotionLease {
  expect(decision.status).toBe('granted');
  if (decision.status !== 'granted') throw new Error('Expected a granted lease');
  return decision.lease;
}

const authorities: CustomMotionEditAuthority[] = [];
function harness() {
  let receipt: ((message: CollaborationLeaseServerMessageV3) => void) | undefined;
  let status: ((value: CollaborationConnectionStatus) => void) | undefined;
  const unsubscribeLease = vi.fn(() => { receipt = undefined; });
  const unsubscribeStatus = vi.fn(() => { status = undefined; });
  const client = {
    subscribeLease: vi.fn<CustomMotionLeaseClient['subscribeLease']>((listener) => {
      receipt = listener;
      return unsubscribeLease;
    }),
    subscribeRealtimeStatus: vi.fn((listener: (value: CollaborationConnectionStatus) => void) => {
      status = listener;
      return unsubscribeStatus;
    }),
    acquireLease: vi.fn(),
    renewLease: vi.fn(),
    releaseLease: vi.fn(),
  };
  let nextRequest = 0;
  const authority = new CollaborationClientCustomMotionEditAuthority(client, {
    requestId: () => `request-${++nextRequest}`,
    acquireTimeoutMs: 100,
    renewIntervalMs: 20,
  });
  authorities.push(authority);
  return {
    authority, client, unsubscribeLease, unsubscribeStatus,
    receipt: (message: CollaborationLeaseServerMessageV3) => receipt?.(message),
    status: (value: CollaborationConnectionStatus) => status?.(value),
    acquire: (value = target(), signal = new AbortController().signal) => authority.acquire(value, signal),
    grant: (value = target(), requestId = 'request-1') => receipt?.({
      type: 'lease:acquired', schemaVersion: 3, requestId, target: value,
    }),
    deny: (value = target(), requestId = 'request-1') => receipt?.({
      type: 'lease:denied', schemaVersion: 3, requestId, target: value, heldByClientId: 'other-client',
    }),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const authority of authorities.splice(0)) authority.dispose();
  vi.useRealTimers();
});

describe('InMemoryCustomMotionEditAuthority', () => {
  it('grants one opaque lease, rejects overlapping ownership and ignores foreign releases', async () => {
    const authority = new InMemoryCustomMotionEditAuthority();
    authorities.push(authority);
    const signal = new AbortController().signal;
    const lease = granted(await authority.acquire(target(), signal));
    await expect(authority.acquire(companion(), signal)).resolves.toEqual({ status: 'denied', reason: 'lease-denied' });
    await authority.release(Object.freeze({}) as HeldCustomMotionLease);
    await expect(authority.acquire(target(), signal)).resolves.toMatchObject({ status: 'denied' });
    await authority.release(lease);
    await authority.release(lease);
    const next = granted(await authority.acquire(companion(), signal));
    expect(next).not.toBe(lease);
    await authority.release(lease);
    await expect(authority.acquire(target(), signal)).resolves.toMatchObject({ status: 'denied' });
  });

  it('rejects pre-aborted or disposed acquires and notifies disposal once', async () => {
    const authority = new InMemoryCustomMotionEditAuthority();
    authorities.push(authority);
    await expect(authority.acquire(target(), AbortSignal.abort())).resolves.toEqual({ status: 'denied', reason: 'cancelled' });
    const lease = granted(await authority.acquire(target(), new AbortController().signal));
    const lost = vi.fn();
    const unsubscribed = vi.fn();
    authority.onLoss(lease, lost);
    authority.onLoss(lease, unsubscribed)();
    authority.dispose();
    authority.dispose();
    expect(lost).toHaveBeenCalledExactlyOnceWith('disposed');
    expect(unsubscribed).not.toHaveBeenCalled();
    await expect(authority.acquire(target(), new AbortController().signal)).resolves.toMatchObject({ status: 'denied' });
  });

  it('reports an already-released token as lost, matching the production adapter contract', async () => {
    const authority = new InMemoryCustomMotionEditAuthority();
    authorities.push(authority);
    const lease = granted(await authority.acquire(target(), new AbortController().signal));
    await authority.release(lease);
    const lost = vi.fn();
    authority.onLoss(lease, lost)();
    expect(lost).toHaveBeenCalledExactlyOnceWith('lease-lost');
  });

  it('keeps stale unsubscriptions from removing an observer attached to a newer lease', async () => {
    const authority = new InMemoryCustomMotionEditAuthority();
    authorities.push(authority);
    const signal = new AbortController().signal;
    const first = granted(await authority.acquire(target(), signal));
    const lost = vi.fn();
    const unsubscribeFirst = authority.onLoss(first, lost);
    await authority.release(first);
    const second = granted(await authority.acquire(companion(), signal));
    authority.onLoss(second, lost);
    unsubscribeFirst();
    authority.dispose();
    expect(lost).toHaveBeenCalledExactlyOnceWith('disposed');
  });
});

describe('CollaborationClientCustomMotionEditAuthority', () => {
  it('requires a matching request ID and complete companion target before granting', async () => {
    const h = harness();
    const pending = h.acquire(companion());
    const settled = vi.fn();
    void pending.then(settled);
    h.grant(companion(), 'unrelated');
    h.grant(companion('other-parent'));
    h.grant(companion('dialogue-1', 'other-companion'));
    h.grant(target('dialogue-1'));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    h.grant(companion());
    const lease = granted(await pending);
    expect(h.client.acquireLease).toHaveBeenCalledExactlyOnceWith('request-1', companion());
    await h.authority.release(lease);
    expect(h.client.releaseLease).toHaveBeenCalledExactlyOnceWith('request-1', companion());
  });

  it('denies conflicts without creating renewable ownership', async () => {
    const h = harness();
    const pending = h.acquire();
    h.deny();
    await expect(pending).resolves.toEqual({ status: 'denied', reason: 'lease-denied' });
    vi.advanceTimersByTime(200);
    expect(h.client.renewLease).not.toHaveBeenCalled();
    expect(h.client.releaseLease).toHaveBeenCalledExactlyOnceWith('request-1', target());
  });

  it('times out and releases a matching grant that arrives after the deadline', async () => {
    const h = harness();
    const pending = h.acquire();
    vi.advanceTimersByTime(100);
    await expect(pending).resolves.toEqual({ status: 'denied', reason: 'timeout' });
    h.grant();
    expect(h.client.releaseLease).toHaveBeenCalledTimes(2);
    expect(h.client.releaseLease).toHaveBeenLastCalledWith('request-1', target());
    vi.advanceTimersByTime(200);
    expect(h.client.renewLease).not.toHaveBeenCalled();
  });

  it('rejects an aborted request and releases its late grant without affecting the next request', async () => {
    const h = harness();
    const controller = new AbortController();
    const old = h.acquire(target('old'), controller.signal);
    controller.abort();
    await expect(old).resolves.toEqual({ status: 'denied', reason: 'cancelled' });
    const pending = h.acquire(target('next'));
    h.grant(target('old'));
    h.grant(target('next'), 'request-2');
    const lease = granted(await pending);
    const lost = vi.fn();
    h.authority.onLoss(lease, lost);
    expect(h.client.releaseLease.mock.calls).toEqual([
      ['request-1', target('old')], ['request-1', target('old')],
    ]);
    vi.advanceTimersByTime(20);
    expect(h.client.renewLease).toHaveBeenCalledExactlyOnceWith('request-2', target('next'));
    expect(lost).not.toHaveBeenCalled();
  });

  it('ignores mismatched targets on abandoned receipts and still releases the genuine late grant', async () => {
    const h = harness();
    const controller = new AbortController();
    const pending = h.acquire(companion(), controller.signal);
    controller.abort();
    await pending;
    h.grant(companion('different-parent'));
    h.deny(companion('dialogue-1', 'different-companion'));
    expect(h.client.releaseLease).toHaveBeenCalledTimes(1);
    h.grant(companion());
    expect(h.client.releaseLease).toHaveBeenCalledTimes(2);
    expect(h.client.releaseLease).toHaveBeenLastCalledWith('request-1', companion());
  });

  it('does not send an acquire for a pre-aborted signal or disposed adapter', async () => {
    const h = harness();
    await expect(h.acquire(target(), AbortSignal.abort())).resolves.toMatchObject({ status: 'denied', reason: 'cancelled' });
    h.authority.dispose();
    await expect(h.acquire()).resolves.toMatchObject({ status: 'denied', reason: 'cancelled' });
    expect(h.client.acquireLease).not.toHaveBeenCalled();
  });

  it('renews using the acquire ID and accepts the real V3 acquired renewal receipt', async () => {
    const h = harness();
    const pending = h.acquire();
    h.grant();
    const lease = granted(await pending);
    const lost = vi.fn();
    h.authority.onLoss(lease, lost);
    vi.advanceTimersByTime(20);
    expect(h.client.renewLease).toHaveBeenCalledExactlyOnceWith('request-1', target());
    h.grant();
    vi.advanceTimersByTime(20);
    expect(h.client.renewLease).toHaveBeenCalledTimes(2);
    expect(lost).not.toHaveBeenCalled();
    expect(h.client.releaseLease).not.toHaveBeenCalled();
    // The acquisition deadline no longer applies after a successful grant.
    vi.advanceTimersByTime(100);
    expect(lost).not.toHaveBeenCalled();
  });

  it('notifies denial of renewal once and stops renewal', async () => {
    const h = harness();
    const pending = h.acquire();
    h.grant();
    const lease = granted(await pending);
    const lost = vi.fn();
    h.authority.onLoss(lease, lost);
    h.deny(target('unrelated'));
    expect(lost).not.toHaveBeenCalled();
    h.deny();
    h.deny();
    expect(lost).toHaveBeenCalledExactlyOnceWith('lease-lost');
    vi.advanceTimersByTime(200);
    expect(h.client.renewLease).not.toHaveBeenCalled();
    await h.authority.release(lease);
    expect(h.client.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('revokes only the complete target identified by a V3 release broadcast', async () => {
    const h = harness();
    const pending = h.acquire(companion());
    h.grant(companion());
    const lease = granted(await pending);
    const lost = vi.fn();
    h.authority.onLoss(lease, lost);
    h.receipt({ type: 'lease:released', schemaVersion: 3, target: companion('other-parent') });
    h.receipt({ type: 'lease:released', schemaVersion: 3, target: companion('dialogue-1', 'other-companion') });
    h.receipt({ type: 'lease:released', schemaVersion: 3, target: target('dialogue-1') });
    expect(lost).not.toHaveBeenCalled();
    h.receipt({ type: 'lease:released', schemaVersion: 3, target: companion() });
    expect(lost).toHaveBeenCalledExactlyOnceWith('lease-lost');
    vi.advanceTimersByTime(200);
    expect(h.client.renewLease).not.toHaveBeenCalled();
  });

  it('releases exactly once without loss notifications and ignores stale or foreign ownership', async () => {
    const h = harness();
    const pending = h.acquire();
    h.grant();
    const lease = granted(await pending);
    const lost = vi.fn();
    h.authority.onLoss(lease, lost);
    await h.authority.release(Object.freeze({}) as HeldCustomMotionLease);
    expect(h.client.releaseLease).not.toHaveBeenCalled();
    await h.authority.release(lease);
    await h.authority.release(lease);
    h.authority.dispose();
    vi.advanceTimersByTime(200);
    expect(h.client.releaseLease).toHaveBeenCalledExactlyOnceWith('request-1', target());
    expect(h.client.renewLease).not.toHaveBeenCalled();
    expect(lost).not.toHaveBeenCalled();
  });

  it('unsubscribes loss observers and immediately reports an already-lost token', async () => {
    const h = harness();
    const pending = h.acquire();
    h.grant();
    const lease = granted(await pending);
    const removed = vi.fn();
    h.authority.onLoss(lease, removed)();
    h.deny();
    expect(removed).not.toHaveBeenCalled();
    const lost = vi.fn();
    h.authority.onLoss(lease, lost)();
    expect(lost).toHaveBeenCalledExactlyOnceWith('lease-lost');
  });

  it('disconnects pending and held requests and cleans up without double release', async () => {
    const h = harness();
    const pending = h.acquire();
    h.grant();
    const lease = granted(await pending);
    const lost = vi.fn();
    h.authority.onLoss(lease, lost);
    const second = h.acquire(companion());
    h.status('connected');
    expect(lost).not.toHaveBeenCalled();
    h.status('disconnected');
    await expect(second).resolves.toEqual({ status: 'denied', reason: 'disconnected' });
    expect(lost).toHaveBeenCalledExactlyOnceWith('disconnected');
    h.status('disconnected');
    h.authority.dispose();
    h.authority.dispose();
    expect(h.client.releaseLease.mock.calls).toEqual([
      ['request-1', target()], ['request-2', companion()],
    ]);
    expect(h.unsubscribeLease).toHaveBeenCalledTimes(1);
    expect(h.unsubscribeStatus).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(h.client.renewLease).not.toHaveBeenCalled();
  });

  it('disposes pending and held requests, stopping renewal and notifying held ownership', async () => {
    const h = harness();
    const pending = h.acquire();
    h.grant();
    const lease = granted(await pending);
    const lost = vi.fn();
    h.authority.onLoss(lease, lost);
    const second = h.acquire(companion());
    h.authority.dispose();
    await expect(second).resolves.toEqual({ status: 'denied', reason: 'disposed' });
    expect(lost).toHaveBeenCalledExactlyOnceWith('disposed');
    expect(h.client.releaseLease).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(200);
    expect(h.client.renewLease).not.toHaveBeenCalled();
  });

  it('turns transport exceptions into disconnection and tolerates failed releases', async () => {
    const h = harness();
    h.client.acquireLease.mockImplementationOnce(() => { throw new Error('offline'); });
    await expect(h.acquire()).resolves.toEqual({ status: 'denied', reason: 'disconnected' });
    const pending = h.acquire();
    h.grant(target(), 'request-2');
    const lease = granted(await pending);
    const lost = vi.fn();
    h.authority.onLoss(lease, lost);
    h.client.renewLease.mockImplementationOnce(() => { throw new Error('offline'); });
    h.client.releaseLease.mockImplementation(() => { throw new Error('offline'); });
    vi.advanceTimersByTime(20);
    expect(lost).toHaveBeenCalledExactlyOnceWith('disconnected');
    await expect(h.authority.release(lease)).resolves.toBeUndefined();
    vi.advanceTimersByTime(200);
    expect(h.client.renewLease).toHaveBeenCalledTimes(1);
  });
});

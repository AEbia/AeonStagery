import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CollaborationLeaseServerMessageV2,
  CollaborationLeaseServerMessageV3,
  CollaborationLeaseTargetV2,
} from '../api/types/collaboration';
import {
  CollaborationClientCustomMotionEditLeaseGate,
} from '../services/timeline-authoring/CustomMotionEditLeaseGate';

function target(statementId = 'perf-1'): CollaborationLeaseTargetV2 {
  return { kind: 'statement', statementId };
}

function companionTarget(statementId = 'perf-1', companionId = 'comp-1'): CollaborationLeaseTargetV2 {
  return { kind: 'companion', statementId, companionId };
}

describe('CollaborationClientCustomMotionEditLeaseGate', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves an acquire only from the matching requestId receipt', async () => {
    let listener: ((message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) | undefined;
    const client = {
      subscribeLease: vi.fn((next: (message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) => {
        listener = next;
        return () => { listener = undefined; };
      }),
      acquireLease: vi.fn(),
      renewLease: vi.fn(),
      releaseLease: vi.fn(),
    };
    const gate = new CollaborationClientCustomMotionEditLeaseGate(client, {
      requestId: () => 'request-1',
      acquireTimeoutMs: 100,
      renewIntervalMs: 1_000,
    });

    const pending = gate.acquire(target());
    expect(client.acquireLease).toHaveBeenCalledWith('request-1', target());
    listener?.({
      type: 'lease:acquired',
      schemaVersion: 2,
      requestId: 'other-request',
      target: target(),
    });
    expect(await Promise.race([pending, Promise.resolve('pending')])).toBe('pending');

    listener?.({
      type: 'lease:acquired',
      schemaVersion: 2,
      requestId: 'request-1',
      target: target(),
    });
    await expect(pending).resolves.toBe(true);
    gate.dispose();
  });

  it('acquires and holds a lease using v3 lease protocol', async () => {
    let listener: ((message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) | undefined;
    const client = {
      subscribeLease: vi.fn((next: (message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) => {
        listener = next;
        return () => { listener = undefined; };
      }),
      acquireLease: vi.fn(),
      renewLease: vi.fn(),
      releaseLease: vi.fn(),
    };
    const gate = new CollaborationClientCustomMotionEditLeaseGate(client, {
      requestId: () => 'req-v3-1',
      acquireTimeoutMs: 200,
      renewIntervalMs: 1_000,
    });

    const t = companionTarget('stmt-1', 'comp-1');
    expect(gate.getState(t)).toBe('unavailable');

    const pending = gate.acquire(t);
    expect(gate.getState(t)).toBe('pending');
    expect(client.acquireLease).toHaveBeenCalledWith('req-v3-1', t);

    // V3 server message
    listener?.({
      type: 'lease:acquired',
      schemaVersion: 3,
      requestId: 'req-v3-1',
      target: t,
    });

    await expect(pending).resolves.toBe(true);
    expect(gate.getState(t)).toBe('held');

    // Acquiring again while held returns true immediately without re-requesting
    client.acquireLease.mockClear();
    await expect(gate.acquire(t)).resolves.toBe(true);
    expect(client.acquireLease).not.toHaveBeenCalled();

    gate.dispose();
  });

  it('handles conflict rejection (lease:denied) in v3 by setting state to denied and resolving false', async () => {
    let listener: ((message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) | undefined;
    const client = {
      subscribeLease: (next: (message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) => {
        listener = next;
        return () => { listener = undefined; };
      },
      acquireLease: vi.fn(),
      renewLease: vi.fn(),
      releaseLease: vi.fn(),
    };
    const gate = new CollaborationClientCustomMotionEditLeaseGate(client, {
      requestId: () => 'req-conflict',
      acquireTimeoutMs: 200,
    });

    const t = target('perf-conflict');
    const pending = gate.acquire(t);
    expect(gate.getState(t)).toBe('pending');

    listener?.({
      type: 'lease:denied',
      schemaVersion: 3,
      requestId: 'req-conflict',
      target: t,
      heldByClientId: 'other-user',
    });

    await expect(pending).resolves.toBe(false);
    expect(gate.getState(t)).toBe('denied');
    expect(client.releaseLease).toHaveBeenCalledWith('req-conflict', t);

    gate.dispose();
  });

  it('releases a held lease using its acquire requestId', async () => {
    let listener: ((message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) | undefined;
    const client = {
      subscribeLease: (next: (message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) => {
        listener = next;
        return () => { listener = undefined; };
      },
      acquireLease: vi.fn(),
      renewLease: vi.fn(),
      releaseLease: vi.fn(),
    };
    const gate = new CollaborationClientCustomMotionEditLeaseGate(client, {
      requestId: () => 'request-2',
      acquireTimeoutMs: 100,
      renewIntervalMs: 1_000,
    });
    const pending = gate.acquire(target('perf-2'));
    listener?.({ type: 'lease:acquired', schemaVersion: 3, requestId: 'request-2', target: target('perf-2') });
    await expect(pending).resolves.toBe(true);
    expect(gate.getState(target('perf-2'))).toBe('held');

    gate.release(target('perf-2'));
    expect(client.releaseLease).toHaveBeenCalledWith('request-2', target('perf-2'));
    expect(gate.getState(target('perf-2'))).toBe('unavailable');
    gate.dispose();
  });

  it('handles server broadcast lease:released to clear held state', async () => {
    let listener: ((message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) | undefined;
    const client = {
      subscribeLease: (next: (message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) => {
        listener = next;
        return () => { listener = undefined; };
      },
      acquireLease: vi.fn(),
      renewLease: vi.fn(),
      releaseLease: vi.fn(),
    };
    const gate = new CollaborationClientCustomMotionEditLeaseGate(client, {
      requestId: () => 'req-released',
      acquireTimeoutMs: 100,
      renewIntervalMs: 1_000,
    });
    const t = target('perf-rel');
    const pending = gate.acquire(t);
    listener?.({ type: 'lease:acquired', schemaVersion: 3, requestId: 'req-released', target: t });
    await expect(pending).resolves.toBe(true);
    expect(gate.getState(t)).toBe('held');

    // Server broadcasts release
    listener?.({ type: 'lease:released', schemaVersion: 3, target: t });
    expect(gate.getState(t)).toBe('unavailable');
    gate.dispose();
  });

  it('renews a held lease while the critical section remains active', async () => {
    vi.useFakeTimers();
    let listener: ((message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) | undefined;
    const client = {
      subscribeLease: (next: (message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) => {
        listener = next;
        return () => { listener = undefined; };
      },
      acquireLease: vi.fn(),
      renewLease: vi.fn(),
      releaseLease: vi.fn(),
    };
    const gate = new CollaborationClientCustomMotionEditLeaseGate(client, {
      requestId: () => 'request-renew',
      acquireTimeoutMs: 100,
      renewIntervalMs: 10,
    });
    const pending = gate.acquire(target('perf-renew'));
    listener?.({ type: 'lease:acquired', schemaVersion: 3, requestId: 'request-renew', target: target('perf-renew') });
    await expect(pending).resolves.toBe(true);

    vi.advanceTimersByTime(10);
    expect(client.renewLease).toHaveBeenCalledWith('request-renew', target('perf-renew'));
    gate.dispose();
  });

  it('cleans up all held leases and cancels pending acquires on dispose/disconnect', async () => {
    let listener: ((message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) | undefined;
    const client = {
      subscribeLease: (next: (message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void) => {
        listener = next;
        return () => { listener = undefined; };
      },
      acquireLease: vi.fn(),
      renewLease: vi.fn(),
      releaseLease: vi.fn(),
    };
    let count = 0;
    const gate = new CollaborationClientCustomMotionEditLeaseGate(client, {
      requestId: () => `req-${++count}`,
      acquireTimeoutMs: 500,
      renewIntervalMs: 100,
    });

    const tHeld = target('held-1');
    const p1 = gate.acquire(tHeld);
    listener?.({ type: 'lease:acquired', schemaVersion: 3, requestId: 'req-1', target: tHeld });
    await expect(p1).resolves.toBe(true);

    const tPending = target('pending-1');
    const p2 = gate.acquire(tPending);

    gate.dispose();

    expect(await p2).toBe(false);
    expect(client.releaseLease).toHaveBeenCalledWith('req-1', tHeld);
    expect(gate.getState(tHeld)).toBe('unavailable');
    expect(gate.getState(tPending)).toBe('unavailable');
  });
});

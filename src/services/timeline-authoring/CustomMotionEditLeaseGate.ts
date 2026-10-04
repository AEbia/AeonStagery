import type {
  CollaborationLeaseServerMessageV2,
  CollaborationLeaseServerMessageV3,
  CollaborationLeaseTargetV2,
  CollaborationLeaseTargetV3,
} from '../../api/types/collaboration';

/**
 * Collaboration edit lease gate for custom motion authoring (ADR-0028/ADR-0029).
 *
 * The server arbitrates the only lease holder for a `characterPerformance`
 * source entity. Commands that mutate a custom motion must hold the lease for
 * the target entity before applying local changes; without a lease the write
 * must be refused. A `null` gate (single-player mode) skips the check.
 */
export interface CustomMotionEditLeaseGate {
  /**
   * Request the scoped edit lease and resolve once the server has granted or
   * denied it. Returns true only when this client is the lease holder.
   */
  acquire(target: CollaborationLeaseTargetV2 | CollaborationLeaseTargetV3): Promise<boolean>;
  /** Actively release the lease (e.g. leaving keyframe editing). */
  release(target: CollaborationLeaseTargetV2 | CollaborationLeaseTargetV3): void;
  getState?(target: CollaborationLeaseTargetV2 | CollaborationLeaseTargetV3): CustomMotionLeaseState;
  subscribe?(listener: () => void): () => void;
}

export type CustomMotionLeaseState = 'unavailable' | 'pending' | 'held' | 'denied';

export interface CustomMotionLeaseClientPort {
  subscribeLease(listener: (message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3) => void): () => void;
  acquireLease(requestId: string, target: CollaborationLeaseTargetV2 | CollaborationLeaseTargetV3): void;
  renewLease(requestId: string, target: CollaborationLeaseTargetV2 | CollaborationLeaseTargetV3): void;
  releaseLease(requestId: string, target: CollaborationLeaseTargetV2 | CollaborationLeaseTargetV3): void;
}

export interface CollaborationClientCustomMotionEditLeaseGateOptions {
  requestId?: () => string;
  acquireTimeoutMs?: number;
  renewIntervalMs?: number;
}

interface LeaseRecord {
  readonly requestId: string;
  readonly target: CollaborationLeaseTargetV2;
  readonly timer: ReturnType<typeof setInterval> | null;
}

interface PendingAcquire {
  readonly requestId: string;
  readonly target: CollaborationLeaseTargetV2;
  readonly promise: Promise<boolean>;
  resolve: (acquired: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function targetKey(target: CollaborationLeaseTargetV2): string {
  return target.kind === 'companion'
    ? `companion:${target.statementId}:${target.companionId}`
    : `statement:${target.statementId}`;
}

function defaultRequestId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `motion-lease-${crypto.randomUUID()}`;
  return `motion-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Client-side adapter that turns CollaborationClientV2 lease events into the
 * command-layer gate. It deliberately matches receipts by requestId because
 * lease:released is broadcast to every peer and stale responses can arrive
 * after a reconnect. */
export class CollaborationClientCustomMotionEditLeaseGate implements CustomMotionEditLeaseGate {
  private readonly requestIdFactory: () => string;
  private readonly acquireTimeoutMs: number;
  private readonly renewIntervalMs: number;
  private readonly pending = new Map<string, PendingAcquire>();
  private readonly held = new Map<string, LeaseRecord>();
  private readonly states = new Map<string, CustomMotionLeaseState>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly client: CustomMotionLeaseClientPort,
    options: CollaborationClientCustomMotionEditLeaseGateOptions = {},
  ) {
    this.requestIdFactory = options.requestId ?? defaultRequestId;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 10_000;
    this.renewIntervalMs = options.renewIntervalMs ?? 10_000;
    this.unsubscribe = client.subscribeLease((message) => this.handleLeaseMessage(message));
  }

  acquire(target: CollaborationLeaseTargetV2): Promise<boolean> {
    const key = targetKey(target);
    if (this.held.has(key)) return Promise.resolve(true);
    const existing = this.pending.get(key);
    if (existing) return existing.promise;

    const requestId = this.requestIdFactory();
    let resolvePending!: (acquired: boolean) => void;
    const promise = new Promise<boolean>((resolve) => { resolvePending = resolve; });
    const pending: PendingAcquire = {
      requestId,
      target,
      promise,
      resolve: resolvePending,
      timeout: setTimeout(() => this.finishPending(key, false), this.acquireTimeoutMs),
    };
    this.pending.set(key, pending);
    this.setState(key, 'pending');
    this.client.acquireLease(requestId, target);
    return promise;
  }

  release(target: CollaborationLeaseTargetV2): void {
    const key = targetKey(target);
    const pending = this.pending.get(key);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(key);
      pending.resolve(false);
      this.setState(key, 'unavailable');
      this.client.releaseLease(pending.requestId, pending.target);
    }
    const held = this.held.get(key);
    if (!held) return;
    if (held.timer) clearInterval(held.timer);
    this.held.delete(key);
    this.setState(key, 'unavailable');
    this.client.releaseLease(held.requestId, held.target);
  }

  getState(target: CollaborationLeaseTargetV2): CustomMotionLeaseState {
    return this.states.get(targetKey(target)) ?? 'unavailable';
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribe();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pending.clear();
    for (const held of this.held.values()) {
      if (held.timer) clearInterval(held.timer);
      this.client.releaseLease(held.requestId, held.target);
    }
    this.held.clear();
    this.states.clear();
    this.listeners.clear();
  }

  private handleLeaseMessage(message: CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3): void {
    if (message.type === 'lease:released') {
      const key = targetKey(message.target);
      const held = this.held.get(key);
      if (held) {
        if (held.timer) clearInterval(held.timer);
        this.held.delete(key);
      }
      this.setState(key, 'unavailable');
      return;
    }
    const key = targetKey(message.target);
    const pending = this.pending.get(key);
    if (!pending || pending.requestId !== message.requestId) return;
    this.finishPending(key, message.type === 'lease:acquired');
    if (message.type !== 'lease:acquired') return;
    const timer = setInterval(() => {
      if (this.held.get(key)?.requestId === pending.requestId) {
        this.client.renewLease(pending.requestId, pending.target);
      }
    }, this.renewIntervalMs);
    this.held.set(key, { requestId: pending.requestId, target: pending.target, timer });
    this.setState(key, 'held');
  }

  private finishPending(key: string, acquired: boolean): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(key);
    pending.resolve(acquired);
    if (!acquired) {
      this.setState(key, 'denied');
      this.client.releaseLease(pending.requestId, pending.target);
    }
  }

  private setState(key: string, state: CustomMotionLeaseState): void {
    if (this.states.get(key) === state) return;
    this.states.set(key, state);
    this.listeners.forEach((listener) => listener());
  }
}

export function locatorToLeaseTarget(
  locator: { statementId: string; companionId?: string },
): CollaborationLeaseTargetV2 {
  return locator.companionId !== undefined
    ? { kind: 'companion', statementId: locator.statementId, companionId: locator.companionId }
    : { kind: 'statement', statementId: locator.statementId };
}

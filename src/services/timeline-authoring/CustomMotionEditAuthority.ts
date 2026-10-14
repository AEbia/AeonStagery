import type {
  CollaborationConnectionStatus,
  CollaborationLeaseServerMessageV3,
  CollaborationLeaseTargetV3,
} from '../../api/types/collaboration';

declare const leaseIdentity: unique symbol;
/** Only the authority that issued a lease can release it. Never exposed to UI. */
export type HeldCustomMotionLease = { readonly [leaseIdentity]: true };
export type LeaseDecision = { readonly status: 'granted'; readonly lease: HeldCustomMotionLease }
  | { readonly status: 'denied'; readonly reason: string };

export interface CustomMotionEditAuthority {
  acquire(target: CollaborationLeaseTargetV3, signal: AbortSignal): Promise<LeaseDecision>;
  release(lease: HeldCustomMotionLease): Promise<void>;
  onLoss(lease: HeldCustomMotionLease, listener: (reason: string) => void): () => void;
  dispose(): void;
}

export class InMemoryCustomMotionEditAuthority implements CustomMotionEditAuthority {
  private lease: HeldCustomMotionLease | null = null;
  private disposed = false;
  private readonly listeners = new Set<(reason: string) => void>();

  async acquire(_target: CollaborationLeaseTargetV3, signal: AbortSignal): Promise<LeaseDecision> {
    if (signal.aborted || this.disposed) return { status: 'denied', reason: 'cancelled' };
    if (this.lease) return { status: 'denied', reason: 'lease-denied' };
    this.lease = Object.freeze({}) as HeldCustomMotionLease;
    return { status: 'granted', lease: this.lease };
  }

  async release(lease: HeldCustomMotionLease): Promise<void> {
    if (this.lease !== lease) return;
    this.lease = null;
    this.listeners.clear();
  }

  onLoss(lease: HeldCustomMotionLease, listener: (reason: string) => void): () => void {
    if (lease !== this.lease) { listener('lease-lost'); return () => {}; }
    this.listeners.add(listener);
    return () => { if (lease === this.lease) this.listeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lease = null;
    for (const listener of this.listeners) listener('disposed');
    this.listeners.clear();
  }
}

export interface CustomMotionLeaseClient {
  subscribeLease(listener: (message: CollaborationLeaseServerMessageV3) => void): () => void;
  subscribeRealtimeStatus?(listener: (status: CollaborationConnectionStatus) => void): () => void;
  acquireLease(requestId: string, target: CollaborationLeaseTargetV3): void;
  renewLease(requestId: string, target: CollaborationLeaseTargetV3): void;
  releaseLease(requestId: string, target: CollaborationLeaseTargetV3): void;
}

interface AuthorityRequest {
  readonly id: string;
  readonly target: CollaborationLeaseTargetV3;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly resolve: (decision: LeaseDecision) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  renew: ReturnType<typeof setInterval> | null;
  lease?: HeldCustomMotionLease;
  readonly listeners: Set<(reason: string) => void>;
}

/** Production adapter: correlates receipts, cancels late grants and owns renewal. */
export class CollaborationClientCustomMotionEditAuthority implements CustomMotionEditAuthority {
  private readonly requests = new Map<string, AuthorityRequest>();
  private readonly leases = new Map<HeldCustomMotionLease, AuthorityRequest>();
  private readonly abandoned = new Map<string, CollaborationLeaseTargetV3>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeStatus: () => void;
  private disposed = false;

  constructor(private readonly client: CustomMotionLeaseClient, private readonly options: {
    requestId?: () => string;
    acquireTimeoutMs?: number;
    renewIntervalMs?: number;
  } = {}) {
    this.unsubscribe = client.subscribeLease((message) => this.receive(message));
    this.unsubscribeStatus = client.subscribeRealtimeStatus?.((status) => {
      if (status !== 'connected') this.loseAll('disconnected');
    }) ?? (() => {});
  }

  acquire(target: CollaborationLeaseTargetV3, signal: AbortSignal): Promise<LeaseDecision> {
    if (this.disposed || signal.aborted) return Promise.resolve({ status: 'denied', reason: 'cancelled' });
    const id = this.options.requestId?.() ?? `motion-lease-${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      const abort = () => this.reject(id, 'cancelled');
      const request: AuthorityRequest = { id, target, signal, abort, resolve, timeout: null, renew: null, listeners: new Set() };
      this.requests.set(id, request);
      signal.addEventListener('abort', abort, { once: true });
      request.timeout = setTimeout(() => this.reject(id, 'timeout'), this.options.acquireTimeoutMs ?? 10_000);
      try { this.client.acquireLease(id, target); }
      catch { this.reject(id, 'disconnected'); }
    });
  }

  async release(lease: HeldCustomMotionLease): Promise<void> {
    const request = this.leases.get(lease);
    if (!request) return;
    this.finish(request);
    this.sendRelease(request.id, request.target);
  }

  onLoss(lease: HeldCustomMotionLease, listener: (reason: string) => void): () => void {
    const request = this.leases.get(lease);
    if (!request) { listener('lease-lost'); return () => {}; }
    request.listeners.add(listener);
    return () => request.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loseAll('disposed');
    this.unsubscribe();
    this.unsubscribeStatus();
    this.abandoned.clear();
  }

  private receive(message: CollaborationLeaseServerMessageV3): void {
    if (message.type === 'lease:released') {
      for (const request of this.requests.values()) {
        if (request.lease && sameTarget(request.target, message.target)) this.lose(request, 'lease-lost');
      }
      return;
    }
    const request = this.requests.get(message.requestId);
    if (!request) {
      const target = this.abandoned.get(message.requestId);
      if (!target || !sameTarget(target, message.target)) return;
      if (message.type === 'lease:acquired') this.sendRelease(message.requestId, target);
      this.abandoned.delete(message.requestId);
      return;
    }
    if (!sameTarget(request.target, message.target)) return;
    if (message.type !== 'lease:acquired') {
      if (request.lease) this.lose(request, 'lease-lost');
      else this.reject(request.id, 'lease-denied');
      return;
    }
    if (request.lease) return;
    if (request.signal.aborted) { this.reject(request.id, 'cancelled'); return; }
    if (request.timeout) clearTimeout(request.timeout);
    request.timeout = null;
    request.signal.removeEventListener('abort', request.abort);
    request.lease = Object.freeze({}) as HeldCustomMotionLease;
    this.leases.set(request.lease, request);
    request.renew = setInterval(() => {
      try { this.client.renewLease(request.id, request.target); }
      catch { this.lose(request, 'disconnected'); }
    }, this.options.renewIntervalMs ?? 10_000);
    request.resolve({ status: 'granted', lease: request.lease });
  }

  private reject(id: string, reason: string): void {
    const request = this.requests.get(id);
    if (!request || request.lease) return;
    this.finish(request);
    this.abandoned.set(id, request.target);
    this.sendRelease(id, request.target);
    request.resolve({ status: 'denied', reason });
  }

  private lose(request: AuthorityRequest, reason: string): void {
    const listeners = [...request.listeners];
    this.finish(request);
    this.sendRelease(request.id, request.target);
    for (const listener of listeners) listener(reason);
  }

  private loseAll(reason: string): void {
    for (const request of [...this.requests.values()]) {
      if (request.lease) this.lose(request, reason);
      else this.reject(request.id, reason);
    }
  }

  private finish(request: AuthorityRequest): void {
    if (request.timeout) clearTimeout(request.timeout);
    if (request.renew) clearInterval(request.renew);
    request.signal.removeEventListener('abort', request.abort);
    this.requests.delete(request.id);
    if (request.lease) this.leases.delete(request.lease);
    request.listeners.clear();
  }

  private sendRelease(id: string, target: CollaborationLeaseTargetV3): void {
    try { this.client.releaseLease(id, target); } catch { /* Disconnection already revoked ownership. */ }
  }
}

function sameTarget(a: CollaborationLeaseTargetV3, b: CollaborationLeaseTargetV3): boolean {
  return a.kind === b.kind && a.statementId === b.statementId
    && (a.kind !== 'companion' || b.kind === 'companion' && a.companionId === b.companionId);
}

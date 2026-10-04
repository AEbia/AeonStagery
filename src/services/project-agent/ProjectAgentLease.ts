/**
 * Application-global singleton running-task lease (ADR0023).
 * Injected port — main process owns the real implementation; tests use memory.
 */

export interface ProjectAgentLeaseHandle {
  readonly leaseToken: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly acquiredAt: number;
}

export type ProjectAgentLeaseAcquireResult =
  | { readonly ok: true; readonly handle: ProjectAgentLeaseHandle }
  | {
      readonly ok: false;
      readonly code: 'lease_held' | 'invalid_owner';
      readonly holder?: ProjectAgentLeaseHandle;
      readonly message: string;
    };

export type ProjectAgentLeaseReleaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'not_holder' | 'not_found'; readonly message: string };

export interface ProjectAgentLeasePort {
  /** Acquire the single global running lease for a task. */
  tryAcquire(projectId: string, taskId: string): Promise<ProjectAgentLeaseAcquireResult>;
  /** Release only if token matches the current holder. */
  release(leaseToken: string): Promise<ProjectAgentLeaseReleaseResult>;
  /** Current holder, if any. */
  getHolder(): Promise<ProjectAgentLeaseHandle | null>;
}

export class InMemoryProjectAgentLeasePort implements ProjectAgentLeasePort {
  private holder: ProjectAgentLeaseHandle | null = null;
  private seq = 0;

  async tryAcquire(projectId: string, taskId: string): Promise<ProjectAgentLeaseAcquireResult> {
    if (this.holder) {
      return {
        ok: false,
        code: 'lease_held',
        holder: { ...this.holder },
        message: `Global running lease held by task ${this.holder.taskId}`,
      };
    }
    this.seq += 1;
    this.holder = {
      leaseToken: `lease-${this.seq}-${taskId}`,
      taskId,
      projectId,
      acquiredAt: Date.now(),
    };
    return { ok: true, handle: { ...this.holder } };
  }

  async release(leaseToken: string): Promise<ProjectAgentLeaseReleaseResult> {
    if (!this.holder) {
      return { ok: false, code: 'not_found', message: 'No lease held' };
    }
    if (this.holder.leaseToken !== leaseToken) {
      return { ok: false, code: 'not_holder', message: 'Lease token does not match holder' };
    }
    this.holder = null;
    return { ok: true };
  }

  async getHolder(): Promise<ProjectAgentLeaseHandle | null> {
    return this.holder ? { ...this.holder } : null;
  }

  /** Test helper: force-clear without token. */
  forceClear(): void {
    this.holder = null;
  }
}

export interface AiProseRequestLease {
  release(): void;
}

type LeaseWaiter = (lease: AiProseRequestLease) => void;

export class AiProseRequestBudget {
  private capacity: number;
  private activeLeases = 0;
  private readonly waiters: LeaseWaiter[] = [];

  constructor(maxConcurrentRequests: number) {
    validateCapacity(maxConcurrentRequests);
    this.capacity = maxConcurrentRequests;
  }

  get maxConcurrentRequests(): number {
    return this.capacity;
  }

  updateCapacity(maxConcurrentRequests: number): void {
    validateCapacity(maxConcurrentRequests);
    this.capacity = maxConcurrentRequests;
    this.drainWaiters();
  }

  acquire(): Promise<AiProseRequestLease> {
    if (this.activeLeases < this.capacity) {
      this.activeLeases += 1;
      return Promise.resolve(this.createLease());
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await this.acquire();
    try {
      return await operation();
    } finally {
      lease.release();
    }
  }

  private createLease(): AiProseRequestLease {
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.activeLeases -= 1;
        this.drainWaiters();
      },
    };
  }

  private drainWaiters(): void {
    while (this.activeLeases < this.capacity && this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (!next) return;
      this.activeLeases += 1;
      next(this.createLease());
    }
  }
}

function validateCapacity(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('maxConcurrentRequests must be a positive safe integer');
  }
}

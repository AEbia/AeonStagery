interface WriteTask {
  bytes: number;
  write: () => Promise<void>;
}

/** Limits IPC writes by both bytes and count, retaining only unfinished work. */
export class ExportWriteQueue {
  private waiting: WriteTask[] = [];
  private activeCount = 0;
  private activeBytes = 0;
  private waitingBytes = 0;
  private failure: Error | undefined;
  private changed!: Promise<void>;
  private notifyChanged!: () => void;

  constructor(private readonly maxBytes: number, private readonly maxWrites: number) {
    this.resetNotification();
  }

  enqueue(bytes: number, write: () => Promise<void>): void {
    this.throwIfFailed();
    this.waiting.push({ bytes, write });
    this.waitingBytes += bytes;
    this.pump();
  }

  async ready(nextBytes = 0): Promise<void> {
    this.throwIfFailed();
    while (this.activeCount + this.waiting.length > 0 && (
      this.activeCount + this.waiting.length >= this.maxWrites
      || this.activeBytes + this.waitingBytes + nextBytes > this.maxBytes
    )) {
      await this.changed;
      this.throwIfFailed();
    }
  }

  async drain(): Promise<void> {
    this.throwIfFailed();
    while (this.activeCount + this.waiting.length > 0) {
      await this.changed;
      this.throwIfFailed();
    }
  }

  abort(error = new Error('Export write queue aborted')): void {
    this.failure ??= error;
    this.waiting = [];
    this.waitingBytes = 0;
    this.notify();
  }

  private pump(): void {
    while (!this.failure && this.waiting.length > 0 && this.activeCount < this.maxWrites) {
      const task = this.waiting[0];
      // An oversized frame/chunk is permitted only as the sole active write.
      if (this.activeCount > 0 && this.activeBytes + task.bytes > this.maxBytes) break;
      this.waiting.shift();
      this.waitingBytes -= task.bytes;
      this.activeCount++;
      this.activeBytes += task.bytes;
      try {
        void task.write().then(
          () => this.settle(task),
          (error: unknown) => this.settle(task, error instanceof Error ? error : new Error(String(error))),
        );
      } catch (error) {
        this.settle(task, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private settle(task: WriteTask, error?: Error): void {
    this.activeCount--;
    this.activeBytes -= task.bytes;
    if (error) this.abort(error);
    this.pump();
    this.notify();
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  private resetNotification(): void {
    this.changed = new Promise((resolve) => { this.notifyChanged = resolve; });
  }

  private notify(): void {
    const resolve = this.notifyChanged;
    this.resetNotification();
    resolve();
  }
}

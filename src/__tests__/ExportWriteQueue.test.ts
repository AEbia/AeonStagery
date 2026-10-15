import { describe, expect, it, vi } from 'vitest';
import { ExportWriteQueue } from '../engine/export/ExportWriteQueue';

function deferredWrite() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { resolve, reject, write: vi.fn(() => promise) };
}

describe('export write backpressure', () => {
  it('limits bytes, dispatches queued chunks in order, and drains every write', async () => {
    const queue = new ExportWriteQueue(8, 4);
    const writes = [deferredWrite(), deferredWrite(), deferredWrite()];
    for (const write of writes) queue.enqueue(6, write.write);
    expect(writes.map((write) => write.write.mock.calls.length)).toEqual([1, 0, 0]);
    const drained = vi.fn();
    const finishing = queue.drain().then(drained);
    writes[0].resolve();
    await Promise.resolve();
    expect(writes.map((write) => write.write.mock.calls.length)).toEqual([1, 1, 0]);
    expect(drained).not.toHaveBeenCalled();
    writes[1].resolve();
    await Promise.resolve();
    expect(writes[2].write).toHaveBeenCalledTimes(1);
    writes[2].resolve();
    await finishing;
    expect(drained).toHaveBeenCalledTimes(1);
  });

  it('pauses producers at the write-count limit and forgets completed work', async () => {
    const queue = new ExportWriteQueue(100, 2);
    const first = deferredWrite();
    const second = deferredWrite();
    queue.enqueue(1, first.write);
    queue.enqueue(1, second.write);
    const ready = vi.fn();
    const waiting = queue.ready(1).then(ready);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    first.resolve();
    await waiting;
    expect(ready).toHaveBeenCalledTimes(1);
    second.resolve();
    await queue.drain();
    await expect(queue.ready(1000)).resolves.toBeUndefined();
  });

  it('allows a single oversized frame and releases blocked producers on cancellation', async () => {
    const queue = new ExportWriteQueue(4, 4);
    const first = deferredWrite();
    const second = deferredWrite();
    await queue.ready(16);
    queue.enqueue(16, first.write);
    queue.enqueue(1, second.write);
    const ready = expect(queue.ready(1)).rejects.toThrow('cancelled');
    const drain = expect(queue.drain()).rejects.toThrow('cancelled');
    queue.abort(new Error('cancelled'));
    await Promise.all([ready, drain]);
    first.resolve();
    await Promise.resolve();
    expect(second.write).not.toHaveBeenCalled();
  });

  it('retains an asynchronous write failure after removing settled work', async () => {
    const queue = new ExportWriteQueue(4, 1);
    const first = deferredWrite();
    const second = deferredWrite();
    queue.enqueue(4, first.write);
    queue.enqueue(4, second.write);
    first.reject(new Error('broken pipe'));
    await expect(queue.drain()).rejects.toThrow('broken pipe');
    await expect(queue.ready()).rejects.toThrow('broken pipe');
    expect(second.write).not.toHaveBeenCalled();
  });
});

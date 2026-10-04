import { describe, expect, it } from 'vitest';
import { AiConversationRequestCoordinator } from '../../electron/aiConversationRequestCoordinator';

describe('AI conversation request coordinator', () => {
  it('registers ownership keyed on { senderFrame, requestId } and keeps senders independent', () => {
    const coordinator = new AiConversationRequestCoordinator();
    const frameA = coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-1' });
    const frameB = coordinator.register({ frameId: 2, webContentsId: 11, requestId: 'req-1' });

    expect(frameA.signal.aborted).toBe(false);
    expect(frameB.signal.aborted).toBe(false);
    expect(coordinator.inflightCount()).toBe(2);

    frameA.settle();
    expect(coordinator.inflightCount()).toBe(1);
  });

  it('returns cancelling for the originating sender and idempotently for repeats', () => {
    const coordinator = new AiConversationRequestCoordinator();
    const registration = coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-1' });

    expect(coordinator.cancel(1, 'req-1')).toBe('cancelling');
    expect(registration.signal.aborted).toBe(true);
    expect(coordinator.cancel(1, 'req-1')).toBe('cancelling');
    expect(coordinator.cancel(1, 'req-1')).toBe('cancelling');
  });

  it('returns alreadySettled after settle and notFound once pruned', () => {
    const coordinator = new AiConversationRequestCoordinator();
    coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-1' }).settle();

    expect(coordinator.cancel(1, 'req-1')).toBe('alreadySettled');
    expect(coordinator.pruneSettled()).toBe(1);
    expect(coordinator.cancel(1, 'req-1')).toBe('notFound');
  });

  it('returns notFound for unknown requests and cross-sender cancels', () => {
    const coordinator = new AiConversationRequestCoordinator();
    coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-1' });

    expect(coordinator.cancel(1, 'unknown-request')).toBe('notFound');
    expect(coordinator.cancel(2, 'req-1')).toBe('notFound');
  });

  it('aborts every outstanding request of a destroyed frame only', () => {
    const coordinator = new AiConversationRequestCoordinator();
    const frameA1 = coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-1' });
    const frameA2 = coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-2' });
    const frameB = coordinator.register({ frameId: 2, webContentsId: 11, requestId: 'req-3' });

    coordinator.abortFrame(1);

    expect(frameA1.signal.aborted).toBe(true);
    expect(frameA2.signal.aborted).toBe(true);
    expect(frameB.signal.aborted).toBe(false);
    expect(coordinator.cancel(1, 'req-1')).toBe('cancelling');
    expect(coordinator.cancel(2, 'req-3')).toBe('cancelling');
  });

  it('aborts every request of a destroyed webContents across its frames', () => {
    const coordinator = new AiConversationRequestCoordinator();
    const frameA = coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-1' });
    const frameB = coordinator.register({ frameId: 2, webContentsId: 10, requestId: 'req-2' });
    const other = coordinator.register({ frameId: 3, webContentsId: 20, requestId: 'req-3' });

    coordinator.abortWebContents(10);

    expect(frameA.signal.aborted).toBe(true);
    expect(frameB.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  it('does not abort settled entries during frame or webContents teardown', () => {
    const coordinator = new AiConversationRequestCoordinator();
    const settled = coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-1' });
    settled.settle();
    const inflight = coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-2' });

    coordinator.abortFrame(1);
    expect(settled.signal.aborted).toBe(false);
    expect(inflight.signal.aborted).toBe(true);

    coordinator.abortWebContents(10);
    expect(settled.signal.aborted).toBe(false);
  });

  it('rejects duplicate in-flight registration from the same sender', () => {
    const coordinator = new AiConversationRequestCoordinator();
    coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-1' });

    expect(() => coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-1' }))
      .toThrow('Duplicate in-flight AI conversation request.');
  });

  it('reuses the key after settle for a later request', () => {
    const coordinator = new AiConversationRequestCoordinator();
    coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-1' }).settle();
    coordinator.pruneSettled();

    const next = coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-1' });
    expect(next.signal.aborted).toBe(false);
    expect(coordinator.inflightCount()).toBe(1);
  });

  it('settle is idempotent and safe for unknown requests', () => {
    const coordinator = new AiConversationRequestCoordinator();
    coordinator.settle(1, 'never-registered');
    coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-1' });
    coordinator.settle(1, 'req-1');
    coordinator.settle(1, 'req-1');
    expect(coordinator.inflightCount()).toBe(0);
  });

  it('a late cancel after frame abort stays scoped to that frame', () => {
    const coordinator = new AiConversationRequestCoordinator();
    const registration = coordinator.register({ frameId: 1, webContentsId: 10, requestId: 'req-1' });
    coordinator.abortFrame(1);
    expect(coordinator.cancel(1, 'req-1')).toBe('cancelling');
    expect(registration.signal.aborted).toBe(true);
  });
});

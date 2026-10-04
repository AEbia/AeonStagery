import type { AiConversationCancelResult } from '../src/services/ai-authoring/AiConversationTransport';

export interface AiConversationRequestOwner {
  frameId: number;
  webContentsId: number;
  requestId: string;
}

export interface AiConversationRequestRegistration {
  signal: AbortSignal;
  settle(): void;
}

type AiConversationRequestState = 'inflight' | 'cancelling' | 'settled';

interface AiConversationRequestEntry extends AiConversationRequestOwner {
  state: AiConversationRequestState;
  controller: AbortController;
}

function requestKey(owner: Pick<AiConversationRequestOwner, 'frameId' | 'requestId'>): string {
  return `${owner.frameId}\u0000${owner.requestId}`;
}

/**
 * Tracks in-flight provider requests by { senderFrame, requestId } ownership.
 * Cancellation is idempotent and scoped: a request can only be cancelled by
 * its originating frame, and frame or webContents destruction aborts every
 * outstanding request it owns without touching other senders.
 */
export class AiConversationRequestCoordinator {
  private readonly entries = new Map<string, AiConversationRequestEntry>();

  register(owner: AiConversationRequestOwner): AiConversationRequestRegistration {
    const key = requestKey(owner);
    const existing = this.entries.get(key);
    if (existing && existing.state !== 'settled') {
      throw new Error('Duplicate in-flight AI conversation request.');
    }
    const controller = new AbortController();
    this.entries.set(key, {
      ...owner,
      state: 'inflight',
      controller,
    });
    return {
      signal: controller.signal,
      settle: () => this.settle(owner.frameId, owner.requestId),
    };
  }

  cancel(frameId: number, requestId: string): AiConversationCancelResult {
    const entry = this.entries.get(requestKey({ frameId, requestId }));
    if (!entry) return 'notFound';
    if (entry.state === 'settled') return 'alreadySettled';
    if (entry.state === 'inflight') {
      entry.state = 'cancelling';
      entry.controller.abort();
    }
    return 'cancelling';
  }

  settle(frameId: number, requestId: string): void {
    const entry = this.entries.get(requestKey({ frameId, requestId }));
    if (!entry) return;
    entry.state = 'settled';
  }

  pruneSettled(): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.state === 'settled') {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  abortFrame(frameId: number): void {
    for (const entry of this.entries.values()) {
      if (entry.frameId !== frameId || entry.state !== 'inflight') continue;
      entry.state = 'cancelling';
      entry.controller.abort();
    }
  }

  abortWebContents(webContentsId: number): void {
    for (const entry of this.entries.values()) {
      if (entry.webContentsId !== webContentsId || entry.state !== 'inflight') continue;
      entry.state = 'cancelling';
      entry.controller.abort();
    }
  }

  inflightCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.state !== 'settled') count += 1;
    }
    return count;
  }
}

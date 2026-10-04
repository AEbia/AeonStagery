import { describe, expect, it, vi } from 'vitest';
import { bindAiConversationAbortSignal } from '../services/ai-authoring/AiConversationTransport';

describe('AI conversation cancellation ports', () => {
  it('forwards one abort to the host port and removes the listener on cleanup', () => {
    const controller = new AbortController();
    const cancel = vi.fn(async () => 'cancelling' as const);
    const cleanup = bindAiConversationAbortSignal('request-1', controller.signal, { cancel });

    controller.abort();
    controller.abort();

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('request-1');

    cleanup();
    controller.abort();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels an already-aborted signal and does nothing without a signal', () => {
    const controller = new AbortController();
    controller.abort();
    const cancel = vi.fn(async () => 'alreadySettled' as const);

    bindAiConversationAbortSignal('request-2', controller.signal, { cancel });
    bindAiConversationAbortSignal('request-3', undefined, { cancel });

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('request-2');
  });
});

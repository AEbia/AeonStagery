import type { AiConversationRequest, AiConversationResponse } from '../../api/types/ai-conversation';
import type {
  AiConversationCompletionOptions,
  AiConversationTransport,
} from '../ai-authoring/AiConversationTransport';

/**
 * Application-wide single-channel request queue for ALL project-Agent model
 * requests (ADR0023): the app globally allows only one running project Agent,
 * so at most one project-Agent model request may be in flight at any moment.
 * Model turns (coordinator) and continuation-summarizer requests pass through
 * the same queue, so a migration compaction issued BEFORE the global lease is
 * acquired can never overlap another task's running model request, and a
 * lease_held compaction is never wasted on a concurrent request slot.
 *
 * The queue is a drop-in `AiConversationTransport`: the host wraps the real
 * transport once and hands the wrapper to every coordinator and every
 * continuation summarizer of the application.
 */
export class ProjectAgentModelRequestQueue implements AiConversationTransport {
  private readonly transport: AiConversationTransport;
  /** Tail of the serialized request chain; always resolves, never rejects. */
  private tail: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private maxObservedInFlight = 0;

  constructor(transport: AiConversationTransport) {
    this.transport = transport;
  }

  complete(
    request: AiConversationRequest,
    options?: AiConversationCompletionOptions,
  ): Promise<AiConversationResponse> {
    const run = this.tail.then(() => this.execute(request, options));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async execute(
    request: AiConversationRequest,
    options?: AiConversationCompletionOptions,
  ): Promise<AiConversationResponse> {
    this.inFlight += 1;
    if (this.inFlight > this.maxObservedInFlight) {
      this.maxObservedInFlight = this.inFlight;
    }
    try {
      return await this.transport.complete(request, options);
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Number of requests currently executing (0 or 1 by contract). */
  getInFlightCount(): number {
    return this.inFlight;
  }

  /** Highest number of concurrent executions ever observed (test probe). */
  getMaxObservedInFlight(): number {
    return this.maxObservedInFlight;
  }

  /** Resolves when every queued and in-flight request has settled. */
  whenIdle(): Promise<void> {
    return this.tail;
  }
}

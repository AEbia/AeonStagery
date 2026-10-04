/**
 * AeonStagery — Event Bus
 *
 * Central pub/sub event system for decoupled communication between engine modules.
 * Supports typed events, wildcard subscriptions, and one-shot listeners.
 */

type EventHandler<P = unknown> = (payload: P) => void | Promise<void>;

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private onceHandlers = new Map<string, Set<EventHandler>>();
  private wildcardHandlers = new Set<EventHandler>();

  /**
   * Subscribe to an event.
   */
  on(event: string, handler: EventHandler): () => void {
    if (event === '*') {
      this.wildcardHandlers.add(handler);
      return () => this.wildcardHandlers.delete(handler);
    }

    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  /**
   * Subscribe to an event, but only fire once.
   */
  once(event: string, handler: EventHandler): () => void {
    if (!this.onceHandlers.has(event)) {
      this.onceHandlers.set(event, new Set());
    }
    this.onceHandlers.get(event)!.add(handler);
    return () => {
      this.onceHandlers.get(event)?.delete(handler);
    };
  }

  /**
   * Unsubscribe from an event.
   */
  off(event: string, handler: EventHandler): void {
    if (event === '*') {
      this.wildcardHandlers.delete(handler);
      return;
    }
    this.handlers.get(event)?.delete(handler);
    this.onceHandlers.get(event)?.delete(handler);
  }

  /**
   * Emit an event with optional payload.
   */
  async emit(event: string, payload?: any): Promise<void> {
    // Fire specific handlers
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        await handler(payload);
      }
    }

    // Fire one-shot handlers
    const onceHandlers = this.onceHandlers.get(event);
    if (onceHandlers) {
      for (const handler of onceHandlers) {
        await handler(payload);
      }
      this.onceHandlers.delete(event);
    }

    // Fire wildcard handlers
    for (const handler of this.wildcardHandlers) {
      await handler({ event, payload });
    }
  }

  /**
   * Remove all handlers for an event, or all handlers if no event specified.
   */
  clear(event?: string): void {
    if (event) {
      this.handlers.delete(event);
      this.onceHandlers.delete(event);
    } else {
      this.handlers.clear();
      this.onceHandlers.clear();
      this.wildcardHandlers.clear();
    }
  }
}

export const eventBus = new EventBus();
export default EventBus;

/**
 * AeonStagery — Hook System
 *
 * Lifecycle hooks that external plugins and AI scripts can tap into.
 * Hooks can optionally cancel default behavior via preventDefault().
 */

import type { HookEvent, HookContext } from './types/hook';
import { eventBus } from './events';

type HookHandler = (ctx: HookContext) => void | Promise<void>;

class HookSystem {
  private handlers = new Map<string, Set<HookHandler>>();

  /**
   * Register a hook handler.
   */
  on(event: HookEvent, handler: HookHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  /**
   * Remove a hook handler.
   */
  off(event: HookEvent, handler: HookHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  /**
   * Emit a custom event through both hooks and event bus.
   */
  emit(event: string, payload?: any): void {
    eventBus.emit(event, payload);
  }

  /**
   * Execute all registered hooks for an event.
   * Returns the context (check ctx.prevented for cancellation).
   */
  async execute(event: HookEvent, data?: any): Promise<HookContext> {
    const ctx: HookContext = {
      event,
      timestamp: performance.now(),
      data,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };

    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        await handler(ctx);
        if (ctx.prevented) break;
      }
    }

    // Also emit through event bus for non-hook listeners
    eventBus.emit(event, data);

    return ctx;
  }

  /**
   * Clear all hooks.
   */
  clear(): void {
    this.handlers.clear();
  }
}

export const hookSystem = new HookSystem();
export default HookSystem;

import type { AgentImageDetail } from '../../api/types/project-agent';
import type { AiConversationImagePayloadResolver } from '../ai-conversation/AiConversationImageProjection';

export interface ProjectAgentCachedImagePayload {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly detail: AgentImageDetail;
  readonly contentFingerprint: string;
}

/**
 * Live-memory image payload cache for one running task session (ADR0023).
 * The cache is NOT the persistence point: image bytes persist once with their
 * tool-result message in the conversation store, and every model request
 * references the stored message copy. The cache only serves per-request
 * projection needs — rebuilding bytes for descriptor-only messages that the
 * store cannot provide (legacy-format records, compaction summarizer copies)
 * and feeding the coordinator when it assembles the tool-result message for a
 * fresh readImage result. Entries are keyed by the same fields the stored
 * descriptor carries, so the transport projection rebuilds deterministically.
 * The cache is cleared when messages leave the context (compaction,
 * suspension, lease replacement, terminal settlement); recovery restores
 * current image bytes with their messages from the store, never from this
 * cache.
 */
export class ProjectAgentImageSessionCache implements AiConversationImagePayloadResolver {
  private readonly entries = new Map<string, ProjectAgentCachedImagePayload>();

  /**
   * Entries are keyed by reference + content fingerprint + detail so the same
   * reference read at different detail levels (or re-read after a content
   * change) never evicts a still-valid sibling observation (ADR0023).
   */
  set(reference: string, payload: ProjectAgentCachedImagePayload): void {
    this.entries.set(cacheKey(reference, payload.contentFingerprint, payload.detail), { ...payload });
  }

  /**
   * Returns the verified payload when the cached fingerprint and detail match
   * the descriptor exactly. A stale fingerprint (the resource changed since
   * readImage) does not match: stale-content observations for this reference
   * are evicted so later requests keep failing closed, while sibling entries
   * at other detail levels with the SAME fingerprint stay valid (ADR0023).
   */
  get(reference: string, contentFingerprint: string, detail: AgentImageDetail): ProjectAgentCachedImagePayload | null {
    const entry = this.entries.get(cacheKey(reference, contentFingerprint, detail));
    if (!entry) {
      this.evictStaleContent(reference, contentFingerprint);
      return null;
    }
    return { ...entry, bytes: new Uint8Array(entry.bytes) };
  }

  resolve(options: {
    reference: string;
    contentFingerprint: string;
    detail: AgentImageDetail;
  }): { mimeType: string; bytes: Uint8Array; width: number; height: number } | null {
    const entry = this.get(options.reference, options.contentFingerprint, options.detail);
    if (!entry) return null;
    return {
      mimeType: entry.mimeType,
      bytes: entry.bytes,
      width: entry.width,
      height: entry.height,
    };
  }

  clear(): void {
    this.entries.clear();
  }

  /** Evict same-reference observations whose content fingerprint went stale. */
  private evictStaleContent(reference: string, contentFingerprint: string): void {
    for (const [key] of this.entries) {
      const parts = key.split('\u0000');
      if (parts[0] === reference && parts[1] !== contentFingerprint) {
        this.entries.delete(key);
      }
    }
  }
}

function cacheKey(reference: string, contentFingerprint: string, detail: AgentImageDetail): string {
  return `${reference}\u0000${contentFingerprint}\u0000${detail}`;
}

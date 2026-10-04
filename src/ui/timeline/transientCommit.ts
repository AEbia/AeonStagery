import type React from 'react';

/**
 * Transient overlay for a timeline block. `time`/`duration` override the
 * block's layout for as long as the entry exists, while the underlying
 * document still holds the pre-commit values.
 */
export type TrackTransientState = {
  time?: number;
  duration?: number;
};

export type TrackTransientStates = Record<string, TrackTransientState>;

export type SetTrackTransientStates = React.Dispatch<React.SetStateAction<TrackTransientStates>>;

/**
 * Runs a commit while the given transient block overlays stay pinned until
 * the commit settles, then clears exactly the entries that were pinned.
 *
 * Timeline authoring commits are asynchronous: they flow through the serial
 * authoring queue → document coordinator → scene pipeline before the
 * document store is replaced. Clearing a transient synchronously at drop
 * would therefore re-render the affected block(s) at their stale document
 * time for the frames between drop and commit — the visible "jump back to
 * the original position, then jump to the target" flicker.
 *
 * `pinned` maps block ids to the transient values already applied for this
 * commit (callers must set them before calling). When `runCommit` settles,
 * only entries whose current value still equals the pinned value are
 * cleared, so a newer interaction (e.g. an immediate re-drag before the
 * commit lands) is never clobbered.
 *
 * A synchronous `runCommit` return (commit skipped, e.g. by the offline
 * gate) clears immediately; a rejected promise also clears (block snaps
 * back, which is the correct outcome when the edit did not commit). A
 * safety timer guarantees the pin can never leak forever.
 */
export function pinTransientUntilCommitSettles(
  setTransientStates: SetTrackTransientStates,
  pinned: TrackTransientStates,
  runCommit: () => unknown,
  fallbackTimeoutMs = 2000,
): void {
  let settled = false;

  const clear = () => {
    if (settled) return;
    settled = true;
    setTransientStates((prev) => {
      let next: TrackTransientStates | null = null;
      for (const [id, expected] of Object.entries(pinned)) {
        const current = prev[id];
        if (!current) continue;
        if (current.time !== expected.time || current.duration !== expected.duration) continue;
        if (!next) next = { ...prev };
        delete next[id];
      }
      return next ?? prev;
    });
  };

  let result: unknown;
  try {
    result = runCommit();
  } catch (error) {
    clear();
    throw error;
  }

  if (result && typeof (result as Promise<unknown>).then === 'function') {
    (result as Promise<unknown>).then(clear, clear);
  } else {
    clear();
  }

  window.setTimeout(clear, fallbackTimeoutMs);
}
/**
 * @vitest-environment jsdom
 *
 * Regression guards for the "jump back to the original position, then to
 * the target" flicker fix: after a timeline interaction commits, the
 * transient overlay must stay pinned until the (asynchronous) authoring
 * commit settles. If a handler drops the authoring promise (returns
 * undefined synchronously), the pin is cleared in the same tick and the
 * flicker returns — these tests pin down that contract.
 */
import { act, fireEvent, renderHook } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../ui/context/AppContext';
import {
  pinTransientUntilCommitSettles,
  type TrackTransientState,
  type TrackTransientStates,
} from '../ui/timeline/transientCommit';
import { useBatchDrag } from '../ui/timeline/useBatchDrag';

function makeContext(): any {
  const document = {
    schemaVersion: 5,
    sceneId: 'scene-1',
    meta: { title: 'Batch drag pin' },
    statements: [
      { id: 'st-a', type: 'dialogue', time: 1, params: { text: 'a', speakerId: 'hero' } },
      { id: 'st-b', type: 'dialogue', time: 2.5, params: { text: 'b', speakerId: 'hero' } },
    ],
  };
  return {
    adapters: {
      playback: { getCurrentTime: () => 0, seek: vi.fn(), subscribeTime: () => () => undefined },
      camera: {} as any,
      character: {} as any,
      stage: {} as any,
      timeline: {} as any,
      export: {} as any,
    },
    stores: {
      document: {
        getCurrentSceneDocumentSnapshot: () => document,
        getCompiledSceneSnapshot: () => null,
        subscribe: () => () => undefined,
      } as any,
      playback: {} as any,
      editor: {} as any,
      validation: {} as any,
    },
    services: {} as any,
    collaboration: {} as any,
  };
}

describe('pinTransientUntilCommitSettles', () => {
  type DispatchTransient = (action: TrackTransientStates | ((prev: TrackTransientStates) => TrackTransientStates)) => void;

  // Mirrors the real usage: the caller applies the pin first, then hands
  // the committed values to the helper so it can release the right ones.
  function drive(pinned: TrackTransientStates, runCommit: () => unknown, afterPin: (state: TrackTransientStates) => void) {
    const box: { current: TrackTransientStates } = { current: { ...pinned } };
    const setState: DispatchTransient = (action) => {
      box.current = typeof action === 'function'
        ? (action as (prev: TrackTransientStates) => TrackTransientStates)(box.current)
        : action;
    };
    pinTransientUntilCommitSettles(setState, pinned, runCommit, 5000);
    afterPin(box.current);
    return { setState, getState: () => box.current };
  }

  it('keeps the pinned transients until the commit promise settles, then clears exactly those entries', async () => {
    let resolveCommit!: () => void;
    const pinned = { a: { time: 11 }, b: { time: 12.5 } };
    const { getState } = drive(
      pinned,
      () => new Promise<void>((resolve) => { resolveCommit = resolve; }),
      (s) => {
        expect(s).toEqual(pinned);
      },
    );
    expect(getState()).toEqual(pinned);

    await act(async () => {
      resolveCommit();
    });
    expect(getState()).toEqual({});
  });

  it('clears immediately when the commit returns synchronously (commit skipped)', () => {
    const commit = vi.fn(() => undefined);
    const { getState } = drive({ a: { time: 11 } }, commit, (s) => {
      expect(s).toEqual({});
    });
    expect(getState()).toEqual({});
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('clears when the commit promise rejects', async () => {
    let rejectCommit!: (error: unknown) => void;
    const { getState } = drive(
      { a: { time: 11 } },
      () => new Promise<void>((_, reject) => { rejectCommit = reject; }),
      () => {},
    );
    expect(getState()).toEqual({ a: { time: 11 } });

    await act(async () => {
      rejectCommit(new Error('commit failed'));
    });
    expect(getState()).toEqual({});
  });

  it('never clears a newer transient pinned after this commit (re-drag race)', async () => {
    type DispatchTransient = (action: TrackTransientStates | ((prev: TrackTransientStates) => TrackTransientStates)) => void;
    let transientState: TrackTransientStates = { a: { time: 11 } };
    let resolveCommit!: () => void;
    const setState: DispatchTransient = (action) => {
      transientState = typeof action === 'function'
        ? (action as (prev: TrackTransientStates) => TrackTransientStates)(transientState)
        : action;
    };
    pinTransientUntilCommitSettles(
      setState,
      { a: { time: 11 } },
      () => new Promise<void>((resolve) => { resolveCommit = resolve; }),
      5000,
    );
    // A second interaction re-pins the same block to a newer value before
    // the first commit settles.
    act(() => {
      transientState = { a: { time: 9 } };
    });
    await act(async () => {
      resolveCommit();
    });
    // The first commit must not clobber the newer pin.
    expect(transientState).toEqual({ a: { time: 9 } });
  });
});

describe('useBatchDrag deduplicated transient pinning', () => {
  beforeEach(() => {
    if (!HTMLElement.prototype.setPointerCapture) {
      Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true });
      Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { value: vi.fn(), configurable: true });
    }
  });

  it('keeps dragged blocks pinned at the committed position until the batch commit settles', async () => {
    const lead = document.createElement('div');
    const blockRefs = { current: new Map([['st-a', lead]]) } as React.RefObject<Map<string, HTMLElement>>;

    let transientState: Record<string, TrackTransientState> = {};
    const setTransientStates = (updater: (prev: Record<string, TrackTransientState>) => Record<string, TrackTransientState>) => {
      transientState = updater(transientState);
    };

    let resolveCommit!: (value: unknown) => void;
    const onBatchDrag = vi.fn(
      (_updates: unknown) => new Promise((resolve) => { resolveCommit = resolve; }),
    );

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AppProvider {...makeContext()}>{children}</AppProvider>
    );
    const { result } = renderHook(() => useBatchDrag({
      blockRefs,
      selectedIds: { 'st-a': true },
      pps: 10,
      onBatchDrag,
      setTransientStates: setTransientStates as any,
      getSnapTargets: () => [],
    }), { wrapper });

    act(() => {
      result.current.handlePointerDown(
        { button: 0, clientX: 100, clientY: 10, pointerId: 1, shiftKey: false, stopPropagation: vi.fn() } as any,
        'st-a',
      );
    });

    act(() => {
      fireEvent.pointerMove(window, { clientX: 200, clientY: 10, buttons: 1, pointerId: 1 });
    });
    expect(transientState['st-a']).toEqual({ time: 11 });

    act(() => {
      fireEvent.pointerUp(window, { clientX: 200, clientY: 10, button: 0, buttons: 0, pointerId: 1 });
    });

    // The commit promise is still pending: the transient must remain pinned.
    expect(onBatchDrag).toHaveBeenCalledWith([{ id: 'st-a', time: 11 }]);
    expect(transientState['st-a']).toEqual({ time: 11 });

    // The commit settles: the pin is released without a visual jump-back.
    await act(async () => {
      resolveCommit({});
    });
    expect(transientState['st-a']).toBeUndefined();
  });

  it('releases the pin immediately when the batch handler returns synchronously', async () => {
    const lead = document.createElement('div');
    const blockRefs = { current: new Map([['st-a', lead]]) } as React.RefObject<Map<string, HTMLElement>>;

    let transientState: Record<string, TrackTransientState> = {};
    const setTransientStates = (updater: (prev: Record<string, TrackTransientState>) => Record<string, TrackTransientState>) => {
      transientState = updater(transientState);
    };

    const onBatchDrag = vi.fn(() => undefined);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AppProvider {...makeContext()}>{children}</AppProvider>
    );
    const { result } = renderHook(() => useBatchDrag({
      blockRefs,
      selectedIds: { 'st-a': true },
      pps: 10,
      onBatchDrag,
      setTransientStates: setTransientStates as any,
      getSnapTargets: () => [],
    }), { wrapper });

    act(() => {
      result.current.handlePointerDown(
        { button: 0, clientX: 100, clientY: 10, pointerId: 1, shiftKey: false, stopPropagation: vi.fn() } as any,
        'st-a',
      );
    });
    act(() => {
      fireEvent.pointerMove(window, { clientX: 200, clientY: 10, buttons: 1, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 200, clientY: 10, button: 0, buttons: 0, pointerId: 1 });
    });

    expect(onBatchDrag).toHaveBeenCalledWith([{ id: 'st-a', time: 11 }]);
    // No pin survives a synchronous (void) handler: commit did not happen.
    expect(transientState['st-a']).toBeUndefined();
  });
});
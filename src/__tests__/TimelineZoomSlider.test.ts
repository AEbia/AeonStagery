/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { computeSmartZoomWindow } from '../ui/timeline/TimelineZoomSlider';
import { TimelineZoomSlider } from '../ui/timeline/TimelineZoomSlider';
import { AppProvider } from '../ui/context/AppContext';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderSlider(props?: Partial<React.ComponentProps<typeof TimelineZoomSlider>>) {
  const setPixelsPerSecond = vi.fn();
  const setScrollLeft = vi.fn();
  const playbackAdapter = {
    getCurrentTime: () => 20,
    play: () => {},
    pause: () => {},
    subscribeTime: () => () => {},
    seek: () => {},
  } as any;
  const adapters = {
    document: {} as any,
    playback: playbackAdapter,
    camera: {} as any,
    character: {} as any,
    stage: {} as any,
    timeline: {} as any,
    export: {} as any,
  };
  const stores = {
    document: {} as any,
    playback: {} as any,
    editor: {} as any,
    validation: {} as any,
  };

  const view = render(
    React.createElement(
      AppProvider,
      {
        adapters,
        stores,
        children: React.createElement(TimelineZoomSlider, {
          pixelsPerSecond: 10,
          setPixelsPerSecond,
          maxTime: 100,
          containerWidth: 200,
          scrollLeft: 100,
          setScrollLeft,
          ...props,
        }),
      },
    ),
  );

  return { ...view, setPixelsPerSecond, setScrollLeft };
}

describe('TimelineZoomSlider smart zoom window', () => {
  it('shrinks symmetrically around the focus time while both sides are free', () => {
    const result = computeSmartZoomWindow({
      dragSide: 'left',
      deltaTime: 2,
      startTime: 10,
      visibleTime: 20,
      maxTime: 100,
      focusTime: 20,
      minVisibleTime: 4,
    });

    expect(result.visibleTime).toBe(16);
    expect(result.startTime).toBe(12);
  });

  it('recenters toward CTI while zooming in before switching to pure centered zoom', () => {
    const result = computeSmartZoomWindow({
      dragSide: 'left',
      deltaTime: 2,
      startTime: 10,
      visibleTime: 20,
      maxTime: 100,
      focusTime: 16,
      minVisibleTime: 4,
    });

    expect(result.visibleTime).toBe(16);
    expect(result.startTime).toBe(10);
  });

  it('hands all remaining zoom to the opposite side after hitting a boundary', () => {
    const result = computeSmartZoomWindow({
      dragSide: 'right',
      deltaTime: -3,
      startTime: 0,
      visibleTime: 12,
      maxTime: 40,
      focusTime: 2,
      minVisibleTime: 4,
    });

    expect(result.visibleTime).toBe(6);
    expect(result.startTime).toBe(0);
  });

  it('zooms out around the current window center until a boundary is hit', () => {
    const result = computeSmartZoomWindow({
      dragSide: 'left',
      deltaTime: -5,
      startTime: 20,
      visibleTime: 20,
      maxTime: 100,
      focusTime: 35,
      minVisibleTime: 4,
    });

    expect(result.visibleTime).toBe(30);
    expect(result.startTime).toBe(15);
  });

  it('after a boundary is hit during zoom out, gives all remaining expansion to the other side', () => {
    const result = computeSmartZoomWindow({
      dragSide: 'left',
      deltaTime: -10,
      startTime: 5,
      visibleTime: 20,
      maxTime: 100,
      focusTime: 12,
      minVisibleTime: 4,
    });

    expect(result.visibleTime).toBe(40);
    expect(result.startTime).toBe(0);
  });

  it('updates zoom when dragging the left handle', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const onInteractionChange = vi.fn();
    const { getByTestId, setPixelsPerSecond, setScrollLeft } = renderSlider({ onInteractionChange });

    fireEvent.pointerDown(getByTestId('timeline-zoom-handle-left'), { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 120, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(raf).toHaveBeenCalled();
    expect(onInteractionChange).toHaveBeenNthCalledWith(1, true);
    expect(onInteractionChange).toHaveBeenLastCalledWith(false);
    expect(setPixelsPerSecond).toHaveBeenCalled();
    expect(setScrollLeft).toHaveBeenCalled();
  });

  it('updates zoom when dragging the right handle', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const { getByTestId, setPixelsPerSecond, setScrollLeft } = renderSlider();

    fireEvent.pointerDown(getByTestId('timeline-zoom-handle-right'), { clientX: 100, pointerId: 2 });
    fireEvent.pointerMove(window, { clientX: 70, pointerId: 2 });
    fireEvent.pointerUp(window, { pointerId: 2 });

    expect(setPixelsPerSecond).toHaveBeenCalled();
    expect(setScrollLeft).toHaveBeenCalled();
  });

  it('locks zoom focus time at drag start instead of rereading CTI on every move', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });

    const getCurrentTime = vi
      .fn<() => number>()
      .mockReturnValueOnce(20)
      .mockReturnValue(35);

    const setPixelsPerSecond = vi.fn();
    const setScrollLeft = vi.fn();
    const adapters = {
      document: {} as any,
      playback: {
        getCurrentTime,
        play: () => {},
        pause: () => {},
        subscribeTime: () => () => {},
        seek: () => {},
      } as any,
      camera: {} as any,
      character: {} as any,
      stage: {} as any,
      timeline: {} as any,
      export: {} as any,
    };
    const stores = {
      document: {} as any,
      playback: {} as any,
      editor: {} as any,
      validation: {} as any,
    };

    const { getByTestId } = render(
      React.createElement(
        AppProvider,
        {
          adapters,
          stores,
          children: React.createElement(TimelineZoomSlider, {
            pixelsPerSecond: 10,
            setPixelsPerSecond,
            maxTime: 100,
            containerWidth: 200,
            scrollLeft: 100,
            setScrollLeft,
          }),
        },
      ),
    );

    fireEvent.pointerDown(getByTestId('timeline-zoom-handle-left'), { clientX: 100, pointerId: 3 });
    fireEvent.pointerMove(window, { clientX: 120, pointerId: 3 });
    fireEvent.pointerMove(window, { clientX: 140, pointerId: 3 });
    fireEvent.pointerUp(window, { pointerId: 3 });

    expect(getCurrentTime).toHaveBeenCalledTimes(1);
    expect(setPixelsPerSecond).toHaveBeenCalled();
    expect(setScrollLeft).toHaveBeenCalled();
  });
});

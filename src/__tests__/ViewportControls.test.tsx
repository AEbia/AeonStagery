/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
import { MAX_ZOOM, MIN_ZOOM, useViewport } from '../ui/hooks/useViewport';

function renderViewport() {
  const stage = document.createElement('div');
  const stageRef = { current: stage };
  return { ...renderHook(() => useViewport(stageRef)), stage };
}

function wheelEvent(deltaY: number): WheelEvent {
  return new WheelEvent('wheel', { deltaY, cancelable: true });
}

function mouseDownEvent(): React.MouseEvent {
  return { button: 0, clientX: 0, clientY: 0 } as unknown as React.MouseEvent;
}

/** 通过真实的 mousedown + 全局 mousemove 路径产生平移偏移。 */
function panBy(dx: number, dy: number): void {
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: dx, clientY: dy }));
}

describe('useViewport', () => {
  it('starts fitted at 100% with no panning offset', () => {
    const { result } = renderViewport();
    expect(result.current.viewport).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it('steps zoom in and out multiplicatively within the shared bounds', () => {
    const { result } = renderViewport();
    act(() => result.current.handleZoomIn());
    expect(result.current.viewport.zoom).toBeCloseTo(1.2, 5);

    act(() => result.current.handleZoomOut());
    expect(result.current.viewport.zoom).toBeCloseTo(1, 5);
  });

  it('keeps zoom-in monotonic at the upper bound (no reversal)', () => {
    const { result, stage } = renderViewport();
    // 滚轮越过旧按钮上限(5)到达共享最大值
    act(() => { stage.dispatchEvent(wheelEvent(-1_000_000)); });
    expect(result.current.viewport.zoom).toBe(MAX_ZOOM);

    act(() => result.current.handleZoomIn());
    expect(result.current.viewport.zoom).toBe(MAX_ZOOM);
  });

  it('keeps zoom-out monotonic at the lower bound (no reversal)', () => {
    const { result, stage } = renderViewport();
    act(() => { stage.dispatchEvent(wheelEvent(1_000_000)); });
    expect(result.current.viewport.zoom).toBe(MIN_ZOOM);

    act(() => result.current.handleZoomOut());
    expect(result.current.viewport.zoom).toBe(MIN_ZOOM);
  });

  it('clamps wheel zoom into the shared [MIN, MAX] range', () => {
    const { result, stage } = renderViewport();
    act(() => { stage.dispatchEvent(wheelEvent(-500)); });
    expect(result.current.viewport.zoom).toBeGreaterThan(1);
    expect(result.current.viewport.zoom).toBeLessThanOrEqual(MAX_ZOOM);

    act(() => { stage.dispatchEvent(wheelEvent(10_000)); });
    expect(result.current.viewport.zoom).toBe(MIN_ZOOM);
  });

  it('resets only zoom to 100% while preserving pan', () => {
    const { result } = renderViewport();
    act(() => result.current.handleZoomIn());
    act(() => result.current.handleStageMouseDown(mouseDownEvent()));
    act(() => panBy(150, 90));
    expect(result.current.viewport.x).toBe(150);

    act(() => result.current.handleResetZoom());
    expect(result.current.viewport.zoom).toBe(1);
    expect(result.current.viewport.x).toBe(150);
    expect(result.current.viewport.y).toBe(90);
  });

  it('recenters pan while preserving zoom', () => {
    const { result } = renderViewport();
    act(() => result.current.handleZoomIn());
    const zoomBefore = result.current.viewport.zoom;
    act(() => result.current.handleStageMouseDown(mouseDownEvent()));
    act(() => panBy(150, 90));

    act(() => result.current.handleRecenter());
    expect(result.current.viewport.zoom).toBe(zoomBefore);
    expect(result.current.viewport.x).toBe(0);
    expect(result.current.viewport.y).toBe(0);
  });

  it('fully resets to the fitted default view', () => {
    const { result } = renderViewport();
    act(() => result.current.handleZoomIn());
    act(() => result.current.handleStageMouseDown(mouseDownEvent()));
    act(() => panBy(40, 60));

    act(() => result.current.handleStageReset());
    expect(result.current.viewport).toEqual({ zoom: 1, x: 0, y: 0 });
  });
});

describe('viewport actual pixel scale', () => {
  it('combines fitted stage size with viewport zoom and updates when resized', () => {
    let width = 960;
    let height = 540;
    let notifyResize = () => {};
    class Observer {
      constructor(callback: () => void) { notifyResize = callback; }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', Observer);
    const stage = document.createElement('div');
    Object.defineProperties(stage, {
      clientWidth: { get: () => width },
      clientHeight: { get: () => height },
    });
    const { result } = renderHook(() => useViewport({ current: stage }));
    expect(result.current.actualScale).toBe(0.5);
    act(() => result.current.handleZoomIn());
    expect(result.current.actualScale).toBeCloseTo(0.6);
    width = 1920;
    height = 600;
    act(notifyResize);
    expect(result.current.actualScale).toBeCloseTo((600 / 1080) * 1.2);
    act(() => result.current.handleResetZoom());
    expect(result.current.actualScale).toBeCloseTo(600 / 1080);
    act(() => result.current.handleStageReset());
    expect(result.current.actualScale).toBeCloseTo(600 / 1080);
  });

  it('disconnects its size observer and remeasures when the stage is reenabled', () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      observe = observe;
      disconnect = disconnect;
    });
    const stage = document.createElement('div');
    Object.defineProperties(stage, {
      clientWidth: { value: 960 }, clientHeight: { value: 540 },
    });
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useViewport({ current: stage }, enabled),
      { initialProps: { enabled: false } },
    );
    expect(observe).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(result.current.actualScale).toBe(0.5);
    expect(observe).toHaveBeenCalledWith(stage);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});

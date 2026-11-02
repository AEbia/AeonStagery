/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { Profiler } from 'react';
import { Live2DResourceSelect } from '../ui/timeline/inspector/Live2DResourceSelect';
import type { PreviewRequest } from '../ui/live2d/previewProtocol';

const context = vi.hoisted(() => ({
  resolveForRead: vi.fn(async () => '/project/figure/model.json'),
  stage: { playMotion: vi.fn(), stopAllMotions: vi.fn(), setExpression: vi.fn() },
}));
vi.mock('../ui/context/AppContext', () => {
  const projectResources = { getCurrentProject: () => ({}), resolveForRead: context.resolveForRead };
  return { useOptionalApp: () => ({
    adapters: { character: context.stage }, services: { projectResources },
  }) };
});

function reply(frame: HTMLIFrameElement, message: unknown) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: message })); });
}

function controlAnimations() {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  const motions: Animation[] = [];
  const animate = vi.fn<HTMLElement['animate']>(() => {
    let finish!: (animation: Animation) => void;
    let cancel!: (reason: unknown) => void;
    let state: AnimationPlayState = 'running';
    const finished = new Promise<Animation>((resolve, reject) => { finish = resolve; cancel = reject; });
    const animation = mock<Animation>();
    Object.defineProperty(animation, 'finished', { get: () => finished });
    Object.defineProperty(animation, 'playState', { get: () => state });
    animation.finish.mockImplementation(() => { state = 'finished'; finish(animation); });
    animation.cancel.mockImplementation(() => { state = 'idle'; cancel(new DOMException('Cancelled', 'AbortError')); });
    motions.push(animation);
    return animation;
  });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  return { animate, motions, restore: () => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'animate', original);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  } };
}

describe('isolated resource preview selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(['motion', 'expression'] as const)('sends %s to its own frame and keeps the stage untouched', async (kind) => {
    const onChange = vi.fn();
    render(<Live2DResourceSelect kind={kind} modelPath="figure/model.json" value="idle"
      options={['idle', 'wave', 'smile']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
    const frame = await screen.findByTitle(kind === 'motion' ? '动作预览模型' : '表情预览模型') as HTMLIFrameElement;
    const send = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'live2d-preview:play', modelUrl: 'asset://localhost//project/figure/model.json', kind, key: 'wave',
    });
    expect(context.resolveForRead).toHaveBeenCalledWith('figure/model.json');

    // Leaving the list retains the preview. Clicking the same row replays it.
    fireEvent.mouseLeave(screen.getByRole('listbox', { name: '可选项' }));
    fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const wave = send.mock.calls.at(-1)?.[0] as PreviewRequest;
    fireEvent.click(screen.getByRole('button', { name: '预览 smile' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const smile = send.mock.calls.at(-1)?.[0] as PreviewRequest;
    expect(smile.key).toBe('smile');
    reply(frame, { type: 'live2d-preview:error', requestId: wave.requestId, message: 'stale failure' });
    expect(screen.queryByRole('alert')).toBeNull();
    reply(frame, { type: 'live2d-preview:played', requestId: smile.requestId });
    await waitFor(() => expect(screen.getByRole('button', { name: '重播' })).not.toBeDisabled());

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
    expect(frame.closest('section')).toHaveAttribute('data-state', 'closing');
    await waitFor(() => expect(frame).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
    for (const action of Object.values(context.stage)) expect(action).not.toHaveBeenCalled();
  });

  it('commits only the selected value and disposes the preview frame', async () => {
    const onChange = vi.fn();
    render(<Live2DResourceSelect kind="motion" modelPath="figure/model.json" value="idle"
      options={['idle', 'wave']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
    await screen.findByTitle('动作预览模型');
    fireEvent.click(screen.getByRole('option', { name: 'wave' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('wave');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(screen.queryByTitle('动作预览模型')).toBeNull());
    expect(context.stage.playMotion).not.toHaveBeenCalled();
  });

  it('reports path resolution failures and resolves again on retry', async () => {
    context.resolveForRead.mockRejectedValueOnce(new Error('模型资源尚未就绪'));
    render(<Live2DResourceSelect kind="motion" modelPath="figure/model.json" value=""
      options={['wave']} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('模型资源尚未就绪');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByTitle('动作预览模型');
    expect(context.resolveForRead).toHaveBeenCalledTimes(2);
  });

  it.each(['escape', 'trigger', 'preview close'] as const)('finishes the exit and releases its frame on %s', async (method) => {
    render(<Live2DResourceSelect kind="motion" modelPath="figure/model.json" value="idle"
      options={['idle', 'wave']} onChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
    const frame = await screen.findByTitle('动作预览模型');
    const panel = screen.getByRole('dialog');
    if (method === 'escape') fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    else if (method === 'trigger') fireEvent.click(trigger);
    else {
      const close = screen.getByRole('button', { name: '关闭角色预览' });
      close.focus();
      fireEvent.click(close);
      expect(trigger).toHaveFocus();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    }
    expect(panel).toHaveAttribute('data-state', 'closing');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
    expect(panel.inert).toBe(true);
    expect(frame).toBeInTheDocument();
    await waitFor(() => expect(frame).not.toBeInTheDocument());
  });

  it('keeps preview controls inside the picker and cancels an interrupted exit on replay', async () => {
    render(<Live2DResourceSelect kind="motion" modelPath="figure/model.json" value="idle"
      options={['idle', 'wave']} onChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
    const frame = await screen.findByTitle('动作预览模型') as HTMLIFrameElement;
    const send = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    await waitFor(() => expect(send).toHaveBeenCalled());
    const request = send.mock.calls.at(-1)?.[0] as PreviewRequest;
    reply(frame, { type: 'live2d-preview:played', requestId: request.requestId });
    const replayButton = screen.getByRole('button', { name: '重播' });
    fireEvent.pointerDown(replayButton);
    fireEvent.click(replayButton);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    vi.useFakeTimers();
    try {
      fireEvent.click(trigger);
      act(() => { vi.advanceTimersByTime(80); });
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
      act(() => { vi.advanceTimersByTime(200); });
      expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'open');
      expect(screen.getByTitle('动作预览模型')).toBe(frame);
      expect(context.resolveForRead).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('does not lose a new exit to an animationend queued by an interrupted exit', async () => {
    render(<Live2DResourceSelect kind="motion" modelPath="figure/model.json" value="idle"
      options={['idle', 'wave']} onChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
    const frame = await screen.findByTitle('动作预览模型');
    const panel = screen.getByRole('dialog');
    // React 18 uses the prefixed event in jsdom, which lacks AnimationEvent.
    const eventName = !('AnimationEvent' in window) && 'WebkitAnimation' in panel.style ? 'webkitAnimationEnd' : 'animationend';
    const staleExitEnd = new Event(eventName, { bubbles: true });
    Object.defineProperty(staleExitEnd, 'animationName', { value: 'live2d-resource-preview-out' });
    vi.useFakeTimers();
    try {
      fireEvent.click(trigger);
      act(() => { vi.advanceTimersByTime(40); });
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
      fireEvent.click(trigger);
      fireEvent(panel, staleExitEnd);
      expect(frame).toBeInTheDocument();
      expect(panel).toHaveAttribute('data-state', 'closing');
      act(() => { vi.advanceTimersByTime(160); });
      expect(frame).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it('keeps the frame until the browser finishes its exit when rendering is delayed', async () => {
    const driver = controlAnimations();
    try {
      render(<Live2DResourceSelect kind="motion" modelPath="figure/model.json" value="idle"
        options={['idle', 'wave']} onChange={vi.fn()} />);
      fireEvent.click(screen.getByRole('combobox'));
      fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
      const frame = await screen.findByTitle('动作预览模型');
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole('combobox'));
      // The JS timer can advance before the browser has rendered every animation frame.
      act(() => { vi.advanceTimersByTime(200); });
      expect(frame).toBeInTheDocument();
      await act(async () => { driver.motions.at(-1)!.finish(); });
      expect(frame).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); driver.restore(); }
  });

  it('starts each rapid reversal from the presented pose and ignores interrupted completions', async () => {
    const driver = controlAnimations();
    try {
      render(<Live2DResourceSelect kind="motion" modelPath="figure/model.json" value="idle"
        options={['idle', 'wave']} onChange={vi.fn()} />);
      const trigger = screen.getByRole('combobox');
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
      const frame = await screen.findByTitle('动作预览模型');
      const panel = screen.getByRole('dialog');
      expect(driver.animate).toHaveBeenCalledTimes(1);
      const computedStyle = window.getComputedStyle.bind(window);
      const pose = { opacity: '0.45', transform: 'matrix(0.98, 0, 0, 0.98, 5, 0)' };
      vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
        const style = computedStyle(element, pseudo);
        if (element === panel) { style.opacity = pose.opacity; style.transform = pose.transform; }
        return style;
      });
      for (let index = 0; index < 5; index++) {
        fireEvent.click(trigger);
        const interruptedExit = driver.motions.at(-1)!;
        expect(driver.animate.mock.calls.at(-1)?.[0]).toEqual([pose, expect.objectContaining({ opacity: '0' })]);
        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
        expect(driver.animate.mock.calls.at(-1)?.[0]).toEqual([pose, expect.objectContaining({ opacity: '1' })]);
        await act(async () => { interruptedExit.finish(); });
        expect(frame).toBeInTheDocument();
        expect(panel).toHaveAttribute('data-state', 'open');
      }
      expect(driver.animate).toHaveBeenCalledTimes(11);
      expect(context.resolveForRead).toHaveBeenCalledTimes(1);
      fireEvent.click(trigger);
      await act(async () => { driver.motions.at(-1)!.finish(); });
      expect(frame).not.toBeInTheDocument();
    } finally { driver.restore(); }
  });

  it.each(['hidden', 'low performance'] as const)('releases an active exit when motion is disabled by %s', async (preference) => {
    const driver = controlAnimations();
    const originalPerformance = document.documentElement.getAttribute('data-perf');
    try {
      render(<Live2DResourceSelect kind="motion" modelPath="figure/model.json" value="idle"
        options={['idle', 'wave']} onChange={vi.fn()} />);
      const trigger = screen.getByRole('combobox');
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
      const frame = await screen.findByTitle('动作预览模型');
      fireEvent.click(trigger);
      expect(frame).toBeInTheDocument();
      await act(async () => {
        if (preference === 'hidden') {
          vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
          document.dispatchEvent(new Event('visibilitychange'));
        } else document.documentElement.setAttribute('data-perf', 'low');
      });
      expect(frame).not.toBeInTheDocument();
      expect(driver.motions.at(-1)?.cancel).toHaveBeenCalled();
    } finally {
      driver.restore();
      if (originalPerformance === null) document.documentElement.removeAttribute('data-perf');
      else document.documentElement.setAttribute('data-perf', originalPerformance);
    }
  });

  it('releases the frame immediately with reduced motion', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    render(<Live2DResourceSelect kind="expression" modelPath="figure/model.json" value=""
      options={['smile']} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('button', { name: '预览 smile' }));
    const frame = await screen.findByTitle('表情预览模型');
    fireEvent.pointerDown(document.body);
    expect(frame).not.toBeInTheDocument();
  });

  it.each(['trigger', 'outside', 'preview close'] as const)('keeps its last position during %s closure and late resize delivery', async (method) => {
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('innerHeight', 800);
    let reportResize: (() => void) | undefined;
    vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { reportResize = () => callback([], this); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const { container } = render(<Live2DResourceSelect kind="motion" modelPath="figure/model.json" value="idle"
      options={['idle', 'wave']} onChange={vi.fn()} onOpenChange={(open) => {
        if (open) return;
        // Deliver the removed list's resize before the preview's closing render commits.
        reportResize?.();
        vi.advanceTimersByTime(20);
      }} />);
    const picker = container.querySelector('.live2d-resource-select')!;
    const anchor = vi.spyOn(picker, 'getBoundingClientRect').mockReturnValue(new DOMRect(1000, 100, 260, 32));
    fireEvent.click(screen.getByRole('combobox'));
    const overlay = container.querySelector('.searchable-select-overlay')!;
    vi.spyOn(overlay, 'getBoundingClientRect').mockImplementation(() =>
      overlay.isConnected ? new DOMRect(1000, 132, 260, 360) : new DOMRect());
    fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
    const frame = await screen.findByTitle('动作预览模型');
    const panel = screen.getByRole('dialog');
    const initialStyle = panel.style.cssText;
    vi.useFakeTimers();
    try {
      if (method === 'trigger') fireEvent.click(screen.getByRole('combobox'));
      else if (method === 'outside') fireEvent.pointerDown(document.body);
      else fireEvent.click(screen.getByRole('button', { name: '关闭角色预览' }));
      expect(panel).toHaveAttribute('data-state', 'closing');
      expect(panel.style.cssText).toBe(initialStyle);
      // A queued observer delivery must also be inert after the preview starts exiting.
      anchor.mockReturnValue(new DOMRect(900, 200, 260, 32));
      act(() => { reportResize?.(); vi.advanceTimersByTime(20); });
      expect(panel.style.cssText).toBe(initialStyle);
      act(() => { vi.advanceTimersByTime(160); });
      expect(frame).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it.each(['resource list', 'unrelated panel', 'window', 'resize'] as const)(
    'skips redundant preview work for %s events that leave the picker in place', async (target) => {
      vi.stubGlobal('innerWidth', 1280);
      vi.stubGlobal('innerHeight', 800);
      const onRender = vi.fn();
      const { container } = render(<Profiler id="preview" onRender={onRender}>
        <Live2DResourceSelect kind="motion" modelPath="figure/model.json" value="idle"
          options={['idle', 'wave']} onChange={vi.fn()} />
        <div data-testid="unrelated-panel" />
      </Profiler>);
      const picker = container.querySelector('.live2d-resource-select')!;
      const measure = vi.spyOn(picker, 'getBoundingClientRect').mockReturnValue(new DOMRect(1000, 100, 260, 32));
      fireEvent.click(screen.getByRole('combobox'));
      const overlay = container.querySelector('.searchable-select-overlay')!;
      vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(1000, 132, 260, 360));
      fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
      await screen.findByTitle('动作预览模型');
      measure.mockClear();
      onRender.mockClear();
      vi.useFakeTimers();
      try {
        if (target === 'resize') fireEvent.resize(window);
        else fireEvent.scroll(target === 'window' ? window : target === 'resource list'
          ? screen.getByRole('listbox', { name: '可选项' }) : screen.getByTestId('unrelated-panel'));
        act(() => { vi.advanceTimersByTime(40); });
        expect(measure).toHaveBeenCalledTimes(target === 'window' || target === 'resize' ? 1 : 0);
        expect(onRender).not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    },
  );

  it('follows the picker until dragged, then keeps the chosen position and fits a smaller workspace', async () => {
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('innerHeight', 800);
    vi.stubGlobal('PointerEvent', MouseEvent);
    const { container } = render(<Live2DResourceSelect kind="motion" modelPath="figure/model.json" value="idle"
      options={['idle', 'wave']} onChange={vi.fn()} />);
    const picker = container.querySelector('.live2d-resource-select')!;
    const anchor = vi.spyOn(picker, 'getBoundingClientRect').mockReturnValue(new DOMRect(1000, 100, 260, 32));
    fireEvent.click(screen.getByRole('combobox'));
    const overlay = container.querySelector('.searchable-select-overlay')!;
    const list = vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(1000, 132, 260, 360));
    fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
    await screen.findByTitle('动作预览模型');
    const panel = screen.getByRole('dialog');
    const initialLeft = Number.parseFloat(panel.style.left);
    expect(initialLeft + Number.parseFloat(panel.style.width)).toBeLessThan(1000);
    vi.useFakeTimers();
    try {
      anchor.mockReturnValue(new DOMRect(900, 100, 260, 32));
      list.mockReturnValue(new DOMRect(900, 132, 260, 360));
      fireEvent.scroll(container);
      act(() => { vi.advanceTimersByTime(40); });
      expect(Number.parseFloat(panel.style.left)).toBeLessThan(initialLeft);
      const header = panel.querySelector('header')!;
      Object.defineProperty(header, 'setPointerCapture', { value: vi.fn() });
      const left = Number.parseFloat(panel.style.left);
      fireEvent.pointerDown(header, { button: 0, clientX: left + 16, clientY: 116 });
      fireEvent.pointerMove(header, { clientX: 64, clientY: 64 });
      fireEvent.pointerUp(header);
      expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true');
      expect(panel.style.left).toBe('48px');
      expect(panel.style.top).toBe('48px');
      fireEvent.scroll(window);
      act(() => { vi.advanceTimersByTime(40); });
      expect(panel.style.left).toBe('48px');
      expect(panel.style.top).toBe('48px');
      vi.stubGlobal('innerWidth', 640);
      vi.stubGlobal('innerHeight', 360);
      fireEvent.resize(window);
      act(() => { vi.advanceTimersByTime(40); });
      expect(Number.parseFloat(panel.style.left) + Number.parseFloat(panel.style.width)).toBeLessThanOrEqual(628);
      expect(Number.parseFloat(panel.style.top) + Number.parseFloat(panel.style.height)).toBeLessThanOrEqual(348);
    } finally { vi.useRealTimers(); }
  });
});

/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';
import CustomAnimHost from '../engine/CustomAnimHost';

function createActiveAnimation(id: string, file = `${id}.html`): any {
  return {
    id,
    iframe: { contentWindow: { postMessage: vi.fn() } },
    container: document.createElement('div'),
    file,
    duration: 5,
    layer: 'overlay',
    ready: true,
    runtimeKey: id,
  };
}

describe('CustomAnimHost capture and keyed runtime state', () => {
  it('rejects export capture when an active animation has no verifiable frame', async () => {
    const host = new CustomAnimHost();
    const animation = createActiveAnimation('missing');
    (host as any).activeAnims = new Map([[animation.id, animation]]);
    vi.spyOn(host as any, 'requestAnimationCapture').mockResolvedValue(null);

    await expect(host.captureFrame(1, 1, 2)).rejects.toThrow(/capture unavailable/);
  });

  it('composites every active custom frame instead of keeping only the first', async () => {
    const host = new CustomAnimHost();
    const first = createActiveAnimation('first');
    const second = createActiveAnimation('second');
    (host as any).activeAnims = new Map([
      [first.id, first],
      [second.id, second],
    ]);
    vi.spyOn(host as any, 'requestAnimationCapture')
      .mockResolvedValueOnce({ width: 1, height: 1, pixels: new Uint8ClampedArray([255, 0, 0, 255]) })
      .mockResolvedValueOnce({ width: 1, height: 1, pixels: new Uint8ClampedArray([0, 0, 255, 255]) });

    const frame = await host.captureFrame(1, 1, 2);

    expect(Array.from(frame?.pixels ?? [])).toEqual([0, 0, 255, 255]);
  });

  it('awaits manual seek dispatch and uses local animation time', async () => {
    const host = new CustomAnimHost();
    const animation = createActiveAnimation('manual');
    animation.startTime = 2;
    animation.iframe.contentWindow.postMessage.mockImplementation((command: any) => {
      if (command.type === 'seek') {
        queueMicrotask(() => (host as any).resolveSeekAck(animation, {
          type: 'rendered',
          requestId: command.requestId,
          time: command.time,
        }));
      }
    });
    (host as any).activeAnims = new Map([[animation.id, animation]]);

    await host.seek(5);

    expect(animation.iframe.contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'seek', time: 3, requestId: expect.any(String) }),
      '*',
    );
    expect(animation.currentTime).toBe(3);
  });

  it('recreates a keyed animation when its runtime source changes', async () => {
    const host = new CustomAnimHost();
    const animation = createActiveAnimation('replace', 'old.html');
    (host as any).activeAnims = new Map([[animation.id, animation]]);
    (host as any).hostContainer = document.createElement('div');
    const stopAnimation = vi.spyOn(host, 'stopAnimation').mockImplementation(() => {});
    const playAnimation = vi.spyOn(host, 'playAnimation').mockResolvedValue('new-id');

    await host.reconcileAtTime([{
      key: 'replace',
      file: 'new.html',
      duration: 5,
      layer: 'overlay',
      elapsed: 1,
      startTime: 0,
    }]);

    expect(stopAnimation).toHaveBeenCalledWith('replace', 0);
    expect(playAnimation).toHaveBeenCalledWith('new.html', 5, 'overlay', expect.objectContaining({
      runtimeKey: 'replace',
      initialTime: 1,
    }));
  });

  it('keeps reconstruction paused and ignores iframe completion in manual-time mode', async () => {
    const host = new CustomAnimHost();
    const root = document.createElement('div');
    host.init(root);
    const readyPromise = host.playAnimation('manual.html', 5, 'overlay', {
      runtimeKey: 'manual-runtime',
      initialTime: 2,
      startTime: 0,
      manualTime: true,
      paused: true,
    });
    const iframe = root.querySelector('iframe')!;
    const source = { postMessage: vi.fn() };
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: source });
    const postMessage = source.postMessage;

    (host as any).handleMessage({ source, data: { type: 'ready', duration: 5 } });
    await Promise.resolve();
    const seekCommand = Array.from(postMessage.mock.calls ?? [])
      .map((call: any[]) => call[0])
      .find((command: any) => command?.type === 'seek');
    const postedCommands = postMessage.mock.calls.map((call: any[]) => call[0]);
    expect(postedCommands.map((command: any) => command.type)).toEqual(['pause', 'seek']);
    expect(seekCommand).toEqual(expect.objectContaining({ time: 2, requestId: expect.any(String) }));

    (host as any).handleMessage({
      source,
      data: { type: 'rendered', requestId: seekCommand.requestId, time: 2 },
    });
    const id = await readyPromise;

    expect((host as any).activeAnims.get(id).manualTime).toBe(true);
    expect((host as any).activeAnims.get(id).autoRemoveTimer).toBeUndefined();
    (host as any).handleMessage({ source, data: { type: 'complete' } });
    expect(host.getActiveAnimationCount()).toBe(1);

    host.destroy();
  });

  it('rejects playAnimation on iframe error and playFromHTML when cleared before ready', async () => {
    const host = new CustomAnimHost();
    const root = document.createElement('div');
    host.init(root);

    const filePromise = host.playAnimation('error.html', 5);
    const fileIframe = root.querySelector('iframe')!;
    const fileSource = { postMessage: vi.fn() };
    Object.defineProperty(fileIframe, 'contentWindow', { configurable: true, value: fileSource });
    (host as any).handleMessage({
      source: fileSource,
      data: { type: 'error', error: 'html failed before ready' },
    });

    await expect(filePromise).rejects.toThrow(/reported an error/);

    const inlinePromise = host.playFromHTML('<script>throw new Error("boom")</script>', 5);
    host.clear();

    await expect(inlinePromise).rejects.toThrow(/stopped before it became ready/);
    expect(host.getActiveAnimationCount()).toBe(0);
    host.destroy();
  });

  it('removes a manual animation when the target time leaves its action interval', async () => {
    const host = new CustomAnimHost();
    const animation = createActiveAnimation('interval');
    animation.manualTime = true;
    animation.startTime = 2;
    animation.duration = 3;
    (host as any).activeAnims = new Map([[animation.id, animation]]);

    await host.seek(5);

    expect(host.getActiveAnimationCount()).toBe(0);
  });

  it('disconnects the per-animation ResizeObserver on stop', async () => {
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn();
      disconnect = disconnect;
    });
    const host = new CustomAnimHost();
    const root = document.createElement('div');
    host.init(root);
    const readyPromise = host.playAnimation('observer.html', 5);
    const iframe = root.querySelector('iframe')!;
    const source = { postMessage: vi.fn() };
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: source });
    (host as any).handleMessage({ source, data: { type: 'ready' } });
    const id = await readyPromise;

    host.stopAnimation(id, 0);

    expect(disconnect).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('throws when an active custom capture provider returns no frame', async () => {
    const host = new CustomAnimHost();
    const animation = createActiveAnimation('provider-missing');
    (host as any).activeAnims = new Map([[animation.id, animation]]);
    host.setCaptureProvider(() => null);

    await expect(host.captureFrame(1, 1, 1)).rejects.toThrow(/returned no frame/);
  });
});

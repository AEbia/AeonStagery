/**
 * AeonStagery — Custom Animation Host
 *
 * Hosts AI-generated HTML/CSS/JS animations in sandboxed iframes.
 * Provides a postMessage-based communication protocol for control.
 *
 * This is the key differentiator from WebGAL — it allows arbitrary
 * front-end code to be loaded as animation overlays.
 */

import gsap from 'gsap';
import { hookSystem } from '../api/hooks';
import type { LayerName } from '../api/types/common';

interface ActiveCustomAnim {
  id: string;
  iframe: HTMLIFrameElement;
  container: HTMLDivElement;
  file: string;
  duration: number;
  layer: LayerName;
  ready: boolean;
  runtimeKey?: string;
  startTime?: number;
  currentTime?: number;
  manualTime: boolean;
  resizeObserver?: ResizeObserver;
  readyTimer?: number;
  autoRemoveTimer?: number;
  readyHandling: boolean;
  readySettled: boolean;
  onReady?: () => void;
  readyReject?: (error: unknown) => void;
}

interface PlayAnimationOptions {
  runtimeKey?: string;
  initialTime?: number;
  startTime?: number;
  /** Keep the iframe paused and drive it exclusively through seek(). */
  manualTime?: boolean;
  /** Alias for callers that only need a paused initial state. */
  paused?: boolean;
}

interface PendingSeekAck {
  animId: string;
  time: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  timeout: number;
}

const SEEK_ACK_TIMEOUT_MS = 250;

export interface CustomAnimationCaptureFrame {
  width: number;
  height: number;
  pixels?: Uint8Array | Uint8ClampedArray;
  canvas?: HTMLCanvasElement | OffscreenCanvas;
}

export type CustomAnimationCaptureProvider = (
  width: number,
  height: number,
  sceneTime?: number,
) => CustomAnimationCaptureFrame | null | Promise<CustomAnimationCaptureFrame | null>;

class CustomAnimHost {
  private activeAnims: Map<string, ActiveCustomAnim> = new Map();
  private animCounter = 0;
  private captureCounter = 0;
  private seekCounter = 0;
  private captureProvider: CustomAnimationCaptureProvider | null = null;
  private hostContainer: HTMLElement | null = null;
  private pendingSeekAcks: Map<string, PendingSeekAck> = new Map();
  private readonly boundMessageHandler = (event: MessageEvent) => this.handleMessage(event);

  /**
   * Initialize the host by creating a container div
   * that overlays the PixiJS canvas.
   */
  init(stageContainer: HTMLElement): void {
    this.hostContainer = document.createElement('div');
    this.hostContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: hidden;
      z-index: 10;
    `;
    stageContainer.appendChild(this.hostContainer);

    // Listen for messages from iframes
    window.addEventListener('message', this.boundMessageHandler);
  }

  /**
   * Load and play a custom HTML animation.
   *
   * @param htmlFilePath Path to the HTML animation file
   * @param duration Expected duration in seconds
   * @param layer Which layer to display on ('overlay' or 'effects')
   * @returns Animation ID for control
   */
  async playAnimation(
    htmlFilePath: string,
    duration: number,
    layer: LayerName = 'overlay',
    options?: PlayAnimationOptions,
  ): Promise<string> {
    if (!this.hostContainer) {
      throw new Error('[CustomAnimHost] Not initialized');
    }

    const id = `custom-anim-${++this.animCounter}`;

    hookSystem.execute('animation:custom', { id, file: htmlFilePath, duration });

    // Create container div for positioning
    const container = document.createElement('div');
    container.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.3s ease;
    `;

    // Create sandboxed iframe
    const iframe = document.createElement('iframe');
    iframe.sandbox?.add('allow-scripts');
    // Do NOT add allow-same-origin for security
    iframe.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 1920px;
      height: 1080px;
      border: none;
      background: transparent;
      pointer-events: none;
      transform-origin: top left;
    `;

    // Scale iframe to fit container
    const scaleIframe = () => {
      if (!this.hostContainer) return;
      const scaleX = this.hostContainer.clientWidth / 1920;
      const scaleY = this.hostContainer.clientHeight / 1080;
      const scale = Math.min(scaleX, scaleY);
      iframe.style.transform = `scale(${scale})`;
      iframe.style.left = `${(this.hostContainer.clientWidth - 1920 * scale) / 2}px`;
      iframe.style.top = `${(this.hostContainer.clientHeight - 1080 * scale) / 2}px`;
    };

    container.appendChild(iframe);
    this.hostContainer.appendChild(container);

    // Set z-index based on layer
    const zIndexMap: Record<string, number> = {
      background: 1,
      effects: 5,
      overlay: 15,
      customAnimation: 10,
    };
    container.style.zIndex = String(zIndexMap[layer] ?? 10);

    const manualTime = options?.manualTime === true
      || options?.paused === true
      || options?.initialTime !== undefined;
    const anim: ActiveCustomAnim = {
      id,
      iframe,
      container,
      file: htmlFilePath,
      duration,
      layer,
      ready: false,
      runtimeKey: options?.runtimeKey,
      startTime: options?.startTime,
      currentTime: options?.initialTime ?? 0,
      manualTime,
      readyHandling: false,
      readySettled: false,
    };

    this.activeAnims.set(id, anim);

    // Load the HTML file
    return new Promise<string>((resolve, reject) => {
      anim.readyReject = reject;
      anim.onReady = () => {
        if (anim.readyHandling || anim.readySettled) return;
        anim.readyHandling = true;
        void (async () => {
          try {
            container.style.opacity = '1';
            if (anim.manualTime) {
              // A reconstructed/exported iframe must never run between its
              // load event and the deterministic seek acknowledgement.
              await this.seekAnimation(anim, options?.initialTime ?? 0);
              this.sendCommand(id, { type: 'pause' });
            } else {
              this.sendCommand(id, { type: 'play' });
              this.armAutoRemove(anim);
            }
            anim.readySettled = true;
            anim.readyReject = undefined;
            resolve(id);
          } catch (error) {
            anim.readySettled = true;
            anim.readyReject = undefined;
            this.stopAnimation(id, 0, error);
            reject(error);
          }
        })();
      };

      // Set up resize observer and retain it so every animation can disconnect
      // its own observer when it leaves the runtime.
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(scaleIframe);
        anim.resizeObserver = observer;
        if (this.hostContainer) observer.observe(this.hostContainer);
      }
      scaleIframe();

      // Load the file
      iframe.src = htmlFilePath;

      // Timeout: auto-ready after 3 seconds if no message received
      anim.readyTimer = window.setTimeout(() => {
        if (!anim.ready) {
          anim.ready = true;
          anim.onReady?.();
        }
      }, 3000);
    });
  }

  /**
   * Load animation from raw HTML string instead of file.
   */
  async playFromHTML(
    htmlContent: string,
    duration: number,
    layer: LayerName = 'overlay',
    options?: PlayAnimationOptions,
  ): Promise<string> {
    if (!this.hostContainer) {
      throw new Error('[CustomAnimHost] Not initialized');
    }

    const id = `custom-anim-${++this.animCounter}`;

    const container = document.createElement('div');
    container.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none; opacity: 0; transition: opacity 0.3s ease;
    `;

    const iframe = document.createElement('iframe');
    iframe.sandbox?.add('allow-scripts');
    iframe.style.cssText = `
      position: absolute; top: 0; left: 0; width: 1920px; height: 1080px;
      border: none; background: transparent; pointer-events: none;
      transform-origin: top left;
    `;

    container.appendChild(iframe);
    this.hostContainer.appendChild(container);

    const manualTime = options?.manualTime === true || options?.paused === true || options?.initialTime !== undefined;
    const anim: ActiveCustomAnim = {
      id, iframe, container, file: 'inline-html', duration, layer, ready: false,
      runtimeKey: options?.runtimeKey,
      startTime: options?.startTime,
      currentTime: options?.initialTime ?? 0,
      manualTime,
      readyHandling: false,
      readySettled: false,
    };

    this.activeAnims.set(id, anim);

    // Use srcdoc for inline HTML
    iframe.srcdoc = htmlContent;

    return new Promise<string>((resolve, reject) => {
      anim.readyReject = reject;
      anim.onReady = () => {
        if (anim.readyHandling || anim.readySettled) return;
        anim.readyHandling = true;
        void (async () => {
          try {
            container.style.opacity = '1';
            if (anim.manualTime) {
              await this.seekAnimation(anim, options?.initialTime ?? 0);
              this.sendCommand(id, { type: 'pause' });
            } else {
              this.sendCommand(id, { type: 'play' });
              this.armAutoRemove(anim);
            }
            anim.readySettled = true;
            anim.readyReject = undefined;
            resolve(id);
          } catch (error) {
            anim.readySettled = true;
            anim.readyReject = undefined;
            this.stopAnimation(id, 0, error);
            reject(error);
          }
        })();
      };

      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => undefined);
        anim.resizeObserver = observer;
        if (this.hostContainer) observer.observe(this.hostContainer);
      }

      anim.readyTimer = window.setTimeout(() => {
        if (!anim.ready) {
          anim.ready = true;
          anim.onReady?.();
        }
      }, 3000);
    });
  }

  /**
   * Send a command to a custom animation iframe.
   */
  sendCommand(animId: string, command: { type: string; [key: string]: any }): void {
    const anim = this.activeAnims.get(animId);
    if (!anim || !anim.iframe.contentWindow) return;

    anim.iframe.contentWindow.postMessage(command, '*');
  }

  /**
   * Optional runtime capture seam used by export.  A host embedding Aeon
   * animations can provide a compositor here; the built-in fallback below
   * also supports the `capture`/`captureFrame` postMessage protocol.
   */
  setCaptureProvider(provider: CustomAnimationCaptureProvider | null): void {
    this.captureProvider = provider;
  }

  /**
   * Ask active HTML animations for raster output.  DOM/iframe visibility is
   * deliberately not treated as captured output: the returned RGBA pixels or
   * canvas are composited into the Pixi frame by FrameCaptureEngine.
   */
  async captureFrame(
    width: number,
    height: number,
    sceneTime?: number,
  ): Promise<CustomAnimationCaptureFrame | null> {
    if (sceneTime !== undefined) this.removeAnimationsOutsideInterval(sceneTime);
    if (this.captureProvider) {
      let frame: CustomAnimationCaptureFrame | null;
      try {
        frame = await this.captureProvider(width, height, sceneTime);
      } catch (error) {
        throw new Error(
          `Custom HTML animation capture provider failed: ${String(error)}. `
          + 'Fix the provider or return verifiable RGBA pixels/canvas before exporting.',
        );
      }
      if (frame) this.validateCaptureFrame(frame, width, height);
      if (!frame && this.activeAnims.size > 0) {
        throw new Error(
          `Custom HTML animation capture provider returned no frame at ${sceneTime ?? 0}s. `
          + 'Return verifiable RGBA pixels/canvas for every active animation before exporting.',
        );
      }
      return frame;
    }

    if (this.activeAnims.size === 0) return null;
    if (typeof window === 'undefined') {
      throw new Error(
        'Custom HTML animation capture is unavailable without a browser window. '
        + 'Register a server-side capture provider before exporting.',
      );
    }
    const results = await Promise.all(
      Array.from(this.activeAnims.values()).map(async (anim) => ({
          anim,
          frame: await this.requestAnimationCapture(anim, width, height, sceneTime),
        })),
    );
    const missing = results.filter((result) => result.frame === null);
    if (missing.length > 0) {
      const ids = missing.map(({ anim }) => anim.runtimeKey ?? anim.id).join(', ');
      throw new Error(
        `Custom HTML animation capture unavailable for ${ids}. `
        + 'Register a capture provider or implement the iframe captureFrame response before exporting.',
      );
    }
    const frames = results.map((result) => result.frame!);
    return this.composeCaptureFrames(frames, width, height);
  }

  /** Number of active HTML animations that must be represented in an export frame. */
  getActiveAnimationCount(): number {
    return this.activeAnims.size;
  }

  /** Pause every iframe without changing the host's manual-time ownership. */
  pause(): void {
    for (const id of this.activeAnims.keys()) this.sendCommand(id, { type: 'pause' });
  }

  /** Resume interactive iframe playback after a seek/manual-time pause. */
  resume(): void {
    for (const anim of this.activeAnims.values()) {
      anim.manualTime = false;
      this.sendCommand(anim.id, { type: 'play' });
      this.armAutoRemove(anim);
    }
  }

  /** Explicitly enter or leave deterministic manual-time mode. */
  setManualTimeMode(enabled: boolean): void {
    for (const anim of this.activeAnims.values()) {
      anim.manualTime = enabled;
      if (enabled) {
        this.clearAutoRemove(anim);
        this.sendCommand(anim.id, { type: 'pause' });
      } else {
        this.sendCommand(anim.id, { type: 'play' });
        this.armAutoRemove(anim);
      }
    }
  }

  /** Forward deterministic scene time and await the iframe's rendered ack. */
  async seek(sceneTime: number): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const anim of [...this.activeAnims.values()]) {
      const localTime = anim.startTime === undefined ? sceneTime : sceneTime - anim.startTime;
      if ((anim.manualTime || anim.startTime !== undefined)
        && (localTime < 0 || localTime >= Math.max(0, anim.duration))) {
        this.stopAnimation(anim.id, 0);
        continue;
      }
      pending.push(this.seekAnimation(anim, Math.max(0, localTime)));
    }
    await Promise.all(pending);
  }

  /**
   * Rebuild active custom animations for an absolute seek.  The timeline's
   * callback events are suppressed during reconstruction, so this explicit
   * keyed seam is what makes an export beginning in the middle of an HTML
   * animation match forward playback.
   */
  async reconcileAtTime(entries: ReadonlyArray<{
    key: string;
    file: string;
    duration: number;
    layer: LayerName;
    elapsed: number;
    startTime: number;
  }>): Promise<void> {
    if (!this.hostContainer) return;
    const activeEntries = entries.filter((entry) => (
      entry.elapsed >= 0 && entry.elapsed < Math.max(0, entry.duration)
    ));
    const desiredKeys = new Set(activeEntries.map((entry) => entry.key));
    for (const [id, anim] of [...this.activeAnims]) {
      if (!anim.runtimeKey || !desiredKeys.has(anim.runtimeKey)) {
        this.stopAnimation(id, 0);
      }
    }

    for (const entry of activeEntries) {
      let existing = [...this.activeAnims.values()].find((anim) => anim.runtimeKey === entry.key);
      if (existing && (
        existing.file !== entry.file
        || existing.duration !== entry.duration
        || existing.layer !== entry.layer
      )) {
        this.stopAnimation(existing.id, 0);
        existing = undefined;
      }
      if (existing) {
        existing.manualTime = true;
        this.clearAutoRemove(existing);
        existing.startTime = entry.startTime;
        existing.currentTime = entry.elapsed;
        try {
          await this.seekAnimation(existing, entry.elapsed);
          this.sendCommand(existing.id, { type: 'pause' });
        } catch (error) {
          this.stopAnimation(existing.id, 0, error);
          throw error;
        }
        continue;
      }
      await this.playAnimation(entry.file, entry.duration, entry.layer, {
        runtimeKey: entry.key,
        initialTime: entry.elapsed,
        startTime: entry.startTime,
        manualTime: true,
        paused: true,
      });
    }
  }

  /**
   * Stop and remove a custom animation.
   */
  stopAnimation(animId: string, fadeDuration: number = 0.3, reason?: unknown): void {
    const anim = this.activeAnims.get(animId);
    if (!anim) return;

    this.clearAnimationTimers(anim);
    anim.resizeObserver?.disconnect();
    anim.resizeObserver = undefined;
    if (!anim.readySettled) {
      anim.readySettled = true;
      anim.readyReject?.(reason ?? new Error(`[CustomAnimHost] Animation "${animId}" stopped before it became ready.`));
      anim.readyReject = undefined;
    }
    for (const [requestId, pending] of this.pendingSeekAcks) {
      if (pending.animId !== animId) continue;
      if (typeof window !== 'undefined') window.clearTimeout(pending.timeout);
      pending.reject(reason ?? new Error(`[CustomAnimHost] Animation "${animId}" stopped during seek.`));
      this.pendingSeekAcks.delete(requestId);
    }
    this.sendCommand(animId, { type: 'destroy' });
    this.activeAnims.delete(animId);

    gsap.to(anim.container, {
      opacity: 0,
      duration: fadeDuration,
      onComplete: () => {
        anim.container.remove();
      },
    });
  }

  /**
   * Handle incoming messages from animation iframes.
   */
  private handleMessage(event: MessageEvent): void {
    const data = event.data;
    if (!data || typeof data !== 'object' || !data.type) return;

    // Find which animation this message belongs to
    for (const [id, anim] of this.activeAnims) {
      if (anim.iframe.contentWindow === event.source) {
        switch (data.type) {
          case 'ready':
            if (anim.readyTimer !== undefined) window.clearTimeout(anim.readyTimer);
            anim.readyTimer = undefined;
            anim.ready = true;
            if (data.duration) anim.duration = data.duration;
            anim.onReady?.();
            break;

          case 'seekAck':
          case 'seeked':
          case 'rendered':
          case 'frameRendered':
          case 'renderedState':
          case 'seek:rendered':
            this.resolveSeekAck(anim, data);
            break;

          case 'complete':
            if (!anim.manualTime) this.stopAnimation(id);
            break;

          case 'error':
            console.error(`[CustomAnim] Error in "${id}":`, data.error);
            this.stopAnimation(id, 0, new Error(
              `[CustomAnimHost] Iframe "${id}" reported an error: ${String(data.error ?? 'unknown error')}`,
            ));
            break;
        }
        break;
      }
    }
  }

  /**
   * Stop all custom animations.
   */
  clear(): void {
    for (const id of [...this.activeAnims.keys()]) {
      this.stopAnimation(id, 0);
    }
  }

  /**
   * Destroy the host.
   */
  destroy(): void {
    this.clear();
    this.pendingSeekAcks.clear();
    if (typeof window !== 'undefined') window.removeEventListener('message', this.boundMessageHandler);
    this.captureProvider = null;
    this.hostContainer?.remove();
    this.hostContainer = null;
  }

  private requestAnimationCapture(
    anim: ActiveCustomAnim,
    width: number,
    height: number,
    sceneTime?: number,
  ): Promise<CustomAnimationCaptureFrame | null> {
    if (!anim.iframe.contentWindow) return Promise.resolve(null);

    const requestId = `custom-capture-${++this.captureCounter}`;
    const localSceneTime = anim.startTime === undefined
      ? sceneTime
      : Math.max(0, (sceneTime ?? anim.startTime) - anim.startTime);
    anim.currentTime = localSceneTime;
    return new Promise((resolve) => {
      let settled = false;
      let timeout: number | undefined;
      const finish = (frame: CustomAnimationCaptureFrame | null) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve(frame);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== anim.iframe.contentWindow) return;
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.requestId !== requestId || !['captureFrame', 'frame', 'captureResult'].includes(data.type)) return;
        void this.normalizeCaptureFrame(data, width, height).then(finish).catch(() => finish(null));
      };

      window.addEventListener('message', onMessage);
      void (async () => {
        try {
          if (localSceneTime !== undefined) await this.seekAnimation(anim, localSceneTime);
          timeout = window.setTimeout(() => finish(null), 100);
          this.sendCommand(anim.id, {
            type: 'capture',
            requestId,
            width,
            height,
            sceneTime: localSceneTime,
          });
        } catch {
          finish(null);
        }
      })();
    });
  }

  private seekAnimation(anim: ActiveCustomAnim, localTime: number): Promise<void> {
    if (!anim.iframe.contentWindow) {
      return Promise.reject(new Error(
        `[CustomAnimHost] Iframe "${anim.runtimeKey ?? anim.id}" has no contentWindow for seek/render acknowledgement.`,
      ));
    }

    const requestId = `custom-seek-${++this.seekCounter}`;
    anim.currentTime = localTime;
    if (anim.manualTime) this.sendCommand(anim.id, { type: 'pause' });
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingSeekAcks.delete(requestId);
        reject(new Error(
          `[CustomAnimHost] Iframe "${anim.runtimeKey ?? anim.id}" did not acknowledge rendered time ${localTime.toFixed(3)}s. `
          + 'Handle seek with a rendered/seeked postMessage response carrying the requestId before exporting.',
        ));
      }, SEEK_ACK_TIMEOUT_MS);
      this.pendingSeekAcks.set(requestId, { animId: anim.id, time: localTime, resolve, reject, timeout });
      this.sendCommand(anim.id, { type: 'seek', time: localTime, requestId });
    });
  }

  private resolveSeekAck(anim: ActiveCustomAnim, data: any): void {
    const responseRequestId = typeof data.requestId === 'string' ? data.requestId : undefined;
    const responseTime = typeof data.time === 'number'
      ? data.time
      : typeof data.sceneTime === 'number' ? data.sceneTime : undefined;
    for (const [requestId, pending] of this.pendingSeekAcks) {
      if (pending.animId !== anim.id) continue;
      if (responseRequestId && responseRequestId !== requestId) continue;
      if (responseTime !== undefined && Math.abs(responseTime - pending.time) > 0.001) continue;
      if (typeof window !== 'undefined') window.clearTimeout(pending.timeout);
      this.pendingSeekAcks.delete(requestId);
      pending.resolve();
      return;
    }
  }

  private removeAnimationsOutsideInterval(sceneTime: number): void {
    for (const anim of [...this.activeAnims.values()]) {
      if (anim.startTime === undefined) continue;
      const localTime = sceneTime - anim.startTime;
      if (localTime < 0 || localTime >= Math.max(0, anim.duration)) this.stopAnimation(anim.id, 0);
    }
  }

  private armAutoRemove(anim: ActiveCustomAnim): void {
    this.clearAutoRemove(anim);
    if (anim.manualTime || typeof window === 'undefined') return;
    const remaining = Math.max(0, anim.duration - (anim.currentTime ?? 0));
    anim.autoRemoveTimer = window.setTimeout(() => {
      if (this.activeAnims.get(anim.id) === anim && !anim.manualTime) this.stopAnimation(anim.id);
    }, remaining * 1000 + 500);
  }

  private clearAutoRemove(anim: ActiveCustomAnim): void {
    if (anim.autoRemoveTimer !== undefined && typeof window !== 'undefined') {
      window.clearTimeout(anim.autoRemoveTimer);
    }
    anim.autoRemoveTimer = undefined;
  }

  private clearAnimationTimers(anim: ActiveCustomAnim): void {
    if (anim.readyTimer !== undefined && typeof window !== 'undefined') window.clearTimeout(anim.readyTimer);
    anim.readyTimer = undefined;
    this.clearAutoRemove(anim);
  }

  private async normalizeCaptureFrame(
    data: any,
    width: number,
    height: number,
  ): Promise<CustomAnimationCaptureFrame | null> {
    const frameWidth = typeof data.width === 'number' ? data.width : width;
    const frameHeight = typeof data.height === 'number' ? data.height : height;
    if (frameWidth <= 0 || frameHeight <= 0) return null;
    const rawPixels = data.pixels ?? data.imageData?.data;
    if (rawPixels) {
      const pixels = rawPixels instanceof Uint8Array || rawPixels instanceof Uint8ClampedArray
        ? rawPixels
        : new Uint8ClampedArray(rawPixels);
      if (pixels.length !== frameWidth * frameHeight * 4) return null;
      return { width: frameWidth, height: frameHeight, pixels };
    }

    if (typeof data.dataUrl !== 'string' || typeof document === 'undefined' || typeof Image === 'undefined') {
      return null;
    }

    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = frameWidth;
        canvas.height = frameHeight;
        const context = canvas.getContext('2d');
        if (!context) {
          resolve(null);
          return;
        }
        context.clearRect(0, 0, frameWidth, frameHeight);
        context.drawImage(image, 0, 0, frameWidth, frameHeight);
        resolve({ width: frameWidth, height: frameHeight, canvas });
      };
      image.onerror = () => resolve(null);
      image.src = data.dataUrl;
    });
  }

  private validateCaptureFrame(frame: CustomAnimationCaptureFrame, width: number, height: number): void {
    if (frame.width <= 0 || frame.height <= 0) {
      throw new Error('Custom HTML capture returned invalid dimensions.');
    }
    if (frame.pixels && frame.pixels.length !== frame.width * frame.height * 4) {
      throw new Error('Custom HTML capture returned an incomplete RGBA frame.');
    }
    if (!frame.pixels && !frame.canvas) {
      throw new Error(
        `Custom HTML animation capture returned no pixels for ${width}×${height}. `
        + 'Return RGBA pixels/canvas from the capture provider or iframe response.',
      );
    }
  }

  private composeCaptureFrames(
    frames: CustomAnimationCaptureFrame[],
    width: number,
    height: number,
  ): CustomAnimationCaptureFrame {
    frames.forEach((frame) => this.validateCaptureFrame(frame, width, height));
    const pixelFrames = frames.filter((frame) => frame.pixels);
    if (pixelFrames.length === frames.length && frames.every((frame) => frame.width === width && frame.height === height)) {
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (const frame of pixelFrames) {
        const source = frame.pixels!;
        const count = Math.min(pixels.length, source.length);
        for (let index = 0; index < count; index += 4) {
          const sourceAlpha = source[index + 3] / 255;
          const destinationAlpha = pixels[index + 3] / 255;
          const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
          if (outputAlpha <= 0) continue;
          pixels[index] = Math.round((source[index] * sourceAlpha + pixels[index] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
          pixels[index + 1] = Math.round((source[index + 1] * sourceAlpha + pixels[index + 1] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
          pixels[index + 2] = Math.round((source[index + 2] * sourceAlpha + pixels[index + 2] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
          pixels[index + 3] = Math.round(outputAlpha * 255);
        }
      }
      return { width, height, pixels };
    }

    if (typeof document === 'undefined') {
      throw new Error(
        'Custom HTML capture returned mixed-size or canvas frames, but no canvas compositor is available.',
      );
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Custom HTML capture could not create a 2D compositor canvas.');
    }

    for (const frame of frames) {
      if (frame.pixels) {
        const overlay = document.createElement('canvas');
        overlay.width = frame.width;
        overlay.height = frame.height;
        const overlayContext = overlay.getContext('2d');
        if (!overlayContext) {
          throw new Error('Custom HTML capture could not create an RGBA overlay canvas.');
        }
        const imageData = overlayContext.createImageData(frame.width, frame.height);
        imageData.data.set(frame.pixels);
        overlayContext.putImageData(imageData, 0, 0);
        context.drawImage(overlay, 0, 0, width, height);
      } else if (frame.canvas) {
        context.drawImage(frame.canvas as CanvasImageSource, 0, 0, width, height);
      }
    }
    return { width, height, canvas };
  }
}

export const customAnimHost = new CustomAnimHost();
export default CustomAnimHost;

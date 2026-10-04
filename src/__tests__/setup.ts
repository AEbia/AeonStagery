import { vi } from 'vitest';

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// jsdom returns null for canvas contexts but logs a warning on every call.
// Keep that unsupported-environment behavior without polluting test output.
if (typeof HTMLCanvasElement !== 'undefined') {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
}

// jsdom lacks DragEvent support; provide a minimal polyfill so Testing Library drag/drop events retain clientY and dataTransfer.
if (typeof window !== 'undefined' && typeof (window as any).DragEvent === 'undefined') {
  class DragEventPolyfill extends MouseEvent {
    dataTransfer: any;
    constructor(type: string, eventInitDict: any = {}) {
      super(type, eventInitDict);
      this.dataTransfer = eventInitDict.dataTransfer ?? null;
    }
  }
  Object.defineProperty(window, 'DragEvent', {
    writable: true,
    configurable: true,
    value: DragEventPolyfill,
  });
  (globalThis as any).DragEvent = DragEventPolyfill;
}

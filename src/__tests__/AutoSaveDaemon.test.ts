/**
 * AutoSaveDaemon tests.
 *
 * The daemon listens for DocumentStore version changes and triggers a
 * debounced forceSave() through the adapter. Save-status UI state lives
 * elsewhere now.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoSaveDaemon } from '../engine/daemons/AutoSaveDaemon';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';

interface MockDocumentStore {
  readonly filePath: string | null;
  readonly version: number;
  _listeners: Set<() => void>;
  getCurrentSceneDocumentSnapshot(): CurrentSceneDocument | null;
  _notifyChange(): void;
  _mutate(document?: CurrentSceneDocument | null, filePath?: string | null): void;
}

interface MockDocumentAdapter {
  forceSave: ReturnType<typeof vi.fn>;
}

function makeDocument(overrides: Partial<CurrentSceneDocument> = {}): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'test-scene',
    meta: { title: 'Test Scene' },
    statements: [],
    ...overrides,
  };
}

function createMockStore(): MockDocumentStore {
  const listeners = new Set<() => void>();
  const state = {
    _document: null as CurrentSceneDocument | null,
    _filePath: null as string | null,
    _version: 0,
  };

  return {
    get filePath() { return state._filePath; },
    get version() { return state._version; },
    _listeners: listeners,
    getCurrentSceneDocumentSnapshot: () => state._document,

    _notifyChange() {
      listeners.forEach((fn) => fn());
    },

    _mutate(document?: CurrentSceneDocument | null, filePath?: string | null) {
      if (document !== undefined) state._document = document;
      if (filePath !== undefined) state._filePath = filePath;
      state._version++;
      this._notifyChange();
    },
  };
}

function createMockAdapter(): MockDocumentAdapter {
  return {
    forceSave: vi.fn().mockResolvedValue(undefined),
  };
}

describe('AutoSaveDaemon', () => {
  let daemon: AutoSaveDaemon;
  let store: MockDocumentStore;
  let adapter: MockDocumentAdapter;

  beforeEach(() => {
    daemon = new AutoSaveDaemon();
    store = createMockStore();
    adapter = createMockAdapter();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('construction', () => {
    it('can be instantiated', () => {
      expect(daemon).toBeDefined();
      expect(daemon).toBeInstanceOf(AutoSaveDaemon);
    });
  });

  describe('attach()', () => {
    it('returns a dispose function', () => {
      const dispose = daemon.attach(store as any, adapter as any);
      expect(typeof dispose).toBe('function');
    });

    it('registers a listener on the store', () => {
      daemon.attach(store as any, adapter as any);
      expect(store._listeners.size).toBe(1);
    });

    it('calling attach() a second time before disposing replaces the listener', () => {
      daemon.attach(store as any, adapter as any);
      daemon.attach(store as any, adapter as any);
      expect(store._listeners.size).toBe(1);
    });
  });

  describe('version change triggers save', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      store._mutate(makeDocument(), '/test/scene.json');
    });

    it('calls adapter.forceSave after debounce when version increments', () => {
      daemon.attach(store as any, adapter as any);

      store._mutate();
      expect(adapter.forceSave).not.toHaveBeenCalled();

      vi.advanceTimersByTime(200);

      expect(adapter.forceSave).toHaveBeenCalledTimes(1);
    });
  });

  describe('debounce', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      store._mutate(makeDocument(), '/test/scene.json');
    });

    it('multiple rapid version changes trigger only one forceSave', () => {
      daemon.attach(store as any, adapter as any);

      store._mutate();
      store._mutate();
      store._mutate();

      expect(adapter.forceSave).not.toHaveBeenCalled();

      vi.advanceTimersByTime(200);

      expect(adapter.forceSave).toHaveBeenCalledTimes(1);
    });

    it('resets the debounce timer on each new change', () => {
      daemon.attach(store as any, adapter as any);

      store._mutate();
      vi.advanceTimersByTime(80);

      store._mutate();
      vi.advanceTimersByTime(80);

      expect(adapter.forceSave).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);

      expect(adapter.forceSave).toHaveBeenCalledTimes(1);
    });
  });

  describe('guards', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    it('does not attempt to save when filePath is null', () => {
      store._mutate(makeDocument(), null);
      daemon.attach(store as any, adapter as any);

      store._mutate();
      vi.advanceTimersByTime(200);

      expect(adapter.forceSave).not.toHaveBeenCalled();
    });

    it('does not attempt to save when semantic document is null', () => {
      store._mutate(null, '/test/scene.json');
      daemon.attach(store as any, adapter as any);

      store._mutate(null);
      vi.advanceTimersByTime(200);

      expect(adapter.forceSave).not.toHaveBeenCalled();
    });

    it('auto-saves the local collaboration workspace main scene', () => {
      store._mutate(makeDocument(), 'D:/project/project/main.scene.json');
      daemon.attach(store as any, adapter as any);

      store._mutate();
      vi.advanceTimersByTime(200);

      expect(adapter.forceSave).toHaveBeenCalledTimes(1);
    });

    it('does not trigger save if version has not changed since last save', () => {
      daemon.attach(store as any, adapter as any);

      store._mutate(makeDocument(), '/test/scene.json');
      vi.advanceTimersByTime(200);
      expect(adapter.forceSave).toHaveBeenCalledTimes(1);

      store._notifyChange();
      vi.advanceTimersByTime(200);

      expect(adapter.forceSave).toHaveBeenCalledTimes(1);
    });

    it('ignores notifications that do not change the version', () => {
      daemon.attach(store as any, adapter as any);

      store._notifyChange();
      vi.advanceTimersByTime(200);

      expect(adapter.forceSave).not.toHaveBeenCalled();
    });
  });

  describe('dispose()', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      store._mutate(makeDocument(), '/test/scene.json');
    });

    it('stops watching after dispose', () => {
      const dispose = daemon.attach(store as any, adapter as any);
      dispose();

      store._mutate();
      vi.advanceTimersByTime(200);

      expect(adapter.forceSave).not.toHaveBeenCalled();
    });

    it('removes the store listener', () => {
      const dispose = daemon.attach(store as any, adapter as any);
      dispose();

      expect(store._listeners.size).toBe(0);
    });

    it('dispose() called twice is idempotent', () => {
      const dispose = daemon.attach(store as any, adapter as any);

      dispose();
      expect(() => dispose()).not.toThrow();

      expect(store._listeners.size).toBe(0);
    });

    it('cancels pending debounced save when disposed mid-debounce', () => {
      const dispose = daemon.attach(store as any, adapter as any);

      store._mutate();
      vi.advanceTimersByTime(30);
      dispose();

      vi.advanceTimersByTime(300);

      expect(adapter.forceSave).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      store._mutate(makeDocument(), '/test/scene.json');
    });

    it('swallows forceSave rejections after logging them', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      adapter.forceSave.mockRejectedValueOnce(new Error('Disk full'));

      daemon.attach(store as any, adapter as any);

      store._mutate();
      vi.advanceTimersByTime(200);

      await vi.runAllTimersAsync();

      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('reattach after dispose', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      store._mutate(makeDocument(), '/test/scene.json');
    });

    it('can be reattached after dispose', () => {
      const dispose1 = daemon.attach(store as any, adapter as any);
      dispose1();

      const dispose2 = daemon.attach(store as any, adapter as any);
      expect(typeof dispose2).toBe('function');

      store._mutate();
      vi.advanceTimersByTime(200);

      expect(adapter.forceSave).toHaveBeenCalledTimes(1);
    });

    it('dispose then attach creates a fresh listener', () => {
      const dispose1 = daemon.attach(store as any, adapter as any);
      dispose1();

      expect(store._listeners.size).toBe(0);

      const dispose2 = daemon.attach(store as any, adapter as any);
      expect(store._listeners.size).toBe(1);

      dispose2();
      expect(store._listeners.size).toBe(0);
    });
  });
});

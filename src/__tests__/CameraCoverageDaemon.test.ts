import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidationDaemon } from '../engine/daemons/ValidationDaemon';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';
import type { ProjectResourceService } from '../services/io/ProjectResourceService';
import { DocumentStore } from '../ui/store/DocumentStore';
import { ValidationStore } from '../ui/store/ValidationStore';
import * as coverageDiagnostics from '../services/semantic-scene/CameraCoverageDiagnostics';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function editingDocument(): CurrentSceneDocument {
  return { schemaVersion: 5, sceneId: 'editing', meta: { title: 'Editing' }, statements: [
    { id: 'bg', time: 0, type: 'environmentLayer', params: {
      mode: 'set', layerId: 'background', file: 'room.png', transition: 'none', durationSeconds: 0,
    } },
    { id: 'camera', time: 1, type: 'camera', params: { mode: 'move', to: [0.75, 0.5], durationSeconds: 0 } },
    { id: 'dialogue', time: 2, type: 'dialogue', params: { text: 'Original', durationSeconds: 1 } },
  ] };
}

function editingFixture(document: CurrentSceneDocument, automaticImages = true) {
  vi.useFakeTimers();
  const loads: string[] = [];
  const pending = new Set<() => void>();
  let maxConcurrent = 0;
  let imageWidth = 1920;
  vi.stubGlobal('Image', class {
    get naturalWidth() { return imageWidth; }
    naturalHeight = 1080;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    finish = () => { pending.delete(this.finish); this.onload?.(); };
    set src(value: string) {
      if (!value) { pending.delete(this.finish); return; }
      loads.push(value);
      pending.add(this.finish);
      maxConcurrent = Math.max(maxConcurrent, pending.size);
      if (automaticImages) void Promise.resolve().then(this.finish);
    }
  });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(),
    aeonStageryAPI: { fs: { exists: async () => true } },
  });
  const resources = { getCurrentProject: () => null } as unknown as ProjectResourceService;
  const documents = new DocumentStore();
  const validation = new ValidationStore();
  documents._replaceCurrentSceneDocumentSnapshot(document);
  const daemon = new ValidationDaemon(documents, validation, resources, () => '/project');
  return { daemon, documents, validation, loads, pending, maxConcurrent: () => maxConcurrent,
    setImageWidth: (width: number) => { imageWidth = width; },
    exposed: () => validation.issues.some(issue => issue.code === 'semantic.camera.black-edge') };
}

describe('camera coverage asset integration', () => {
  it('coalesces rapid visual edits and reuses completed coverage while typing dialogue', async () => {
    const scan = vi.spyOn(coverageDiagnostics, 'collectCameraCoverageIssuesAsync');
    let document = editingDocument();
    const fixture = editingFixture(document);
    try {
      fixture.daemon.start();
      for (let i = 0; i < 25; i++) {
        await vi.advanceTimersByTimeAsync(20);
        document = { ...document, statements: document.statements.map(statement => statement.type === 'camera'
          ? { ...statement, params: { mode: 'move', to: [0.7 + i / 1000, 0.5], durationSeconds: 0 } } : statement) };
        fixture.documents._replaceCurrentSceneDocumentSnapshot(document);
      }
      expect(fixture.loads).toHaveLength(0);
      expect(scan).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400);
      expect(fixture.exposed()).toBe(true);
      expect(scan).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 20; i++) {
        document = { ...document, statements: document.statements.map(statement => statement.type === 'dialogue'
          ? { ...statement, params: { ...statement.params, text: `Edited ${i}` } } : statement) };
        fixture.documents._replaceCurrentSceneDocumentSnapshot(document);
        expect(fixture.exposed()).toBe(true);
      }
      await vi.advanceTimersByTimeAsync(400);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(fixture.loads).toHaveLength(1);
      fixture.documents._replaceCurrentSceneDocumentSnapshot({ ...document,
        statements: document.statements.map(statement => statement.type === 'environmentLayer'
          ? { ...statement, params: { ...statement.params, scale: 2 } } : statement),
      });
      expect(fixture.exposed()).toBe(false);
      await vi.advanceTimersByTimeAsync(400);
      expect(scan).toHaveBeenCalledTimes(2);
      expect(fixture.exposed()).toBe(false);
      expect(fixture.loads).toHaveLength(1);
    } finally { fixture.daemon.dispose(); }
  });

  it('keeps an in-flight coverage request across unrelated edits', async () => {
    const scan = vi.spyOn(coverageDiagnostics, 'collectCameraCoverageIssuesAsync');
    const document = editingDocument();
    const fixture = editingFixture(document, false);
    try {
      fixture.daemon.start();
      await vi.advanceTimersByTimeAsync(400);
      fixture.documents._replaceCurrentSceneDocumentSnapshot({ ...document,
        statements: document.statements.map(statement => statement.type === 'dialogue'
          ? { ...statement, params: { ...statement.params, text: 'Typed before image loaded' } } : statement),
      });
      for (const finish of [...fixture.pending]) finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.exposed()).toBe(true);
      await vi.advanceTimersByTimeAsync(400);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(fixture.loads).toHaveLength(1);
    } finally { fixture.daemon.dispose(); }
  });

  it('does not load environment dimensions without a sampled camera', async () => {
    const document = editingDocument();
    const fixture = editingFixture({ ...document, statements: document.statements.filter(statement => statement.type !== 'camera') });
    try {
      fixture.daemon.start();
      await vi.advanceTimersByTimeAsync(400);
      expect(fixture.loads).toHaveLength(0);
      expect(fixture.validation.loading).toBe(false);
    } finally { fixture.daemon.dispose(); }
  });

  it.each([false, true])('clears coverage and rejects late image results when closing a scene (completed: %s)', async completed => {
    const fixture = editingFixture(editingDocument(), false);
    try {
      fixture.daemon.start();
      await vi.advanceTimersByTimeAsync(400);
      if (completed) {
        for (const finish of [...fixture.pending]) finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.exposed()).toBe(true);
      }
      fixture.documents._clearCurrentSceneDocumentSnapshot();
      for (const finish of [...fixture.pending]) finish();
      await vi.advanceTimersByTimeAsync(400);
      expect(fixture.exposed()).toBe(false);
      expect(fixture.validation.loading).toBe(false);
    } finally { fixture.daemon.dispose(); }
  });

  it('retries unavailable image dimensions after an unrelated edit instead of caching an inconclusive scan', async () => {
    const document = editingDocument();
    const fixture = editingFixture(document);
    fixture.setImageWidth(0);
    try {
      fixture.daemon.start();
      await vi.advanceTimersByTimeAsync(400);
      expect(fixture.exposed()).toBe(false);
      fixture.setImageWidth(1920);
      fixture.documents._replaceCurrentSceneDocumentSnapshot({ ...document, meta: { ...document.meta, title: 'Edited title' } });
      await vi.advanceTimersByTimeAsync(400);
      expect(fixture.exposed()).toBe(true);
      expect(fixture.loads).toHaveLength(2);
    } finally { fixture.daemon.dispose(); }
  });

  it('bounds image loads across obsolete requests and skips their queued images', async () => {
    const document = editingDocument();
    const withImages = (prefix: string): CurrentSceneDocument => ({ ...document,
      statements: [...Array.from({ length: 12 }, (_, i) => ({
        id: `bg-${i}`, time: i, type: 'environmentLayer' as const,
        params: { mode: 'set' as const, layerId: 'background', file: `${prefix}-${i}.png` },
      })), document.statements[1]],
    });
    const fixture = editingFixture(withImages('old'), false);
    try {
      fixture.daemon.start();
      await vi.advanceTimersByTimeAsync(400);
      expect(fixture.pending.size).toBe(4);
      fixture.documents._replaceCurrentSceneDocumentSnapshot(withImages('new'));
      await vi.advanceTimersByTimeAsync(400);
      expect(fixture.pending.size).toBe(4);
      for (let batch = 0; batch < 5 && fixture.pending.size; batch++) {
        for (const finish of [...fixture.pending]) finish();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(fixture.maxConcurrent()).toBe(4);
      expect(fixture.loads.filter(path => path.includes('/old-'))).toHaveLength(4);
      expect(fixture.loads.filter(path => path.includes('/new-'))).toHaveLength(12);
      expect(fixture.validation.loading).toBe(false);
      expect(fixture.exposed()).toBe(true);
    } finally { fixture.daemon.dispose(); }
  });

  it('resamples a looping path when a non-visual edit extends the scene end', async () => {
    const document = editingDocument();
    const fixture = editingFixture({ ...document, statements: [
      { id: 'bg', time: 0, type: 'environmentLayer', params: {
        mode: 'set', layerId: 'background', file: 'room.png', scale: 1.5, transition: 'none', durationSeconds: 0,
      } },
      { id: 'path', time: 0, type: 'camera', params: { mode: 'path', loop: true, durationSeconds: 1 / 59,
        keyframes: [{ time: 0, rotation: 0 }, { time: 1 / 59, rotation: 180, ease: 'linear' }],
      } },
      { id: 'line', time: 0, type: 'dialogue', params: { text: 'Short', durationSeconds: 1 / 59 } },
    ] });
    try {
      fixture.daemon.start();
      await vi.advanceTimersByTimeAsync(400);
      expect(fixture.exposed()).toBe(false);
      const current = fixture.documents.getCurrentSceneDocumentSnapshot()!;
      fixture.documents._replaceCurrentSceneDocumentSnapshot({ ...current,
        statements: current.statements.map(statement => statement.type === 'dialogue'
          ? { ...statement, params: { ...statement.params, durationSeconds: 10 } } : statement),
      });
      await vi.advanceTimersByTimeAsync(400);
      expect(fixture.exposed()).toBe(true);
    } finally { fixture.daemon.dispose(); }
  });

  it.each([false, true])('revalidates a format change with an image request pending: %s', async pending => {
    vi.useFakeTimers();
    let imageReady: (() => void) | undefined;
    vi.stubGlobal('Image', class {
      naturalWidth = 1920;
      naturalHeight = 1080;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        imageReady = () => this.onload?.();
        if (!pending) void Promise.resolve().then(imageReady);
      }
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      aeonStageryAPI: { fs: { exists: async () => true } },
    });
    let project = { metadata: { videoFormat: { width: 1920, height: 1080, fps: 60 } } };
    const listeners = new Set<() => void>();
    const projectChanges = { subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    } };
    const resources = {
      getCurrentProject: () => project,
      resolveForRead: async (path: string) => `/project/${path}`,
    } as unknown as ProjectResourceService;
    const documentStore = new DocumentStore();
    const store = new ValidationStore();
    documentStore._replaceCurrentSceneDocumentSnapshot({
      schemaVersion: 5, sceneId: 'format-change', meta: { title: 'Format change' },
      statements: [
        { id: 'bg', time: 0, type: 'environmentLayer', params: {
          mode: 'set', layerId: 'background', file: 'room.png',
        } },
        { id: 'camera', time: 1, type: 'camera', params: {
          mode: 'move', to: [0.75, 0.5], durationSeconds: 0,
        } },
      ],
    });
    const version = documentStore.version;
    const daemon = new ValidationDaemon(documentStore, store, resources, () => '/project', undefined, projectChanges);
    try {
      daemon.start();
      await vi.advanceTimersByTimeAsync(400);
      expect(store.issues.some(issue => issue.code === 'semantic.camera.black-edge')).toBe(!pending);
      const oldImageReady = imageReady;
      project = { metadata: { videoFormat: { width: 1080, height: 1920, fps: 30 } } };
      listeners.forEach(listener => listener());
      oldImageReady?.();
      await vi.advanceTimersByTimeAsync(0);
      imageReady?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(documentStore.version).toBe(version);
      expect(store.loading).toBe(false);
      expect(store.issues.some(issue => issue.code === 'semantic.camera.black-edge')).toBe(false);
    } finally {
      daemon.dispose();
    }
    expect(listeners.size).toBe(0);
  });

  it('discards a pending image result after the document changes', async () => {
    vi.useFakeTimers();
    let imageReady: (() => void) | undefined;
    vi.stubGlobal('Image', class {
      naturalWidth = 1920;
      naturalHeight = 1080;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { imageReady = () => this.onload?.(); }
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      aeonStageryAPI: { fs: { exists: async () => true } },
    });
    const resources = {
      getCurrentProject: () => null,
      resolveForRead: async (path: string) => `/project/${path}`,
    } as unknown as ProjectResourceService;
    const documentStore = new DocumentStore();
    const store = new ValidationStore();
    const document: CurrentSceneDocument = {
      schemaVersion: 5, sceneId: 'pending-coverage', meta: { title: 'Pending coverage' },
      statements: [
        { id: 'bg', time: 0, type: 'environmentLayer', params: {
          mode: 'set', layerId: 'background', file: 'background/room.png',
        } },
        { id: 'camera', time: 1, type: 'camera', params: {
          mode: 'move', to: [0.9, 0.5], durationSeconds: 0,
        } },
      ],
    };
    documentStore._replaceCurrentSceneDocumentSnapshot(document);
    const daemon = new ValidationDaemon(documentStore, store, resources, () => '/project');
    try {
      daemon.start();
      await vi.advanceTimersByTimeAsync(400);
      expect(imageReady).toBeDefined();
      documentStore._replaceCurrentSceneDocumentSnapshot({ ...document, statements: [document.statements[0]] });
      imageReady?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.issues.some(issue => issue.code === 'semantic.camera.black-edge')).toBe(false);
      await vi.advanceTimersByTimeAsync(400);
      expect(store.loading).toBe(false);
      expect(store.issues.some(issue => issue.code === 'semantic.camera.black-edge')).toBe(false);
    } finally {
      daemon.dispose();
    }
  });

  it.each([
    { name: 'stage aspect artwork exposes an edge', width: 1920, height: 1080, portrait: false, exposed: true },
    { name: 'wide artwork covers the pan', width: 3840, height: 1080, portrait: false, exposed: false },
    { name: 'portrait project uses its own aspect', width: 1080, height: 1920, portrait: true, exposed: true },
  ])('$name', async ({ width, height, portrait, exposed }) => {
    vi.useFakeTimers();
    const loads: string[] = [];
    vi.stubGlobal('Image', class {
      naturalWidth = width;
      naturalHeight = height;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        loads.push(value);
        void Promise.resolve().then(() => this.onload?.());
      }
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      aeonStageryAPI: { fs: { exists: async () => true } },
    });
    const project = { metadata: { videoFormat: portrait
      ? { width: 1080, height: 1920, fps: 30 } : { width: 1920, height: 1080, fps: 60 } } };
    const resources = {
      getCurrentProject: () => project,
      resolveForRead: async (path: string) => `/project/${path}`,
    } as unknown as ProjectResourceService;
    const documentStore = new DocumentStore();
    const store = new ValidationStore();
    const document: CurrentSceneDocument = {
      schemaVersion: 5, sceneId: 'asset-coverage', meta: { title: 'Asset coverage' },
      statements: [
        { id: 'bg', time: 0, type: 'environmentLayer', params: {
          mode: 'set', layerId: 'background', file: 'background/room.png',
        } },
        { id: 'camera', time: 1, type: 'camera', params: {
          mode: 'move', to: [0.75, 0.5], durationSeconds: 0,
        } },
      ],
    };
    documentStore._replaceCurrentSceneDocumentSnapshot(document);
    const daemon = new ValidationDaemon(documentStore, store, resources, () => '/project');
    try {
      daemon.start();
      expect(store.issues.some(issue => issue.code === 'semantic.camera.black-edge')).toBe(false);
      await vi.advanceTimersByTimeAsync(400);
      expect(store.loading).toBe(false);
      expect(store.issues.some(issue => issue.code === 'semantic.camera.black-edge')).toBe(exposed);
      expect(loads).toEqual(['asset://localhost//project/background/room.png']);
    } finally {
      daemon.dispose();
    }
  });
});

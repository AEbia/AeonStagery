import { describe, it, expect, vi } from 'vitest';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import { DocumentStore } from '../ui/store/DocumentStore';
import type { SemanticDocumentProjectionRuntimePort } from '../services/document/DocumentProjectionPorts';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';

function makeDocument(tag: string, time = 0): CurrentSceneDocument {
  return {
    schemaVersion: 5,
    sceneId: 'coalesce-scene',
    meta: { title: `Doc ${tag}`, resolution: [1920, 1080], fps: 60 },
    statements: [
      {
        id: `stmt-${tag}`,
        type: 'dialogue',
        time,
        params: {
          speaker: 'alice',
          text: `text-${tag}`,
          durationSeconds: 3,
        },
      },
    ],
  };
}

function makeCoordinator() {
  const store = new DocumentStore();
  const runtime: SemanticDocumentProjectionRuntimePort = {
    projectPreparedScene: vi.fn(async () => undefined),
  };
  const pipeline = new SemanticScenePipeline({
    resolveAsset: async (source) => `asset://localhost/C:/project/${source}`,
  });
  const coordinator = new SemanticDocumentCoordinator(store, pipeline, runtime);
  return { store, runtime, coordinator };
}

describe('SemanticDocumentCoordinator coalescing', () => {
  it('projects only the leading and final documents of a burst batch', async () => {
    const { store, runtime, coordinator } = makeCoordinator();

    const first = coordinator.applyDocument(makeDocument('first'));
    const second = coordinator.applyDocument(makeDocument('second'));
    const third = coordinator.applyDocument(makeDocument('third'));

    const [bundleFirst, bundleSecond, bundleThird] = await Promise.all([first, second, third]);

    // The leading commit settles with its own bundle; the coalesced batch
    // members settle with the final (latest-wins) document's bundle.
    expect(bundleFirst.prepared.sceneId).toBe('coalesce-scene');
    expect(bundleFirst).not.toBe(bundleSecond);
    expect(bundleSecond).toBe(bundleThird);
    // Exactly two projections: the leading commit and the coalesced drain.
    expect(runtime.projectPreparedScene).toHaveBeenCalledTimes(2);
    expect(runtime.projectPreparedScene).toHaveBeenNthCalledWith(1, bundleFirst.prepared);
    expect(runtime.projectPreparedScene).toHaveBeenNthCalledWith(2, bundleThird.prepared);
    // The store ends at the final document and reflects one coalesced commit.
    expect((store.getCurrentSceneDocumentSnapshot()?.statements[0].params as { text?: string }).text).toBe('text-third');
  });

  it('still projects every document when commits are awaited sequentially', async () => {
    const { runtime, coordinator } = makeCoordinator();

    await coordinator.applyDocument(makeDocument('one'));
    await coordinator.applyDocument(makeDocument('two'));
    await coordinator.applyDocument(makeDocument('three'));

    expect(runtime.projectPreparedScene).toHaveBeenCalledTimes(3);
  });

  it('rejects the whole batch and rolls back the runtime when the batch drain projection fails', async () => {
    const { store, runtime, coordinator } = makeCoordinator();
    await coordinator.applyDocument(makeDocument('baseline'));
    const runtimeFn = runtime.projectPreparedScene as unknown as ReturnType<typeof vi.fn>;
    runtimeFn.mockImplementation(async (scene: { sceneId: string }) => {
      if (scene.sceneId === 'coalesce-scene-bad') throw new Error('projection failed');
    });
    const callsAfterBaseline = runtimeFn.mock.calls.length;

    // Leading document succeeds; the in-flight batch member fails to project.
    const leading = coordinator.applyDocument(makeDocument('ok'));
    const failing = coordinator.applyDocument({ ...makeDocument('bad'), sceneId: 'coalesce-scene-bad' });

    await expect(leading).resolves.toBeDefined();
    await expect(failing).rejects.toThrow('projection failed');

    // The failed drain re-projects the previous prepared scene for the runtime.
    const calls = runtimeFn.mock.calls;
    expect(calls.length).toBe(callsAfterBaseline + 3);
    expect(calls[calls.length - 1][0]).toBe(store.getPreparedSceneSnapshot());
    // The store keeps the last successfully committed document.
    expect((store.getCurrentSceneDocumentSnapshot()?.statements[0].params as { text?: string }).text).toBe('text-ok');
  });

  it('never absorbs a non-coalescable apply into an open local batch', async () => {
    const { store, runtime, coordinator } = makeCoordinator();
    const scenes = {
      local1: { ...makeDocument('local1'), sceneId: 'coalesce-local1' },
      remote: { ...makeDocument('remote'), sceneId: 'coalesce-remote' },
      local2: { ...makeDocument('local2'), sceneId: 'coalesce-local2' },
    };

    // A local burst is open (leading in flight) when the remote state apply
    // lands; a further local commit follows before the batch drains.
    const local1 = coordinator.applyDocument(scenes.local1);
    const remote = coordinator.applyDocument(scenes.remote, 'project/main.scene.json', { coalesce: false });
    const local2 = coordinator.applyDocument(scenes.local2);

    const [bundle1, bundleRemote, bundle2] = await Promise.all([local1, remote, local2]);

    // Both local commits coalesce (leading + latest-wins drain)…
    expect(bundle1.prepared.sceneId).toBe('coalesce-local1');
    expect(bundle2.prepared.sceneId).toBe('coalesce-local2');
    // …but the remote apply runs as its OWN leading batch: its document is
    // always prepared and projected, even under an open local burst.
    expect(bundleRemote.prepared.sceneId).toBe('coalesce-remote');
    const scenesProjected = (runtime.projectPreparedScene as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => (call[0] as { sceneId: string }).sceneId);
    expect(scenesProjected).toEqual(['coalesce-local1', 'coalesce-local2', 'coalesce-remote']);
    // The store ends at the remote document, not at a coalesced local.
    expect(store.getCurrentSceneDocumentSnapshot()?.sceneId).toBe('coalesce-remote');
  });

  it('projects queued non-coalescable applies in FIFO order behind a local burst', async () => {
    const { runtime, coordinator } = makeCoordinator();
    const scenes = {
      local: { ...makeDocument('local'), sceneId: 'coalesce-local' },
      remoteA: { ...makeDocument('remoteA'), sceneId: 'coalesce-remote-a' },
      remoteB: { ...makeDocument('remoteB'), sceneId: 'coalesce-remote-b' },
    };

    const local = coordinator.applyDocument(scenes.local);
    const remoteA = coordinator.applyDocument(scenes.remoteA, undefined, { coalesce: false });
    const remoteB = coordinator.applyDocument(scenes.remoteB, undefined, { coalesce: false });
    await Promise.all([local, remoteA, remoteB]);

    const scenesProjected = (runtime.projectPreparedScene as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => (call[0] as { sceneId: string }).sceneId);
    expect(scenesProjected).toEqual([
      'coalesce-local',
      'coalesce-remote-a',
      'coalesce-remote-b',
    ]);
  });

  it('projects an isolated non-coalescable apply immediately as a leading commit', async () => {
    const { runtime, coordinator } = makeCoordinator();
    const remote = { ...makeDocument('only'), sceneId: 'coalesce-remote-only' };

    const bundle = await coordinator.applyDocument(remote, 'project/main.scene.json', { coalesce: false });

    expect(bundle.prepared.sceneId).toBe('coalesce-remote-only');
    expect(runtime.projectPreparedScene).toHaveBeenCalledTimes(1);
  });
});
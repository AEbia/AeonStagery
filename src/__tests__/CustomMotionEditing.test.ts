import { describe, expect, it, vi } from 'vitest';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument, type CharacterPerformanceParams } from '../api/types/semantic-scene';
import { DocumentStore } from '../ui/store/DocumentStore';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { CustomMotionEditing } from '../services/timeline-authoring/CustomMotionEditing';
import { CustomMotionConversion } from '../services/timeline-authoring/CustomMotionConversion';
import { InMemoryCustomMotionEditAuthority, type CustomMotionEditAuthority, type HeldCustomMotionLease, type LeaseDecision } from '../services/timeline-authoring/CustomMotionEditAuthority';

function document(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'scene',
    meta: { title: 'Motion editing', fps: 30, characters: [{ id: 'alice', name: 'Alice', model: 'figure/alice.moc' }] },
    statements: [{ id: 'performance', type: 'characterPerformance', time: 0, params: {
      target: 'alice', expression: 'smile', motion: {
        kind: 'custom', durationSeconds: 2, fadeInSeconds: 0.1, derivedFrom: { key: 'wave' },
        tracks: [{ parameterId: 'ANGLE', keyframes: [{ time: 0, value: 0, segment: { type: 'linear' } }, { time: 1, value: 10 }] }],
      },
    } }],
  };
}

async function harness(authority: CustomMotionEditAuthority = new InMemoryCustomMotionEditAuthority(), source = document()) {
  const store = new DocumentStore();
  const coordinator = new SemanticDocumentCoordinator(store, new SemanticScenePipeline({ resolveAsset: async (source) => source }), {
    projectPreparedScene: vi.fn(async () => {}),
  });
  await coordinator.applyDocument(source);
  const authoring = new SemanticAuthoringApplicationService(store, coordinator);
  const preview = { apply: vi.fn(), clear: vi.fn(async () => {}) };
  const editing = new CustomMotionEditing({ store, authoring, authority, preview });
  return { store, coordinator, authoring, editing, preview };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function delayedAuthority() {
  const decisions: ReturnType<typeof deferred<LeaseDecision>>[] = [];
  const releases: HeldCustomMotionLease[] = [];
  const losses = new Map<HeldCustomMotionLease, (reason: string) => void>();
  const authority: CustomMotionEditAuthority = {
    acquire: vi.fn(async () => { const decision = deferred<LeaseDecision>(); decisions.push(decision); return decision.promise; }),
    release: vi.fn(async (lease) => { releases.push(lease); losses.delete(lease); }),
    onLoss: (lease, listener) => { losses.set(lease, listener); return () => { losses.delete(lease); }; },
    dispose: vi.fn(),
  };
  return { authority, decisions, releases, losses, grant: (index: number) => {
    const lease = Object.freeze({}) as HeldCustomMotionLease;
    decisions[index].resolve({ status: 'granted', lease });
    return lease;
  } };
}

async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

describe('CustomMotionEditing session interface', () => {
  it('keeps previews outside the document and commits one gesture as one undo record', async () => {
    const { store, authoring, editing, preview } = await harness();
    const initialVersion = store.version;
    const session = editing.open({ statementId: 'performance' });
    expect(editing.getSnapshot().state).toBe('pending');
    expect(await session.ready).toEqual({ status: 'held' });
    const keyframe = editing.getSnapshot().keyframes.find((point) => point.time === 1)!.ref;
    session.preview({ type: 'update-keyframe', keyframe, value: 12 });
    session.preview({ type: 'update-keyframe', keyframe, value: 15 });
    expect(store.version).toBe(initialVersion);
    expect(authoring.canUndo).toBe(false);
    expect(preview.apply).toHaveBeenCalled();
    expect(await session.commit()).toEqual({ status: 'committed' });
    expect(editing.getSnapshot().motion!.tracks[0].keyframes[1].value).toBe(15);
    expect(store.version).toBe(initialVersion + 1);
    expect(editing.getSnapshot().state).toBe('held');
    await session.close();
    expect(await authoring.undo()).toBe(true);
    expect((store.getCurrentSceneDocumentSnapshot()!.statements[0].params as CharacterPerformanceParams).motion).toMatchObject({ tracks: [{ keyframes: [{ value: 0 }, { value: 10 }] }] });
    expect(await authoring.undo()).toBe(false);
    await editing.dispose();
  });

  it('holds at most one pending commit and discards it when authority is denied', async () => {
    const gate = delayedAuthority();
    const { editing, store, authoring, preview } = await harness(gate.authority);
    const version = store.version;
    const session = editing.open({ statementId: 'performance' });
    await settle();
    const keyframe = editing.getSnapshot().keyframes[1].ref;
    expect(session.preview({ type: 'update-keyframe', keyframe, value: 12 }).status).toBe('previewed');
    const commit = session.commit();
    expect(session.commit()).toBe(commit);
    expect(store.version).toBe(version);
    gate.decisions[0].resolve({ status: 'denied', reason: 'timeout' });
    expect(await commit).toEqual({ status: 'dropped', reason: 'timeout' });
    expect(editing.getSnapshot().state).toBe('readonly');
    expect(editing.getSnapshot().motion!.tracks[0].keyframes[1].value).toBe(10);
    expect(authoring.canUndo).toBe(false);
    expect(preview.clear).toHaveBeenCalled();
    await editing.dispose();
  });

  it('accepts one pending gesture after grant without repeating lease acquisition', async () => {
    const gate = delayedAuthority();
    const { editing, store } = await harness(gate.authority);
    const version = store.version;
    const session = editing.open({ statementId: 'performance' });
    await settle();
    session.preview({ type: 'update-keyframe', keyframe: editing.getSnapshot().keyframes[1].ref, value: 20 });
    const commit = session.commit();
    gate.grant(0);
    expect(await commit).toEqual({ status: 'committed' });
    expect(store.version).toBe(version + 1);
    expect(gate.authority.acquire).toHaveBeenCalledTimes(1);
    expect(gate.authority.release).not.toHaveBeenCalled();
    await session.close();
    await session.close();
    expect(gate.authority.release).toHaveBeenCalledTimes(1);
    await editing.dispose();
  });

  it('releases A before acquiring B and makes old handles harmless', async () => {
    const gate = delayedAuthority();
    const { editing } = await harness(gate.authority);
    const first = editing.open({ statementId: 'performance' });
    await settle();
    const firstLease = gate.grant(0);
    await first.ready;
    const second = editing.open({ statementId: 'performance' });
    expect(first.preview(null).status).toBe('rejected');
    await settle();
    expect(gate.releases).toEqual([firstLease]);
    expect(vi.mocked(gate.authority.release).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(gate.authority.acquire).mock.invocationCallOrder[1]);
    gate.grant(1);
    await second.ready;
    await first.close();
    expect(editing.getSnapshot().session).toBe(second);
    expect(editing.getSnapshot().state).toBe('held');
    await editing.dispose();
  });

  it('releases a late grant for a closed session and never writes its candidate', async () => {
    const gate = delayedAuthority();
    const { editing, store } = await harness(gate.authority);
    const session = editing.open({ statementId: 'performance' });
    await settle();
    const version = store.version;
    session.preview({ type: 'update-keyframe', keyframe: editing.getSnapshot().keyframes[1].ref, value: 99 });
    const commit = session.commit();
    const closing = session.close();
    const lease = gate.grant(0);
    await closing;
    expect((await commit).status).toBe('dropped');
    expect(gate.releases).toEqual([lease]);
    expect(store.version).toBe(version);
    expect(editing.getSnapshot().state).toBe('closed');
    await editing.dispose();
  });

  it('clears preview and refuses further writes after loss of an acquired lease', async () => {
    const gate = delayedAuthority();
    const { editing, store } = await harness(gate.authority);
    const session = editing.open({ statementId: 'performance' });
    await settle();
    const lease = gate.grant(0);
    await session.ready;
    const version = store.version;
    session.preview({ type: 'update-keyframe', keyframe: editing.getSnapshot().keyframes[1].ref, value: 99 });
    gate.losses.get(lease)!('disconnected');
    expect(editing.getSnapshot().state).toBe('readonly');
    expect(editing.getSnapshot().motion!.tracks[0].keyframes[1].value).toBe(10);
    expect((await session.commit()).status).toBe('dropped');
    expect(store.version).toBe(version);
    await editing.dispose();
  });

  it.each([24, 30, 60, undefined])('lowers newly inserted frame times at %s fps without rounding native subframe points', async (fps) => {
    const base = document();
    const source = { ...base, meta: { ...base.meta, fps } };
    const { editing, store } = await harness(undefined, source);
    const session = editing.open({ statementId: 'performance' });
    await session.ready;
    const rate = fps ?? 60;
    session.preview({ type: 'insert-keyframe', parameterId: 'ANGLE', frame: 7, value: 4 });
    expect(await session.commit()).toEqual({ status: 'committed' });
    expect(editing.getSnapshot().motion!.tracks[0].keyframes[1].time).toBe(7 / rate);
    expect((store.getCurrentSceneDocumentSnapshot()!.statements[0].params as CharacterPerformanceParams).expression).toBe('smile');
    await editing.dispose();
  });

  it('cancels a candidate on fps changes while preserving persisted seconds and the lease', async () => {
    const { editing, coordinator, store } = await harness();
    const session = editing.open({ statementId: 'performance' });
    await session.ready;
    const ref = editing.getSnapshot().keyframes[1].ref;
    session.preview({ type: 'update-keyframe', keyframe: ref, value: 40 });
    const source = store.getCurrentSceneDocumentSnapshot()!;
    await coordinator.applyDocument({ ...source, meta: { ...source.meta, fps: 24 } });
    expect(editing.getSnapshot()).toMatchObject({ state: 'held', fps: 24 });
    expect(editing.getSnapshot().motion!.tracks[0].keyframes[1]).toMatchObject({ time: 1, value: 10 });
    expect(session.preview({ type: 'update-keyframe', keyframe: ref, value: 40 }).status).toBe('rejected');
    expect((await session.commit()).status).toBe('dropped');
    await editing.dispose();
  });

  it('shows the current canonical Motion readonly after an external revision and closes on deletion', async () => {
    const { editing, coordinator, store } = await harness();
    const session = editing.open({ statementId: 'performance' });
    await session.ready;
    const next = document();
    ((next.statements[0].params as CharacterPerformanceParams).motion as { fadeInSeconds: number }).fadeInSeconds = 0.2;
    await coordinator.applyDocument(next);
    expect(editing.getSnapshot()).toMatchObject({ state: 'readonly', motion: { fadeInSeconds: 0.2 } });
    expect((await session.commit()).status).toBe('dropped');
    const current = store.getCurrentSceneDocumentSnapshot()!;
    await coordinator.applyDocument({ ...current, statements: [] });
    expect(editing.getSnapshot().state).toBe('closed');
    await editing.dispose();
  });

  it('does not request authority for an invalid target', async () => {
    const gate = delayedAuthority();
    const { editing } = await harness(gate.authority);
    expect(await editing.open({ statementId: 'missing' }).ready).toEqual({ status: 'invalid-target' });
    expect(gate.authority.acquire).not.toHaveBeenCalled();
    await editing.dispose();
  });

  it('preserves native subframe seconds for vertical edits and snaps moved points to scene frames', async () => {
    const source = document();
    const motion = (source.statements[0].params as CharacterPerformanceParams).motion!;
    if (!motion || motion.kind !== 'custom') throw new Error('fixture');
    (source.statements[0].params as CharacterPerformanceParams).motion = {
      ...motion, tracks: [{ ...motion.tracks[0], keyframes: motion.tracks[0].keyframes.map((point, index) => index === 1 ? { ...point, time: 1.013 } : point) }],
    };
    const { editing } = await harness(undefined, source);
    const session = editing.open({ statementId: 'performance' });
    await session.ready;
    session.preview({ type: 'move-keyframes', keyframes: [editing.getSnapshot().keyframes[1].ref], deltaFrames: 0, deltaValue: 2 });
    await session.commit();
    expect(editing.getSnapshot().motion!.tracks[0].keyframes[1].time).toBe(1.013);
    session.preview({ type: 'move-keyframes', keyframes: [editing.getSnapshot().keyframes[1].ref], deltaFrames: 1 });
    await session.commit();
    expect(editing.getSnapshot().motion!.tracks[0].keyframes[1].time).toBe(31 / 30);
    await editing.dispose();
  });

  it('waits for an explicit close release before opening another session', async () => {
    const gate = delayedAuthority();
    const released = deferred<void>();
    vi.mocked(gate.authority.release).mockImplementationOnce(() => released.promise);
    const { editing } = await harness(gate.authority);
    const first = editing.open({ statementId: 'performance' });
    await settle(); gate.grant(0); await first.ready;
    const closing = first.close();
    const second = editing.open({ statementId: 'performance' });
    await settle();
    expect(gate.authority.acquire).toHaveBeenCalledTimes(1);
    released.resolve(); await closing; await settle();
    expect(gate.authority.acquire).toHaveBeenCalledTimes(2);
    gate.grant(1); await second.ready;
    await editing.dispose();
  });

  it('does not resurrect a pending session after an external revision and late grant', async () => {
    const gate = delayedAuthority();
    const { editing, coordinator } = await harness(gate.authority);
    const session = editing.open({ statementId: 'performance' });
    await settle();
    const next = document();
    const motion = (next.statements[0].params as CharacterPerformanceParams).motion!;
    if (!motion || motion.kind !== 'custom') throw new Error('fixture');
    (next.statements[0].params as CharacterPerformanceParams).motion = { ...motion, fadeInSeconds: 0.2 };
    await coordinator.applyDocument(next);
    const lease = gate.grant(0);
    expect(await session.ready).toMatchObject({ status: 'readonly' });
    expect(editing.getSnapshot().state).toBe('readonly');
    expect(gate.releases).toEqual([lease]);
    await editing.dispose();
  });

  it('invalidates a preview when the same Motion is retargeted to another character', async () => {
    const { editing, coordinator } = await harness();
    const session = editing.open({ statementId: 'performance' }); await session.ready;
    session.preview({ type: 'update-keyframe', keyframe: editing.getSnapshot().keyframes[1].ref, value: 20 });
    const next = document(); (next.statements[0].params as CharacterPerformanceParams).target = 'bob';
    await coordinator.applyDocument(next);
    expect(editing.getSnapshot()).toMatchObject({ state: 'readonly', reason: 'target-changed', target: { characterId: 'bob' } });
    expect((await session.commit()).status).toBe('dropped');
    await editing.dispose();
  });

  it('waits for an entered write before releasing, while immediately invalidating the handle', async () => {
    const authority = new InMemoryCustomMotionEditAuthority();
    const release = vi.spyOn(authority, 'release');
    const { editing, coordinator, authoring, store } = await harness(authority);
    const session = editing.open({ statementId: 'performance' }); await session.ready;
    const completed = deferred<void>(); const entered = deferred<void>();
    const apply = coordinator.applyDocument.bind(coordinator);
    vi.spyOn(coordinator, 'applyDocument').mockImplementationOnce(async (...args) => {
      entered.resolve(); await completed.promise; return apply(...args);
    });
    session.preview({ type: 'update-keyframe', keyframe: editing.getSnapshot().keyframes[1].ref, value: 30 });
    const committing = session.commit(); await entered.promise;
    const closing = session.close();
    expect(editing.getSnapshot().state).toBe('closed');
    expect(session.preview(null).status).toBe('rejected');
    expect(release).not.toHaveBeenCalled();
    completed.resolve();
    expect((await committing).status).toBe('committed'); await closing;
    expect(release).toHaveBeenCalledTimes(1);
    expect(authoring.canUndo).toBe(true);
    expect((store.getCurrentSceneDocumentSnapshot()!.statements[0].params as CharacterPerformanceParams).motion).toMatchObject({ tracks: [{ keyframes: [{ value: 0 }, { value: 30 }] }] });
    await editing.dispose();
  });

  it('reapplies a newer preview after an asynchronous canonical restore', async () => {
    const { editing, preview } = await harness();
    const session = editing.open({ statementId: 'performance' }); await session.ready;
    const keyframe = editing.getSnapshot().keyframes[1].ref;
    session.preview({ type: 'update-keyframe', keyframe, value: 12 });
    const restored = deferred<void>(); preview.clear.mockImplementationOnce(() => restored.promise);
    session.preview(null);
    session.preview({ type: 'update-keyframe', keyframe, value: 24 });
    const count = preview.apply.mock.calls.length;
    restored.resolve(); await settle();
    expect(preview.apply).toHaveBeenCalledTimes(count + 1);
    expect(preview.apply.mock.lastCall?.[0].motion.tracks[0].keyframes[1].value).toBe(24);
    await editing.dispose();
  });

  it('releases ownership even when restoring the canonical stage fails', async () => {
    const authority = new InMemoryCustomMotionEditAuthority();
    const release = vi.spyOn(authority, 'release');
    const { editing, preview } = await harness(authority);
    const session = editing.open({ statementId: 'performance' }); await session.ready;
    session.preview({ type: 'update-keyframe', keyframe: editing.getSnapshot().keyframes[1].ref, value: 12 });
    preview.clear.mockRejectedValueOnce(new Error('stage unavailable'));
    await expect(session.close()).rejects.toThrow('stage unavailable');
    expect(release).toHaveBeenCalledTimes(1);
    expect(await editing.open({ statementId: 'performance' }).ready).toEqual({ status: 'held' });
    await editing.dispose();
  });

  it('transfers conversion ownership to the resulting session without reacquiring', async () => {
    const authority = new InMemoryCustomMotionEditAuthority();
    const acquire = vi.spyOn(authority, 'acquire'); const release = vi.spyOn(authority, 'release');
    const source = document(); (source.statements[0].params as CharacterPerformanceParams).motion = { kind: 'resource', key: 'wave' };
    const { editing, store, authoring } = await harness(authority, source);
    const conversion = new CustomMotionConversion({ store, editing, authoring, sampler: {
      resolveMeta: vi.fn(async () => ({ durationSeconds: 2, fadeInSeconds: 0.1 })),
      sample: vi.fn(async () => [{ parameterId: 'ANGLE', samples: [{ time: 0, value: 0 }, { time: 2, value: 10 }] }]),
    } });
    const receipt = await conversion.convert({ statementId: 'performance' }, 'standard');
    expect(receipt.motion.kind).toBe('custom');
    expect(editing.getSnapshot().state).toBe('held');
    expect(acquire).toHaveBeenCalledTimes(1); expect(release).not.toHaveBeenCalled();
    await conversion.dispose(); await editing.dispose(); expect(release).toHaveBeenCalledTimes(1);
  });

  it('drops an edit queued behind an external Motion replacement without rebasing', async () => {
    const { editing, authoring, coordinator } = await harness();
    const session = editing.open({ statementId: 'performance' }); await session.ready;
    session.preview({ type: 'update-keyframe', keyframe: editing.getSnapshot().keyframes[1].ref, value: 90 });
    const next = document(); const replacement = (next.statements[0].params as CharacterPerformanceParams).motion!;
    if (!replacement || replacement.kind !== 'custom') throw new Error('fixture');
    const changed = { ...replacement, tracks: [{ ...replacement.tracks[0], keyframes: replacement.tracks[0].keyframes.map((point, index) => index === 1 ? { ...point, value: 25 } : point) }] };
    const completed = deferred<void>(); const entered = deferred<void>();
    const apply = coordinator.applyDocument.bind(coordinator);
    vi.spyOn(coordinator, 'applyDocument').mockImplementationOnce(async (...args) => { entered.resolve(); await completed.promise; return apply(...args); });
    const preceding = authoring.author({ version: AUTHORING_SCHEMA_VERSION, correlationId: 'external', origin: 'timeline-editor', kind: 'update-custom-motion-keyframes', locator: { statementId: 'performance' }, motion: changed });
    await entered.promise;
    const commit = session.commit(); completed.resolve(); await preceding;
    expect((await commit).status).toBe('dropped');
    expect(editing.getSnapshot()).toMatchObject({ state: 'readonly', motion: { tracks: [{ keyframes: [{ value: 0 }, { value: 25 }] }] } });
    await editing.dispose();
  });

  it('rejects protected F0 deletion and collisions before any document write', async () => {
    const { editing, store, authoring } = await harness();
    const session = editing.open({ statementId: 'performance' }); await session.ready;
    const version = store.version;
    expect(session.preview({ type: 'remove-keyframe', keyframe: editing.getSnapshot().keyframes[0].ref }).status).toBe('rejected');
    expect(session.preview({ type: 'insert-keyframe', parameterId: 'ANGLE', frame: 30, value: 2 }).status).toBe('rejected');
    expect(store.version).toBe(version); expect(authoring.canUndo).toBe(false);
    await editing.dispose();
  });

  it('edits a dialogue companion through the same interface and grows scene duration', async () => {
    const source = document();
    source.meta.durationSeconds = 2;
    const performance = source.statements[0];
    source.statements = [{ id: 'line', type: 'dialogue', time: 0, params: { text: 'hello', speakerId: 'alice', durationSeconds: 1 }, companions: [{ id: 'companion', type: 'characterPerformance', anchor: 'start', offset: 0, params: { ...performance.params, target: '$speaker' } }] }];
    const { editing, store } = await harness(undefined, source);
    const session = editing.open({ statementId: 'line', companionId: 'companion' }); await session.ready;
    expect(editing.getSnapshot().target).toMatchObject({ characterId: 'alice', companionId: 'companion' });
    session.preview({ type: 'set-duration', frames: 150 }); await session.commit();
    expect(editing.getSnapshot().canonicalMotion!.durationSeconds).toBe(5);
    expect(store.getCurrentSceneDocumentSnapshot()!.meta.durationSeconds).toBeGreaterThanOrEqual(5);
    await editing.dispose();
  });

  it('cancels conversion during sampling when another editor opens without acquiring overlapping ownership', async () => {
    const authority = new InMemoryCustomMotionEditAuthority();
    const acquire = vi.spyOn(authority, 'acquire');
    const { editing, store, authoring } = await harness(authority);
    const sampled = deferred<void>(); const sampling = deferred<void>();
    const conversion = new CustomMotionConversion({ store, editing, authoring, sampler: {
      resolveMeta: vi.fn(async () => ({ durationSeconds: 2, fadeInSeconds: 0.1 })),
      sample: vi.fn(async () => { sampling.resolve(); await sampled.promise; return [{ parameterId: 'ANGLE', samples: [{ time: 0, value: 0 }, { time: 2, value: 10 }] }]; }),
    } });
    const converting = conversion.convert({ statementId: 'performance' }, 'standard');
    const failed = expect(converting).rejects.toMatchObject({ code: 'lease-denied' });
    await sampling.promise;
    const session = editing.open({ statementId: 'performance' });
    await settle(); expect(acquire).not.toHaveBeenCalled();
    sampled.resolve(); await failed; await session.ready;
    expect(acquire.mock.calls.filter(([, signal]) => !signal.aborted)).toHaveLength(1);
    expect(authoring.canUndo).toBe(false); expect(editing.getSnapshot().state).toBe('held');
    await conversion.dispose(); await editing.dispose();
  });

  it('releases a cancelled conversion grant before requesting the editor lease', async () => {
    const gate = delayedAuthority();
    const { editing, store, authoring } = await harness(gate.authority);
    const conversion = new CustomMotionConversion({ store, editing, authoring, sampler: {
      resolveMeta: vi.fn(async () => ({ durationSeconds: 2, fadeInSeconds: 0.1 })),
      sample: vi.fn(async () => [{ parameterId: 'ANGLE', samples: [{ time: 0, value: 0 }, { time: 2, value: 10 }] }]),
    } });
    const converting = conversion.convert({ statementId: 'performance' }, 'standard');
    const failed = expect(converting).rejects.toMatchObject({ code: 'entity-changed' });
    await settle(); expect(gate.decisions).toHaveLength(1);
    const session = editing.open({ statementId: 'performance' });
    await settle(); expect(gate.authority.acquire).toHaveBeenCalledTimes(1);
    const lease = gate.grant(0); await failed; await settle();
    expect(gate.releases).toEqual([lease]); expect(gate.decisions).toHaveLength(2);
    expect(vi.mocked(gate.authority.release).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(gate.authority.acquire).mock.invocationCallOrder[1]);
    gate.grant(1); await session.ready;
    expect(authoring.canUndo).toBe(false);
    await conversion.dispose(); await editing.dispose();
  });
});

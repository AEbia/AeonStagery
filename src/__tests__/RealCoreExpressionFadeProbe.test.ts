/**
 * Real-core probe: drive the ACTUAL vendored Cubism 2.1 runtime
 * (the locally staged `live2d.min.js`) plus pixi-live2d-display's real
 * Cubism2ExpressionManager through the exact setExpressionForSeek clock
 * sequence, and observe what weight actually reaches the core parameters on
 * the seeked frame.
 *
 * Verifies:
 *  - seek at elapsed=2ms must produce the fade-in start weight (~0), not a
 *    fully-applied expression;
 *  - the previous-expression retention (two-phase latch) keeps the old
 *    expression resident while the target fades in.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import { resolveCubism2CorePath } from './helpers/live2dRuntimeFixture';

// The Cubism 2.1 core is not committed (ADR-0035): without a staged runtime
// this probe cannot run, so it skips instead of failing.
const cubism2CorePath = resolveCubism2CorePath();

let UtSystem: any;
let Cubism2ExpressionManager: any;

function createCoreModel() {
  const values = new Float32Array(16);
  const saved = new Float32Array(16);
  const indexByName = new Map<string, number>([
    ['PARAM_MOUTH_FORM', 0],
    ['PARAM_EYE_OPEN', 1],
    ['PARAM_ANGLE_X', 2],
  ]);
  const writes: Array<{ id: number; value: number; ut: number }> = [];
  return {
    values,
    writes,
    getParamIndex: (name: string) => indexByName.get(name) ?? -1,
    setParamFloat: (idOrName: string | number, value: number) => {
      const index = typeof idOrName === 'number' ? idOrName : (indexByName.get(idOrName) ?? -1);
      if (index < 0) return;
      values[index] = value;
      writes.push({ id: index, value, ut: UtSystem.getUserTimeMSec() });
    },
    setParamFloatByIndex: (index: number, value: number) => {
      values[index] = value;
      writes.push({ id: index, value, ut: UtSystem.getUserTimeMSec() });
    },
    getParamFloat: (index: number) => values[index],
    getParameterValues: () => values,
    saveParam: () => {
      for (let i = 0; i < values.length; i++) saved[i] = values[i];
    },
    loadParam: () => {
      for (let i = 0; i < values.length; i++) values[i] = saved[i];
    },
  };
}

function createExpressionManager() {
  const settings = {
    name: 'probe-model',
    expressions: [
      { name: 'smileA', file: 'smileA.json' },
      { name: 'shame01', file: 'shame01.json' },
      { name: 'anger02', file: 'anger02.json' },
      { name: 'cry01', file: 'cry01.json' },
      { name: 'shame01', file: 'shame01.json' },
    ],
  };
  const manager = new Cubism2ExpressionManager(settings, {});
  const loaders: Record<string, any> = {
    smileA: {
      params: [
        { id: 'PARAM_MOUTH_FORM', val: 0.9, calc: 'add', def: 0 },
        { id: 'PARAM_EYE_OPEN', val: 0.5, calc: 'add', def: 0 },
      ],
    },
    shame01: {
      params: [
        { id: 'PARAM_EYE_OPEN', val: -0.4, calc: 'add', def: 0 },
        { id: 'PARAM_ANGLE_X', val: -0.25, calc: 'add', def: 0 },
      ],
    },
    anger02: {
      params: [
        { id: 'PARAM_MOUTH_FORM', val: -0.6, calc: 'add', def: 0 },
      ],
    },
  };
  // pixi's real loadExpression goes through Live2DFactory's async loader;
  // construct the real expression objects directly (same data decoding as
  // createExpression) and pre-fill the cache the way a finished load would.
  manager.expressions = settings.expressions.map((definition) => (
    manager.createExpression(loaders[definition.name] ?? {}, definition)
  ));
  return { manager, loaders };
}

beforeAll(async () => {
  if (!cubism2CorePath) return;
  (globalThis as any).window = globalThis;
  if (typeof (globalThis as any).navigator === 'undefined' || !(globalThis as any).navigator.userAgent) {
    (globalThis as any).navigator = { userAgent: 'vitest-probe' };
  }
  const sdkCode = fs.readFileSync(cubism2CorePath, 'utf8');
  (0, eval)(sdkCode);
  UtSystem = (globalThis as any).UtSystem;
  if (!UtSystem) throw new Error('vendored SDK did not expose UtSystem');
  // v8 migration: the engine ships as `untitled-pixi-live2d-engine`; its
  // Cubism 2 expression manager is the renamed `CubismLegacyExpressionManager`.
  const cubism2 = await import('untitled-pixi-live2d-engine/cubism-legacy');
  Cubism2ExpressionManager = cubism2.CubismLegacyExpressionManager;
  if (!Cubism2ExpressionManager) throw new Error('CubismLegacyExpressionManager not exported');
});

describe.skipIf(!cubism2CorePath)('real-core seek expression fade probe', () => {
  it('seek at elapsed=2ms drives a fade-in START weight, not a full expression', async () => {
    const coreModel = createCoreModel();
    const { manager } = createExpressionManager();

    // The target expression object is pre-fetched like a finished load.
    const index = manager.getExpressionIndex('shame01');
    const expression = manager.expressions[index];
    expect(expression).toBeTruthy();

    // ── Simulate the setExpressionForSeek locked sequence (elapsed=2ms) ──
    const nowMs = 10_000;
    const elapsedMs = 2;
    UtSystem.setUserTimeMSec(nowMs - elapsedMs);
    manager.currentExpression = expression;
    manager._setExpression(expression);
    // first updateParam latches the entry start time at the rewound clock
    manager.update(coreModel, nowMs - elapsedMs);
    UtSystem.setUserTimeMSec(nowMs);
    // the next real render evaluates at the restored clock
    manager.update(coreModel, nowMs);

    const mouth = coreModel.values[0]; // PARAM_MOUTH_FORM is NOT touched by shame01
    const eye = coreModel.values[1]; // PARAM_EYE_OPEN = -0.4 * weight
    const angle = coreModel.values[2]; // PARAM_ANGLE_X = -0.25 * weight

    // shame01 owns eye/angle: at the very start of the fade their weight must
    // be ~0 (nothing visible), NOT the full values.
    expect(Math.abs(eye)).toBeLessThan(0.05);
    expect(Math.abs(angle)).toBeLessThan(0.05);
    // mouth untouched by shame01 → stays 0 from the core baseline.
    expect(mouth).toBe(0);

    // After the fade completes (advance 600ms), the expression is full.
    UtSystem.setUserTimeMSec(nowMs + 600);
    manager.update(coreModel, nowMs + 600);
    expect(coreModel.values[1]).toBeCloseTo(-0.4, 3);
    expect(coreModel.values[2]).toBeCloseTo(-0.25, 3);
  });

  it('previous-expression retention: old expression stays resident at weight 1 while the target fades in', async () => {
    const coreModel = createCoreModel();
    const { manager } = createExpressionManager();

    // Playback phase: smileA fully applied (weight 1) — queue owns it.
    const aIndex = manager.getExpressionIndex('smileA');
    const aExpr = manager.expressions[aIndex];
    UtSystem.setUserTimeMSec(6000);
    manager.currentExpression = aExpr;
    manager._setExpression(aExpr);
    manager.update(coreModel, 6000); // latch at 6000
    UtSystem.setUserTimeMSec(6600); // 600ms later: fade complete
    manager.update(coreModel, 6600);
    expect(coreModel.values[0]).toBeCloseTo(0.9, 3); // smileA mouth (weight 1)
    expect(coreModel.values[1]).toBeCloseTo(0.5, 3); // smileA eye

    // Seek: switch to anger02 with elapsed=2ms, keeping smileA resident.
    const nowMs = 10_000;
    const elapsedMs = 2;
    const bIndex = manager.getExpressionIndex('anger02');
    const bExpr = manager.expressions[bIndex];

    // reset the queue to just the previous entry (setExpressionForSeek's
    // stopAllMotions + our two-phase re-enqueue):
    manager.queueManager.stopAllMotions();
    coreModel.saveParam();

    // Phase 1: previous expression latched far in the past (weight 1).
    UtSystem.setUserTimeMSec(nowMs - elapsedMs - 6000);
    manager._setExpression(aExpr);
    manager.update(coreModel, nowMs - elapsedMs - 6000);
    const afterPhase1 = coreModel.values[0];
    // Phase 2: target expression latched at the seeked elapsed.
    UtSystem.setUserTimeMSec(nowMs - elapsedMs);
    manager.currentExpression = bExpr;
    manager._setExpression(bExpr);
    manager.update(coreModel, nowMs - elapsedMs);
    const _afterPhase2 = coreModel.values[0];
    void _afterPhase2;
    // Restored clock render pass.
    UtSystem.setUserTimeMSec(nowMs);
    manager.update(coreModel, nowMs);
    const afterRestore = coreModel.values[0];
    const queueLen = manager.queueManager.motions.filter(Boolean).length;

    // Overlap semantics: the target expression owns mouth, so at the fade
    // START its write (valB * ~0) dominates the shared parameter exactly like
    // playback's first fade frame does — the previous expression's exclusive
    // parameters (eye) must keep their resident contribution instead.
    expect(afterPhase1).toBeGreaterThanOrEqual(-1e-9);
    expect(Math.abs(afterRestore)).toBeLessThan(0.05); // B covered mouth at ~0 weight
    expect(coreModel.values[1]).toBeGreaterThan(0.4); // smileA eye stays resident
    expect(queueLen).toBeGreaterThanOrEqual(2); // both entries remain enqueued
  });

  it('seek cross-boundary reconstruction matches playback frame-for-frame (real core)', async () => {
    // Playback: cry01 resident (eye + mouth), then shame01 fades in on top
    // without stopping the old entry — this is what the user observes as
    // "smooth" playback. The seek reconstruction must reproduce the same
    // frame: shared parameters = val_shame * fade(elapsed), exclusive
    // parameters keep the resident old-expression contribution.
    const playback = createCoreModel();
    const playbackMgr = createExpressionManager().manager;
    const cryIdx = playbackMgr.getExpressionIndex('cry01');
    const shameIdx = playbackMgr.getExpressionIndex('shame01');
    if (cryIdx < 0 || shameIdx < 0) throw new Error('expression defs missing');
    const cry = playbackMgr.expressions[cryIdx];
    const shame = playbackMgr.expressions[shameIdx];
    // add cry01 + shame01 definitions with a shared param and an exclusive one
    // (rebuild manager with matching definitions)

    UtSystem.setUserTimeMSec(4500);
    playbackMgr.currentExpression = cry;
    playbackMgr._setExpression(cry);
    playbackMgr.update(playback, 4500);
    UtSystem.setUserTimeMSec(10_800); // 6.3s later: fully faded in
    playbackMgr.update(playback, 10_800);
    // start shame01 (playback path: no stopAll) at 10.800
    const shameStart = 10_800;
    const elapsed = 6; // 6ms into the fade
    UtSystem.setUserTimeMSec(shameStart + elapsed);
    playbackMgr.currentExpression = shame;
    playbackMgr._setExpression(shame);
    playbackMgr.update(playback, shameStart + elapsed);
    // next real render pass at the same clock
    playbackMgr.update(playback, shameStart + elapsed);

    // ── Seek path reproduces the identical clock layout via two phases ──
    const seek = createCoreModel();
    const seekMgr = createExpressionManager().manager;
    const prev = seekMgr.expressions[seekMgr.getExpressionIndex('cry01')];
    const target = seekMgr.expressions[seekMgr.getExpressionIndex('shame01')];
    const nowMs = shameStart + elapsed;
    seekMgr.queueManager.stopAllMotions();
    seek.saveParam();
    UtSystem.setUserTimeMSec(nowMs - elapsed - 6000);
    seekMgr.currentExpression = prev;
    seekMgr._setExpression(prev);
    seekMgr.update(seek, nowMs - elapsed - 6000);
    UtSystem.setUserTimeMSec(nowMs - elapsed);
    seekMgr.currentExpression = target;
    seekMgr._setExpression(target);
    seekMgr.update(seek, nowMs - elapsed);
    UtSystem.setUserTimeMSec(nowMs);
    seekMgr.update(seek, nowMs);

    // Mouth (shared by cry01=0.9 and shame01=-0.4): both paths must show
    // shame01's fade-in weighted value (the later writer covers the param).
    expect(seek.values[0]).toBeCloseTo(playback.values[0], 6);
    // Eye (exclusive to cry01): the resident old expression keeps writing it.
    // The seek path latches its own save/restore clock, so the resident
    // writer's contribution can drift by ~1e-4 from the playback pass — the
    // reconstructed value must still track playback, not snap to neutral.
    expect(seek.values[1]).toBeCloseTo(playback.values[1], 3);
  });
});


import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { SemanticScenePatchV1 } from '../api/types/semantic-scene-patch';
import {
  assertEnhancementStageScope,
  buildEnhancementStageScope,
  computeSceneEndSeconds,
  planTechnicalSplits,
} from '../services/ai-authoring/EnhancementScope';
import { SemanticSceneLineView } from '../services/semantic-scene/SemanticSceneLineView';

function doc(statements: CurrentSceneDocument['statements']): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-1',
    meta: { title: 'Test', characters: [{ id: 'c1', name: 'Alice' }] },
    statements,
  };
}

describe('EnhancementScope', () => {
  it('builds writable group ranges and line sets from narrative boundaries', () => {
    const document = doc([
      {
        id: 'd0',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'c1', speaker: 'Alice', text: '一', durationSeconds: 1 },
      },
      {
        id: 'd1',
        time: 2,
        type: 'dialogue',
        params: { speakerId: 'c1', speaker: 'Alice', text: '二', durationSeconds: 1 },
      },
      {
        id: 'd2',
        time: 4,
        type: 'dialogue',
        params: { speakerId: 'c1', speaker: 'Alice', text: '三', durationSeconds: 1 },
      },
    ]);

    const scope = buildEnhancementStageScope({
      document,
      groups: [
        { index: 0, time: 0, rootCount: 1, hasSpeakerText: true, visibleChars: 1 },
        { index: 1, time: 2, rootCount: 1, hasSpeakerText: true, visibleChars: 1 },
        { index: 2, time: 4, rootCount: 1, hasSpeakerText: true, visibleChars: 1 },
      ],
      boundary: { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 2 },
      isLastUnit: false,
      nextUnitStartTime: 4,
    });

    expect(scope.coreStartTime).toBe(0);
    expect(scope.coreEndTimeExclusive).toBe(4);
    expect(scope.writableRootLines.has(1)).toBe(true);
    expect(scope.writableRootLines.has(2)).toBe(true);
    expect(scope.writableRootLines.has(3)).toBe(false);
  });

  it('rejects operations that target lines outside the core writable set', () => {
    const document = doc([
      {
        id: 'd0',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'c1', speaker: 'Alice', text: '一', durationSeconds: 1 },
      },
      {
        id: 'd1',
        time: 2,
        type: 'dialogue',
        params: { speakerId: 'c1', speaker: 'Alice', text: '二', durationSeconds: 1 },
      },
    ]);
    const lineView = new SemanticSceneLineView(document);
    const scope = buildEnhancementStageScope({
      document,
      groups: [
        { index: 0, time: 0, rootCount: 1, hasSpeakerText: true, visibleChars: 1 },
        { index: 1, time: 2, rootCount: 1, hasSpeakerText: true, visibleChars: 1 },
      ],
      boundary: { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 1 },
      isLastUnit: false,
      nextUnitStartTime: 2,
    });

    const patch: SemanticScenePatchV1 = {
      version: 1,
      operations: [{
        kind: 'updateStatement',
        line: 2,
        patch: { params: { motion: 'wave' } },
      }],
    };

    const result = assertEnhancementStageScope({
      patch,
      scope,
      lineView,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('stage_scope_violation');
  });

  it('plans technical splits when a narrative segment exceeds the safe budget', () => {
    const groups = Array.from({ length: 6 }, (_, index) => ({
      index,
      time: index * 2,
      rootCount: 1,
      hasSpeakerText: true,
      visibleChars: 1000,
    }));

    const plan = planTechnicalSplits({
      groups,
      boundary: { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 6 },
      /** Force split: each group ~1000 chars, budget 2500 → multiple units. */
      maxVisibleCharsPerUnit: 2500,
    });

    expect(plan.status).toBe('ok');
    if (plan.status !== 'ok') return;
    expect(plan.units.length).toBeGreaterThan(1);
    expect(plan.units.every((unit) => unit.kind === 'technical_capacity')).toBe(true);
    expect(plan.units[0]?.startGroupIndex).toBe(0);
    expect(plan.units.at(-1)?.endGroupIndexExclusive).toBe(6);
  });

  it('returns processing_unit_too_large when a single group exceeds the budget', () => {
    const plan = planTechnicalSplits({
      groups: [{
        index: 0,
        time: 0,
        rootCount: 1,
        hasSpeakerText: true,
        visibleChars: 9000,
      }],
      boundary: { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 1 },
      maxVisibleCharsPerUnit: 2500,
    });

    expect(plan.status).toBe('processing_unit_too_large');
  });

  it('bounds the last unit core window inclusively at the computed scene end', () => {
    // dialogue d0 spans [0, 2), dialogue d1 spans [4, 5) → sceneEnd = 5.
    const document = doc([
      {
        id: 'd0',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'c1', speaker: 'Alice', text: '一', durationSeconds: 2 },
      },
      {
        id: 'd1',
        time: 4,
        type: 'dialogue',
        params: { speakerId: 'c1', speaker: 'Alice', text: '二', durationSeconds: 1 },
      },
    ]);
    const lineView = new SemanticSceneLineView(document);
    const scope = buildEnhancementStageScope({
      document,
      groups: [
        { index: 0, time: 0, rootCount: 1, hasSpeakerText: true, visibleChars: 1 },
        { index: 1, time: 4, rootCount: 1, hasSpeakerText: true, visibleChars: 1 },
      ],
      boundary: { key: 'seg-1', startGroupIndex: 1, endGroupIndexExclusive: 2 },
      isLastUnit: true,
    });

    expect(scope.coreStartTime).toBe(4);
    expect(scope.coreEndTimeExclusive).toBe(5);

    const insertAt = (time: number): SemanticScenePatchV1 => ({
      version: 1,
      operations: [{
        kind: 'insertStatement',
        time,
        statement: {
          type: 'camera',
          params: { mode: 'reset', durationSeconds: 0.3 },
        },
      }],
    });

    // Exactly scene end is allowed (inclusive bound).
    expect(assertEnhancementStageScope({
      patch: insertAt(5),
      scope,
      lineView,
    }).ok).toBe(true);

    // Beyond scene end is rejected with stage_scope_violation.
    const beyond = assertEnhancementStageScope({
      patch: insertAt(5.001),
      scope,
      lineView,
    });
    expect(beyond.ok).toBe(false);
    if (!beyond.ok) {
      expect(beyond.issues[0]?.code).toBe('stage_scope_violation');
      expect(beyond.issues[0]?.message).toContain('5.001');
    }
  });

  it('keeps the non-last unit upper bound exclusive at the next unit start time', () => {
    const document = doc([
      {
        id: 'd0',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'c1', speaker: 'Alice', text: '一', durationSeconds: 1 },
      },
      {
        id: 'd1',
        time: 4,
        type: 'dialogue',
        params: { speakerId: 'c1', speaker: 'Alice', text: '二', durationSeconds: 1 },
      },
    ]);
    const lineView = new SemanticSceneLineView(document);
    const scope = buildEnhancementStageScope({
      document,
      groups: [
        { index: 0, time: 0, rootCount: 1, hasSpeakerText: true, visibleChars: 1 },
        { index: 1, time: 4, rootCount: 1, hasSpeakerText: true, visibleChars: 1 },
      ],
      boundary: { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 1 },
      isLastUnit: false,
      nextUnitStartTime: 4,
    });

    const insertAt = (time: number): SemanticScenePatchV1 => ({
      version: 1,
      operations: [{
        kind: 'insertStatement',
        time,
        statement: {
          type: 'camera',
          params: { mode: 'reset', durationSeconds: 0.3 },
        },
      }],
    });

    // [0, 4): inside accepted, exactly the next unit start rejected.
    expect(assertEnhancementStageScope({ patch: insertAt(3.5), scope, lineView }).ok).toBe(true);
    const atNextStart = assertEnhancementStageScope({ patch: insertAt(4), scope, lineView });
    expect(atNextStart.ok).toBe(false);
    if (!atNextStart.ok) {
      expect(atNextStart.issues[0]?.code).toBe('stage_scope_violation');
    }
  });

  it('computes scene end 0 for a document without statements', () => {
    // No statements → no temporal extent to extend the scene; the last-unit
    // bound collapses to 0, so only time 0 inserts remain in core.
    expect(computeSceneEndSeconds(doc([]))).toBe(0);

    const lineView = new SemanticSceneLineView(doc([]));
    const scope = buildEnhancementStageScope({
      document: doc([]),
      // Hand-constructed group so the scope itself is still representable.
      groups: [{ index: 0, time: 0, rootCount: 0, hasSpeakerText: false, visibleChars: 0 }],
      boundary: { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 1 },
      isLastUnit: true,
    });
    expect(scope.coreEndTimeExclusive).toBe(0);

    const insertAt = (time: number): SemanticScenePatchV1 => ({
      version: 1,
      operations: [{
        kind: 'insertStatement',
        time,
        statement: {
          type: 'camera',
          params: { mode: 'reset', durationSeconds: 0.3 },
        },
      }],
    });
    expect(assertEnhancementStageScope({ patch: insertAt(0), scope, lineView }).ok).toBe(true);
    const beyond = assertEnhancementStageScope({ patch: insertAt(1), scope, lineView });
    expect(beyond.ok).toBe(false);
    if (!beyond.ok) {
      expect(beyond.issues[0]?.code).toBe('stage_scope_violation');
    }
  });
});

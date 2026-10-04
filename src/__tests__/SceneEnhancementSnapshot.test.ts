import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import {
  SceneEnhancementSnapshotStore,
  bindEnhancementSegmentation,
  checkSceneEnhancementSnapshotValidity,
  createEmptySceneNoChangesSnapshot,
  createSceneEnhancementSnapshot,
  isEmptySceneDocument,
  isSceneEnhancementSnapshotValid,
  withSceneEnhancementPhase,
  withSceneEnhancementPreviewPatch,
  withSceneEnhancementStageResult,
} from '../services/ai-authoring/SceneEnhancementSnapshot';

describe('Scene enhancement snapshot binding', () => {
  it('binds snapshots to sceneSessionEpoch and documentVersion', () => {
    const snapshot = createSceneEnhancementSnapshot({
      sceneSessionEpoch: 3,
      documentVersion: 12,
      nowMs: 1000,
    });
    expect(snapshot.binding).toEqual({ sceneSessionEpoch: 3, documentVersion: 12 });
    expect(snapshot.phase).toBe('idle');
    expect(isSceneEnhancementSnapshotValid(snapshot, { sceneSessionEpoch: 3, documentVersion: 12 }))
      .toBe(true);
  });

  it('invalidates the whole preview on document version change', () => {
    const snapshot = createSceneEnhancementSnapshot({
      sceneSessionEpoch: 1,
      documentVersion: 5,
    });
    const validity = checkSceneEnhancementSnapshotValidity(snapshot, {
      sceneSessionEpoch: 1,
      documentVersion: 6,
    });
    expect(validity).toEqual({ valid: false, reason: 'document_version_changed' });
  });

  it('invalidates on scene session epoch change', () => {
    const snapshot = createSceneEnhancementSnapshot({
      sceneSessionEpoch: 1,
      documentVersion: 5,
    });
    expect(checkSceneEnhancementSnapshotValidity(snapshot, {
      sceneSessionEpoch: 2,
      documentVersion: 5,
    }).reason).toBe('scene_session_epoch_changed');
  });

  it('stores segmentation under the same binding', () => {
    const binding = { sceneSessionEpoch: 1, documentVersion: 2 };
    const segmentation = bindEnhancementSegmentation({
      binding,
      segmentKeys: ['seg-0', 'seg-1'],
      narrativeBoundaries: [
        { key: 'seg-0', startGroupIndex: 0, endGroupIndexExclusive: 3 },
        { key: 'seg-1', startGroupIndex: 3, endGroupIndexExclusive: 7 },
      ],
      source: 'semantic_segmentation',
    });
    expect(segmentation.binding).toEqual(binding);
    expect(segmentation.segmentKeys).toHaveLength(2);
  });

  it('updates phase and stage results immutably', () => {
    const base = createSceneEnhancementSnapshot({
      sceneSessionEpoch: 1,
      documentVersion: 1,
      nowMs: 10,
    });
    const withPhase = withSceneEnhancementPhase(base, 'performance', 20);
    expect(withPhase.phase).toBe('performance');
    expect(base.phase).toBe('idle');

    const withStage = withSceneEnhancementStageResult(withPhase, {
      stage: 'performance',
      status: 'succeeded',
      patch: { version: 1, operations: [] },
      policyVersion: 'performance-stage-policy/v1',
    }, 30);
    expect(withStage.performance?.status).toBe('succeeded');

    const withPreview = withSceneEnhancementPreviewPatch(
      withStage,
      { version: 1, operations: [] },
      40,
    );
    expect(withPreview.phase).toBe('preview_ready');
    expect(withPreview.previewPatch?.operations).toEqual([]);
  });

  it('supports empty-scene no_changes fast path', () => {
    const empty: CurrentSceneDocument = {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'empty',
      meta: { title: 'Empty', characters: [] },
      statements: [],
    };
    expect(isEmptySceneDocument(empty)).toBe(true);
    const snapshot = createEmptySceneNoChangesSnapshot({
      sceneSessionEpoch: 1,
      documentVersion: 1,
      nowMs: 50,
    });
    expect(snapshot.phase).toBe('no_changes');
    expect(snapshot.segmentation?.source).toBe('empty_scene');
  });

  it('discards stale snapshots from the in-memory store', () => {
    const store = new SceneEnhancementSnapshotStore();
    store.set(createSceneEnhancementSnapshot({
      sceneSessionEpoch: 1,
      documentVersion: 10,
    }));
    expect(store.getIfValid({ sceneSessionEpoch: 1, documentVersion: 10 })).not.toBeNull();
    expect(store.invalidateIfStale({ sceneSessionEpoch: 1, documentVersion: 11 })).toBe(true);
    expect(store.get()).toBeNull();
  });
});

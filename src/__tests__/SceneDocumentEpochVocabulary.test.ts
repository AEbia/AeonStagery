import { describe, expect, it } from 'vitest';
import {
  SCENE_SCHEMA_VERSION,
  SCENE_SCHEMA_VERSION_V4,
  SCENE_SCHEMA_VERSION_V5,
  type CurrentSceneDocument,
  type SceneDocumentV4,
  type SceneDocumentV5,
} from '../api/types/semantic-scene';

function makeV4Document(): SceneDocumentV4 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V4,
    sceneId: 'scene-v4',
    meta: { title: 'V4' },
    statements: [],
  };
}

function makeV5Document(): SceneDocumentV5 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V5,
    sceneId: 'scene-v5',
    meta: { title: 'V5' },
    statements: [],
  };
}

function makeCurrentDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-current',
    meta: { title: 'Current' },
    statements: [],
  };
}

describe('scene document epoch vocabulary', () => {
  it('activates scene v5 as the product contract', () => {
    expect(SCENE_SCHEMA_VERSION_V4).toBe(4);
    expect(SCENE_SCHEMA_VERSION_V5).toBe(5);
    expect(SCENE_SCHEMA_VERSION).toBe(SCENE_SCHEMA_VERSION_V5);
  });

  it('treats current documents as the v5 contract', () => {
    const current = makeCurrentDocument();
    const canonical: SceneDocumentV5 = current;
    const roundTrip: CurrentSceneDocument = canonical;
    const v5 = makeV5Document();
    const currentFromV5: CurrentSceneDocument = v5;
    expect(roundTrip.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
    expect(currentFromV5.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
  });

  it('keeps historical scene v4 distinct from the active current document contract', () => {
    const v4 = makeV4Document();
    expect(v4.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V4);

    // @ts-expect-error - v4 is not the active current document now that the product loads v5
    const invalidCurrent: CurrentSceneDocument = v4;
    expect(invalidCurrent).toBeDefined();
  });
});

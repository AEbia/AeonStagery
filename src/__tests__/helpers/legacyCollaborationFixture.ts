import * as Y from 'yjs';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborativeSceneStateV3,
} from '../../api/types/collaboration';
import { SCENE_SCHEMA_VERSION_V5 } from '../../api/types/semantic-scene';
import {
  COLLABORATIVE_SCENE_ROOT,
  writeCollaborativeStateV3ToYDoc,
} from '../../services/collaboration/CollaborativeYDocStore';

export type LegacyCollaborationStateFixture = Omit<
  CollaborativeSceneStateV3,
  'schemaVersion' | 'sceneSchemaVersion'
> & { schemaVersion: 2; sceneSchemaVersion: 4 };

/** Old wire markers are fixtures for rejection tests, never a supported codec. */
export function writeLegacyCollaborationStateFixture(
  doc: Y.Doc,
  state: LegacyCollaborationStateFixture,
  origin?: string,
): void {
  writeCollaborativeStateV3ToYDoc(doc, {
    ...state,
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
  }, origin);
  const root = doc.getMap<unknown>(COLLABORATIVE_SCENE_ROOT);
  root.set('schemaVersion', state.schemaVersion);
  root.set('sceneSchemaVersion', state.sceneSchemaVersion);
}

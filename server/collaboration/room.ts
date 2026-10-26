import * as Y from 'yjs';
import { COLLABORATION_LIMITS, CollaborationRequestError } from './security';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborativeSceneStateV3,
} from '../../src/api/types/collaboration';
import {
  SCENE_SCHEMA_VERSION_V5,
  type SceneDocumentV5,
} from '../../src/api/types/semantic-scene';
import { materializeCollaborativeSceneDocumentV5 } from '../../src/services/collaboration/CollaborativeSceneStateV3';
import {
  hasCollaborativeStateV3,
  readCollaborativeSchemaVersions,
  readCollaborativeStateV3FromYDoc,
  writeCollaborativeStateV3ToYDoc,
} from '../../src/services/collaboration/CollaborativeYDocStore';
import { CollaborationPersistence } from './persistence';
export type CollaborativeStateValidatorV3 = (state: CollaborativeSceneStateV3) => Promise<void> | void;

export class CollaborationProjectMismatchError extends Error {}

export function assertCollaborationProjectId(actualProjectId: string, expectedProjectId?: string): void {
  if (expectedProjectId !== undefined && actualProjectId !== expectedProjectId) {
    throw new CollaborationProjectMismatchError(
      `Collaboration room project mismatch: expected "${expectedProjectId}", got "${actualProjectId}"`,
    );
  }
}

export function validateCollaborativeSceneCodecV3(state: CollaborativeSceneStateV3): void {
  materializeCollaborativeSceneDocumentV5(state);
}

export class SingleRoomCollaborationRoomV3 {
  private doc = new Y.Doc();
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: CollaborationPersistence) {}

  get ydoc(): Y.Doc {
    return this.doc;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await this.persistence.ensure();
    const probeDoc = new Y.Doc();
    try {
      if (await this.persistence.loadDoc(probeDoc)) {
        const versions = readCollaborativeSchemaVersions(probeDoc);
        if (
          (versions.sceneSchemaVersion !== null && versions.sceneSchemaVersion !== SCENE_SCHEMA_VERSION_V5) ||
          (versions.schemaVersion !== null && versions.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V3)
        ) {
          throw new Error(
            `Incompatible persisted room data: Collaboration room at "${this.persistence.paths.dataDir}" contains persisted collaboration schema version ${versions.schemaVersion ?? 'unknown'} (scene schema version ${versions.sceneSchemaVersion ?? 'unknown'}). Only collaboration v3 with scene v5 is supported. Export a scene snapshot with an older AeonStagery release, migrate it to scene v5, and seed a new room in a separate data directory.`,
          );
        }
        this.doc.destroy();
        this.doc = probeDoc;
      }
    } finally {
      if (this.doc !== probeDoc) probeDoc.destroy();
    }
    this.loaded = true;
  }

  hasState(): boolean {
    return hasCollaborativeStateV3(this.doc);
  }

  getState(): CollaborativeSceneStateV3 | null {
    return readCollaborativeStateV3FromYDoc(this.doc);
  }

  getMaterializedSceneDocument(): SceneDocumentV5 | null {
    const state = this.getState();
    return state ? materializeCollaborativeSceneDocumentV5(state) : null;
  }

  async seed(state: CollaborativeSceneStateV3): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.load();
      if (state.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V3) {
        throw new Error(`Collaboration room v3 expected schema version ${COLLABORATION_SCHEMA_VERSION_V3}`);
      }
      if (state.sceneSchemaVersion !== SCENE_SCHEMA_VERSION_V5) {
        throw new Error(`Collaboration room v3 expected scene schema version ${SCENE_SCHEMA_VERSION_V5}`);
      }
      validateCollaborativeSceneCodecV3(state);
      if (this.hasState() || await this.persistence.hasPersistedState()) {
        throw new Error('Collaboration room already has persisted state');
      }

      const nextDoc = new Y.Doc();
      try {
        writeCollaborativeStateV3ToYDoc(nextDoc, state, 'seed');
        const update = Y.encodeStateAsUpdate(nextDoc);
        if (update.byteLength > COLLABORATION_LIMITS.websocketBytes) {
          throw new CollaborationRequestError(413, 'Collaboration room state exceeds limit');
        }
        Y.applyUpdate(this.doc, update, 'seed');
      } finally { nextDoc.destroy(); }
      await this.flush();
    });
  }

  async applyUpdate(update: Uint8Array, validateState?: CollaborativeStateValidatorV3): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.load();
      const nextDoc = new Y.Doc();
      try {
        Y.applyUpdate(nextDoc, Y.encodeStateAsUpdate(this.doc));
        Y.applyUpdate(nextDoc, update);
        if (Y.encodeStateAsUpdate(nextDoc).byteLength > COLLABORATION_LIMITS.websocketBytes) {
          throw new CollaborationRequestError(413, 'Collaboration room state exceeds limit');
        }
        const nextState = readCollaborativeStateV3FromYDoc(nextDoc);
        if (!nextState) {
          throw new Error(`Collaboration update did not contain schema version ${COLLABORATION_SCHEMA_VERSION_V3} state`);
        }
        const currentState = this.getState();
        if (currentState && (nextState.collaborationProjectId !== currentState.collaborationProjectId
          || nextState.roomId !== currentState.roomId || nextState.sceneId !== currentState.sceneId)) {
          throw new CollaborationProjectMismatchError(
            `Collaboration room identity is immutable: expected project "${currentState.collaborationProjectId}", got "${nextState.collaborationProjectId}"`,
          );
        }
        if (validateState) await validateState(nextState);
        else validateCollaborativeSceneCodecV3(nextState);
      } finally {
        nextDoc.destroy();
      }

      Y.applyUpdate(this.doc, update);
      await this.flush();
    });
  }

  encodeStateAsUpdate(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  async flush(): Promise<void> {
    await this.persistence.saveDoc(this.doc);
    const state = this.getState();
    if (!state) return;
    await this.persistence.saveManifest(state.assets ?? {});
    await this.persistence.saveSnapshotV3(materializeCollaborativeSceneDocumentV5(state));
  }

  private enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }
}

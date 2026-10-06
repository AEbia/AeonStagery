import * as Y from 'yjs';
import { COLLABORATION_LIMITS, CollaborationRequestError } from './security';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborativeSceneStateV2,
  type CollaborativeSceneStateV3,
} from '../../src/api/types/collaboration';
import {
  SCENE_SCHEMA_VERSION_V4,
  SCENE_SCHEMA_VERSION_V5,
  type HistoricalSceneDocumentV4,
  type SceneDocumentV5,
} from '../../src/api/types/semantic-scene';
import { materializeCollaborativeSceneDocumentV4 } from '../../src/services/collaboration/CollaborativeSceneStateV2';
import { materializeCollaborativeSceneDocumentV5 } from '../../src/services/collaboration/CollaborativeSceneStateV3';
import {
  hasCollaborativeStateV2,
  hasCollaborativeStateV3,
  readCollaborativeSchemaVersions,
  readCollaborativeStateV2FromYDoc,
  readCollaborativeStateV3FromYDoc,
  writeCollaborativeStateV2ToYDoc,
  writeCollaborativeStateV3ToYDoc,
} from '../../src/services/collaboration/CollaborativeYDocStore';
import { sceneDocumentCodec } from '../../src/services/semantic-scene';
import { CollaborationPersistence } from './persistence';

export type CollaborativeStateValidatorV2 = (state: CollaborativeSceneStateV2) => Promise<void> | void;
export type CollaborativeStateValidatorV3 = (state: CollaborativeSceneStateV3) => Promise<void> | void;

export class CollaborationProjectMismatchError extends Error {}

export function assertCollaborationProjectId(actualProjectId: string, expectedProjectId?: string): void {
  if (expectedProjectId !== undefined && actualProjectId !== expectedProjectId) {
    throw new CollaborationProjectMismatchError(
      `Collaboration room project mismatch: expected "${expectedProjectId}", got "${actualProjectId}"`,
    );
  }
}

/** Validate the materialized semantic document at the server boundary. This
 * includes custom-motion keyframe contracts, so binary Yjs updates cannot
 * bypass the client command validator. */
export function validateCollaborativeSceneCodecV2(state: CollaborativeSceneStateV2): void {
  sceneDocumentCodec.parseAndValidate(materializeCollaborativeSceneDocumentV4(state));
}

export function validateCollaborativeSceneCodecV3(state: CollaborativeSceneStateV3): void {
  materializeCollaborativeSceneDocumentV5(state);
}

export class SingleRoomCollaborationRoomV2 {
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
        if (versions.schemaVersion !== null && versions.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V2) {
          throw new Error(
            `Collaboration room at "${this.persistence.paths.dataDir}" contains persisted schema version ${versions.schemaVersion}; room v2 expected schema version ${COLLABORATION_SCHEMA_VERSION_V2}`,
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
    return hasCollaborativeStateV2(this.doc);
  }

  getState(): CollaborativeSceneStateV2 | null {
    return readCollaborativeStateV2FromYDoc(this.doc);
  }

  getMaterializedSceneDocument(): HistoricalSceneDocumentV4 | null {
    const state = this.getState();
    return state ? materializeCollaborativeSceneDocumentV4(state) : null;
  }

  async seed(state: CollaborativeSceneStateV2): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.load();
      if (state.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V2) {
        throw new Error(`Collaboration room v2 expected schema version ${COLLABORATION_SCHEMA_VERSION_V2}`);
      }
      if (state.sceneSchemaVersion !== SCENE_SCHEMA_VERSION_V4) {
        throw new Error(`Collaboration room v2 expected scene schema version ${SCENE_SCHEMA_VERSION_V4}`);
      }
      validateCollaborativeSceneCodecV2(state);
      if (this.hasState() || await this.persistence.hasPersistedState()) {
        throw new Error('Collaboration room already has persisted state');
      }

      const nextDoc = new Y.Doc();
      try {
        writeCollaborativeStateV2ToYDoc(nextDoc, state, 'seed');
        const update = Y.encodeStateAsUpdate(nextDoc);
        if (update.byteLength > COLLABORATION_LIMITS.websocketBytes) {
          throw new CollaborationRequestError(413, 'Collaboration room state exceeds limit');
        }
        Y.applyUpdate(this.doc, update, 'seed');
      } finally { nextDoc.destroy(); }
      await this.flush();
    });
  }

  async applyUpdate(update: Uint8Array, validateState?: CollaborativeStateValidatorV2): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.load();
      const nextDoc = new Y.Doc();
      try {
        Y.applyUpdate(nextDoc, Y.encodeStateAsUpdate(this.doc));
        Y.applyUpdate(nextDoc, update);
        if (Y.encodeStateAsUpdate(nextDoc).byteLength > COLLABORATION_LIMITS.websocketBytes) {
          throw new CollaborationRequestError(413, 'Collaboration room state exceeds limit');
        }
        const nextState = readCollaborativeStateV2FromYDoc(nextDoc);
        if (!nextState) {
          throw new Error(`Collaboration update did not contain schema version ${COLLABORATION_SCHEMA_VERSION_V2} state`);
        }
        const currentState = this.getState();
        if (currentState && (nextState.collaborationProjectId !== currentState.collaborationProjectId
          || nextState.roomId !== currentState.roomId || nextState.sceneId !== currentState.sceneId)) {
          throw new CollaborationProjectMismatchError(
            `Collaboration room identity is immutable: expected project "${currentState.collaborationProjectId}", got "${nextState.collaborationProjectId}"`,
          );
        }
        if (validateState) await validateState(nextState);
        else validateCollaborativeSceneCodecV2(nextState);
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
    await this.persistence.saveSnapshotV2(materializeCollaborativeSceneDocumentV4(state));
  }

  private enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }
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
          versions.schemaVersion === COLLABORATION_SCHEMA_VERSION_V2 ||
          versions.sceneSchemaVersion === SCENE_SCHEMA_VERSION_V4 ||
          (versions.schemaVersion !== null && versions.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V3)
        ) {
          throw new Error(
            `Incompatible persisted room data: Collaboration room at "${this.persistence.paths.dataDir}" contains persisted collaboration schema version ${versions.schemaVersion ?? 'unknown'} (scene schema version ${versions.sceneSchemaVersion ?? 'unknown'}). Collaboration v3 servers do not migrate persisted v2 rooms in place. To upgrade, export a scene v4 snapshot using the v2 collaboration server, migrate the snapshot from scene v4 to v5, and seed a new v3 collaboration room.`,
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

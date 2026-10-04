import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import type { CollaborativeAssetManifest } from '../../src/api/types/collaboration';
import type { HistoricalSceneDocumentV4, SceneDocumentV5 } from '../../src/api/types/semantic-scene';

const STATE_FILE = 'room-state.bin';
const MANIFEST_FILE = 'asset-manifest.json';
const SNAPSHOT_FILE = 'scene-snapshot.json';

export interface CollaborationPersistencePaths {
  dataDir: string;
  stateFile: string;
  manifestFile: string;
  snapshotFile: string;
}

export class CollaborationPersistence {
  readonly paths: CollaborationPersistencePaths;

  constructor(dataDir: string) {
    const resolvedDataDir = path.resolve(dataDir);
    this.paths = {
      dataDir: resolvedDataDir,
      stateFile: path.join(resolvedDataDir, STATE_FILE),
      manifestFile: path.join(resolvedDataDir, MANIFEST_FILE),
      snapshotFile: path.join(resolvedDataDir, SNAPSHOT_FILE),
    };
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.paths.dataDir, { recursive: true });
  }

  async hasPersistedState(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.paths.stateFile);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  async loadDoc(doc: Y.Doc): Promise<boolean> {
    if (!(await this.hasPersistedState())) return false;
    const data = await fs.readFile(this.paths.stateFile);
    Y.applyUpdate(doc, new Uint8Array(data));
    return true;
  }

  async saveDoc(doc: Y.Doc): Promise<void> {
    await this.ensure();
    const update = Y.encodeStateAsUpdate(doc);
    await fs.writeFile(this.paths.stateFile, Buffer.from(update));
  }

  async loadManifest(): Promise<CollaborativeAssetManifest> {
    try {
      const raw = await fs.readFile(this.paths.manifestFile, 'utf8');
      return JSON.parse(raw) as CollaborativeAssetManifest;
    } catch {
      return {};
    }
  }

  async saveManifest(manifest: CollaborativeAssetManifest): Promise<void> {
    await this.ensure();
    await fs.writeFile(this.paths.manifestFile, JSON.stringify(manifest, null, 2));
  }

  async loadSnapshotV2(): Promise<HistoricalSceneDocumentV4 | null> {
    try {
      const raw = await fs.readFile(this.paths.snapshotFile, 'utf8');
      return JSON.parse(raw) as HistoricalSceneDocumentV4;
    } catch {
      return null;
    }
  }

  async saveSnapshotV2(document: HistoricalSceneDocumentV4): Promise<void> {
    await this.ensure();
    await fs.writeFile(this.paths.snapshotFile, JSON.stringify(document, null, 2));
  }

  async loadSnapshotV3(): Promise<SceneDocumentV5 | null> {
    try {
      const raw = await fs.readFile(this.paths.snapshotFile, 'utf8');
      return JSON.parse(raw) as SceneDocumentV5;
    } catch {
      return null;
    }
  }

  async saveSnapshotV3(document: SceneDocumentV5): Promise<void> {
    await this.ensure();
    await fs.writeFile(this.paths.snapshotFile, JSON.stringify(document, null, 2));
  }
}

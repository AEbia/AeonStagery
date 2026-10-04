import type {
  ProjectCompatibilityEnvelope,
  ProjectCompatibilitySceneEntry,
  ProjectMetadata,
  ProjectSceneEntry,
} from '../../api/types/project';
import {
  PROJECT_COMPATIBILITY_ENVELOPE_FILE_NAME,
  PROJECT_COMPATIBILITY_ENVELOPE_SCHEMA_VERSION,
} from '../../api/types/project';
import { CompatibleSceneSession } from '../semantic-scene/CompatibleSceneSession';
import { ProjectPathResolver } from '../io/ProjectPathResolver';

export interface EnvelopeFileAccess {
  readFile(path: string): Promise<{ data: string; path: string }>;
  writeFile(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  join(...parts: string[]): Promise<string>;
  dirname(path: string): Promise<string>;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function calculateSourceHash(content: string | Uint8Array): Promise<string> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `sha256:${hex}`;
  }
  let hash = 0;
  for (let i = 0; i < bytes.length; i++) {
    hash = (Math.imul(31, hash) + bytes[i]) | 0;
  }
  return `sha256:${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

export class ProjectCompatibilityEnvelopeService {
  private readonly resolver: ProjectPathResolver;

  constructor(
    private readonly fileAccess: EnvelopeFileAccess,
    resolver?: ProjectPathResolver,
  ) {
    this.resolver = resolver ?? new ProjectPathResolver((window as any).aeonStageryAPI);
  }

  async buildSceneEntry(
    projectRoot: string,
    scene: ProjectSceneEntry,
  ): Promise<ProjectCompatibilitySceneEntry> {
    const fullPath = await this.resolver.resolveAbsolute(projectRoot, scene.path);
    const fileExists = await this.fileAccess.exists(fullPath);

    if (!fileExists) {
      return {
        path: scene.path,
        sceneSchemaVersion: 0,
        sourceHash: '',
        hasUnknownFields: false,
      };
    }

    try {
      const { data } = await this.fileAccess.readFile(fullPath);
      const sourceHash = await calculateSourceHash(data);

      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        return {
          path: scene.path,
          sceneSchemaVersion: 0,
          sourceHash,
          hasUnknownFields: false,
        };
      }

      const sceneSchemaVersion =
        typeof parsed?.schemaVersion === 'number' && Number.isInteger(parsed.schemaVersion)
          ? parsed.schemaVersion
          : 0;
      const hasUnknownFields = CompatibleSceneSession.detectUnknownFields(parsed);

      return {
        path: scene.path,
        sceneSchemaVersion,
        sourceHash,
        hasUnknownFields,
      };
    } catch {
      return {
        path: scene.path,
        sceneSchemaVersion: 0,
        sourceHash: '',
        hasUnknownFields: false,
      };
    }
  }

  async buildEnvelope(
    projectRoot: string,
    projectMetadata: ProjectMetadata,
  ): Promise<ProjectCompatibilityEnvelope> {
    const sceneEntries = projectMetadata.scenes ?? [];
    const scenes: ProjectCompatibilitySceneEntry[] = [];

    for (const scene of sceneEntries) {
      const entry = await this.buildSceneEntry(projectRoot, scene);
      scenes.push(entry);
    }

    return {
      schemaVersion: PROJECT_COMPATIBILITY_ENVELOPE_SCHEMA_VERSION,
      scenes,
    };
  }

  validateEnvelope(
    persistedEnvelope: unknown,
    sceneFacts: readonly ProjectCompatibilitySceneEntry[],
  ): boolean {
    if (!this.isWellFormedEnvelope(persistedEnvelope)) {
      return false;
    }

    if (persistedEnvelope.scenes.length !== sceneFacts.length) {
      return false;
    }

    for (let i = 0; i < sceneFacts.length; i++) {
      const fact = sceneFacts[i];
      const persisted =
        persistedEnvelope.scenes.find((s) => s.path === fact.path) ??
        persistedEnvelope.scenes[i];
      if (!persisted) return false;

      if (
        persisted.path !== fact.path ||
        persisted.sceneSchemaVersion !== fact.sceneSchemaVersion ||
        persisted.sourceHash !== fact.sourceHash ||
        persisted.hasUnknownFields !== fact.hasUnknownFields
      ) {
        return false;
      }
    }

    return true;
  }

  isWellFormedEnvelope(input: unknown): input is ProjectCompatibilityEnvelope {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return false;
    }
    const record = input as Record<string, unknown>;
    if (record.schemaVersion !== PROJECT_COMPATIBILITY_ENVELOPE_SCHEMA_VERSION) {
      return false;
    }
    if (!Array.isArray(record.scenes)) {
      return false;
    }
    for (const entry of record.scenes) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return false;
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.path !== 'string' || !e.path.trim()) {
        return false;
      }
      if (
        typeof e.sceneSchemaVersion !== 'number' ||
        !Number.isInteger(e.sceneSchemaVersion) ||
        e.sceneSchemaVersion < 0
      ) {
        return false;
      }
      if (typeof e.sourceHash !== 'string') {
        return false;
      }
      if (typeof e.hasUnknownFields !== 'boolean') {
        return false;
      }
    }
    return true;
  }

  async loadOrRebuildEnvelope(
    projectRoot: string,
    projectMetadata: ProjectMetadata,
  ): Promise<{ envelope: ProjectCompatibilityEnvelope; isRebuilt: boolean }> {
    const envelopePath = await this.fileAccess.join(
      projectRoot,
      PROJECT_COMPATIBILITY_ENVELOPE_FILE_NAME,
    );
    const exists = await this.fileAccess.exists(envelopePath);

    if (!exists) {
      const freshEnvelope = await this.buildEnvelope(projectRoot, projectMetadata);
      return { envelope: freshEnvelope, isRebuilt: true };
    }

    let parsed: unknown;
    try {
      const raw = await this.fileAccess.readFile(envelopePath);
      parsed = JSON.parse(raw.data);
    } catch {
      const freshEnvelope = await this.buildEnvelope(projectRoot, projectMetadata);
      return { envelope: freshEnvelope, isRebuilt: true };
    }

    const freshEnvelope = await this.buildEnvelope(projectRoot, projectMetadata);
    const isFresh = this.validateEnvelope(parsed, freshEnvelope.scenes);

    if (isFresh && this.isWellFormedEnvelope(parsed)) {
      return { envelope: parsed, isRebuilt: false };
    }

    return { envelope: freshEnvelope, isRebuilt: true };
  }

  async writeEnvelope(
    projectRoot: string,
    envelope: ProjectCompatibilityEnvelope,
  ): Promise<void> {
    const envelopePath = await this.fileAccess.join(
      projectRoot,
      PROJECT_COMPATIBILITY_ENVELOPE_FILE_NAME,
    );
    await this.fileAccess.writeFile(envelopePath, JSON.stringify(envelope, null, 2));
  }
}

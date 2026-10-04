import type {
  ArtifactCompatibilityAdapter,
  CompatibilityOutcome,
} from './types';
import {
  CompatibleSceneSession,
} from '../semantic-scene/CompatibleSceneSession';
import {
  SceneDocumentCodec,
  sceneDocumentCodec,
} from '../semantic-scene/SceneDocumentCodec';
import type { SceneDocumentV5 } from '../../api/types/semantic-scene';

export class SceneArtifactCompatibilityAdapter
  implements ArtifactCompatibilityAdapter<unknown, SceneDocumentV5, CompatibleSceneSession>
{
  readonly artifactKind = 'scene';
  readonly migrationPolicy = 'gated' as const;
  private readonly codec: SceneDocumentCodec;

  constructor(codec: SceneDocumentCodec = sceneDocumentCodec) {
    this.codec = codec;
  }

  inspect(input: unknown): CompatibilityOutcome<CompatibleSceneSession> {
    return CompatibleSceneSession.open(input, this.codec);
  }

  serialize(session: CompatibleSceneSession): unknown {
    return session.serialize();
  }

  parseProjection(source: unknown): SceneDocumentV5 {
    return this.codec.parseKnownProjection(source as any) as any;
  }

  resolveBackupRelativePath(_artifactPath: string, now: Date, basename: string): string {
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    return `.aeonstagery/backups/${timestamp}/${basename}`;
  }

  createInvalidIssue(message: string) {
    return {
      code: 'malformed_scene',
      message: message.includes('File does not exist') ? `Scene file does not exist at ${_extractPath(message)}` : message,
    };
  }
}

function _extractPath(message: string): string {
  const match = message.match(/at (.*)$/);
  return match ? match[1] : '';
}

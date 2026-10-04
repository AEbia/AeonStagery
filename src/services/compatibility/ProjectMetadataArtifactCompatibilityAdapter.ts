import type {
  ArtifactCompatibilityAdapter,
  CompatibilityOutcome,
} from './types';
import {
  CompatibleProjectSession,
} from '../project/CompatibleProjectSession';
import {
  ProjectMetadataCodec,
  projectMetadataCodec,
} from '../project/ProjectMetadataCodec';
import type { ProjectMetadataV2 } from '../../api/types/project';

export class ProjectMetadataArtifactCompatibilityAdapter
  implements ArtifactCompatibilityAdapter<unknown, ProjectMetadataV2, CompatibleProjectSession>
{
  readonly artifactKind = 'project_metadata';
  readonly migrationPolicy = 'automatic' as const;
  private readonly codec: ProjectMetadataCodec;

  constructor(codec: ProjectMetadataCodec = projectMetadataCodec) {
    this.codec = codec;
  }

  inspect(input: unknown): CompatibilityOutcome<CompatibleProjectSession> {
    return CompatibleProjectSession.open(input, this.codec);
  }

  serialize(session: CompatibleProjectSession): unknown {
    return session.serialize();
  }

  parseProjection(source: unknown): ProjectMetadataV2 {
    return this.codec.parseKnownProjection(source);
  }

  createInvalidIssue(message: string) {
    return {
      code: 'malformed_metadata',
      message: message.toLowerCase().includes('invalid json')
        ? `Failed to parse project metadata: invalid JSON`
        : message,
    };
  }
}

import {
  AUTHORING_SCHEMA_VERSION,
  type SemanticAuthorReceipt,
} from '../../api/types/authoring';
import type { SceneStatement } from '../../api/types/semantic-scene';
import type { SemanticDocumentCoordinator } from '../document/SemanticDocumentCoordinator';
import type { SemanticAuthoringApplicationService } from '../timeline-authoring/SemanticAuthoringApplicationService';

export class SemanticRawScriptService {
  constructor(
    private readonly coordinator: SemanticDocumentCoordinator,
    private readonly authoring: SemanticAuthoringApplicationService,
  ) {}

  async replaceRawJson(rawJson: string, path?: string): Promise<void> {
    await this.coordinator.applyRawJson(rawJson, path);
  }

  patchStatement(
    statementId: string,
    patch: Partial<SceneStatement>,
    correlationId = createCorrelationId(),
  ): Promise<SemanticAuthorReceipt> {
    return this.authoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId,
      origin: 'raw-script',
      kind: 'update-statement',
      statementId,
      patch,
    });
  }
}

function createCorrelationId(): string {
  return globalThis.crypto?.randomUUID
    ? `raw-script_${globalThis.crypto.randomUUID()}`
    : `raw-script_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

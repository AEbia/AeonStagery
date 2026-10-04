import type {
  CurrentSceneDocument,
  SemanticSceneBundle,
} from '../../api/types/semantic-scene';
import {
  RuntimeAssetPreparer,
  type RuntimeAssetResolver,
} from './RuntimeAssetPreparer';
import { SceneDocumentCodec, sceneDocumentCodec } from './SceneDocumentCodec';
import { SceneStatementCompiler, sceneStatementCompiler } from './SceneStatementCompiler';
import {
  getSceneDocumentCanonicalOrder,
  withSceneDocumentCanonicalOrder,
} from './SceneDocumentCanonicalOrder';

export type SemanticSourceReadiness = (
  document: CurrentSceneDocument,
) => CurrentSceneDocument | Promise<CurrentSceneDocument>;

export interface SemanticScenePipelineOptions {
  readonly resolveAsset: RuntimeAssetResolver;
  readonly prepareSource?: SemanticSourceReadiness;
  readonly codec?: SceneDocumentCodec;
  readonly compiler?: SceneStatementCompiler;
}

export class SemanticScenePipeline {
  private readonly codec: SceneDocumentCodec;
  private readonly compiler: SceneStatementCompiler;
  private readonly runtimeAssetPreparer: RuntimeAssetPreparer;
  private readonly prepareSource?: SemanticSourceReadiness;

  constructor(options: SemanticScenePipelineOptions) {
    this.codec = options.codec ?? sceneDocumentCodec;
    this.compiler = options.compiler ?? sceneStatementCompiler;
    this.runtimeAssetPreparer = new RuntimeAssetPreparer({
      resolveAsset: options.resolveAsset,
    });
    this.prepareSource = options.prepareSource;
  }

  async processRawJson(rawJson: string): Promise<SemanticSceneBundle> {
    return this.processDocument(JSON.parse(rawJson));
  }

  async processDocument(input: unknown): Promise<SemanticSceneBundle> {
    const canonicalOrder = getSceneDocumentCanonicalOrder(
      isSceneDocumentLike(input) ? input : undefined,
    );
    const parsed = this.codec.parseAndValidate(input);
    const validatedSource = this.codec.parseAndValidate(
      this.prepareSource ? await this.prepareSource(parsed) : parsed,
    );
    const source = canonicalOrder
      ? withSceneDocumentCanonicalOrder(validatedSource, canonicalOrder)
      : validatedSource;
    const compiled = this.compiler.compile(source);
    const prepared = await this.runtimeAssetPreparer.prepare(compiled);
    return Object.freeze({ source, compiled, prepared });
  }
}

function isSceneDocumentLike(input: unknown): input is CurrentSceneDocument {
  return typeof input === 'object' && input !== null;
}

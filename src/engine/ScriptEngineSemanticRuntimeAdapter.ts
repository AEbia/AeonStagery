import type { PreparedCompiledScene } from '../api/types/semantic-scene';
import type ScriptEngine from './ScriptEngine';
import type {
  ProjectionDurationSink,
  SemanticDocumentProjectionRuntimePort,
} from '../services/document/DocumentProjectionPorts';

export class ScriptEngineSemanticRuntimeAdapter implements SemanticDocumentProjectionRuntimePort {
  constructor(private readonly getScriptEngine: () => ScriptEngine | undefined) {}

  async projectPreparedScene(scene: PreparedCompiledScene): Promise<void> {
    await this.getScriptEngine()?.loadPreparedScene(scene);
  }
}

export class PlaybackStoreDurationSink implements ProjectionDurationSink {
  constructor(private readonly applyDuration: (duration: number) => void) {}

  setDuration(duration: number): void {
    this.applyDuration(duration);
  }
}

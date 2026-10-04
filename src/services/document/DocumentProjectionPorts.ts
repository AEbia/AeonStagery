import type { PreparedCompiledScene } from '../../api/types/semantic-scene';
import type { SaveStatus } from '../../ui/store/EditorStore';

export interface DocumentFilePathPort {
  setFilePath(path: string | null): void;
}

export interface EditorSaveStatusPort {
  setSaveStatus(status: SaveStatus): void;
}

export interface SemanticDocumentProjectionRuntimePort {
  projectPreparedScene(scene: PreparedCompiledScene): Promise<void>;
}

export interface ProjectionDurationSink {
  setDuration(duration: number): void;
}

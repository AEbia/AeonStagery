import type { ExportConfig, ExportProgress, ExportResult } from '../types/export';

export interface IExportAdapter {
  export(config: ExportConfig, onProgress: (p: ExportProgress) => void, signal?: AbortSignal): Promise<ExportResult>;
}

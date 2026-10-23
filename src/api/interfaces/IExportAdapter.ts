import type { ExportConfig, ExportProgress, ExportResult } from '../types/export';
import type { ExportSizeEstimate, ExportSizeEstimateConfig } from '../exportSizeEstimate';

export interface IExportAdapter {
  estimateSize(config: ExportSizeEstimateConfig, signal?: AbortSignal): Promise<ExportSizeEstimate>;
  export(config: ExportConfig, onProgress: (p: ExportProgress) => void, signal?: AbortSignal): Promise<ExportResult>;
}

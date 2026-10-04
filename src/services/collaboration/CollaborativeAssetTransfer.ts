export interface CollaborativeAssetTransferProgress {
  currentFilePath?: string;
  currentFileBytes: number;
  currentFileSizeBytes: number;
  completedFiles: number;
  totalFiles: number;
  completedBytes: number;
  totalBytes: number;
}

export interface CollaborativeAssetFileTransferProgress {
  loadedBytes: number;
  totalBytes: number;
}

export interface CollaborativeAssetFileTransferOptions {
  signal?: AbortSignal;
  totalBytes?: number;
  onProgress?: (progress: CollaborativeAssetFileTransferProgress) => void;
}

export interface CollaborativeAssetTransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: CollaborativeAssetTransferProgress) => void;
}

export function throwIfTransferAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('已取消协作资源传输');
  error.name = 'AbortError';
  throw error;
}

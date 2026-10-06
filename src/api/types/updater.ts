export type UpdateSource = 'oss' | 'github';

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  source: UpdateSource;
  version?: string;
  releaseDate?: string;
  notes?: unknown;
  percent?: number;
  message?: string;
  fallbackFrom?: UpdateSource;
}

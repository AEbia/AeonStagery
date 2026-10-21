import { useCallback, useEffect, useRef, useState } from 'react';
import { planExportSizeSamples, type ExportSizeEstimate, type ExportSizeEstimateConfig } from '../../api/exportSizeEstimate';
import type { IExportAdapter } from '../../api/interfaces/IExportAdapter';

export const EXPORT_SIZE_ESTIMATE_DELAY_MS = 600;

/** Debounce settled edits, pause during dragging, and serialize stage restoration. */
export function useExportSizeEstimate(config: ExportSizeEstimateConfig, enabled: boolean, adapter: IExportAdapter, paused = false) {
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const activeRef = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);
  const timerRef = useRef<number>();
  const [result, setResult] = useState<{
    config: ExportSizeEstimateConfig;
    estimate: ExportSizeEstimate | null;
    error?: string;
  } | null>(null);

  const stop = useCallback(async () => {
    window.clearTimeout(timerRef.current);
    const active = activeRef.current;
    active?.controller.abort();
    await active?.promise;
  }, []);

  useEffect(() => {
    if (!enabled || paused) return;
    const controller = new AbortController();
    timerRef.current = window.setTimeout(() => {
      const previous = activeRef.current;
      const promise = (async () => {
        try {
          await previous?.promise;
          controller.signal.throwIfAborted();
          if (!planExportSizeSamples(config).length) {
            setResult({ config, estimate: null, error: '请先设置有效的导出规格和时间范围' });
            return;
          }
          const estimate = await adapterRef.current.estimateSize(config, controller.signal);
          if (!controller.signal.aborted) setResult({ config, estimate });
        } catch (error: unknown) {
          if (!controller.signal.aborted) setResult({ config, estimate: null, error: error instanceof Error ? error.message : String(error) });
        }
      })();
      activeRef.current = { controller, promise };
    }, EXPORT_SIZE_ESTIMATE_DELAY_MS);
    return () => {
      window.clearTimeout(timerRef.current);
      controller.abort();
    };
  }, [config, enabled, paused]);

  const current = result?.config === config ? result : null;
  return { pending: enabled && !current, estimate: enabled ? current?.estimate ?? null : null, error: current?.error, stop };
}

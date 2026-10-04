/**
 * Global Error Boundary & Crash Interceptor
 * Implements ADR-0032
 */

import React from 'react';
import type { CrashReport, CrashSurface } from '../api/types/crash';
import { buildCrashReport } from '../services/crash/CrashReporter';
import { registerManualCrashHandler, type ManualCrashOptions } from '../services/crash/manualCrash';
import { CrashScreen } from './CrashScreen';

export interface GlobalErrorBoundaryProps {
  children: React.ReactNode;
  surface?: CrashSurface;
  isDev?: boolean;
}

interface GlobalErrorBoundaryState {
  hasError: boolean;
  report: CrashReport | null;
}

export class GlobalErrorBoundary extends React.Component<
  GlobalErrorBoundaryProps,
  GlobalErrorBoundaryState
> {
  private unregisterManualCrash: () => void;

  constructor(props: GlobalErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, report: null };
    this.unregisterManualCrash = registerManualCrashHandler(this.handleManualCrash.bind(this));
  }

  /**
   * Shows the crash recovery screen on demand (debug chord / console trigger).
   * Reuses the same report pipeline and IPC persistence as real React crashes.
   */
  private handleManualCrash(options: ManualCrashOptions): void {
    const error = new Error(options.reason ?? '手动崩溃（调试触发）');
    error.name = 'ManualCrash';

    const report = buildCrashReport({
      error,
      tier: options.tier ?? 1,
      surface: options.surface ?? this.props.surface ?? 'editor',
    });

    this.setState({ hasError: true, report });

    const api = (window as unknown as { aeonStageryAPI?: any }).aeonStageryAPI;
    if (api?.crash?.record) {
      api.crash.record(report).catch((err: unknown) => {
        console.error('[AeonStagery] Failed to record manual crash via IPC:', err);
      });
    }
  }

  componentWillUnmount(): void {
    this.unregisterManualCrash?.();
  }

  static getDerivedStateFromError(error: Error): Partial<GlobalErrorBoundaryState> {
    return {
      hasError: true,
      report: buildCrashReport({ error, tier: 1 }),
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[AeonStagery] React rendering crash caught:', error, errorInfo);

    const report = buildCrashReport({
      error,
      tier: 1,
      surface: this.props.surface || 'editor',
      componentStack: errorInfo.componentStack || undefined,
    });

    this.setState({ report });

    // Automatically persist report in background via IPC if available
    const api = (window as any).aeonStageryAPI;
    if (api?.crash?.record) {
      api.crash.record(report).catch((err: any) => {
        console.error('[AeonStagery] Failed to record crash via IPC:', err);
      });
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError && this.state.report) {
      return (
        <CrashScreen
          report={this.state.report}
          isDev={this.props.isDev}
        />
      );
    }
    return this.props.children;
  }
}

/**
 * Attaches global window error and unhandled promise rejection listeners (Tier 2)
 */
export function setupGlobalCrashHandlers(surface: CrashSurface = 'renderer-global'): () => void {
  if (typeof window === 'undefined') return () => {};

  const errorHandler = (event: ErrorEvent) => {
    try {
      const report = buildCrashReport({
        error: event.error || event.message || 'Unknown window error',
        tier: 2,
        surface,
      });
      const api = (window as any).aeonStageryAPI;
      if (api?.crash?.record) {
        api.crash.record(report);
      }
    } catch {
      // Must not throw in global error handler
    }
  };

  const rejectionHandler = (event: PromiseRejectionEvent) => {
    try {
      const report = buildCrashReport({
        error: event.reason || 'Unhandled Promise Rejection',
        tier: 2,
        surface,
      });
      const api = (window as any).aeonStageryAPI;
      if (api?.crash?.record) {
        api.crash.record(report);
      }
    } catch {
      // Must not throw in global error handler
    }
  };

  window.addEventListener('error', errorHandler);
  window.addEventListener('unhandledrejection', rejectionHandler);

  return () => {
    window.removeEventListener('error', errorHandler);
    window.removeEventListener('unhandledrejection', rejectionHandler);
  };
}

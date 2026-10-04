import ReactDOM from 'react-dom/client';
import 'pixi.js/unsafe-eval';
import App from './App';
import { AgentWindow } from './AgentWindow';
import { WorkspaceToolsWindow } from './WorkspaceToolsWindow';
import { GlobalErrorBoundary, setupGlobalCrashHandlers } from './ui/GlobalErrorBoundary';
import { installManualCrashHotkey } from './services/crash/manualCrash';
import { setCrashEnvironmentOverride } from './services/crash/CrashReporter';
import type { CrashSurface } from './api/types/crash';
import { seekProfiler } from './engine/SeekProfiler';
import { motionCurveCache } from './engine/live2d/motionCurveCache';
import { initLive2DRuntimeAvailability } from './engine/Live2DRuntimeAvailability';
import './index.css';

console.log('[AeonStagery] Starting application...');

// Wire runtime-family availability probes (main-process seed report + the
// live2d-runtime-bootstrap-complete event). Detection is passive: it only
// flips resolver flags, and missing runtimes surface when a model loads.
initLive2DRuntimeAvailability();

// Seek phase profiling is on by default in dev builds so the editor console
// shows one `engine:seek:report`-style line per seek — `forward=`/`motionStep=`
// drop to ~0 once the resource motion curve cache covers the characters.
// `window.__AEON_SEEK_PROFILER = true|false` overrides on the next seek
// (packaged builds can opt in the same way). The curve cache is exposed for
// console inspection (size / keys / invalidate / clear).
if (import.meta.env.DEV && typeof window !== 'undefined') {
  if ((window as any).__AEON_SEEK_PROFILER !== false) seekProfiler.setEnabled(true);
  (window as any).__AEON_MOTION_CURVE_CACHE = motionCurveCache;
}

const surfaceParam = new URLSearchParams(window.location.search).get('surface');
const currentSurface: CrashSurface =
  surfaceParam === 'workspace-tools'
    ? 'workspace-tools'
    : surfaceParam === 'agent'
    ? 'agent'
    : 'editor';

// Attach Tier 2 global error listeners
setupGlobalCrashHandlers(currentSurface);

// DEV-only manual crash hotkey (F3 + C) for debugging the recovery flow.
installManualCrashHotkey();

// Pull real environment metadata from the main process so crash reports are
// not full of "unknown" fields.
const crashApi = (window as unknown as { aeonStageryAPI?: any }).aeonStageryAPI?.crash;
if (crashApi?.getEnvironment) {
  crashApi.getEnvironment()
    .then((env: Partial<import('./api/types/crash').CrashEnvironmentInfo>) => setCrashEnvironmentOverride(env))
    .catch(() => {});
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <GlobalErrorBoundary surface={currentSurface} isDev={import.meta.env.DEV}>
    {currentSurface === 'workspace-tools' ? (
      <WorkspaceToolsWindow />
    ) : currentSurface === 'agent' ? (
      <AgentWindow />
    ) : (
      <App />
    )}
  </GlobalErrorBoundary>
);

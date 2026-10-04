/**
 * Manual crash trigger for debugging (ADR-0032 extension).
 *
 * Lets a developer force the crash recovery screen (CrashScreen) with a real
 * diagnostic report via a keyboard chord (hold F3, then press C) or a console
 * escape hatch (`window.__AEON_TRIGGER_CRASH()`). The screen, report and
 * persistence path are identical to real crashes so the recovery flow itself
 * can be exercised.
 *
 * The hotkey is only installed in DEV builds (see installManualCrashHotkey).
 */

import type { CrashSurface, CrashTier } from '../../api/types/crash';

export interface ManualCrashOptions {
  reason?: string;
  tier?: CrashTier;
  surface?: CrashSurface;
}

type ManualCrashHandler = (options: ManualCrashOptions) => void;

let registeredHandler: ManualCrashHandler | null = null;

/**
 * Registered by GlobalErrorBoundary so the crash screen can be shown on demand.
 * Returns an unregister function for balanced lifecycle management.
 */
export function registerManualCrashHandler(handler: ManualCrashHandler): () => void {
  registeredHandler = handler;
  return () => {
    if (registeredHandler === handler) registeredHandler = null;
  };
}

/** Force the crash recovery screen. No-op if no surface has registered a handler. */
export function triggerManualCrash(options: ManualCrashOptions = {}): void {
  if (registeredHandler) registeredHandler(options);
}

const F3_CODE = 'F3';
const C_CODE = 'KeyC';
const HELD_KEYS = new Set<string>();

function isDevBuild(): boolean {
  return typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
}

/**
 * Installs the F3 + C chord hotkey. DEV-only: returns a no-op cleanup in
 * production builds so packaged apps are never affected.
 *
 * Chord: hold F3, then press C.
 */
export function installManualCrashHotkey(): () => void {
  if (typeof window === 'undefined' || !isDevBuild()) return () => {};

  const onKeyDown = (event: KeyboardEvent) => {
    HELD_KEYS.add(event.code);
    const f3Held = HELD_KEYS.has(F3_CODE);
    const cPressed = event.code === C_CODE || event.key === 'c' || event.key === 'C';
    if (f3Held && cPressed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      triggerManualCrash({ reason: '手动崩溃（调试）：长按 F3 后按 C' });
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    HELD_KEYS.delete(event.code);
  };

  // Clear stuck keys if the window loses focus mid-chord.
  const onBlur = () => HELD_KEYS.clear();

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);

  // Console escape hatch for environments where the chord is awkward.
  (window as unknown as Record<string, unknown>).__AEON_TRIGGER_CRASH = () =>
    triggerManualCrash({ reason: '手动崩溃（调试）：控制台触发' });

  console.log(
    '[AeonStagery] 手动崩溃快捷键已启用（调试）：长按 F3 再按 C，或控制台调用 window.__AEON_TRIGGER_CRASH()',
  );

  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    delete (window as unknown as Record<string, unknown>).__AEON_TRIGGER_CRASH;
  };
}

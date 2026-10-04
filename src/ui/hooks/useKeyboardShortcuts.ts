import { useEffect } from 'react';
import { eventBus } from '../../api/events';
import { useSetting } from '../SettingsStore';
import {
  resolveShortcutCommandId,
} from '../shortcuts/shortcutUtils';
import type { ShortcutCommandId, ShortcutSurface } from '../shortcuts/types';

interface UseKeyboardShortcutsOptions {
  initialized: boolean;
  onPlayPause: () => void;
  onStageReset: () => void;
  onFrameStep: (dir: 1 | -1) => void;
  onSave?: () => void;
  onOpenProject?: () => void;
  onExport?: () => void;
  onOpenShortcutSettings?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
}

const TEXT_ENTRY_SHORTCUT_TARGET = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '.monaco-editor',
  '.monaco-editor *',
].join(',');

const INTERACTIVE_SHORTCUT_TARGET = [
  ...TEXT_ENTRY_SHORTCUT_TARGET.split(','),
  'button',
  'a[href]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="separator"]',
  '[role="tab"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="button"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const EDITING_SHORTCUT_SURFACE = [
  '.stage-container',
  '.stage-area',
  '.timeline-editor-root',
  '.timeline-selection-bar',
  '[data-shortcut-surface="stage"]',
  '[data-shortcut-surface="timeline"]',
  '[data-shortcut-surface="selection"]',
].join(',');

export function shouldIgnoreGlobalShortcut(
  event: KeyboardEvent,
  options: { allowEditingSurfaceOverride?: boolean; commandId?: ShortcutCommandId } = {},
): boolean {
  if (event.isComposing) return true;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest(TEXT_ENTRY_SHORTCUT_TARGET)) return true;
  // 关键帧编辑器接管局部操作；撤销/重做复用命令层的统一历史。
  if (target.closest('.cme')) {
    return options.commandId !== 'app.undo' && options.commandId !== 'app.redo';
  }
  if (options.allowEditingSurfaceOverride && target.closest(EDITING_SHORTCUT_SURFACE)) return false;
  return !!target.closest(INTERACTIVE_SHORTCUT_TARGET);
}

export function getShortcutSurface(target: EventTarget | null): ShortcutSurface {
  const element = target instanceof Element
    ? target
    : typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  if (!element) return 'app';
  if (element.closest('.timeline-selection-bar, [data-shortcut-surface="selection"]')) return 'selection';
  if (element.closest('.timeline-editor-root, [data-shortcut-surface="timeline"]')) return 'timeline';
  if (element.closest('.stage-container, .stage-area, [data-shortcut-surface="stage"]')) return 'stage';
  return 'app';
}

export function useKeyboardShortcuts({
  initialized,
  onPlayPause,
  onStageReset,
  onFrameStep,
  onSave,
  onOpenProject,
  onExport,
  onOpenShortcutSettings,
  onUndo,
  onRedo,
}: UseKeyboardShortcutsOptions) {
  const keyboardShortcuts = useSetting('keyboardShortcuts');

  useEffect(() => {
    if (!initialized) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const surface = getShortcutSurface(e.target);
      const commandId = resolveShortcutCommandId(e, keyboardShortcuts, surface);
      if (!commandId) return;
      if (shouldIgnoreGlobalShortcut(e, { allowEditingSurfaceOverride: surface !== 'app', commandId })) return;
      if (!dispatchShortcutCommand(commandId)) return;
      e.preventDefault();
      e.stopPropagation();
    };

    const dispatchShortcutCommand = (commandId: ShortcutCommandId): boolean => {
      switch (commandId) {
        case 'app.playPause':
          onPlayPause();
          return true;
        case 'app.frameBackward':
          onFrameStep(-1);
          return true;
        case 'app.frameForward':
          onFrameStep(1);
          return true;
        case 'app.save':
          if (onSave) onSave();
          else void eventBus.emit('timeline:save');
          return true;
        case 'app.openProject':
          onOpenProject?.();
          return true;
        case 'app.export':
          onExport?.();
          return true;
        case 'app.undo':
          onUndo?.();
          return true;
        case 'app.redo':
          onRedo?.();
          return true;
        case 'app.openShortcutSettings':
          onOpenShortcutSettings?.();
          return true;
        case 'stage.resetView':
          onStageReset();
          return true;
        default:
          void eventBus.emit('shortcut:timeline-command', { commandId });
          return true;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [
    initialized,
    keyboardShortcuts,
    onExport,
    onFrameStep,
    onOpenProject,
    onOpenShortcutSettings,
    onPlayPause,
    onRedo,
    onSave,
    onStageReset,
    onUndo,
  ]);
}

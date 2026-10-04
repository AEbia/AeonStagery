import {
  DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS,
  PREMIERE_SHORTCUT_BINDINGS,
  SHORTCUT_COMMANDS,
  SHORTCUT_COMMAND_BY_ID,
} from './defaults';
import type React from 'react';
import type {
  KeyboardShortcutsSettings,
  ShortcutBinding,
  ShortcutCommandId,
  ShortcutConflict,
  ShortcutSurface,
} from './types';

const VALID_COMMAND_IDS = new Set(SHORTCUT_COMMANDS.map((command) => command.id));

export function normalizeKeyboardShortcutsSettings(value: unknown): KeyboardShortcutsSettings {
  if (!value || typeof value !== 'object') return cloneShortcutSettings(DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS);
  const raw = value as Partial<KeyboardShortcutsSettings>;
  const overrides: KeyboardShortcutsSettings['overrides'] = {};

  if (raw.overrides && typeof raw.overrides === 'object') {
    for (const [commandId, bindings] of Object.entries(raw.overrides)) {
      if (!VALID_COMMAND_IDS.has(commandId as ShortcutCommandId) || !Array.isArray(bindings)) continue;
      overrides[commandId as ShortcutCommandId] = bindings
        .map(normalizeShortcutBinding)
        .filter((binding): binding is ShortcutBinding => !!binding);
    }
  }

  return {
    activeProfileId: 'premiere',
    overrides,
  };
}

export function cloneShortcutSettings(settings: KeyboardShortcutsSettings): KeyboardShortcutsSettings {
  return {
    activeProfileId: 'premiere',
    overrides: Object.fromEntries(
      Object.entries(settings.overrides).map(([commandId, bindings]) => [
        commandId,
        bindings.map((binding) => ({ ...binding })),
      ]),
    ) as KeyboardShortcutsSettings['overrides'],
  };
}

export function getEffectiveShortcutBindings(
  settings: KeyboardShortcutsSettings,
  commandId: ShortcutCommandId,
): ShortcutBinding[] {
  const normalized = normalizeKeyboardShortcutsSettings(settings);
  const override = normalized.overrides[commandId];
  return (override ?? PREMIERE_SHORTCUT_BINDINGS[commandId] ?? []).map((binding) => ({ ...binding }));
}

export function getAllEffectiveShortcutBindings(
  settings: KeyboardShortcutsSettings,
): Record<ShortcutCommandId, ShortcutBinding[]> {
  return Object.fromEntries(
    SHORTCUT_COMMANDS.map((command) => [command.id, getEffectiveShortcutBindings(settings, command.id)]),
  ) as Record<ShortcutCommandId, ShortcutBinding[]>;
}

export function normalizeShortcutBinding(value: unknown): ShortcutBinding | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ShortcutBinding>;
  if (!raw.code || typeof raw.code !== 'string') return null;
  return {
    code: raw.code,
    key: typeof raw.key === 'string' ? raw.key : undefined,
    primary: raw.primary === true || undefined,
    ctrl: raw.ctrl === true || undefined,
    meta: raw.meta === true || undefined,
    alt: raw.alt === true || undefined,
    shift: raw.shift === true || undefined,
  };
}

export function bindingFromKeyboardEvent(event: KeyboardEvent | React.KeyboardEvent): ShortcutBinding | null {
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  if (native.isComposing || event.code === 'Tab') return null;
  const usePrimary = isPrimaryModifierEvent(event);
  const code = event.code || keyToCode(event.key);
  if (!code) return null;
  return {
    code,
    key: event.key,
    primary: usePrimary || undefined,
    ctrl: !usePrimary && event.ctrlKey ? true : undefined,
    meta: !usePrimary && event.metaKey ? true : undefined,
    alt: event.altKey ? true : undefined,
    shift: event.shiftKey ? true : undefined,
  };
}

export function shortcutBindingMatchesEvent(binding: ShortcutBinding, event: KeyboardEvent): boolean {
  if (event.code !== binding.code) return false;
  const primaryPressed = isPrimaryModifierEvent(event);
  if (!!binding.primary !== primaryPressed) return false;
  if (!binding.primary) {
    if (!!binding.ctrl !== event.ctrlKey) return false;
    if (!!binding.meta !== event.metaKey) return false;
  }
  if (!!binding.alt !== event.altKey) return false;
  if (!!binding.shift !== event.shiftKey) return false;
  return true;
}

export function resolveShortcutCommandId(
  event: KeyboardEvent,
  settings: KeyboardShortcutsSettings,
  surface: ShortcutSurface,
): ShortcutCommandId | null {
  for (const command of SHORTCUT_COMMANDS) {
    if (!isCommandAvailableOnSurface(command.id, surface)) continue;
    const bindings = getEffectiveShortcutBindings(settings, command.id);
    if (bindings.some((binding) => shortcutBindingMatchesEvent(binding, event))) {
      return command.id;
    }
  }
  return null;
}

export function isCommandAvailableOnSurface(commandId: ShortcutCommandId, surface: ShortcutSurface): boolean {
  const command = SHORTCUT_COMMAND_BY_ID.get(commandId);
  if (!command) return false;
  if (command.scope === 'global') return true;
  if (command.scope === 'editing') return true;
  if (command.scope === 'stage') return surface === 'stage';
  if (command.scope === 'timeline') return surface === 'timeline' || surface === 'selection';
  return false;
}

export function findShortcutConflicts(
  settings: KeyboardShortcutsSettings,
  commandId: ShortcutCommandId,
  binding: ShortcutBinding,
): ShortcutConflict[] {
  const command = SHORTCUT_COMMAND_BY_ID.get(commandId);
  if (!command) return [];
  const bindingKey = shortcutBindingKey(binding);
  return SHORTCUT_COMMANDS.flatMap((candidate) => {
    if (candidate.id === commandId) return [];
    if (!scopesCanConflict(command.scope, candidate.scope)) return [];
    return getEffectiveShortcutBindings(settings, candidate.id)
      .filter((candidateBinding) => shortcutBindingKey(candidateBinding) === bindingKey)
      .map((candidateBinding) => ({
        commandId: candidate.id,
        commandLabel: candidate.label,
        binding: candidateBinding,
      }));
  });
}

export function addShortcutBinding(
  settings: KeyboardShortcutsSettings,
  commandId: ShortcutCommandId,
  binding: ShortcutBinding,
): KeyboardShortcutsSettings {
  const next = cloneShortcutSettings(normalizeKeyboardShortcutsSettings(settings));
  const existing = getEffectiveShortcutBindings(next, commandId);
  if (!existing.some((candidate) => shortcutBindingKey(candidate) === shortcutBindingKey(binding))) {
    existing.push(binding);
  }
  next.overrides[commandId] = existing;
  return next;
}

export function removeShortcutBinding(
  settings: KeyboardShortcutsSettings,
  commandId: ShortcutCommandId,
  bindingIndex: number,
): KeyboardShortcutsSettings {
  const next = cloneShortcutSettings(normalizeKeyboardShortcutsSettings(settings));
  next.overrides[commandId] = getEffectiveShortcutBindings(next, commandId)
    .filter((_, index) => index !== bindingIndex);
  return next;
}

export function resetShortcutCommand(
  settings: KeyboardShortcutsSettings,
  commandId: ShortcutCommandId,
): KeyboardShortcutsSettings {
  const next = cloneShortcutSettings(normalizeKeyboardShortcutsSettings(settings));
  delete next.overrides[commandId];
  return next;
}

export function replaceConflictingShortcutBindings(
  settings: KeyboardShortcutsSettings,
  commandId: ShortcutCommandId,
  binding: ShortcutBinding,
): KeyboardShortcutsSettings {
  const conflicts = findShortcutConflicts(settings, commandId, binding);
  const next = cloneShortcutSettings(normalizeKeyboardShortcutsSettings(settings));
  const conflictIds = new Set(conflicts.map((conflict) => conflict.commandId));
  for (const conflictId of conflictIds) {
    next.overrides[conflictId] = getEffectiveShortcutBindings(next, conflictId)
      .filter((candidate) => shortcutBindingKey(candidate) !== shortcutBindingKey(binding));
  }
  return addShortcutBinding(next, commandId, binding);
}

export function formatShortcutBinding(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.primary) parts.push(isMacPlatform() ? 'Cmd' : 'Ctrl');
  else {
    if (binding.ctrl) parts.push('Ctrl');
    if (binding.meta) parts.push('Cmd');
  }
  if (binding.alt) parts.push(isMacPlatform() ? 'Option' : 'Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(formatShortcutCode(binding.code, binding.key));
  return parts.join('+');
}

export function shortcutBindingKey(binding: ShortcutBinding): string {
  return [
    binding.primary ? 'primary' : '',
    binding.ctrl ? 'ctrl' : '',
    binding.meta ? 'meta' : '',
    binding.alt ? 'alt' : '',
    binding.shift ? 'shift' : '',
    binding.code,
  ].filter(Boolean).join('+');
}

function scopesCanConflict(left: string, right: string): boolean {
  if (left === 'global' || right === 'global') return true;
  if (left === 'editing' || right === 'editing') return true;
  return left === right;
}

function isPrimaryModifierEvent(event: KeyboardEvent | React.KeyboardEvent): boolean {
  return isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '');
}

function keyToCode(key: string): string {
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') return `Key${upper}`;
    if (upper >= '0' && upper <= '9') return `Digit${upper}`;
  }
  return key;
}

function formatShortcutCode(code: string, key?: string): string {
  if (code === 'Space') return 'Space';
  if (code === 'Slash') return '/';
  if (code === 'Equal') return '=';
  if (code === 'Minus') return '-';
  if (code === 'Backspace') return 'Backspace';
  if (code === 'Delete') return 'Delete';
  if (code === 'NumpadAdd') return 'Numpad +';
  if (code === 'NumpadSubtract') return 'Numpad -';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return key && key.length > 0 ? key : code;
}

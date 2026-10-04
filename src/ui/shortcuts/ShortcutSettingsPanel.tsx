import React, { useMemo, useState } from 'react';
import { IconPlus, IconRefresh, IconSearch, IconTrash } from '../icons';
import {
  SHORTCUT_COMMANDS,
  DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS,
} from './defaults';
import type {
  KeyboardShortcutsSettings,
  ShortcutBinding,
  ShortcutCommandId,
  ShortcutConflict,
} from './types';
import {
  addShortcutBinding,
  bindingFromKeyboardEvent,
  findShortcutConflicts,
  formatShortcutBinding,
  getEffectiveShortcutBindings,
  normalizeKeyboardShortcutsSettings,
  removeShortcutBinding,
  replaceConflictingShortcutBindings,
  resetShortcutCommand,
} from './shortcutUtils';

interface ShortcutSettingsPanelProps {
  value: KeyboardShortcutsSettings;
  onChange: (value: KeyboardShortcutsSettings) => void;
}

interface PendingConflict {
  commandId: ShortcutCommandId;
  binding: ShortcutBinding;
  conflicts: ShortcutConflict[];
}

interface MouseShortcut {
  label: string;
  gesture: string;
  description: string;
}

const MODIFIER_ONLY_CODES = new Set([
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'ShiftLeft',
  'ShiftRight',
]);

const MOUSE_SHORTCUTS: MouseShortcut[] = [
  {
    label: '缩放时间线',
    gesture: 'Alt + 滚轮',
    description: '鼠标停在时间线区域时，围绕当前播放头放大或缩小时间线。',
  },
  {
    label: '缩放舞台视图',
    gesture: '滚轮',
    description: '鼠标停在舞台区域时，放大或缩小画布视图。',
  },
  {
    label: '平移舞台视图',
    gesture: '鼠标左键拖拽',
    description: '在舞台区域拖拽，移动当前画布视图。',
  },
  {
    label: '切换时间线选区',
    gesture: 'Ctrl / Cmd / Shift + 点击',
    description: '点击时间线语句块，切换它是否属于当前选区。',
  },
];

export function ShortcutSettingsPanel({ value, onChange }: ShortcutSettingsPanelProps) {
  const settings = useMemo(() => normalizeKeyboardShortcutsSettings(value), [value]);
  const [query, setQuery] = useState('');
  const [recordingCommandId, setRecordingCommandId] = useState<ShortcutCommandId | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleCommands = useMemo(() => (
    SHORTCUT_COMMANDS.filter((command) => {
      if (!normalizedQuery) return true;
      const bindingText = getEffectiveShortcutBindings(settings, command.id)
        .map((binding) => formatShortcutBinding(binding))
        .join(' ');
      return [
        command.label,
        command.group,
        command.description,
        command.id,
        bindingText,
      ].some((text) => text.toLowerCase().includes(normalizedQuery));
    })
  ), [normalizedQuery, settings]);

  const visibleMouseShortcuts = useMemo(() => (
    MOUSE_SHORTCUTS.filter((shortcut) => {
      if (!normalizedQuery) return true;
      return [
        shortcut.label,
        shortcut.gesture,
        shortcut.description,
        '鼠标操作',
      ].some((text) => text.toLowerCase().includes(normalizedQuery));
    })
  ), [normalizedQuery]);

  const groups = useMemo(() => {
    const grouped = new Map<string, typeof SHORTCUT_COMMANDS>();
    for (const command of visibleCommands) {
      const commands = grouped.get(command.group) ?? [];
      commands.push(command);
      grouped.set(command.group, commands);
    }
    return [...grouped.entries()];
  }, [visibleCommands]);

  const handleRecordKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    commandId: ShortcutCommandId,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setRecordingCommandId(null);
      setPendingConflict(null);
      return;
    }
    const binding = bindingFromKeyboardEvent(event);
    if (!binding || MODIFIER_ONLY_CODES.has(binding.code)) return;
    const conflicts = findShortcutConflicts(settings, commandId, binding);
    if (conflicts.length > 0) {
      setPendingConflict({ commandId, binding, conflicts });
      return;
    }
    onChange(addShortcutBinding(settings, commandId, binding));
    setRecordingCommandId(null);
  };

  const commitConflictReplacement = () => {
    if (!pendingConflict) return;
    onChange(replaceConflictingShortcutBindings(
      settings,
      pendingConflict.commandId,
      pendingConflict.binding,
    ));
    setPendingConflict(null);
    setRecordingCommandId(null);
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={shortcutToolbarStyle}>
        <label style={searchBoxStyle}>
          <IconSearch width={14} height={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索命令、快捷键或鼠标操作"
            aria-label="搜索快捷键和鼠标操作"
            style={searchInputStyle}
          />
        </label>
        <button
          type="button"
          className="btn"
          onClick={() => {
            onChange(DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS);
            setRecordingCommandId(null);
            setPendingConflict(null);
          }}
          style={toolbarButtonStyle}
        >
          <IconRefresh width={14} height={14} />
          重置全部
        </button>
      </div>

      {pendingConflict && (
        <div role="alert" style={conflictBannerStyle}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {formatShortcutBinding(pendingConflict.binding)} 已被占用
          </div>
          <div>
            将替换：{pendingConflict.conflicts.map((conflict) => conflict.commandLabel).join('、')}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn--primary" onClick={commitConflictReplacement}>替换冲突</button>
            <button type="button" className="btn" onClick={() => setPendingConflict(null)}>取消</button>
          </div>
        </div>
      )}

      {visibleMouseShortcuts.length > 0 && (
        <section style={shortcutGroupStyle}>
          <h4 style={shortcutGroupTitleStyle}>鼠标操作</h4>
          <div style={{ display: 'grid', gap: 8 }}>
            {visibleMouseShortcuts.map((shortcut) => (
              <div key={shortcut.label} style={mouseShortcutRowStyle}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{shortcut.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    {shortcut.description}
                  </div>
                </div>
                <div style={shortcutBindingsStyle}>
                  <span style={mouseShortcutChipStyle}>{shortcut.gesture}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {groups.map(([group, commands]) => (
        <section key={group} style={shortcutGroupStyle}>
          <h4 style={shortcutGroupTitleStyle}>{group}</h4>
          <div style={{ display: 'grid', gap: 8 }}>
            {commands.map((command) => {
              const bindings = getEffectiveShortcutBindings(settings, command.id);
              const hasOverride = Object.prototype.hasOwnProperty.call(settings.overrides, command.id);
              const isRecording = recordingCommandId === command.id;
              return (
                <div key={command.id} style={shortcutRowStyle}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{command.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      {command.description}
                    </div>
                  </div>
                  <div style={shortcutBindingsStyle}>
                    {bindings.length > 0 ? bindings.map((binding, index) => (
                      <span key={`${command.id}:${index}:${formatShortcutBinding(binding)}`} style={shortcutChipStyle}>
                        {formatShortcutBinding(binding)}
                        <button
                          type="button"
                          className="btn btn--icon"
                          onClick={() => onChange(removeShortcutBinding(settings, command.id, index))}
                          aria-label={`移除 ${command.label} 的 ${formatShortcutBinding(binding)}`}
                          style={chipRemoveButtonStyle}
                        >
                          <IconTrash width={11} height={11} />
                        </button>
                      </span>
                    )) : (
                      <span style={emptyBindingStyle}>未绑定</span>
                    )}
                  </div>
                  <div style={shortcutActionsStyle}>
                    {isRecording ? (
                      <button
                        type="button"
                        className="btn btn--primary"
                        autoFocus
                        onKeyDown={(event) => handleRecordKeyDown(event, command.id)}
                        onBlur={() => {
                          if (!pendingConflict) setRecordingCommandId(null);
                        }}
                        style={recordButtonStyle}
                      >
                        按下快捷键
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setPendingConflict(null);
                          setRecordingCommandId(command.id);
                        }}
                        style={smallActionButtonStyle}
                      >
                        <IconPlus width={13} height={13} />
                        添加
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn"
                      onClick={() => onChange(resetShortcutCommand(settings, command.id))}
                      disabled={!hasOverride}
                      style={smallActionButtonStyle}
                    >
                      重置
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

const shortcutToolbarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
};

const searchBoxStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flex: '1 1 260px',
  minWidth: 220,
  padding: '8px 10px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-tertiary)',
};

const searchInputStyle: React.CSSProperties = {
  width: '100%',
  border: 0,
  outline: 0,
  background: 'transparent',
  color: 'var(--text-primary)',
  fontSize: 13,
};

const toolbarButtonStyle: React.CSSProperties = {
  borderRadius: 'var(--radius-md)',
  padding: '8px 12px',
};

const conflictBannerStyle: React.CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--warning) 50%, transparent)',
  background: 'color-mix(in srgb, var(--warning) 12%, var(--bg-surface))',
  color: 'var(--text-primary)',
  borderRadius: 'var(--radius-lg)',
  padding: 12,
  fontSize: 12,
};

const shortcutGroupStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
};

const shortcutGroupTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: 0,
};

const shortcutRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(180px, 1fr) minmax(180px, 1.1fr) auto',
  gap: 12,
  alignItems: 'center',
  padding: 12,
  borderRadius: 'var(--radius-lg)',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-subtle)',
};

const mouseShortcutRowStyle: React.CSSProperties = {
  ...shortcutRowStyle,
  gridTemplateColumns: 'minmax(180px, 1fr) minmax(180px, 1.1fr)',
};

const shortcutBindingsStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  alignItems: 'center',
};

const shortcutChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-tertiary)',
  padding: '4px 4px 4px 8px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  whiteSpace: 'nowrap',
};

const mouseShortcutChipStyle: React.CSSProperties = {
  ...shortcutChipStyle,
  padding: '4px 8px',
};

const chipRemoveButtonStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  minWidth: 20,
};

const emptyBindingStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-secondary)',
};

const shortcutActionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  justifyContent: 'flex-end',
};

const smallActionButtonStyle: React.CSSProperties = {
  borderRadius: 'var(--radius-md)',
  padding: '7px 9px',
  fontSize: 12,
};

const recordButtonStyle: React.CSSProperties = {
  borderRadius: 'var(--radius-md)',
  padding: '7px 10px',
  fontSize: 12,
};

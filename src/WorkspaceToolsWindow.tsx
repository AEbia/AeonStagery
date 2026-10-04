import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconActivity,
  IconCheck,
  IconError,
  IconExternalLink,
  IconFileText,
  IconFolder,
  IconPlus,
  IconSave,
  IconTrash,
  IconUser,
  IconWarning,
} from './ui/icons';
import { ColorPickerInput } from './ui/ColorPickerInput';
import {
  areWorkspaceToolsSceneIdentitiesEqual,
  type WorkspaceCharacterCommand,
  type WorkspaceRuntimeSnapshot,
  type WorkspaceToolsCommand,
  type WorkspaceToolsCommandResult,
  type WorkspaceToolsSceneIdentity,
  type WorkspaceToolsSnapshot,
  type WorkspaceToolTab,
} from './ui/workspace-tools/types';
import {
  applyAeonStageryMonacoTheme,
  loadMonacoRuntime,
  MONACO_JSON_EDITOR_OPTIONS,
  type MonacoApi,
  type MonacoRuntime,
} from './ui/monaco/monacoRuntime';

function sendCommand(command: WorkspaceToolsCommand) {
  window.aeonStageryAPI?.workspaceTools?.sendCommand(command);
}

export interface WorkspaceToolsScriptDraft {
  sceneIdentity: WorkspaceToolsSceneIdentity;
  rawScript: string;
  dirty: boolean;
  error: string;
  pendingRequestId?: string;
  pendingSource?: string;
}

export function reconcileWorkspaceToolsScriptDraft(
  draft: WorkspaceToolsScriptDraft | null,
  snapshot: WorkspaceToolsSnapshot,
): WorkspaceToolsScriptDraft | null {
  if (!snapshot.sceneIdentity) {
    return draft?.dirty || draft?.pendingRequestId ? draft : null;
  }
  if (draft?.dirty || draft?.pendingRequestId) {
    return draft;
  }
  return {
    sceneIdentity: snapshot.sceneIdentity,
    rawScript: snapshot.rawScript,
    dirty: false,
    error: '',
  };
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `workspace-tools-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const ToolTabButton: React.FC<{
  tab: WorkspaceToolTab;
  activeTab: WorkspaceToolTab;
  label: string;
  icon: React.ReactNode;
  count?: number;
}> = ({ tab, activeTab, label, icon, count }) => (
  <button
    type="button"
    role="tab"
    id={`workspace-tools-tab-${tab}`}
    aria-controls={`workspace-tools-panel-${tab}`}
    aria-selected={tab === activeTab}
    tabIndex={tab === activeTab ? 0 : -1}
    className="workspace-tools-window__tab"
    data-active={tab === activeTab}
    onClick={() => sendCommand({ type: 'set-tab', tab })}
    onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tablist = event.currentTarget.closest('[role="tablist"]');
      const tabs = Array.from(tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
      const currentIndex = tabs.indexOf(event.currentTarget);
      if (currentIndex < 0 || tabs.length === 0) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[nextIndex]?.focus();
      tabs[nextIndex]?.click();
    }}
  >
    {icon}
    <span>{label}</span>
    {!!count && <b>{count}</b>}
  </button>
);

const DetachedCharacterPanel: React.FC<{
  snapshot: WorkspaceToolsSnapshot;
  runtime: WorkspaceRuntimeSnapshot | null;
}> = ({ snapshot, runtime }) => {
  const characters = snapshot.sceneMeta?.characters || [];
  const [selectedId, setSelectedId] = useState<string | null>(() => characters[0]?.id ?? null);
  const [showParameters, setShowParameters] = useState(false);
  const [idError, setIdError] = useState<string | null>(null);
  const selected = characters.find((character) => character.id === selectedId) || characters[0];
  const runtimeCharacter = runtime?.characters.find((character) => character.id === selected?.id);

  useEffect(() => {
    if (selected && selected.id !== selectedId) {
      setSelectedId(selected.id);
    }
    if (!selected) {
      setShowParameters(false);
    }
  }, [selected, selectedId]);

  useEffect(() => {
    setIdError(null);
  }, [selectedId]);

  const apply = (command: WorkspaceCharacterCommand) => {
    sendCommand({ type: 'character-command', command });
  };

  /**
   * Commits an edited character id. Empty or already-taken ids are rejected
   * locally: duplicate ids break the character list, the timeline tracks and
   * every statement that references the character.
   */
  const commitCharacterId = (input: HTMLInputElement) => {
    if (!selected) return;
    const nextId = input.value.trim();

    if (nextId === '') {
      setIdError('角色 ID 不能为空');
      input.value = selected.id;
      return;
    }
    if (nextId === selected.id) {
      setIdError(null);
      input.value = nextId;
      return;
    }
    if (characters.some((character) => character.id === nextId)) {
      setIdError(`角色 ID「${nextId}」已被其他角色占用`);
      input.value = selected.id;
      return;
    }

    setIdError(null);
    apply({ kind: 'update-character-id', currentCharId: selected.id, nextCharId: nextId });
    setSelectedId(nextId);
  };

  const chooseModel = async (onSelect: (modelPath: string) => void) => {
    const api = window.aeonStageryAPI;
    if (!api) return;
    const result = await api.dialog.showOpen({
      title: '选择 Live2D 模型文件',
      properties: ['openFile'],
      filters: [{ name: 'Live2D 模型', extensions: ['json'] }],
    });
    const selectedPath = result.filePaths?.[0];
    if (result.canceled || !selectedPath) return;

    let modelPath = selectedPath;
    if (snapshot.projectRoot) {
      modelPath = await api.path.relative(snapshot.projectRoot, selectedPath);
    }
    onSelect(modelPath.replace(/\\/g, '/'));
  };

  return (
    <div className="character-directory">
      <header className="character-directory__header">
        <div>
          <strong>角色管理</strong>
          <span>{characters.length} 个角色</span>
        </div>
        <button className="btn btn--primary btn--sm" onClick={() => apply({ kind: 'add-character' })}>
          <IconPlus width={13} height={13} />
          添加角色
        </button>
      </header>

      <div className="character-directory__list" role="listbox" aria-label="角色列表">
        {characters.map((character) => (
          <button
            className="character-directory__list-item"
            key={character.id}
            data-active={character.id === selectedId}
            role="option"
            aria-selected={character.id === selectedId}
            onClick={() => {
              setSelectedId(character.id);
              setShowParameters(false);
            }}
          >
            <span className="character-directory__swatch" style={{ background: character.color || '#FFD700' }} />
            <span className="character-directory__list-name">{character.name || character.id}</span>
            <span className="character-directory__list-id">{character.id}</span>
          </button>
        ))}
        {characters.length === 0 && (
          <div className="character-directory__empty">
            <IconUser width={24} height={24} />
            <span>尚未添加角色</span>
          </div>
        )}
      </div>

      {selected ? (
        <div className="character-directory__detail" key={selected.id}>
          <section className="character-directory__section">
            <div className="character-directory__section-title">基础信息</div>
            <div className="character-directory__field-grid">
              <label>
                <span>角色 ID</span>
                <input
                  key={`id-${selected.id}`}
                  defaultValue={selected.id}
                  aria-invalid={idError ? true : undefined}
                  className={idError ? 'character-directory__id-input character-directory__id-input--invalid' : 'character-directory__id-input'}
                  onChange={() => {
                    if (idError) setIdError(null);
                  }}
                  onBlur={(event) => commitCharacterId(event.currentTarget)}
                />
                {idError && (
                  <small className="character-directory__field-error" role="alert">{idError}</small>
                )}
              </label>
              <label>
                <span>显示名称</span>
                <input
                  key={`name-${selected.id}-${selected.name}`}
                  defaultValue={selected.name}
                  onBlur={(event) => {
                    if (event.target.value === selected.name) return;
                    apply({ kind: 'update-character-name', charId: selected.id, nextName: event.target.value });
                  }}
                />
              </label>
            </div>
            <label className="character-directory__color-field">
              <span>主题色</span>
              <div className="compound-input">
                <ColorPickerInput
                  value={selected.color || '#FFD700'}
                  onChange={(color) => apply({
                    kind: 'set-character-color',
                    charId: selected.id,
                    color,
                  })}
                />
                <input
                  type="text"
                  value={selected.color || ''}
                  placeholder="#FFD700"
                  onChange={(event) => apply({
                    kind: 'set-character-color',
                    charId: selected.id,
                    color: event.target.value || undefined,
                  })}
                />
              </div>
            </label>
          </section>

          <section className="character-directory__section">
            <div className="character-directory__section-title">模型</div>
            <div className="character-directory__model-row">
              <div title={selected.model || ''}>{selected.model || '未选择模型'}</div>
              <button
                className="btn btn--icon"
                title="选择模型文件"
                onClick={() => void chooseModel((model) => apply({
                  kind: 'set-character-model',
                  charId: selected.id,
                  model,
                }))}
              >
                <IconFolder width={14} height={14} />
              </button>
            </div>
            {selected.model && runtimeCharacter && (
              <div className="character-directory__inline-actions">
                <button
                  className="btn btn--sm"
                  disabled={runtime?.playing}
                  onClick={() => sendCommand({ type: 'reload-character', charId: selected.id })}
                >
                  重新加载
                </button>
                <button className="btn btn--sm" onClick={() => setShowParameters((current) => !current)}>
                  {showParameters ? '隐藏参数' : 'Live2D 参数'}
                </button>
              </div>
            )}
            {showParameters && runtimeCharacter && (
              <div className="character-directory__parameters">
                {runtimeCharacter.parameters.map((parameter) => (
                  <label className="character-directory__parameter" key={parameter.index}>
                    <span>{parameter.name}</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={parameter.value}
                      disabled={runtime?.playing}
                      onChange={(event) => sendCommand({
                        type: 'set-character-parameter',
                        charId: selected.id,
                        parameterIndex: parameter.index,
                        value: Number(event.target.value),
                      })}
                    />
                  </label>
                ))}
              </div>
            )}
          </section>

          <section className="character-directory__section">
            <div className="character-directory__section-header">
              <div className="character-directory__section-title">副模型</div>
              <button
                className="btn btn--sm"
                onClick={() => void chooseModel((model) => apply({
                  kind: 'add-character-variant',
                  charId: selected.id,
                  model,
                }))}
              >
                <IconPlus width={11} height={11} />
                添加
              </button>
            </div>
            <div className="character-directory__variants">
            {(selected.variants || []).map((variant, variantIndex) => (
              <div className="character-directory__variant" key={`${selected.id}-${variantIndex}`}>
                <input
                  key={`variant-name-${selected.id}-${variantIndex}-${variant.name}`}
                  defaultValue={variant.name}
                  placeholder="名称"
                  onBlur={(event) => apply({
                    kind: 'update-character-variant-name',
                    charId: selected.id,
                    variantIndex,
                    nextName: event.target.value,
                  })}
                />
                <div title={variant.model || ''}>{variant.model || '未选择模型'}</div>
                <button
                  className="btn btn--icon"
                  title="选择副模型文件"
                  onClick={() => void chooseModel((model) => apply({
                    kind: 'update-character-variant-model',
                    charId: selected.id,
                    variantIndex,
                    nextModel: model,
                  }))}
                >
                  <IconFolder width={12} height={12} />
                </button>
                <button className="btn btn--icon" title="删除副模型" onClick={() => apply({
                  kind: 'remove-character-variant',
                  charId: selected.id,
                  variantIndex,
                })}>
                  <IconTrash width={12} height={12} />
                </button>
              </div>
            ))}
              {(selected.variants || []).length === 0 && (
                <div className="character-directory__empty-row">没有副模型</div>
              )}
            </div>
          </section>

          <button
            className="btn btn--danger character-directory__delete"
            onClick={() => apply({ kind: 'remove-character', charId: selected.id })}
          >
            <IconTrash width={13} height={13} />
            删除角色
          </button>
        </div>
      ) : null}
    </div>
  );
};

const DetachedDiagnosticsPanel: React.FC<{ snapshot: WorkspaceToolsSnapshot }> = ({ snapshot }) => {
  const [filter, setFilter] = useState<'all' | 'error' | 'warning'>('all');
  const errors = snapshot.issues.filter((issue) => issue.severity === 'error');
  const warnings = snapshot.issues.filter((issue) => issue.severity === 'warning');
  const filteredIssues = filter === 'error'
    ? errors
    : filter === 'warning'
      ? warnings
      : snapshot.issues;

  const locateIssue = (actionId?: string) => {
    sendCommand({
      type: 'select-action',
      actionId,
      time: actionId ? snapshot.timelineActionTimesById[actionId] : undefined,
    });
    if (actionId) {
      sendCommand({ type: 'set-tab', tab: 'script' });
    }
  };

  return (
    <div className="workspace-tools-diagnostics">
      <header className="workspace-tools-diagnostics__header">
        <div>
          <strong>剧本问题诊断</strong>
          <span>定位后自动切换至 JSON 编辑器</span>
        </div>
      </header>

      {snapshot.issues.length > 0 && (
        <>
          <div className="workspace-tools-diagnostics__summary">
            <div data-severity="error">
              <span>错误总数</span>
              <strong>{errors.length}</strong>
            </div>
            <div data-severity="warning">
              <span>警告总数</span>
              <strong>{warnings.length}</strong>
            </div>
          </div>
          <div className="workspace-tools-diagnostics__filters" role="group" aria-label="诊断筛选">
            <button type="button" data-active={filter === 'all'} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              全部 ({snapshot.issues.length})
            </button>
            <button type="button" data-active={filter === 'error'} aria-pressed={filter === 'error'} data-severity="error" onClick={() => setFilter('error')}>
              <IconError width={11} height={11} />
              错误 ({errors.length})
            </button>
            <button type="button" data-active={filter === 'warning'} aria-pressed={filter === 'warning'} data-severity="warning" onClick={() => setFilter('warning')}>
              <IconWarning width={11} height={11} />
              警告 ({warnings.length})
            </button>
          </div>
        </>
      )}

      <div className="workspace-tools-diagnostics__list">
        {filteredIssues.length === 0 ? (
          <div className="workspace-tools-diagnostics__success">
            <IconCheck width={15} height={15} />
            {snapshot.issues.length === 0 ? '剧本业务逻辑验证通过，未发现任何问题。' : '该类别下无诊断项。'}
          </div>
        ) : (
          filteredIssues.map((issue, index) => {
            const isError = issue.severity === 'error';
            return (
              <button
                className="workspace-tools-diagnostics__issue"
                key={`${issue.actionId || 'global'}-${index}`}
                data-severity={issue.severity}
                disabled={!issue.actionId}
                onClick={() => locateIssue(issue.actionId)}
              >
                <span className="workspace-tools-diagnostics__strip" />
                <span className="workspace-tools-diagnostics__issue-header">
                  <strong>
                    {isError ? <IconError width={12} height={12} /> : <IconWarning width={12} height={12} />}
                    {isError ? '错误' : issue.severity === 'warning' ? '警告' : '提示'}
                  </strong>
                  {issue.actionType && <code>{issue.actionType}</code>}
                  {issue.actionId && (
                    <em>
                      点击定位
                      <IconExternalLink width={12} height={12} />
                    </em>
                  )}
                </span>
                <span className="workspace-tools-diagnostics__message">{issue.message}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

const DetachedScriptPanel: React.FC<{
  snapshot: WorkspaceToolsSnapshot;
  draft: WorkspaceToolsScriptDraft;
  onDraftChange: React.Dispatch<React.SetStateAction<WorkspaceToolsScriptDraft | null>>;
}> = ({ snapshot, draft, onDraftChange }) => {
  const [monacoRuntime, setMonacoRuntime] = useState<MonacoRuntime | null>(null);
  const rawScriptRef = useRef(draft.rawScript);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const applyRawScriptRef = useRef<() => void>(() => {});
  const conflict = !areWorkspaceToolsSceneIdentitiesEqual(
    draft.sceneIdentity,
    snapshot.sceneIdentity,
  );

  useEffect(() => {
    let cancelled = false;
    void loadMonacoRuntime().then((runtime) => {
      if (!cancelled) {
        setMonacoRuntime(runtime);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    rawScriptRef.current = draft.rawScript;
  }, [draft.rawScript]);

  useEffect(() => {
    applyAeonStageryMonacoTheme(monacoRef.current, snapshot.theme);
  }, [snapshot.theme]);

  const applyRawScript = useCallback(() => {
    const source = rawScriptRef.current;
    if (conflict) {
      onDraftChange((current) => current ? {
        ...current,
        error: '主窗口已切换到其他场景。请切回草稿所属场景后再应用。',
      } : current);
      return;
    }
    try {
      JSON.parse(source);
      const requestId = createRequestId();
      onDraftChange((current) => current ? {
        ...current,
        error: '',
        pendingRequestId: requestId,
        pendingSource: source,
      } : current);
      sendCommand({
        type: 'apply-raw-script',
        requestId,
        rawScript: source,
        sceneIdentity: draft.sceneIdentity,
      });
    } catch (cause) {
      onDraftChange((current) => current ? {
        ...current,
        error: cause instanceof Error ? cause.message : 'JSON 格式无效',
      } : current);
    }
  }, [conflict, draft.sceneIdentity, onDraftChange]);

  const discardDraftAndSwitchScene = useCallback(() => {
    if (!snapshot.sceneIdentity) return;
    onDraftChange({
      sceneIdentity: snapshot.sceneIdentity,
      rawScript: snapshot.rawScript,
      dirty: false,
      error: '',
    });
  }, [onDraftChange, snapshot.rawScript, snapshot.sceneIdentity]);

  useEffect(() => {
    applyRawScriptRef.current = applyRawScript;
  }, [applyRawScript]);

  const handleEditorMount = useCallback((editor: any, monacoApi: MonacoApi) => {
    editorRef.current = editor;
    monacoRef.current = monacoApi;
    applyAeonStageryMonacoTheme(monacoApi, snapshot.theme);

    editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => {
      applyRawScriptRef.current();
    });
    editor.addCommand(
      monacoApi.KeyMod.CtrlCmd | monacoApi.KeyMod.Shift | monacoApi.KeyCode.KeyF,
      () => {
        void editor.getAction('editor.action.formatDocument')?.run();
      },
    );
  }, [snapshot.theme]);

  return (
    <div className="workspace-tools-window__script">
      <div className="workspace-tools-window__script-toolbar">
        <span>{draft.sceneIdentity.filePath || '当前场景'}</span>
        <div className="workspace-tools-window__script-actions">
          <em data-dirty={draft.dirty || conflict}>
            {conflict ? '场景冲突' : draft.pendingRequestId ? '应用中' : draft.dirty ? '未应用' : '已同步'}
          </em>
          <button onClick={() => void editorRef.current?.getAction('editor.action.formatDocument')?.run()}>
            格式化
          </button>
          <button
            onClick={() => applyRawScript()}
            disabled={!draft.dirty || !!draft.pendingRequestId || conflict}
          >
            应用 JSON
          </button>
        </div>
      </div>
      {conflict && (
        <div className="workspace-tools-window__script-error">
          <span>
            草稿属于 {draft.sceneIdentity.filePath || draft.sceneIdentity.sceneId}，当前主窗口是 {snapshot.filePath || snapshot.sceneIdentity?.sceneId || '空场景'}。
          </span>
          {snapshot.sceneIdentity && (
            <button className="btn btn--sm" onClick={discardDraftAndSwitchScene}>
              放弃旧草稿并切换到当前场景
            </button>
          )}
        </div>
      )}
      {draft.error && <div className="workspace-tools-window__script-error">{draft.error}</div>}
      <div className="workspace-tools-window__script-editor">
        {monacoRuntime ? (
          <monacoRuntime.Editor
            language="json"
            path={draft.sceneIdentity.filePath || `inmemory://workspace-tools/${draft.sceneIdentity.sceneId}.json`}
            value={draft.rawScript}
            options={MONACO_JSON_EDITOR_OPTIONS}
            onMount={handleEditorMount}
            onChange={(value) => {
              if (value === undefined) return;
              rawScriptRef.current = value;
              onDraftChange((current) => current ? {
                ...current,
                rawScript: value,
                dirty: true,
                error: '',
              } : current);
            }}
          />
        ) : (
          <div className="workspace-tools-window__empty">正在加载 Monaco 编辑器...</div>
        )}
      </div>
    </div>
  );
};

const DetachedSnapshotPanel: React.FC<{ runtime: WorkspaceRuntimeSnapshot | null }> = ({ runtime }) => {
  if (!runtime) {
    return <div className="workspace-tools-window__empty">等待运行时快照</div>;
  }

  return (
    <div className="workspace-tools-snapshot">
      <section>
        <h3>相机 (CAMERA)</h3>
        <div className="workspace-tools-snapshot__metrics">
          <div><span>X坐标</span><strong>{runtime.camera.x.toFixed(2)}</strong></div>
          <div><span>Y坐标</span><strong>{runtime.camera.y.toFixed(2)}</strong></div>
          <div><span>缩放</span><strong>{runtime.camera.zoom.toFixed(2)}x</strong></div>
          <div><span>旋转</span><strong>{runtime.camera.rotation.toFixed(1)}°</strong></div>
        </div>
      </section>
      <section>
        <h3>角色状态 (CHARACTERS)</h3>
        {runtime.characters.map((character) => (
          <div className="workspace-tools-snapshot__character" key={character.id}>
            <header>
              <strong>{character.name}</strong>
              <code>{character.x.toFixed(0)}% , {character.y.toFixed(0)}% <span>z:{character.z.toFixed(1)}</span></code>
            </header>
            <div className="workspace-tools-snapshot__bar">
              <span>缩放</span>
              <i><b style={{ width: `${Math.min(100, (character.scale / 2) * 100)}%` }} /></i>
              <code>{character.scale.toFixed(1)}</code>
            </div>
            <div className="workspace-tools-snapshot__bar" data-kind="opacity">
              <span>透明度</span>
              <i><b style={{ width: `${Math.min(100, character.opacity * 100)}%` }} /></i>
              <code>{character.opacity.toFixed(1)}</code>
            </div>
          </div>
        ))}
        {runtime.characters.length === 0 && <div className="workspace-tools-snapshot__empty">场景中没有角色</div>}
      </section>
    </div>
  );
};

export const WorkspaceToolsWindow: React.FC = () => {
  const [snapshot, setSnapshot] = useState<WorkspaceToolsSnapshot | null>(null);
  const [runtime, setRuntime] = useState<WorkspaceRuntimeSnapshot | null>(null);
  const [scriptDraft, setScriptDraft] = useState<WorkspaceToolsScriptDraft | null>(null);

  useEffect(() => {
    const bridge = window.aeonStageryAPI?.workspaceTools;
    if (!bridge) return;
    const unsubscribeSnapshot = bridge.onSnapshot((nextSnapshot) => {
      setSnapshot(nextSnapshot);
      setScriptDraft((current) => reconcileWorkspaceToolsScriptDraft(current, nextSnapshot));
    });
    const unsubscribeRuntime = bridge.onRuntime(setRuntime);
    const unsubscribeCommandResult = bridge.onCommandResult((result: WorkspaceToolsCommandResult) => {
      setScriptDraft((current) => {
        if (!current || current.pendingRequestId !== result.requestId) return current;
        if (!areWorkspaceToolsSceneIdentitiesEqual(current.sceneIdentity, result.sceneIdentity)) {
          return current;
        }
        if (!result.success) {
          return {
            ...current,
            dirty: true,
            error: result.error || '场景 JSON 应用失败',
            pendingRequestId: undefined,
            pendingSource: undefined,
          };
        }
        return {
          ...current,
          dirty: current.rawScript !== current.pendingSource,
          error: '',
          pendingRequestId: undefined,
          pendingSource: undefined,
        };
      });
    });
    void bridge.requestSnapshot();
    return () => {
      unsubscribeSnapshot();
      unsubscribeRuntime();
      unsubscribeCommandResult();
    };
  }, []);

  useEffect(() => {
    const theme = snapshot?.theme;
    if (!theme) return;
    if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [snapshot?.theme]);

  const issueCount = snapshot?.issues.length || 0;
  const activeTab = snapshot?.activeTab || 'characters';
  const title = useMemo(() => snapshot?.projectName || '工作区工具', [snapshot?.projectName]);
  const connectionStatus = !snapshot
    ? '等待主窗口连接'
    : snapshot.saveStatus === 'dirty'
      ? '有未保存更改'
      : '与主窗口同步';

  return (
    <div className="workspace-tools-window">
      <header className="workspace-tools-window__header">
        <div>
          <strong>{title}</strong>
          <span>{connectionStatus}</span>
        </div>
        <div>
          <button title="保存" aria-label="保存" disabled={!snapshot} onClick={() => sendCommand({ type: 'save' })}>
            <IconSave width={15} height={15} />
          </button>
        </div>
      </header>

      <nav className="workspace-tools-window__tabs" role="tablist" aria-label="工作区工具视图" aria-orientation="horizontal">
        <ToolTabButton tab="characters" activeTab={activeTab} label="角色" icon={<IconUser width={15} height={15} />} />
        <ToolTabButton tab="diagnostics" activeTab={activeTab} label="问题" icon={<IconError width={15} height={15} />} count={issueCount} />
        <ToolTabButton tab="script" activeTab={activeTab} label="JSON" icon={<IconFileText width={15} height={15} />} />
        <ToolTabButton tab="snapshot" activeTab={activeTab} label="快照" icon={<IconActivity width={15} height={15} />} />
      </nav>

      <main className="workspace-tools-window__body">
        {!snapshot && <div className="workspace-tools-window__empty">正在连接主窗口...</div>}
        {snapshot && (
          <div
            className="workspace-tools-window__view"
            key={activeTab}
            id={`workspace-tools-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`workspace-tools-tab-${activeTab}`}
          >
            {activeTab === 'characters' && <DetachedCharacterPanel snapshot={snapshot} runtime={runtime} />}
            {activeTab === 'diagnostics' && <DetachedDiagnosticsPanel snapshot={snapshot} />}
            {activeTab === 'script' && (
              scriptDraft ? (
                <DetachedScriptPanel
                  snapshot={snapshot}
                  draft={scriptDraft}
                  onDraftChange={setScriptDraft}
                />
              ) : (
                <div className="workspace-tools-window__empty">正在准备场景 JSON...</div>
              )
            )}
            {activeTab === 'snapshot' && <DetachedSnapshotPanel runtime={runtime} />}
          </div>
        )}
      </main>
    </div>
  );
};

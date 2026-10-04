import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TimelineAction } from './semanticTimelineTypes';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import { eventBus } from '../../api/events';
import { useDocumentStore, useSceneFileService } from '../context/AppContext';
import { useSettings } from '../SettingsStore';
import { useEditorState, useSemanticDocument } from '../store/storeHooks';
import {
  applyAeonStageryMonacoTheme,
  loadMonacoRuntime,
  MONACO_JSON_EDITOR_OPTIONS,
  type MonacoApi,
  type MonacoRuntime,
} from '../monaco/monacoRuntime';
import { buildSemanticTimelineReadModel } from './semanticTimelineReadModel';

function isDocumentEqual(a: CurrentSceneDocument | null, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function toRawSceneText(document: CurrentSceneDocument): string {
  return JSON.stringify(document, null, 2);
}

export const RawScriptTab: React.FC<{ action?: TimelineAction }> = ({ action }) => {
  const documentStore = useDocumentStore();
  const sceneFileService = useSceneFileService();
  const { document: semanticDocument, filePath } = useSemanticDocument();
  const { undo, redo } = useEditorState();
  const { settings } = useSettings();
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decorationsRef = useRef<string[]>([]);
  const lastSavedObjRef = useRef<any>(null);
  const pendingSaveTimeoutRef = useRef<any>(null);
  const pendingTextRef = useRef<string>('');
  const isProgrammaticChange = useRef(false);
  const [monacoRuntime, setMonacoRuntime] = useState<MonacoRuntime | null>(null);

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

  const flushPendingSave = useCallback(async () => {
    if (pendingSaveTimeoutRef.current) {
      clearTimeout(pendingSaveTimeoutRef.current);
      pendingSaveTimeoutRef.current = null;
    }
    if (!pendingTextRef.current) return;

    try {
      const parsed = JSON.parse(pendingTextRef.current);
      const result = await sceneFileService?.loadFromRawJson(pendingTextRef.current, filePath ?? undefined);
      if (!result || !result.success) {
        return;
      }
      lastSavedObjRef.current = parsed;
      pendingTextRef.current = '';
    } catch {
      // Ignore incomplete JSON while the user is typing.
    }
  }, [filePath, sceneFileService]);

  useEffect(() => {
    return () => {
      void flushPendingSave();
    };
  }, [flushPendingSave]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !semanticDocument) return;
    if (lastSavedObjRef.current && isDocumentEqual(semanticDocument, lastSavedObjRef.current)) {
      return;
    }

    const incomingText = toRawSceneText(semanticDocument);
    if (editor.getValue() !== incomingText) {
      isProgrammaticChange.current = true;
      editor.setValue(incomingText);
      isProgrammaticChange.current = false;
    }
  }, [semanticDocument]);

  const locateActionInEditor = useCallback((targetAction: TimelineAction | undefined) => {
    const editor = editorRef.current;
    const monacoApi = monacoRef.current;
    if (!editor || !monacoApi) return;

    if (!targetAction) {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
      return;
    }

    if (editor.hasWidgetFocus()) {
      return;
    }

    const model = editor.getModel();
    if (!model) return;

    let range: InstanceType<MonacoApi['Range']> | null = null;
    const semanticItems = buildSemanticTimelineReadModel(
      semanticDocument,
      documentStore.getCompiledSceneSnapshot(),
    );
    const semanticItem = targetAction._id
      ? semanticItems.find((item) => item.id === targetAction._id)
      : undefined;
    const sourceId = semanticItem?.companionId ?? semanticItem?.statementId;
    const idMatches = sourceId
      ? model.findMatches(`"id": "${sourceId}"`, false, false, false, null, true)
      : targetAction._id
        ? model.findMatches(`"_id": "${targetAction._id}"`, false, false, false, null, true)
      : [];

    if (idMatches.length > 0) {
      const idLine = idMatches[0].range.startLineNumber;
      const idText = model.getLineContent(idLine);
      const indentMatch = idText.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : '';
      const blockIndent = indent.substring(0, Math.max(0, indent.length - 2));

      let startLine = idLine;
      for (let i = idLine; i >= 1; i -= 1) {
        const lineText = model.getLineContent(i);
        if (lineText.trim() === '{' && lineText.startsWith(blockIndent)) {
          startLine = i;
          break;
        }
      }

      let endLine = idLine;
      for (let i = idLine; i <= model.getLineCount(); i += 1) {
        const lineText = model.getLineContent(i);
        if ((lineText.trim() === '}' || lineText.trim() === '},') && lineText.startsWith(blockIndent)) {
          endLine = i;
          break;
        }
      }

      range = new monacoApi.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
    }

    if (range) {
      editor.revealRangeInCenterIfOutsideViewport(range);
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [
        {
          range,
          options: {
            isWholeLine: true,
            className: 'monaco-action-highlight',
            linesDecorationsClassName: 'monaco-action-highlight-margin',
          },
        },
      ]);
    } else {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
    }
  }, [documentStore, semanticDocument]);

  useEffect(() => {
    locateActionInEditor(action);
  }, [action, locateActionInEditor]);

  useEffect(() => {
    applyAeonStageryMonacoTheme(monacoRef.current, settings.theme || 'dark');
  }, [settings.theme]);

  const handleEditorDidMount = (editor: any, monacoApi: any) => {
    editorRef.current = editor;
    monacoRef.current = monacoApi;

    applyAeonStageryMonacoTheme(monacoApi, settings.theme || 'dark');

    if (semanticDocument) {
      editor.setValue(toRawSceneText(semanticDocument));
    }

    if (action) {
      setTimeout(() => {
        locateActionInEditor(action);
      }, 80);
    }

    editor.onDidBlurEditorWidget(() => {
      void flushPendingSave();
    });

    editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => {
      void flushPendingSave();
      eventBus.emit('timeline:save');
    });

    editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyZ, () => {
      const model = editor.getModel();
      if (model && model.canUndo()) {
        editor.trigger('keyboard', 'undo', null);
      } else {
        undo();
      }
    });

    editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyY, () => {
      const model = editor.getModel();
      if (model && model.canRedo()) {
        editor.trigger('keyboard', 'redo', null);
      } else {
        redo();
      }
    });

    editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyMod.Shift | monacoApi.KeyCode.KeyZ, () => {
      const model = editor.getModel();
      if (model && model.canRedo()) {
        editor.trigger('keyboard', 'redo', null);
      } else {
        redo();
      }
    });
  };

  const handleEditorChange = (value: string | undefined) => {
    if (!value || isProgrammaticChange.current) return;
    pendingTextRef.current = value;

    if (pendingSaveTimeoutRef.current) {
      clearTimeout(pendingSaveTimeoutRef.current);
    }

    pendingSaveTimeoutRef.current = setTimeout(() => {
      void flushPendingSave();
    }, 500);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        .monaco-action-highlight { background: var(--accent-glow) !important; }
        .monaco-action-highlight-margin { border-left: 3px solid var(--accent-primary) !important; }
      `}</style>
      <div style={{ flex: 1, minHeight: 0 }}>
        {monacoRuntime ? (
          <monacoRuntime.Editor
            language="json"
            options={MONACO_JSON_EDITOR_OPTIONS}
            onMount={handleEditorDidMount}
            onChange={handleEditorChange}
          />
        ) : (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
              fontSize: 12,
            }}
          >
            正在加载脚本编辑器...
          </div>
        )}
      </div>
    </div>
  );
};

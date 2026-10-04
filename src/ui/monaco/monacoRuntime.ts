type MonacoApi = typeof import('monaco-editor/esm/vs/editor/editor.api.js');
type MonacoEditorComponent = typeof import('@monaco-editor/react').default;

export type MonacoRuntime = {
  Editor: MonacoEditorComponent;
  monaco: MonacoApi;
};

export type AeonStageryTheme = 'light' | 'dark' | 'system';

let monacoRuntimePromise: Promise<MonacoRuntime> | null = null;

export function loadMonacoRuntime(): Promise<MonacoRuntime> {
  monacoRuntimePromise ??= Promise.all([
    import('@monaco-editor/react'),
    import('monaco-editor/esm/vs/editor/editor.api.js'),
    import('monaco-editor/esm/vs/language/json/monaco.contribution.js'),
    import('monaco-editor/esm/vs/editor/editor.worker?worker'),
    import('monaco-editor/esm/vs/language/json/json.worker?worker'),
  ]).then(([editorModule, monacoApi, _jsonContribution, editorWorkerModule, jsonWorkerModule]) => {
    const Editor = editorModule.default;
    editorModule.loader.config({
      monaco: monacoApi as any,
    });

    const EditorWorker = editorWorkerModule.default;
    const JsonWorker = jsonWorkerModule.default;
    const monacoEnv = globalThis as typeof globalThis & {
      MonacoEnvironment?: {
        getWorker?: (_: unknown, label: string) => Worker;
      };
    };

    monacoEnv.MonacoEnvironment = {
      getWorker(_: unknown, label: string) {
        if (label === 'json') {
          return new JsonWorker();
        }
        return new EditorWorker();
      },
    };

    return { Editor, monaco: monacoApi };
  });

  return monacoRuntimePromise;
}

export function applyAeonStageryMonacoTheme(monacoApi: MonacoApi | null, theme: AeonStageryTheme): void {
  if (!monacoApi) return;

  const resolvedTheme = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  const isDark = resolvedTheme === 'dark';

  let bg = '#ffffff';
  let text = '#13151a';
  let cursor = '#4f46e5';
  let lineHighlight = '#00000008';

  if (isDark) {
    bg = '#1a1b24';
    text = '#f1eee9';
    cursor = '#d88c7a';
    lineHighlight = '#ffffff12';
  }

  monacoApi.editor.defineTheme('aeonstagery-theme', {
    base: isDark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.foreground': text,
      'editor.lineHighlightBackground': lineHighlight,
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': cursor,
      'editor.foldBackground': '#00000000',
      'editorError.foreground': '#ef4444',
      'editorWarning.foreground': '#f59e0b',
      'editorLineNumber.activeForeground': cursor,
    },
  });
  monacoApi.editor.setTheme('aeonstagery-theme');
}

export const MONACO_JSON_EDITOR_OPTIONS = {
  minimap: { enabled: true, scale: 0.75 },
  wordWrap: 'on' as const,
  fontSize: 12,
  formatOnPaste: true,
  scrollBeyondLastLine: false,
  tabSize: 2,
  smoothScrolling: true,
  foldingHighlight: false,
  automaticLayout: true,
};

export type { MonacoApi };

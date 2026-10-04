import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type AiWorkbenchMode = 'prose' | 'enhance';

export type AiWorkbenchModeDirection = 'left' | 'right' | null;

type AiWorkbenchModeContextValue = {
  mode: AiWorkbenchMode;
  setMode: (mode: AiWorkbenchMode) => void;
  direction: AiWorkbenchModeDirection;
};

const AiWorkbenchModeContext = createContext<AiWorkbenchModeContextValue | null>(null);

const MODE_ORDER: AiWorkbenchMode[] = ['prose', 'enhance'];

export function useAiWorkbenchMode(): AiWorkbenchModeContextValue | null {
  return useContext(AiWorkbenchModeContext);
}

export function AiWorkbenchModeProvider({
  children,
  initialMode = 'prose',
}: {
  children: ReactNode;
  initialMode?: AiWorkbenchMode;
}) {
  const [mode, setModeState] = useState<AiWorkbenchMode>(initialMode);
  const [direction, setDirection] = useState<AiWorkbenchModeDirection>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const setMode = useCallback((next: AiWorkbenchMode) => {
    const current = modeRef.current;
    if (next === current) return;
    const from = MODE_ORDER.indexOf(current);
    const to = MODE_ORDER.indexOf(next);
    setDirection(to > from ? 'left' : 'right');
    setModeState(next);
  }, []);

  return (
    <AiWorkbenchModeContext.Provider value={{ mode, setMode, direction }}>
      {children}
    </AiWorkbenchModeContext.Provider>
  );
}

export function AiWorkbenchModeSwitch() {
  const ctx = useAiWorkbenchMode();
  if (!ctx) return null;

  const { mode, setMode } = ctx;

  return (
    <div
      className={`ai-prose-mode-switch ${mode === 'enhance' ? 'is-enhance' : 'is-prose'}`}
      role="tablist"
      aria-label="AI 工作台模式"
    >
      <span className="ai-prose-mode-switch__thumb" aria-hidden="true" />
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'prose'}
        className={`ai-prose-mode-switch__btn ${mode === 'prose' ? 'is-active' : ''}`}
        onClick={() => setMode('prose')}
      >
        正文铺戏
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'enhance'}
        className={`ai-prose-mode-switch__btn ${mode === 'enhance' ? 'is-active' : ''}`}
        onClick={() => setMode('enhance')}
      >
        正式增强
      </button>
    </div>
  );
}

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { AI_PROSE_EFFORTS, DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL } from '../../api/types/ai-prose-authoring';
import {
  MISSING_CREDENTIAL_GUIDE_MESSAGE,
  shouldRequireAiCredentialSetup,
} from '../../services/ai-authoring/aiErrorPresentation';

interface AiProseSettingsShape {
  baseUrl?: string;
  defaultModel?: string;
  projectAgentModel?: string;
  effort?: string;
}

interface StoredSettingsShape {
  theme?: string;
  aiProse?: AiProseSettingsShape;
}

function readStoredSettings(): StoredSettingsShape {
  try {
    const raw = localStorage.getItem('aeonstagery_settings');
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredSettingsShape;
    return {
      theme: typeof parsed.theme === 'string' ? parsed.theme : undefined,
      aiProse: parsed.aiProse && typeof parsed.aiProse === 'object' ? parsed.aiProse : undefined,
    };
  } catch {
    return {};
  }
}

function effectiveModelFrom(settings: StoredSettingsShape): string {
  const aiProse = settings.aiProse;
  const projectAgentModel = aiProse?.projectAgentModel?.trim();
  return projectAgentModel && projectAgentModel.length > 0
    ? projectAgentModel
    : (aiProse?.defaultModel?.trim() || DEFAULT_AI_MODEL);
}

function effectiveEffortFrom(settings: StoredSettingsShape): string {
  const effort = settings.aiProse?.effort;
  return effort && AI_PROSE_EFFORTS.includes(effort as (typeof AI_PROSE_EFFORTS)[number])
    ? effort
    : 'medium';
}

function readTheme(): 'light' | 'dark' | 'system' {
  const theme = readStoredSettings().theme;
  return theme === 'light' || theme === 'dark' ? theme : 'system';
}

function applyTheme(theme: 'light' | 'dark' | 'system') {
  if (typeof document === 'undefined') return;
  const isDark = theme === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false)
    : theme === 'dark';
  if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}

export function useAgentWindowSettings(setStartError: Dispatch<SetStateAction<string | null>>) {
  const bridge = window.aeonStageryAPI?.projectAgent;
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelListState, setModelListState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [modelList, setModelList] = useState<string[]>([]);
  const [effectiveModel, setEffectiveModel] = useState(() => (
    effectiveModelFrom(readStoredSettings())
  ));
  const [effort, setEffort] = useState(() => effectiveEffortFrom(readStoredSettings()));
  const [baseUrl, setBaseUrl] = useState(() => readStoredSettings().aiProse?.baseUrl);
  const [credentialConfigured, setCredentialConfigured] = useState(false);
  const [credentialChecked, setCredentialChecked] = useState(false);
  const modelFetchingRef = useRef(false);
  useEffect(() => {
    applyTheme(readTheme());
    let active = true;
    const refreshCredentialStatus = () => {
      const getCredentialStatus = window.aeonStageryAPI?.aiProse?.getCredentialStatus;
      if (typeof getCredentialStatus !== 'function') {
        setCredentialConfigured(false);
        setCredentialChecked(false);
        return;
      }
      void getCredentialStatus()
        .then((status) => {
          if (!active) return;
          setCredentialConfigured(status.configured);
          setCredentialChecked(true);
          if (status.configured) {
            setStartError((current) => (current === MISSING_CREDENTIAL_GUIDE_MESSAGE ? null : current));
          }
        })
        .catch(() => {
          if (!active) return;
          setCredentialConfigured(false);
          setCredentialChecked(false);
        });
    };
    refreshCredentialStatus();
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'aeonstagery_settings' || event.key === null) {
        const stored = readStoredSettings();
        applyTheme(readTheme());
        setEffectiveModel(effectiveModelFrom(stored));
        setEffort(effectiveEffortFrom(stored));
        setBaseUrl(stored.aiProse?.baseUrl);
        refreshCredentialStatus();
      }
    };
    const onFocus = () => {
      const stored = readStoredSettings();
      setEffectiveModel(effectiveModelFrom(stored));
      setEffort(effectiveEffortFrom(stored));
      setBaseUrl(stored.aiProse?.baseUrl);
      refreshCredentialStatus();
    };
    const onSystemTheme = () => applyTheme(readTheme());
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', onSystemTheme);
    return () => {
      active = false;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
      window.matchMedia?.('(prefers-color-scheme: dark)')?.removeEventListener?.('change', onSystemTheme);
    };
  }, [setStartError]);

  const needsCredentialSetup = shouldRequireAiCredentialSetup({
    credentialChecked,
    credentialConfigured,
    endpoint: baseUrl,
  });

  const toggleModelMenu = () => {
    const next = !modelMenuOpen;
    setModelMenuOpen(next);
    if (next) {
      fetchModels();
    }
  };

  const fetchModels = () => {
    if (modelFetchingRef.current) return;
    modelFetchingRef.current = true;
    setModelListState('loading');
    const settings = readStoredSettings();
    const baseUrl = settings.aiProse?.baseUrl?.trim() || DEFAULT_AI_BASE_URL;
    const aiBridge = window.aeonStageryAPI?.aiProse;
    if (!aiBridge?.listModels) {
      modelFetchingRef.current = false;
      setModelListState('error');
      return;
    }
    void aiBridge.listModels(baseUrl || '').then((result) => {
      modelFetchingRef.current = false;
      if (result.success) {
        setModelList(result.models);
        setModelListState('ready');
      } else {
        setModelListState('error');
      }
    }).catch(() => {
      modelFetchingRef.current = false;
      setModelListState('error');
    });
  };

  const selectModel = (model: string) => {
    setModelMenuOpen(false);
    void bridge?.setAgentModel(model).then((result) => {
      if (!result.ok) {
        setStartError(result.error || '模型切换失败。');
      }
    });
  };

  const selectEffort = (next: string) => {
    if (!AI_PROSE_EFFORTS.includes(next as (typeof AI_PROSE_EFFORTS)[number])) return;
    setEffort(next);
    void bridge?.setEffort(next).then((result) => {
      if (!result.ok) {
        setStartError(result.error || 'Effort 调整失败。');
      }
    });
  };

  return {
    needsCredentialSetup,
    modelMenuOpen,
    setModelMenuOpen,
    modelListState,
    modelList,
    effectiveModel,
    effort,
    toggleModelMenu,
    fetchModels,
    selectModel,
    selectEffort,
  };
}

export type AgentWindowSettings = ReturnType<typeof useAgentWindowSettings>;

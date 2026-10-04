export type GptSovitsPromptLanguage = 'zh' | 'ja' | 'en' | 'ko' | 'yue' | 'auto';

export interface GptSovitsLocalConfig {
  apiHost: string;
  apiPort: number;
  rootPath: string;
  modelRoots?: string[];
  referenceRoots?: string[];
}

export interface GptSovitsVoicePreset {
  id: string;
  name: string;
  gptWeightsPath: string;
  sovitsWeightsPath: string;
  refAudioPath: string;
  promptText: string;
  promptLang: GptSovitsPromptLanguage | string;
  textLang: GptSovitsPromptLanguage | string;
  speed: number;
}

export interface VoiceGenerationProjectConfig {
  gptSovits?: {
    selectedPresetId?: string;
    presets: GptSovitsVoicePreset[];
  };
}

export type GptSovitsProcessState = 'not-configured' | 'stopped' | 'starting' | 'running' | 'unreachable' | 'error';

export interface GptSovitsStatusResult {
  success: boolean;
  state: GptSovitsProcessState;
  configured: boolean;
  apiBaseUrl?: string;
  pid?: number;
  logs?: string[];
  error?: string;
}

export interface GptSovitsGenerateDialogueVoiceRequest {
  config: GptSovitsLocalConfig;
  preset: GptSovitsVoicePreset;
  text: string;
  projectRootPath: string;
  sceneId: string;
  actionId: string;
}

export interface GptSovitsGenerateDialogueVoiceResult {
  success: boolean;
  relativePath?: string;
  absolutePath?: string;
  error?: string;
}

export interface GptSovitsStartResult extends GptSovitsStatusResult {}

export interface GptSovitsStopResult {
  success: boolean;
  state: GptSovitsProcessState;
  logs?: string[];
  error?: string;
}

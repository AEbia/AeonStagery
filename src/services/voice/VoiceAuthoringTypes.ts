export const VOICE_LIBRARY_SCHEMA_VERSION = 1;

export type VoiceLanguage = 'zh' | 'ja' | 'en' | 'ko' | 'yue' | 'auto' | string;

export interface LocalModelLocator {
  absolutePath: string;
  fileName: string;
  relativePathSuffix?: string;
  size?: number;
  modifiedAt?: number;
}

export interface VoiceInferenceOptions {
  textLang: VoiceLanguage;
  speed: number;
  topK?: number;
  topP?: number;
  temperature?: number;
  batchSize?: number;
  batchThreshold?: number;
  splitBucket?: boolean;
  fragmentInterval?: number;
  parallelInfer?: boolean;
  textSplitMethod?: string;
  repetitionPenalty?: number;
  sampleSteps?: number;
  superSampling?: boolean;
  seed?: number;
}

export interface LocalVoiceReference {
  id: string;
  label: string;
  managedPath: string;
  role: 'primary' | 'auxiliary';
  promptText: string;
  promptLang: VoiceLanguage;
  tags?: string[];
}

export interface LocalVoicePreset {
  id: string;
  name: string;
  gptModel: LocalModelLocator;
  sovitsModel: LocalModelLocator;
  references: LocalVoiceReference[];
  inferenceDefaults: VoiceInferenceOptions;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VoiceLibraryDocument {
  schemaVersion: typeof VOICE_LIBRARY_SCHEMA_VERSION;
  presets: LocalVoicePreset[];
}

export interface VoiceCatalogIssue {
  code: 'missing-root' | 'unreadable-root' | 'limit-reached' | 'time-limit-reached' | 'invalid-entry';
  root: string;
  message: string;
}

export interface VoiceCatalogModel extends LocalModelLocator {
  kind: 'gpt' | 'sovits';
  sourceRoot: string;
}

export interface VoiceCatalogReference {
  absolutePath: string;
  fileName: string;
  sourceRoot: string;
  pathTags: string[];
  size?: number;
  modifiedAt?: number;
  transcriptTrusted: false;
}

export interface VoiceCatalogResult {
  models: VoiceCatalogModel[];
  references: VoiceCatalogReference[];
  issues: VoiceCatalogIssue[];
  truncated: boolean;
}

export interface ScanVoiceCatalogRequest {
  gptRoot: string;
  modelRoots?: string[];
  referenceRoots?: string[];
  maxEntries?: number;
  maxDurationMs?: number;
}

export interface SaveLocalVoicePresetRequest {
  preset: Omit<LocalVoicePreset, 'createdAt' | 'updatedAt'> & Partial<Pick<LocalVoicePreset, 'createdAt' | 'updatedAt'>>;
  references?: Array<{ referenceId: string; sourcePath: string }>;
  mode: 'create' | 'save-as' | 'update';
}

export interface LocalVoicePresetResult {
  success: boolean;
  preset?: LocalVoicePreset;
  error?: string;
}

export interface PublishTemplateVoiceProfileResult {
  success: boolean;
  templateId?: string;
  profileId?: string;
  manifestPath?: string;
  error?: string;
}

export interface VoiceLibraryResult {
  success: boolean;
  library?: VoiceLibraryDocument;
  error?: string;
}

export interface GenerateVoiceCandidateRequest {
  config: { apiHost: string; apiPort: number; rootPath: string };
  sessionId: string;
  candidateId: string;
  text: string;
  gptModelPath: string;
  sovitsModelPath: string;
  referenceAudioPath: string;
  auxiliaryReferenceAudioPaths?: string[];
  promptText: string;
  promptLang: VoiceLanguage;
  options: VoiceInferenceOptions;
}

export interface VoiceCandidateResult {
  success: boolean;
  candidateId?: string;
  absolutePath?: string;
  seed?: number;
  byteLength?: number;
  durationSeconds?: number;
  error?: string;
}

export interface ProjectModelSelector {
  fileName: string;
  relativePathSuffix?: string;
}

export interface ProjectVoiceProfile {
  id: string;
  name: string;
  gptModel: ProjectModelSelector;
  sovitsModel: ProjectModelSelector;
  references: Array<Omit<LocalVoiceReference, 'managedPath'> & { projectPath: string }>;
  inferenceDefaults: VoiceInferenceOptions;
}

export interface TemplateVoiceProfile {
  id: string;
  name: string;
  gptModel: ProjectModelSelector;
  sovitsModel: ProjectModelSelector;
  references: Array<Omit<LocalVoiceReference, 'managedPath'> & { assetId: string }>;
  inferenceDefaults: VoiceInferenceOptions;
  file?: string;
}

export function validateLocalVoicePreset(preset: LocalVoicePreset): string | null {
  if (!preset.id.trim()) return '音色配置缺少 ID。';
  if (!preset.name.trim()) return '音色配置缺少名称。';
  if (!preset.gptModel.absolutePath || !preset.gptModel.fileName) return '音色配置缺少 GPT 模型。';
  if (!preset.sovitsModel.absolutePath || !preset.sovitsModel.fileName) return '音色配置缺少 SoVITS 模型。';
  const primary = preset.references.find((reference) => reference.role === 'primary');
  if (!primary) return '音色配置缺少主参考音频。';
  if (!primary.promptText.trim() || !primary.promptLang.trim()) return '保存前必须确认主参考音频的 prompt 文本和语言。';
  if (!primary.managedPath.trim()) return '主参考音频尚未进入托管语音库。';
  return null;
}

export function createModelSelector(locator: LocalModelLocator): ProjectModelSelector {
  return { fileName: locator.fileName, relativePathSuffix: locator.relativePathSuffix };
}

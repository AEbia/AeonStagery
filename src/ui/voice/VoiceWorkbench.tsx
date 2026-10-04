import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectState } from '../../api/types/project';
import type { VoiceAuthoringService } from '../../services/voice/VoiceAuthoringService';
import type {
  LocalVoicePreset,
  VoiceCatalogModel,
  VoiceCatalogReference,
  VoiceCandidateResult,
} from '../../services/voice/VoiceAuthoringTypes';
import type { GptSovitsLocalConfig } from '../../services/voice/GptSovitsTypes';
import { IconFolder, IconPlay, IconRefresh, IconSave, IconVolume2, IconX } from '../icons';
import { FormSelect } from '../FormSelect';
import { InfoTip } from '../Tooltip';
import { showToast } from '../Toast';
import { useModalDialog } from '../hooks/useModalDialog';

export interface VoiceWorkbenchContext {
  mode: 'free' | 'dialogue';
  statementId?: string;
  sceneId?: string;
  characterId?: string;
  characterName?: string;
  voiceProfileId?: string;
  text?: string;
}

interface Candidate extends Required<Pick<VoiceCandidateResult, 'candidateId' | 'absolutePath' | 'seed'>> {
  text: string;
  createdAt: number;
  durationSeconds?: number;
}

export function VoiceWorkbench({
  isOpen,
  context,
  project,
  config,
  service,
  onClose,
}: {
  isOpen: boolean;
  context: VoiceWorkbenchContext;
  project: ProjectState | null;
  config: GptSovitsLocalConfig;
  service: VoiceAuthoringService;
  onClose: () => void;
}) {
  const sessionIdRef = useRef(`voice-${crypto.randomUUID?.() ?? Date.now()}`);
  const projectIdRef = useRef(project?.metadata.projectId ?? null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [presets, setPresets] = useState<LocalVoicePreset[]>([]);
  const [models, setModels] = useState<VoiceCatalogModel[]>([]);
  const [references, setReferences] = useState<VoiceCatalogReference[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [assignedDefaultName, setAssignedDefaultName] = useState('');
  const [gptPath, setGptPath] = useState('');
  const [sovitsPath, setSovitsPath] = useState('');
  const [referencePath, setReferencePath] = useState('');
  const [auxiliaryReferencePaths, setAuxiliaryReferencePaths] = useState<string[]>([]);
  const [promptText, setPromptText] = useState('');
  const [promptLang, setPromptLang] = useState('all_ja');
  const [refFree, setRefFree] = useState(false);
  const [textLang, setTextLang] = useState('all_ja');
  const [text, setText] = useState('');
  const [speed, setSpeed] = useState(1);
  const [temperature, setTemperature] = useState(1);
  const [topK, setTopK] = useState(5);
  const [topP, setTopP] = useState(1);
  const [textSplitMethod, setTextSplitMethod] = useState('cut5');
  const [batchSize, setBatchSize] = useState(1);
  const [batchThreshold, setBatchThreshold] = useState(0.75);
  const [splitBucket, setSplitBucket] = useState(true);
  const [fragmentInterval, setFragmentInterval] = useState(0.3);
  const [parallelInfer, setParallelInfer] = useState(true);
  const [repetitionPenalty, setRepetitionPenalty] = useState(1.35);
  const [sampleSteps, setSampleSteps] = useState(32);
  const [superSampling, setSuperSampling] = useState(false);
  const [seed, setSeed] = useState(-1);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const targetTextRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useModalDialog(onClose, isOpen, targetTextRef);

  useEffect(() => {
    if (!isOpen) return;
    if (context.mode === 'dialogue') setText(context.text ?? '');
    setAssignedDefaultName('');
  }, [context.statementId, context.characterId, context.mode, context.text, isOpen]);

  useEffect(() => () => stopPreview(), []);

  useEffect(() => {
    const nextProjectId = project?.metadata.projectId ?? null;
    if (projectIdRef.current === nextProjectId) return;
    const previousSession = sessionIdRef.current;
    projectIdRef.current = nextProjectId;
    sessionIdRef.current = `voice-${crypto.randomUUID?.() ?? Date.now()}`;
    setCandidates([]);
    stopPreview();
    void service.discardSession(previousSession);
  }, [project?.metadata.projectId, service]);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    void Promise.all([
      service.listPresets(),
      service.scanCatalog({
        gptRoot: config.rootPath,
        modelRoots: config.modelRoots,
        referenceRoots: config.referenceRoots,
      }),
    ]).then(([libraryResult, catalog]) => {
      if (libraryResult.success) setPresets(libraryResult.library?.presets ?? []);
      else showToast(libraryResult.error || '读取用户语音库失败。', 'warning');
      setModels(catalog.models);
      setReferences(catalog.references);
      if (catalog.issues.length) showToast(`语音目录扫描完成，${catalog.issues.length} 个目录需要检查。`, 'warning');
    }).catch((error) => showToast(`加载语音工作台失败：${String(error)}`, 'error')).finally(() => setLoading(false));
  }, [config.modelRoots, config.referenceRoots, config.rootPath, isOpen, service]);

  const gptModels = useMemo(() => models.filter((model) => model.kind === 'gpt'), [models]);
  const sovitsModels = useMemo(() => models.filter((model) => model.kind === 'sovits'), [models]);
  const referenceGroups = useMemo(() => groupReferencesByDirectory(references), [references]);
  const referenceOptions = useMemo(() => [
    { value: '', label: '选择参考' },
    ...referenceGroups.flatMap(({ directory, references: groupedReferences }) => groupedReferences.map((reference) => ({
      ...referenceSelectOption(reference),
      group: directory,
    }))),
    ...(referencePath && !references.some((reference) => reference.absolutePath === referencePath)
      ? [externalReferenceSelectOption(referencePath)]
      : []),
  ], [referenceGroups, referencePath, references]);
  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId);
  const matchingPresets = useMemo(() => {
    if (!gptPath && !sovitsPath) return [];
    return presets.filter((preset) => (
      (!gptPath || modelLocatorMatchesPath(preset.gptModel, gptPath))
      && (!sovitsPath || modelLocatorMatchesPath(preset.sovitsModel, sovitsPath))
    ));
  }, [gptPath, presets, sovitsPath]);
  const projectProfile = project?.metadata.voiceProfiles?.find((profile) => profile.id === context.voiceProfileId);
  const projectGptMatch = projectProfile ? models.find((model) => model.kind === 'gpt' && model.fileName === projectProfile.gptModel.fileName) : undefined;
  const projectSovitsMatch = projectProfile ? models.find((model) => model.kind === 'sovits' && model.fileName === projectProfile.sovitsModel.fileName) : undefined;
  const canGenerate = !!text.trim() && !!gptPath && !!sovitsPath && !!referencePath && (refFree || !!promptText.trim()) && !busy;
  const characterLabel = context.characterName?.trim() || context.characterId || '未指定角色';
  const defaultPresetName = context.mode === 'dialogue' && context.characterId
    ? `${characterLabel} 音色`
    : gptPath ? `${modelStem(fileName(gptPath))} 音色` : '通用音色';

  const refreshCatalog = async () => {
    setLoading(true);
    try {
      const catalog = await service.scanCatalog({
        gptRoot: config.rootPath,
        modelRoots: config.modelRoots,
        referenceRoots: config.referenceRoots,
      });
      setModels(catalog.models);
      setReferences(catalog.references);
      if (catalog.issues.length) showToast(`语音目录扫描完成，${catalog.issues.length} 个目录需要检查。`, 'warning');
      else showToast(`已刷新：${catalog.models.length} 个模型，${catalog.references.length} 个参考音频。`, 'success');
    } catch (error) {
      showToast(`刷新语音目录失败：${String(error)}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const selectPreset = useCallback(async (presetId: string) => {
    setSelectedPresetId(presetId);
    const preset = presets.find((item) => item.id === presetId);
    if (!preset) {
      setPresetName('');
      return;
    }
    setPresetName(preset.name);
    const primary = preset.references.find((reference) => reference.role === 'primary');
    setGptPath(preset.gptModel.absolutePath);
    setSovitsPath(preset.sovitsModel.absolutePath);
    setPromptText(primary?.promptText ?? '');
    setPromptLang(primary?.promptLang ?? 'all_ja');
    setTextLang(preset.inferenceDefaults.textLang);
    setSpeed(preset.inferenceDefaults.speed);
    setTemperature(preset.inferenceDefaults.temperature ?? 1);
    setTopK(preset.inferenceDefaults.topK ?? 5);
    setTopP(preset.inferenceDefaults.topP ?? 1);
    setTextSplitMethod(preset.inferenceDefaults.textSplitMethod ?? 'cut5');
    setBatchSize(preset.inferenceDefaults.batchSize ?? 1);
    setBatchThreshold(preset.inferenceDefaults.batchThreshold ?? 0.75);
    setSplitBucket(preset.inferenceDefaults.splitBucket ?? true);
    setFragmentInterval(preset.inferenceDefaults.fragmentInterval ?? 0.3);
    setParallelInfer(preset.inferenceDefaults.parallelInfer ?? true);
    setRepetitionPenalty(preset.inferenceDefaults.repetitionPenalty ?? 1.35);
    setSampleSteps(preset.inferenceDefaults.sampleSteps ?? 32);
    setSuperSampling(preset.inferenceDefaults.superSampling ?? false);
    setSeed(preset.inferenceDefaults.seed ?? -1);
    setRefFree(false);
    if (primary) {
      const resolved = await service.resolveReference(preset.id, primary.id);
      if (resolved.success && resolved.absolutePath) setReferencePath(resolved.absolutePath);
      else showToast(resolved.error || '托管参考音频不可用。', 'error');
    }
    const auxiliary = preset.references.filter((reference) => reference.role === 'auxiliary');
    const resolvedAuxiliary = await Promise.all(auxiliary.map((reference) => service.resolveReference(preset.id, reference.id)));
    setAuxiliaryReferencePaths(resolvedAuxiliary.flatMap((result) => result.success && result.absolutePath ? [result.absolutePath] : []));
  }, [presets, service]);

  useEffect(() => {
    if (!isOpen || context.mode !== 'dialogue' || !context.voiceProfileId || selectedPresetId) return;
    const localDefault = presets.find((preset) => preset.id === context.voiceProfileId);
    if (localDefault) void selectPreset(localDefault.id);
  }, [context.mode, context.voiceProfileId, isOpen, presets, selectPreset, selectedPresetId]);

  useEffect(() => {
    if (!projectProfile || !projectGptMatch || !projectSovitsMatch || gptPath || sovitsPath) return;
    setGptPath(projectGptMatch.absolutePath);
    setSovitsPath(projectSovitsMatch.absolutePath);
    setTextLang(projectProfile.inferenceDefaults.textLang);
    setSpeed(projectProfile.inferenceDefaults.speed);
    setTemperature(projectProfile.inferenceDefaults.temperature ?? 1);
    setTopK(projectProfile.inferenceDefaults.topK ?? 5);
    setTopP(projectProfile.inferenceDefaults.topP ?? 1);
    setTextSplitMethod(projectProfile.inferenceDefaults.textSplitMethod ?? 'cut5');
    setBatchSize(projectProfile.inferenceDefaults.batchSize ?? 1);
    setBatchThreshold(projectProfile.inferenceDefaults.batchThreshold ?? 0.75);
    setSplitBucket(projectProfile.inferenceDefaults.splitBucket ?? true);
    setFragmentInterval(projectProfile.inferenceDefaults.fragmentInterval ?? 0.3);
    setParallelInfer(projectProfile.inferenceDefaults.parallelInfer ?? true);
    setRepetitionPenalty(projectProfile.inferenceDefaults.repetitionPenalty ?? 1.35);
    setSampleSteps(projectProfile.inferenceDefaults.sampleSteps ?? 32);
    setSuperSampling(projectProfile.inferenceDefaults.superSampling ?? false);
    setSeed(projectProfile.inferenceDefaults.seed ?? -1);
    const primary = projectProfile.references.find((reference) => reference.role === 'primary');
    if (primary) {
      setPromptText(primary.promptText);
      setPromptLang(primary.promptLang);
      void service.resolveProjectReference(primary.projectPath).then(setReferencePath).catch((error) => showToast(`项目参考音频不可用：${String(error)}`, 'error'));
    }
    const auxiliary = projectProfile.references.filter((reference) => reference.role === 'auxiliary');
    void Promise.all(auxiliary.map((reference) => service.resolveProjectReference(reference.projectPath)))
      .then(setAuxiliaryReferencePaths)
      .catch((error) => showToast(`项目辅助参考音频不可用：${String(error)}`, 'error'));
  }, [gptPath, projectGptMatch, projectProfile, projectSovitsMatch, service, sovitsPath]);

  const resetPresetDetails = () => {
    setSelectedPresetId('');
    setPresetName('');
    setReferencePath('');
    setAuxiliaryReferencePaths([]);
    setPromptText('');
    setRefFree(false);
  };

  const selectGptModel = (pathValue: string) => {
    const stem = modelStem(fileName(pathValue));
    const suggested = pathValue ? sovitsModels.find((model) => modelStem(model.fileName) === stem) : undefined;
    const nextSovitsPath = suggested?.absolutePath ?? sovitsPath;
    setGptPath(pathValue);
    if (suggested) setSovitsPath(suggested.absolutePath);
    resetPresetDetails();
    const compatible = presets.filter((preset) => modelLocatorMatchesPath(preset.gptModel, pathValue) && modelLocatorMatchesPath(preset.sovitsModel, nextSovitsPath));
    if (compatible.length === 1) void selectPreset(compatible[0].id);
  };

  const selectSovitsModel = (pathValue: string) => {
    const stem = modelStem(fileName(pathValue));
    const suggested = pathValue ? gptModels.find((model) => modelStem(model.fileName) === stem) : undefined;
    const nextGptPath = suggested?.absolutePath ?? gptPath;
    setSovitsPath(pathValue);
    if (suggested) setGptPath(suggested.absolutePath);
    resetPresetDetails();
    const compatible = presets.filter((preset) => modelLocatorMatchesPath(preset.gptModel, nextGptPath) && modelLocatorMatchesPath(preset.sovitsModel, pathValue));
    if (compatible.length === 1) void selectPreset(compatible[0].id);
  };

  const selectPrimaryReference = (pathValue: string) => {
    setReferencePath(pathValue);
    setAuxiliaryReferencePaths((current) => current.filter((item) => item !== pathValue));
    setPromptText(pathValue ? referencePromptText(pathValue) : '');
  };

  const pickReferenceAudio = async (multiple: boolean) => {
    try {
      const paths = await service.pickReferenceAudio(multiple);
      if (paths.length === 0) return;
      if (multiple) {
        setAuxiliaryReferencePaths((current) => uniquePaths([...current, ...paths]).filter((item) => item !== referencePath));
      } else {
        selectPrimaryReference(paths[0]);
      }
      void refreshCatalog();
    } catch (error) {
      showToast(`选择参考音频失败：${String(error)}`, 'error');
    }
  };

  const addAuxiliaryReference = (pathValue: string) => {
    if (!pathValue || pathValue === referencePath) return;
    setAuxiliaryReferencePaths((current) => uniquePaths([...current, pathValue]));
  };

  const replaceAuxiliaryReference = (index: number, pathValue: string) => {
    setAuxiliaryReferencePaths((current) => {
      if (!pathValue || pathValue === referencePath) return current.filter((_, currentIndex) => currentIndex !== index);
      return uniquePaths(current.map((item, currentIndex) => currentIndex === index ? pathValue : item));
    });
  };

  const generate = async () => {
    if (!canGenerate) return;
    setBusy(true);
    const candidateId = `candidate-${Date.now()}`;
    let result: VoiceCandidateResult;
    try {
      result = await service.generateCandidate({
        config,
        sessionId: sessionIdRef.current,
        candidateId,
        text: text.trim(),
        gptModelPath: gptPath,
        sovitsModelPath: sovitsPath,
        referenceAudioPath: referencePath,
        auxiliaryReferenceAudioPaths: auxiliaryReferencePaths,
        promptText: refFree ? '' : promptText.trim(),
        promptLang,
        options: { textLang, speed, temperature, topK, topP, batchSize, batchThreshold, splitBucket, fragmentInterval, parallelInfer, textSplitMethod, repetitionPenalty, sampleSteps, superSampling, seed },
      });
    } catch (error) {
      result = { success: false, error: String(error) };
    } finally {
      setBusy(false);
    }
    if (!result.success || !result.absolutePath || !result.candidateId || result.seed === undefined) {
      showToast(result.error || '候选生成失败。', 'error');
      return;
    }
    const candidate = { candidateId: result.candidateId, absolutePath: result.absolutePath, seed: result.seed, durationSeconds: result.durationSeconds, text: text.trim(), createdAt: Date.now() };
    setCandidates((current) => [candidate, ...current]);
    play(candidate.absolutePath);
  };

  const savePreset = async (assignToCharacter: boolean) => {
    if (!gptPath || !sovitsPath || !referencePath || !promptText.trim()) {
      showToast('请完整选择模型、参考音频并确认 prompt。', 'warning');
      return;
    }
    const id = `voice-${Date.now()}`;
    const referenceId = 'primary';
    const result = await service.savePreset({
      mode: 'create',
      preset: {
        id,
        name: presetName.trim() || defaultPresetName,
        gptModel: { absolutePath: gptPath, fileName: fileName(gptPath) },
        sovitsModel: { absolutePath: sovitsPath, fileName: fileName(sovitsPath) },
        references: [
          { id: referenceId, label: fileName(referencePath), managedPath: 'pending', role: 'primary', promptText: promptText.trim(), promptLang },
          ...auxiliaryReferencePaths.filter((pathValue) => pathValue !== referencePath).map((pathValue, index) => ({
            id: `auxiliary-${index + 1}`, label: fileName(pathValue), managedPath: 'pending', role: 'auxiliary' as const, promptText: '', promptLang,
          })),
        ],
        inferenceDefaults: { textLang, speed, temperature, topK, topP, batchSize, batchThreshold, splitBucket, fragmentInterval, parallelInfer, textSplitMethod, repetitionPenalty, sampleSteps, superSampling, seed },
      },
      references: [
        { referenceId, sourcePath: referencePath },
        ...auxiliaryReferencePaths.filter((pathValue) => pathValue !== referencePath).map((pathValue, index) => ({ referenceId: `auxiliary-${index + 1}`, sourcePath: pathValue })),
      ],
    });
    if (!result.success || !result.preset) {
      showToast(result.error || '保存用户音色失败。', 'error');
      return;
    }
    setPresets((current) => [...current, result.preset!]);
    setSelectedPresetId(result.preset.id);
    setPresetName(result.preset.name);
    if (assignToCharacter && context.characterId) {
      const assignment = await service.setCharacterDefault(result.preset, context.characterId);
      if (!assignment.success) {
        showToast(`音色已保存，但角色默认设置失败：${assignment.error || '未知错误'}`, 'warning');
        return;
      }
      setAssignedDefaultName(result.preset.name);
      showToast(`已保存并设为“${characterLabel}”的默认音色。`, 'success');
      return;
    }
    showToast('已保存为通用音色。', 'success');
  };

  const renamePreset = async () => {
    if (!selectedPreset) return;
    const name = window.prompt('音色名称', selectedPreset.name)?.trim();
    if (!name || name === selectedPreset.name) return;
    const result = await service.renamePreset(selectedPreset.id, name);
    if (!result.success || !result.preset) { showToast(result.error || '重命名失败。', 'error'); return; }
    setPresets((current) => current.map((item) => item.id === result.preset!.id ? result.preset! : item));
  };

  const duplicatePreset = async () => {
    if (!selectedPreset) return;
    const result = await service.duplicatePreset(selectedPreset.id);
    if (!result.success || !result.preset) { showToast(result.error || '复制音色失败。', 'error'); return; }
    setPresets((current) => [...current, result.preset!]);
    setSelectedPresetId(result.preset.id);
    const primary = result.preset.references.find((reference) => reference.role === 'primary');
    if (primary) {
      const resolved = await service.resolveReference(result.preset.id, primary.id);
      if (resolved.success && resolved.absolutePath) setReferencePath(resolved.absolutePath);
    }
  };

  const deletePreset = async () => {
    if (!selectedPreset || !window.confirm(`删除用户音色“${selectedPreset.name}”？`)) return;
    const result = await service.deletePreset(selectedPreset.id);
    if (!result.success) { showToast(result.error || '删除音色失败。', 'error'); return; }
    setPresets(result.library?.presets ?? []);
    setSelectedPresetId('');
    setPresetName('');
  };

  const publishTemplateProfile = async () => {
    if (!selectedPreset) return;
    const result = await service.publishTemplateProfile(selectedPreset.id);
    if (!result.success) { showToast(result.error || '发布模板音色失败。', 'error'); return; }
    showToast('已发布到用户模板包 aeonstagery.user-voices。', 'success');
  };

  const adopt = async (candidate: Candidate, mode: 'apply' | 'sync-and-apply' | 'save-only') => {
    if (!project) { showToast('当前没有打开项目。', 'warning'); return; }
    const receipt = await service.adoptCandidate({
      candidatePath: candidate.absolutePath,
      candidateId: candidate.candidateId,
      candidateText: candidate.text,
      dialogueText: context.text,
      statementId: context.statementId,
      projectId: project.metadata.projectId,
      mode,
    });
    if (!receipt.success) { showToast(receipt.error || '采用候选失败。', 'error'); return; }
    showToast(mode === 'save-only' ? `已保存：${receipt.relativePath}` : '候选已应用到对白。', 'success');
    if (mode !== 'save-only') onClose();
  };

  const setCharacterDefault = async () => {
    if (!selectedPreset || !context.characterId) return;
    const result = await service.setCharacterDefault(selectedPreset, context.characterId);
    if (!result.success) { showToast(result.error || '设置角色默认音色失败。', 'error'); return; }
    setAssignedDefaultName(selectedPreset.name);
    showToast(`已将“${selectedPreset.name}”设为角色默认音色。`, 'success');
  };

  const play = (absolutePath: string) => {
    stopPreview();
    const audio = new Audio(toAssetUrl(absolutePath));
    audioRef.current = audio;
    void audio.play().catch((error) => showToast(`试听失败：${String(error)}`, 'error'));
  };
  const stopPreview = () => {
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.src = '';
    audioRef.current = null;
  };

  if (!isOpen) return null;
  return (
    <div className="voice-workbench-overlay" onMouseDown={onClose}>
      <div ref={dialogRef} className="voice-workbench" role="dialog" aria-modal="true" aria-labelledby="voice-workbench-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="voice-workbench__header">
          <div><h2 id="voice-workbench-title">语音工作台</h2><span>{context.mode === 'dialogue' ? `${characterLabel} · 当前对白` : '自由文本'} · {gptModels.length} GPT / {sovitsModels.length} SoVITS · {references.length} 参考</span></div>
          <button className="btn btn--icon" onClick={onClose} title="关闭" aria-label="关闭语音工作台"><IconX width={17} height={17} /></button>
        </header>
        <div className="voice-workbench__body">
          <aside className="voice-workbench__library">
            {projectProfile && (!projectGptMatch || !projectSovitsMatch) && <div className="voice-workbench__binding-warning">项目默认音色缺少本机模型绑定：{!projectGptMatch ? projectProfile.gptModel.fileName : ''} {!projectSovitsMatch ? projectProfile.sovitsModel.fileName : ''}</div>}
            {context.mode === 'dialogue' && <div className="voice-workbench__character-context">
              <div className="voice-workbench__character-mark" aria-hidden="true">{characterLabel.slice(0, 1).toUpperCase()}</div>
              <div><span>当前角色</span><strong>{characterLabel}</strong><small>{context.characterId}</small></div>
              <div className="voice-workbench__character-voice"><span>角色默认音色</span><strong>{assignedDefaultName || projectProfile?.name || '未设置'}</strong></div>
            </div>}
            <div className="voice-workbench__section-heading">
              <div className="voice-workbench__section-heading-title">
                <strong>推理模型</strong>
                <InfoTip title="GPT-SoVITS 模型" content="选择角色的 GPT 语义权重（.ckpt）与 SoVITS 声学模型（.pth），共同决定声音韵律与音色质感。" />
              </div>
              <button className="btn btn--icon" onClick={() => void refreshCatalog()} disabled={loading} title="刷新模型与参考音频目录" aria-label="刷新模型与参考音频目录"><IconRefresh width={14} height={14} /></button>
            </div>
            <label className="voice-workbench__field-label">
              <span>GPT 模型</span>
              <InfoTip title="GPT 权重文件 (.ckpt)" content="GPT-SoVITS 文本到语义 Token 模型，决定句子的语调起伏、重音与韵律节奏。" />
            </label>
            <FormSelect
              aria-label="GPT 模型"
              value={gptPath}
              options={[{ value: '', label: '选择 .ckpt' }, ...gptModels.map((model) => ({ value: model.absolutePath, label: model.fileName }))]}
              onChange={selectGptModel}
              disabled={loading}
            />
            <label className="voice-workbench__field-label">
              <span>SoVITS 模型</span>
              <InfoTip title="SoVITS 声学模型 (.pth)" content="GPT-SoVITS 声学合成与音色还原模型，决定角色的基础音色质感与声线特征。" />
            </label>
            <FormSelect
              aria-label="SoVITS 模型"
              value={sovitsPath}
              options={[{ value: '', label: '选择 .pth' }, ...sovitsModels.map((model) => ({ value: model.absolutePath, label: model.fileName }))]}
              onChange={selectSovitsModel}
              disabled={loading}
            />
            <label className="voice-workbench__field-label">
              <span>匹配音色</span>
              <InfoTip title="预设音色库" content="当前模型已保存的完整音色预设（包含参考音频与 Prompt 文本配置）。" />
            </label>
            <FormSelect
              aria-label="匹配音色"
              value={selectedPresetId}
              options={[
                { value: '', label: gptPath || sovitsPath ? '临时配置' : '选择模型后筛选' },
                ...matchingPresets.map((preset) => ({ value: preset.id, label: preset.name })),
              ]}
              onChange={(value) => { void selectPreset(value); }}
              disabled={!gptPath && !sovitsPath}
            />
            {(gptPath || sovitsPath) && matchingPresets.length === 0 && <div className="voice-workbench__model-note">当前模型组合没有已保存音色，可在下方配置参考后保存。</div>}
            {selectedPreset && <div className="voice-candidate__actions voice-workbench__preset-actions">
              <button className="btn" onClick={() => void renamePreset()}>重命名</button>
              <button className="btn" onClick={() => void duplicatePreset()}>复制</button>
              <button className="btn" onClick={() => void publishTemplateProfile()}>发布模板</button>
              <button className="btn" onClick={() => void deletePreset()}>删除</button>
              {context.characterId && <button className="btn btn--primary" onClick={() => void setCharacterDefault()}>设为角色默认</button>}
            </div>}
            <div className="voice-workbench__section-heading">
              <div className="voice-workbench__section-heading-title">
                <strong>参考音频</strong>
                <InfoTip title="参考音频 (Prompt Audio)" content="提供角色音色特征的 3~10 秒清晰无杂音语音片段，合成时模型会模仿该音频的声线与语调特征。" />
              </div>
            </div>
            <label className="voice-workbench__field-label">
              <span>参考音频</span>
              <InfoTip title="主参考音频" content="作为音色克隆的主要基准样本。" />
            </label>
            <div className="voice-workbench__inline">
              <FormSelect
                aria-label="参考音频"
                value={referencePath}
                options={referenceOptions}
                onChange={selectPrimaryReference}
                menuLayout="dual-pane"
                menuMinWidth={440}
              />
              <button className="btn btn--icon" onClick={() => void pickReferenceAudio(false)} title="从系统中选择参考音频" aria-label="选择参考音频"><IconFolder width={15} height={15} /></button>
              <button className="btn btn--icon" disabled={!referencePath} onClick={() => play(referencePath)} title="试听参考" aria-label="试听参考音频"><IconPlay width={15} height={15} /></button>
            </div>
            <div className="voice-workbench__auxiliary-field">
              <div className="voice-workbench__auxiliary-label">
                <span className="voice-workbench__label-head">
                  辅助参考音频
                  <InfoTip title="多参考音频融合" content="可添加多个不同情绪或语调的辅助音频，模型将融合多段声线特征以提高合成泛化能力。" />
                </span>
                <button className="btn btn--icon voice-workbench__pick-auxiliary" type="button" onClick={() => void pickReferenceAudio(true)} title="从系统中选择辅助参考音频" aria-label="选择辅助参考音频"><IconFolder width={15} height={15} /></button>
              </div>
              <div className="voice-workbench__inline">
                <FormSelect
                  aria-label="添加辅助参考音频"
                  value=""
                  options={[
                    { value: '', label: '添加辅助参考' },
                    ...referenceGroups.flatMap(({ directory, references: groupedReferences }) => groupedReferences
                      .filter((reference) => reference.absolutePath !== referencePath && !auxiliaryReferencePaths.includes(reference.absolutePath))
                      .map((reference) => ({
                        ...referenceSelectOption(reference),
                        group: directory,
                      }))),
                  ]}
                  onChange={addAuxiliaryReference}
                  menuLayout="dual-pane"
                  menuMinWidth={440}
                />
                <button className="btn btn--icon" type="button" onClick={() => void pickReferenceAudio(true)} title="从系统中选择辅助参考音频" aria-label="从系统中添加辅助参考音频"><IconFolder width={15} height={15} /></button>
              </div>
              {auxiliaryReferencePaths.map((pathValue, index) => (
                <div className="voice-workbench__inline voice-workbench__auxiliary-item" key={pathValue}>
                  <FormSelect
                    aria-label={`辅助参考音频 ${index + 1}`}
                    value={pathValue}
                    options={[
                      { value: '', label: '移除此参考' },
                      ...referenceGroups.flatMap(({ directory, references: groupedReferences }) => groupedReferences
                        .filter((reference) => reference.absolutePath !== referencePath && (reference.absolutePath === pathValue || !auxiliaryReferencePaths.includes(reference.absolutePath)))
                        .map((reference) => ({
                          ...referenceSelectOption(reference),
                          group: directory,
                        }))),
                      ...(references.some((reference) => reference.absolutePath === pathValue) ? [] : [externalReferenceSelectOption(pathValue)]),
                    ]}
                    onChange={(nextPath) => replaceAuxiliaryReference(index, nextPath)}
                    menuLayout="dual-pane"
                    menuMinWidth={440}
                  />
                  <button className="btn btn--icon" type="button" onClick={() => play(pathValue)} title="试听辅助参考" aria-label={`试听辅助参考音频 ${index + 1}`}><IconPlay width={15} height={15} /></button>
                  <button className="btn btn--icon" type="button" onClick={() => replaceAuxiliaryReference(index, '')} title="移除辅助参考" aria-label={`移除辅助参考音频 ${index + 1}`}><IconX width={15} height={15} /></button>
                </div>
              ))}
            </div>
            <label className="voice-workbench__toggle">
              <input type="checkbox" checked={refFree} onChange={(event) => setRefFree(event.target.checked)} />
              <span className="voice-workbench__label-head">
                无参考文本模式
                <InfoTip title="无参考文本模式" content="无需提供参考音频中说话的文字内容，适合快速测试或参考音频台词未知的情况。" />
              </span>
            </label>
            <label id="voice-workbench-prompt-label" htmlFor="voice-workbench-prompt-text" className="voice-workbench__field-label">
              <span>Prompt 文本</span>
              <InfoTip title="Prompt 文本 (参考台词)" content="参考音频中角色实际说出的准确台词。提供准确的参考文本可显著提升音色还原度与发音清晰度。" />
            </label>
            <textarea id="voice-workbench-prompt-text" className="form-input voice-workbench__prompt" aria-labelledby="voice-workbench-prompt-label" value={promptText} onChange={(event) => setPromptText(event.target.value)} disabled={refFree} placeholder={refFree ? '本次推理将忽略参考文本' : '填写参考音频中准确说出的内容'} />
            <label>
              <span className="voice-workbench__label-head">
                参考语种
                <InfoTip title="参考语种" content="参考音频所使用的主要语言类别。" />
              </span>
              <FormSelect aria-label="参考语种" value={promptLang} options={VOICE_LANGUAGE_OPTIONS} onChange={setPromptLang} />
            </label>
            <div className="voice-workbench__save-voice">
              <label>{selectedPreset ? '另存配置名称' : '音色名称'}<input className="form-input" value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder={defaultPresetName} /></label>
              <div className="voice-workbench__save-actions">
                <button className="btn" onClick={() => void savePreset(false)} title="保存到本机通用语音库"><IconSave width={14} height={14} /> {selectedPreset ? '另存通用音色' : '保存通用音色'}</button>
                {context.characterId && <button className="btn btn--primary" onClick={() => void savePreset(true)}><IconSave width={14} height={14} /> 保存并设为角色默认</button>}
              </div>
            </div>
          </aside>
          <main className="voice-workbench__editor">
            <label id="voice-workbench-target-label" htmlFor="voice-workbench-target-text">目标文本</label>
            <textarea ref={targetTextRef} id="voice-workbench-target-text" className="form-input voice-workbench__text" aria-labelledby="voice-workbench-target-label" value={text} onChange={(event) => setText(event.target.value)} />
            <div className="voice-workbench__controls">
              <label>
                <span className="voice-workbench__label-head">
                  目标语种
                  <InfoTip title="目标语种" content="要合成的目标台词语言类型。" />
                </span>
                <FormSelect aria-label="目标语种" value={textLang} options={VOICE_LANGUAGE_OPTIONS} onChange={setTextLang} />
              </label>
              <label>
                <span className="voice-workbench__label-head">
                  文本切分
                  <InfoTip title="长文本切分" content="长篇台词送入模型推理前的分段策略，推荐选择『按标点符号切』以保持自然的句读节奏。" />
                </span>
                <FormSelect aria-label="文本切分" value={textSplitMethod} options={TEXT_SPLIT_OPTIONS} onChange={setTextSplitMethod} />
              </label>
              <label>
                <span className="voice-workbench__label-head">
                  语速
                  <InfoTip title="播放语速" content="合成音频的播放速度倍率（0.6x ~ 1.65x）。" />
                </span>
                <input className="form-input" type="number" min="0.6" max="1.65" step="0.05" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} />
              </label>
            </div>
            <button className="btn voice-workbench__advanced-toggle" onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced}>{showAdvanced ? '收起推理参数' : '展开推理参数'}</button>
            {showAdvanced && <div className="voice-workbench__advanced">
              <div className="voice-workbench__parameter-group">
                <h4>GPT 采样</h4>
                <div className="voice-workbench__controls">
                  <label title="较小值发音更严谨，较大值词汇更丰富">Top K (选词范围)<input className="form-input" type="number" min="1" max="100" step="1" value={topK} onChange={(event) => setTopK(Number(event.target.value))} /></label>
                  <label title="截断低概率词汇，平衡稳定性">Top P (概率阈值)<input className="form-input" type="number" min="0" max="1" step="0.05" value={topP} onChange={(event) => setTopP(Number(event.target.value))} /></label>
                  <label title="温度越高音调起伏和情感更生动，较低更平稳">Temperature (生动度)<input className="form-input" type="number" min="0" max="1" step="0.05" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} /></label>
                  <label title="抑制连续重复发音或卡壳">重复惩罚 (Penalty)<input className="form-input" type="number" min="1" max="2" step="0.05" value={repetitionPenalty} onChange={(event) => setRepetitionPenalty(Number(event.target.value))} /></label>
                </div>
              </div>
              <div className="voice-workbench__parameter-group">
                <h4>批处理与输出</h4>
                <div className="voice-workbench__controls">
                  <label>批大小<input className="form-input" type="number" min="1" max="200" step="1" value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value))} /></label>
                  <label>分桶阈值<input className="form-input" type="number" min="0.1" max="1" step="0.05" value={batchThreshold} onChange={(event) => setBatchThreshold(Number(event.target.value))} /></label>
                  <label>句间停顿 (秒)<input className="form-input" type="number" min="0.1" max="0.5" step="0.01" value={fragmentInterval} onChange={(event) => setFragmentInterval(Number(event.target.value))} /></label>
                  <label title="步数越高音质越细腻，生成耗时稍增">采样精细步数<FormSelect aria-label="采样步数" value={sampleSteps} options={[4, 8, 16, 32, 64, 128].map((value) => ({ value, label: `${value} 步` }))} onChange={(value) => setSampleSteps(Number(value))} /></label>
                </div>
                <div className="voice-workbench__toggles">
                  <label className="voice-workbench__toggle"><input type="checkbox" checked={splitBucket} onChange={(event) => setSplitBucket(event.target.checked)} /><span>启用分桶</span></label>
                  <label className="voice-workbench__toggle"><input type="checkbox" checked={parallelInfer} onChange={(event) => setParallelInfer(event.target.checked)} /><span>并行推理</span></label>
                  <label className="voice-workbench__toggle"><input type="checkbox" checked={superSampling} onChange={(event) => setSuperSampling(event.target.checked)} /><span>超采样</span></label>
                </div>
              </div>
              <div className="voice-workbench__parameter-group voice-workbench__seed-row">
                <label>随机种子 <span className="voice-workbench__hint">-1 每次随机</span><input className="form-input" type="number" min="-1" max="2147483646" step="1" value={seed} onChange={(event) => setSeed(Number(event.target.value))} /></label>
                <button className="btn" onClick={() => setSeed(-1)}>恢复随机</button>
              </div>
            </div>}
            <button className="btn btn--primary voice-workbench__generate" disabled={!canGenerate} onClick={() => void generate()}>
              {candidates.length ? <IconRefresh width={16} height={16} /> : <IconVolume2 width={16} height={16} />}{busy ? '生成中...' : candidates.length ? '再生成一条' : '生成候选'}
            </button>
          </main>
          <aside className="voice-workbench__candidates">
            <h3>候选</h3>
            {!candidates.length && <div className="voice-workbench__empty">尚未生成候选</div>}
            {candidates.map((candidate, index) => <article className="voice-candidate" key={candidate.candidateId}>
              <div><strong>候选 {candidates.length - index}</strong><span>{candidate.durationSeconds !== undefined ? `${candidate.durationSeconds.toFixed(2)}s · ` : ''}Seed {candidate.seed}</span></div>
              <p>{candidate.text}</p>
              <div className="voice-candidate__actions">
                <button className="btn btn--icon" onClick={() => play(candidate.absolutePath)} title="试听候选" aria-label="试听候选"><IconPlay width={15} height={15} /></button>
                <button className="btn" onClick={() => { setSeed(candidate.seed); setShowAdvanced(true); }} title="使用该候选的随机种子再次生成">复用 Seed</button>
                {context.mode === 'dialogue' && candidate.text.trim() === (context.text ?? '').trim() && <button className="btn btn--primary" onClick={() => void adopt(candidate, 'apply')}>应用</button>}
                {context.mode === 'dialogue' && candidate.text.trim() !== (context.text ?? '').trim() && <button className="btn btn--primary" onClick={() => void adopt(candidate, 'sync-and-apply')}>同步文本并应用</button>}
                <button className="btn" onClick={() => void adopt(candidate, 'save-only')}>仅保存到项目</button>
              </div>
            </article>)}
          </aside>
        </div>
      </div>
    </div>
  );
}

function fileName(pathValue: string): string { return pathValue.replace(/\\/g, '/').split('/').pop() || pathValue; }
function fileStem(pathValue: string): string { return fileName(pathValue).replace(/\.[^.]+$/, ''); }
function referencePromptText(pathValue: string): string { return fileStem(pathValue); }
function uniquePaths(paths: string[]): string[] { return [...new Set(paths)]; }
function groupReferencesByDirectory(references: VoiceCatalogReference[]): Array<{ directory: string; references: VoiceCatalogReference[] }> {
  const groups = new Map<string, VoiceCatalogReference[]>();
  for (const reference of references) {
    const directory = referenceDirectoryLabel(reference);
    groups.set(directory, [...(groups.get(directory) ?? []), reference]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([directory, groupedReferences]) => ({ directory, references: [...groupedReferences].sort((left, right) => left.fileName.localeCompare(right.fileName)) }));
}
function referenceDirectoryLabel(reference: VoiceCatalogReference): string {
  return reference.pathTags.length ? reference.pathTags.join('\\') : '根目录';
}
function referenceDisplayLabel(reference: VoiceCatalogReference): string {
  return [...reference.pathTags, fileStem(reference.fileName)].join('\\') || fileStem(reference.fileName);
}
function referenceSelectOption(reference: VoiceCatalogReference) {
  return {
    value: reference.absolutePath,
    label: fileStem(reference.fileName),
    selectedLabel: referenceDisplayLabel(reference),
    group: referenceDirectoryLabel(reference),
    title: reference.absolutePath,
  };
}
function externalReferenceSelectOption(pathValue: string) {
  return { value: pathValue, label: fileName(pathValue), selectedLabel: fileName(pathValue), group: '已选择的外部文件', title: pathValue };
}
function modelStem(fileNameValue: string): string { return fileNameValue.replace(/\.(ckpt|pth)$/i, '').replace(/[-_.]?(gpt|sovits)$/i, '').toLowerCase(); }
function modelLocatorMatchesPath(locator: LocalVoicePreset['gptModel'], pathValue: string): boolean {
  return !!pathValue && (locator.absolutePath === pathValue || locator.fileName.toLowerCase() === fileName(pathValue).toLowerCase());
}
function toAssetUrl(pathValue: string): string { return encodeURI(`asset://localhost/${pathValue.replace(/\\/g, '/')}`); }

const VOICE_LANGUAGE_OPTIONS = [
  { value: 'all_zh', label: '中文' },
  { value: 'en', label: '英文' },
  { value: 'all_ja', label: '日文' },
  { value: 'all_yue', label: '粤语' },
  { value: 'all_ko', label: '韩文' },
  { value: 'zh', label: '中英混合' },
  { value: 'ja', label: '日英混合' },
  { value: 'yue', label: '粤英混合' },
  { value: 'ko', label: '韩英混合' },
  { value: 'auto', label: '多语种混合' },
  { value: 'auto_yue', label: '多语种混合（粤语）' },
] as const;

const TEXT_SPLIT_OPTIONS = [
  { value: 'cut0', label: '不切' },
  { value: 'cut1', label: '凑四句一切' },
  { value: 'cut2', label: '凑 50 字一切' },
  { value: 'cut3', label: '按中文句号切' },
  { value: 'cut4', label: '按英文句号切' },
  { value: 'cut5', label: '按标点符号切' },
] as const;

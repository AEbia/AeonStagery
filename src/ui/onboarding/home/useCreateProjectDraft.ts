import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { DEFAULT_DIALOGUE_STYLE_ID, type CharacterVariantImportMode, type ProjectTemplateDefaults } from '../../../api/types/project';
import { DEFAULT_VIDEO_FORMAT, validateVideoFormat, type ProjectVideoFormat } from '../../../api/types/video-format';
import { buildAvailableCharacterPresets, buildAvailableDialogueStyles, resolveTemplateDefaultValue } from '../../templates/TemplateCapabilityConfig';
import { convertWebGalToSceneDocument, joinWebGalScriptTexts, type WebGalChapterTransition, type WebGalImportReport } from '../../../services/import/webgal';
import type { ProjectHomeProps } from '../ProjectHome';
import { buildProjectPath } from './buildProjectPath';

interface WebGalAssetSource {
  mountId: string;
  path: string;
}

interface WebGalScriptFile {
  name: string;
  text: string;
}

type Options = Required<Pick<ProjectHomeProps,
  'defaultProjectName'
  | 'defaultProjectLocation'
  | 'templatePackages'
  | 'onCreateProject'
  | 'onBrowseCreateLocation'
  | 'onRegisterWebGalAssetSource'
>> & {
  isSubmitting: boolean;
  setIsSubmitting: Dispatch<SetStateAction<boolean>>;
};

export function useCreateProjectDraft({
  defaultProjectName,
  defaultProjectLocation,
  templatePackages,
  onCreateProject,
  onBrowseCreateLocation,
  onRegisterWebGalAssetSource,
  isSubmitting,
  setIsSubmitting,
}: Options) {
  const defaultRootPath = useMemo(
    () => buildProjectPath(defaultProjectLocation, defaultProjectName),
    [defaultProjectLocation, defaultProjectName],
  );
  const [projectName, setProjectName] = useState(defaultProjectName);
  const [videoFormat, setVideoFormat] = useState<ProjectVideoFormat>({ ...DEFAULT_VIDEO_FORMAT });
  const videoFormatError = validateVideoFormat(videoFormat);
  const [projectRootPath, setProjectRootPath] = useState(defaultRootPath);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>(() => templatePackages.map((templatePackage) => templatePackage.id));
  const hasCustomizedTemplateSelectionRef = useRef(false);
  const [selectedCharacterPresetIds, setSelectedCharacterPresetIds] = useState<string[]>([]);
  const [characterVariantImportMode, setCharacterVariantImportMode] = useState<CharacterVariantImportMode>('primary-only');
  const [defaultOverrides, setDefaultOverrides] = useState<ProjectTemplateDefaults>({});
  const [isRootPathDirty, setIsRootPathDirty] = useState(false);
  const [webgalScriptFiles, setWebgalScriptFiles] = useState<WebGalScriptFile[]>([]);
  const [webgalScriptReport, setWebgalScriptReport] = useState<WebGalImportReport | null>(null);
  const [webgalChapterTransition, setWebgalChapterTransition] = useState<WebGalChapterTransition>('black');
  const [webgalAssetSource, setWebgalAssetSource] = useState<WebGalAssetSource | null>(null);
  const [webgalSpeed, setWebgalSpeed] = useState(1.5);
  const [isReadingWebgalScript, setIsReadingWebgalScript] = useState(false);
  useEffect(() => {
    setProjectName(defaultProjectName);
  }, [defaultProjectName]);

  useEffect(() => {
    if (!isRootPathDirty) {
      setProjectRootPath(defaultRootPath);
    }
  }, [defaultRootPath, isRootPathDirty]);

  useEffect(() => {
    const availableIds = new Set(templatePackages.map((templatePackage) => templatePackage.id));
    setSelectedTemplateIds((current) => {
      if (!hasCustomizedTemplateSelectionRef.current) {
        return templatePackages.map((templatePackage) => templatePackage.id);
      }
      const filtered = current.filter((id) => availableIds.has(id));
      return filtered.length === current.length && filtered.every((id, index) => id === current[index])
        ? current
        : filtered;
    });
  }, [templatePackages]);

  const availableCharacterPresets = useMemo(() => {
    return buildAvailableCharacterPresets(templatePackages, selectedTemplateIds);
  }, [selectedTemplateIds, templatePackages]);
  const availableDialogueStyles = useMemo(
    () => buildAvailableDialogueStyles(templatePackages, selectedTemplateIds),
    [selectedTemplateIds, templatePackages],
  );
  const resolvedDialogueStyle = useMemo(
    () => resolveTemplateDefaultValue(
      'dialogueStyleId',
      templatePackages,
      selectedTemplateIds,
      defaultOverrides,
      DEFAULT_DIALOGUE_STYLE_ID,
    ),
    [defaultOverrides, selectedTemplateIds, templatePackages],
  );

  useEffect(() => {
    const availableIds = new Set(availableCharacterPresets.map((preset) => preset.id));
    setSelectedCharacterPresetIds((current) => current.filter((id) => availableIds.has(id)));
  }, [availableCharacterPresets]);

  const handleNameChange = (nextName: string) => {
    setProjectName(nextName);
    if (!isRootPathDirty) {
      setProjectRootPath(buildProjectPath(defaultProjectLocation, nextName));
    }
  };

  const handleBrowseLocation = async () => {
    const nextPath = await onBrowseCreateLocation(projectRootPath);
    if (nextPath) {
      setIsRootPathDirty(true);
      setProjectRootPath(nextPath);
    }
  };

  const handleCreate = async () => {
    const trimmedName = projectName.trim();
    const trimmedRootPath = projectRootPath.trim().replace(/[\\/]+$/, '');
    if (!trimmedName || !trimmedRootPath || isSubmitting || videoFormatError) return;

    setIsSubmitting(true);
    try {
      await onCreateProject({
        name: trimmedName,
        rootPath: trimmedRootPath,
        videoFormat,
        templates: {
          enabledTemplateIds: selectedTemplateIds,
          defaults: Object.keys(defaultOverrides).length > 0 ? defaultOverrides : undefined,
          selectedCharacterPresetIds,
          characterVariantImportMode,
        },
        ...(webgalScriptFiles.length > 0
          ? {
            webgal: {
              scriptText: webgalScriptFiles[0].text,
              scriptName: webgalScriptFiles[0].name,
              ...(webgalScriptFiles.length > 1
                ? {
                  additionalScripts: webgalScriptFiles.slice(1).map((file) => ({
                    scriptText: file.text,
                    scriptName: file.name,
                  })),
                }
                : {}),
              mountId: webgalAssetSource?.mountId,
              speed: webgalSpeed,
              chapterTransition: webgalChapterTransition,
            },
          }
          : {}),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChooseWebGalScript = async () => {
    if (isReadingWebgalScript) return;
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '选择 WebGAL 剧本文件（可多选，按选择顺序连续演出）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'WebGAL 剧本', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePaths?.length) return;
    setIsReadingWebgalScript(true);
    try {
      const loaded: WebGalScriptFile[] = [];
      for (const filePath of result.filePaths) {
        const fileResult = await window.aeonStageryAPI.fs.readTextFile(filePath);
        if (!fileResult.success || typeof fileResult.data !== 'string') {
          throw new Error(fileResult.error ?? '无法读取剧本文件');
        }
        loaded.push({
          name: filePath.split(/[\\/]/).pop() ?? '剧本',
          text: fileResult.data,
        });
      }
      const next = [...webgalScriptFiles, ...loaded];
      setWebgalScriptFiles(next);
      setWebgalScriptReport(mergeScriptsReport(next, webgalSpeed, webgalChapterTransition));
    } catch (error: unknown) {
      window.alert(`读取 WebGAL 剧本失败：${(error instanceof Error ? error.message : String(error))}`);
    } finally {
      setIsReadingWebgalScript(false);
    }
  };

  const handleRemoveWebGalScript = (index: number) => {
    const next = webgalScriptFiles.filter((_, currentIndex) => currentIndex !== index);
    setWebgalScriptFiles(next);
    setWebgalScriptReport(next.length > 0 ? mergeScriptsReport(next, webgalSpeed, webgalChapterTransition) : null);
  };

  const handleMoveWebGalScript = (index: number, delta: -1 | 1) => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= webgalScriptFiles.length) return;
    const next = [...webgalScriptFiles];
    const [removed] = next.splice(index, 1);
    next.splice(targetIndex, 0, removed);
    setWebgalScriptFiles(next);
    setWebgalScriptReport(next.length > 0 ? mergeScriptsReport(next, webgalSpeed, webgalChapterTransition) : null);
  };

  const handleClearWebGalScripts = () => {
    setWebgalScriptFiles([]);
    setWebgalScriptReport(null);
  };

  const mergeScriptsReport = (
    files: WebGalScriptFile[],
    speed: number,
    transition: WebGalChapterTransition,
  ): WebGalImportReport | null => {
    if (files.length === 0) return null;
    return convertWebGalToSceneDocument(
      joinWebGalScriptTexts({
        scriptText: files[0].text,
        additionalScripts: files.slice(1).map((file) => ({
          scriptText: file.text,
          scriptName: file.name,
        })),
        chapterTransition: transition,
      }),
      { duration: { speed } },
    ).report;
  };

  const handleWebgalSpeedChange = (speed: number) => {
    setWebgalSpeed(speed);
    if (webgalScriptFiles.length > 0) {
      setWebgalScriptReport(mergeScriptsReport(webgalScriptFiles, speed, webgalChapterTransition));
    }
  };

  const handleWebgalChapterTransitionChange = (transition: WebGalChapterTransition) => {
    setWebgalChapterTransition(transition);
    if (webgalScriptFiles.length > 0) {
      setWebgalScriptReport(mergeScriptsReport(webgalScriptFiles, webgalSpeed, transition));
    }
  };

  const handleChooseWebGalAssetSource = async () => {
    const source = await onRegisterWebGalAssetSource();
    if (source) setWebgalAssetSource(source);
  };

  const handleClearWebGalAssetSource = () => {
    setWebgalAssetSource(null);
  };

  const toggleTemplate = (templateId: string) => {
    hasCustomizedTemplateSelectionRef.current = true;
    setSelectedTemplateIds((current) => {
      if (current.includes(templateId)) {
        return current.filter((id) => id !== templateId);
      }
      const availableOrder = templatePackages.map((templatePackage) => templatePackage.id);
      return [...current, templateId].sort((left, right) =>
        availableOrder.indexOf(left) - availableOrder.indexOf(right),
      );
    });
  };

  const moveTemplate = (templateId: string, direction: -1 | 1) => {
    const selectedIndex = selectedTemplateIds.indexOf(templateId);
    if (selectedIndex < 0 || selectedIndex + direction < 0 || selectedIndex + direction >= selectedTemplateIds.length) return;
    hasCustomizedTemplateSelectionRef.current = true;
    setSelectedTemplateIds((current) => {
      const index = current.indexOf(templateId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const toggleCharacterPreset = (presetId: string) => {
    setSelectedCharacterPresetIds((current) => (
      current.includes(presetId)
        ? current.filter((id) => id !== presetId)
        : [...current, presetId]
    ));
  };

  const handleChangeDialogueStyleOverride = (styleId: string | undefined) => {
    updateDefaultOverride('dialogueStyleId', styleId);
  };

  const updateDefaultOverride = (key: keyof ProjectTemplateDefaults, value: string | undefined) => {
    setDefaultOverrides((current) => {
      const next = { ...current };
      if (!value) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  return {
    projectName,
    videoFormat,
    setVideoFormat,
    videoFormatError,
    projectRootPath,
    setProjectRootPath,
    selectedTemplateIds,
    selectedCharacterPresetIds,
    characterVariantImportMode,
    setCharacterVariantImportMode,
    setIsRootPathDirty,
    webgalScriptFiles,
    webgalScriptReport,
    webgalChapterTransition,
    webgalAssetSource,
    webgalSpeed,
    isReadingWebgalScript,
    availableCharacterPresets,
    availableDialogueStyles,
    resolvedDialogueStyle,
    handleNameChange,
    handleBrowseLocation,
    handleCreate,
    handleChooseWebGalScript,
    handleRemoveWebGalScript,
    handleMoveWebGalScript,
    handleClearWebGalScripts,
    handleWebgalSpeedChange,
    handleWebgalChapterTransitionChange,
    handleChooseWebGalAssetSource,
    handleClearWebGalAssetSource,
    toggleTemplate,
    moveTemplate,
    toggleCharacterPreset,
    handleChangeDialogueStyleOverride,
    isSubmitting,
  };
}

export type CreateProjectDraft = ReturnType<typeof useCreateProjectDraft>;

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  IconX,
  IconSettings,
  IconFolder,
  IconActivity,
  IconSparkles,
  IconInfo,
  IconVolume2,
  IconCheck,
  IconRefresh,
  IconDialogue,
} from './icons';
import { InfoTip } from './Tooltip';
import {
  createExternalLibraryMount,
  useSettings,
  settingsManager,
  DEFAULT_SETTINGS,
  DIALOGUE_TEXT_SPEED_SECONDS_RANGE,
  DIALOGUE_FONT_SIZE_RANGE,
  DEFAULT_DIALOGUE_DURATION_SECONDS_RANGE,
} from './SettingsStore';
import { ShortcutSettingsPanel } from './shortcuts/ShortcutSettingsPanel';
import { createSettingsDialogPolicy, type DirectoryPickerPort } from '../services/settings/SettingsDialogPolicy';
import { createWindowDirectoryPicker } from '../services/settings/WindowDirectoryPicker';
import { useOptionalApp } from './context/AppContext';
import type { ProjectState, ProjectVoiceGenerationConfiguration } from '../api/types/project';
import type { CollaborationSessionSummary } from '../api/types/window';
import type { GptSovitsStatusResult } from '../services/voice/GptSovitsTypes';
import { normalizeGptSovitsConfig } from '../services/voice/GptSovitsService';
import { useModalDialog } from './hooks/useModalDialog';
import {
  AI_PROSE_EFFORTS,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  type AiProseEffort,
  type AiProseProviderConfig,
  type AiProseStage,
} from '../api/types/ai-prose-authoring';
import type { AiProseAuthoringComposition } from '../services/ai-authoring/AiProseAuthoringComposition';
import type {
  AiProseElectronCredentialController,
  AiProseElectronProviderController,
} from '../services/ai-authoring/AiProseElectronTransport';
import { SETTINGS_CATEGORIES, findSettingsCategories, type SettingsDialogTab } from './settingsNavigation';
import { formatAeonStageryVersionLabel } from '../services/product/ProductInfo';
import './settingsNavigation.css';
import { DialogueDefaultsSettings } from './settings/DialogueDefaultsSettings';
import { getAiProseProviderIdentity } from '../services/ai-authoring/AiProseGlobalConfiguration';

interface SettingsDialogProps {
  templateContent?: React.ReactNode;
  isOpen: boolean;
  isClosing?: boolean;
  initialTab?: SettingsDialogTab;
  onClose: () => void;
  directoryPicker?: DirectoryPickerPort;
}

type TabType = SettingsDialogTab;
export type { SettingsDialogTab } from './settingsNavigation';

function getProjectVoiceGenerationConfiguration(project: ProjectState | null): ProjectVoiceGenerationConfiguration {
  return project?.metadata.voiceGeneration ?? { gptSovits: { selectedPresetId: undefined, presets: [] } };
}

export const SettingsDialog = ({ isOpen, isClosing = false, initialTab = 'general', onClose, directoryPicker, templateContent }: SettingsDialogProps) => {
  const dialogRef = useModalDialog(onClose, isOpen);
  const tabIdPrefix = React.useId();
  const { settings, setSetting } = useSettings();
  const app = useOptionalApp();
  const projectWorkspace = app?.services?.projectWorkspace;
  const voiceAuthoring = app?.services?.voiceAuthoring;
  const currentProject = useSyncExternalStore(
    projectWorkspace ? (listener) => projectWorkspace.subscribe(listener) : () => () => { },
    projectWorkspace ? () => projectWorkspace.getCurrentProject() : () => null,
    () => null,
  );
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const [searchQuery, setSearchQuery] = useState('');
  const [updateState, setUpdateState] = useState<{ state: string;[key: string]: any }>({ state: 'idle' });
  const [updateMessage, setUpdateMessage] = useState('');
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);
  const [isDownloadingUpdate, setIsDownloadingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ version?: string | null; releaseDate?: string | null; notes?: unknown } | null>(null);
  const [voiceGeneration, setVoiceGeneration] = useState<ProjectVoiceGenerationConfiguration>(() =>
    getProjectVoiceGenerationConfiguration(currentProject),
  );
  const [voiceStatus, setVoiceStatus] = useState<GptSovitsStatusResult | null>(null);
  const [voiceMessage, setVoiceMessage] = useState('');
  const [isVoiceBusy, setIsVoiceBusy] = useState(false);
  const [collaborationSessions, setCollaborationSessions] = useState<CollaborationSessionSummary[]>([]);
  const [isLoadingCollaborationSessions, setIsLoadingCollaborationSessions] = useState(false);
  const [collaborationSessionsMessage, setCollaborationSessionsMessage] = useState('');
  void isOpen;
  const stateClass = isClosing ? ' is-closing' : ' is-open';

  useEffect(() => {
    if (isOpen) { setActiveTab(initialTab); setSearchQuery(''); }
  }, [initialTab, isOpen]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let mounted = true;

    void window.aeonStageryAPI.updater.getState().then((state) => {
      if (!mounted) return;
      setUpdateState((prev) => ({ ...prev, ...state, state: 'idle' }));
    });

    unsubscribe = window.aeonStageryAPI.updater.onStatus((status) => {
      setUpdateState((prev) => ({ ...prev, ...status }));
      if (status.state === 'checking') {
        setIsCheckingForUpdates(true);
        setUpdateMessage('正在检查更新…');
      } else if (status.state === 'available') {
        setIsCheckingForUpdates(false);
        setIsDownloadingUpdate(false);
        setUpdateResult(status);
        setUpdateMessage(`发现新版本 ${status.version}`);
      } else if (status.state === 'not-available') {
        setIsCheckingForUpdates(false);
        setIsDownloadingUpdate(false);
        setUpdateMessage('当前已经是最新版本。');
      } else if (status.state === 'downloading') {
        setIsCheckingForUpdates(false);
        setIsDownloadingUpdate(true);
        setUpdateMessage(`正在下载更新 ${Math.round(status.percent ?? 0)}%`);
      } else if (status.state === 'downloaded') {
        setIsCheckingForUpdates(false);
        setIsDownloadingUpdate(false);
        setUpdateResult(status);
        setUpdateMessage(`更新已下载完成：${status.version}`);
      } else if (status.state === 'error') {
        setIsCheckingForUpdates(false);
        setIsDownloadingUpdate(false);
        setUpdateMessage(status.message || '更新检查失败');
      }
    });

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const nextConfig = getProjectVoiceGenerationConfiguration(currentProject);
    setVoiceGeneration(nextConfig);
  }, [currentProject]);

  const handleCheckUpdates = async () => {
    setIsCheckingForUpdates(true);
    setUpdateMessage('正在检查更新…');
    const result = await window.aeonStageryAPI.updater.checkForUpdates();
    if (!result.success) {
      setIsCheckingForUpdates(false);
      setUpdateMessage(result.error || '检查更新失败');
      return;
    }
    if (result.updateAvailable) {
      setUpdateResult(result);
      setUpdateMessage(`发现新版本 ${result.version}`);
    } else {
      setUpdateMessage('当前已经是最新版本。');
    }
    setIsCheckingForUpdates(false);
  };

  const handleDownloadUpdate = async () => {
    setIsDownloadingUpdate(true);
    setUpdateMessage('开始下载更新…');
    const result = await window.aeonStageryAPI.updater.downloadUpdate();
    setIsDownloadingUpdate(false);
    if (!result.success) {
      setUpdateMessage(result.error || '下载更新失败');
      return;
    }
    setUpdateMessage('更新下载完成，可以立即重启安装。');
  };

  const handleInstallUpdate = async () => {
    await window.aeonStageryAPI.updater.installUpdate();
  };

  const refreshCollaborationSessions = async () => {
    const api = window.aeonStageryAPI?.collaborationServer;
    if (!api?.listSessions) return;
    setIsLoadingCollaborationSessions(true);
    setCollaborationSessionsMessage('');
    try {
      const result = await api.listSessions();
      if (!result.success) {
        setCollaborationSessionsMessage(result.error || '读取协作服务器数据失败');
        return;
      }
      setCollaborationSessions(result.sessions || []);
    } catch (error) {
      setCollaborationSessionsMessage(`读取协作服务器数据失败：${getErrorMessage(error)}`);
    } finally {
      setIsLoadingCollaborationSessions(false);
    }
  };

  const handleClearPreviousCollaborationSessions = async () => {
    const api = window.aeonStageryAPI?.collaborationServer;
    if (!api?.clearPreviousSessions) return;
    if (!window.confirm('确定清理未运行的协作服务器数据吗？这会删除已保存的房间状态和资源，再次主持同一项目时无法恢复原房间。正在运行的房间会保留。')) return;
    setIsLoadingCollaborationSessions(true);
    setCollaborationSessionsMessage('正在清理未运行的协作房间数据…');
    try {
      const result = await api.clearPreviousSessions();
      if (!result.success) {
        setCollaborationSessionsMessage(result.error || '清理协作服务器数据失败');
        return;
      }
      await refreshCollaborationSessions();
      const skipped = result.skippedActiveCount ? `，保留运行中目录 ${result.skippedActiveCount} 个` : '';
      setCollaborationSessionsMessage(`已清理 ${result.clearedCount || 0} 个未运行的协作服务器目录${skipped}`);
    } catch (error) {
      setCollaborationSessionsMessage(`清理协作服务器数据失败：${getErrorMessage(error)}`);
    } finally {
      setIsLoadingCollaborationSessions(false);
    }
  };

  useEffect(() => {
    if (!isOpen || activeTab !== 'collaboration') return;
    void refreshCollaborationSessions();
  }, [activeTab, isOpen]);

  const handleTestGptSovits = async () => {
    setIsVoiceBusy(true);
    setVoiceMessage('正在测试 GPT-SoVITS 连接…');
    try {
      const result = await window.aeonStageryAPI.gptSovits.status(settings.gptSovits);
      setVoiceStatus(result);
      setVoiceMessage(result.success ? `连接可用：${result.apiBaseUrl}` : (result.error || 'GPT-SoVITS 连接不可用。'));
    } catch (error: any) {
      setVoiceStatus(createVoiceOperationErrorStatus(settings.gptSovits.rootPath, error));
      setVoiceMessage(`GPT-SoVITS 连接测试失败：${getErrorMessage(error)}`);
    } finally {
      setIsVoiceBusy(false);
    }
  };

  const handleStartGptSovits = async () => {
    setIsVoiceBusy(true);
    setVoiceMessage('正在启动 GPT-SoVITS API…');
    try {
      const result = await window.aeonStageryAPI.gptSovits.start(settings.gptSovits);
      setVoiceStatus(result);
      setVoiceMessage(result.success ? `启动命令已发送：${result.apiBaseUrl}` : (result.error || 'GPT-SoVITS API 启动失败。'));
    } catch (error: any) {
      setVoiceStatus(createVoiceOperationErrorStatus(settings.gptSovits.rootPath, error));
      setVoiceMessage(`GPT-SoVITS API 启动失败：${getErrorMessage(error)}`);
    } finally {
      setIsVoiceBusy(false);
    }
  };

  const handleStopGptSovits = async () => {
    setIsVoiceBusy(true);
    setVoiceMessage('正在停止 GPT-SoVITS API…');
    try {
      const result = await window.aeonStageryAPI.gptSovits.stop();
      setVoiceStatus({ success: result.success, configured: !!settings.gptSovits.rootPath, state: result.state, logs: result.logs, error: result.error });
      setVoiceMessage(result.success ? 'GPT-SoVITS API 已停止。' : (result.error || '停止 GPT-SoVITS API 失败。'));
    } catch (error: any) {
      setVoiceStatus(createVoiceOperationErrorStatus(settings.gptSovits.rootPath, error));
      setVoiceMessage(`停止 GPT-SoVITS API 失败：${getErrorMessage(error)}`);
    } finally {
      setIsVoiceBusy(false);
    }
  };

  const saveLegacyPresetToLibrary = async (preset: NonNullable<ProjectVoiceGenerationConfiguration['gptSovits']>['presets'][number]) => {
    if (!voiceAuthoring) return;
    const referenceId = 'primary';
    const result = await voiceAuthoring.savePreset({
      mode: 'save-as',
      preset: {
        id: preset.id,
        name: preset.name,
        gptModel: { absolutePath: preset.gptWeightsPath, fileName: getPathFileName(preset.gptWeightsPath) },
        sovitsModel: { absolutePath: preset.sovitsWeightsPath, fileName: getPathFileName(preset.sovitsWeightsPath) },
        references: [{ id: referenceId, label: getPathFileName(preset.refAudioPath), managedPath: 'pending', role: 'primary', promptText: preset.promptText, promptLang: preset.promptLang }],
        inferenceDefaults: { textLang: preset.textLang, speed: preset.speed },
      },
      references: [{ referenceId, sourcePath: preset.refAudioPath }],
    });
    setVoiceMessage(result.success ? `已将“${preset.name}”另存到用户语音库。` : (result.error || '另存旧版音色失败。'));
  };

  const tabs = findSettingsCategories(searchQuery);
  const activeCategory = SETTINGS_CATEGORIES.find(category => category.id === activeTab)!;
  const categoryIcons = { settings: IconSettings, activity: IconActivity, sparkles: IconSparkles, volume: IconVolume2, folder: IconFolder, info: IconInfo, dialogue: IconDialogue };
  const handleSearch = (query: string) => {
    setSearchQuery(query);
    const matches = findSettingsCategories(query);
    if (matches.length && !matches.some(category => category.id === activeTab)) setActiveTab(matches[0].id);
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.nativeEvent.isComposing) return;
    let nextIndex = index;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;

    event.preventDefault();
    setActiveTab(tabs[nextIndex].id);
    event.currentTarget.closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]
      ?.focus({ preventScroll: true });
  };

  const resolvedDirectoryPicker = directoryPicker ?? createWindowDirectoryPicker();
  const dialogPolicy = resolvedDirectoryPicker ? createSettingsDialogPolicy(resolvedDirectoryPicker) : null;

  const handleBrowseFolder = async (onPick: (path: string) => void) => {
    await dialogPolicy?.pickDirectory(onPick);
  };

  return (
    <div
      className={`dialog-overlay${stateClass}`}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className={`dialog-content settings-dialog${stateClass}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <aside className="settings-dialog__sidebar">
          <div className="settings-dialog__brand">
            <div className="settings-dialog__brand-row">
              <div className="settings-dialog__logo-badge">
                <img src="./icon.png" alt="AeonStagery" className="settings-dialog__logo-img" />
              </div>
              <h2 id="settings-dialog-title">AeonStagery 设置</h2>
            </div>
            <div className="settings-dialog__brand-subtitle">SETTINGS</div>
          </div>

          <div className="settings-navigation__search">
            <input type="search" aria-label="查找设置分类" placeholder="查找设置分类…" value={searchQuery} onChange={event => handleSearch(event.target.value)} />
            {searchQuery && <button type="button" className="btn btn--icon" aria-label="清除设置搜索" onClick={() => handleSearch('')}><IconX width={12} height={12} /></button>}
          </div>
          <div className="settings-dialog__tabs settings-navigation" role="tablist" aria-label="设置分类" aria-orientation="vertical">
            {tabs.map((tab, index) => {
              const Icon = categoryIcons[tab.icon];
              return (
                <React.Fragment key={tab.id}>
                  {(index === 0 || tabs[index - 1].group !== tab.group) && <div className="settings-navigation__group" role="presentation">{tab.group}</div>}
                  <button
                    id={tabIdPrefix + '-' + tab.id + '-tab'}
                    type="button" className="btn settings-dialog__tab" role="tab"
                    aria-label={tab.label} title={tab.description}
                    aria-selected={activeTab === tab.id} aria-controls={tabIdPrefix + '-tabpanel'}
                    tabIndex={activeTab === tab.id ? 0 : -1}
                    onClick={() => setActiveTab(tab.id)}
                    onKeyDown={event => handleTabKeyDown(event, index)}
                  >
                    <Icon width={16} height={16} /><span className="settings-dialog__tab-label">{tab.label}</span>
                  </button>
                </React.Fragment>
              );
            })}
          </div>
          {tabs.length === 0 && <p className="settings-navigation__empty" role="status">没有匹配的分类。试试“模型”“配音”或“模板”。</p>}

          <div className="settings-dialog__sidebar-spacer" />
        </aside>

        <main className="settings-dialog__main">
          <header className="settings-dialog__header">
            <div>
              <h3 className="settings-dialog__heading">
                {tabs.length ? activeCategory.label : '查找设置'}
              </h3>
              <p className="settings-dialog__scope">{tabs.length ? activeCategory.description : '按功能名称查找设置分类'}</p>
            </div>
            <button type="button" className="btn btn--icon settings-dialog__close" onClick={onClose} aria-label="关闭设置">
              <IconX width={18} height={18} />
            </button>
          </header>

          <div
            id={`${tabIdPrefix}-tabpanel`}
            role="tabpanel"
            aria-labelledby={`${tabIdPrefix}-${activeTab}-tab`}
            tabIndex={0}
            className="settings-dialog__content"
            hidden={tabs.length === 0}
          >
            <div className="settings-navigation__scope">{activeCategory.scope}{activeTab === 'templates' && (' · ' + (currentProject?.metadata.name ?? '未打开项目'))}</div>
            <div hidden={activeTab !== 'templates'}>
              {templateContent ?? <p>打开项目后可配置模板包与默认预设。</p>}
            </div>
            {activeTab === 'general' && (
              <Section title="基础体验">
                <SettingItem
                  title="主题"
                  description="切换浅色、深色、或跟随系统外观主题"
                  control={
                    <SegmentedControl
                      options={[
                        { label: '浅色', value: 'light' },
                        { label: '深色', value: 'dark' },
                        { label: '跟随系统', value: 'system' },
                      ]}
                      value={settings.theme}
                      onChange={(value) => setSetting('theme', value)}
                    />
                  }
                />
                <SettingItem
                  title="自动保存"
                  description="编辑时间轴、修改动作或对白时实时将变更写入本地工程 scene.json，防止意外丢失进度。"
                  control={<Toggle label="自动保存" active={settings.autoSave} onChange={(value) => setSetting('autoSave', value)} />}
                />
                <SettingItem
                  title="低性能模式"
                  description="关闭界面毛玻璃模糊、复杂光影粒子与动态过渡特效，在低配置设备或核显笔记本上提供流畅帧率。"
                  control={<Toggle label="低性能模式" active={settings.lowPerformance} onChange={(value) => setSetting('lowPerformance', value)} />}
                />
                <SettingItem
                  title="工作区布局"
                  description="轨道编辑优先模式下底部轨道获得完整宽度；剧本动作优先模式下右侧动作检查器具有纵向优先高度。"
                  control={(
                    <SegmentedControl
                      ariaLabel="工作区布局"
                      options={[
                        { label: '轨道编辑优先', value: 'tracks' },
                        { label: '剧本动作优先', value: 'list' },
                      ]}
                      value={settings.workbenchTimelineLayoutMode}
                      onChange={(value) => setSetting('workbenchTimelineLayoutMode', value)}
                    />
                  )}
                />
              </Section>
            )}

            {activeTab === 'engine' && (
              <Section title="预烘焙与回放">
                <SettingItem
                  title="启用预烘焙"
                  description="在后台空闲时提前计算并缓存 Live2D 动作变形关键帧快照，减少长剧本播放卡顿。"
                  control={<Toggle label="启用预烘焙" active={settings.preBakeEnabled} onChange={(value) => setSetting('preBakeEnabled', value)} />}
                />
                <SettingItem
                  title="烘焙精度"
                  description="预烘焙采样的切片步长（秒）。数值越小采样越密、运动过渡越细腻，但会占用更多内存与后台 CPU。"
                  control={<Slider label="烘焙精度" min={0.05} max={1} step={0.05} value={settings.bakePrecision} onChange={(value: number) => setSetting('bakePrecision', value)} suffix="s" />}
                />
                <SettingItem
                  title="预烘焙防抖"
                  description="连续拖拽或调整关键帧后等待该时长再启动后台烘焙，避免频繁重复计算浪费 CPU 算力。"
                  control={<Slider label="预烘焙防抖" min={100} max={2000} step={50} value={settings.preBakeDebounce} onChange={(value: number) => setSetting('preBakeDebounce', value)} suffix="ms" />}
                />
                <SettingItem
                  title="快照上限"
                  description="关键帧快照的最大步数缓存限制。"
                  control={<Slider label="快照上限" min={100} max={20000} step={200} value={settings.snapshotMaxCount} onChange={(value: number) => setSetting('snapshotMaxCount', value)} />}
                />
              </Section>
            )}

            {activeTab === 'ai' && (
              <AiProseSettingsSection
                value={settings.aiProse}
                composition={app?.services?.aiProse}
                onChange={(value) => setSetting('aiProse', value)}
              />
            )}

            {activeTab === 'audio' && (
              <div className="settings-dialog__stack settings-dialog__stack--loose">
                <Section title="混音面板">
                  <SettingItem
                    title="主音量"
                    description="控制工作区整体混音输出音量，影响预览与实时播放监听。"
                    control={<Slider label="主音量" min={0} max={1} step={0.01} value={settings.masterVolume} onChange={(value: number) => setSetting('masterVolume', value)} percent />}
                  />

                  <SettingItem
                    title="背景音乐"
                    description="控制 BGM 与环境声轨道的监听音量。"
                    control={<Slider label="背景音乐" min={0} max={1} step={0.01} value={settings.bgmVolume} onChange={(value: number) => setSetting('bgmVolume', value)} percent />}
                  />
                </Section>
              </div>
            )}
            {activeTab === 'dialogue' && (
              <div className="settings-dialog__stack settings-dialog__stack--loose">
                <Section title="默认对白样式">
                  <DialogueDefaultsSettings />
                </Section>
                <Section title="对白监听">
                  <SettingItem
                    title="对白音量"
                    description="控制角色配音轨道的监听音量。"
                    control={<Slider label="对白音量" min={0} max={1} step={0.01} value={settings.voiceVolume} onChange={(value: number) => setSetting('voiceVolume', value)} percent />}
                  />
                </Section>
                <Section title="文字与动画">
                  <SettingItem
                    title="对白字体大小"
                    description="仅调整舞台对白正文的字号（像素），说话人字号保持各样式的设定。正文按文本框可用宽度自动换行，行距随字号调整。"
                    control={<Slider label="对白字体大小" min={DIALOGUE_FONT_SIZE_RANGE.min} max={DIALOGUE_FONT_SIZE_RANGE.max} step={DIALOGUE_FONT_SIZE_RANGE.step} value={settings.dialogueFontSize} onChange={(value) => setSetting('dialogueFontSize', value)} suffix=" 像素" />}
                  />
                  <SettingItem
                    title="文本框入场动画"
                    description="控制文本框的淡入与上滑效果；文字仍按所选字幕样式展现。所有对白共用此开关。"
                    control={<Toggle label="文本框入场动画" active={settings.dialogueEntranceAnimation} onChange={(value) => setSetting('dialogueEntranceAnimation', value)} />}
                  />
                  <SettingItem
                    title="对白文本速度"
                    description="控制打字机字幕逐字展现的时间（秒/字）。数值越小打字速度越快。"
                    control={(
                      <Slider
                        label="对白文本速度"
                        min={DIALOGUE_TEXT_SPEED_SECONDS_RANGE.min}
                        max={DIALOGUE_TEXT_SPEED_SECONDS_RANGE.max}
                        step={DIALOGUE_TEXT_SPEED_SECONDS_RANGE.step}
                        value={settings.dialogueTextSpeed}
                        onChange={(value: number) => setSetting('dialogueTextSpeed', value)}
                        formatValue={(value) => `${formatCompactNumber(value, 3)} 秒/字`}
                      />
                    )}
                  />
                  <SettingItem
                    title="默认对白时长"
                    description="在时间轴上新建空白对白时默认分配的时间轴长度（秒）。"
                    control={(
                      <Slider
                        label="默认对白时长"
                        min={DEFAULT_DIALOGUE_DURATION_SECONDS_RANGE.min}
                        max={DEFAULT_DIALOGUE_DURATION_SECONDS_RANGE.max}
                        step={DEFAULT_DIALOGUE_DURATION_SECONDS_RANGE.step}
                        value={settings.defaultDialogueDurationSeconds}
                        onChange={(value: number) => setSetting('defaultDialogueDurationSeconds', value)}
                        formatValue={(value) => `${formatCompactNumber(value, 1)} 秒`}
                      />
                    )}
                  />
                </Section>
              </div>
            )}
            {activeTab === 'voice' && (
              <div className="settings-dialog__stack settings-dialog__stack--loose">
                <Section title="语音生成 / GPT-SoVITS" last>
                  <div className="settings-dialog__card">
                    <div className="settings-dialog__card-stack">
                      <div className="settings-dialog__field-label settings-dialog__field-label--spaced">
                        API 主机与端口
                        <InfoTip title="API 主机与端口" content="GPT-SoVITS 语音合成服务端运行的 IP 地址与端口号（默认 127.0.0.1:9880）。" />
                      </div>
                      <div className="settings-dialog__field-grid settings-dialog__field-grid--host">
                        <TextInput
                          ariaLabel="GPT-SoVITS API 主机"
                          value={settings.gptSovits.apiHost}
                          onChange={(value: string) => setSetting('gptSovits', { ...settings.gptSovits, apiHost: value })}
                          placeholder="127.0.0.1"
                        />
                        <TextInput
                          ariaLabel="GPT-SoVITS API 端口"
                          value={String(settings.gptSovits.apiPort)}
                          onChange={(value: string) => setSetting('gptSovits', { ...settings.gptSovits, apiPort: Number.parseInt(value, 10) || 9880 })}
                          placeholder="9880"
                        />
                      </div>
                      <div className="settings-dialog__field-label settings-dialog__field-label--spaced">
                        GPT-SoVITS 根目录
                        <InfoTip title="GPT-SoVITS 根目录" content="本地 GPT-SoVITS 整合包或克隆仓库的根路径。配置后可在编辑器内直接启动或停止语音合成 API 守护进程。" />
                      </div>
                      <div className="settings-dialog__field-row">
                        <TextInput
                          ariaLabel="GPT-SoVITS 根目录"
                          value={settings.gptSovits.rootPath}
                          onChange={(value: string) => setSetting('gptSovits', { ...settings.gptSovits, rootPath: value })}
                          placeholder="GPT-SoVITS 根目录"
                        />
                        <button
                          onClick={() => {
                            void handleBrowseFolder((pickedPath) => {
                              setSetting('gptSovits', { ...settings.gptSovits, rootPath: pickedPath });
                            });
                          }}
                          className="btn settings-dialog__compact-button"
                        >
                          浏览
                        </button>
                      </div>
                      <div className="settings-dialog__helper settings-dialog__helper--flush">
                        启动命令预览：{settings.gptSovits.rootPath
                          ? `runtime/python.exe api_v2.py -a ${normalizeGptSovitsConfig(settings.gptSovits).apiHost} -p ${normalizeGptSovitsConfig(settings.gptSovits).apiPort}`
                          : '未配置 GPT-SoVITS 根目录'}
                      </div>
                      <div className="settings-dialog__field-group">
                        <div className="settings-dialog__field-label">
                          额外模型目录
                          <InfoTip title="额外模型目录" content="存放外部训练好的 GPT-SoVITS .pth 权重与 .ckpt 模型的扫描目录，供配音角色自由挑选音色。" />
                        </div>
                        {(settings.gptSovits.modelRoots ?? []).map((root, index) => (
                          <div key={`${root}-${index}`} className="settings-dialog__field-row">
                            <TextInput ariaLabel={`额外模型目录 ${index + 1}`} value={root} onChange={(value: string) => {
                              const modelRoots = [...(settings.gptSovits.modelRoots ?? [])];
                              modelRoots[index] = value;
                              setSetting('gptSovits', { ...settings.gptSovits, modelRoots });
                            }} />
                            <button className="btn" onClick={() => setSetting('gptSovits', { ...settings.gptSovits, modelRoots: (settings.gptSovits.modelRoots ?? []).filter((_, itemIndex) => itemIndex !== index) })}>移除</button>
                          </div>
                        ))}
                        <button className="btn" onClick={() => void handleBrowseFolder((pickedPath) => setSetting('gptSovits', { ...settings.gptSovits, modelRoots: [...(settings.gptSovits.modelRoots ?? []), pickedPath] }))}>添加模型目录</button>
                      </div>
                      <div className="settings-dialog__field-group">
                        <div className="settings-dialog__field-label">
                          原始参考音频目录
                          <InfoTip title="原始参考音频目录" content="存放角色音色参考音频（.wav/.mp3）与对应参考文本的目录，用于零样本声音克隆。" />
                        </div>
                        {(settings.gptSovits.referenceRoots ?? []).map((root, index) => (
                          <div key={`${root}-${index}`} className="settings-dialog__field-row">
                            <TextInput ariaLabel={`原始参考音频目录 ${index + 1}`} value={root} onChange={(value: string) => {
                              const referenceRoots = [...(settings.gptSovits.referenceRoots ?? [])];
                              referenceRoots[index] = value;
                              setSetting('gptSovits', { ...settings.gptSovits, referenceRoots });
                            }} />
                            <button className="btn" onClick={() => setSetting('gptSovits', { ...settings.gptSovits, referenceRoots: (settings.gptSovits.referenceRoots ?? []).filter((_, itemIndex) => itemIndex !== index) })}>移除</button>
                          </div>
                        ))}
                        <button className="btn" onClick={() => void handleBrowseFolder((pickedPath) => setSetting('gptSovits', { ...settings.gptSovits, referenceRoots: [...(settings.gptSovits.referenceRoots ?? []), pickedPath] }))}>添加参考目录</button>
                      </div>
                      <div className="settings-dialog__actions">
                        <button className="btn" disabled={isVoiceBusy} onClick={handleTestGptSovits}>
                          <IconCheck width={14} height={14} /> 测试连接
                        </button>
                        <button className="btn" disabled={isVoiceBusy} onClick={handleStartGptSovits}>
                          启动 API
                        </button>
                        <button className="btn" disabled={isVoiceBusy} onClick={handleStopGptSovits}>
                          停止 API
                        </button>
                        <span className={voiceStatus?.success ? 'settings-dialog__status settings-dialog__status--success' : 'settings-dialog__status'}>
                          状态：{voiceStatus?.state ?? '未检测'}
                        </span>
                      </div>
                      {voiceMessage && <div role="status" aria-live="polite" className={voiceStatus?.success ? 'settings-dialog__message settings-dialog__message--success' : 'settings-dialog__message'}>{voiceMessage}</div>}
                      {voiceStatus?.logs && voiceStatus.logs.length > 0 && (
                        <pre className="settings-dialog__logs">
                          {voiceStatus.logs.slice(-8).join('\n')}
                        </pre>
                      )}
                    </div>
                  </div>

                  {(voiceGeneration.gptSovits?.presets.length ?? 0) > 0 && (
                    <div className="settings-dialog__helper settings-dialog__legacy-presets">
                      <div>检测到 {voiceGeneration.gptSovits?.presets.length} 个旧版项目音色配置。它们保持只读兼容。</div>
                      {voiceGeneration.gptSovits?.presets.map((preset) => (
                        <div key={preset.id} className="settings-dialog__legacy-preset">
                          <span>{preset.name}</span>
                          <button className="btn" disabled={!voiceAuthoring} onClick={() => void saveLegacyPresetToLibrary(preset)}>另存到用户语音库</button>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>
              </div>
            )}

            {activeTab === 'resources' && (
              <div className="settings-dialog__stack settings-dialog__stack--loose">
                <Section title="当前项目">
                  <div className="settings-dialog__card">
                    <div className="settings-dialog__field-label settings-dialog__field-label--spaced">
                      项目根目录
                      <InfoTip content="当前项目根目录会在创建项目或打开项目时自动设置。为了保持项目可搬迁，这里只展示，不建议手动修改。" />
                    </div>
                    <TextInput
                      ariaLabel="项目根目录"
                      readOnly
                      value={settings.assetsPath}
                      onChange={() => { }}
                      placeholder="尚未打开项目"
                      inputStyle={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
                    />
                  </div>
                </Section>

                <Section title="外部素材库" last>
                  <div className="settings-dialog__card">
                    <div className="settings-dialog__field-label settings-dialog__field-label--spaced">
                      只读浏览来源
                      <InfoTip content="可以添加多个公共素材库，供资源浏览器检索和导入。" />
                    </div>

                    {(settings.externalLibraryMounts || []).map((mount, index) => (
                      <div key={mount.id} className="settings-dialog__mount-row">
                        <code className="settings-dialog__mount-id">@mount/{mount.id}</code>
                        <TextInput
                          ariaLabel={`外部资源库 ${mount.id} 路径`}
                          value={mount.path}
                          onChange={(value: string) => {
                            const mounts = [...(settings.externalLibraryMounts || [])];
                            mounts[index] = { ...mounts[index], path: value };
                            setSetting('externalLibraryMounts', mounts);
                          }}
                          placeholder="例如：D:/Live2D Library"
                          inputStyle={{ padding: '10px 12px', borderRadius: 'var(--radius-md)', fontSize: 12 }}
                        />
                        <button
                          onClick={() => {
                            void handleBrowseFolder((pickedPath) => {
                              const mounts = [...(settings.externalLibraryMounts || [])];
                              mounts[index] = { ...mounts[index], path: pickedPath };
                              setSetting('externalLibraryMounts', mounts);
                            });
                          }}
                          className="btn settings-dialog__compact-button"
                        >
                          浏览
                        </button>
                        <button
                          onClick={() => {
                            const mounts = (settings.externalLibraryMounts || []).filter((_, mountIndex) => mountIndex !== index);
                            setSetting('externalLibraryMounts', mounts);
                          }}
                          className="btn settings-dialog__compact-button settings-dialog__compact-button--danger"
                        >
                          删除
                        </button>
                      </div>
                    ))}

                    <div className="settings-dialog__actions settings-dialog__actions--top-space">
                      <button
                        onClick={() => {
                          const mounts = settings.externalLibraryMounts || [];
                          setSetting('externalLibraryMounts', [...mounts, createExternalLibraryMount('', mounts)]);
                        }}
                        className="btn settings-dialog__compact-button"
                      >
                        添加素材库
                      </button>
                      <button
                        onClick={() => setSetting('hasCompletedExternalLibraryOnboarding', false)}
                        className="btn settings-dialog__compact-button"
                      >
                        重新显示首次引导
                      </button>
                    </div>
                  </div>
                </Section>
              </div>
            )}

            {activeTab === 'collaboration' && (
              <div className="settings-dialog__stack">
                <Section title="协作服务器数据">
                  <div className="settings-dialog__card">
                    <div className="settings-dialog__field-label">
                      本机协作服务器目录
                      <InfoTip content="已停止的房间仍可在再次主持同一项目时恢复。清理会删除未运行房间的状态、资源清单和场景快照。" />
                    </div>
                    {isLoadingCollaborationSessions && (
                      <div role="status" className="settings-dialog__helper settings-dialog__helper--with-space">正在读取协作服务器数据…</div>
                    )}
                    {!isLoadingCollaborationSessions && collaborationSessions.length === 0 && !collaborationSessionsMessage && (
                      <div className="settings-dialog__helper settings-dialog__helper--with-space">没有本机协作服务器目录。</div>
                    )}
                    {collaborationSessions.length > 0 && (
                      <div className="settings-dialog__session-list">
                        {collaborationSessions.map((session) => (
                          <div
                            key={session.dataDir}
                            className="settings-dialog__session-row"
                          >
                            <div className="settings-dialog__session-main">
                              <code className="settings-dialog__session-name">{session.name}</code>
                              <div className="settings-dialog__session-meta">
                                {formatCollaborationSessionBytes(session.sizeBytes)} · {session.hasState ? '已有房间状态' : '尚未发布状态'} · {new Date(session.updatedAt).toLocaleString()}
                              </div>
                            </div>
                            <span className={
                              session.active
                                ? 'settings-dialog__session-state settings-dialog__session-state--active'
                                : session.hasState
                                  ? 'settings-dialog__session-state settings-dialog__session-state--restorable'
                                  : 'settings-dialog__session-state'
                            }>
                              {session.active ? '运行中，保留' : session.hasState ? '已停止，可恢复' : '尚未发布'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {collaborationSessionsMessage && (
                      <div role="status" aria-live="polite" className="settings-dialog__helper settings-dialog__helper--with-space">
                        {collaborationSessionsMessage}
                      </div>
                    )}
                    <button
                      type="button"
                      className="btn btn--danger settings-dialog__action-button"
                      disabled={isLoadingCollaborationSessions || collaborationSessions.every((session) => session.active)}
                      onClick={() => void handleClearPreviousCollaborationSessions()}
                    >
                      清理未运行的协作房间数据
                    </button>
                  </div>
                </Section>

              </div>
            )}

            {activeTab === 'shortcuts' && (
              <Section last>
                <ShortcutSettingsPanel
                  value={settings.keyboardShortcuts}
                  onChange={(next) => setSetting('keyboardShortcuts', next)}
                />
              </Section>
            )}

            {activeTab === 'about' && (
              <div className="settings-dialog__about">
                <div className="settings-dialog__about-mark">
                  <img src="./icon.png" alt="AeonStagery" className="settings-dialog__about-logo" />
                </div>
                <h3 className="settings-dialog__about-title">AeonStagery</h3>
                <p className="settings-dialog__about-copy">
                  面向可搬迁项目的 Live2D 剧本动画编辑器。场景内容保存在 `scene.json`，项目元数据保存在 `project.json`。
                </p>
                <div className="settings-dialog__about-grid">
                  <InfoCard label="Version" value={formatAeonStageryVersionLabel()} />
                  <InfoCard label="Theme" value={settings.theme} />
                  <InfoCard label="Defaults" value="Portable Projects" />
                </div>
                <div className="settings-dialog__card settings-dialog__about-update">
                  <div className="settings-dialog__field-label">
                    增量更新
                    <InfoTip
                      content={updateState.enabled
                        ? '已启用增量更新：仅允许差分下载。无法构建差分包时会中止更新并提示，不会回退到全量安装包。'
                        : '当前未配置更新源。打包时需在 package.json 的 build.publish 中配置对象存储更新目录，也可用 APP_UPDATE_URL 环境变量覆盖。'}
                    />
                  </div>
                  <div role="status" aria-live="polite" className="settings-dialog__update-status">
                    {updateMessage || '尚未检查更新'}
                  </div>
                  <div className="settings-dialog__actions">
                    <button className="btn" onClick={handleCheckUpdates} disabled={isCheckingForUpdates || isDownloadingUpdate}>
                      {isCheckingForUpdates ? '检查中…' : '检查更新'}
                    </button>
                    <button
                      className="btn"
                      onClick={handleDownloadUpdate}
                      disabled={!updateResult?.version || isDownloadingUpdate || !updateState.enabled}
                    >
                      {isDownloadingUpdate ? '下载中…' : '下载更新'}
                    </button>
                    <button
                      className="btn"
                      onClick={handleInstallUpdate}
                      disabled={updateState.state !== 'downloaded'}
                    >
                      立即重启安装
                    </button>
                  </div>
                  {updateResult?.releaseDate && (
                    <div className="settings-dialog__update-date">
                      发布日期：{new Date(updateResult.releaseDate).toLocaleString()}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                  <button
                    className="btn settings-dialog__reset-button"
                    onClick={() => {
                      settingsManager.update(DEFAULT_SETTINGS);
                    }}
                  >
                    重置设置
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
};

function getAiProseCredentialController(
  composition: AiProseAuthoringComposition | undefined,
): AiProseElectronCredentialController | undefined {
  const transport = composition?.transport as Partial<AiProseElectronCredentialController> | undefined;
  if (!transport
    || typeof transport.getCredentialStatus !== 'function'
    || typeof transport.setCredential !== 'function'
    || typeof transport.clearCredential !== 'function') {
    return undefined;
  }
  return transport as AiProseElectronCredentialController;
}

function getAiProseModelController(
  composition: AiProseAuthoringComposition | undefined,
): AiProseElectronProviderController | undefined {
  const transport = composition?.transport as Partial<AiProseElectronProviderController> | undefined;
  return typeof transport?.listModels === 'function'
    ? transport as AiProseElectronProviderController
    : undefined;
}

function getAiProseProviderController(
  composition: AiProseAuthoringComposition | undefined,
): AiProseElectronProviderController | undefined {
  const transport = composition?.transport as Partial<AiProseElectronProviderController> | undefined;
  return typeof transport?.configureProvider === 'function'
    ? transport as AiProseElectronProviderController
    : undefined;
}

function createAiProseProvider(value: typeof DEFAULT_SETTINGS.aiProse): AiProseProviderConfig {
  let endpoint = value.baseUrl.trim() || DEFAULT_AI_BASE_URL;
  if (!/^https?:\/\//i.test(endpoint)) {
    endpoint = `https://${endpoint}`;
  }
  const defaultModel = value.defaultModel.trim() || DEFAULT_AI_MODEL;
  return {
    endpoint,
    defaultModel,
    ...(value.projectAgentModel ? { projectAgentModel: value.projectAgentModel } : {}),
    ...(value.modelOverrides ? { modelOverrides: { ...value.modelOverrides } } : {}),
    jsonOutputSupported: value.jsonOutputSupported,
  };
}

const AI_PROSE_STAGE_LABELS: Record<AiProseStage, string> = {
  segmentation: '语义分段',
  characterExtraction: '人物提取',
  normalization: '语句规范化',
  rhythm: '语义节奏',
  acting: '表演指导',
  cinematic: '电影感',
};

const AI_PROSE_STAGE_HINTS: Partial<Record<AiProseStage, string>> = {
  acting: '可选增强 · 仅需结构化 JSON',
  cinematic: '可选增强 · 仅需结构化 JSON',
};

function AiProseSettingsSection({
  value,
  composition,
  onChange,
}: {
  value: typeof DEFAULT_SETTINGS.aiProse;
  composition?: AiProseAuthoringComposition;
  onChange: (value: typeof DEFAULT_SETTINGS.aiProse) => void;
}) {
  const [credentialConfigured, setCredentialConfigured] = useState(false);
  const [credentialInput, setCredentialInput] = useState('');
  const [message, setMessage] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const modelsRequestIdRef = useRef(0);

  useEffect(() => {
    let active = true;
    const controller = getAiProseCredentialController(composition);
    if (!controller) {
      setCredentialConfigured(false);
      return () => {
        active = false;
      };
    }
    void controller.getCredentialStatus()
      .then((status) => {
        if (active) setCredentialConfigured(status.configured);
      })
      .catch(() => {
        if (active) setCredentialConfigured(false);
      });
    return () => {
      active = false;
    };
  }, [composition]);

  const updateValue = (patch: Partial<typeof DEFAULT_SETTINGS.aiProse>) => {
    const next = { ...value, ...patch };
    const providerChanged = getAiProseProviderIdentity(value) !== getAiProseProviderIdentity(next);
    const updated = providerChanged
      ? { ...next, jsonOutputSupported: false, capabilityIdentity: undefined }
      : next;
    onChange(updated);
    if (providerChanged && composition) {
      try {
        const provider = createAiProseProvider(updated);
        const providerIdentity = getAiProseProviderIdentity(provider);
        const configurationAlreadyUpdated = composition.configuration
          && getAiProseProviderIdentity(composition.configuration.provider) === providerIdentity;
        if (!configurationAlreadyUpdated) {
          composition.configuration?.updateProviderConfig?.(provider);
          const providerController = getAiProseProviderController(composition);
          if (providerController) {
            void providerController.configureProvider(provider).catch(() => undefined);
          }
        }
      } catch {
        // Ignore incomplete values while user is typing
      }
    }
  };

  const handleCredentialSave = async () => {
    const controller = getAiProseCredentialController(composition);
    if (!controller || !credentialInput.trim()) return;
    try {
      const result = await controller.setCredential(credentialInput.trim());
      if (!result.success) {
        setMessage(result.error ?? 'API 密钥保存失败');
        return;
      }
      setCredentialInput('');
      setCredentialConfigured(true);
      setMessage('API 密钥已保存');
    } catch (error) {
      setMessage(`API 密钥保存失败：${getErrorMessage(error)}`);
    }
  };

  const handleCredentialClear = async () => {
    const controller = getAiProseCredentialController(composition);
    if (!controller) return;
    try {
      const result = await controller.clearCredential();
      if (!result.success) {
        setMessage(result.error ?? 'API 密钥清除失败');
        return;
      }
      setCredentialConfigured(false);
      setMessage('API 密钥已清除');
    } catch (error) {
      setMessage(`API 密钥清除失败：${getErrorMessage(error)}`);
    }
  };

  const handleCapabilityProbe = async () => {
    if (!composition) {
      setMessage('AI 服务不可用');
      return;
    }
    setMessage('正在测试…');
    try {
      const provider = createAiProseProvider(value);
      composition.configuration?.updateProviderConfig?.(provider);
      const providerController = getAiProseProviderController(composition);
      if (providerController) {
        const configured = await providerController.configureProvider(provider);
        if (!configured.success) {
          setMessage(`AI 设置无效：${configured.error ?? 'provider 配置失败'}`);
          return;
        }
      }
      const capabilities = await composition.configuration.probeCapabilities({
        probe: (request) => composition.capabilityProbe.probe(request),
      });
      const jsonOutputSupported = [...capabilities.values()].every((item) => item.jsonOutputSupported);
      updateValue({
        jsonOutputSupported,
        capabilityIdentity: getAiProseProviderIdentity(value),
      });
      setMessage(`已测试 ${capabilities.size} 个模型 · JSON Output ${jsonOutputSupported ? '可用' : '不可用'}`);
    } catch (error) {
      setMessage(`测试失败：${getErrorMessage(error)}`);
    }
  };

  const handleFetchModels = async () => {
    const controller = getAiProseModelController(composition);
    if (!controller) {
      setMessage('当前运行环境不支持自动获取模型');
      return;
    }
    let baseUrl = value.baseUrl.trim() || DEFAULT_AI_BASE_URL;
    if (!/^https?:\/\//i.test(baseUrl)) {
      baseUrl = `https://${baseUrl}`;
    }
    const provider = createAiProseProvider({ ...value, baseUrl });
    composition?.configuration?.updateProviderConfig?.(provider);
    const providerController = getAiProseProviderController(composition);
    if (providerController) {
      const configured = await providerController.configureProvider(provider);
      if (!configured.success) {
        setMessage(`AI 设置无效：${configured.error ?? 'provider 配置失败'}`);
        return;
      }
    }
    const requestId = ++modelsRequestIdRef.current;
    setIsLoadingModels(true);
    setMessage('正在获取模型…');
    try {
      const result = await controller.listModels?.(baseUrl);
      if (requestId !== modelsRequestIdRef.current) return;
      if (!result?.success) {
        setAvailableModels([]);
        setMessage(result?.error ?? '获取模型列表失败');
        return;
      }
      const models = [...new Set(result.models)].filter((model) => model.trim().length > 0);
      setAvailableModels(models);
      if ((value.defaultModel.trim() === '' || value.defaultModel === DEFAULT_AI_MODEL) && models[0]) {
        updateValue({ defaultModel: models[0] });
      }
      setMessage(models.length > 0 ? `已获取 ${models.length} 个模型` : '接口未返回可用模型');
    } catch (error) {
      if (requestId === modelsRequestIdRef.current) setMessage(`获取模型失败：${getErrorMessage(error)}`);
    } finally {
      if (requestId === modelsRequestIdRef.current) setIsLoadingModels(false);
    }
  };

  return (
    <Section title="AI" last>
      <div className="settings-ai-panel">
        <div className="settings-ai-panel__grid">
          <label className="settings-ai-panel__field settings-ai-panel__field--wide">
            <span>
              Base URL
              <InfoTip
                title="Base URL (接口地址)"
                content="大语言模型服务商的 API 请求接口地址。OpenAI 通常为 https://api.openai.com/v1。若使用Deepseek,Kimi,GLM,官方开放平台、第三方中转/聚合平台、或本地部署模型（如 Ollama / vLLM / LM Studio），请填入对应的完整接口 URL。暂时只支持Chat Completions格式"
              />
            </span>
            <input
              aria-label="AI Base URL"
              value={value.baseUrl}
              placeholder={DEFAULT_AI_BASE_URL}
              onChange={(event) => updateValue({ baseUrl: event.target.value })}
            />
          </label>
          <label className="settings-ai-panel__field">
            <span>
              最大并发
              <InfoTip
                title="最大并发请求数"
                content="同时向大模型服务商发起请求的最大连接数。数值越大批量处理剧本速度越快，但可能触碰服务商的 TPM / RPM（每分钟 Token / 请求数）速率限制。"
              />
            </span>
            <input
              aria-label="AI 最大并发"
              type="number"
              min="1"
              step="1"
              value={value.maxConcurrentAiRequests}
              onChange={(event) => updateValue({ maxConcurrentAiRequests: Math.max(1, Number(event.target.value) || 1) })}
            />
          </label>
          <label className="settings-ai-panel__field">
            <span>
              effort
              <InfoTip
                title="推理深度 (Effort)"
                content="控制推理大模型在输出回答前的思考推理深度。设置为 max 时推理最全面严谨，但耗时更长；low 时响应更敏捷，部分提供商可能不兼容所有的推理深度。"
              />
            </span>
            <select
              aria-label="AI effort"
              value={value.effort}
              onChange={(event) => updateValue({ effort: event.target.value as AiProseEffort })}
            >
              {AI_PROSE_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </label>
        </div>

        <div className="settings-ai-panel__model-row">
          <label className="settings-ai-panel__field">
            <span>
              默认模型
              <InfoTip
                title="默认模型 (Default Model)"
                content="AI 剧本创作、分段分析、角色动作与镜头建议默认使用的大模型标识（例如 gpt-5.6-luna、deepseek-v4-flash等）。"
              />
            </span>
            <input
              aria-label="AI 默认模型"
              value={value.defaultModel}
              placeholder={DEFAULT_AI_MODEL}
              onChange={(event) => updateValue({ defaultModel: event.target.value })}
            />
          </label>
          <label className="settings-ai-panel__field">
            <span>
              已获取模型
              <InfoTip
                title="已获取模型"
                content="点击右侧『获取模型』按钮，可从当前配置的 Base URL 接口自动拉取服务商支持的全部可用模型 ID。"
              />
            </span>
            <select
              aria-label="AI 已获取模型"
              value={availableModels.includes(value.defaultModel) ? value.defaultModel : '__manual__'}
              onChange={(event) => {
                if (event.target.value !== '__manual__') updateValue({ defaultModel: event.target.value });
              }}
            >
              <option value="__manual__">手动输入</option>
              {availableModels.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>
          <label className="settings-ai-panel__field">
            <span>
              项目 Agent 模型
              <InfoTip
                title="项目 Agent 模型"
                content="专门用于全剧本全局规划、角色设定推理与复杂多步骤 Agent 决策的高性能模型。留空时将直接继承默认模型。"
              />
            </span>
            <input
              aria-label="AI 项目 Agent 模型"
              value={value.projectAgentModel ?? ''}
              placeholder={value.defaultModel || DEFAULT_AI_MODEL}
              onChange={(event) => updateValue({
                projectAgentModel: event.target.value.trim() || undefined,
              })}
            />
          </label>
          <button className="btn settings-ai-panel__model-button" type="button" onClick={() => void handleFetchModels()} disabled={isLoadingModels}>
            <IconRefresh width={14} height={14} />
            {isLoadingModels ? '获取中…' : '获取模型'}
          </button>
        </div>

        <div className="settings-ai-panel__overrides">
          <div className="settings-ai-panel__label">
            阶段模型
            <InfoTip
              title="阶段模型覆盖 (Stage Overrides)"
              content="针对特定创作阶段指定单独模型。例如：语义分段与人物提取可使用高速轻量模型，表演指导与电影感镜头可使用推理能力更强的顶级模型；留空则统一使用默认模型。"
            />
          </div>
          {(Object.keys(AI_PROSE_STAGE_LABELS) as AiProseStage[]).map((stage) => (
            <label key={stage} className="settings-ai-panel__override">
              <span>
                {AI_PROSE_STAGE_LABELS[stage]}
                <InfoTip
                  title={AI_PROSE_STAGE_LABELS[stage]}
                  content={
                    stage === 'segmentation'
                      ? '将长篇故事文本切分为适合视觉演出的独立镜头与场景切片。'
                      : stage === 'characterExtraction'
                        ? '识别剧本台词中的说话人、旁白与登场角色。'
                        : stage === 'normalization'
                          ? '规范化标点符号、台词格式及视觉演出描述。'
                          : stage === 'rhythm'
                            ? '评估句子情绪与阅读停顿，推算更自然的时间轴节奏。'
                            : stage === 'acting'
                              ? '为 Live2D 模型生成细腻的表情参数、视线焦点与动作情绪建议。'
                              : '规划景别推拉、镜头旋转、虚化与景深构图等视听语言。'
                  }
                />
                {AI_PROSE_STAGE_HINTS[stage] ? (
                  <em className="settings-ai-panel__stage-hint">{AI_PROSE_STAGE_HINTS[stage]}</em>
                ) : null}
              </span>
              <input
                aria-label={`${AI_PROSE_STAGE_LABELS[stage]}模型`}
                value={value.modelOverrides?.[stage] ?? ''}
                placeholder={value.defaultModel || DEFAULT_AI_MODEL}
                onChange={(event) => {
                  const modelOverrides = { ...(value.modelOverrides ?? {}) };
                  if (event.target.value.trim()) modelOverrides[stage] = event.target.value.trim();
                  else delete modelOverrides[stage];
                  updateValue({ modelOverrides });
                }}
              />
            </label>
          ))}
        </div>

        <div className="settings-ai-panel__credential">
          <div className="settings-ai-panel__label">
            API 密钥
            <InfoTip
              title="API 密钥 (API Key)"
              content="大语言模型服务商提供的身份凭证与计费标识。在服务商后台生成后粘贴在此并点击保存。密钥仅加密保存在本机安全存储中，不会随剧本工程文件导出或共享。"
            />
          </div>
          <span className={`settings-ai-panel__status ${credentialConfigured ? 'is-ready' : ''}`}>
            {credentialConfigured ? '已配置' : '未配置'}
          </span>
          <input
            aria-label="AI API 密钥"
            type="password"
            value={credentialInput}
            onChange={(event) => setCredentialInput(event.target.value)}
            placeholder="输入新密钥"
            autoComplete="off"
          />
          <button className="btn" type="button" onClick={() => void handleCredentialSave()} disabled={!credentialInput.trim()}>保存</button>
          <button className="btn" type="button" onClick={() => void handleCredentialClear()} disabled={!credentialConfigured}>清除</button>
        </div>

        <div className="settings-ai-panel__footer">
          <button className="btn" type="button" onClick={() => void handleCapabilityProbe()}>测试连接</button>
          <span role="status">{message || (value.jsonOutputSupported ? 'JSON Output 可用' : '未测试')}</span>
        </div>
      </div>
    </Section>
  );
}

const Section = ({ title, children, last = false }: { title?: string; children: React.ReactNode; last?: boolean }) => (
  <section className={`settings-dialog__section${last ? ' settings-dialog__section--last' : ''}`}>
    {title && (
      <div className="settings-dialog__section-title">
        {title}
      </div>
    )}
    <div className="settings-dialog__section-body">{children}</div>
  </section>
);

const SettingItem = ({ title, description, control }: { title: string; description?: string; control: React.ReactNode }) => (
  <div className="settings-dialog__setting">
    <div className="settings-dialog__setting-copy">
      <div className="settings-dialog__setting-title">
        <span>{title}</span>
        {description && <InfoTip content={description} title={title} ariaLabel={`${title}说明`} />}
      </div>
    </div>
    <div className="settings-dialog__setting-control">{control}</div>
  </div>
);

const Toggle = ({ label, active, onChange, disabled }: { label: string; active: boolean; onChange: (value: boolean) => void; disabled?: boolean }) => (
  <button
    type="button"
    role="switch"
    aria-label={label}
    aria-checked={active}
    disabled={disabled}
    onClick={() => !disabled && onChange(!active)}
    className={`settings-dialog__toggle${active ? ' is-active' : ''}`}
  >
    <span className="settings-dialog__toggle-thumb" />
  </button>
);

const Slider = ({ label, min, max, step, value, onChange, percent, suffix, formatValue }: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  percent?: boolean;
  suffix?: string;
  formatValue?: (value: number) => string;
}) => {
  const displayValue = formatValue
    ? formatValue(value)
    : percent
      ? `${Math.round(value * 100)}%`
      : `${value}${suffix || ''}`;
  return (
    <div className="settings-dialog__slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={displayValue}
        onChange={(event) => onChange(parseFloat(event.target.value))}
        className="settings-dialog__slider-input"
      />
      <div className="settings-dialog__slider-value">{displayValue}</div>
    </div>
  );
};

function formatCompactNumber(value: number, maxFractionDigits: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
    useGrouping: false,
  });
}

const SegmentedControl = ({ options, value, onChange, ariaLabel }: { options: { label: string; value: any }[]; value: any; onChange: (value: any) => void; ariaLabel?: string }) => (
  <div role="group" aria-label={ariaLabel} className="settings-dialog__segmented">
    {options.map((option) => (
      <button
        key={option.label}
        type="button"
        onClick={() => onChange(option.value)}
        aria-pressed={value === option.value}
        className={`btn settings-dialog__segmented-option${value === option.value ? ' is-active' : ''}`}
      >
        {option.label}
      </button>
    ))}
  </div>
);

const InfoCard = ({ label, value }: { label: string; value: string }) => (
  <div className="settings-dialog__info-card">
    <div className="settings-dialog__info-label">{label}</div>
    <div className="settings-dialog__info-value">{value}</div>
  </div>
);

interface SettingsTextInputProps {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  inputStyle?: React.CSSProperties;
  disabled?: boolean;
  readOnly?: boolean;
}

const TextInput = ({ ariaLabel, value, onChange, placeholder, style, inputStyle, disabled, readOnly }: SettingsTextInputProps) => {
  const [isFocused, setIsFocused] = useState(false);
  return (
    <div className="settings-dialog__input-wrap" style={style}>
      <input
        type="text"
        name={ariaLabel}
        autoComplete="off"
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        disabled={disabled}
        readOnly={readOnly}
        className={`settings-dialog__input${isFocused ? ' is-focused' : ''}`}
        style={inputStyle}
      />
    </div>
  );
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function getPathFileName(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').split('/').pop() || pathValue;
}

function formatCollaborationSessionBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return '0 B';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createVoiceOperationErrorStatus(rootPath: string, error: unknown): GptSovitsStatusResult {
  return {
    success: false,
    configured: !!rootPath.trim(),
    state: 'error',
    logs: [],
    error: getErrorMessage(error),
  };
}

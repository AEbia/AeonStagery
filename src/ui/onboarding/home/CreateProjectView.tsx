import { InfoTip, Tooltip } from '../../Tooltip';
import { IconCheck, IconChevronDown, IconChevronUp, IconFileText, IconFolder } from '../../icons';
import { VideoFormatFields } from '../../VideoFormatFields';
import { TemplateCapabilityConfig, TemplatePackageSelector } from '../../templates/TemplateCapabilityConfig';
import type { ProjectHomeProps, NavigationTarget, CreateView } from '../ProjectHome';
import type { CreateProjectDraft } from './useCreateProjectDraft';
import { Field, HomeFormSection, HomeSubviewFrame } from './HomeSubviewFrame';

type Props = Required<Pick<ProjectHomeProps, 'templatePackages'>> & Pick<ProjectHomeProps, 'onDeleteTemplatePackage'> & {
  draft: CreateProjectDraft;
  createView: CreateView;
  navigateTo: (target: NavigationTarget) => void;
};

export function CreateProjectView({ draft, createView, navigateTo, templatePackages, onDeleteTemplatePackage }: Props) {
  const {
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
  } = draft;
  const capabilities = createView === 'template-capabilities';
  return <HomeSubviewFrame title={capabilities ? '模板能力配置' : '新建项目'}
    info={capabilities ? '配置项目的初始角色和默认对白样式。' : '选择模板包并调整加载顺序，角色和对白样式可在模板能力中配置。'}
    onGoHome={() => navigateTo('start')} onBack={() => navigateTo(capabilities ? 'create-form' : 'start')}
    parent={capabilities ? { label: '新建项目', onClick: () => navigateTo('create-form') } : undefined}>
    {createView === 'form' ? (
      <>
        <HomeFormSection title="项目信息">
          <Field label="项目名称">
            <input
              className="ph-input"
              value={projectName}
              onChange={(event) => handleNameChange(event.target.value)}
              placeholder="例如：第 1 话演出稿"
            />
          </Field>

          <Field label="项目位置">
            <div className="ph-browse-row">
              <input
                className="ph-input"
                value={projectRootPath}
                onChange={(event) => {
                  setIsRootPathDirty(true);
                  setProjectRootPath(event.target.value);
                }}
                placeholder="例如：Documents/AeonStagery Projects/第 1 话演出稿"
              />
              <button className="btn ph-btn-compact" onClick={() => { void handleBrowseLocation(); }}>
                浏览
              </button>
            </div>
          </Field>
        </HomeFormSection>

        <HomeFormSection title="画布与帧率" info="分辨率和帧率保存在项目中，创建后可在画布设置中调整。">
          <div className="ph-video-section">
            <VideoFormatFields value={videoFormat} onChange={setVideoFormat} idPrefix="create-video" disabled={isSubmitting} />
            {videoFormatError && <p role="alert" className="video-format__error">{videoFormatError}</p>}
          </div>
        </HomeFormSection>

        <HomeFormSection title="模板与角色">
          <TemplatePackageSelector
            compact
            packages={templatePackages}
            selectedIds={selectedTemplateIds}
            onToggle={toggleTemplate}
            onMove={moveTemplate}
            onDeletePackage={onDeleteTemplatePackage}
          />
          <div className="ph-capability-card">
            <div>
              <div className="ph-field-label">
                模板能力
                <InfoTip content="配置项目的初始角色和默认对白样式。" />
              </div>
              <div className="ph-capability-count">
                已选择 {selectedCharacterPresetIds.length} 个初始角色
              </div>
            </div>
            <button
              type="button"
              className="btn ph-btn-compact"
              onClick={() => navigateTo('create-capabilities')}
            >
              配置模板能力
            </button>
          </div>
        </HomeFormSection>

        <HomeFormSection title="导入 WebGAL 剧本（可选）"
          info="多个 WebGAL .txt 剧本会按列表顺序合并为连续时间线，支持对白、旁白、背景及立绘进出场与移动。">
          {webgalScriptFiles.length > 0 ? (
            <div className="ph-webgal-scripts">
              {webgalScriptFiles.map((file, index) => (
                <div key={`${file.name}:${index}`} className="ph-webgal-script">
                  <span className="ph-webgal-order">{index + 1}</span>
                  <span className="ph-webgal-script-name" title={file.name}>{file.name}</span>
                  <div className="ph-webgal-script-actions">
                    <button
                      type="button"
                      className="btn ph-btn-compact ph-webgal-tiny"
                      onClick={() => handleMoveWebGalScript(index, -1)}
                      disabled={index === 0 || isReadingWebgalScript}
                      title="上移"
                      aria-label={`${file.name} 上移`}
                    >
                      <IconChevronUp width={14} height={14} />
                    </button>
                    <button
                      type="button"
                      className="btn ph-btn-compact ph-webgal-tiny"
                      onClick={() => handleMoveWebGalScript(index, 1)}
                      disabled={index === webgalScriptFiles.length - 1 || isReadingWebgalScript}
                      title="下移"
                      aria-label={`${file.name} 下移`}
                    >
                      <IconChevronDown width={14} height={14} />
                    </button>
                    <button
                      type="button"
                      className="btn ph-btn-compact ph-webgal-tiny"
                      onClick={() => handleRemoveWebGalScript(index)}
                      disabled={isReadingWebgalScript}
                    >
                      移除
                    </button>
                  </div>
                </div>
              ))}
              <div className="ph-webgal-script-footer">
                <button
                  type="button"
                  className="btn ph-btn-compact"
                  onClick={() => { void handleChooseWebGalScript(); }}
                  disabled={isReadingWebgalScript}
                >
                  {isReadingWebgalScript ? '正在读取...' : '继续添加剧本'}
                </button>
                <button
                  type="button"
                  className="btn ph-btn-compact"
                  onClick={handleClearWebGalScripts}
                  disabled={isReadingWebgalScript}
                >
                  全部移除
                </button>
              </div>
            </div>
          ) : (
            <div className="ph-file-picker">
              <IconFileText width={22} height={22} />
              <div className="ph-file-picker__name">
                {isReadingWebgalScript ? '正在读取...' : '未选择剧本文件'}
              </div>
              <button
                type="button"
                className="btn ph-btn-compact"
                onClick={() => { void handleChooseWebGalScript(); }}
                disabled={isReadingWebgalScript}
              >
                选择剧本文件
              </button>
            </div>
          )}

          <div className="ph-webgal-options">
            <div className="ph-option-group" role="group" aria-label="阅读速度">
              <div className="ph-field-label">
                阅读速度
                <InfoTip content="无配音台词按所选速度计算停留时间，有配音时以音频时长为准。" />
              </div>
              <div className="ph-speed-row">
                {[1.125, 1.5, 2.25].map((speed) => (
                  <button
                    key={speed}
                    type="button"
                    className={`btn ph-speed-btn ${webgalSpeed === speed ? 'ph-speed-btn--active' : ''}`}
                    aria-pressed={webgalSpeed === speed}
                    onClick={() => handleWebgalSpeedChange(speed)}
                  >
                    {speed === 1.125 ? '慢速' : speed === 1.5 ? '标准' : '快速'}
                  </button>
                ))}
              </div>
            </div>

            <div className="ph-option-group" role="group" aria-label="衔接处处理">
              <div className="ph-field-label">
                衔接处处理
                <InfoTip content="多个剧本衔接时角色会全部退场，背景按所选方式处理。" />
              </div>
              <div className="ph-speed-row">
                {[
                  { value: 'black' as const, label: '黑场', hint: '背景淡出为黑并停留片刻，下一剧本再淡入' },
                  { value: 'fade' as const, label: '淡入再淡出', hint: '背景快速淡出，下一剧本的背景淡入' },
                  { value: 'none' as const, label: '不做任何改动', hint: '背景无缝衔接（只执行角色退场）' },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`btn ph-speed-btn ${webgalChapterTransition === option.value ? 'ph-speed-btn--active' : ''}`}
                    aria-pressed={webgalChapterTransition === option.value}
                    onClick={() => handleWebgalChapterTransitionChange(option.value)}
                    title={option.hint}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {webgalScriptReport && (
            <div className="ph-webgal-summary">
              <div className="ph-webgal-stats">
                {webgalScriptFiles.length > 1 && `已合并 ${webgalScriptFiles.length} 个剧本 · `}
                {(() => {
                  const { stats, characters } = webgalScriptReport;
                  const parts = [
                    `对白 ${stats.dialogueCount + stats.narrationCount} 句`,
                    `角色 ${characters.length} 个`,
                    `背景 ${stats.backgroundChanges} 处`,
                    `登场 ${stats.figureEnters} 次`,
                    `退场 ${stats.figureExits} 次`,
                    `移动 ${stats.transforms} 次`,
                  ];
                  if (stats.bgmCount > 0) parts.push(`音乐 ${stats.bgmCount} 首`);
                  if (stats.sfxCount > 0) parts.push(`音效 ${stats.sfxCount} 处`);
                  return parts.join(' · ');
                })()}
              </div>
              {webgalScriptReport.unsupportedCommands.length > 0 && (
                <div className="ph-webgal-warning">
                  未识别指令 {webgalScriptReport.unsupportedCommands.length} 条（已跳过）
                </div>
              )}
            </div>
          )}

          <div className="ph-option-group">
            <div className="ph-field-label">
              素材目录（可选）
              <InfoTip content="选择含 figure、background 等子目录的 WebGAL 素材目录以解析立绘和背景，未选时保留项目相对路径。" />
            </div>
            <div className="ph-file-picker">
              <IconFolder width={20} height={20} />
              <div className="ph-file-picker__name" title={webgalAssetSource?.path}>
                {webgalAssetSource ? webgalAssetSource.path : '未选择素材目录'}
              </div>
              {webgalAssetSource ? (
                <button className="btn ph-btn-compact" onClick={handleClearWebGalAssetSource}>
                  移除
                </button>
              ) : (
                <button
                  className="btn ph-btn-compact"
                  onClick={() => { void handleChooseWebGalAssetSource(); }}
                >
                  选择素材目录
                </button>
              )}
            </div>
          </div>
        </HomeFormSection>

        <div className="ph-footer-row">
          <div />
          <Tooltip content="创建 project.json、默认场景和资源目录。">
            <button
              className="btn btn--primary ph-btn-primary-compact"
              onClick={() => { void handleCreate(); }}
              disabled={!projectName.trim() || !projectRootPath.trim() || isSubmitting || !!videoFormatError}
            >
              {isSubmitting ? '正在创建...' : '创建项目'}
            </button>
          </Tooltip>
        </div>
      </>
    ) : (
      <>
        <TemplateCapabilityConfig
          dialogueStyles={availableDialogueStyles}
          resolvedDialogueStyle={resolvedDialogueStyle}
          onChangeDialogueStyleOverride={handleChangeDialogueStyleOverride}
          characterPresets={availableCharacterPresets}
          selectedCharacterPresetIds={selectedCharacterPresetIds}
          onToggleCharacterPreset={toggleCharacterPreset}
          characterVariantImportMode={characterVariantImportMode}
          onChangeCharacterVariantImportMode={setCharacterVariantImportMode}
        />
        <div className="ph-footer-row ph-footer-row--end">
          <button type="button" className="btn btn--primary ph-btn-primary-compact" onClick={() => navigateTo('create-form')}>
            <IconCheck width={16} height={16} /> 完成配置
          </button>
        </div>
      </>
    )}
  </HomeSubviewFrame>;
}

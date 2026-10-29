import { InfoTip } from '../../Tooltip';
import { VideoFormatFields } from '../../VideoFormatFields';
import { TemplateCapabilityConfig, TemplatePackageSelector } from '../../templates/TemplateCapabilityConfig';
import type { ProjectHomeProps, NavigationTarget, CreateView } from '../ProjectHome';
import type { CreateProjectDraft } from './useCreateProjectDraft';
import { Field, HomeSubviewFrame } from './HomeSubviewFrame';

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
    info={capabilities ? '配置会应用到项目初始化的模板能力。' : '选择模板包和优先级；角色等细项进入模板能力配置。'}
    onGoHome={() => navigateTo('start')} onBack={() => navigateTo(capabilities ? 'create-form' : 'start')}
    parent={capabilities ? { label: '新建项目', onClick: () => navigateTo('create-form') } : undefined}>
    {createView === 'form' ? (
      <>
        <div className="ph-form-grid ph-stagger-2">
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
        </div>

        <section className="ph-stagger-3" aria-labelledby="create-video-title">
          <h3 id="create-video-title" className="ph-field-label">画布与帧率</h3>
          <VideoFormatFields value={videoFormat} onChange={setVideoFormat} idPrefix="create-video" disabled={isSubmitting} />
          <p className="video-format__message">分辨率和帧率将保存在此项目中，创建后可在画布设置中调整。</p>
          {videoFormatError && <p role="alert" className="video-format__error">{videoFormatError}</p>}
        </section>

        <div className="ph-stagger-3">
          <TemplatePackageSelector
            compact
            packages={templatePackages}
            selectedIds={selectedTemplateIds}
            onToggle={toggleTemplate}
            onMove={moveTemplate}
            onDeletePackage={onDeleteTemplatePackage}
          />
        </div>

        <div className="ph-capability-card ph-stagger-4">
          <div>
            <div className="ph-field-label">
              模板能力
              <InfoTip content="已选择初始角色。角色、对白样式和后续模板能力会在这里集中配置。" />
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

        <div className="ph-webgal-card ph-stagger-4">
          <div>
            <div className="ph-field-label">
              导入 WebGAL 剧本（可选）
              <InfoTip content="可以一次选择多个 WebGAL 剧本文件（例如按章节拆分的多个 .txt）。创建项目时会按选择顺序合并成一条连续时间线：对白、旁白、背景、立绘登场/退场与移动，中间不会中断。" />
            </div>
          </div>

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
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn ph-btn-compact ph-webgal-tiny"
                      onClick={() => handleMoveWebGalScript(index, 1)}
                      disabled={index === webgalScriptFiles.length - 1 || isReadingWebgalScript}
                      title="下移"
                    >
                      ↓
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
            <div className="ph-browse-row">
              <div className="ph-webgal-file-name">
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

          <div>
            <div className="ph-field-label">
              阅读速度
              <InfoTip content="决定没有配音的台词停留多久；有配音的台词以音频实际时长为准。" />
            </div>
          </div>
          <div className="ph-speed-row">
            {[1.125, 1.5, 2.25].map((speed) => (
              <button
                key={speed}
                type="button"
                className={`btn ph-speed-btn ${webgalSpeed === speed ? 'ph-speed-btn--active' : ''}`}
                onClick={() => handleWebgalSpeedChange(speed)}
              >
                {speed === 1.125 ? '慢速' : speed === 1.5 ? '标准' : '快速'}
              </button>
            ))}
          </div>

          <div>
            <div className="ph-field-label">
              衔接处处理（多个剧本时生效）
              <InfoTip content="每个衔接处都会先让前一个剧本中仍登场的角色全部退场（固定行为）。背景的处理方式可以三选一。" />
            </div>
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
                onClick={() => handleWebgalChapterTransitionChange(option.value)}
                title={option.hint}
              >
                {option.label}
              </button>
            ))}
          </div>

          {webgalScriptReport && (
            <div className="ph-webgal-summary">
              <div className="ph-webgal-stats">
                {webgalScriptFiles.length > 1 && `已合并 ${webgalScriptFiles.length} 个剧本，按选择顺序连续演出 · `}
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

          <div>
            <div className="ph-field-label">
              素材目录（可选）
              <InfoTip content="选择 WebGAL 工程里直接包含 figure、background 等素材子目录的目录，剧本里的立绘和背景就会引用该素材库；不选则引用会暂时保留为项目相对路径。" />
            </div>
            {webgalAssetSource && (
              <div className="ph-webgal-source-info">
                已连接：{webgalAssetSource.path}（@mount/{webgalAssetSource.mountId}）
              </div>
            )}
          </div>

          <div className="ph-browse-row">
            <div className="ph-webgal-file-name">
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

        <div className="ph-footer-row ph-stagger-5">
          <div className="ph-hint-text">
            <InfoTip content="会生成 project.json、默认场景入口和资源目录。" ariaLabel="创建项目说明" />
          </div>
          <button
            className="btn btn--primary ph-btn-primary-compact"
            onClick={() => { void handleCreate(); }}
            disabled={!projectName.trim() || !projectRootPath.trim() || isSubmitting || !!videoFormatError}
          >
            {isSubmitting ? '正在创建...' : '创建项目'}
          </button>
        </div>
      </>
    ) : (
      <div className="ph-stagger-2">
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
      </div>
    )}
  </HomeSubviewFrame>;
}

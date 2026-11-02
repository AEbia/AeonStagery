import type React from 'react';
import { AI_PROSE_EFFORTS } from '../../api/types/ai-prose-authoring';
import type { ProjectAgentProjectContext } from '../../api/types/project-agent-ipc';
import {
  IconX,
  IconFile,
  IconWarning,
  IconPlus,
  IconImage,
  IconChevronDown,
  IconSquare,
  IconSend,
  IconCheck,
} from '../icons';
import { hasImageDropData, readDroppedImage } from './imageDrop';
import type { AgentWindowSettings } from './useAgentWindowSettings';
import type { AgentImageAttachmentState } from './useAgentImageAttachment';
import type { AgentFileMentions } from './useAgentFileMentions';

interface AgentWindowComposerProps {
  settings: AgentWindowSettings;
  images: AgentImageAttachmentState;
  mentions: AgentFileMentions;
  selectedId: string | null;
  selectedRunning: boolean;
  selectedNoContinue: boolean;
  anyRunning: boolean;
  context: ProjectAgentProjectContext | null;
  projectName: string;
  draft: string;
  fullAccess: boolean;
  setFullAccess: (value: boolean) => void;
  pendingStartId: string | null;
  supplementSending: boolean;
  canAttachImage: boolean;
  sendComposer: () => void;
  cancelTask: () => void;
}
export function AgentWindowComposer({
  settings,
  images,
  mentions,
  selectedId,
  selectedRunning,
  selectedNoContinue,
  anyRunning,
  context,
  projectName,
  draft,
  fullAccess,
  setFullAccess,
  pendingStartId,
  supplementSending,
  canAttachImage,
  sendComposer,
  cancelTask,
}: AgentWindowComposerProps) {
  const {
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
  } = settings;
  const {
    imageAttachment,
    imageProcessing,
    attachError,
    fileInputRef,
    handlePickImage,
    handleFileChange,
    removeImage,
    attachImage,
  } = images;
  const {
    draftRef,
    mentionOpen,
    setMentionOpen,
    mentionIndex,
    setMentionIndex,
    mentionFiles,
    mentionCandidates,
    handleDraftChange,
    insertMention,
  } = mentions;
  /**
   * Shared input box (ADR0023): one persistent composer surface pinned to the
   * footer of both the welcome surface and every conversation — same seat,
   * same width, same card chrome, so sending never moves or widens it.
   */
  const composerPlaceholder = selectedId
    ? (selectedRunning ? '追加指令…' : '继续输入，发送给当前对话…')
    : `可向 ${projectName} 询问任何事，输入 @ 提及文件`;

  const composerBlocked = anyRunning && !selectedRunning;
  const composerBlockedHint = composerBlocked
    ? '另一个对话正在执行，请等待其回合结束。'
    : selectedNoContinue
      ? '该对话已不可继续执行，只能浏览或删除。'
      : null;

  const composerSendDisabled = imageProcessing || supplementSending || (selectedId
    ? (!draft.trim() && !imageAttachment) || composerBlocked || selectedNoContinue || !!pendingStartId
    : ((!draft.trim() && !imageAttachment) || !!pendingStartId || anyRunning));

  return (
    <div className="agent-composer-wrap">
      <div className="agent-promptbox"
        onDragOver={(event) => {
          if (!hasImageDropData(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = canAttachImage ? 'copy' : 'none';
        }}
        onDrop={(event) => {
          const image = readDroppedImage(event.dataTransfer);
          if (event.dataTransfer.files.length || image) event.preventDefault();
          if (image && canAttachImage) {
            event.stopPropagation();
            void attachImage(image);
              }
        }}
      >
        {imageProcessing && <p className="agent-promptbox__hint" role="status">正在处理图片…</p>}
        {imageAttachment && (
          <div className="agent-promptbox__preview">
            <img
              className="agent-promptbox__preview-thumb"
              src={imageAttachment.previewUrl}
              alt={imageAttachment.name}
            />
            <span className="agent-promptbox__preview-name" title={imageAttachment.name}>
              {imageAttachment.name}
            </span>
            <button
              type="button"
              className="agent-promptbox__preview-remove"
              onClick={removeImage}
              aria-label="移除图片"
            >
              <IconX width={12} height={12} />
            </button>
          </div>
        )}
        <textarea
          id="agent-window-supplement"
          ref={draftRef}
          className="agent-promptbox__input"
          value={draft}
          placeholder={composerPlaceholder}
          aria-label="任务描述"
          rows={3}
          disabled={selectedId ? (composerBlocked || selectedNoContinue) : false}
          onChange={handleDraftChange}
          onPaste={(event) => {
            const file = Array.from(event.clipboardData.files).find((entry) => entry.type.startsWith('image/'));
            if (file && canAttachImage) {
              event.preventDefault();
              void attachImage(file);
                }
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && mentionOpen && mentionCandidates.length > 0) {
              event.preventDefault();
              setMentionIndex((index) => (index + 1) % mentionCandidates.length);
            } else if (event.key === 'ArrowUp' && mentionOpen && mentionCandidates.length > 0) {
              event.preventDefault();
              setMentionIndex((index) => (
                (index - 1 + mentionCandidates.length) % mentionCandidates.length
              ));
            } else if (event.key === 'Enter' && !event.nativeEvent.isComposing && !mentionOpen) {
              event.preventDefault();
              sendComposer();
            } else if (event.key === 'Enter' && mentionOpen) {
              event.preventDefault();
              if (mentionCandidates[mentionIndex]) {
                insertMention(mentionCandidates[mentionIndex]!);
                  }
            } else if (event.key === 'Escape') {
              setMentionOpen(false);
              setModelMenuOpen(false);
                }
          }}
        />

        {mentionOpen && (
          <div className="agent-popover agent-popover--mention" role="listbox" aria-label="提及文件">
            <div className="agent-popover__head">
              <span className="agent-popover__head-icon" aria-hidden="true">
                <IconFile width={12} height={12} />
              </span>
              项目文件
            </div>
            <ul className="agent-popover__list">
              {mentionCandidates.length === 0 && (
                <li className="agent-popover__empty">没有匹配的文件</li>
              )}
              {mentionCandidates.map((path, index) => (
                <li
                  key={path}
                  role="option"
                  aria-selected={index === mentionIndex}
                  className={`agent-popover__item ${index === mentionIndex ? 'agent-popover__item--active' : ''}`}
                  onMouseEnter={() => setMentionIndex(index)}
                  onClick={() => insertMention(path)}
                >
                  <IconFile width={12} height={12} />
                  <span>{path}</span>
                </li>
              ))}
            </ul>
            {mentionFiles.length >= 500 && (
              <p className="agent-popover__hint">文件较多，仅显示部分（至多 500 项）</p>
            )}
          </div>
        )}

        {attachError && <p className="agent-promptbox__attach-error" role="alert">{attachError}</p>}

        {!selectedId && fullAccess && (
          <div className="agent-promptbox__access-warning" role="status">
            <IconWarning width={13} height={13} />
            <span>完全访问已开启：Agent 将获得执行 Shell 终端命令的系统权限。</span>
          </div>
        )}

        <div className="agent-promptbox__footer">
          <div className="agent-promptbox__footer-left">
            {!selectedId && (
              <label
                className="agent-promptbox__access"
                title="允许 Agent 执行任意终端命令；仅影响这次新建对话"
              >
                <input
                  type="checkbox"
                  checked={fullAccess}
                  disabled={anyRunning || !!pendingStartId}
                  onChange={(event) => setFullAccess(event.target.checked)}
                />
                <span className="agent-promptbox__access-track" aria-hidden="true" />
                <span>完全访问</span>
              </label>
            )}
            <button
              type="button"
              className="agent-promptbox__tool"
              onClick={handlePickImage}
              disabled={!canAttachImage || imageProcessing}
              title={context?.imageInputSupported === false
                ? '当前模型不支持图片输入'
                : imageProcessing ? '正在处理图片…' : '上传图片（也可粘贴或拖入）'}
              aria-label="上传图片"
            >
              <IconPlus width={15} height={15} />
              <IconImage width={15} height={15} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => void handleFileChange(event)}
            />
          </div>
          <div className="agent-promptbox__footer-right">
            <button
              type="button"
              className={`agent-promptbox__model ${modelMenuOpen ? 'agent-promptbox__model--open' : ''}`}
              onClick={toggleModelMenu}
              title="切换模型"
              aria-haspopup="listbox"
              aria-expanded={modelMenuOpen}
            >
              <span>{effectiveModel || '未配置模型'}</span>
              <IconChevronDown width={12} height={12} aria-hidden="true" />
            </button>
            {selectedRunning && !draft.trim() && !imageAttachment && !imageProcessing ? (
              <button
                type="button"
                className="agent-promptbox__stop"
                onClick={cancelTask}
                aria-label="停止生成"
                title="停止生成"
              >
                <IconSquare width={13} height={13} />
              </button>
            ) : (
              <button
                type="button"
                className="agent-promptbox__send"
                disabled={composerSendDisabled}
                onClick={sendComposer}
                aria-label="发送"
              >
                {pendingStartId || supplementSending || imageProcessing
                  ? <span className="agent-promptbox__send-spinner" aria-hidden="true" />
                  : <IconSend width={15} height={15} />}
              </button>
            )}
          </div>
        </div>

        {modelMenuOpen && (
          <div className="agent-model-panel" aria-label="模型与 Effort 设置">
            <div className="agent-model-panel__effort">
              <div className="agent-model-panel__effort-head">
                <span className="agent-model-panel__label">Effort</span>
                <span className="agent-model-panel__effort-value">{effort}</span>
              </div>
              <input
                type="range"
                className="agent-model-panel__effort-slider"
                min={0}
                max={AI_PROSE_EFFORTS.length - 1}
                step={1}
                value={AI_PROSE_EFFORTS.indexOf(effort as (typeof AI_PROSE_EFFORTS)[number])}
                aria-label="推理力度"
                style={{
                  '--effort-fill': `${(AI_PROSE_EFFORTS.indexOf(effort as (typeof AI_PROSE_EFFORTS)[number]) / (AI_PROSE_EFFORTS.length - 1)) * 100}%`,
                } as React.CSSProperties}
                onChange={(event) => {
                  const next = AI_PROSE_EFFORTS[Number(event.target.value)];
                  if (next) selectEffort(next);
                }}
              />
            </div>

            <div className="agent-model-panel__divider" aria-hidden="true" />
            {modelListState === 'loading' && (
              <p className="agent-popover__empty">正在获取模型列表...</p>
            )}
            {modelListState === 'error' && (
              <>
                <p className="agent-popover__empty">无法获取模型列表（请检查 AI 设置中的接口地址）。</p>
                <button
                  type="button"
                  className="btn btn--sm agent-popover__retry"
                  onClick={fetchModels}
                >
                  重试
                </button>
              </>
            )}
            {modelListState === 'ready' && (
              <ul
                className={`agent-popover__list ${modelList.length > 8 ? 'agent-model-panel__list--grid' : ''}`}
                role="listbox"
                aria-label="选择模型"
              >
                {modelList.length === 0 && (
                  <li className="agent-popover__empty">接口未返回可用模型</li>
                )}
                {modelList.map((model) => (
                  <li
                    key={model}
                    role="option"
                    aria-selected={model === effectiveModel}
                    title={model}
                    className={`agent-popover__item ${model === effectiveModel ? 'agent-popover__item--active' : ''}`}
                    onClick={() => selectModel(model)}
                  >
                    <span>{model}</span>
                    {model === effectiveModel && <IconCheck width={12} height={12} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {selectedId && composerBlockedHint && (
        <p className="agent-window__composer-hint">{composerBlockedHint}</p>
      )}
    </div>
  );
}

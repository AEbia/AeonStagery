import React from 'react';
import type { DraftSession } from '../../services/ai-authoring/AiProseDraftSession';
import { diagnoseAiError } from '../../services/ai-authoring/aiErrorPresentation';
import { STAGES, formatTime, type WorkbenchErrorInfo } from './workbenchPresentation';

export function AiSetupGuideBanner({
  onOpenSettings,
  contextLabel = 'AI 铺戏',
}: {
  onOpenSettings: () => void;
  contextLabel?: string;
}) {
  return (
    <div className="ai-prose-setup-banner" role="region" aria-label="AI 配置引导">
      <div className="ai-prose-setup-banner__body">
        <div className="ai-prose-setup-banner__title">
          <span className="ai-prose-setup-banner__badge">首次使用引导</span>
          <strong>尚未配置 AI 服务（API Key）</strong>
        </div>
        <p className="ai-prose-setup-banner__desc">
          {contextLabel}
          需要调用大语言模型来分析文本与生成演出编排。请先前往「AI 设置」填写服务商接口地址（Base URL）、保存 API 密钥（API Key）并选择模型（支持 DeepSeek、OpenAI等）。
        </p>
      </div>
      <button
        className="ai-prose-button ai-prose-button--primary ai-prose-setup-banner__action"
        type="button"
        onClick={onOpenSettings}
      >
        前往 AI 设置
      </button>
    </div>
  );
}

export function WorkbenchErrorAlert({
  info,
  onOpenSettings,
}: {
  info: WorkbenchErrorInfo;
  onOpenSettings?: () => void;
}) {
  const detailEntries = Object.entries(info.details).filter(([key, value]) => (
    key !== 'stage' && value !== undefined && value !== null && value !== ''
  ));
  const stageLabel = info.stage ? STAGES.find((stage) => stage.id === info.stage)?.label : undefined;
  const status = info.details.status;
  const diagnosis = diagnoseAiError(info.message, {
    code: info.code,
    status: typeof status === 'number' ? status : undefined,
  });
  const showDiagnosis = diagnosis.category !== 'unknown';
  return (
    <div className="ai-prose-inline-error" role="alert">
      <div className="ai-prose-error-header-row">
        <div className="ai-prose-error-heading">
          <strong>{stageLabel ? `${stageLabel}失败` : 'AI 工作台错误'}</strong>
          <span>{info.message}</span>
        </div>
        {diagnosis.suggestOpenSettings && onOpenSettings && (
          <button
            className="ai-prose-button ai-prose-button--secondary ai-prose-error-action"
            type="button"
            onClick={onOpenSettings}
          >
            前往 AI 设置
          </button>
        )}
      </div>
      {showDiagnosis && (
        <div className="ai-prose-error-guidance">
          <strong>{diagnosis.userTitle}：</strong>
          <span>
            {diagnosis.userMessage !== info.message ? `${diagnosis.userMessage} ` : ''}
            {diagnosis.suggestion}
          </span>
        </div>
      )}
      {(info.code || typeof status === 'number') && (
        <div className="ai-prose-error-meta">
          {info.code && <code>{info.code}</code>}
          {typeof status === 'number' && <code>HTTP {status}</code>}
        </div>
      )}
      {detailEntries.length > 0 && (
        <dl className="ai-prose-error-details">
          {detailEntries.map(([key, value]) => (
            <React.Fragment key={key}>
              <dt>{key}</dt>
              <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

export function EmptyStage({ message }: { message: string }) {
  return <div className="ai-prose-empty-stage"><span>—</span>{message}</div>;
}

export function ApplyDialog({ draft, onCancel, onConfirm }: { draft: DraftSession; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="ai-prose-apply-overlay" role="dialog" aria-modal="true" aria-labelledby="ai-prose-apply-title">
      <div className="ai-prose-apply-dialog">
        <h2 id="ai-prose-apply-title">写入正式时间线？</h2>
        <p>
          将添加
          {' '}
          {draft.preview?.statements.length ?? 0}
          {' '}
          条语句。
        </p>
        <div className="ai-prose-apply-summary">
          <div>
            <label>锚点</label>
            <b>{formatTime(draft.anchorTime)}</b>
          </div>
          <div>
            <label>时长</label>
            <b>{formatTime(draft.preview?.durationSeconds ?? 0)}</b>
          </div>
          <div>
            <label>人物</label>
            <b>{draft.confirmedMainCharacters.length}</b>
          </div>
        </div>
        <div className="ai-prose-apply-actions">
          <button className="ai-prose-button ai-prose-button--secondary" type="button" onClick={onCancel}>取消</button>
          <button className="ai-prose-button ai-prose-button--primary" type="button" onClick={onConfirm}>确认应用</button>
        </div>
      </div>
    </div>
  );
}


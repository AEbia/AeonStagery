import React from 'react';
import type { DraftSession } from '../../services/ai-authoring/AiProseDraftSession';
import { STAGES, formatTime, type WorkbenchErrorInfo } from './workbenchPresentation';

export function WorkbenchErrorAlert({ info }: { info: WorkbenchErrorInfo }) {
  const detailEntries = Object.entries(info.details).filter(([key, value]) => (
    key !== 'stage' && value !== undefined && value !== null && value !== ''
  ));
  const stageLabel = info.stage ? STAGES.find((stage) => stage.id === info.stage)?.label : undefined;
  const status = info.details.status;
  return (
    <div className="ai-prose-inline-error" role="alert">
      <div className="ai-prose-error-heading">
        <strong>{stageLabel ? `${stageLabel}失败` : 'AI 工作台错误'}</strong>
        <span>{info.message}</span>
      </div>
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
          条语句（含绑定对白的表演占位）；现有时间线不会被覆盖或平移。
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
          <button className="ai-prose-button ai-prose-button--primary" type="button" onClick={onConfirm}>确认原子应用</button>
        </div>
      </div>
    </div>
  );
}


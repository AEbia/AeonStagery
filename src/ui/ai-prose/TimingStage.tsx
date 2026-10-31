import type { DraftSession } from '../../services/ai-authoring/AiProseDraftSession';
import type { splitAiProseNormalizationTasks } from '../../services/ai-authoring/AiProseDeterministicCompiler';
import { ReadingSpeedControl, TabIntro } from './StageControls';
import { formatTime } from './workbenchPresentation';

export function TimingStage({
  draft,
  blocks,
  scriptReadingSpeed,
  onReadingSpeedChange,
  onRhythm,
  busy,
  enableActing,
  enableCinematic,
  onEnableActingChange,
  onEnableCinematicChange,
  onRunEnhancement,
  enhancementBusy,
  enhancementMessage,
  enhancementOperationCount,
  enhancementMotions,
}: {
  draft: DraftSession;
  blocks: ReturnType<typeof splitAiProseNormalizationTasks>;
  scriptReadingSpeed: number;
  onReadingSpeedChange: (value: number) => void;
  onRhythm: () => void;
  busy: boolean;
  enableActing: boolean;
  enableCinematic: boolean;
  onEnableActingChange: (value: boolean) => void;
  onEnableCinematicChange: (value: boolean) => void;
  onRunEnhancement: () => void;
  enhancementBusy: boolean;
  enhancementMessage: string;
  enhancementOperationCount: number;
  enhancementMotions: { readonly motionCount: number; readonly motions: readonly string[] } | null;
}) {
  const preview = draft.preview;
  const statementCount = preview?.statements.length ?? blocks.length;
  const duration = preview?.durationSeconds ?? 0;
  const maxDuration = Math.max(duration, 0.1);

  return (
    <section className="ai-prose-tab-panel is-active">
      <TabIntro title="时间编排" />
      <div className="ai-prose-timing-progress">
        <div>
          <strong>时间预览</strong>
          <b>
            {statementCount}
            {' '}
            句 ·
            {' '}
            {formatTime(duration)}
          </b>
        </div>
        <div className="ai-prose-progress-track">
          <span style={{ width: `${preview ? 100 : 0}%` }} />
        </div>
        <small>
          {scriptReadingSpeed.toFixed(1)}
          {' '}
          字/秒
        </small>
      </div>
      {preview && (
        <div className="ai-prose-timing-track">
          <div className="ai-prose-timing-axis">
            <span>00:00</span>
            <span>{formatTime(maxDuration * 0.5, 0)}</span>
            <span>{formatTime(maxDuration, 0)}</span>
          </div>
          <div className="ai-prose-timing-line" />
          {preview.statements.map((statement, index) => (
            <span
              key={`${statement.statementIndex}-${statement.time}`}
              className={`ai-prose-timing-block ${statement.speaker ? 'is-dialogue' : 'is-narration'}`}
              style={{
                left: `${Math.min(96, Math.max(0, ((statement.time - preview.anchorTime) / maxDuration) * 100))}%`,
                width: `${Math.max(3, Math.min(18, (statement.durationSeconds / maxDuration) * 100))}%`,
              }}
              title={`${statement.speaker || '旁白'} · ${statement.durationSeconds.toFixed(1)}s`}
            >
              #
              {String(index + 1).padStart(3, '0')}
            </span>
          ))}
        </div>
      )}
      <div className="ai-prose-timing-options">
        <ReadingSpeedControl value={scriptReadingSpeed} onChange={onReadingSpeedChange} compact />
        <button className="ai-prose-button ai-prose-button--secondary" type="button" onClick={onRhythm} disabled={busy || blocks.length === 0}>
          {preview ? '重新规划节奏' : '计算时间预览'}
        </button>
      </div>

      <div className="ai-enhance-panel ai-prose-optional-enhance">
        <div className="ai-prose-section-title">
          <h3>可选增强</h3>
          <span>{enhancementOperationCount > 0 ? `${enhancementOperationCount} 操作` : '基线'}</span>
        </div>
        <div className="ai-enhance-mode-row" role="group" aria-label="可选增强">
          <button
            type="button"
            className={`ai-prose-button ${enableActing ? 'ai-prose-button--primary' : 'ai-prose-button--secondary'}`}
            onClick={() => onEnableActingChange(!enableActing)}
            aria-pressed={enableActing}
            disabled={busy || !preview}
          >
            表演指导
          </button>
          <button
            type="button"
            className={`ai-prose-button ${enableCinematic ? 'ai-prose-button--primary' : 'ai-prose-button--secondary'}`}
            onClick={() => onEnableCinematicChange(!enableCinematic)}
            aria-pressed={enableCinematic}
            disabled={busy || !preview}
          >
            电影感
          </button>
          <button
            type="button"
            className="ai-prose-button ai-prose-button--secondary"
            onClick={onRunEnhancement}
            disabled={busy || !preview || (!enableActing && !enableCinematic)}
          >
            {enhancementBusy ? '增强中…' : '运行可选增强'}
          </button>
        </div>
        {enhancementMessage && (
          <div className="ai-enhance-note">{enhancementMessage}</div>
        )}
        {enhancementMotions && enhancementMotions.motionCount > 0 && (
          <div className="ai-enhance-motion-summary">
            <strong>
              表演指导已为
              {' '}
              {enhancementMotions.motionCount}
              {' '}
              条对白填充动作：
            </strong>
            <span>{enhancementMotions.motions.join('、')}</span>
          </div>
        )}
        <p className="ai-prose-timing-hint">
          应用时始终写入确定性基线与角色表演占位；可选增强 patch 若已生成将一并原子提交。
          既有正式 scene 请用「正式增强」模式。
        </p>
      </div>

      <div className="ai-prose-timing-table">
        <div className="ai-prose-timing-row is-head">
          <span>#</span>
          <span>语句</span>
          <span>时长</span>
          <span>起点</span>
          <span>间隔</span>
        </div>
        {preview?.statements.map((statement, index) => (
          <div className="ai-prose-timing-row" key={`${statement.statementIndex}-${statement.time}`}>
            <span>
              #
              {String(index + 1).padStart(3, '0')}
            </span>
            <strong>{statement.text}</strong>
            <b>
              {statement.durationSeconds.toFixed(1)}
              s
            </b>
            <span>{formatTime(statement.time)}</span>
            <span>{statement.gapSecondsToNext ? `${statement.gapSecondsToNext.toFixed(2)}s` : '—'}</span>
          </div>
        ))}
      </div>
    </section>
  );
}


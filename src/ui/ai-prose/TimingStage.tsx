import { useRef, useState } from 'react';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { DraftSession } from '../../services/ai-authoring/AiProseDraftSession';
import type { splitAiProseNormalizationTasks } from '../../services/ai-authoring/AiProseDeterministicCompiler';
import { ReadingSpeedControl, TabIntro } from './StageControls';
import { formatTime, resolveSpeakerColors, summarizeTiming } from './workbenchPresentation';

export function TimingStage({
  draft,
  document,
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
  document: CurrentSceneDocument;
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
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const rows = useRef(new Map<number, HTMLTableRowElement>());
  const stats = summarizeTiming(preview ?? { statements: [], anchorTime: 0, durationSeconds: 0 });
  const colors = resolveSpeakerColors([
    ...draft.confirmedMainCharacters, ...(preview?.statements.map((statement) => statement.speaker) ?? []),
  ], document.meta.characters);

  return (
    <section className="ai-prose-tab-panel is-active">
      <TabIntro title="时间编排" />
      <div className="ai-prose-timing-layout">
        <div className="ai-prose-timing-main">
          <div className="ai-prose-timing-stats">
            <strong>总时长 {formatTime(duration)}</strong>
            <span>{statementCount} 句（对白 {stats.dialogueCount} / 旁白 {stats.narrationCount}）</span>
            <span>平均 {stats.averageDuration.toFixed(1)}s</span>
            <span>最长 {stats.longestDuration.toFixed(1)}s</span>
          </div>
          {preview && (
            <div className="ai-prose-timing-track">
              <div className="ai-prose-timing-axis">
                {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
                  <span key={fraction}>{formatTime(duration * fraction, 0)}</span>
                ))}
              </div>
              <div className="ai-prose-timing-lane">
                {preview.statements.map((statement, index) => (
                  <button type="button" key={statement.statementIndex}
                    className={`ai-prose-timing-block ${selectedIndex === index || hoveredIndex === index ? 'is-highlighted' : ''}`}
                    style={{
                      left: `${duration > 0 ? ((statement.time - preview.anchorTime) / duration) * 100 : 0}%`,
                      width: `${duration > 0 ? (statement.durationSeconds / duration) * 100 : 0}%`,
                      background: colors.get(statement.speaker) ?? 'var(--text-muted)',
                    }}
                    title={`#${String(index + 1).padStart(3, '0')} ${statement.speaker || '旁白'} · ${statement.durationSeconds.toFixed(1)}s · ${formatTime(statement.time)}`}
                    aria-label={`定位语句 #${String(index + 1).padStart(3, '0')} ${statement.speaker || '旁白'}`}
                    aria-pressed={selectedIndex === index}
                    onClick={() => {
                      setSelectedIndex(index);
                      const row = rows.current.get(index);
                      row?.scrollIntoView({ block: 'nearest' });
                      row?.focus({ preventScroll: true });
                    }}
                  />
                ))}
              </div>
            </div>
          )}
          <div className="ai-prose-timing-table">
            <table aria-label="语句时间预览">
              <thead><tr><th scope="col">#</th><th scope="col">说话人</th><th scope="col">语句</th><th scope="col">起点</th><th scope="col">时长</th><th scope="col">间隔</th></tr></thead>
              <tbody>
                {preview?.statements.map((statement, index) => (
                  <tr key={statement.statementIndex} tabIndex={-1}
                    ref={(element) => { if (element) rows.current.set(index, element); else rows.current.delete(index); }}
                    className={selectedIndex === index ? 'is-selected' : ''}
                    onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)}
                    onFocus={() => setHoveredIndex(index)} onBlur={() => setHoveredIndex(null)}>
                    <td>#{String(index + 1).padStart(3, '0')}</td>
                    <td><span className="ai-prose-timing-speaker"><i style={{ background: colors.get(statement.speaker) ?? 'var(--text-muted)' }} />{statement.speaker || '旁白'}</span></td>
                    <td className="ai-prose-timing-text">{statement.text}</td>
                    <td>{formatTime(statement.time)}</td>
                    <td>{statement.durationSeconds.toFixed(1)}s</td>
                    <td>{statement.gapSecondsToNext ? `${statement.gapSecondsToNext.toFixed(2)}s` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <aside className="ai-prose-timing-side" aria-label="节奏与可选增强">
          <div className="ai-prose-timing-options">
            <ReadingSpeedControl value={scriptReadingSpeed} onChange={onReadingSpeedChange} compact disabled={busy} />
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

        </aside>
      </div>
    </section>
  );
}

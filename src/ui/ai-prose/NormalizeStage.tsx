import type { CSSProperties } from 'react';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { DraftSession } from '../../services/ai-authoring/AiProseDraftSession';
import { TabIntro } from './StageControls';
import { EmptyStage } from './WorkbenchFeedback';
import { countBlocksByKind, groupNormalizationBlocks, resolveSpeakerColors, statusText } from './workbenchPresentation';

export function NormalizeStage({
  draft, document, selectedFilter, onFilterChange, onRetry, onNormalize, busy,
}: {
  draft: DraftSession;
  document: CurrentSceneDocument;
  selectedFilter: 'all' | 'dialogue' | 'narration';
  onFilterChange: (filter: 'all' | 'dialogue' | 'narration') => void;
  onRetry: (segmentIndex: number) => Promise<void>;
  onNormalize: () => void;
  busy: boolean;
}) {
  const groups = groupNormalizationBlocks(draft);
  const blocks = groups.flatMap((group) => group.blocks);
  const counts = countBlocksByKind(blocks);
  const colors = resolveSpeakerColors([
    ...draft.confirmedMainCharacters, ...blocks.map((block) => block.speaker),
  ], document.meta.characters);
  const speakerCounts = new Map<string, number>();
  blocks.forEach((block) => speakerCounts.set(block.speaker, (speakerCounts.get(block.speaker) ?? 0) + 1));
  const failedCount = groups.filter((group) => group.status === 'failed').length;
  let statementNumber = 0;
  return (
    <section className="ai-prose-tab-panel is-active">
      <TabIntro title="语句规范化" action={(
        <div className="ai-prose-normalize-actions">
          <div className="ai-prose-filter-buttons">
            {(['all', 'dialogue', 'narration'] as const).map((filter) => (
              <button key={filter} className={selectedFilter === filter ? 'is-active' : ''} type="button"
                aria-pressed={selectedFilter === filter} onClick={() => onFilterChange(filter)}>
                {filter === 'all' ? '全部' : filter === 'dialogue' ? '对白' : '旁白'} {counts[filter]}
              </button>
            ))}
          </div>
          <button className="ai-prose-button ai-prose-button--secondary" type="button" onClick={onNormalize}
            disabled={busy || (groups.length === draft.segmentation.segments.length && groups.every((group) => group.status === 'succeeded'))}>
            {groups.length === draft.segmentation.segments.length && groups.every((group) => group.status === 'succeeded') ? '语句已完成' : '继续规范化'}
          </button>
        </div>
      )} />
      <div className="ai-prose-speaker-legend" aria-label="说话人统计">
        <span>说话人：</span>
        {[...speakerCounts].map(([speaker, count]) => (
          <span key={speaker}><i style={{ background: colors.get(speaker) ?? 'var(--text-muted)' }} />{speaker || '旁白'} {count}</span>
        ))}
      </div>
      {failedCount > 0 && <div className="ai-prose-stage-callout ai-prose-stage-callout--warning"><b>{failedCount} 个故事段失败</b></div>}
      <div className="ai-prose-normalization-groups">
        {groups.map((group) => {
          const numbered = group.blocks.map((block) => ({ block, number: ++statementNumber }));
          const visible = numbered.filter(({ block }) => selectedFilter === 'all'
            || (selectedFilter === 'dialogue' ? block.speaker !== '' : block.speaker === ''));
          if (!visible.length && group.status === 'succeeded') return null;
          return (
            <section className="ai-prose-normalization-group" key={group.segmentIndex} aria-label={`故事段 ${group.segmentIndex + 1}`}>
              <h3 className="ai-prose-group-heading">
                故事段 {String(group.segmentIndex + 1).padStart(2, '0')}
                {group.lineRange && <span> · L{group.lineRange[0]}–L{group.lineRange[1]}</span>}
                <span> · {group.status === 'succeeded' ? `${group.blocks.length} 句` : statusText(group.status)}</span>
              </h3>
              {group.status === 'failed' && (
                <div className="ai-prose-normalization-error">
                  <p role="alert">规范化失败：{group.error?.message ?? '请求失败，请重试此段。'}</p>
                  <button className="ai-prose-button ai-prose-button--secondary" type="button" onClick={() => void onRetry(group.segmentIndex)} disabled={busy}>重试此段</button>
                </div>
              )}
              <div className="ai-prose-statement-list">
                {visible.map(({ block, number }) => (
                  <article className="ai-prose-statement-row" key={`${block.sourceStatementIndex}-${block.blockIndex}`}
                    style={{ '--ai-speaker-color': colors.get(block.speaker) ?? 'var(--text-muted)' } as CSSProperties}>
                    <span className="ai-prose-statement-number">#{String(number).padStart(3, '0')}</span>
                    <span className="ai-prose-statement-speaker">{block.speaker || '旁白'}</span>
                    <p>{block.text}</p>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
        {groups.length === 0 && <EmptyStage message="正文规范化尚未完成。" />}
      </div>
    </section>
  );
}

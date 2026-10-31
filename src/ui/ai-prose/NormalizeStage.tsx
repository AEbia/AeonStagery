import type { DraftSession } from '../../services/ai-authoring/AiProseDraftSession';
import type { splitAiProseNormalizationTasks } from '../../services/ai-authoring/AiProseDeterministicCompiler';
import { TabIntro } from './StageControls';
import { EmptyStage } from './WorkbenchFeedback';

export function NormalizeStage({
  draft,
  blocks,
  selectedFilter,
  onFilterChange,
  onRetry,
  onNormalize,
  busy,
}: {
  draft: DraftSession;
  blocks: ReturnType<typeof splitAiProseNormalizationTasks>;
  selectedFilter: 'all' | 'dialogue' | 'narration';
  onFilterChange: (filter: 'all' | 'dialogue' | 'narration') => void;
  onRetry: (segmentIndex: number) => Promise<void>;
  onNormalize: () => void;
  busy: boolean;
}) {
  const failedTasks = draft.normalization.filter((task) => task.status === 'failed');
  return (
    <section className="ai-prose-tab-panel is-active">
      <TabIntro
        title="语句规范化"
        action={(
          <div className="ai-prose-filter-buttons">
            {(['all', 'dialogue', 'narration'] as const).map((filter) => (
              <button
                key={filter}
                className={selectedFilter === filter ? 'is-active' : ''}
                type="button"
                aria-pressed={selectedFilter === filter}
                onClick={() => onFilterChange(filter)}
              >
                {filter === 'all' ? '全部' : filter === 'dialogue' ? '对白' : '旁白'}
              </button>
            ))}
          </div>
        )}
      />
      {failedTasks.length > 0 && (
        <div className="ai-prose-stage-callout ai-prose-stage-callout--warning">
          <b>
            {failedTasks.length}
            {' '}
            个故事段失败
          </b>
          {failedTasks.map((task) => (
            <button
              key={task.segmentIndex}
              className="ai-prose-button ai-prose-button--secondary"
              type="button"
              onClick={() => void onRetry(task.segmentIndex)}
              disabled={busy}
            >
              重试段
              {' '}
              {task.segmentIndex + 1}
            </button>
          ))}
        </div>
      )}
      <div className="ai-prose-statement-list">
        {blocks.map((block) => {
          const visible = selectedFilter === 'all'
            || (selectedFilter === 'dialogue' && block.speaker !== '')
            || (selectedFilter === 'narration' && block.speaker === '');
          if (!visible) return null;
          return (
            <article
              className={`ai-prose-statement-row ${block.speaker ? 'is-dialogue' : 'is-narration'}`}
              key={`${block.segmentIndex}-${block.sourceStatementIndex}-${block.blockIndex}`}
            >
              <span className="ai-prose-statement-number">
                #
                {String(block.blockIndex + 1).padStart(3, '0')}
              </span>
              <div>
                <small>
                  {block.speaker || '旁白'}
                  {' · 段 '}
                  {block.segmentIndex + 1}
                </small>
                <p>{block.text}</p>
              </div>
            </article>
          );
        })}
        {blocks.length === 0 && <EmptyStage message="正文规范化尚未完成。" />}
      </div>
      {blocks.length > 0 && (
        <div className="ai-prose-stage-callout">
          <button
            className="ai-prose-button ai-prose-button--secondary"
            type="button"
            onClick={onNormalize}
            disabled={busy || failedTasks.length > 0}
          >
            重新规范化
          </button>
        </div>
      )}
    </section>
  );
}


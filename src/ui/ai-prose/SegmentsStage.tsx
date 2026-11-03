import { useState } from 'react';
import { IconChevronRight } from '../icons';
import { visibleCharacterCount } from '../../services/ai-authoring/AiProseTextMetrics';
import type { DraftSession } from '../../services/ai-authoring/AiProseDraftSession';
import { InfoTip } from '../Tooltip';
import { TabIntro } from './StageControls';
import { EmptyStage } from './WorkbenchFeedback';
import { formatCount, getLineNumberAtOffset, statusText } from './workbenchPresentation';

export function SegmentsStage({
  draft,
  segments,
  targetBatchSize,
  onTargetBatchSizeChange,
  onPrepare,
  busy,
}: {
  draft: DraftSession;
  segments: DraftSession['segmentation']['segments'];
  targetBatchSize: number;
  onTargetBatchSizeChange: (value: number) => void;
  onPrepare: () => void;
  busy: boolean;
}) {
  const [expandedSegment, setExpandedSegment] = useState<number | null>(null);
  const lengths = segments.map((segment) => visibleCharacterCount(segment.sourceText));
  const average = lengths.length ? Math.round(lengths.reduce((sum, count) => sum + count, 0) / lengths.length) : 0;
  const longest = lengths.reduce((max, count) => Math.max(max, count), 0);
  return (
    <section className="ai-prose-tab-panel is-active">
      <TabIntro
        title="语义分段"
        action={<button className="ai-prose-button ai-prose-button--secondary" type="button" onClick={onPrepare} disabled={busy}>重新分析</button>}
      />
      <div className="ai-prose-segment-controls">
        <div className="ai-prose-segment-control">
          <div>
            <strong>
              目标处理量
              <InfoTip
                title="语义分段批大小"
                content="单次请求送入大语言模型进行分段分析的目标文本字数，平衡语义完整性与模型上下文开销。"
              />
            </strong>
            <output>
              {formatCount(targetBatchSize)}
              {' '}
              字
            </output>
          </div>
          <input
            aria-label="目标处理量"
            type="range"
            min="1000"
            max="12000"
            step="500"
            value={targetBatchSize}
            onChange={(event) => onTargetBatchSizeChange(Number(event.target.value))}
          />
          <small>
            约
            {' '}
            {draft.segmentation.targetSegmentCount}
            {' '}
            段
          </small>
        </div>
        <div className="ai-prose-segment-progress">
          <div>
            <strong>分段</strong>
            <b>
              {draft.segmentation.status === 'succeeded'
                ? `${segments.length} 段`
                : statusText(draft.segmentation.status)}
            </b>
          </div>
          <small>平均 {formatCount(average)} 字 · 最长 {formatCount(longest)} 字</small>
        </div>
      </div>
      <div className="ai-prose-segment-list">
        {segments.map((segment, index) => (
          <button
            key={`${segment.index}-${segment.startOffset}`}
            className={`ai-prose-segment-card ${expandedSegment === index ? 'is-expanded' : ''}`}
            type="button"
            onClick={() => setExpandedSegment(expandedSegment === index ? null : index)}
            aria-expanded={expandedSegment === index}
          >
            <div className="ai-prose-segment-card-head">
              <span>
                <i>{String(index + 1).padStart(2, '0')}</i>
                <strong>
                  故事段
                  {' '}
                  {index + 1}
                </strong>
                <small>
                  L
                  {getLineNumberAtOffset(draft.sourceText, segment.startOffset)}
                  –
                  {getLineNumberAtOffset(draft.sourceText, Math.max(segment.startOffset, segment.endOffset - 1))}
                  {' · '}{formatCount(lengths[index])} 字
                </small>
              </span>
              <IconChevronRight size={16} />
            </div>
            <div className="ai-prose-segment-body">
              <p>
                {segment.sourceText}
              </p>
            </div>
          </button>
        ))}
        {segments.length === 0 && <EmptyStage message="语义分段尚未完成。" />}
      </div>
    </section>
  );
}

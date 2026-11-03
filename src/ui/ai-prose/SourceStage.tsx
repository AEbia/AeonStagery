import type { ChangeEvent, MouseEventHandler, ReactNode } from 'react';
import type { AiProseAnchorMode } from '../../api/types/ai-prose-authoring';
import { IconFileText } from '../icons';
import { InfoTip } from '../Tooltip';
import { ReadingSpeedControl, TabIntro } from './StageControls';
import { estimateReadingSeconds, formatCount, formatTime } from './workbenchPresentation';

export function SourceReference({ sourceText, sourceName, busy, onEdit }: {
  sourceText: string;
  sourceName: string;
  busy: boolean;
  onEdit: MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <div className="ai-prose-source-document">
      <div className="ai-prose-source-document-head">
        <strong>原文参考</strong>
        <button className="ai-prose-button ai-prose-button--ghost" type="button" onClick={onEdit} disabled={busy}>编辑正文</button>
      </div>
      <textarea className="ai-prose-source-editor" aria-label="正文参考" value={sourceText} readOnly />
      <div className="ai-prose-field-foot"><strong title={sourceName}>{sourceName}</strong></div>
    </div>
  );
}

export function SourceEditor({
  sourceText,
  sourceName,
  visibleCount,
  spokenCount,
  scriptReadingSpeed,
  fileInputKey,
  busy,
  onSourceChange,
  onImportFile,
}: {
  sourceText: string;
  sourceName: string;
  visibleCount: number;
  spokenCount: number;
  scriptReadingSpeed: number;
  fileInputKey: number;
  busy: boolean;
  onSourceChange: (value: string) => void;
  onImportFile: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
}) {
  return (
    <div className="ai-prose-source-document">
      <div className="ai-prose-source-document-head">
        <strong>正文</strong>
        <div className="ai-prose-source-actions">
          <label className={`ai-prose-button ai-prose-button--secondary ai-prose-file-button ${busy ? 'is-disabled' : ''}`}>
            <IconFileText size={14} /> 导入正文
            <input key={fileInputKey} aria-label="导入正文文件" type="file" accept=".txt,.text,.md" onChange={(event) => void onImportFile(event)} disabled={busy} />
          </label>
          <button className="ai-prose-button ai-prose-button--ghost" type="button" onClick={() => onSourceChange('')} disabled={busy || !sourceText}>清空</button>
        </div>
      </div>
      <textarea
        className="ai-prose-source-editor"
        aria-label="完整正文"
        value={sourceText}
        onChange={(event) => onSourceChange(event.target.value)}
        disabled={busy}
        placeholder="粘贴完整正文，或导入 TXT / Markdown 文件。只做无损结构化，不改写剧情。"
        spellCheck={false}
      />
      <div className="ai-prose-field-foot">
        <strong title={sourceName}>{sourceName}</strong>
        <span title="按当前朗读速度估算，不含语句间停顿">{formatCount(visibleCount)} 字 · {formatCount(spokenCount)} 朗读 · 约 {formatTime(estimateReadingSeconds(spokenCount, scriptReadingSpeed), 0)} 纯朗读</span>
      </div>
    </div>
  );
}

export function SourceStage({
  anchorMode,
  scriptReadingSpeed,
  onReadingSpeedChange,
  editor,
  busy = false,
}: {
  anchorMode: AiProseAnchorMode;
  scriptReadingSpeed: number;
  onReadingSpeedChange: (value: number) => void;
  editor: ReactNode;
  busy?: boolean;
}) {
  return (
    <section className="ai-prose-tab-panel ai-prose-source-stage is-active">
      <TabIntro title="原文输入" />
      {editor}
      <div className="ai-prose-source-options">
        <div>
          <label>
            时间锚点
            <InfoTip
              title="时间锚点 (Anchor Mode)"
              content="决定 AI 生成的对白、动作与镜头在主工程时间轴上的起始插入位置。"
            />
          </label>
          <strong>{anchorMode === 'zero' ? '从 00:00.0 开始' : '从创建草稿时的播放头开始'}</strong>
        </div>
        <ReadingSpeedControl value={scriptReadingSpeed} onChange={onReadingSpeedChange} disabled={busy} />
      </div>
    </section>
  );
}

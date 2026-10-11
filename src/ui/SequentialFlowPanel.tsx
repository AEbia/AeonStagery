import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SemanticAuthorReceipt } from '../api/types/authoring';
import {
  SCENE_PACE_TIERS,
  type ScenePaceTier,
} from '../api/types/semantic-scene';
import {
  buildAppendSequentialLinesIntent,
  buildUpdateScenePaceTierIntent,
  compileSequentialDialogueDrafts,
  computeTimelineEndSeconds,
} from '../services/sequential-flow/SequentialFlowAuthoring';
import { useSetting } from './SettingsStore';
import {
  useSemanticAuthoringService,
} from './context/AppContext';
import { useSemanticDocument } from './store/storeHooks';
import { showToast } from './Toast';
import { IconCheck, IconSave } from './icons';
import { createSemanticTimelineCorrelationId } from './timeline/semanticTimelineEditing';

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

const SCENE_PACE_TIER_LABELS: Record<ScenePaceTier, string> = {
  snap: '快',
  normal: '正常',
  slow: '慢',
};

const DEFAULT_SCENE_PACE_TIER: ScenePaceTier = 'normal';

export function SequentialFlowPanel() {
  const { document: semanticDocument } = useSemanticDocument();
  const semanticAuthoring = useSemanticAuthoringService();
  const dialogueTextSpeed = useSetting('dialogueTextSpeed');
  const dialogueEntranceAnimation = useSetting('dialogueEntranceAnimation');
  const [sourceText, setSourceText] = useState(() => localStorage.getItem('aeonstagery_sequential_source') || '');
  const [singleLine, setSingleLine] = useState('');
  const [receipt, setReceipt] = useState<SemanticAuthorReceipt | null>(null);
  const [errorLog, setErrorLog] = useState('');
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    localStorage.setItem('aeonstagery_sequential_source', sourceText);
  }, [sourceText]);

  const scenePaceTier = semanticDocument?.meta.paceTier ?? DEFAULT_SCENE_PACE_TIER;

  const changeScenePaceTier = useCallback(async (tier: ScenePaceTier) => {
    if (!semanticAuthoring || !semanticDocument) {
      setErrorLog('当前没有加载场景。');
      return;
    }
    if (tier === (semanticDocument.meta.paceTier ?? DEFAULT_SCENE_PACE_TIER)) return;

    setIsApplying(true);
    setErrorLog('');
    try {
      const intent = buildUpdateScenePaceTierIntent(tier, {
        correlationId: createSemanticTimelineCorrelationId('sequential_flow'),
      });
      await semanticAuthoring.author(intent);
      showToast(`场景节奏档位已切换为${SCENE_PACE_TIER_LABELS[tier]}`, 'success');
    } catch (err: any) {
      setErrorLog(err?.message || String(err));
    } finally {
      setIsApplying(false);
    }
  }, [semanticAuthoring, semanticDocument]);

  const preview = useMemo(() => {
    if (!semanticDocument) return null;
    const lines = splitLines(sourceText).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const compiled = compileSequentialDialogueDrafts(lines, scenePaceTier, {
      textSpeed: dialogueTextSpeed,
      entranceAnimation: dialogueEntranceAnimation,
    });
    return {
      lines,
      anchorTime: computeTimelineEndSeconds(semanticDocument),
      compiled,
    };
  }, [semanticDocument, sourceText, scenePaceTier, dialogueTextSpeed, dialogueEntranceAnimation]);

  const appendText = useCallback(async (text: string) => {
    if (!semanticAuthoring || !semanticDocument) {
      setErrorLog('当前没有加载场景。');
      return;
    }
    const lines = splitLines(text).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      setErrorLog('请输入要追加的对白文本。');
      return;
    }

    setIsApplying(true);
    setErrorLog('');
    setReceipt(null);

    try {
      const intent = buildAppendSequentialLinesIntent(lines, {
        correlationId: createSemanticTimelineCorrelationId('sequential_flow'),
      });
      const nextReceipt = await semanticAuthoring.author(intent);
      setReceipt(nextReceipt);
      showToast(`顺序铺排已追加 ${nextReceipt.createdStatementIds.length} 条对白`, 'success');
      if (text === sourceText) setSourceText('');
      if (text === singleLine) setSingleLine('');
    } catch (err: any) {
      setErrorLog(err?.message || String(err));
    } finally {
      setIsApplying(false);
    }
  }, [semanticAuthoring, semanticDocument, singleLine, sourceText]);

  const canAppend = !!semanticAuthoring && !!semanticDocument && !isApplying;

  return (
    <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', marginBottom: 0 }}>
      <h3 style={{ marginBottom: 4, fontSize: 14 }}>顺序铺排</h3>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        每行一句对白,按顺序追加到时间线末尾;时长与间隔按场景节奏档位自动计算,无需设置时间与位置。
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>场景节奏档位</span>
        <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="场景节奏档位">
          {SCENE_PACE_TIERS.map((tier) => (
            <button
              key={tier}
              className={scenePaceTier === tier ? 'btn btn--primary' : 'btn'}
              onClick={() => void changeScenePaceTier(tier)}
              disabled={!canAppend}
              style={{ padding: '3px 12px', fontSize: 12 }}
            >
              {SCENE_PACE_TIER_LABELS[tier]}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          切换后自动时长按档位整体缩放,手动改过时长或位置的语句保持锁定。
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 140 }}>
          <label className="form-label">整段文本（每行一句）</label>
          <textarea
            aria-label="顺序铺排整段文本"
            value={sourceText}
            onChange={(event) => setSourceText(event.target.value)}
            disabled={isApplying}
            style={{ minHeight: 140, resize: 'vertical', background: 'var(--bg-tertiary)' }}
            placeholder={'你好。\n我想把这句话说清楚。'}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
            <button className="btn" onClick={() => { setSourceText(''); setReceipt(null); }} disabled={isApplying}>
              清空
            </button>
            <button className="btn btn--primary" onClick={() => void appendText(sourceText)} disabled={!canAppend || !sourceText.trim()}>
              <IconSave width={16} height={16} /> 整段追加
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label className="form-label" htmlFor="sequential-flow-single-line">单句追加</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="sequential-flow-single-line"
              aria-label="单句追加输入"
              type="text"
              value={singleLine}
              onChange={(event) => setSingleLine(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter' && singleLine.trim() && canAppend) {
                  event.preventDefault();
                  void appendText(singleLine);
                }
              }}
              disabled={isApplying}
              style={{ flex: 1, background: 'var(--bg-tertiary)' }}
              placeholder="输入一句对白后回车追加"
            />
            <button className="btn" onClick={() => void appendText(singleLine)} disabled={!canAppend || !singleLine.trim()}>
              追加
            </button>
          </div>
        </div>

        {errorLog && (
          <div role="alert" style={{ padding: 8, background: 'var(--error-surface)', color: 'var(--error)', borderRadius: 'var(--radius-sm)', fontSize: 12 }}>
            {errorLog}
          </div>
        )}

        <div style={{ minHeight: 0, flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {preview && (
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 12, background: 'var(--bg-tertiary)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>追加预览</strong>
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  {preview.lines.length} 句对白 · 预计 {preview.compiled.durationSeconds.toFixed(1)}s
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                <span>从 {preview.anchorTime.toFixed(1)}s 开始</span>
              </div>
              <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                {preview.compiled.statements.slice(0, 18).map((statement, index) => (
                  <div
                    key={`sequential-preview-${index}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '54px 64px 1fr',
                      gap: 8,
                      padding: '7px 10px',
                      borderBottom: index === Math.min(preview.compiled.statements.length, 18) - 1 ? 'none' : '1px solid var(--border-subtle)',
                      fontSize: 12,
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ color: 'var(--text-muted)' }}>{(preview.anchorTime + (statement.time ?? 0)).toFixed(1)}s</span>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {((statement.params as any).durationSeconds ?? 0).toFixed(1)}s
                    </span>
                    <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {(statement.params as any).text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {receipt && (
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 12, background: 'rgba(80, 200, 120, 0.08)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700 }}>
                <IconCheck width={14} height={14} /> 已追加
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
                {receipt.createdStatementIds.length} 条对白 · {receipt.historyDescriptor.fallbackLabel}
                {receipt.timeRange && ` · 至 ${receipt.timeRange.end.toFixed(1)}s`}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SequentialFlowPanel;

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AI_SCRIPT_SEGMENT_PLAN_JSON_SCHEMA,
  type AiScriptSegmentPlan,
  isAiScriptSegmentPlan,
} from '../api/types/ai-authoring';
import type { SemanticAuthorReceipt } from '../api/types/authoring';
import { compileAiScriptSegmentPlanToSceneStatements, type AiScriptSegmentSemanticCompileResult } from '../services/ai-authoring/AiScriptSegmentCompiler';
import { buildAiScriptSegmentSystemPrompt, buildAiScriptSegmentUserPrompt } from '../services/ai-authoring/AiScriptSegmentPrompt';
import {
  useEditorSelection,
  useSemanticDocument,
} from './store/storeHooks';
import {
  usePlaybackAdapter,
  useSemanticAuthoringService,
} from './context/AppContext';
import { showToast } from './Toast';
import { IconCheck, IconInfo, IconSave } from './icons';

interface AiScriptSegmentPanelProps {
  apiKey: string;
  baseUrl: string;
  modelName: string;
}

interface SegmentPreview {
  plan: AiScriptSegmentPlan;
  compiled: AiScriptSegmentSemanticCompileResult;
  anchorTime: number;
}

function roundTime(value: number): number {
  return Math.round(value * 10) / 10;
}

function extractStructuredContent(data: any): string {
  const message = data?.choices?.[0]?.message;
  if (!message) {
    throw new Error('LLM 返回缺少 message。');
  }
  if (message.refusal) {
    throw new Error(`模型拒绝生成: ${message.refusal}`);
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part: any) => typeof part === 'string' ? part : part?.text || '')
      .join('');
  }
  throw new Error('LLM 返回缺少结构化 JSON 内容。');
}

function createCorrelationId(): string {
  return globalThis.crypto?.randomUUID
    ? `ai_script_${globalThis.crypto.randomUUID()}`
    : `ai_script_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function statementIdFromRuntimeActionId(id: string): string {
  const match = id.match(/^statementId:(\d+):/);
  if (!match) return id;
  const start = match[0].length;
  return id.slice(start, start + Number(match[1]));
}

export function AiScriptSegmentPanel({
  apiKey,
  baseUrl,
  modelName,
}: AiScriptSegmentPanelProps) {
  const { document: semanticDocument } = useSemanticDocument();
  const { selectedActionIds, setSelectedIds } = useEditorSelection();
  const playbackAdapter = usePlaybackAdapter();
  const semanticAuthoring = useSemanticAuthoringService();
  const [sourceText, setSourceText] = useState(() => localStorage.getItem('aeonstagery_ai_script_source') || '');
  const [preview, setPreview] = useState<SegmentPreview | null>(null);
  const [receipt, setReceipt] = useState<SemanticAuthorReceipt | null>(null);
  const [errorLog, setErrorLog] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    localStorage.setItem('aeonstagery_ai_script_source', sourceText);
  }, [sourceText]);

  const selectedIds = useMemo(
    () => Object.keys(selectedActionIds).filter((id) => selectedActionIds[id]),
    [selectedActionIds],
  );
  const selectedStatementIds = useMemo(
    () => selectedIds.map(statementIdFromRuntimeActionId),
    [selectedIds],
  );

  const previewErrors = useMemo(
    () => preview?.compiled.issues.filter((issue) => issue.severity === 'error') || [],
    [preview],
  );

  const previewWarnings = useMemo(
    () => preview?.compiled.issues.filter((issue) => issue.severity === 'warning') || [],
    [preview],
  );

  const generatePreview = useCallback(async () => {
    if (!semanticDocument) {
      setErrorLog('当前没有加载场景。');
      return;
    }
    if (!apiKey) {
      setErrorLog('请先设置 API 密钥。');
      return;
    }
    if (!sourceText.trim()) {
      setErrorLog('请输入要铺成时间线的文本。');
      return;
    }

    setIsGenerating(true);
    setErrorLog('');
    setReceipt(null);

    try {
      const anchorTime = roundTime(playbackAdapter.getCurrentTime());
      const userPrompt = buildAiScriptSegmentUserPrompt(sourceText, {
        scene: semanticDocument,
        currentTime: anchorTime,
        selectedStatementIds,
      });
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: buildAiScriptSegmentSystemPrompt() },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.35,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'ai_script_segment_plan',
              strict: true,
              schema: AI_SCRIPT_SEGMENT_PLAN_JSON_SCHEMA,
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`LLM API Error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const content = extractStructuredContent(data);
      const parsed = JSON.parse(content);
      if (!isAiScriptSegmentPlan(parsed)) {
        throw new Error('模型输出不符合 AI 铺戏结构。');
      }

      setPreview({
        plan: parsed,
        compiled: compileAiScriptSegmentPlanToSceneStatements(parsed, semanticDocument),
        anchorTime,
      });
    } catch (err: any) {
      setPreview(null);
      setErrorLog(err?.message || String(err));
    } finally {
      setIsGenerating(false);
    }
  }, [apiKey, baseUrl, modelName, playbackAdapter, semanticDocument, selectedStatementIds, sourceText]);

  const applyPreview = useCallback(async () => {
    if (!preview || !semanticAuthoring || previewErrors.length > 0) return;

    setIsApplying(true);
    setErrorLog('');

    try {
      const result = await semanticAuthoring.authorAiScriptSegment(
        preview.compiled,
        preview.anchorTime,
        createCorrelationId(),
        { origin: 'ai-script-panel' },
      );
      const nextReceipt = result.receipt;
      setReceipt(nextReceipt);
      setSelectedIds({});
      showToast(`AI 铺戏已插入 ${nextReceipt.createdStatementIds.length} 个语义语句`, 'success');
    } catch (err: any) {
      setErrorLog(err?.message || String(err));
    } finally {
      setIsApplying(false);
    }
  }, [preview, previewErrors.length, semanticAuthoring, setSelectedIds]);

  const canApply = !!preview && previewErrors.length === 0 && !isGenerating && !isApplying && !!semanticAuthoring;

  return (
    <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', marginBottom: 0 }}>
      <h3 style={{ marginBottom: 12, fontSize: 14 }}>AI 铺戏</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 120 }}>
          <label className="form-label">文本原案</label>
          <textarea
            aria-label="文本原案"
            value={sourceText}
            onChange={(event) => setSourceText(event.target.value)}
            disabled={isGenerating || isApplying}
            style={{ minHeight: 120, resize: 'vertical', background: 'var(--bg-tertiary)' }}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <button className="btn" onClick={() => { setSourceText(''); setPreview(null); setReceipt(null); }} disabled={isGenerating || isApplying}>
            清空
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={generatePreview} disabled={isGenerating || isApplying}>
              {isGenerating && <span className="status-dot" style={{ marginRight: 8, animation: 'pulse-red 1.5s infinite' }} />}
              生成预览
            </button>
            <button className="btn btn--primary" onClick={applyPreview} disabled={!canApply}>
              <IconSave width={16} height={16} /> 应用到当前时间
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
                <strong style={{ fontSize: 13 }}>{preview.plan.title || 'AI 铺戏预览'}</strong>
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  {preview.compiled.statements.length} 语义语句 · {preview.compiled.markers.length} 标记
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 8 }}>
                {preview.plan.summary}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
                <span>插入: {preview.anchorTime.toFixed(1)}s</span>
                {preview.compiled.timeRange && <span>长度: {preview.compiled.timeRange.end.toFixed(1)}s</span>}
                {selectedIds.length > 0 && <span>参考选区: {selectedIds.length}</span>}
              </div>
            </div>
          )}

          {(previewErrors.length > 0 || previewWarnings.length > 0) && (
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontWeight: 700, fontSize: 13 }}>
                <IconInfo width={14} height={14} /> 检查结果
              </div>
              {[...previewErrors, ...previewWarnings].map((issue, index) => (
                <div key={`compile-${index}`} style={{ color: issue.severity === 'error' ? '#ff6b6b' : 'var(--warning)', fontSize: 12, lineHeight: 1.5 }}>
                  {issue.stepIndex !== undefined ? `步骤 ${issue.stepIndex + 1}: ` : ''}{issue.message}
                </div>
              ))}
            </div>
          )}

          {preview && preview.compiled.statements.length > 0 && (
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
              {preview.compiled.statements.slice(0, 18).map((statement, index) => (
                <div
                  key={`${statement.type}-${index}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '54px 120px 1fr',
                    gap: 8,
                    padding: '7px 10px',
                    borderBottom: index === Math.min(preview.compiled.statements.length, 18) - 1 ? 'none' : '1px solid var(--border-subtle)',
                    fontSize: 12,
                    alignItems: 'center',
                  }}
                >
                  <span style={{ color: 'var(--text-muted)' }}>{(preview.anchorTime + (statement.time ?? 0)).toFixed(1)}s</span>
                  <strong>{statement.type}</strong>
                  <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {(() => {
                      const params = statement.params as Record<string, unknown>;
                      return String(params.text || params.id || params.speakerId || params.durationSeconds || '');
                    })()}
                  </span>
                </div>
              ))}
            </div>
          )}

          {receipt && (
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 12, background: 'rgba(80, 200, 120, 0.08)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700 }}>
                <IconCheck width={14} height={14} /> 已应用
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
                {receipt.createdStatementIds.length} 个语义语句，{receipt.createdMarkerIds.length} 个标记 · {receipt.historyDescriptor.fallbackLabel}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AiScriptSegmentPanel;

import React, { useEffect, useRef } from 'react';
import { useDocumentStore, usePlaybackAdapter, useTimelineAdapter } from '../context/AppContext';
import { useValidationIssues } from '../store/storeHooks';
import { scriptEngine } from '../../engine/ScriptEngine';
import { cameraController } from '../../engine/CameraController';
import type { SceneMeta } from '../../api/types/scene-common';
import type { TimelineAction } from './semanticTimelineTypes';
import { resolveVec2 } from '../../engine/utils/math';
import { IconCheck, IconError, IconExternalLink, IconWarning } from '../icons';
import { buildSemanticTimelineReadModel } from './semanticTimelineReadModel';

const ENGINE_SNAPSHOT_SCAN_INTERVAL_MS = 1000 / 15;

// -------------------------------------------------------------
// Tab 1: Engine Snapshot
// -------------------------------------------------------------
export const EngineSnapshotTab: React.FC<{ action?: TimelineAction, sceneMeta: SceneMeta }> = ({ action, sceneMeta }) => {
  const playbackAdapter = usePlaybackAdapter();
  const [snapshot, setSnapshot] = React.useState<{cam?: any, chars?: any[]}>({});
  const lastScanAtRef = useRef(Number.NEGATIVE_INFINITY);
  const snapshotRef = useRef<{cam?: any, chars?: any[]}>({});
  const characterMetaById = React.useMemo(() => {
    const map = new Map<string, { name: string; hasModel: boolean }>();
    sceneMeta.characters?.forEach((character: any) => {
      map.set(character.id, {
        name: character.name || character.id,
        hasModel: !!character.model,
      });
    });
    return map;
  }, [sceneMeta]);

  const areSnapshotsEqual = (a: {cam?: any, chars?: any[]}, b: {cam?: any, chars?: any[]}) => {
    if (!a.cam || !b.cam) {
      return !a.cam && !b.cam && (a.chars?.length || 0) === (b.chars?.length || 0);
    }

    if (
      a.cam.x !== b.cam.x ||
      a.cam.y !== b.cam.y ||
      a.cam.zoom !== b.cam.zoom ||
      a.cam.rot !== b.cam.rot
    ) {
      return false;
    }

    const aChars = a.chars || [];
    const bChars = b.chars || [];
    if (aChars.length !== bChars.length) return false;

    for (let i = 0; i < aChars.length; i += 1) {
      const left = aChars[i];
      const right = bChars[i];
      if (
        left.id !== right.id ||
        left.name !== right.name ||
        Math.round((left.proxy.x / 1920) * 100) !== Math.round((right.proxy.x / 1920) * 100) ||
        Math.round((left.proxy.y / 1080) * 100) !== Math.round((right.proxy.y / 1080) * 100) ||
        Number((left.proxy.z ?? 0).toFixed(1)) !== Number((right.proxy.z ?? 0).toFixed(1)) ||
        Number(left.proxy.scale.toFixed(1)) !== Number(right.proxy.scale.toFixed(1)) ||
        Number(left.proxy.opacity.toFixed(1)) !== Number(right.proxy.opacity.toFixed(1))
      ) {
        return false;
      }
    }

    return true;
  };

  useEffect(() => {
    const renderSnapshot = () => {
      const now = performance.now();
      if (now - lastScanAtRef.current < ENGINE_SNAPSHOT_SCAN_INTERVAL_MS) return;
      lastScanAtRef.current = now;

      const cam = cameraController.getState();
      const camPos = resolveVec2(cam.position);

      const chars: any[] = [];
      scriptEngine.transformationProxies.forEach((proxy, id) => {
        const cMeta = characterMetaById.get(id);
        if (!cMeta?.hasModel) return;
        const name = cMeta.name;
        chars.push({ id, name, proxy });
      });

      const nextSnapshot = {
        cam: {
          x: Number(camPos.x.toFixed(2)),
          y: Number(camPos.y.toFixed(2)),
          zoom: Number(cam.zoom.toFixed(2)),
          rot: Number(cam.rotation.toFixed(1)),
        },
        chars,
      };

      if (areSnapshotsEqual(snapshotRef.current, nextSnapshot)) {
        return;
      }

      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
    };

    // Render immediately so it doesn't disappear when paused
    lastScanAtRef.current = Number.NEGATIVE_INFINITY;
    snapshotRef.current = {};
    renderSnapshot();
    
    // Keep the panel responsive without repainting the whole tab at frame rate.
    const unsub = playbackAdapter.subscribeTime(renderSnapshot);
    return unsub;
  }, [action, characterMetaById, playbackAdapter]);

  return (
    <div style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 'bold', color: 'var(--text-muted)' }}>
          相机 (CAMERA)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ background: 'var(--bg-surface)', padding: '16px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 0, textTransform: 'uppercase' }}>X坐标</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', marginTop: 4 }}>{snapshot.cam?.x?.toFixed(2)}</div>
          </div>
          <div style={{ background: 'var(--bg-surface)', padding: '16px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 0, textTransform: 'uppercase' }}>Y坐标</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', marginTop: 4 }}>{snapshot.cam?.y?.toFixed(2)}</div>
          </div>
          <div style={{ background: 'var(--bg-surface)', padding: '16px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 0, textTransform: 'uppercase' }}>缩放</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', marginTop: 4 }}>{snapshot.cam?.zoom?.toFixed(2)}x</div>
          </div>
          <div style={{ background: 'var(--bg-surface)', padding: '16px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 0, textTransform: 'uppercase' }}>旋转</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', marginTop: 4 }}>{snapshot.cam?.rot?.toFixed(1)}°</div>
          </div>
        </div>
      </div>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 'bold', color: 'var(--text-muted)' }}>
          角色状态 (CHARACTERS)
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {snapshot.chars?.map(c => (
            <div key={c.id} style={{ background: 'var(--bg-surface)', padding: 16, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{c.name}</span>
                <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', background: 'var(--bg-primary)', padding: '4px 8px', borderRadius: 'var(--radius-sm)' }}>
                  {((c.proxy.x/1920)*100).toFixed(0)}% , {((c.proxy.y/1080)*100).toFixed(0)}% <span style={{ opacity: 0.5 }}>z:{c.proxy.z?.toFixed(1) || '0'}</span>
                </span>
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{ fontSize: 11, width: 44, color: 'var(--text-muted)', fontWeight: 600 }}>缩放</div>
                <div style={{ flex: 1, height: 4, background: 'var(--border-default)', borderRadius: 'var(--radius-xs)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, (c.proxy.scale / 2) * 100)}%`, background: 'var(--accent-primary)', borderRadius: 'var(--radius-xs)' }} />
                </div>
                <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', width: 28, textAlign: 'right' }}>{c.proxy.scale.toFixed(1)}</div>
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{ fontSize: 11, width: 44, color: 'var(--text-muted)', fontWeight: 600 }}>透明度</div>
                <div style={{ flex: 1, height: 4, background: 'var(--border-default)', borderRadius: 'var(--radius-xs)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, c.proxy.opacity * 100)}%`, background: 'var(--accent-secondary)', borderRadius: 'var(--radius-xs)' }} />
                </div>
                <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', width: 28, textAlign: 'right' }}>{c.proxy.opacity.toFixed(1)}</div>
              </div>
            </div>
          ))}
          {(!snapshot.chars || snapshot.chars.length === 0) && (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)' }}>
              场景中没有角色
            </div>
          )}
        </div>
      </div>
      
      {action?.params?.ease && (
        <div style={{ padding: 12, background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: 12, fontWeight: 'bold', marginBottom: 8, color: 'var(--text-muted)' }}>
            缓动曲线 (EASING GRAPH): {action.params.ease}
          </div>
          <svg width="100%" height="80" viewBox="0 -10 100 120" preserveAspectRatio="none" style={{ overflow: 'visible', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
            <line x1="0" y1="100" x2="100" y2="100" stroke="var(--border-subtle)" strokeWidth="1" />
            <line x1="0" y1="0" x2="100" y2="0" stroke="var(--border-subtle)" strokeWidth="1" strokeDasharray="4 4" />
            <path 
              d={getEaseSvgPath(action.params.ease)} 
              fill="none" 
              stroke="var(--accent-primary)" 
              strokeWidth="2" 
              strokeLinecap="round" 
              strokeLinejoin="round" 
            />
          </svg>
        </div>
      )}
    </div>
  );
};

function getEaseSvgPath(ease: string) {
  // Approximate SVG paths for GSAP default eases (x: 0->100, y: 100->0)
  const map: Record<string, string> = {
    'none': 'M0,100 L100,0',
    'linear': 'M0,100 L100,0',
    'power1.in': 'M0,100 Q 50,100 100,0',
    'power1.out': 'M0,100 Q 50,0 100,0',
    'power1.inOut': 'M0,100 C 50,100 50,0 100,0',
    'power2.in': 'M0,100 Q 70,100 100,0',
    'power2.out': 'M0,100 Q 30,0 100,0',
    'power2.inOut': 'M0,100 C 70,100 30,0 100,0',
    'power3.inOut': 'M0,100 C 80,100 20,0 100,0',
    'back.out': 'M0,100 C 30,-20 70,-20 100,0',
    'back.inOut': 'M0,100 C 50,130 50,-30 100,0',
    'elastic.out': 'M0,100 C 20,0 40,-40 50,0 C 60,20 70,-10 80,0 C 90,5 95,-5 100,0',
  };
  // Fallback to power1.inOut
  const base = ease.replace(/\([^)]*\)/, '').trim(); 
  return map[base] || map['power1.inOut'];
}

// -------------------------------------------------------------
// Tab 3: Diagnostics
// -------------------------------------------------------------
export const DiagnosticsTab: React.FC<{ globalIssues?: any[] }> = () => {
  const { issues, loading } = useValidationIssues();
  const documentStore = useDocumentStore();
  const timelineAdapter = useTimelineAdapter();
  const playbackAdapter = usePlaybackAdapter();
  const [filter, setFilter] = React.useState<'all' | 'error' | 'warning'>('all');
  const semanticTimelineItems = React.useMemo(
    () => buildSemanticTimelineReadModel(
      documentStore.getCurrentSceneDocumentSnapshot(),
      documentStore.getCompiledSceneSnapshot(),
    ),
    [documentStore],
  );

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  const filteredIssues = React.useMemo(() => {
    if (filter === 'error') return errors;
    if (filter === 'warning') return warnings;
    return issues;
  }, [issues, filter, errors, warnings]);

  const handleIssueClick = (actionId?: string) => {
    if (actionId) {
      const semanticItem = semanticTimelineItems.find((item) => (
        item.id === actionId ||
        item.statementId === actionId ||
        item.companionId === actionId
      ));
      const selectedId = semanticItem?.id ?? actionId;
      timelineAdapter.select({ [selectedId]: true });
      
      // Auto-seek playback/engine time to the beginning of the action
      const actionTime = semanticItem?.time;
      if (actionTime !== undefined) {
        playbackAdapter.seek(actionTime, true);
      }
    }
  };

  return (
    <div style={{ position: 'absolute', inset: 0, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
          剧本问题诊断
        </div>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--accent-primary)' }}>
            <div className="spinner-mini" style={{ width: 10, height: 10, borderTopColor: 'var(--accent-primary)' }} />
            <span>异步文件校验中…</span>
          </div>
        )}
      </div>

      {/* Summary Counter Stats */}
      {issues.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div style={{ padding: '8px 12px', background: 'var(--error-surface)', border: '1px solid color-mix(in srgb, var(--error) 24%, transparent)', borderRadius: 'var(--radius-sm)', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>错误总数</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--error)' }}>{errors.length}</span>
          </div>
          <div style={{ padding: '8px 12px', background: 'var(--warning-surface)', border: '1px solid color-mix(in srgb, var(--warning) 24%, transparent)', borderRadius: 'var(--radius-sm)', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>警告总数</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--warning)' }}>{warnings.length}</span>
          </div>
        </div>
      )}

      {/* Filter Pills */}
      {issues.length > 0 && (
        <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 8 }}>
          <button 
            type="button"
            onClick={() => setFilter('all')}
            style={{
              padding: '4px 10px',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              background: filter === 'all' ? 'var(--accent-primary)' : 'var(--bg-elevated)',
              color: filter === 'all' ? 'var(--bg-primary)' : 'var(--text-primary)',
              transition: 'background-color 0.15s ease, color 0.15s ease'
            }}
          >
            全部 ({issues.length})
          </button>
          <button 
            type="button"
            onClick={() => setFilter('error')}
            style={{
              padding: '4px 10px',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              background: filter === 'error' ? 'var(--error)' : 'var(--bg-elevated)',
              color: filter === 'error' ? '#ffffff' : 'var(--text-primary)',
              transition: 'background-color 0.15s ease, color 0.15s ease'
            }}
          >
            <IconError width={11} height={11} /> 错误 ({errors.length})
          </button>
          <button 
            type="button"
            onClick={() => setFilter('warning')}
            style={{
              padding: '4px 10px',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              background: filter === 'warning' ? 'var(--warning)' : 'var(--bg-elevated)',
              color: filter === 'warning' ? '#ffffff' : 'var(--text-primary)',
              transition: 'background-color 0.15s ease, color 0.15s ease'
            }}
          >
            <IconWarning width={11} height={11} /> 警告 ({warnings.length})
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
        {filteredIssues.length === 0 ? (
          <div style={{ 
            padding: 20, 
            background: 'rgba(16, 185, 129, 0.08)', 
            border: '1px solid rgba(16, 185, 129, 0.2)', 
            color: '#34d399', 
            borderRadius: 'var(--radius-md)', 
            fontSize: 12,
            textAlign: 'center',
            fontWeight: 500,
            lineHeight: 1.5
          }}>
            <IconCheck width={14} height={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            {issues.length === 0 ? '剧本业务逻辑验证通过，未发现任何问题。' : '该类别下无更多诊断项。'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filteredIssues.map((msg, i) => {
              const isErr = msg.severity === 'error';
              const IssueElement = msg.actionId ? 'button' : 'div';
              return (
                <IssueElement
                  key={`issue-${i}`}
                  type={msg.actionId ? 'button' : undefined}
                  onClick={msg.actionId ? () => handleIssueClick(msg.actionId) : undefined}
                  aria-label={msg.actionId ? `${isErr ? '错误' : '警告'}：${msg.message}，定位动作` : undefined}
                  style={{ 
                    position: 'relative',
                    width: '100%',
                    padding: '10px 12px', 
                    paddingLeft: 18,
                    background: 'var(--bg-tertiary)', 
                    border: '1px solid var(--border-subtle)', 
                    borderRadius: 'var(--radius-md)', 
                    fontSize: 12,
                    color: 'inherit',
                    textAlign: 'left',
                    cursor: msg.actionId ? 'pointer' : 'default',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    transition: 'background-color 0.2s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                  }}
                  className={msg.actionId ? 'issue-item--clickable' : ''}
                >
                  {/* Color Status Strip */}
                  <div style={{ 
                    position: 'absolute', 
                    left: 0, 
                    top: 0, 
                    bottom: 0, 
                    width: 4, 
                    borderTopLeftRadius: 8, 
                    borderBottomLeftRadius: 8, 
                    background: isErr ? '#ef4444' : '#f59e0b' 
                  }} />

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontWeight: 700, color: isErr ? 'var(--error)' : 'var(--warning)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {isErr ? <IconError width={12} height={12} /> : <IconWarning width={12} height={12} />}
                        {isErr ? '错误' : '警告'}
                      </span>
                      {msg.actionType && (
                        <span style={{ fontSize: 10, background: 'rgba(255, 255, 255, 0.08)', padding: '1px 6px', borderRadius: 'var(--radius-sm)', color: 'var(--text-muted)' }}>
                          {msg.actionType}
                        </span>
                      )}
                    </div>
                    {msg.actionId && (
                      <span className="issue-locate-btn" style={{ fontSize: 10, color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: 4, opacity: 0.8 }}>
                        <span>点击定位</span>
                        <IconExternalLink width={12} height={12} />
                      </span>
                    )}
                  </div>
                  <div style={{ 
                    lineHeight: 1.4, 
                    color: 'var(--text-primary)',
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word',
                    whiteSpace: 'pre-wrap'
                  }}>{msg.message}</div>
                </IssueElement>
              );
            })}
          </div>
        )}
      </div>

      <style>{`
        .issue-item--clickable:hover {
          background: var(--bg-secondary) !important;
          border-color: var(--accent-primary) !important;
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }
        .issue-item--clickable:hover .issue-locate-btn {
          opacity: 1 !important;
          text-decoration: underline;
        }
      `}</style>
    </div>
  );
};

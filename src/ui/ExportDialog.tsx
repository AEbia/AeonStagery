/**
 * AeonStagery — Export Dialog
 *
 * Video export UI. Config form + progress display.
 * All capture/encode/mux logic lives in ExportAdapter.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import {
  usePlaybackAdapter,
  useExportAdapter,
} from './context/AppContext';
import { IconFilm, IconCheck, IconX } from './icons';
import { FormSelect } from './FormSelect';
import { InfoTip } from './Tooltip';
import type { ExportProgress } from '../api/types/export';
import { useModalDialog } from './hooks/useModalDialog';

interface Props {
  onClose: () => void;
}

type UIState = 'idle' | 'recording' | 'converting' | 'done' | 'cancelled' | 'error';

export default function ExportDialog({ onClose }: Props) {
  const dialogRef = useModalDialog(onClose);
  const [uiState, setUiState] = useState<UIState>('idle');
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('准备导出');
  const [outputPath, setOutputPath] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const exportControllerRef = useRef<AbortController | null>(null);
  const handleCancelExport = () => {
    const controller = exportControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    setCancelling(true);
    setStatusText('正在取消导出...');
    controller.abort();
  };

  const playbackAdapter = usePlaybackAdapter();
  const exportAdapter = useExportAdapter();

  // Export config state
  const [format, setFormat] = useState<'mp4' | 'webm' | 'mov'>('mp4');
  const [codec, setCodec] = useState('libx264');
  const [bitrate, setBitrate] = useState<number>(12);
  const fullDuration = playbackAdapter.getDuration();
  const [exportStart, setExportStart] = useState(0);
  const [exportEnd, setExportEnd] = useState(fullDuration);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [subtitleExportMode, setSubtitleExportMode] = useState<'full' | 'scene' | 'subtitle-only' | 'subtitle-chroma'>('full');
  const [exportMode, setExportMode] = useState<'webcodecs' | 'rawpixels'>('webcodecs');

  const hasWebCodecsSupport =
    typeof window.VideoEncoder !== 'undefined' &&
    typeof (window as any).VideoFrame !== 'undefined';
  const isElectron = typeof window.aeonStageryAPI !== 'undefined';
  const isSubtitleIsolated =
    subtitleExportMode === 'subtitle-only' || subtitleExportMode === 'subtitle-chroma';

  // FFmpeg log callback for progress parsing during mix phase
  const totalFramesRef = useRef(0);
  const uiStateRef = useRef<UIState>('idle');
  useEffect(() => { uiStateRef.current = uiState; }, [uiState]);

  const ffmpegLogCallback = useCallback((msg: string) => {
    console.log(`[FFmpeg Main] ${msg}`);
    if (!exportControllerRef.current?.signal.aborted && uiStateRef.current === 'converting' && totalFramesRef.current > 0) {
      const match = msg.match(/frame=\s*(\d+)/);
      if (match) {
        const currentFrame = parseInt(match[1]);
        const pct = Math.min(99, Math.round((currentFrame / totalFramesRef.current) * 100));
        setProgress(pct);
      }
    }
  }, []);

  const handleExport = useCallback(async () => {
    try {
      const saveResult = await window.aeonStageryAPI.dialog.showSave({
        title: '导出视频',
        defaultPath: `AeonStagery_Export_${Date.now()}.${format}`,
        filters: [
          {
            name: format === 'mp4' ? 'MP4 Video' : format === 'mov' ? 'MOV Video' : 'WebM Video',
            extensions: [format],
          },
        ],
      });

      if (saveResult.canceled || !saveResult.filePath) return;

      const controller = new AbortController();
      exportControllerRef.current = controller;
      setCancelling(false);
      setOutputPath(saveResult.filePath);
      setProgress(0);
      setUiState('recording');
      setStatusText('正在初始化导出...');

      const rangeStart = exportStart > 0 || exportEnd < fullDuration ? exportStart : 0;
      const rangeEnd = exportStart > 0 || exportEnd < fullDuration ? exportEnd : fullDuration;
      totalFramesRef.current = Math.ceil((rangeEnd - rangeStart) * 60);

      const result = await exportAdapter.export(
        {
          format,
          codec,
          bitrateMbps: bitrate,
          fps: 60,
          width: 1920,
          height: 1080,
          rangeStart,
          rangeEnd,
          includeAudio,
          includeSubtitles: subtitleExportMode !== 'scene',
          subtitleOnly: subtitleExportMode === 'subtitle-only',
          subtitleChroma: subtitleExportMode === 'subtitle-chroma',
          backend: exportMode,
          outputPath: saveResult.filePath,
          ffmpegLogCallback,
        },
        (p: ExportProgress) => {
          if (controller.signal.aborted) return;
          if (p.phase === 'capture') {
            setUiState('recording');
            setProgress(p.percent);
            setStatusText(
              `正在导出: ${p.percent.toFixed(1)}% (${p.frame}/${p.totalFrames} 帧)`,
            );
          } else if (p.phase === 'mix') {
            setUiState('converting');
            setProgress(p.percent);
            const srcNote = p.audioSourceCount
              ? ` (${p.audioSourceCount} 个音频轨道)`
              : '';
            setStatusText(`正在进行音视频混合...${srcNote}`);
          } else if (p.phase === 'done') {
            setProgress(100);
          }
        },
        controller.signal,
      );

      if (result.cancelled) {
        setUiState('cancelled');
        setStatusText('导出已取消');
        return;
      }
      if (!result.success) {
        setUiState('error');
        setErrorMsg(result.error || '导出失败');
        setStatusText('导出失败');
        return;
      }

      setUiState('done');
      setStatusText(`已导出至 ${saveResult.filePath}`);
      setProgress(100);
    } catch (err: any) {
      setUiState('error');
      setErrorMsg(err.message);
      setStatusText('导出失败');
    } finally {
      exportControllerRef.current = null;
      setCancelling(false);
    }
  }, [
    format, codec, bitrate, exportStart, exportEnd, includeAudio,
    subtitleExportMode, exportMode, fullDuration, exportAdapter, ffmpegLogCallback,
  ]);

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="export-dialog-title" tabIndex={-1}>
        <div id="export-dialog-title" className="modal__header">
          <IconFilm width={20} height={20} style={{ color: 'var(--accent-primary)' }} /> 导出视频
        </div>

        {uiState === 'idle' && (
          <div className="form-grid">
            <div className="form-group">
              <div id="export-resolution-label" className="form-label">
                分辨率 & 帧率
                <InfoTip
                  title="分辨率与帧率"
                  content="标准 1080P (1920×1080) 60 帧每秒渲染，保证 Live2D 物理摆动、粒子与视线动作的极致平滑度。"
                />
              </div>
              <div aria-labelledby="export-resolution-label" style={{ padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', fontSize: '13px', color: 'var(--text-secondary)' }}>
                1920 × 1080 @ 60fps
              </div>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="export-format">
                格式
                <InfoTip
                  title="视频容器格式"
                  content="MP4 格式在大多数播放器、剪辑软件与移动端中具有最佳兼容性；WebM 格式具有更高压缩率且支持透明通道（Alpha）。"
                />
              </label>
              {!isSubtitleIsolated && (
              <>
                <FormSelect
                  id="export-format"
                  value={format}
                  options={[
                    { value: 'mp4', label: 'MP4 (.mp4)' },
                    { value: 'webm', label: 'WebM (.webm)' },
                  ]}
                  onChange={(value) => {
                    const val = value as 'mp4' | 'webm';
                    setFormat(val);
                    setCodec(val === 'webm' ? 'vp9' : 'libx264');
                  }}
                />
              </>
            )}
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="export-codec">
                编码器 / 编码
                <InfoTip
                  title="视频编码标准"
                  content="H.264 (x264) 兼顾兼容性与画质；H.265 (HEVC) 在同等画质下体积更小（支持 Nvidia NVENC 硬件加速）；AV1 为下一代极高压缩比开源编码。"
                />
              </label>
              {!isSubtitleIsolated && (
              <FormSelect
                id="export-codec"
                value={codec}
                options={
                  format === 'webm' ? [
                    { value: 'vp9', label: 'VP9 (高质量)' },
                    { value: 'libaom-av1', label: 'AV1 (下一代 / CPU 软解极慢)' },
                    { value: 'av1_nvenc', label: 'AV1 (下一代 / Nvidia 40系及以上显卡)' },
                    { value: 'av1_amf', label: 'AV1 (下一代 / AMD 7000系及以上显卡)' },
                  ] : [
                    { value: 'libx264', label: 'H.264 (标准 / 兼容性最好)' },
                    { value: 'libx265', label: 'H.265 (HEVC / CPU 软解较慢)' },
                    { value: 'hevc_nvenc', label: 'H.265 (HEVC / Nvidia 显卡极速)' },
                    { value: 'hevc_mf', label: 'H.265 (HEVC / Windows 显卡通用加速)' },
                    { value: 'libaom-av1', label: 'AV1 (下一代 / CPU 软解极慢)' },
                    { value: 'av1_nvenc', label: 'AV1 (下一代 / Nvidia 40系及以上显卡)' },
                    { value: 'av1_amf', label: 'AV1 (下一代 / AMD 7000系及以上显卡)' },
                  ]
                }
                onChange={setCodec}
              />
            )}
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="export-bitrate">
                视频码率 (Mbps)
                <InfoTip
                  title="视频码率 (Bitrate)"
                  content="控制视频每秒数据流大小。1080P 60fps 推荐设为 12~24 Mbps。码率越高画质越清晰细腻，导出的视频体积也成比例增大。"
                />
              </label>
              <input
                id="export-bitrate"
                type="number"
                className="form-input"
                min={1} max={100}
                value={bitrate}
                onChange={(e) => setBitrate(Math.max(1, Math.min(100, Number(e.target.value))))}
              />
            </div>
            <div className="form-group">
              <div id="export-duration-label" className="form-label">
                剧本时长
                <InfoTip
                  title="剧本总时长"
                  content="当前工程时间轴包含的所有动作关键帧与对白语音的最大结束时间戳。"
                />
              </div>
              <div aria-labelledby="export-duration-label" style={{ padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', fontSize: '13px', color: 'var(--text-secondary)' }}>
                <span className="tabular-nums">{playbackAdapter.getDuration().toFixed(1)}</span> 秒
              </div>
            </div>

            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label" htmlFor="export-mode">
                导出引擎 / 兼容性模式
                <InfoTip
                  title="导出渲染引擎"
                  content="WebCodecs 模式使用 Chromium 底层硬件编码接口，速度极快且零拷贝；RawPixels 模式逐帧抓取显存像素并通过 FFmpeg 软解封装，用于兼容硬件限制环境。"
                />
              </label>
              {!isSubtitleIsolated && (
              <FormSelect
                id="export-mode"
                value={exportMode}
                options={[
                  { value: 'webcodecs', label: `WebCodecs ${hasWebCodecsSupport ? '(推荐：高帧率、硬件加速、零拷贝)' : '(不可用：当前系统/浏览器不支持)'}` },
                  { value: 'rawpixels', label: `RawPixels ${isElectron ? '(兼容：提取像素，适用于不支持 WebCodecs 的环境)' : '(不可用：当前非 Electron 环境)'}` },
                ]}
                onChange={(value) => setExportMode(value as 'webcodecs' | 'rawpixels')}
              />
            )}
            </div>

            <div className="form-grid form-grid--2col" style={{ gridColumn: '1 / -1' }}>
              <div className="form-group">
                <label className="form-label" htmlFor="export-start">
                  开始时间 (秒)
                  <InfoTip title="导出起始点" content="指定导出的起始时间戳，留 0 则从剧本最开始渲染。" />
                </label>
                <input
                  id="export-start"
                  type="number" className="form-input" min="0" step="0.1"
                  value={exportStart}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value) || 0;
                    setExportStart(Math.max(0, Math.min(val, exportEnd - 0.1)));
                  }}
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="export-end">
                  结束时间 (秒)
                  <InfoTip title="导出截断点" content="指定导出的结束时间戳，默认导出至剧本结尾。" />
                </label>
                <input
                  id="export-end"
                  type="number" className="form-input" min="0" step="0.1"
                  value={exportEnd}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value) || fullDuration;
                    setExportEnd(Math.max(exportStart + 0.1, Math.min(val, fullDuration)));
                  }}
                />
              </div>
            </div>

            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={includeAudio}
                  onChange={(e) => setIncludeAudio(e.target.checked)}
                  style={{ width: '16px', height: '16px', accentColor: 'var(--accent-primary)' }}
                />
                包含音频 (BGM + 语音)
                <InfoTip
                  title="多轨混音导出"
                  content="勾选后将自动混合时间轴上的背景音乐轨道、音效轨道与角色语音轨道并封装入视频。"
                />
              </label>
            </div>

            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label" htmlFor="export-subtitles">
                字幕层导出
                <InfoTip
                  title="字幕层导出"
                  content="「画面+字幕」按完整画面导出；「仅画面」导出不含任何字幕的纯净画面；「仅字幕层(透明)」以 Apple ProRes 4444 保留纯透明背景；「仅字幕层(绿幕)」则渲染在纯绿背景上，用剪辑软件的色度键即可一键抠出字幕。"
                />
              </label>
              <FormSelect
                id="export-subtitles"
                value={subtitleExportMode}
                options={[
                  { value: 'full', label: '画面 + 字幕 (默认)' },
                  { value: 'scene', label: '仅画面 (不含字幕)' },
                  { value: 'subtitle-only', label: '仅字幕层 (透明背景)' },
                  { value: 'subtitle-chroma', label: '仅字幕层 (绿幕背景)' },
                ]}
                onChange={(value) => {
                  const mode = value as 'full' | 'scene' | 'subtitle-only' | 'subtitle-chroma';
                  setSubtitleExportMode(mode);
                  if (mode === 'subtitle-only') {
                    setFormat('mov');
                    setCodec('prores_ks');
                    setExportMode('rawpixels');
                  } else if (mode === 'subtitle-chroma') {
                    setFormat('mp4');
                    setCodec('libx264');
                    setExportMode('rawpixels');
                  }
                }}
              />

              {subtitleExportMode === 'subtitle-only' && (
                <div
                  aria-live="polite"
                  style={{
                    marginTop: '8px',
                    padding: '8px 12px',
                    background: 'var(--bg-tertiary)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '12px',
                    color: 'var(--text-secondary)',
                  }}
                >
                  仅字幕层将以 <strong>MOV + Apple ProRes 4444</strong>（10-bit 4:4:4 + Alpha）导出，背景纯透明，可直接在 PR / AE / FCP 中叠加合成；其余格式与编码选项已自动适配。
                </div>
              )}

              {subtitleExportMode === 'subtitle-chroma' && (
                <div
                  aria-live="polite"
                  style={{
                    marginTop: '8px',
                    padding: '8px 12px',
                    background: 'var(--bg-tertiary)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '12px',
                    color: 'var(--text-secondary)',
                  }}
                >
                  仅字幕层将以 <strong>MP4 + H.264</strong> 导出，字幕渲染在纯绿幕 (RGB 0,255,0) 上，可用剪辑软件的色度键 / 绿幕抠像直接提取；其余格式与编码选项已自动适配。
                </div>
              )}
            </div>
          </div>
        )}

        {(uiState === 'recording' || uiState === 'converting') && (
          <div style={{ marginTop: '16px' }}>
            <div role="progressbar" aria-label="导出进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} style={{
              height: '6px', background: 'var(--bg-elevated)',
              borderRadius: 'var(--radius-xs)', overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                background: 'linear-gradient(90deg, var(--accent-primary), var(--accent-secondary))',
                width: `${progress}%`,
                transition: 'width 0.3s ease',
                boxShadow: 'var(--shadow-glow)',
              }} />
            </div>
            <div role="status" aria-live="polite" style={{ marginTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontSize: '13px', color: 'var(--text-primary)' }}>
              {uiState === 'recording' && <span className="recording-dot" />}
              <span className="tabular-nums">{statusText} — {progress.toFixed(0)}%</span>
            </div>
          </div>
        )}

        {uiState === 'done' && (
          <div className="empty-state" role="status" aria-live="polite" style={{ padding: '24px 0' }}>
            <div style={{ marginBottom: '12px', color: 'var(--success)' }}>
              <IconCheck width={48} height={48} />
            </div>
            <div style={{ color: 'var(--success)', fontWeight: 600, fontSize: '16px' }}>导出完成！</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', wordBreak: 'break-all' }}>{outputPath}</div>
          </div>
        )}

        {uiState === 'error' && (
          <div className="empty-state" role="alert" style={{ padding: '24px 0' }}>
            <div style={{ marginBottom: '12px', color: 'var(--error)' }}>
              <IconX width={48} height={48} />
            </div>
            <div style={{ color: 'var(--error)', fontWeight: 600, fontSize: '16px' }}>导出失败</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{errorMsg}</div>
          </div>
        )}

        {uiState === 'cancelled' && (
          <div className="empty-state" role="status" aria-live="polite" style={{ padding: '24px 0' }}>
            <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '16px' }}>导出已取消</div>
          </div>
        )}

        <div className="modal__footer">
          {(uiState === 'recording' || uiState === 'converting') && (
            <button className="btn" onClick={handleCancelExport} disabled={cancelling}>
              {cancelling ? '正在取消...' : '取消导出'}
            </button>
          )}
          {uiState === 'idle' && (
            <>
              <button className="btn" onClick={onClose}>取消</button>
              <button className="btn btn--primary" onClick={handleExport}>开始导出</button>
            </>
          )}
          {(uiState === 'done' || uiState === 'error' || uiState === 'cancelled') && (
            <button className="btn btn--primary" onClick={onClose}>关闭</button>
          )}
        </div>
      </div>
    </div>
  );
}

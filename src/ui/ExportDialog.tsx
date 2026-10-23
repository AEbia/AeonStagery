/**
 * AeonStagery — Export Dialog
 *
 * Professional studio-grade video export interface.
 * Config cards + real-time cinematic render dashboard + success file manager.
 * All capture/encode/mux logic lives in ExportAdapter.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  usePlaybackAdapter,
  useExportAdapter,
} from './context/AppContext';
import {
  IconFilm,
  IconCheck,
  IconX,
  IconFolder,
  IconMaximize,
  IconSettings,
  IconTimelineCamera,
  IconRefresh,
  IconCopy,
  IconInfo,
} from './icons';
import { FormSelect } from './FormSelect';
import { InfoTip } from './Tooltip';
import type { ExportConfig, ExportProgress, ExportEncodingSettings, ExportEncodingInfo } from '../api/types/export';
import { EXPORT_CONTAINER_CODECS, getDefaultCrf, getSoftwareEncoder } from '../api/exportEncoding';
import type { ExportSizeEstimateConfig } from '../api/exportSizeEstimate';
import { ExportEncodingFields, formatExportEncoding } from './ExportEncodingFields';
import { useModalDialog } from './hooks/useModalDialog';
import { ExportEtaEstimator } from './ExportEtaEstimator';
import { useProjectVideoFormat } from './hooks/useProjectVideoFormat';
import { useExportSizeEstimate } from './hooks/useExportSizeEstimate';
import { VideoFormatFields } from './VideoFormatFields';
import { validateVideoFormat, type OutputFit } from '../api/types/video-format';
import { revealFileInManager } from './fileReveal';
import { getRecommendedBitrate } from './bitrateRecommendation';
import './exportDialog.css';

interface Props {
  onClose: () => void;
}

type UIState = 'idle' | 'recording' | 'converting' | 'done' | 'cancelled' | 'error';

function formatFileSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getAspectRatioLabel(width: number, height: number): string {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return '';
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(Math.round(width), Math.round(height));
  const wRatio = Math.round(width) / divisor;
  const hRatio = Math.round(height) / divisor;
  if ((wRatio === 16 && hRatio === 9) || (width === 1920 && height === 1080) || (width === 1280 && height === 720) || (width === 3840 && height === 2160)) {
    return '16:9 宽屏';
  }
  if ((wRatio === 9 && hRatio === 16) || (width === 1080 && height === 1920)) {
    return '9:16 竖屏';
  }
  if (wRatio === 1 && hRatio === 1) {
    return '1:1 方形';
  }
  if (wRatio === 4 && hRatio === 3) {
    return '4:3 标清';
  }
  return `${wRatio}:${hRatio}`;
}

export default function ExportDialog({ onClose }: Props) {
  const [uiState, setUiState] = useState<UIState>('idle');
  const [preparingExport, setPreparingExport] = useState(false);
  const [progress, setProgress] = useState(0);
  const [estimatedRemainingSeconds, setEstimatedRemainingSeconds] = useState<number | null>(null);
  const [statusText, setStatusText] = useState('准备导出');
  const [outputPath, setOutputPath] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [fileSizeBytes, setFileSizeBytes] = useState<number | null>(null);
  const [copiedError, setCopiedError] = useState(false);

  const exportControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => exportControllerRef.current?.abort(), []);
  const exportStartedAtRef = useRef<number | null>(null);
  const etaProgressRef = useRef(0);
  const etaEstimatorRef = useRef(new ExportEtaEstimator());
  const progressPhaseRef = useRef<'capture' | 'mix' | null>(null);

  const handleCancelExport = () => {
    const controller = exportControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    setCancelling(true);
    setStatusText('正在取消导出...');
    controller.abort();
  };

  const playbackAdapter = usePlaybackAdapter();
  const exportAdapter = useExportAdapter();

  const projectFormat = useProjectVideoFormat();
  const [followProject, setFollowProject] = useState(true);
  const [customFormat, setCustomFormat] = useState(projectFormat);
  const [fit, setFit] = useState<OutputFit>('contain');
  const videoFormat = followProject ? projectFormat : customFormat;
  const formatError = validateVideoFormat(videoFormat);

  // Export config state
  const [format, setFormat] = useState<ExportConfig['format']>('mp4');
  const [codec, setCodec] = useState('libx264');
  const [encoding, setEncoding] = useState<ExportEncodingSettings>({ videoCodec: 'h264', implementation: 'auto', quality: 'balanced' });
  const [actualEncoding, setActualEncoding] = useState<ExportEncodingInfo | null>(null);
  const encodingAttemptRef = useRef(0);

  const handleFormatChange = (nextFormat: ExportConfig['format']) => {
    setFormat(nextFormat);
    if (EXPORT_CONTAINER_CODECS[nextFormat].includes(encoding.videoCodec)) return;
    const videoCodec = EXPORT_CONTAINER_CODECS[nextFormat][0];
    setCodec(getSoftwareEncoder(videoCodec));
    setEncoding(previous => ({
      ...previous, videoCodec, ffmpegEncoder: undefined,
      rateControl: previous.rateControl?.mode === 'crf'
        ? { mode: 'crf', crf: getDefaultCrf(videoCodec, previous.quality) }
        : undefined,
    }));
  };

  const recommendedBitrate = useMemo(() => {
    return getRecommendedBitrate(videoFormat.width, videoFormat.height, videoFormat.fps, codec);
  }, [videoFormat.width, videoFormat.height, videoFormat.fps, codec]);

  const [userOverrodeBitrate, setUserOverrodeBitrate] = useState(false);
  const [bitrate, setBitrate] = useState<number>(() => {
    return getRecommendedBitrate(projectFormat.width, projectFormat.height, projectFormat.fps, 'libx264').standard;
  });
  const [adjustingRateControl, setAdjustingRateControl] = useState(false);

  useEffect(() => {
    if (!adjustingRateControl) return;
    const finishAdjustment = () => setAdjustingRateControl(false);
    // A native slider can be released outside its bounds or interrupted by the OS.
    window.addEventListener('pointerup', finishAdjustment);
    window.addEventListener('pointercancel', finishAdjustment);
    window.addEventListener('blur', finishAdjustment);
    return () => {
      window.removeEventListener('pointerup', finishAdjustment);
      window.removeEventListener('pointercancel', finishAdjustment);
      window.removeEventListener('blur', finishAdjustment);
    };
  }, [adjustingRateControl]);

  useEffect(() => {
    if (!userOverrodeBitrate) {
      setBitrate(encoding.quality === 'high' ? recommendedBitrate.high : recommendedBitrate.standard);
    }
  }, [recommendedBitrate, userOverrodeBitrate, encoding.quality]);

  const fullDuration = playbackAdapter.getDuration();
  const [exportStart, setExportStart] = useState(0);
  const [exportEnd, setExportEnd] = useState(fullDuration);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [subtitleExportMode, setSubtitleExportMode] = useState<'full' | 'scene' | 'subtitle-only' | 'subtitle-chroma'>('full');
  const [exportMode, setExportMode] = useState<'webcodecs' | 'rawpixels'>('webcodecs');
  const isElectron = typeof window.aeonStageryAPI !== 'undefined';

  const isSubtitleIsolated =
    subtitleExportMode === 'subtitle-only' || subtitleExportMode === 'subtitle-chroma';

  const exportConfig = useMemo<ExportSizeEstimateConfig>(() => ({
    format, codec, bitrateMbps: bitrate,
    encoding: {
      ...encoding,
      // Only explicit FFmpeg CRF uses CRF. Native encoding and every fallback
      // share the visible target bitrate; ProRes keeps its fixed alpha pipeline.
      rateControl: encoding.videoCodec === 'prores'
        || (encoding.implementation === 'ffmpeg' && encoding.rateControl?.mode === 'crf')
        ? encoding.rateControl
        : { mode: 'bitrate', bitrateMbps: bitrate },
    }, ...videoFormat, fit,
    rangeStart: exportStart > 0 || exportEnd < fullDuration ? exportStart : 0,
    rangeEnd: exportStart > 0 || exportEnd < fullDuration ? exportEnd : fullDuration,
    includeAudio,
    includeSubtitles: subtitleExportMode !== 'scene',
    subtitleOnly: subtitleExportMode === 'subtitle-only',
    subtitleChroma: subtitleExportMode === 'subtitle-chroma',
    backend: exportMode,
  }), [format, codec, bitrate, encoding, videoFormat, fit, exportStart, exportEnd, fullDuration, includeAudio, subtitleExportMode, exportMode]);
  const { pending: sizeEstimatePending, estimate: sizeEstimate, error: sizeEstimateError, stop: stopSizeEstimate } = useExportSizeEstimate(exportConfig, uiState === 'idle' && !preparingExport, exportAdapter, adjustingRateControl);
  const handleClose = useCallback(() => {
    exportControllerRef.current?.abort();
    void stopSizeEstimate();
    onClose();
  }, [onClose, stopSizeEstimate]);
  const dialogRef = useModalDialog(handleClose);

  // Total frames ref for calculation
  const totalFramesRef = useRef(0);
  const uiStateRef = useRef<UIState>('idle');
  useEffect(() => { uiStateRef.current = uiState; }, [uiState]);

  const updateProgress = useCallback((nextProgress: number, etaProgress = nextProgress) => {
    etaProgressRef.current = etaProgress;
    setProgress(nextProgress);
  }, []);

  useEffect(() => {
    if (uiState !== 'recording' && uiState !== 'converting') return;

    const updateRemainingEstimate = () => {
      const startedAt = exportStartedAtRef.current;
      if (startedAt !== null) {
        const now = Date.now();
        setEstimatedRemainingSeconds(
          etaEstimatorRef.current.update(etaProgressRef.current, now),
        );
      }
    };

    updateRemainingEstimate();
    const intervalId = window.setInterval(updateRemainingEstimate, 1000);
    return () => window.clearInterval(intervalId);
  }, [uiState]);

  const ffmpegLogCallback = useCallback((msg: string) => {
    console.log(`[FFmpeg Main] ${msg}`);
    if (!exportControllerRef.current?.signal.aborted && uiStateRef.current === 'converting' && totalFramesRef.current > 0) {
      const match = msg.match(/frame=\s*(\d+)/);
      if (match) {
        const currentFrame = parseInt(match[1]);
        const frameRatio = Math.max(0, currentFrame / totalFramesRef.current);
        const mixProgress = Math.min(9, Math.round(frameRatio * 10));
        const etaProgress = 90 + Math.min(9.9, frameRatio * 10);
        const pct = 90 + mixProgress;
        updateProgress(pct, etaProgress);
      }
    }
  }, [updateProgress]);

  const handleExport = useCallback(async () => {
    if (formatError || preparingExport) return;
    const controller = new AbortController();
    exportControllerRef.current = controller;
    setPreparingExport(true);
    try {
      await stopSizeEstimate();
      if (controller.signal.aborted) return;
      const saveResult = await window.aeonStageryAPI.dialog.showSave({
        title: '导出视频',
        defaultPath: `AeonStagery_Export_${Date.now()}.${format}`,
        filters: [
          {
            name: `${format === 'webm' ? 'WebM' : format.toUpperCase()} Video`,
            extensions: [format],
          },
        ],
      });

      if (controller.signal.aborted || saveResult.canceled || !saveResult.filePath) return;
      exportStartedAtRef.current = Date.now();
      etaEstimatorRef.current.reset();
      progressPhaseRef.current = 'capture';
      etaProgressRef.current = 0;
      setEstimatedRemainingSeconds(null);
      setCancelling(false);
      setActualEncoding(null);
      encodingAttemptRef.current = 0;
      setFileSizeBytes(null);
      setOutputPath(saveResult.filePath);
      updateProgress(0);
      setUiState('recording');
      setStatusText('正在初始化导出...');

      const { rangeStart, rangeEnd } = exportConfig;
      const calcTotalFrames = Math.ceil(rangeEnd * videoFormat.fps) - Math.floor(rangeStart * videoFormat.fps);
      totalFramesRef.current = calcTotalFrames;

      const result = await exportAdapter.export(
        {
          ...exportConfig,
          outputPath: saveResult.filePath,
          ffmpegLogCallback,
        },
        (p: ExportProgress) => {
          if (controller.signal.aborted) return;
          if (p.encoding) {
            setActualEncoding(p.encoding);
            if (p.encoding.attempt !== encodingAttemptRef.current) {
              encodingAttemptRef.current = p.encoding.attempt;
              etaEstimatorRef.current.reset();
              setEstimatedRemainingSeconds(null);
            }
          }
          if (p.phase === 'capture') {
            if (progressPhaseRef.current !== 'capture') {
              etaEstimatorRef.current.reset();
              progressPhaseRef.current = 'capture';
              setEstimatedRemainingSeconds(null);
            }
            setUiState('recording');

            const captureEtaProgress = p.frame !== undefined
              && p.totalFrames !== undefined
              && p.totalFrames > 0
              ? Math.min(100, Math.max(0, (p.frame / p.totalFrames) * 100))
              : p.percent;
            updateProgress(p.percent, captureEtaProgress);
            setStatusText('正在渲染视频帧');
          } else if (p.phase === 'mix') {
            if (progressPhaseRef.current !== 'mix') {
              etaEstimatorRef.current.reset();
              progressPhaseRef.current = 'mix';
              setEstimatedRemainingSeconds(null);
            }
            setUiState('converting');
            updateProgress(p.percent);
            const srcNote = p.audioSourceCount
              ? ` (${p.audioSourceCount} 个音频轨道)`
              : '';
            setStatusText(`${p.encoding?.implementation === 'webcodecs-transcode' ? '正在编码并合成输出' : '正在合成输出'}...${srcNote}`);
          } else if (p.phase === 'done') {
            updateProgress(100);
            setEstimatedRemainingSeconds(0);
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
      updateProgress(100);

      // Attempt to retrieve exported file size for presentation
      if (window.aeonStageryAPI?.fs?.stat) {
        try {
          const stat = await window.aeonStageryAPI.fs.stat(saveResult.filePath);
          if (stat.success && stat.data?.sizeBytes !== undefined) {
            setFileSizeBytes(stat.data.sizeBytes);
          }
        } catch {
          // Non-critical metadata query failure
        }
      }
    } catch (err: unknown) {
      setUiState('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatusText('导出失败');
    } finally {
      setPreparingExport(false);
      exportControllerRef.current = null;
      exportStartedAtRef.current = null;
      setCancelling(false);
    }
  }, [
    format, videoFormat, formatError, exportConfig, exportAdapter, ffmpegLogCallback, updateProgress, preparingExport, stopSizeEstimate,
  ]);

  const handleRevealInFolder = useCallback(async () => {
    if (!outputPath) return;
    try {
      await revealFileInManager({ path: outputPath });
    } catch (err: any) {
      console.error('Failed to reveal file:', err);
    }
  }, [outputPath]);

  const handleResetToIdle = () => {
    setUiState('idle');
    setProgress(0);
    setEstimatedRemainingSeconds(null);
    setStatusText('准备导出');
    setErrorMsg('');
    setCancelling(false);
    setFileSizeBytes(null);
  };

  const handleCopyError = async () => {
    if (!errorMsg) return;
    try {
      await navigator.clipboard.writeText(errorMsg);
      setCopiedError(true);
      setTimeout(() => setCopiedError(false), 2000);
    } catch {
      // Ignore clipboard write failure
    }
  };

  const aspectRatioBadge = useMemo(() => {
    return getAspectRatioLabel(videoFormat.width, videoFormat.height);
  }, [videoFormat.width, videoFormat.height]);

  const exportDuration = Math.max(0, exportEnd - exportStart);

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && handleClose()}>
      <div
        ref={dialogRef}
        className="modal export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        tabIndex={-1}
      >
        {/* ── Header ───────────────────────────────────────────── */}
        <div className="export-dialog__header">
          <div className="export-dialog__title-group">
            <div className="export-dialog__icon-badge">
              <IconFilm width={18} height={18} />
            </div>
            <div id="export-dialog-title" className="export-dialog__title">导出视频</div>
          </div>
          {(uiState === 'idle' || uiState === 'done' || uiState === 'error' || uiState === 'cancelled') && (
            <button className="export-dialog__close-btn" onClick={handleClose} aria-label="关闭窗口" title="关闭">
              <IconX width={16} height={16} />
            </button>
          )}
        </div>

        {/* ── Body: Idle Config Form ────────────────────────────── */}
        {uiState === 'idle' && (
          <div className="export-dialog__body">
            {/* Card 1: 画面与画质规格 */}
            <div className="export-card">
              <div className="export-card__header">
                <div className="export-card__title-row">
                  <span className="export-card__icon"><IconMaximize width={15} height={15} /></span>
                  <span>画面规格与分辨率</span>
                </div>
                {aspectRatioBadge && (
                  <span className="export-card__badge">{aspectRatioBadge}</span>
                )}
              </div>

              <div className="video-format__export">
                <label className="export-toggle-box" htmlFor="export-follow-project">
                  <div className="export-toggle-box__label">
                    <span className="export-toggle-box__title">跟随项目分辨率与帧率</span>
                    <span className="export-toggle-box__desc">
                      {projectFormat.width} × {projectFormat.height} · {projectFormat.fps} fps · 按工程基准渲染，不受视口缩放影响
                    </span>
                  </div>
                  <input
                    id="export-follow-project"
                    type="checkbox"
                    aria-label="跟随项目分辨率与帧率"
                    checked={followProject}
                    onChange={(event) => {
                      setFollowProject(event.target.checked);
                      if (!event.target.checked) setCustomFormat(projectFormat);
                    }}
                  />
                </label>

                {!followProject && (
                  <div style={{ marginTop: '12px' }}>
                    <VideoFormatFields value={customFormat} onChange={setCustomFormat} idPrefix="export-video" />
                  </div>
                )}

                {!followProject && videoFormat.width * projectFormat.height !== videoFormat.height * projectFormat.width && (
                  <div style={{ marginTop: '10px' }}>
                    <label className="form-label" htmlFor="export-fit">画面比例适配</label>
                    <FormSelect
                      id="export-fit"
                      value={fit}
                      options={[
                        { value: 'contain', label: '完整画面 · 留黑边 (Contain)' },
                        { value: 'cover', label: '填满画面 · 居中裁切 (Cover)' },
                      ]}
                      onChange={(value) => setFit(value === 'cover' ? 'cover' : 'contain')}
                    />
                  </div>
                )}

                {formatError && (
                  <p role="alert" className="video-format__error" style={{ marginTop: '8px' }}>
                    {formatError}
                  </p>
                )}
              </div>
            </div>

            {/* Card 2: 格式与编码配置 */}
            <div className="export-card">
              <div className="export-card__header">
                <div className="export-card__title-row">
                  <span className="export-card__icon"><IconSettings width={15} height={15} /></span>
                  <span>格式与编码器配置</span>
                </div>
              </div>

              {isSubtitleIsolated ? (
                <div className="export-notice" aria-live="polite">
                  {subtitleExportMode === 'subtitle-only' && (
                    <>
                      导出文件具有纯透明背景，可直接拖入 Premiere Pro、After Effects 或 Final Cut Pro 作为透明字幕轨叠加。<strong>文件较大，请预留磁盘空间</strong>

                    </>
                  )}
                  {subtitleExportMode === 'subtitle-chroma' && (
                    <>
                      字幕渲染在纯绿色背景上（RGB 0, 255, 0），可在剪辑软件中使用超级键/色度键一键抠像去除背景。
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label className="form-label" htmlFor="export-format">
                      视频封装格式
                      <InfoTip
                        title="视频容器格式"
                        content="MP4 兼容性广；WebM 支持 VP9 和 AV1；MKV 支持 H.264、HEVC、VP9 和 AV1。"
                      />
                    </label>
                    <div className="export-segmented" role="radiogroup" aria-label="视频封装格式">
                      <button
                        type="button"
                        className={`export-segmented__item ${format === 'mp4' ? 'is-active' : ''}`}
                        onClick={() => handleFormatChange('mp4')}
                      >
                        <span className="export-segmented__name">MP4 (.mp4)</span>
                        <span className="export-segmented__desc">推荐 · 主流格式</span>
                      </button>
                      <button
                        type="button"
                        className={`export-segmented__item ${format === 'webm' ? 'is-active' : ''}`}
                        onClick={() => handleFormatChange('webm')}
                      >
                        <span className="export-segmented__name">WebM (.webm)</span>
                        <span className="export-segmented__desc">VP9 · AV1</span>
                      </button>
                      <button
                        type="button"
                        className={`export-segmented__item ${format === 'mkv' ? 'is-active' : ''}`}
                        onClick={() => handleFormatChange('mkv')}
                      >
                        <span className="export-segmented__name">MKV (.mkv)</span>
                        <span className="export-segmented__desc">多编码支持</span>
                      </button>
                    </div>
                  </div>
                </>
              )}

              {subtitleExportMode !== 'subtitle-only' && (
                <ExportEncodingFields format={format} value={encoding} bitrate={bitrate}
                  onRateControlPointerDown={() => setAdjustingRateControl(true)}
                  subtitleMode={subtitleExportMode === 'subtitle-chroma' ? 'chroma' : undefined}
                  intermediateBitrate={getRecommendedBitrate(videoFormat.width, videoFormat.height, videoFormat.fps, 'libx264').high * 2}
                  onChange={next => {
                    setEncoding(next);
                    setCodec(next.ffmpegEncoder && next.ffmpegEncoder !== 'auto'
                      ? next.ffmpegEncoder : getSoftwareEncoder(next.videoCodec));
                    setUserOverrodeBitrate(next.quality === 'custom');
                    setExportMode(next.implementation === 'ffmpeg' ? 'rawpixels' : 'webcodecs');
                  }}
                  onBitrateChange={next => {
                    setUserOverrodeBitrate(true);
                    setBitrate(next);
                    setEncoding(previous => ({
                      ...previous, quality: 'custom',
                      allowH264Intermediate: previous.allowH264Intermediate ?? previous.quality !== 'high',
                    }));
                  }} />
              )}
            </div>

            {/* Card 3: 导出范围与轨道输出 */}
            <div className="export-card">
              <div className="export-card__header">
                <div className="export-card__title-row">
                  <span className="export-card__icon"><IconTimelineCamera width={15} height={15} /></span>
                  <span>时间范围与轨道输出</span>
                </div>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    setExportStart(0);
                    setExportEnd(fullDuration);
                  }}
                  title="重置为完整剧本时间轴"
                  style={{ fontSize: '11px', padding: '2px 8px' }}
                >
                  <IconRefresh width={12} height={12} /> 全片 ({fullDuration.toFixed(1)}s)
                </button>
              </div>

              <div className="export-grid--2col">
                <div className="form-group">
                  <label className="form-label" htmlFor="export-start">
                    开始时间 (秒)
                    <InfoTip title="起始时间戳" content="指定导出的起始时间点，留 0 则从时间轴最开始导出。" />
                  </label>
                  <input
                    id="export-start"
                    type="number"
                    className="form-input"
                    min="0"
                    step="0.1"
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
                    <InfoTip title="结束时间戳" content="指定导出的截断时间点，默认为剧本最大时长。" />
                  </label>
                  <input
                    id="export-end"
                    type="number"
                    className="form-input"
                    min="0"
                    step="0.1"
                    value={exportEnd}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value) || fullDuration;
                      setExportEnd(Math.max(exportStart + 0.1, Math.min(val, fullDuration)));
                    }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <label className="export-toggle-box">
                  <div className="export-toggle-box__label">
                    <span className="export-toggle-box__title">包含音频轨道 (BGM + 语音 + 音效)</span>
                    <span className="export-toggle-box__desc">自动混音时间轴上的背景音乐、音效与角色台词语音</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={includeAudio}
                    onChange={(e) => setIncludeAudio(e.target.checked)}
                  />
                </label>

                <div className="form-group">
                  <label className="form-label" htmlFor="export-subtitles">
                    字幕层导出模式
                    <InfoTip
                      title="字幕层导出"
                      content="「完整合成」输出音画字幕一体化视频；「纯净画面」输出不含任何字幕的画面母版；「独立字幕轨(透明)」以 ProRes 4444 携带 Alpha 通道；「独立字幕轨(绿幕)」以 MP4 绿幕便于非编软件色度键抠像。"
                    />
                  </label>
                  <FormSelect
                    id="export-subtitles"
                    value={subtitleExportMode}
                    options={[
                      { value: 'full', label: '完整合成 · 画面与字幕 (默认)' },
                      { value: 'scene', label: '仅画面 (无字幕)' },
                      { value: 'subtitle-only', label: '独立字幕轨 · MOV Apple ProRes 4444 (含Alpha 透明通道)' },
                      { value: 'subtitle-chroma', label: '独立字幕轨 · MP4 H.264 (绿幕背景)' },
                    ]}
                    onChange={(value) => {
                      const mode = value as 'full' | 'scene' | 'subtitle-only' | 'subtitle-chroma';
                      setSubtitleExportMode(mode);
                      if (mode === 'subtitle-only') {
                        setFormat('mov');
                        setCodec('prores_ks');
                        setEncoding({ videoCodec: 'prores', implementation: 'ffmpeg', quality: 'balanced', allowH264Intermediate: false });
                        setExportMode('rawpixels');
                      } else if (mode === 'subtitle-chroma') {
                        setFormat('mp4');
                        setCodec('libx264');
                        setEncoding({ videoCodec: 'h264', implementation: 'ffmpeg', quality: 'balanced', allowH264Intermediate: false });
                        setExportMode('rawpixels');
                      } else if (isSubtitleIsolated) {
                        setFormat('mp4');
                        setCodec('libx264');
                        setEncoding({ videoCodec: 'h264', implementation: 'auto', quality: 'balanced' });
                        setExportMode('webcodecs');
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Body: Exporting Dashboard ─────────────────────────── */}
        {(uiState === 'recording' || uiState === 'converting') && (
          <div className="export-dialog__body export-dashboard">
            {actualEncoding && <p className="export-encoding-status" title={actualEncoding.fallbackReason}>{formatExportEncoding(actualEncoding, { includeFallbackStatus: false })}</p>}
            <div className="export-dashboard__status-pill">
              <span className="export-pulse-dot" />
              <span>{uiState === 'recording' ? '阶段 1/2' : '阶段 2/2'}</span>
            </div>

            <div className="export-dashboard__percent tabular-nums">
              {progress.toFixed(1)}%
            </div>

            <div
              className="export-progress-track"
              role="progressbar"
              aria-label="导出进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
            >
              <div
                className="export-progress-bar"
                style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
              />
            </div>

            <div
              className="export-dashboard__desc tabular-nums"
              role="status"
              aria-live="polite"
            >
              {cancelling ? '正在取消导出...' : statusText}
            </div>

            <div className="export-metrics-grid">
              <div className="export-metric-card">
                <span className="export-metric-card__label">预计剩余时间</span>
                <span className="export-metric-card__value">
                  {cancelling ? '—' : (estimatedRemainingSeconds !== null && Number.isFinite(estimatedRemainingSeconds) ? `${Math.ceil(estimatedRemainingSeconds)} 秒` : '估算中...')}
                </span>
              </div>
              <div className="export-metric-card">
                <span className="export-metric-card__label">画面规格</span>
                <span className="export-metric-card__value">
                  {videoFormat.width}×{videoFormat.height} @ {videoFormat.fps}fps
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ── Body: Done Success Screen ─────────────────────────── */}
        {uiState === 'done' && (
          <div className="export-dialog__body export-result-view">
            <div className="export-status-emblem export-status-emblem--success">
              <IconCheck width={36} height={36} />
            </div>

            <h3 role="status" aria-live="polite" className="export-result-view__title">导出完成！</h3>

            <div className="export-result-file-card">
              <div className="export-result-file-card__header">
                <span>导出文件保存路径</span>
                {fileSizeBytes !== null && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                    {formatFileSize(fileSizeBytes)}
                  </span>
                )}
              </div>
              <div className="export-result-file-card__path">{outputPath}</div>
              {actualEncoding && <p className="export-encoding-status" title={actualEncoding.fallbackReason}>{formatExportEncoding(actualEncoding, { includeFallbackStatus: false })}</p>}
              <div style={{ display: 'flex', gap: '8px', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                <span>规格: {videoFormat.width}×{videoFormat.height} · {videoFormat.fps}fps</span>
                <span>·</span>
                <span>容器: {format.toUpperCase()}</span>
                <span>·</span>
                <span>时长: {exportDuration.toFixed(1)} 秒</span>
              </div>
            </div>
          </div>
        )}

        {/* ── Body: Error Screen ───────────────────────────────── */}
        {uiState === 'error' && (
          <div className="export-dialog__body export-result-view" role="alert">
            <div className="export-status-emblem export-status-emblem--error">
              <IconX width={36} height={36} />
            </div>

            <h3 className="export-result-view__title">导出中断或失败</h3>
            <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--text-secondary)' }}>
              视频导出过程中遇到错误，请检查磁盘空间或切换兼容模式重试。
            </p>

            <div className="export-error-box">{errorMsg || '未知错误发生'}</div>

            <button
              type="button"
              className="btn btn--sm"
              onClick={handleCopyError}
              style={{ alignSelf: 'center' }}
            >
              <IconCopy width={12} height={12} /> {copiedError ? '已复制到剪贴板' : '复制错误诊断信息'}
            </button>
          </div>
        )}

        {/* ── Body: Cancelled Screen ───────────────────────────── */}
        {uiState === 'cancelled' && (
          <div className="export-dialog__body export-result-view">
            <div className="export-status-emblem export-status-emblem--cancelled">
              <IconInfo width={32} height={32} />
            </div>
            <h3 role="status" aria-live="polite" className="export-result-view__title">导出已取消</h3>
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
              导出流程已被手动中止，未生成完整视频文件。
            </p>
          </div>
        )}

        {/* ── Footer ───────────────────────────────────────────── */}
        <div className="export-dialog__footer modal__footer" style={{ margin: 0 }}>
          {uiState === 'idle' && (
            <>
              <div className="export-summary-chip">
                <span>{videoFormat.width} × {videoFormat.height}</span>
                <span>·</span>
                <span>{videoFormat.fps} fps</span>
                <span>·</span>
                <span className="export-summary-chip__size" role="status" aria-live="polite" aria-atomic="true">
                  {sizeEstimatePending ? '正在预估' : sizeEstimate ? `预估大小：约 ${formatFileSize(sizeEstimate.bytes)}` : '预估大小：暂无法估算'}
                </span>
                <InfoTip
                  title="预估视频大小"
                  content={sizeEstimate
                    ? `${sizeEstimate.basis === 'bitrate'
                      ? `按${sizeEstimate.encoding?.implementation === 'webcodecs' ? ' WebCodecs VBR ' : '最终'}目标码率与时长估算；${includeAudio ? '计入混音轨道预算。' : '不包含音频。'}`
                      : `${sizeEstimate.sampledFrames === sizeEstimate.totalFrames ? '已对完整导出范围试编码。' : `按 ${sizeEstimate.sampleCount} 段实测视频推算，共抽样 ${(sizeEstimate.sampledFrames / videoFormat.fps).toFixed(1)} 秒。`}${includeAudio ? '抽样包含实际音频。' : '不包含音频。'}`}${sizeEstimate.encoding ? `${sizeEstimate.basis === 'sample' ? '实测' : '预估'}编码路径：${formatExportEncoding(sizeEstimate.encoding)}。` : ''}实际大小受画面复杂度影响。`
                    : sizeEstimateError || '面板动画结束后自动估算；自动 / WebCodecs 按 VBR 目标码率计算。使用 FFmpeg CRF / ProRes 时抽样。退出页面自动停止。'}
                />
              </div>
              <div className="export-dialog__footer-actions">
                <button className="btn" onClick={handleClose}>取消</button>
                <button
                  className="btn btn--primary"
                  disabled={!!formatError || preparingExport}
                  onClick={handleExport}
                >
                  <IconFilm width={14} height={14} /> 开始导出
                </button>
              </div>
            </>
          )}

          {(uiState === 'recording' || uiState === 'converting') && (
            <div style={{ display: 'flex', width: '100%', justifyContent: 'flex-end' }}>
              <button className="btn export-dialog__cancel-btn" onClick={handleCancelExport} disabled={cancelling}>
                {cancelling ? '正在取消...' : '取消导出'}
              </button>
            </div>
          )}

          {uiState === 'done' && (
            <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
              <button className="btn" onClick={handleResetToIdle}>
                <IconRefresh width={14} height={14} /> 再导出一份
              </button>
              <div className="export-dialog__footer-actions">
                {isElectron && (
                  <button className="btn" onClick={handleRevealInFolder}>
                    <IconFolder width={14} height={14} /> 打开所在文件夹
                  </button>
                )}
                <button className="btn btn--primary" onClick={onClose}>关闭</button>
              </div>
            </div>
          )}

          {(uiState === 'error' || uiState === 'cancelled') && (
            <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
              <button className="btn" onClick={handleResetToIdle}>
                <IconRefresh width={14} height={14} /> 返回修改配置
              </button>
              <button className="btn btn--primary" onClick={onClose}>关闭</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ExportConfig, ExportEncodingSettings, ExportEncodingSpeed, ExportVideoCodec } from '../api/types/export';
import { EXPORT_CONTAINER_CODECS, FFMPEG_ENCODERS, getDefaultCrf, getSoftwareEncoder } from '../api/exportEncoding';
import { FormSelect } from './FormSelect';
import { InfoTip } from './Tooltip';

interface Props {
  format: ExportConfig['format'];
  value: ExportEncodingSettings;
  bitrate: number;
  intermediateBitrate: number;
  subtitleMode?: 'chroma';
  onChange(value: ExportEncodingSettings): void;
  onBitrateChange(value: number): void;
  onRateControlPointerDown(): void;
}

const CODEC_LABELS: Record<ExportVideoCodec, string> = { h264: 'H.264', hevc: 'H.265 / HEVC', vp9: 'VP9', av1: 'AV1', prores: 'ProRes 4444' };
const ENCODER_LABELS: Record<string, string> = {
  auto: '自动',
  libx264: '软件编码 · x264', libx265: '软件编码 · x265', 'libvpx-vp9': '软件编码 · libvpx VP9',
  'libaom-av1': '软件编码 · libaom AV1', prores_ks: '软件编码 · ProRes',
  h264_nvenc: '硬件加速 · NVIDIA NVENC', hevc_nvenc: '硬件加速 ·NVIDIA NVENC', av1_nvenc: '硬件加速 ·NVIDIA NVENC',
  h264_amf: '硬件加速 ·AMD AMF', hevc_amf: '硬件加速 ·AMD AMF', av1_amf: '硬件加速 ·AMD AMF',
  h264_qsv: '硬件加速 ·Intel QSV', hevc_qsv: '硬件加速 ·Intel QSV', av1_qsv: '硬件加速 ·Intel QSV',
  h264_mf: '硬件加速 ·Windows Media Foundation', hevc_mf: '硬件加速 ·Windows Media Foundation',
};

export function ExportEncodingFields({ format, value, bitrate, intermediateBitrate, subtitleMode, onChange, onBitrateChange, onRateControlPointerDown }: Props) {
  const [availableEncoders, setAvailableEncoders] = useState<readonly string[] | null>(null);
  useEffect(() => {
    let active = true;
    const api = window.aeonStageryAPI?.export;
    if (api?.getEncodingCapabilities) void api.getEncodingCapabilities().then(result => {
      if (active && result.success) setAvailableEncoders(result.encoders);
    }).catch(() => { });
    return () => { active = false; };
  }, []);
  const usesFFmpeg = value.implementation === 'ffmpeg';
  const rateControl = value.rateControl ?? { mode: 'bitrate' as const, bitrateMbps: bitrate };
  const allowIntermediate = value.allowH264Intermediate ?? value.quality !== 'high';
  const canUseIntermediate = value.videoCodec !== 'h264' && value.implementation !== 'ffmpeg';
  const update = (patch: Partial<ExportEncodingSettings>) => onChange({
    ...value, rateControl, allowH264Intermediate: allowIntermediate, quality: 'custom', ...patch,
  });
  const crfMaximum = value.videoCodec === 'h264' || value.videoCodec === 'hevc' ? 51 : 63;
  const bitrateMaximum = Math.max(100, Math.ceil(bitrate / 100) * 100);
  const sliderStyle = (current: number, minimum: number, maximum: number): CSSProperties & { '--export-slider-progress': string } => ({
    '--export-slider-progress': `${Math.max(0, Math.min(100, (current - minimum) / (maximum - minimum) * 100))}%`,
  });
  const updateCrf = (crf: number) => update({ rateControl: { mode: 'crf', crf: Math.min(crfMaximum, Math.round(crf)) } });
  const codecs = EXPORT_CONTAINER_CODECS[format];
  const numberValue = (text: string, apply: (number: number) => void, allowZero = false) => {
    const number = Number(text);
    if (text.trim() && Number.isFinite(number) && (allowZero ? number >= 0 : number > 0)) apply(number);
  };
  const ffmpegEncoderField = <div className="form-group">
    <div className="export-encoding-field-label">
      <label className="form-label" htmlFor="export-ffmpeg-encoder">FFmpeg 编码器</label>
      <InfoTip title="自动选择编码器" content="自动优先尝试环境支持的硬件编码器，不可用时回退软件编码。CRF 使用软件编码。" />
    </div>
    <FormSelect id="export-ffmpeg-encoder" value={value.ffmpegEncoder ?? 'auto'}
      options={[{ value: 'auto', label: '自动' }, ...FFMPEG_ENCODERS[value.videoCodec].map(encoder => ({
        value: encoder,
        label: `${ENCODER_LABELS[encoder] ?? encoder}${availableEncoders && !availableEncoders.includes(encoder) ? '（不可用）' : ''}`
      }))]}
      onChange={ffmpegEncoder => onChange({
        ...value,
        ffmpegEncoder,
        rateControl: ffmpegEncoder === 'auto' || ffmpegEncoder === getSoftwareEncoder(value.videoCodec) ? rateControl : { mode: 'bitrate', bitrateMbps: bitrate }
      })} />
  </div>;

  return <>
    <div className="export-grid--2col">
      {!subtitleMode && <div className="form-group">
        <label className="form-label" htmlFor="export-codec">编码标准</label>
        <FormSelect id="export-codec" value={value.videoCodec} options={codecs.map(codec => ({ value: codec, label: CODEC_LABELS[codec] }))}
          onChange={codec => onChange({
            ...value, videoCodec: codec as ExportVideoCodec, ffmpegEncoder: undefined,
            rateControl: rateControl.mode === 'crf'
              ? { mode: 'crf', crf: getDefaultCrf(codec as ExportVideoCodec, value.quality) }
              : undefined,
          })} />
      </div>}
      <div className="form-group">
        <label className="form-label" htmlFor="export-quality">编码质量</label>
        <FormSelect id="export-quality" value={value.quality}
          options={[{ value: 'balanced', label: '均衡' }, { value: 'high', label: '高画质' }, { value: 'custom', label: '自定义' }]}
          onChange={quality => quality === 'custom' ? update({}) : onChange({
            ...value, quality: quality as ExportEncodingSettings['quality'],
            rateControl: rateControl.mode === 'crf'
              ? { mode: 'crf', crf: getDefaultCrf(value.videoCodec, quality as 'balanced' | 'high') }
              : undefined,
            speed: 'balanced', allowH264Intermediate: quality !== 'high', intermediateBitrateMbps: undefined
          })} />
      </div>
      {!subtitleMode && <div className="form-group">
        <label className="form-label" htmlFor="export-mode">编码方式</label>
        <FormSelect id="export-mode" value={value.implementation}
          options={[{ value: 'auto', label: '自动' }, { value: 'webcodecs', label: 'WebCodecs' }, { value: 'ffmpeg', label: 'FFmpeg' }]}
          onChange={implementation => onChange({ ...value, implementation: implementation as ExportEncodingSettings['implementation'] })} />
      </div>}
      {usesFFmpeg && <div className="form-group">
        <label className="form-label" htmlFor="export-rate-control">FFmpeg 质量控制</label>
        <FormSelect id="export-rate-control" value={rateControl.mode}
          options={[{ value: 'bitrate', label: '目标码率' }, { value: 'crf', label: '恒定质量 (CRF)' }]}
          onChange={mode => update({
            rateControl: mode === 'crf' ? { mode, crf: getDefaultCrf(value.videoCodec, value.quality) } : { mode: 'bitrate', bitrateMbps: bitrate },
            ...(mode === 'crf' && value.ffmpegEncoder && value.ffmpegEncoder !== 'auto'
              ? { ffmpegEncoder: getSoftwareEncoder(value.videoCodec) } : {}),
          })} />
      </div>}
      {(!usesFFmpeg || rateControl.mode === 'bitrate') && <div className="form-group export-encoding-rate">
        <div className="export-encoding-field-label">
          <label className="form-label" htmlFor="export-bitrate">目标码率 (Mbps)</label>
          <InfoTip title="目标码率" content="用于当前视频编码及兼容回退。选择 FFmpeg 恒定质量（CRF）后，改由 CRF 控制画质与大小。" />
        </div>
        <div className="export-encoding-rate__controls">
          <input className="export-encoding-rate__slider" type="range" min={0.1} max={bitrateMaximum} step={0.1}
            onPointerDown={onRateControlPointerDown}
            style={sliderStyle(bitrate, 0.1, bitrateMaximum)}
            aria-label="目标码率滑块 (Mbps)" aria-valuetext={`${bitrate} Mbps`} value={bitrate}
            onChange={event => onBitrateChange(Number(event.target.value))} />
          <input id="export-bitrate" className="form-input" type="number" min={0.1} step={0.1} value={bitrate}
            onChange={event => numberValue(event.target.value, onBitrateChange)} />
          <div className="export-encoding-rate__scale" aria-hidden="true">
            <span>0.1 · 较小文件</span><span>{bitrateMaximum} · 更高画质</span>
          </div>
        </div>
      </div>}
      {usesFFmpeg && rateControl.mode === 'crf' && <div className="form-group export-encoding-rate">
        <div className="export-encoding-field-label">
          <label className="form-label" htmlFor="export-crf">CRF</label>
          <InfoTip title="恒定质量" content="数值越低，画质越高、文件通常越大。不同编码标准的数值不等价。" />
        </div>
        <div className="export-encoding-rate__controls">
          <input className="export-encoding-rate__slider" type="range" min={0} max={crfMaximum} step={1}
            onPointerDown={onRateControlPointerDown}
            style={sliderStyle(rateControl.crf, 0, crfMaximum)}
            aria-label="CRF 滑块" aria-describedby="export-crf-description" value={rateControl.crf}
            onChange={event => updateCrf(Number(event.target.value))} />
          <input id="export-crf" className="form-input" type="number" min={0} max={crfMaximum} step={1}
            aria-describedby="export-crf-description" value={rateControl.crf}
            onChange={event => numberValue(event.target.value, updateCrf, true)} />
          <div className="export-encoding-rate__scale" aria-hidden="true">
            <span>0 · 更高画质</span><span>{crfMaximum} · 较小文件</span>
          </div>
        </div>
        <p id="export-crf-description" className="export-encoding-rate__hint">数值越低，画质越高、文件通常越大。</p>
      </div>}
    </div>
    {(usesFFmpeg || canUseIntermediate) && <details className="export-encoding-advanced">
      <summary>高级编码设置</summary>
      {usesFFmpeg && <div className="export-grid--2col">
        {!subtitleMode && ffmpegEncoderField}
        <div className="form-group">
          <label className="form-label" htmlFor="export-speed">FFmpeg 编码速度</label>
          <FormSelect id="export-speed" value={value.speed ?? 'balanced'}
            options={[{ value: 'fast', label: '快速' }, { value: 'balanced', label: '均衡' }, { value: 'quality', label: '慢速 · 更高压缩率' }]}
            onChange={speed => update({ speed: speed as ExportEncodingSpeed })} />
        </div>
      </div>}
      {canUseIntermediate && <label className="export-encoding-toggle">
        <input type="checkbox" checked={allowIntermediate} onChange={event => update({ allowH264Intermediate: event.target.checked })} />
        <span>允许 H.264 中转加速</span>
        <InfoTip title="兼容回退" content="原生编码失败时，先捕获高码率 H.264，再按目标码率转码；会增加一次有损编码。" />
      </label>}
      {canUseIntermediate && allowIntermediate && <div className="form-group">
        <label className="form-label" htmlFor="export-intermediate-bitrate">中间流码率 (Mbps)</label>
        <input id="export-intermediate-bitrate" className="form-input" type="number" min={0.1} step={0.1}
          value={value.intermediateBitrateMbps ?? intermediateBitrate}
          onChange={event => numberValue(event.target.value, intermediateBitrateMbps => update({ intermediateBitrateMbps }))} />
      </div>}
    </details>}
  </>;
}

export function formatExportEncoding(
  info: import('../api/types/export').ExportEncodingInfo,
  options: { includeFallbackStatus?: boolean } = {},
): string {
  const encoder = ENCODER_LABELS[info.encoder] ?? CODEC_LABELS[info.encoder as ExportVideoCodec] ?? info.encoder;
  const fallbackStatus = info.fallbackReason && options.includeFallbackStatus !== false ? ' · 已回退' : '';
  return `${info.implementation === 'webcodecs-transcode' ? 'H.264 中转 →' : info.implementation === 'webcodecs' ? 'WebCodecs ·' : 'FFmpeg ·'} ${encoder}${fallbackStatus}`;
}

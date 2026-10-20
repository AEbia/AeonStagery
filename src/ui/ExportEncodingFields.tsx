import { useEffect, useState } from 'react';
import type { ExportEncodingSettings, ExportEncodingSpeed, ExportVideoCodec } from '../api/types/export';
import { FFMPEG_ENCODERS, getDefaultCrf, getSoftwareEncoder } from '../api/exportEncoding';
import { FormSelect } from './FormSelect';
import { InfoTip } from './Tooltip';

interface Props {
  format: 'mp4' | 'webm' | 'mov';
  value: ExportEncodingSettings;
  bitrate: number;
  intermediateBitrate: number;
  onChange(value: ExportEncodingSettings): void;
  onBitrateChange(value: number): void;
}

const CODEC_LABELS: Record<ExportVideoCodec, string> = { h264: 'H.264', hevc: 'H.265 / HEVC', vp9: 'VP9', av1: 'AV1', prores: 'ProRes 4444' };
const ENCODER_LABELS: Record<string, string> = {
  libx264: '软件编码 · x264', libx265: '软件编码 · x265', 'libvpx-vp9': '软件编码 · libvpx VP9',
  'libaom-av1': '软件编码 · libaom AV1', prores_ks: '软件编码 · ProRes',
  h264_nvenc: '硬件加速 · NVIDIA NVENC', hevc_nvenc: '硬件加速 ·NVIDIA NVENC', av1_nvenc: '硬件加速 ·NVIDIA NVENC',
  h264_amf: '硬件加速 ·AMD AMF', hevc_amf: '硬件加速 ·AMD AMF', av1_amf: '硬件加速 ·AMD AMF',
  h264_qsv: '硬件加速 ·Intel QSV', hevc_qsv: '硬件加速 ·Intel QSV', av1_qsv: '硬件加速 ·Intel QSV',
  h264_mf: '硬件加速 ·Windows Media Foundation', hevc_mf: '硬件加速 ·Windows Media Foundation',
};

export function ExportEncodingFields({ format, value, bitrate, intermediateBitrate, onChange, onBitrateChange }: Props) {
  const [availableEncoders, setAvailableEncoders] = useState<readonly string[] | null>(null);
  useEffect(() => {
    let active = true;
    const api = window.aeonStageryAPI?.export;
    if (api?.getEncodingCapabilities) void api.getEncodingCapabilities().then(result => {
      if (active && result.success) setAvailableEncoders(result.encoders);
    }).catch(() => { });
    return () => { active = false; };
  }, []);
  const rateControl = value.rateControl ?? { mode: 'crf' as const, crf: getDefaultCrf(value.videoCodec, value.quality) };
  const allowIntermediate = value.allowH264Intermediate ?? value.quality !== 'high';
  const canUseIntermediate = value.videoCodec !== 'h264' && value.implementation !== 'ffmpeg';
  const update = (patch: Partial<ExportEncodingSettings>) => onChange({ ...value, rateControl, quality: 'custom', ...patch });
  const crfMaximum = value.videoCodec === 'h264' || value.videoCodec === 'hevc' ? 51 : 63;
  const codecs: ExportVideoCodec[] = format === 'webm' ? ['vp9', 'av1'] : ['h264', 'hevc', 'av1'];
  const numberValue = (text: string, apply: (number: number) => void, allowZero = false) => {
    const number = Number(text);
    if (text.trim() && Number.isFinite(number) && (allowZero ? number >= 0 : number > 0)) apply(number);
  };
  const ffmpegEncoderField = <div className="form-group">
    <label className="form-label" htmlFor="export-ffmpeg-encoder">FFmpeg 编码器</label>
    <FormSelect id="export-ffmpeg-encoder" value={value.ffmpegEncoder ?? getSoftwareEncoder(value.videoCodec)}
      options={FFMPEG_ENCODERS[value.videoCodec].map(encoder => ({
        value: encoder,
        label: `${ENCODER_LABELS[encoder] ?? encoder}${availableEncoders && !availableEncoders.includes(encoder) ? '（不可用）' : ''}`
      }))}
      onChange={ffmpegEncoder => update({
        ffmpegEncoder,
        rateControl: ffmpegEncoder === getSoftwareEncoder(value.videoCodec) ? rateControl : { mode: 'bitrate', bitrateMbps: bitrate }
      })} />
  </div>;

  return <>
    <div className="export-grid--2col">
      <div className="form-group">
        <label className="form-label" htmlFor="export-codec">编码标准</label>
        <FormSelect id="export-codec" value={value.videoCodec} options={codecs.map(codec => ({ value: codec, label: CODEC_LABELS[codec] }))}
          onChange={codec => update({ videoCodec: codec as ExportVideoCodec, ffmpegEncoder: undefined, rateControl: undefined })} />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="export-quality">编码质量</label>
        <FormSelect id="export-quality" value={value.quality}
          options={[{ value: 'balanced', label: '均衡' }, { value: 'high', label: '高画质' }, { value: 'custom', label: '自定义' }]}
          onChange={quality => onChange({
            ...value, quality: quality as ExportEncodingSettings['quality'], rateControl: undefined,
            speed: 'balanced', allowH264Intermediate: quality !== 'high', intermediateBitrateMbps: undefined
          })} />
      </div>
      <div className="form-group">
        <div className="export-encoding-field-label">
          <label className="form-label" htmlFor="export-bitrate">目标码率 (Mbps)</label>
          <InfoTip title="目标码率" content="用于 WebCodecs 原生编码；FFmpeg 可在高级设置中改用 CRF。" />
        </div>
        <input id="export-bitrate" className="form-input" type="number" min={0.1} step={0.1} value={bitrate}
          onChange={event => numberValue(event.target.value, onBitrateChange)} />
      </div>
      {value.videoCodec !== 'h264' && ffmpegEncoderField}
    </div>
    <details className="export-encoding-advanced">
      <summary>高级编码设置</summary>
      <div className="export-grid--2col">
        <div className="form-group">
          <label className="form-label" htmlFor="export-mode">编码方式</label>
          <FormSelect id="export-mode" value={value.implementation}
            options={[{ value: 'auto', label: '自动' }, { value: 'webcodecs', label: 'WebCodecs' }, { value: 'ffmpeg', label: 'FFmpeg' }]}
            onChange={implementation => update({ implementation: implementation as ExportEncodingSettings['implementation'] })} />
        </div>
        {value.videoCodec === 'h264' && ffmpegEncoderField}
        <div className="form-group">
          <label className="form-label" htmlFor="export-rate-control">FFmpeg 质量控制</label>
          <FormSelect id="export-rate-control" value={rateControl.mode}
            options={[{ value: 'crf', label: '恒定质量 (CRF)' }, { value: 'bitrate', label: '目标码率' }]}
            onChange={mode => update({
              rateControl: mode === 'crf' ? { mode, crf: getDefaultCrf(value.videoCodec, value.quality) } : { mode: 'bitrate', bitrateMbps: bitrate },
              ...(mode === 'crf' ? { ffmpegEncoder: getSoftwareEncoder(value.videoCodec) } : {})
            })} />
        </div>
        <div className="form-group">
          {rateControl.mode === 'crf' ? <>
            <div className="export-encoding-field-label">
              <label className="form-label" htmlFor="export-crf">CRF</label>
              <InfoTip title="恒定质量" content="数值越低，画质越高、文件通常越大。不同编码标准的数值不等价。" />
            </div>
            <input id="export-crf" className="form-input" type="number" min={0} max={crfMaximum}
              value={rateControl.crf} onChange={event => numberValue(event.target.value, crf => update({ rateControl: { mode: 'crf', crf: Math.min(crfMaximum, Math.round(crf)) } }), true)} />
          </> : <>
            <label className="form-label" htmlFor="export-ffmpeg-bitrate">FFmpeg 码率 (Mbps)</label>
            <input id="export-ffmpeg-bitrate" className="form-input" type="number" min={0.1} step={0.1} value={rateControl.bitrateMbps}
              onChange={event => numberValue(event.target.value, bitrateMbps => update({ rateControl: { mode: 'bitrate', bitrateMbps } }))} />
          </>}
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="export-speed">FFmpeg 编码速度</label>
          <FormSelect id="export-speed" value={value.speed ?? 'balanced'}
            options={[{ value: 'fast', label: '快速' }, { value: 'balanced', label: '均衡' }, { value: 'quality', label: '慢速 · 更高压缩率' }]}
            onChange={speed => update({ speed: speed as ExportEncodingSpeed })} />
        </div>
      </div>
      {canUseIntermediate && <label className="export-encoding-toggle">
        <input type="checkbox" checked={allowIntermediate} onChange={event => update({ allowH264Intermediate: event.target.checked })} />
        <span>允许 H.264 中转加速</span>
        <InfoTip title="兼容回退" content="原生编码失败时，先捕获高码率 H.264 再转码；会增加一次有损编码。" />
      </label>}
      {canUseIntermediate && allowIntermediate && <div className="form-group">
        <label className="form-label" htmlFor="export-intermediate-bitrate">中间流码率 (Mbps)</label>
        <input id="export-intermediate-bitrate" className="form-input" type="number" min={0.1} step={0.1}
          value={value.intermediateBitrateMbps ?? intermediateBitrate}
          onChange={event => numberValue(event.target.value, intermediateBitrateMbps => update({ intermediateBitrateMbps }))} />
      </div>}
    </details>
  </>;
}

export function formatExportEncoding(info: import('../api/types/export').ExportEncodingInfo): string {
  const encoder = ENCODER_LABELS[info.encoder] ?? CODEC_LABELS[info.encoder as ExportVideoCodec] ?? info.encoder;
  return `${info.implementation === 'webcodecs-transcode' ? 'H.264 中转 →' : info.implementation === 'webcodecs' ? 'WebCodecs ·' : 'FFmpeg ·'} ${encoder}${info.fallbackReason ? ' · 已回退' : ''}`;
}

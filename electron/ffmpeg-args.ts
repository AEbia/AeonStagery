import type { FFmpegAudioSource, FFmpegConvertOptions, FFmpegStreamOptions, FFmpegVideoOptions } from '../src/api/types/export';
import { isHardwareEncoder } from '../src/api/exportEncoding';
export type { FFmpegAudioSource, FFmpegConvertOptions } from '../src/api/types/export';

export function buildFFmpegConvertArgs(
  inputPath: string,
  outputPath: string,
  options: FFmpegConvertOptions = {},
  sourceExists: (sourcePath: string) => boolean = () => true,
): string[] {
  const {
    fps = 60,
    width = 1920,
    height = 1080,
    audioPaths: legacyPaths = [],
    audioSources = [],
    audioCodec = 'aac',
    codec = 'libx264',
    bitrate = 12,
    totalFrames,
    transparent = false,
    crf,
    speed = 'balanced',
  } = options;

  const sources: FFmpegAudioSource[] = audioSources.length > 0
    ? audioSources
    : legacyPaths.map((sourcePath) => ({ path: sourcePath, delayMs: 0 }));
  const validSources = sources.filter((source) => sourceExists(source.path));
  const outputDuration = positiveNumber(totalFrames) && positiveNumber(fps)
    ? totalFrames / fps
    : undefined;

  const args: string[] = [
    '-y',
    '-i', inputPath,
  ];

  appendAudioInputs(args, validSources);

  args.push(...buildFFmpegVideoArgs({ codec, bitrate, crf, speed, transparent }, fps));
  if (codec !== 'copy') args.push('-r', String(fps), '-s', `${width}x${height}`);

  appendMuxOutput(args, outputPath, validSources, audioCodec, outputDuration);
  return args;
}

function appendAudioInputs(args: string[], sources: FFmpegAudioSource[]): void {
  for (const source of sources) {
    if (source.loop === true) args.push('-stream_loop', '-1');
    args.push('-i', source.path);
  }
}

function appendMuxOutput(
  args: string[], outputPath: string, validSources: FFmpegAudioSource[],
  audioCodec: string, outputDuration?: number,
): void {
  if (validSources.length > 0) {
    args.push('-c:a', audioCodec, '-b:a', audioCodec === 'libopus' ? '128k' : '192k');
    const filterParts: string[] = [];
    const delayedLabels: string[] = [];
    for (let i = 0; i < validSources.length; i++) {
      const source = validSources[i];
      const label = `a${i}d`;
      delayedLabels.push(`[${label}]`);
      filterParts.push(`[${i + 1}:a]${buildAudioFilterChain(source, outputDuration).join(',')}[${label}]`);
    }
    // Timeline clips retain their authored gains, including while other inputs are delayed.
    filterParts.push(`${delayedLabels.join('')}amix=inputs=${validSources.length}:duration=longest:normalize=0[aout]`);
    args.push('-filter_complex', filterParts.join(';'));
    args.push('-map', '0:v', '-map', '[aout]');
    // Combining -shortest with -t can cut delayed/reordered MP4 packets in
    // bundled FFmpeg 7. Known export duration already caps all mixed audio.
    if (outputDuration === undefined) args.push('-shortest');
  } else {
    args.push('-an');
  }

  appendOutputFlags(args, outputPath);
  if (outputDuration !== undefined) {
    args.push('-t', formatSeconds(outputDuration));
  }
  args.push(outputPath);
}

export function buildFFmpegVideoArgs(options: FFmpegVideoOptions, fps = 60): string[] {
  const { codec: requestedCodec = 'libx264', bitrate = 12, crf, speed = 'balanced', transparent = false } = options;
  const codec = requestedCodec === 'vp9' ? 'libvpx-vp9' : requestedCodec;
  const args: string[] = [];
  if (codec === 'copy') {
    return ['-c:v', 'copy'];
  }
  const speedIndex = { fast: 0, balanced: 1, quality: 2 }[speed];
  if (speedIndex === undefined) throw new Error('Invalid encoding speed');
  if (crf !== undefined && (!Number.isFinite(crf) || crf < 0 || crf > (codec === 'libx264' || codec === 'libx265' ? 51 : 63))) throw new Error('Invalid CRF');
  if (crf !== undefined && (codec === 'libvpx-vp9' || codec === 'libaom-av1') && !Number.isInteger(crf)) throw new Error('Invalid integer CRF');
  if (crf === undefined && (!Number.isFinite(bitrate) || bitrate <= 0)) throw new Error('Invalid video bitrate');
  args.push('-c:v', codec);
  if (transparent) {
    if (codec !== 'prores_ks') throw new Error('Transparent export requires ProRes 4444');
    args.push('-profile:v', '4444', '-q:v', '6', '-pix_fmt', 'yuva444p10le');
  } else if (isHardwareEncoder(codec)) {
    if (crf !== undefined) throw new Error(`CRF is not supported by encoder ${codec}`);
    if (codec.endsWith('_nvenc')) args.push('-preset', ['p2', 'p4', 'p6'][speedIndex]);
    else if (codec.endsWith('_amf')) args.push('-quality', ['speed', 'balanced', 'quality'][speedIndex]);
    else if (codec.endsWith('_qsv')) args.push('-preset', ['veryfast', 'medium', 'slow'][speedIndex]);
    args.push('-b:v', `${bitrate}M`, '-pix_fmt', 'nv12');
  } else {
    if (codec === 'libx264' || codec === 'libx265') args.push('-preset', ['veryfast', 'medium', 'slow'][speedIndex]);
    else if (codec === 'libvpx-vp9') args.push('-deadline', 'good', '-cpu-used', String([4, 2, 1][speedIndex]), '-row-mt', '1');
    else if (codec === 'libaom-av1') args.push('-cpu-used', String([8, 6, 4][speedIndex]), '-row-mt', '1');
    if (crf !== undefined) {
      args.push('-crf', String(crf));
      if (codec === 'libvpx-vp9' || codec === 'libaom-av1') args.push('-b:v', '0');
    } else args.push('-b:v', `${bitrate}M`);
    args.push('-pix_fmt', 'yuv420p');
  }
  if (!transparent) args.push('-g', String(Math.max(1, Math.round(fps * 2))));
  if (codec.includes('265') || codec.includes('hevc')) {
    args.push('-tag:v', 'hvc1');
  }
  return args;
}

function appendOutputFlags(args: string[], outputPath: string): void {
  if (/\.mp4$/i.test(outputPath)) args.push('-movflags', '+faststart');
}

export function buildFFmpegStreamArgs(
  outputPath: string, options: FFmpegStreamOptions = {},
  sourceExists: (sourcePath: string) => boolean = () => true,
): string[] {
  const { fps = 60, width = 1920, height = 1080, audioCodec = 'aac', totalFrames } = options;
  const input = options.inputFormat ?? (options.isEncoded ? 'h264' : 'rgba');
  const sources = (options.audioSources ?? []).filter(source => sourceExists(source.path));
  const outputDuration = positiveNumber(totalFrames) && positiveNumber(fps) ? totalFrames / fps : undefined;
  let args: string[];
  if (input === 'rgba') {
    args = ['-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', '-'];
  } else {
    if (!['h264', 'hevc', 'ivf'].includes(input)) throw new Error('Invalid encoded input format');
    args = ['-y', '-fflags', '+genpts', '-f', input];
    if (input !== 'ivf') args.push('-r', String(fps));
    args.push('-i', '-');
  }
  appendAudioInputs(args, sources);
  if (input === 'rgba') {
    if (options.vflip) args.push('-vf', 'vflip');
    args.push(...buildFFmpegVideoArgs(options, fps));
  } else if (options.transcode) {
    args.push(...buildFFmpegVideoArgs(options.transcode, fps));
    args.push('-r', String(fps));
  } else {
    args.push('-c:v', 'copy');
    if (input !== 'ivf') args.push('-bsf:v', 'setts=pts=N:dts=N');
    if (input === 'hevc') args.push('-tag:v', 'hvc1');
  }
  appendMuxOutput(args, outputPath, sources, audioCodec, outputDuration);
  return args;
}

function buildAudioFilterChain(source: FFmpegAudioSource, outputDuration: number | undefined): string[] {
  const chain: string[] = [];
  const startOffset = positiveNumber(source.startOffset) ? source.startOffset : 0;
  const duration = positiveNumber(source.duration) ? source.duration : undefined;
  const delaySeconds = positiveNumber(source.delayMs) ? source.delayMs / 1000 : 0;
  const effectiveDuration = duration ?? (
    outputDuration === undefined ? undefined : Math.max(0, outputDuration - delaySeconds)
  );

  if (startOffset > 0 || duration !== undefined || source.loop === true) {
    const trimEnd = duration === undefined ? '' : `:end=${formatSeconds(startOffset + duration)}`;
    chain.push(`atrim=start=${formatSeconds(startOffset)}${trimEnd}`, 'asetpts=PTS-STARTPTS');
  }
  if (nonNegativeNumber(source.volume) && source.volume !== 1) {
    chain.push(`volume=${formatSeconds(source.volume)}`);
  }
  if (positiveNumber(source.fadeIn)) {
    if (isMidFade(source.fadeInStartGain)) {
      chain.push(buildFadeEnvelopeVolume('in', source.fadeInStartGain, source.fadeIn));
    } else {
      chain.push(`afade=t=in:st=0:d=${formatSeconds(source.fadeIn)}`);
    }
  }
  if (positiveNumber(source.fadeOut) && effectiveDuration !== undefined && effectiveDuration > 0) {
    const fadeDuration = Math.min(source.fadeOut, effectiveDuration);
    if (isMidFade(source.fadeOutStartGain)) {
      chain.push(buildFadeEnvelopeVolume('out', source.fadeOutStartGain, fadeDuration));
    } else {
      chain.push(`afade=t=out:st=${formatSeconds(Math.max(0, effectiveDuration - fadeDuration))}:d=${formatSeconds(fadeDuration)}`);
    }
  }
  if (positiveNumber(source.delayMs)) {
    chain.push(`adelay=${Math.round(source.delayMs)}|${Math.round(source.delayMs)}`);
  }
  if (chain.length === 0) chain.push('anull');
  return chain;
}

function isMidFade(value: number | undefined): value is number {
  return nonNegativeNumber(value) && value > 0 && value < 1;
}

function buildFadeEnvelopeVolume(type: 'in' | 'out', startGain: number, duration: number): string {
  const gain = formatSeconds(startGain);
  const fadeDuration = formatSeconds(duration);
  const expression = type === 'in'
    ? `if(lt(t,${fadeDuration}),${gain}+(1-${gain})*t/${fadeDuration},1)`
    : `if(lt(t,${fadeDuration}),${gain}*(1-t/${fadeDuration}),0)`;
  // FFmpeg evaluates volume expressions once by default. Mid-fade sources
  // need the envelope to be recalculated for every audio frame.
  return `volume='${expression}':eval=frame`;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function formatSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : Number(value.toFixed(6)).toString();
}

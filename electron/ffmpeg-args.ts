export interface FFmpegAudioSource {
  path: string;
  delayMs: number;
  startOffset?: number;
  duration?: number;
  volume?: number;
  fadeIn?: number;
  fadeInStartGain?: number;
  fadeOut?: number;
  fadeOutStartGain?: number;
  loop?: boolean;
}

export interface FFmpegConvertOptions {
  fps?: number;
  width?: number;
  height?: number;
  audioPaths?: string[];
  audioSources?: FFmpegAudioSource[];
  audioCodec?: string;
  codec?: string;
  bitrate?: number;
  totalFrames?: number;
  /** Preserve the alpha channel (yuva420p) when re-encoding — subtitle-only exports. */
  transparent?: boolean;
}

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

  for (const source of validSources) {
    if (source.loop === true) args.push('-stream_loop', '-1');
    args.push('-i', source.path);
  }

  appendVideoCodecArgs(args, codec, bitrate, fps, width, height, transparent);

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
    args.push('-shortest');
  } else {
    args.push('-an');
  }

  if (outputDuration !== undefined) {
    args.push('-t', formatSeconds(outputDuration));
  }
  args.push(outputPath);
  return args;
}

function appendVideoCodecArgs(
  args: string[],
  codec: string,
  bitrate: number,
  fps: number,
  width: number,
  height: number,
  transparent: boolean,
): void {
  if (codec === 'copy') {
    args.push('-c:v', 'copy');
    return;
  }

  args.push('-c:v', codec);
  const isHWEncoder = codec.includes('nvenc') || codec.includes('amf') || codec.includes('qsv') || codec.includes('mf');
  if (transparent) {
    // Apple ProRes 4444 — 10-bit 4:4:4 with alpha plane (MOV). Quality-driven
    // encode; 4444 profile is required for the alpha channel.
    args.push(
      '-profile:v', '4444',
      '-q:v', '6',
      '-pix_fmt', 'yuva444p10le',
    );
  } else if (codec === 'libaom-av1') {
    args.push(
      '-cpu-used', '8',
      '-b:v', `${bitrate}M`,
      '-pix_fmt', 'yuv420p',
    );
  } else if (isHWEncoder) {
    args.push(
      '-b:v', `${bitrate}M`,
      '-pix_fmt', 'nv12',
    );
  } else {
    args.push(
      '-preset', 'medium',
      '-b:v', `${bitrate}M`,
      '-pix_fmt', 'yuv420p',
    );
  }
  args.push(
    '-r', String(fps),
    '-s', `${width}x${height}`,
  );
  if (codec.includes('265') || codec.includes('hevc')) {
    args.push('-tag:v', 'hvc1');
  }
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

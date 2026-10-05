/**
 * AeonStagery — FFmpeg Video Export Module (Electron Main Process)
 *
 * Handles converting captured WebM video to MP4 using bundled FFmpeg.
 * Also supports audio muxing for BGM + voice tracks.
 */

import { ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import { buildFFmpegConvertArgs, type FFmpegAudioSource } from './ffmpeg-args';

export function resolveFfmpegExecutablePath(candidate: string): string {
  // electron-builder unpacks executable files beside app.asar. ffmpeg-static
  // can still return the original app.asar path, which cannot be spawned.
  return candidate.replace(/([\\/])app\.asar([\\/])/i, '$1app.asar.unpacked$2');
}

// ffmpeg-static provides the path to the bundled ffmpeg binary
let ffmpegPath: string;
try {
  ffmpegPath = resolveFfmpegExecutablePath(require('ffmpeg-static'));
} catch {
  ffmpegPath = 'ffmpeg'; // Fallback to system ffmpeg
}

interface StreamCompletion {
  success: boolean;
  code: number | null;
  error?: string;
}

interface PendingWrite {
  settled: boolean;
  resolve: () => void;
  reject: (reason: Error) => void;
}

interface StreamState {
  child: any;
  expectedFrameSize: number;
  endRequested: boolean;
  closed: boolean;
  failure?: string;
  pendingWrites: Set<PendingWrite>;
  completion: Promise<StreamCompletion>;
  resolveCompletion: (result: StreamCompletion) => void;
  completionSettled: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createStreamState(child: any, expectedFrameSize: number): StreamState {
  let resolveCompletion!: (result: StreamCompletion) => void;
  return {
    child,
    expectedFrameSize,
    endRequested: false,
    closed: false,
    pendingWrites: new Set(),
    completion: new Promise((resolve) => { resolveCompletion = resolve; }),
    resolveCompletion,
    completionSettled: false,
  };
}

function settleCompletion(state: StreamState, result: StreamCompletion): void {
  if (state.completionSettled) return;
  state.completionSettled = true;
  state.resolveCompletion(result);
}

function rejectPendingWrites(state: StreamState): void {
  if (!state.failure) return;
  const error = new Error(state.failure);
  for (const pending of state.pendingWrites) {
    if (pending.settled) continue;
    pending.settled = true;
    pending.reject(error);
  }
  state.pendingWrites.clear();
}

function recordStreamFailure(state: StreamState, message: string, terminate = false): void {
  if (!state.failure) state.failure = message;
  rejectPendingWrites(state);
  if (terminate && !state.closed) {
    try {
      state.child.kill();
    } catch {
      // The process may already have exited between the stream error and kill.
    }
  }
  if (state.endRequested) {
    settleCompletion(state, { success: false, code: null, error: state.failure });
  }
}

function streamFailure(state: StreamState, fallback: string): Error {
  return new Error(state.failure || fallback);
}

function emitFFmpegLog(message: string): void {
  try {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send('ffmpeg:log', message);
  } catch {
    // Logging must not turn a completed/failed export into a second failure.
  }
}

function handleStreamClose(state: StreamState, code: number | null, signal?: string | null): void {
  state.closed = true;
  if (code !== 0 || signal) {
    const suffix = signal ? ` (${signal})` : '';
    recordStreamFailure(state, `FFmpeg stream exited with code ${code ?? 'unknown'}${suffix}`);
  } else if (!state.endRequested) {
    recordStreamFailure(state, 'FFmpeg stream exited before export completion');
  }

  if (state.failure) rejectPendingWrites(state);
  settleCompletion(state, {
    success: !state.failure && code === 0,
    code,
    ...(state.failure ? { error: state.failure } : {}),
  });
}

function writeStreamChunk(state: StreamState, buffer: Buffer, label: string): Promise<void> {
  if (state.failure) return Promise.reject(streamFailure(state, 'FFmpeg stream failed'));
  if (state.closed) return Promise.reject(new Error('FFmpeg stream is closed'));
  if (!state.child.stdin) return Promise.reject(new Error('FFmpeg stream stdin is unavailable'));

  return new Promise<void>((resolve, reject) => {
    const pending: PendingWrite = {
      settled: false,
      resolve,
      reject,
    };
    state.pendingWrites.add(pending);

    const finish = (error?: Error): void => {
      if (pending.settled) return;
      pending.settled = true;
      state.pendingWrites.delete(pending);
      if (error) pending.reject(error);
      else pending.resolve();
    };

    let canWrite = false;
    let writeReturned = false;
    let callbackCalled = false;
    let callbackError: Error | undefined;
    const handleWriteError = (error: unknown): void => {
      const message = `${label} write error: ${errorText(error)}`;
      console.error(`[${label}] ${message}`);
      const failure = new Error(message);
      recordStreamFailure(state, message, true);
      finish(failure);
    };
    const onWrite = (error?: Error): void => {
      callbackCalled = true;
      callbackError = error;
      if (!writeReturned) return;
      if (error) {
        handleWriteError(error);
      } else if (canWrite) {
        finish();
      }
    };

    try {
      canWrite = state.child.stdin.write(buffer, onWrite);
      writeReturned = true;
      if (callbackCalled) {
        if (callbackError) {
          handleWriteError(callbackError);
        } else if (canWrite) {
          finish();
        }
      }
      if (!canWrite) {
        state.child.stdin.once('drain', () => {
          if (state.failure) finish(streamFailure(state, 'FFmpeg stream failed while draining'));
          else finish();
        });
      }
    } catch (error) {
      handleWriteError(error);
    }
  });
}

async function finishStream(state: StreamState): Promise<{ success: true; code: number | null }> {
  if (state.failure) throw streamFailure(state, 'FFmpeg stream failed');
  if (state.closed) throw new Error('FFmpeg stream closed before export completion');

  state.endRequested = true;
  try {
    state.child.stdin?.end();
  } catch (error) {
    const message = `FFmpeg stream end error: ${errorText(error)}`;
    recordStreamFailure(state, message, true);
    throw new Error(message);
  }

  const completion = await state.completion;
  if (!completion.success) throw new Error(completion.error || 'FFmpeg stream export failed');
  return { success: true, code: completion.code };
}

/**
 * Register all FFmpeg-related IPC handlers.
 */
export function registerFFmpegHandlers(): void {
  let activeStreamState: StreamState | null = null;
  const conversions = new Set<{ child: any; outputPath: string; cancelled: boolean; closed: Promise<void> }>();
  let streamOutputPath: string | null = null;
  let streamClosed: Promise<void> | null = null;

  // Wait for process handles to close before removing incomplete output files.
  ipcMain.handle('ffmpeg:cancelExport', async () => {
    const state = activeStreamState;
    const outputPath = streamOutputPath;
    const closed = streamClosed;
    const runningConversions = [...conversions];
    if (state && !state.closed) {
      recordStreamFailure(state, 'Export cancelled', true);
    }
    for (const conversion of runningConversions) {
      conversion.cancelled = true;
      conversion.child.kill();
    }
    await Promise.all([closed, ...runningConversions.map((conversion) => conversion.closed)]);
    if (activeStreamState === state) {
      activeStreamState = null;
      streamOutputPath = null;
      streamClosed = null;
    }
    const outputs = new Set([
      ...(state && outputPath ? [outputPath] : []),
      ...runningConversions.map((conversion) => conversion.outputPath),
    ]);
    for (const output of outputs) {
      await fs.promises.rm(output, { force: true });
    }
    return { success: true };
  });

  // Convert WebM to MP4
  ipcMain.handle('ffmpeg:convert', async (
    _event,
    inputPath: string,
    outputPath: string,
    options: {
      fps?: number;
      width?: number;
      height?: number;
      audioPaths?: string[];  // legacy: flat path array
      audioSources?: FFmpegAudioSource[];  // new: with timing
      audioCodec?: string;
      crf?: number;
      codec?: string;
      bitrate?: number;
      totalFrames?: number;
    } = {}
  ) => {
    return new Promise((resolve) => {
      const args = buildFFmpegConvertArgs(inputPath, outputPath, options, fs.existsSync);

      console.log(`[FFmpeg] Converting: ${inputPath} → ${outputPath}`);
      console.log(`[FFmpeg] Args: ${args.join(' ')}`);

      let child: any;
      let stderrAccum = '';
      let settled = false;
      const finish = (result: { success: boolean; error?: string; stderr?: string; path?: string }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        child = spawn(ffmpegPath, args);
      } catch (error) {
        const message = `FFmpeg process error: ${errorText(error)}`;
        console.error(`[FFmpeg Convert] ${message}`);
        finish({ success: false, error: message, stderr: stderrAccum });
        return;
      }

      if (!child || typeof child.on !== 'function') {
        const message = 'FFmpeg process did not return an evented child process';
        console.error(`[FFmpeg Convert] ${message}`);
        finish({ success: false, error: message, stderr: stderrAccum });
        return;
      }

      const conversion = {
        child, outputPath, cancelled: false,
        closed: new Promise<void>((resolveClosed) => child.once('close', resolveClosed)),
      };
      conversions.add(conversion);

      child.stderr?.on('data', (data: any) => {
        const msg = data.toString();
        stderrAccum += msg;
        console.error(`[FFmpeg Convert] ${msg}`);
        emitFFmpegLog(msg);
      });

      child.stderr?.on('error', (error: unknown) => {
        const message = `FFmpeg stderr stream error: ${errorText(error)}`;
        console.error(`[FFmpeg Convert] ${message}`);
        finish({ success: false, error: message, stderr: stderrAccum });
        try { child.kill(); } catch { /* process may already be closed */ }
      });

      child.on('error', (error: unknown) => {
        const message = `FFmpeg process error: ${errorText(error)}`;
        console.error(`[FFmpeg Convert] ${message}`);
        finish({ success: false, error: message, stderr: stderrAccum });
      });

      child.on('close', (code: number | null, signal?: string | null) => {
        conversions.delete(conversion);
        if (conversion.cancelled) {
          finish({ success: false, error: 'Export cancelled' });
        } else if (code !== 0) {
          const suffix = signal ? ` (${signal})` : '';
          const message = `转码失败 (Code ${code ?? 'unknown'}${suffix})`;
          console.error(`[FFmpeg Convert] ${message}`);
          finish({ success: false, error: message, stderr: stderrAccum });
        } else if (!settled) {
          console.log('[FFmpeg] Conversion complete:', outputPath);
          finish({ success: true, path: outputPath });
        }
      });
    });
  });

  // Show save dialog specifically for video export
  ipcMain.handle('ffmpeg:showExportDialog', async (_event) => {
    const result = await dialog.showSaveDialog({
      title: 'Export Video',
      defaultPath: `AeonStagery_Export_${Date.now()}.mp4`,
      filters: [
        { name: 'MP4 Video', extensions: ['mp4'] },
        { name: 'WebM Video', extensions: ['webm'] },
      ],
    });
    return result;
  });

  // Get ffmpeg version (for diagnostics)
  ipcMain.handle('ffmpeg:version', async () => {
    return new Promise((resolve) => {
      execFile(ffmpegPath, ['-version'], (error, stdout) => {
        if (error) {
          resolve({ success: false, error: error.message });
        } else {
          resolve({ success: true, version: stdout.split('\n')[0] });
        }
      });
    });
  });

  // Get temp directory for intermediate files
  ipcMain.handle('ffmpeg:getTempDir', async () => {
    const tmpDir = path.join(process.env.TEMP || process.env.TMP || '/tmp', 'aeonstagery-export');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    return tmpDir;
  });

  // ─── Deterministic Offline Rendering (Accelerated Export) ───

  ipcMain.handle('ffmpeg:startStreamExport', async (
    _event,
    outputPath: string,
    options: {
      fps?: number;
      width?: number;
      height?: number;
      codec?: string;
      crf?: number;
      vflip?: boolean;
      isEncoded?: boolean; // New flag for WebCodecs path
      bitrate?: number;
      transparent?: boolean; // Preserve alpha (yuva420p) — subtitle-only exports
    } = {}
  ) => {
    const {
      fps = 60,
      width = 1920,
      height = 1080,
      codec = 'libx264',
      vflip = false,
      isEncoded = false,
      bitrate = 12,
      transparent = false,
    } = options;

    if (activeStreamState) {
      recordStreamFailure(activeStreamState, 'FFmpeg stream export superseded', true);
      activeStreamState.endRequested = true;
      settleCompletion(activeStreamState, {
        success: false,
        code: null,
        error: activeStreamState.failure,
      });
      try { activeStreamState.child.stdin?.end(); } catch { /* already closed */ }
      activeStreamState = null;
    }

    let args: string[] = [];

    if (isEncoded) {
      // --- WebCodecs Muxing Mode ---
      // We expect a raw H.264 bitstream (Annex B) from the renderer.
      args = [
        '-y',
        '-fflags', '+genpts',  // Force FFmpeg to generate missing timestamps
        '-f', 'h264',          // Input format is raw H.264 bitstream
        '-r', String(fps),     // Input frame rate
        '-i', '-',             // Read from stdin
        // The raw H.264 demuxer has no packet timestamps. setts assigns the
        // packet index as PTS/DTS in the input frame-rate time base so the
        // MP4 muxer receives valid timestamps while keeping the encoded video.
        '-bsf:v', 'setts=pts=N:dts=N',
        '-c:v', 'copy',        // Just copy (no re-encoding)
      ];
    } else {
      // --- Raw Pixels Encoding Mode ---
      args = [
        '-y',
        '-f', 'rawvideo',
        '-pixel_format', 'rgba',
        '-video_size', `${width}x${height}`,
        '-framerate', String(fps),
        '-i', '-',
      ];

      if (vflip) {
        args.push('-vf', 'vflip');
      }

      args.push('-c:v', codec);
      const isHWEncoder = codec.includes('nvenc') || codec.includes('amf') || codec.includes('qsv') || codec.includes('mf');
      if (transparent) {
        // Apple ProRes 4444 — 10-bit 4:4:4 with alpha plane. Quality-driven
        // encode; 4444 profile is required for the alpha channel. The
        // renderer only requests transparent with prores_ks.
        args.push(
          '-profile:v', '4444',
          '-q:v', '6',
          '-pix_fmt', 'yuva444p10le',
        );
      } else if (codec === 'libaom-av1') {
        args.push('-cpu-used', '8');
        args.push(
          '-b:v', `${bitrate}M`,
          '-pix_fmt', 'yuv420p'
        );
      } else if (isHWEncoder) {
        // GPU hardware encoders: require nv12 pixel format and target bitrate instead of -preset/-crf
        args.push(
          '-b:v', `${bitrate}M`,
          '-pix_fmt', 'nv12'
        );
      } else {
        args.push(
          '-preset', 'ultrafast',
          '-b:v', `${bitrate}M`,
          '-pix_fmt', 'yuv420p'
        );
      }
    }

    if ((codec.includes('265') || codec.includes('hevc')) && !isEncoded) {
      args.push('-tag:v', 'hvc1');
    }

    args.push(outputPath);

    console.log(`[FFmpeg Stream] Starting with args: ${args.join(' ')}`);

    let child: any;
    try {
      child = spawn(ffmpegPath, args);
    } catch (error) {
      const message = `FFmpeg process error: ${errorText(error)}`;
      console.error(`[FFmpeg Stream] ${message}`);
      return { success: false, error: message };
    }

    if (
      !child
      || typeof child.on !== 'function'
      || !child.stdin
      || typeof child.stdin.write !== 'function'
      || typeof child.stdin.on !== 'function'
    ) {
      const message = 'FFmpeg process started without a writable stdin stream';
      console.error(`[FFmpeg Stream] ${message}`);
      try { child?.kill?.(); } catch { /* process may not have started */ }
      return { success: false, error: message };
    }

    const state = createStreamState(child, width * height * 4);
    activeStreamState = state;
    streamOutputPath = outputPath;
    streamClosed = new Promise<void>((resolveClosed) => child.once('close', resolveClosed));

    child.stderr?.on('data', (data: any) => {
      const msg = data.toString();
      console.error(`[FFmpeg Stream] ${msg}`);
      emitFFmpegLog(msg);
    });

    child.stderr?.on('error', (error: unknown) => {
      const message = `FFmpeg stderr stream error: ${errorText(error)}`;
      console.error(`[FFmpeg Stream] ${message}`);
      recordStreamFailure(state, message, true);
    });

    child.stdin?.on('error', (error: unknown) => {
      const message = `FFmpeg stdin stream error: ${errorText(error)}`;
      console.error(`[FFmpeg Stream] ${message}`);
      recordStreamFailure(state, message, true);
    });

    child.stdin?.on('close', () => {
      if (!state.endRequested && !state.closed) {
        const message = 'FFmpeg stdin closed before export completion';
        console.error(`[FFmpeg Stream] ${message}`);
        recordStreamFailure(state, message, true);
      }
    });

    child.on('error', (error: unknown) => {
      const message = `FFmpeg process error: ${errorText(error)}`;
      console.error(`[FFmpeg Stream] ${message}`);
      recordStreamFailure(state, message, true);
    });

    child.on('exit', (code: number | null, signal?: string | null) => {
      if (code !== 0 || signal) {
        const suffix = signal ? ` (${signal})` : '';
        recordStreamFailure(state, `FFmpeg stream exited with code ${code ?? 'unknown'}${suffix}`);
      }
    });

    child.on('close', (code: number | null, signal?: string | null) => {
      handleStreamClose(state, code, signal);
    });

    if (state.failure) return { success: false, error: state.failure };

    return { success: true };
  });

  // Handle compressed chunks from WebCodecs
  ipcMain.handle('ffmpeg:pushEncodedChunk', async (_event, chunkData: Uint8Array) => {
    if (!activeStreamState) throw new Error('No active FFmpeg process');
    await writeStreamChunk(activeStreamState, Buffer.from(chunkData), 'FFmpeg Chunk');
    return { success: true };
  });

  ipcMain.handle('ffmpeg:pushFrame', async (_event, frameData: Uint8Array | Uint8ClampedArray) => {
    if (!activeStreamState) throw new Error('No active FFmpeg process');
    const buffer = Buffer.from(frameData.buffer, frameData.byteOffset, frameData.byteLength);

    if (buffer.length !== activeStreamState.expectedFrameSize) {
      const msg = `[FFmpeg] Buffer size mismatch! Expected ${activeStreamState.expectedFrameSize}, got ${buffer.length}`;
      console.error(msg);
      emitFFmpegLog(msg);
      recordStreamFailure(activeStreamState, 'Buffer size mismatch', true);
      throw new Error('Buffer size mismatch');
    }

    await writeStreamChunk(activeStreamState, buffer, 'FFmpeg');
    return { success: true };
  });

  ipcMain.handle('ffmpeg:endStreamExport', async () => {
    const state = activeStreamState;
    if (!state) throw new Error('No active FFmpeg process');

    try {
      return await finishStream(state);
    } finally {
      if (activeStreamState === state) activeStreamState = null;
    }
  });
}

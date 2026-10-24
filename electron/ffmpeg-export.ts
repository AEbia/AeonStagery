/**
 * AeonStagery — FFmpeg Video Export Module (Electron Main Process)
 *
 * Encodes pixel streams, muxes native bitstreams, and transcodes video with
 * timeline audio using bundled FFmpeg.
 */

import { BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { buildFFmpegConvertArgs, buildFFmpegStreamArgs } from './ffmpeg-args';
import type { FFmpegConvertOptions, FFmpegStreamOptions } from '../src/api/types/export';
import { classifyExportFailure } from '../src/api/exportEncoding';
import { ExportOutputTasks, type ExportOutput } from './export-output';

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
  promise: Promise<void>;
  cleanup: () => void;
}

interface StreamState {
  child: ChildProcessWithoutNullStreams;
  expectedFrameSize: number;
  endRequested: boolean;
  closed: boolean;
  failure?: string;
  stderr: string;
  pendingWrites: Set<PendingWrite>;
  drainWaiters: Set<() => void>;
  onDrain: () => void;
  completion: Promise<StreamCompletion>;
  resolveCompletion: (result: StreamCompletion) => void;
  completionSettled: boolean;
  output: ExportOutput;
  measureOnly?: boolean;
  closedPromise: Promise<void>;
  spaceMonitor?: ReturnType<typeof setInterval>;
  spaceCheck?: Promise<void>;
  publishPromise?: Promise<void>;
  ownerId?: number;
  detachOwner?: () => void;
  terminationRequested?: boolean;
  terminationTimer?: ReturnType<typeof setTimeout>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createStreamState(child: ChildProcessWithoutNullStreams, expectedFrameSize: number, output: ExportOutput): StreamState {
  let resolveCompletion!: (result: StreamCompletion) => void;
  const drainWaiters = new Set<() => void>();
  return {
    child,
    output,
    closedPromise: new Promise(resolve => child.once('close', () => resolve())),
    expectedFrameSize,
    stderr: '',
    endRequested: false,
    closed: false,
    pendingWrites: new Set(),
    drainWaiters,
    onDrain: () => { for (const onDrain of drainWaiters) onDrain(); },
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
  const error = streamFailure(state, state.failure);
  for (const pending of state.pendingWrites) {
    if (pending.settled) continue;
    pending.settled = true;
    pending.cleanup();
    pending.reject(error);
  }
  state.pendingWrites.clear();
}

function recordStreamFailure(state: StreamState, message: string, terminate = false): void {
  if (!state.failure) state.failure = message;
  rejectPendingWrites(state);
  if (terminate && !state.closed && !state.terminationRequested) {
    state.terminationRequested = true;
    try {
      // FFmpeg can remain blocked in a pipe read after SIGTERM. Close its
      // input as well, and bound graceful termination before deleting output.
      state.child.stdin?.destroy?.();
      state.child.kill();
    } catch {
      // The process may already have exited between the stream error and kill.
    }
    state.terminationTimer = setTimeout(() => {
      if (!state.closed) {
        try { state.child.kill('SIGKILL'); } catch { /* already exited */ }
      }
    }, 3000);
    state.terminationTimer.unref();
  }
  if (state.endRequested) {
    settleCompletion(state, { success: false, code: null, error: state.failure });
  }
}

function streamFailure(state: StreamState, fallback: string): Error {
  return new Error([state.failure || fallback, state.stderr].filter(Boolean).join('\n'));
}

function emitFFmpegLog(message: string): void {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send('ffmpeg:log', message);
  } catch {
    // Logging must not turn a completed/failed export into a second failure.
  }
}

function handleStreamClose(state: StreamState, code: number | null, signal?: string | null): void {
  state.closed = true;
  clearInterval(state.spaceMonitor);
  clearTimeout(state.terminationTimer);
  if (code !== 0 || signal) {
    const suffix = signal ? ` (${signal})` : '';
    recordStreamFailure(state, `FFmpeg stream exited with code ${code ?? 'unknown'}${suffix}`);
  } else if (!state.endRequested) {
    recordStreamFailure(state, 'FFmpeg stream exited before export completion');
  } else if (state.pendingWrites.size > 0) {
    recordStreamFailure(state, 'FFmpeg stream exited before pending writes completed');
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
  if (state.endRequested) return Promise.reject(new Error('FFmpeg stream is finishing'));
  const stdin = state.child.stdin;
  if (!stdin) return Promise.reject(new Error('FFmpeg stream stdin is unavailable'));

  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  const pending: PendingWrite = {
    settled: false, resolve, reject, promise,
    cleanup: () => {
      state.drainWaiters.delete(onDrain);
      if (state.drainWaiters.size === 0) stdin.removeListener('drain', state.onDrain);
    },
  };
  state.pendingWrites.add(pending);

  let writeReturned = false;
  let callbackCalled = false;
  let callbackError: Error | null | undefined;
  let needsDrain = false;
  let drained = false;
  const finish = (): void => {
    if (pending.settled || !writeReturned || !callbackCalled) return;
    if (callbackError) {
      const message = `${label} write error: ${errorText(callbackError)}`;
      console.error(`[${label}] ${message}`);
      recordStreamFailure(state, message, true);
      return;
    }
    if (needsDrain && !drained) return;
    pending.settled = true;
    pending.cleanup();
    state.pendingWrites.delete(pending);
    pending.resolve();
  };
  function onDrain(): void {
    drained = true;
    pending.cleanup();
    finish();
  }

  // Install before write so synchronous callbacks/drain cannot be missed.
  if (state.drainWaiters.size === 0) stdin.on('drain', state.onDrain);
  state.drainWaiters.add(onDrain);
  try {
    needsDrain = !stdin.write(buffer, (error?: Error | null) => {
      callbackCalled = true;
      callbackError = error;
      finish();
    });
    writeReturned = true;
    if (!needsDrain || pending.settled) pending.cleanup();
    finish();
  } catch (error) {
    recordStreamFailure(state, `${label} write error: ${errorText(error)}`, true);
  }
  return promise;
}

async function pushStreamChunk(state: StreamState, buffer: Buffer, label: string): Promise<void> {
  try { await writeStreamChunk(state, buffer, label); }
  catch (error) {
    // EPIPE can arrive before the encoder diagnostic. Preserve stderr through
    // process closure so an unavailable encoder remains eligible for fallback.
    await state.closedPromise;
    throw streamFailure(state, errorText(error));
  }
}

async function finishStream(state: StreamState): Promise<{ success: true; code: number | null }> {
  if (state.failure) throw streamFailure(state, 'FFmpeg stream failed');
  if (state.closed) throw new Error('FFmpeg stream closed before export completion');

  state.endRequested = true;
  await Promise.all([...state.pendingWrites].map((pending) => pending.promise));
  if (state.failure) throw streamFailure(state, 'FFmpeg stream failed');
  if (state.closed) throw new Error('FFmpeg stream closed before export completion');
  try {
    state.child.stdin.end();
  } catch (error) {
    const message = `FFmpeg stream end error: ${errorText(error)}`;
    recordStreamFailure(state, message, true);
    throw new Error(message);
  }

  const completion = await state.completion;
  if (!completion.success) throw streamFailure(state, completion.error || 'FFmpeg stream export failed');
  return { success: true, code: completion.code };
}

/**
 * Register all FFmpeg-related IPC handlers.
 */
export function registerFFmpegHandlers(): void {
  let encoderCapabilities: Promise<{ success: boolean; encoders: string[]; error?: string }> | undefined;
  ipcMain.handle('ffmpeg:getEncodingCapabilities', () => {
    encoderCapabilities ??= new Promise((resolve) => {
      execFile(ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) { encoderCapabilities = undefined; resolve({ success: false, encoders: [], error: error.message }); return; }
        const encoders = stdout.split('\n').flatMap((line) => {
          const match = /^\s*V[.A-Z]{5}\s+(\S+)/.exec(line);
          return match ? [match[1]] : [];
        });
        resolve({ success: true, encoders });
      });
    });
    return encoderCapabilities;
  });
  let activeStreamState: StreamState | null = null;
  const conversions = new Set<{ child: ChildProcessWithoutNullStreams; outputPath: string; cancelled: boolean; closed: Promise<void> }>();
  const outputTasks = new ExportOutputTasks();
  const recovery = outputTasks.recover().catch(error => console.error('[Export] Startup cleanup failed:', error));
  let starting: Promise<void> | undefined;
  let abortStart = false;
  let startingOwnerId: number | undefined;

  // Wait for process handles to close before removing incomplete output files.
  ipcMain.handle('ffmpeg:cancelExport', async (event) => {
    const ownerId = activeStreamState?.ownerId ?? startingOwnerId;
    if (ownerId !== undefined && event?.sender?.id !== ownerId) return { success: false, error: 'Export belongs to another window' };
    abortStart = true;
    if (starting) await starting;
    const state = activeStreamState;
    const runningConversions = [...conversions];
    if (state?.publishPromise) await state.publishPromise.catch(() => {});
    else if (state) {
      recordStreamFailure(state, 'Export cancelled', true);
    }
    for (const conversion of runningConversions) {
      conversion.cancelled = true;
      conversion.child.kill();
    }
    await Promise.all([state?.closedPromise, ...runningConversions.map((conversion) => conversion.closed)]);
    if (state) await state.output.cleanup();
    state?.detachOwner?.();
    if (activeStreamState === state) {
      activeStreamState = null;
    }
    const outputs = new Set([
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
    options: FFmpegConvertOptions = {}
  ) => {
    return new Promise((resolve) => {
      const args = buildFFmpegConvertArgs(inputPath, outputPath, options, fs.existsSync);

      console.log(`[FFmpeg] Converting: ${inputPath} → ${outputPath}`);
      console.log(`[FFmpeg] Args: ${args.join(' ')}`);

      let child: ChildProcessWithoutNullStreams;
      let stderrAccum = '';
      let settled = false;
      const finish = (result: { success: boolean; error?: string; stderr?: string; path?: string; failureKind?: 'encoder' | 'output' | 'process' }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        child = spawn(ffmpegPath, args);
      } catch (error) {
        const message = `FFmpeg process error: ${errorText(error)}`;
        console.error(`[FFmpeg Convert] ${message}`);
        finish({ success: false, error: message, stderr: stderrAccum, failureKind: classifyExportFailure(message + '\n' + stderrAccum) });
        return;
      }

      if (!child || typeof child.on !== 'function') {
        const message = 'FFmpeg process did not return an evented child process';
        console.error(`[FFmpeg Convert] ${message}`);
        finish({ success: false, error: message, stderr: stderrAccum, failureKind: classifyExportFailure(message + '\n' + stderrAccum) });
        return;
      }

      const conversion = {
        child, outputPath, cancelled: false,
        closed: new Promise<void>((resolveClosed) => child.once('close', resolveClosed)),
      };
      conversions.add(conversion);

      child.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString();
        stderrAccum = (stderrAccum + msg).slice(-16000);
        console.error(`[FFmpeg Convert] ${msg}`);
        emitFFmpegLog(msg);
      });

      child.stderr?.on('error', (error: unknown) => {
        const message = `FFmpeg stderr stream error: ${errorText(error)}`;
        console.error(`[FFmpeg Convert] ${message}`);
        finish({ success: false, error: message, stderr: stderrAccum, failureKind: classifyExportFailure(message + '\n' + stderrAccum) });
        try { child.kill(); } catch { /* process may already be closed */ }
      });

      child.on('error', (error: unknown) => {
        const message = `FFmpeg process error: ${errorText(error)}`;
        console.error(`[FFmpeg Convert] ${message}`);
        finish({ success: false, error: message, stderr: stderrAccum, failureKind: classifyExportFailure(message + '\n' + stderrAccum) });
      });

      child.on('close', (code: number | null, signal?: string | null) => {
        conversions.delete(conversion);
        if (conversion.cancelled) {
          finish({ success: false, error: 'Export cancelled' });
        } else if (code !== 0) {
          const suffix = signal ? ` (${signal})` : '';
          const message = `转码失败 (Code ${code ?? 'unknown'}${suffix})`;
          console.error(`[FFmpeg Convert] ${message}`);
          finish({ success: false, error: message, stderr: stderrAccum, failureKind: classifyExportFailure(message + '\n' + stderrAccum) });
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
        { name: 'MKV Video', extensions: ['mkv'] },
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
    await fs.promises.mkdir(tmpDir, { recursive: true });
    return tmpDir;
  });

  // ─── Deterministic Offline Rendering (Accelerated Export) ───

  ipcMain.handle('ffmpeg:startStreamExport', async (
    _event,
    outputPath: string,
    options: FFmpegStreamOptions = {}
  ) => {
    if (starting || activeStreamState) return { success: false, error: 'Another video export is active', failureKind: 'process' };
    let releaseStart!: () => void;
    starting = new Promise<void>(resolve => { releaseStart = resolve; });
    startingOwnerId = _event?.sender?.id;
    abortStart = false;
    const owner = _event?.sender;
    const onStartingOwnerGone = () => { abortStart = true; };
    owner?.once('destroyed', onStartingOwnerGone);
    owner?.once('render-process-gone', onStartingOwnerGone);
    try {
      await recovery;
      const { width = 1920, height = 1080 } = options;
      let output: ExportOutput;
      try { output = await outputTasks.create(outputPath, options); }
      catch (error) { return { success: false, error: errorText(error), failureKind: 'output' }; }
      if (abortStart) { await output.cleanup(); return { success: false, error: 'Export cancelled' }; }
      let args: string[];
      try {
        args = buildFFmpegStreamArgs(output.partialPath, options, fs.existsSync);
      } catch (error) {
        await output.cleanup();
        return { success: false, error: errorText(error), failureKind: classifyExportFailure(errorText(error)) };
      }

      console.log(`[FFmpeg Stream] Starting with args: ${args.join(' ')}`);

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(ffmpegPath, args);
      } catch (error) {
        const message = `FFmpeg process error: ${errorText(error)}`;
        console.error(`[FFmpeg Stream] ${message}`);
        await output.cleanup();
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
        await output.cleanup();
        return { success: false, error: message };
      }

      const state = createStreamState(child, width * height * 4, output);
      state.measureOnly = options.measureOnly === true;
      state.ownerId = _event?.sender?.id;
      activeStreamState = state;
      const onOwnerDestroyed = () => {
        if (!state.publishPromise) recordStreamFailure(state, 'Export window closed', true);
        void state.closedPromise.then(async () => {
          await state.publishPromise?.catch(() => {});
          await output.cleanup();
          state.detachOwner?.();
          if (activeStreamState === state) activeStreamState = null;
        });
      };
      owner?.once('destroyed', onOwnerDestroyed);
      owner?.once('render-process-gone', onOwnerDestroyed);
      state.detachOwner = () => {
        owner?.removeListener('destroyed', onOwnerDestroyed);
        owner?.removeListener('render-process-gone', onOwnerDestroyed);
      };

      child.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString();
        state.stderr = (state.stderr + msg).slice(-8000);
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
        if ((!state.endRequested || state.pendingWrites.size > 0) && !state.closed) {
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

      try { await output.recordChild(child.pid); }
      catch (error) { recordStreamFailure(state, `Output ownership record failed: ${errorText(error)}`, true); }
      if (abortStart) recordStreamFailure(state, 'Export cancelled', true);
      if (state.failure) {
        await state.closedPromise;
        await output.cleanup();
        state.detachOwner?.();
        if (activeStreamState === state) activeStreamState = null;
        return { success: false, error: state.failure, failureKind: classifyExportFailure(state.failure) };
      }
      state.spaceMonitor = setInterval(() => {
        if (state.closed || state.spaceCheck) return;
        state.spaceCheck = output.checkSpace().catch(error => {
          if (!state.closed) recordStreamFailure(state, `Output disk check failed: ${errorText(error)}`, true);
        }).finally(() => { state.spaceCheck = undefined; });
      }, 2000);
      state.spaceMonitor.unref();
      return { success: true };
    } finally {
      starting = undefined;
      startingOwnerId = undefined;
      owner?.removeListener('destroyed', onStartingOwnerGone);
      owner?.removeListener('render-process-gone', onStartingOwnerGone);
      releaseStart();
    }
  });

  // Handle compressed chunks from WebCodecs
  ipcMain.handle('ffmpeg:pushEncodedChunk', async (_event, chunkData: Uint8Array) => {
    if (!activeStreamState) throw new Error('No active FFmpeg process');
    if (activeStreamState.ownerId !== _event?.sender?.id) throw new Error('Export belongs to another window');
    const buffer = Buffer.from(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength);
    await pushStreamChunk(activeStreamState, buffer, 'FFmpeg Chunk');
    return { success: true };
  });

  ipcMain.handle('ffmpeg:pushFrame', async (_event, frameData: Uint8Array | Uint8ClampedArray) => {
    if (!activeStreamState) throw new Error('No active FFmpeg process');
    if (activeStreamState.ownerId !== _event?.sender?.id) throw new Error('Export belongs to another window');
    const buffer = Buffer.from(frameData.buffer, frameData.byteOffset, frameData.byteLength);

    if (buffer.length !== activeStreamState.expectedFrameSize) {
      const msg = `[FFmpeg] Buffer size mismatch! Expected ${activeStreamState.expectedFrameSize}, got ${buffer.length}`;
      console.error(msg);
      emitFFmpegLog(msg);
      recordStreamFailure(activeStreamState, 'Buffer size mismatch', true);
      throw new Error('Buffer size mismatch');
    }

    await pushStreamChunk(activeStreamState, buffer, 'FFmpeg');
    return { success: true };
  });

  ipcMain.handle('ffmpeg:endStreamExport', async (_event) => {
    const state = activeStreamState;
    if (!state) throw new Error('No active FFmpeg process');
    if (state.ownerId !== _event?.sender?.id) throw new Error('Export belongs to another window');

    try {
      const result = await finishStream(state);
      await state.spaceCheck;
      if (state.failure) throw streamFailure(state, 'FFmpeg stream failed');
      await state.output.checkSpace();
      if (state.failure) throw streamFailure(state, 'Export cancelled');
      if (state.measureOnly) {
        const stat = await fs.promises.stat(state.output.partialPath);
        if (state.failure) throw streamFailure(state, 'Export cancelled');
        return { ...result, sizeBytes: stat.size };
      }
      state.publishPromise = state.output.commit();
      await state.publishPromise;
      return result;
    } catch (error) {
      recordStreamFailure(state, errorText(error), true);
      throw streamFailure(state, errorText(error));
    } finally {
      await state.closedPromise;
      await state.output.cleanup();
      state.detachOwner?.();
      if (activeStreamState === state) activeStreamState = null;
    }
  });
}

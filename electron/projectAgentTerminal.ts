import { isUtf8 } from 'node:buffer';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type {
  AgentRunTerminalCommandArgs,
  AgentRunTerminalCommandResult,
  AgentTerminalShell,
} from '../src/api/types/project-agent';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 200_000;

export interface ProjectAgentTerminalSpawnSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly fallbackFile?: string;
}

export interface ProjectAgentTerminalExecutor {
  run(
    requestId: string,
    args: AgentRunTerminalCommandArgs,
  ): Promise<AgentRunTerminalCommandResult>;
  cancel(requestId: string): void;
}

function getIncompleteUtf8TailLength(buf: Buffer): number {
  const len = buf.length;
  if (len === 0) return 0;
  for (let i = 1; i <= Math.min(4, len); i++) {
    const byte = buf[len - i];
    if ((byte & 0x80) === 0) return 0;
    if ((byte & 0xc0) === 0xc0) {
      let expected = 0;
      if ((byte & 0xe0) === 0xc0) expected = 2;
      else if ((byte & 0xf0) === 0xe0) expected = 3;
      else if ((byte & 0xf8) === 0xf0) expected = 4;
      else return 0;
      return i < expected ? i : 0;
    }
  }
  return 0;
}

/**
 * Robust terminal output decoder. Automatically detects UTF-8 (including
 * boundary-truncated UTF-8) and falls back to GBK / GB18030 for Windows console output.
 */
export function decodeTerminalBuffer(buffer: Buffer): string {
  if (buffer.length === 0) return '';
  let validUtf8 = isUtf8(buffer);
  if (!validUtf8) {
    const tail = getIncompleteUtf8TailLength(buffer);
    if (tail > 0 && buffer.length > tail && isUtf8(buffer.subarray(0, buffer.length - tail))) {
      validUtf8 = true;
    }
  }

  if (validUtf8) {
    return new TextDecoder('utf-8').decode(buffer);
  }

  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

/**
 * Main-process terminal executor. Full-access is authorized by the IPC
 * handler, so this module intentionally does not restrict commands, paths,
 * environment variables, network access, or filesystem scope.
 */
export class NodeProjectAgentTerminalExecutor implements ProjectAgentTerminalExecutor {
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();

  async run(
    requestId: string,
    args: AgentRunTerminalCommandArgs,
  ): Promise<AgentRunTerminalCommandResult> {
    const timeoutMs = normalizePositiveInt(args.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxOutputChars = normalizePositiveInt(args.maxOutputChars, DEFAULT_OUTPUT_CHARS, MAX_OUTPUT_CHARS);
    const shell = resolveProjectAgentTerminalShell(args.shell);
    const spawnSpec = projectAgentTerminalSpawnSpec(shell, args.command);

    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(spawnSpec.file, spawnSpec.args, {
          cwd: args.cwd || undefined,
          windowsHide: true,
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
          },
        });
      } catch {
        resolve({
          shell,
          exitCode: null,
          stdout: '',
          stderr: 'Unable to start terminal command.',
          truncated: false,
          timedOut: false,
          cancelled: false,
        });
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      // Allow up to 4 bytes per character to safely bound buffer accumulation without OOM
      const maxOutputBytes = maxOutputChars * 4;

      const appendChunk = (
        chunks: Buffer[],
        currentBytes: number,
        chunk: Buffer,
      ): { bytes: number; truncated: boolean } => {
        if (currentBytes >= maxOutputBytes) {
          return { bytes: currentBytes, truncated: true };
        }
        const available = maxOutputBytes - currentBytes;
        if (chunk.length > available) {
          chunks.push(chunk.subarray(0, available));
          return { bytes: maxOutputBytes, truncated: true };
        }
        chunks.push(chunk);
        return { bytes: currentBytes + chunk.length, truncated: false };
      };

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.active.delete(requestId);

        const decodedStdout = decodeTerminalBuffer(Buffer.concat(stdoutChunks));
        const decodedStderr = decodeTerminalBuffer(Buffer.concat(stderrChunks));

        const isStdoutCharTruncated = decodedStdout.length > maxOutputChars;
        const isStderrCharTruncated = decodedStderr.length > maxOutputChars;

        const stdout = isStdoutCharTruncated ? decodedStdout.slice(0, maxOutputChars) : decodedStdout;
        const stderr = isStderrCharTruncated ? decodedStderr.slice(0, maxOutputChars) : decodedStderr;
        const truncated = stdoutTruncated || stderrTruncated || isStdoutCharTruncated || isStderrCharTruncated;

        resolve({ shell, exitCode, stdout, stderr, truncated, timedOut, cancelled });
      };

      const terminate = (reason: 'timeout' | 'cancel') => {
        if (reason === 'timeout') timedOut = true;
        else cancelled = true;
        if (!child.killed) {
          child.kill();
          const forceTimer = setTimeout(() => {
            if (!settled && !child.killed) child.kill('SIGKILL');
          }, 2_000);
          forceTimer.unref();
        }
      };

      const timeout = setTimeout(() => terminate('timeout'), timeoutMs);
      timeout.unref();

      const attach = (proc: ChildProcessWithoutNullStreams, canFallBack: boolean) => {
        child = proc;
        this.active.set(requestId, child);
        child.stdout.on('data', (chunk: Buffer) => {
          const res = appendChunk(stdoutChunks, stdoutBytes, chunk);
          stdoutBytes = res.bytes;
          if (res.truncated) stdoutTruncated = true;
        });
        child.stderr.on('data', (chunk: Buffer) => {
          const res = appendChunk(stderrChunks, stderrBytes, chunk);
          stderrBytes = res.bytes;
          if (res.truncated) stderrTruncated = true;
        });
        child.once('error', () => {
          if (canFallBack && spawnSpec.fallbackFile && !settled) {
            this.active.delete(requestId);
            try {
              attach(spawn(spawnSpec.fallbackFile, spawnSpec.args, {
                cwd: args.cwd || undefined,
                windowsHide: true,
                env: {
                  ...process.env,
                  PYTHONIOENCODING: 'utf-8',
                  PYTHONUTF8: '1',
                },
              }), false);
              return;
            } catch {
              // Fall through to the bounded startup error below.
            }
          }
          const errBuf = Buffer.from('Unable to start terminal command.');
          const res = appendChunk(stderrChunks, stderrBytes, errBuf);
          stderrBytes = res.bytes;
          if (res.truncated) stderrTruncated = true;
        });
        child.once('close', (code) => {
          if (proc === child) finish(code);
        });
      };
      attach(child, true);
    });
  }

  cancel(requestId: string): void {
    const child = this.active.get(requestId);
    if (child && !child.killed) child.kill();
  }
}

function normalizePositiveInt(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

/**
 * Windows full-access commands default to PowerShell so agents can use the
 * platform's current scripting syntax without opting in on every invocation.
 */
export function resolveProjectAgentTerminalShell(
  requested: AgentTerminalShell | undefined,
  platform = process.platform,
): AgentTerminalShell {
  return requested === 'powershell' || platform === 'win32' ? 'powershell' : 'default';
}

export function buildPowerShellEncodedScript(command: string): string {
  return [
    '$OutputEncoding = [Console]::OutputEncoding = [Console]::InputEncoding = (New-Object System.Text.UTF8Encoding $false);',
    'chcp 65001 >$null;',
    command,
    '',
    'if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }',
  ].join('\n');
}

export function projectAgentTerminalSpawnSpec(
  shell: AgentTerminalShell,
  command: string,
  platform = process.platform,
  comSpec = process.env.ComSpec,
): ProjectAgentTerminalSpawnSpec {
  if (shell === 'powershell') {
    const fullScript = buildPowerShellEncodedScript(command);
    const encodedCommand = Buffer.from(fullScript, 'utf16le').toString('base64');
    return {
      file: 'pwsh',
      ...(platform === 'win32' ? { fallbackFile: 'powershell.exe' } : {}),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
    };
  }
  return platform === 'win32'
    ? { file: comSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { file: process.env.SHELL || '/bin/sh', args: ['-lc', command] };
}

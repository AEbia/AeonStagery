import type { UpdateCheckResult, UpdateInfo } from 'electron-updater';
import type { UpdateSource, UpdateStatus } from '../src/api/types/updater';

export interface UpdateChannel {
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export function isUpdateNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; statusCode?: number; message?: string; cause?: unknown };
  if (candidate.statusCode && (candidate.statusCode >= 500 || [408, 429].includes(candidate.statusCode))) return true;
  const networkFailure = /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|ERR_CONNECTION_[A-Z_]+|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_TIMED_OUT)\b|Request timed out|response has been aborted by the server|socket hang up|(?:status|HttpError:)\s*(?:5\d\d|408|429)\b/i;
  return networkFailure.test(candidate.code ?? '') || networkFailure.test(candidate.message ?? '')
    || (candidate.cause !== error && isUpdateNetworkError(candidate.cause));
}

/** Serializes both channels so their shared NSIS cache and installer cannot race. */
export class UpdateCoordinator {
  private busy = false;
  private currentStatus: UpdateStatus = { state: 'idle', source: 'oss' };
  private checked: { source: UpdateSource; result: UpdateCheckResult } | null = null;
  private downloadedSource: UpdateSource | null = null;

  constructor(
    private readonly channels: Partial<Record<UpdateSource, UpdateChannel>>,
    private readonly onStatus: (status: UpdateStatus) => void,
  ) {
    if (!channels.oss && channels.github) this.currentStatus = { state: 'idle', source: 'github' };
    for (const source of ['oss', 'github'] as const) {
      const channel = channels[source];
      if (!channel) continue;
      channel.on('download-progress', (progress: { percent: number }) => {
        this.status({ state: 'downloading', source, percent: progress.percent });
      });
      // check/download errors are reported after deciding whether to fail over.
      channel.on('error', (error: Error) => {
        if (!this.busy) this.status({ state: 'error', source, message: error.message });
      });
    }
  }

  get sources(): UpdateSource[] {
    return (['oss', 'github'] as const).filter((source) => Boolean(this.channels[source]));
  }

  get snapshot(): UpdateStatus {
    return this.currentStatus;
  }

  private status(status: UpdateStatus): void {
    this.currentStatus = status;
    this.onStatus(status);
  }

  private channel(source: UpdateSource): UpdateChannel {
    const channel = this.channels[source];
    if (!channel) throw new Error(`${source === 'oss' ? '国内源' : '海外源'} 更新渠道不可用。`);
    return channel;
  }

  private async attemptCheck(source: UpdateSource, fallbackFrom?: UpdateSource): Promise<UpdateCheckResult> {
    this.status({ state: 'checking', source, fallbackFrom });
    const result = await this.channel(source).checkForUpdates();
    if (!result) throw new Error('当前环境不支持自动更新。');
    return result;
  }

  private alternate(source: UpdateSource, error: unknown): UpdateSource | null {
    const other = source === 'oss' ? 'github' : 'oss';
    return this.channels[other] && isUpdateNetworkError(error) ? other : null;
  }

  async checkForUpdates(source: UpdateSource = 'oss'): Promise<{ source: UpdateSource; result: UpdateCheckResult }> {
    if (this.busy) throw new Error('正在检查或下载更新，请稍候。');
    this.busy = true;
    this.checked = null;
    this.downloadedSource = null;
    try {
      let result: UpdateCheckResult;
      try {
        result = await this.attemptCheck(source);
      } catch (error) {
        const other = this.alternate(source, error);
        if (!other) throw error;
        const original = source;
        source = other;
        result = await this.attemptCheck(source, original);
      }
      this.checked = { source, result };
      this.status({ state: result.isUpdateAvailable ? 'available' : 'not-available', source,
        version: result.updateInfo.version, releaseDate: result.updateInfo.releaseDate, notes: result.updateInfo.releaseNotes });
      return { source, result };
    } catch (error) {
      this.checked = null;
      this.status({ state: 'error', source, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async downloadUpdate(): Promise<{ source: UpdateSource; files: string[] }> {
    if (this.busy) throw new Error('正在检查或下载更新，请稍候。');
    if (!this.checked?.result.isUpdateAvailable) throw new Error('请先检查更新。');
    this.busy = true;
    this.downloadedSource = null;
    let { source } = this.checked;
    const target: UpdateInfo = this.checked.result.updateInfo;
    try {
      this.status({ state: 'downloading', source, percent: 0 });
      let files: string[];
      try {
        files = await this.channel(source).downloadUpdate();
      } catch (error) {
        const other = this.alternate(source, error);
        if (!other) throw error;
        const original = source;
        source = other;
        const result = await this.attemptCheck(source, original);
        if (!result.isUpdateAvailable || result.updateInfo.version !== target.version) {
          throw new Error(`另一渠道尚未提供 ${target.version}，请稍后重试或手动安装。`);
        }
        this.checked = { source, result };
        this.status({ state: 'downloading', source, percent: 0 });
        files = await this.channel(source).downloadUpdate();
      }
      this.downloadedSource = source;
      this.status({ state: 'downloaded', source, version: target.version, releaseDate: target.releaseDate, notes: target.releaseNotes });
      return { source, files };
    } catch (error) {
      this.checked = null;
      this.status({ state: 'error', source, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  installUpdate(): void {
    if (this.busy || !this.downloadedSource) throw new Error('请先完成更新下载。');
    this.channel(this.downloadedSource).quitAndInstall(false, true);
  }
}

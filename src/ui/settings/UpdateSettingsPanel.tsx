import { useEffect, useState } from 'react';
import type { UpdateSource, UpdateStatus } from '../../api/types/updater';
import { FormSelect } from '../FormSelect';
import { InfoTip } from '../Tooltip';

const sourceLabels: Record<UpdateSource, string> = { oss: '国内源', github: '海外源' };
const sourceOptions = [
  { value: 'oss', label: '国内源（增量下载）' },
  { value: 'github', label: '海外源（增量下载）' },
] as const;

function statusMessage(status: UpdateStatus): string {
  const source = sourceLabels[status.source];
  switch (status.state) {
    case 'checking': return status.fallbackFrom
      ? `${sourceLabels[status.fallbackFrom]} 连接失败，正在尝试 ${source}…`
      : `正在通过 ${source} 检查更新…`;
    case 'available': return `${source} 发现新版本 ${status.version}`;
    case 'not-available': return '当前已经是最新版本。';
    case 'downloading': return `正在从 ${source} 下载更新 ${Math.round(status.percent ?? 0)}%`;
    case 'downloaded': return `更新已下载完成：${status.version}，可以重启安装。`;
    case 'error': return status.message || '更新失败，请重试或手动下载安装。';
    default: return '尚未检查更新';
  }
}

export function UpdateSettingsPanel() {
  const [enabled, setEnabled] = useState(false);
  const [sources, setSources] = useState<UpdateSource[]>(['oss', 'github']);
  const [source, setSource] = useState<UpdateSource>('oss');
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle', source: 'oss' });
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    let receivedStatus = false;
    const unsubscribe = window.aeonStageryAPI.updater.onStatus((next) => {
      receivedStatus = true;
      setStatus(next);
      if (next.source) setSource(next.source);
      setMessage(statusMessage(next));
      if (next.state === 'available' || next.state === 'downloaded') setVersion(next.version ?? null);
      if (next.state === 'not-available' || next.state === 'error') setVersion(null);
    });
    void window.aeonStageryAPI.updater.getState().then((state) => {
      if (!mounted) return;
      setEnabled(state.enabled);
      if (state.sources) setSources(state.sources);
      // A late initial snapshot must not overwrite an event from an active download.
      if (!receivedStatus) {
        const next: UpdateStatus = { state: state.state ?? 'idle', source: state.source ?? 'oss', ...state };
        setSource(next.source);
        setStatus(next);
        setMessage(statusMessage(next));
        if (next.state === 'available' || next.state === 'downloaded') setVersion(next.version ?? null);
      }
    }).catch(() => {
      if (mounted) setMessage('无法读取更新状态，请重新打开设置。');
    });
    return () => { mounted = false; unsubscribe(); };
  }, []);

  const isBusy = busy || status.state === 'checking' || status.state === 'downloading';
  const fail = (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    setStatus({ state: 'error', source, message: text });
    setMessage(text);
    setVersion(null);
  };

  const check = async () => {
    setBusy(true);
    setVersion(null);
    setStatus({ state: 'checking', source });
    setMessage(`正在通过 ${sourceLabels[source]} 检查更新…`);
    try {
      const result = await window.aeonStageryAPI.updater.checkForUpdates(source);
      if (!result.success) throw new Error(result.error || '检查更新失败');
      const next: UpdateStatus = { state: result.updateAvailable ? 'available' : 'not-available',
        source: result.source ?? source, version: result.version ?? undefined,
        releaseDate: result.releaseDate ?? undefined, notes: result.notes };
      setSource(next.source);
      setStatus(next);
      setVersion(result.updateAvailable ? result.version ?? null : null);
      setMessage(statusMessage(next));
    } catch (error) { fail(error); } finally { setBusy(false); }
  };

  const download = async () => {
    setBusy(true);
    setStatus({ state: 'downloading', source, percent: 0 });
    setMessage(`开始从 ${sourceLabels[source]} 下载更新…`);
    try {
      const result = await window.aeonStageryAPI.updater.downloadUpdate();
      if (!result.success) throw new Error(result.error || '下载更新失败');
      const next: UpdateStatus = { state: 'downloaded', source: result.source ?? source, version: version ?? undefined };
      setSource(next.source);
      setStatus(next);
      setMessage(statusMessage(next));
    } catch (error) { fail(error); } finally { setBusy(false); }
  };

  const install = async () => {
    setBusy(true);
    try {
      const result = await window.aeonStageryAPI.updater.installUpdate();
      if (!result.success) throw new Error(result.error || '安装更新失败');
    } catch (error) { fail(error); } finally { setBusy(false); }
  };

  return (
    <div className="settings-dialog__card settings-dialog__about-update">
      <div className="settings-dialog__field-label">
        软件更新
        <InfoTip
          title="更新渠道说明"
          content="国内源为国内 OSS 直连更新源，海外源为 GitHub Releases，两者都只做增量下载。海外源缺少块图或 SHA-512 文件时会从国内源补取同版本文件；两边都缺少时需手动下载安装。连接失败会自动尝试另一个渠道。"
        />
      </div>
      <FormSelect aria-label="更新渠道" value={source}
        options={sourceOptions.filter((option) => sources.includes(option.value))}
        disabled={isBusy || !enabled}
        onChange={(value) => {
          setSource(value as UpdateSource);
          setStatus({ state: 'idle', source: value as UpdateSource });
          setVersion(null);
          setMessage('已切换更新渠道，请检查更新。');
        }}
      />
      <div role="status" aria-live="polite" className="settings-dialog__update-status">
        {enabled ? message || statusMessage(status) : '当前环境未启用自动更新。'}
      </div>
      <div className="settings-dialog__actions">
        <button className="btn" onClick={check} disabled={isBusy || !enabled}>
          {status.state === 'checking' ? '检查中…' : '检查更新'}
        </button>
        <button className="btn" onClick={download} disabled={!version || isBusy || !enabled || status.state === 'downloaded'}>
          {status.state === 'downloading' ? '下载中…' : '下载增量更新'}
        </button>
        <button className="btn" onClick={install} disabled={status.state !== 'downloaded' || isBusy}>
          立即重启安装
        </button>
      </div>
      {status.releaseDate && (
        <div className="settings-dialog__update-date">发布日期：{new Date(status.releaseDate).toLocaleString()}</div>
      )}
    </div>
  );
}

import React from 'react';
import { useCollaborationPresence, useCollaborationStatus, usePlaybackAdapter } from './context/AppContext';
import { IconClock, IconLayers, IconActivity, IconUsers, IconError, IconWarning } from './icons';
import { eventBus } from '../api/events';
import { deriveCollaborationStatusUx } from '../services/collaboration/CollaborationStatusUxModel';
import { Tooltip } from './Tooltip';
import {
  useDocumentTitle,
  useEditorPixelsPerSecond,
  useEditorSaveStatus,
  usePlaybackSummary,
  useSelectedActionCount,
  useValidationSummary,
} from './store/storeHooks';

const pad2 = (n: number) => (n < 10 ? '0' + n : '' + n);

const formatTime = (t: number) => {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 100);
  return pad2(m) + ':' + pad2(s) + '.' + pad2(ms);
};

export const StatusBar = () => {
  const playbackAdapter = usePlaybackAdapter();
  const timeRef = React.useRef<HTMLSpanElement>(null);
  const initialTime = playbackAdapter.getCurrentTime();

  const title = useDocumentTitle();
  const { errorsCount, warningsCount } = useValidationSummary();
  const { saveStatus } = useEditorSaveStatus();
  const pixelsPerSecond = useEditorPixelsPerSecond();
  const selectedActionCount = useSelectedActionCount();
  const { engineStatus, duration } = usePlaybackSummary();
  const collaborationStatus = useCollaborationStatus();
  const { self: collaborationSelf, peers: collaborationPeers } = useCollaborationPresence();
  const collaborationStatusUx = React.useMemo(() => deriveCollaborationStatusUx({
    status: collaborationStatus,
    self: collaborationSelf,
    peers: collaborationPeers,
  }), [collaborationPeers, collaborationSelf, collaborationStatus]);
  const collaborationTooltip = React.useMemo(() => {
    const names = [
      collaborationSelf ? `${collaborationSelf.displayName || collaborationSelf.clientId}（你）` : null,
      ...collaborationPeers.map((peer) => peer.displayName || peer.clientId),
    ].filter(Boolean);
    const suffix = names.length > 0 ? ` · ${names.join('、')}` : '';
    return `${collaborationStatusUx.tooltip}${suffix}`;
  }, [collaborationPeers, collaborationSelf, collaborationStatusUx.tooltip]);

  const [bakeStatus, setBakeStatus] = React.useState<'idle' | 'baking' | 'complete' | 'cancelled'>('idle');
  const [bakeProgress, setBakeProgress] = React.useState(0);

  React.useEffect(() => {
    let lastUpdate = 0;
    let lastTimeStr = '';
    const unsubTime = playbackAdapter.subscribeTime((time: number) => {
      const now = Date.now();
      const isLowPerf = document.documentElement.getAttribute('data-perf') === 'low';
      const throttleMs = isLowPerf ? 100 : 33;
      if (now - lastUpdate > throttleMs) {
        if (timeRef.current) {
          const timeStr = formatTime(time);
          if (timeStr !== lastTimeStr) {
            timeRef.current.textContent = timeStr;
            lastTimeStr = timeStr;
          }
        }
        lastUpdate = now;
      }
    });

    let timer: any = null;

    const unsubStart = eventBus.on('pb-daemon:start', () => {
      if (timer) clearTimeout(timer);
      setBakeStatus('baking');
      setBakeProgress(1);
    });
    const unsubProgress = eventBus.on('pb-daemon:progress', (payload: any) => {
      if (timer) clearTimeout(timer);
      setBakeStatus('baking');
      setBakeProgress(Math.round(payload.progress * 100));
    });
    const unsubComplete = eventBus.on('pb-daemon:complete', () => {
      if (timer) clearTimeout(timer);
      setBakeStatus('complete');
      setBakeProgress(100);
      timer = setTimeout(() => {
        setBakeStatus('idle');
        setBakeProgress(0);
      }, 2000);
    });
    const unsubCancel = eventBus.on('pb-daemon:cancel', () => {
      if (timer) clearTimeout(timer);
      setBakeStatus('cancelled');
      timer = setTimeout(() => {
        setBakeStatus('idle');
        setBakeProgress(0);
      }, 1000);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubTime();
      unsubStart();
      unsubProgress();
      unsubComplete();
      unsubCancel();
    };
  }, [playbackAdapter]);

  const saveLabel = () => {
    switch (saveStatus) {
      case 'saving': return '保存中...';
      case 'dirty': return '未保存';
      case 'error': return '保存失败';
      default: return '已保存';
    }
  };

  return (
    <div className="status-bar">
      <div className="status-bar__item">
        <div className={`status-dot status-dot--${saveStatus}`} />
        <span className="status-bar__project-name">{title || '未命名剧本'}</span>
        <span className="status-bar__divider">·</span>
        <span className={`status-bar__save-text status-bar__save-text--${saveStatus}`}>
          {saveLabel()}
        </span>
        <span className="status-bar__divider">·</span>
        <span className="status-bar__engine-status">{engineStatus}</span>

        {(errorsCount > 0 || warningsCount > 0) && (
          <>
            <span className="status-bar__divider">·</span>
            <Tooltip
              title="剧本诊断"
              content={`${errorsCount > 0 ? `${errorsCount} 个错误` : ''}${warningsCount > 0 ? ` ${warningsCount} 个警告` : ''}。点击打开剧本诊断面板。`}
            >
              <button
                type="button"
                className={`status-bar__validation-badge ${errorsCount > 0 ? 'is-error' : 'is-warning'}`}
                onClick={() => eventBus.emit('ui:openDiagnostics')}
                aria-label="打开剧本诊断面板"
              >
                {errorsCount > 0 && (
                  <span className="status-bar__validation-count status-bar__validation-count--error">
                    <IconError width={11} height={11} /> {errorsCount}
                  </span>
                )}
                {warningsCount > 0 && (
                  <span className="status-bar__validation-count status-bar__validation-count--warning">
                    <IconWarning width={11} height={11} /> {warningsCount}
                  </span>
                )}
              </button>
            </Tooltip>
          </>
        )}
      </div>

      <div className="status-bar__center">
        <Tooltip title="时间码" content="当前播放时间 / 场景总时长">
          <div className="status-bar__stat">
            <IconClock width={11} height={11} />
            <span ref={timeRef} className="status-bar__value tabular-nums">{formatTime(initialTime)}</span>
            <span className="status-bar__separator">/</span>
            <span className="status-bar__total tabular-nums">{formatTime(duration)}</span>
          </div>
        </Tooltip>

        <Tooltip title="时间轴缩放级别" content="当前时间轴像素缩放比例">
          <div className="status-bar__stat">
            <IconActivity width={11} height={11} />
            <span className="status-bar__value tabular-nums">{Math.round((pixelsPerSecond / 50) * 100)}%</span>
          </div>
        </Tooltip>

        <Tooltip title="选中动作数量" content="当前时间轴或检查器中选中的动作总数">
          <div className="status-bar__stat">
            <IconLayers width={11} height={11} />
            <span className="status-bar__value tabular-nums">{selectedActionCount}</span>
            <span className="status-bar__label">选中</span>
          </div>
        </Tooltip>
      </div>

      <div className="status-bar__item status-bar__item--right">
        {collaborationStatus !== 'disconnected' && (
          <Tooltip title="协作状态" content={collaborationTooltip}>
            <div className={`status-bar__collaboration status-bar__collaboration--${collaborationStatus}`} title={collaborationTooltip}>
              <IconUsers width={11} height={11} />
              <span>{collaborationStatusUx.footerLabel}</span>
            </div>
          </Tooltip>
        )}
        {bakeStatus !== 'idle' && (
          <div className={`status-bar__bake status-bar__bake--${bakeStatus}`}>
            {bakeStatus === 'baking' && <div className="spinner-mini" />}
            <span className="tabular-nums">
              {bakeStatus === 'baking' && `后台烘焙 ${bakeProgress}%`}
              {bakeStatus === 'complete' && '后台烘焙完成'}
              {bakeStatus === 'cancelled' && '后台烘焙中止'}
            </span>
          </div>
        )}
        <Tooltip title="场景画布规格" content="标准演出渲染分辨率与帧率">
          <span className="status-bar__spec tabular-nums">1920×1080 · 60fps</span>
        </Tooltip>
      </div>
    </div>
  );
};

export default StatusBar;

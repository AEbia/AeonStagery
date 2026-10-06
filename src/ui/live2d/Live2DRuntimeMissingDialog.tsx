import React, { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Live2DRuntimeStatusReport } from '../../api/types/live2dRuntime';
import {
  CUBISM2_CONFIG,
  CUBISM3_PLUS_CONFIG,
  openLive2DDirectory,
  openExternalLink,
  refreshLive2DRuntimeStatus,
} from '../../services/live2d/live2dRuntimeDetection';
import { useModalDialog } from '../hooks/useModalDialog';
import {
  IconX,
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconFolder,
  IconRefresh,
} from '../icons';
import { showToast } from '../Toast';
import './live2dRuntimeDialog.css';

const LIVE2D_OPEN_LICENSE_URL = 'https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html';
const LIVE2D_PROPRIETARY_LICENSE_URL = 'https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html';

export interface Live2DRuntimeMissingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onNeverRemind?: () => void;
  report?: Live2DRuntimeStatusReport | null;
  onRefresh?: () => Promise<Live2DRuntimeStatusReport | null>;
}

export const Live2DRuntimeMissingDialog: React.FC<Live2DRuntimeMissingDialogProps> = ({
  isOpen,
  onClose,
  onNeverRemind,
  report: initialReport,
  onRefresh,
}) => {
  const dialogRef = useModalDialog(onClose, isOpen);
  const [report, setReport] = useState<Live2DRuntimeStatusReport | null>(initialReport ?? null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const isElectron = typeof window !== 'undefined' && !!window.aeonStageryAPI;

  useEffect(() => {
    if (initialReport) {
      setReport(initialReport);
    }
  }, [initialReport]);

  const handleCopy = useCallback(async (text: string, label: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        showToast(`已复制 ${label} 到剪贴板`, 'info');
      }
    } catch {
      showToast('复制失败，请手动复制', 'warning');
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const refreshed = onRefresh
        ? await onRefresh()
        : await refreshLive2DRuntimeStatus();
      if (refreshed) {
        const hasNewRuntime = (refreshed.cubism2 && !report?.cubism2)
          || (refreshed.cubism3Plus && !report?.cubism3Plus);
        setReport(refreshed);
        setRestartRequired((required) => required || hasNewRuntime || !refreshed.missingAny);
        if (hasNewRuntime || !refreshed.missingAny) {
          showToast(`运行时文件已就绪，${isElectron ? '重启应用' : '刷新页面'}后即可加载。`, 'info');
        } else {
          showToast('检测完成，仍有部分运行时缺失', 'info');
        }
      }
    } catch (err) {
      console.error('[Live2DRuntimeMissingDialog] Refresh failed:', err);
      showToast('检测运行时状态失败', 'warning');
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh, report, isElectron]);

  const handleRestart = useCallback(async () => {
    if (typeof window === 'undefined') return;
    const confirmed = window.confirm(`运行时文件已就绪，需要重新加载应用才能生效。是否现在${isElectron ? '重启' : '刷新页面'}？`);
    if (!confirmed) return;

    try {
      const restart = window.aeonStageryAPI?.app?.restart;
      if (typeof restart === 'function') {
        const result = await restart();
        if (!result.success) {
          showToast('重启应用失败，请手动重启。', 'warning');
        }
      } else {
        window.location.reload();
      }
    } catch (err) {
      console.error('[Live2DRuntimeMissingDialog] Restart failed:', err);
      showToast('重启应用失败，请手动重启。', 'warning');
    }
  }, [isElectron]);

  const handleOpenRuntimeDir = useCallback(async () => {
    const success = await openLive2DDirectory('runtime');
    if (success) {
      showToast('已在资源管理器中打开运行时目录', 'info');
    } else {
      showToast('未能打开目录，请查看目标路径手动打开', 'warning');
    }
  }, []);

  if (!isOpen) return null;

  const cubism2Available = report ? report.cubism2 : false;
  const cubism3PlusAvailable = report ? report.cubism3Plus : false;
  const allReady = cubism2Available && cubism3PlusAvailable;

  const targetDisplayPath = report?.paths?.runtimeRoot
    || (isElectron ? '%APPDATA%\\AeonStagery\\live2d-runtime' : 'public');

  return createPortal(
    <div
      ref={dialogRef}
      className="live2d-runtime-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="live2d-runtime-dialog-title"
    >
      <div className="live2d-runtime-dialog__surface">
        <div className="live2d-runtime-dialog__header">
          <div className="live2d-runtime-dialog__header-text">
            <div id="live2d-runtime-dialog-title" className="live2d-runtime-dialog__title">
              Live2D 运行时配置引导
            </div>
            <div className="live2d-runtime-dialog__subtitle">
              受Live2d官方版权许可限制，本软件不随附 Live2D 运行时。下载前请阅读
              <button
                type="button"
                className="live2d-runtime-dialog__terms-link"
                onClick={() => void openExternalLink(LIVE2D_OPEN_LICENSE_URL)}
              >
                开放软件许可
              </button>
              和
              <button
                type="button"
                className="live2d-runtime-dialog__terms-link"
                onClick={() => void openExternalLink(LIVE2D_PROPRIETARY_LICENSE_URL)}
              >
                专有软件许可
              </button>
              ，确认适用条款后再下载和使用。
            </div>
          </div>
          <button
            className="live2d-runtime-dialog__close"
            onClick={onClose}
            title="关闭引导"
            aria-label="关闭引导"
          >
            <IconX width={16} height={16} />
          </button>
        </div>

        <div className="live2d-runtime-dialog__body">
          {/* Target Folder Quick Action Bar */}
          <div className="live2d-target-folder-bar">
            <div className="live2d-target-folder-bar__info">
              <span className="live2d-target-folder-bar__label">运行时存放目录</span>
              <span className="live2d-target-folder-bar__path" title={targetDisplayPath}>
                {targetDisplayPath}
              </span>
            </div>
            <div className="live2d-target-folder-bar__actions">
              {isElectron && (
                <button
                  type="button"
                  className="live2d-btn live2d-btn--folder"
                  onClick={() => void handleOpenRuntimeDir()}
                  title="在文件管理器中打开此目录"
                >
                  <IconFolder width={14} height={14} />
                  打开运行时目录
                </button>
              )}
              <button
                type="button"
                className="live2d-btn"
                onClick={() => void handleCopy(targetDisplayPath, '运行时路径')}
                title="复制目录路径"
              >
                <IconCopy width={13} height={13} />
                复制路径
              </button>
            </div>
          </div>

          {/* Steps */}
          <div className="live2d-runtime-steps">
            <div className="live2d-runtime-steps__title">操作步骤：</div>
            <div className="live2d-runtime-steps__list">
              <div className="live2d-runtime-step-item">
                <span className="live2d-runtime-step-item__num">1</span>
                <span className="live2d-runtime-step-item__text">
                  点击下方对应版本的<strong>【下载】</strong>按钮获取核心脚本。若浏览器显示脚本文本，请按 <strong>Ctrl+S</strong>，若已自动下载可跳过，并保留原文件名。
                </span>
              </div>
              <div className="live2d-runtime-step-item">
                <span className="live2d-runtime-step-item__num">2</span>
                <span className="live2d-runtime-step-item__text">
                  {isElectron ? (
                    <>点击上方<strong>【打开运行时目录】</strong>按钮，将下载的 <strong>live2d.min.js</strong> 或 <strong>live2dcubismcore.min.js</strong> 直接拖入打开的文件夹中。</>
                  ) : (
                    <>将下载的 <strong>live2d.min.js</strong> 或 <strong>live2dcubismcore.min.js</strong> 直接放入项目根目录下的 <strong>public</strong> 文件夹。</>
                  )}
                </span>
              </div>
              <div className="live2d-runtime-step-item">
                <span className="live2d-runtime-step-item__num">3</span>
                <span className="live2d-runtime-step-item__text">
                  放置完成后，点击右下角<strong>【重新检测】</strong>；检测到所需运行时后{isElectron ? '重启应用' : '刷新页面'}以加载运行时。
                </span>
              </div>
            </div>
          </div>

          {/* Cards for each runtime version */}
          <div className="live2d-runtime-cards">
            {/* Cubism 2.1 Card */}
            <div
              className={`live2d-runtime-card ${cubism2Available ? 'live2d-runtime-card--ready' : 'live2d-runtime-card--missing'
                }`}
            >
              <div className="live2d-runtime-card__top">
                <div className="live2d-runtime-card__title-row">
                  <span className="live2d-runtime-card__title">{CUBISM2_CONFIG.title}</span>
                  <span className="live2d-runtime-card__filename">{CUBISM2_CONFIG.fileName}</span>
                </div>
                <span
                  className={`live2d-status-pill ${cubism2Available ? 'live2d-status-pill--ready' : 'live2d-status-pill--missing'
                    }`}
                >
                  {cubism2Available ? (
                    <>
                      <IconCheck width={12} height={12} /> 已就绪
                    </>
                  ) : (
                    '缺失'
                  )}
                </span>
              </div>

              <div className="live2d-runtime-card__desc">{CUBISM2_CONFIG.description}</div>

              <div className="live2d-runtime-card__actions">
                <button
                  type="button"
                  className="live2d-btn"
                  onClick={() => void openExternalLink(CUBISM2_CONFIG.downloadUrl)}
                  title="通过 CDN 高速下载 live2d.min.js"
                >
                  <IconExternalLink width={13} height={13} />
                  下载 live2d.min.js
                </button>
                {CUBISM2_CONFIG.downloadMirrorUrl && (
                  <button
                    type="button"
                    className="live2d-btn live2d-btn--ghost"
                    onClick={() => void openExternalLink(CUBISM2_CONFIG.downloadMirrorUrl!)}
                    title="备用下载地址"
                  >
                    <IconExternalLink width={13} height={13} />
                    GitHub 备用源
                  </button>
                )}
                <button
                  type="button"
                  className="live2d-btn live2d-btn--ghost"
                  onClick={() => void handleCopy(CUBISM2_CONFIG.downloadUrl, '下载地址')}
                  title="复制直接下载链接"
                >
                  <IconCopy width={12} height={12} />
                  复制下载链接
                </button>
              </div>
            </div>

            {/* Cubism 3/4/5 Card */}
            <div
              className={`live2d-runtime-card ${cubism3PlusAvailable ? 'live2d-runtime-card--ready' : 'live2d-runtime-card--missing'
                }`}
            >
              <div className="live2d-runtime-card__top">
                <div className="live2d-runtime-card__title-row">
                  <span className="live2d-runtime-card__title">{CUBISM3_PLUS_CONFIG.title}</span>
                  <span className="live2d-runtime-card__filename">{CUBISM3_PLUS_CONFIG.fileName}</span>
                </div>
                <span
                  className={`live2d-status-pill ${cubism3PlusAvailable ? 'live2d-status-pill--ready' : 'live2d-status-pill--missing'
                    }`}
                >
                  {cubism3PlusAvailable ? (
                    <>
                      <IconCheck width={12} height={12} /> 已就绪
                    </>
                  ) : (
                    '缺失'
                  )}
                </span>
              </div>

              <div className="live2d-runtime-card__desc">{CUBISM3_PLUS_CONFIG.description}</div>

              <div className="live2d-runtime-card__actions">
                <button
                  type="button"
                  className="live2d-btn"
                  onClick={() => void openExternalLink(CUBISM3_PLUS_CONFIG.downloadUrl)}
                  title="通过官方直链直接下载 live2dcubismcore.min.js"
                >
                  <IconExternalLink width={13} height={13} />
                  直链下载 live2dcubismcore.min.js
                </button>
                {CUBISM3_PLUS_CONFIG.officialSiteUrl && (
                  <button
                    type="button"
                    className="live2d-btn live2d-btn--ghost"
                    onClick={() => void openExternalLink(CUBISM3_PLUS_CONFIG.officialSiteUrl!)}
                    title="Live2D 官方 Web SDK 官网下载页"
                  >
                    <IconExternalLink width={13} height={13} />
                    官方 SDK 下载页
                  </button>
                )}
                <button
                  type="button"
                  className="live2d-btn live2d-btn--ghost"
                  onClick={() => void handleCopy(CUBISM3_PLUS_CONFIG.downloadUrl, '下载地址')}
                  title="复制直接下载链接"
                >
                  <IconCopy width={12} height={12} />
                  复制下载链接
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="live2d-runtime-dialog__footer">
          <div className="live2d-runtime-dialog__footer-left">
            {isElectron && (
              <button
                type="button"
                className="live2d-btn live2d-btn--ghost"
                onClick={() => void handleOpenRuntimeDir()}
                title="打开目标文件夹"
              >
                <IconFolder width={14} height={14} />
                打开存放文件夹
              </button>
            )}
            {!allReady && onNeverRemind && (
              <button
                type="button"
                className="live2d-btn live2d-btn--ghost"
                onClick={() => {
                  onNeverRemind();
                  showToast('已关闭 Live2D 运行时启动提醒，可在设置中重新开启。', 'info');
                }}
              >
                不再提醒
              </button>
            )}
          </div>

          <div className="live2d-runtime-dialog__footer-right">
            <button
              type="button"
              className="live2d-btn"
              onClick={() => void handleRefresh()}
              disabled={isRefreshing}
            >
              <IconRefresh
                width={14}
                height={14}
                className={isRefreshing ? 'live2d-spin' : undefined}
              />
              {isRefreshing ? '检测中...' : '重新检测'}
            </button>
            {restartRequired ? (
              <>
                <button type="button" className="live2d-btn" onClick={onClose}>
                  {isElectron ? '稍后重启' : '稍后刷新'}
                </button>
                <button
                  type="button"
                  className="live2d-btn live2d-btn--primary"
                  onClick={() => void handleRestart()}
                >
                  {isElectron ? '重启应用以加载' : '刷新页面以加载'}
                </button>
              </>
            ) : (
              <button
                type="button"
                className={`live2d-btn ${allReady ? 'live2d-btn--primary' : ''}`}
                onClick={onClose}
              >
                {allReady ? '配置完成，进入' : '我知道了 / 稍后配置'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

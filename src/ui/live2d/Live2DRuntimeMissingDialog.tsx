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

export interface Live2DRuntimeMissingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  report?: Live2DRuntimeStatusReport | null;
  onRefresh?: () => Promise<Live2DRuntimeStatusReport | null>;
}

export const Live2DRuntimeMissingDialog: React.FC<Live2DRuntimeMissingDialogProps> = ({
  isOpen,
  onClose,
  report: initialReport,
  onRefresh,
}) => {
  const dialogRef = useModalDialog(onClose, isOpen);
  const [report, setReport] = useState<Live2DRuntimeStatusReport | null>(initialReport ?? null);
  const [isRefreshing, setIsRefreshing] = useState(false);
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
        setReport(refreshed);
        if (!refreshed.missingAny) {
          showToast('所有 Live2D 运行时均已就绪！', 'info');
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
  }, [onRefresh]);

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

  const targetDisplayPath = report?.paths?.runtimeRoot || '%APPDATA%\\AeonStagery\\live2d-runtime';

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
              受官方版权许可限制，本软件不随附 Live2D 运行时。请下载核心脚本放入指定目录后使用。
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
              <span className="live2d-target-folder-bar__label">Windows 运行时存放目录</span>
              <span className="live2d-target-folder-bar__path" title={targetDisplayPath}>
                {targetDisplayPath}
              </span>
            </div>
            <div className="live2d-target-folder-bar__actions">
              {isElectron && (
                <button
                  type="button"
                  className="live2d-btn live2d-btn--primary"
                  onClick={() => void handleOpenRuntimeDir()}
                  title="在 Windows 资源管理器中打开此文件夹"
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
                  点击下方对应版本的<strong>【下载】</strong>按钮获取缺失的核心脚本。
                </span>
              </div>
              <div className="live2d-runtime-step-item">
                <span className="live2d-runtime-step-item__num">2</span>
                <span className="live2d-runtime-step-item__text">
                  点击上方<strong>【打开运行时目录】</strong>按钮，将下载的 <strong>live2d.min.js</strong> 或 <strong>live2dcubismcore.min.js</strong> 直接拖入打开的文件夹中。
                </span>
              </div>
              <div className="live2d-runtime-step-item">
                <span className="live2d-runtime-step-item__num">3</span>
                <span className="live2d-runtime-step-item__text">
                  放置完成后，点击右下角<strong>【重新检测】</strong>即可生效。
                </span>
              </div>
            </div>
          </div>

          {/* Cards for each runtime version */}
          <div className="live2d-runtime-cards">
            {/* Cubism 2.1 Card */}
            <div
              className={`live2d-runtime-card ${
                cubism2Available ? 'live2d-runtime-card--ready' : 'live2d-runtime-card--missing'
              }`}
            >
              <div className="live2d-runtime-card__top">
                <div className="live2d-runtime-card__title-row">
                  <span className="live2d-runtime-card__title">{CUBISM2_CONFIG.title}</span>
                  <span className="live2d-runtime-card__filename">{CUBISM2_CONFIG.fileName}</span>
                </div>
                <span
                  className={`live2d-status-pill ${
                    cubism2Available ? 'live2d-status-pill--ready' : 'live2d-status-pill--missing'
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
              className={`live2d-runtime-card ${
                cubism3PlusAvailable ? 'live2d-runtime-card--ready' : 'live2d-runtime-card--missing'
              }`}
            >
              <div className="live2d-runtime-card__top">
                <div className="live2d-runtime-card__title-row">
                  <span className="live2d-runtime-card__title">{CUBISM3_PLUS_CONFIG.title}</span>
                  <span className="live2d-runtime-card__filename">{CUBISM3_PLUS_CONFIG.fileName}</span>
                </div>
                <span
                  className={`live2d-status-pill ${
                    cubism3PlusAvailable ? 'live2d-status-pill--ready' : 'live2d-status-pill--missing'
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
            <button
              type="button"
              className={`live2d-btn ${allReady ? 'live2d-btn--primary' : ''}`}
              onClick={onClose}
            >
              {allReady ? '配置完成，进入' : '我知道了 / 稍后配置'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

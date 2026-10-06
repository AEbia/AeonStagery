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
  IconWarning,
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

  const handleOpenLocalDir = useCallback(async () => {
    const success = await openLive2DDirectory('local');
    if (success) {
      showToast('已在文件管理器中打开 .local/live2d 目录', 'info');
    } else {
      showToast('未能打开目录，请手动打开项目根目录下的 .local/live2d', 'warning');
    }
  }, []);

  if (!isOpen) return null;

  const cubism2Available = report ? report.cubism2 : false;
  const cubism3PlusAvailable = report ? report.cubism3Plus : false;
  const allReady = cubism2Available && cubism3PlusAvailable;

  return createPortal(
    <div
      ref={dialogRef}
      className="live2d-runtime-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="live2d-runtime-dialog-title"
      aria-describedby="live2d-runtime-dialog-notice"
    >
      <div className="live2d-runtime-dialog__surface">
        <div className="live2d-runtime-dialog__header">
          <div className="live2d-runtime-dialog__header-left">
            <div className="live2d-runtime-dialog__header-icon">
              <IconWarning width={22} height={22} />
            </div>
            <div>
              <div id="live2d-runtime-dialog-title" className="live2d-runtime-dialog__title">
                Live2D Cubism 运行时配置引导
              </div>
              <div className="live2d-runtime-dialog__subtitle">
                检测到仓库缺少 Live2D 运行时核心文件，模型加载需要对应运行时支持
              </div>
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
          <div id="live2d-runtime-dialog-notice" className="live2d-runtime-dialog__notice">
            <span className="live2d-runtime-dialog__notice-highlight">版权与合规说明：</span>
            本仓库依据开源规范，<strong>不随附任何 Live2D Inc. 专有运行时核心代码</strong>。
            若缺少对应运行时，相关模型将无法加载或显示为错误状态。请按照下方指引下载对应核心脚本并放置到指定目录中。
          </div>

          <div className="live2d-runtime-dialog__cards">
            {/* Cubism 2.1 Card */}
            <div
              className={`live2d-runtime-card ${
                cubism2Available ? 'live2d-runtime-card--ready' : 'live2d-runtime-card--missing'
              }`}
            >
              <div className="live2d-runtime-card__header">
                <div className="live2d-runtime-card__title-wrap">
                  <span className="live2d-runtime-card__title">{CUBISM2_CONFIG.title}</span>
                  <span className="live2d-runtime-card__file">{CUBISM2_CONFIG.fileName}</span>
                </div>
                <span
                  className={`live2d-runtime-card__badge ${
                    cubism2Available
                      ? 'live2d-runtime-card__badge--ready'
                      : 'live2d-runtime-card__badge--missing'
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

              <div className="live2d-runtime-card__path-row">
                <span className="live2d-runtime-card__path-label">放置路径:</span>
                <span className="live2d-runtime-card__path-value" title={CUBISM2_CONFIG.targetRelativePath}>
                  {CUBISM2_CONFIG.targetRelativePath}
                </span>
                <button
                  type="button"
                  className="live2d-runtime-action-btn"
                  onClick={() => void handleCopy(CUBISM2_CONFIG.targetRelativePath, '路径')}
                  title="复制路径"
                >
                  <IconCopy width={12} height={12} />
                  复制
                </button>
              </div>

              <div className="live2d-runtime-card__actions">
                <button
                  type="button"
                  className="live2d-runtime-action-btn live2d-runtime-action-btn--primary"
                  onClick={() => void openExternalLink(CUBISM2_CONFIG.downloadUrl)}
                  title="在浏览器中下载"
                >
                  <IconExternalLink width={13} height={13} />
                  下载 live2d.min.js
                </button>
                {CUBISM2_CONFIG.downloadMirrorUrl && (
                  <button
                    type="button"
                    className="live2d-runtime-action-btn"
                    onClick={() => void openExternalLink(CUBISM2_CONFIG.downloadMirrorUrl!)}
                    title="查看开源镜像项目"
                  >
                    <IconExternalLink width={13} height={13} />
                    GitHub 镜像仓库
                  </button>
                )}
                <button
                  type="button"
                  className="live2d-runtime-action-btn"
                  onClick={() => void handleCopy(CUBISM2_CONFIG.downloadUrl, '下载链接')}
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
              <div className="live2d-runtime-card__header">
                <div className="live2d-runtime-card__title-wrap">
                  <span className="live2d-runtime-card__title">{CUBISM3_PLUS_CONFIG.title}</span>
                  <span className="live2d-runtime-card__file">{CUBISM3_PLUS_CONFIG.fileName}</span>
                </div>
                <span
                  className={`live2d-runtime-card__badge ${
                    cubism3PlusAvailable
                      ? 'live2d-runtime-card__badge--ready'
                      : 'live2d-runtime-card__badge--missing'
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

              <div className="live2d-runtime-card__path-row">
                <span className="live2d-runtime-card__path-label">放置路径:</span>
                <span className="live2d-runtime-card__path-value" title={CUBISM3_PLUS_CONFIG.targetRelativePath}>
                  {CUBISM3_PLUS_CONFIG.targetRelativePath}
                </span>
                <button
                  type="button"
                  className="live2d-runtime-action-btn"
                  onClick={() => void handleCopy(CUBISM3_CONFIG_PATH, '路径')}
                  title="复制路径"
                >
                  <IconCopy width={12} height={12} />
                  复制
                </button>
              </div>

              <div className="live2d-runtime-card__actions">
                <button
                  type="button"
                  className="live2d-runtime-action-btn live2d-runtime-action-btn--primary"
                  onClick={() => void openExternalLink(CUBISM3_PLUS_CONFIG.downloadUrl)}
                  title="通过官方直链下载"
                >
                  <IconExternalLink width={13} height={13} />
                  直链下载 live2dcubismcore.min.js
                </button>
                {CUBISM3_PLUS_CONFIG.officialSiteUrl && (
                  <button
                    type="button"
                    className="live2d-runtime-action-btn"
                    onClick={() => void openExternalLink(CUBISM3_PLUS_CONFIG.officialSiteUrl!)}
                    title="前往官方 SDK 下载页"
                  >
                    <IconExternalLink width={13} height={13} />
                    官方 SDK 下载页
                  </button>
                )}
                <button
                  type="button"
                  className="live2d-runtime-action-btn"
                  onClick={() => void handleCopy(CUBISM3_PLUS_CONFIG.downloadUrl, '下载链接')}
                  title="复制直接下载链接"
                >
                  <IconCopy width={12} height={12} />
                  复制下载链接
                </button>
              </div>
            </div>
          </div>

          <div className="live2d-runtime-dialog__instructions">
            <div className="live2d-runtime-dialog__instructions-title">配置操作步骤：</div>
            <ol className="live2d-runtime-dialog__instructions-list">
              <li>
                下载上述缺失的运行时文件（<code>live2d.min.js</code> 或 <code>live2dcubismcore.min.js</code>）。
              </li>
              <li>
                将下载的文件放入仓库根目录下的 <code className="live2d-runtime-dialog__code">.local/live2d/</code> 目录（或 <code>public/</code> 目录）。
              </li>
              <li>
                放置后，在终端执行 <code className="live2d-runtime-dialog__code">npm run sync:live2d-runtime</code> 同步，或在下方点击「重新检测」即时完成检测与同步。
              </li>
            </ol>
          </div>
        </div>

        <div className="live2d-runtime-dialog__footer">
          <div className="live2d-runtime-dialog__footer-left">
            {isElectron && (
              <button
                type="button"
                className="live2d-runtime-action-btn"
                onClick={() => void handleOpenLocalDir()}
                title="在操作系统中打开 .local/live2d 文件夹"
              >
                <IconFolder width={14} height={14} />
                打开 .local/live2d 目录
              </button>
            )}
            <button
              type="button"
              className="live2d-runtime-action-btn"
              onClick={() => void handleCopy('npm run sync:live2d-runtime', '同步命令')}
              title="复制同步命令"
            >
              <IconCopy width={13} height={13} />
              复制同步命令
            </button>
          </div>

          <div className="live2d-runtime-dialog__footer-right">
            <button
              type="button"
              className="btn btn--secondary"
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
              className={`btn ${allReady ? 'btn--primary' : 'btn--secondary'}`}
              onClick={onClose}
            >
              {allReady ? '完成并进入' : '我知道了 / 稍后配置'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

const CUBISM3_CONFIG_PATH = CUBISM3_PLUS_CONFIG.targetRelativePath;

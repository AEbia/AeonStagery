/**
 * CrashScreen Component
 * Implements ADR-0032 Crash Screen & Recovery Flow
 */

import React, { useState } from 'react';
import type { CrashReport } from '../api/types/crash';
import { formatCrashReportMarkdown } from '../services/crash/CrashReporter';
import { IconWarning, IconRefresh, IconCopy, IconCheck, IconFolder, IconChevronDown, IconInfo } from './icons';

export interface CrashScreenProps {
  report: CrashReport;
  onRestart?: () => void;
  isDev?: boolean;
}

export const CrashScreen: React.FC<CrashScreenProps> = ({
  report,
  onRestart,
  isDev = typeof process !== 'undefined' ? (process.env.NODE_ENV === 'development') : false,
}) => {
  const [copied, setCopied] = useState(false);

  const handleRestart = () => {
    if (onRestart) {
      onRestart();
      return;
    }
    const api = (window as any).aeonStageryAPI;
    if (api?.app?.restart) {
      api.app.restart();
    } else {
      window.location.reload();
    }
  };

  const handleCopyReport = async () => {
    try {
      const markdown = formatCrashReportMarkdown(report);
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(markdown);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = markdown;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      console.error('Failed to copy crash report:', err);
    }
  };

  const handleOpenFolder = () => {
    const api = (window as any).aeonStageryAPI;
    if (api?.crash?.openReportDir) {
      api.crash.openReportDir();
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: '#090a0f',
        color: '#e2e8f0',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        zIndex: 999999,
        overflow: 'auto',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '680px',
          background: 'rgba(20, 24, 33, 0.95)',
          border: '1px solid rgba(239, 68, 68, 0.25)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05)',
          padding: '32px',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
        }}
      >
        {/* Header Title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#f87171',
              flexShrink: 0,
            }}
          >
            <IconWarning width={26} height={26} />
          </div>
          <div>
            <h1
              style={{
                fontSize: '19px',
                fontWeight: 600,
                color: '#f1f5f9',
                margin: 0,
                letterSpacing: '-0.01em',
              }}
            >
              AeonStagery 遇到了意外错误
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#94a3b8' }}>
              应用程序遇到无法继续执行的异常，已为您保护最近的系统状态。
            </p>
          </div>
        </div>

        {/* Error Summary Badge */}
        <div
          style={{
            background: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 16px',
            fontSize: '13px',
            color: '#cbd5e1',
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 500, color: '#fca5a5', marginBottom: '2px' }}>
            {report.error.name || 'Application Error'}
          </div>
          <div style={{ wordBreak: 'break-word', color: '#cbd5e1' }}>
            {report.error.message || '未知运行时错误'}
          </div>
          <div style={{ marginTop: '8px', fontSize: '12px', color: '#64748b' }}>
            诊断报告已就绪：<code>{report.reportId}</code>
          </div>
        </div>

        {/* Important Guidance Callout (Against Screenshots) */}
        <div
          style={{
            background: 'rgba(59, 130, 246, 0.08)',
            border: '1px solid rgba(59, 130, 246, 0.25)',
            borderRadius: 'var(--radius-md)',
            padding: '14px 16px',
            fontSize: '13px',
            lineHeight: 1.6,
            color: '#bfdbfe',
          }}
        >
          <div style={{ fontWeight: 600, color: '#93c5fd', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <IconInfo width={16} height={16} />
            <span>问题反馈提示</span>
          </div>
          <div style={{ marginTop: '4px', color: '#e0f2fe' }}>
            若需向开发者反馈此问题，<strong>请使用下方的【复制错误报告】或【打开报告文件】</strong>获取信息。
          </div>
          <div style={{ marginTop: '6px', color: '#fcd34d', fontWeight: 500, display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
            <IconWarning width={15} height={15} style={{ flexShrink: 0, marginTop: '2px', color: '#f59e0b' }} />
            <span>请勿直接只发送本窗口截图</span>
          </div>
        </div>

        {/* Action Controls */}
        <div style={{ display: 'flex', gap: '12px', marginTop: '4px', flexWrap: 'wrap' }}>
          {/* Primary: Restart Button */}
          <button
            type="button"
            onClick={handleRestart}
            style={{
              flex: 1,
              minWidth: '140px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              padding: '10px 18px',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              background: '#3b82f6',
              color: '#ffffff',
              fontSize: '14px',
              fontWeight: 500,
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(59, 130, 246, 0.3)',
              transition: 'background 0.15s ease',
            }}
          >
            <IconRefresh width={16} height={16} />
            重启应用
          </button>

          {/* Secondary: Copy Report */}
          <button
            type="button"
            onClick={handleCopyReport}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              padding: '10px 18px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              background: copied ? 'rgba(34, 197, 94, 0.15)' : 'rgba(255, 255, 255, 0.06)',
              color: copied ? '#86efac' : '#e2e8f0',
              borderColor: copied ? 'rgba(34, 197, 94, 0.4)' : 'rgba(255, 255, 255, 0.12)',
              fontSize: '14px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            {copied ? <IconCheck width={16} height={16} /> : <IconCopy width={16} height={16} />}
            {copied ? '已复制脱敏诊断报告' : '复制错误报告'}
          </button>

          {/* Tertiary: Open Directory if available */}
          {(window as any).aeonStageryAPI?.crash?.openReportDir && (
            <button
              type="button"
              onClick={handleOpenFolder}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '10px 14px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                background: 'transparent',
                color: '#94a3b8',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              <IconFolder width={16} height={16} />
              打开报告文件夹
            </button>
          )}
        </div>

        {/* Developer Raw Stack Details (Only rendered when isDev is true) */}
        {isDev && report.error.stack && (
          <details
            style={{
              marginTop: '12px',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              paddingTop: '12px',
              fontSize: '12px',
              color: '#94a3b8',
            }}
          >
            <summary
              style={{
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontWeight: 500,
                color: '#cbd5e1',
                outline: 'none',
              }}
            >
              <IconChevronDown width={14} height={14} />
              查看开发者原始堆栈（仅 DEV 模式可见）
            </summary>
            <pre
              style={{
                marginTop: '8px',
                padding: '12px',
                background: 'rgba(0, 0, 0, 0.4)',
                borderRadius: 'var(--radius-md)',
                overflow: 'auto',
                maxHeight: '180px',
                fontFamily: 'monospace',
                fontSize: '11px',
                color: '#f87171',
                lineHeight: 1.4,
              }}
            >
              {report.error.stack}
              {report.error.componentStack ? `\n\nComponent Stack:\n${report.error.componentStack}` : ''}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
};

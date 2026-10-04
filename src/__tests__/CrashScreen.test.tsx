/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CrashScreen } from '../ui/CrashScreen';
import { buildCrashReport } from '../services/crash/CrashReporter';

describe('CrashScreen Component', () => {
  const sampleReport = buildCrashReport({
    error: new Error('Cannot read properties of null'),
    tier: 1,
    surface: 'editor',
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders title, error summary, guidance callout, and no raw stack trace by default in prod', () => {
    render(
      <CrashScreen
        report={sampleReport}
        isDev={false}
      />
    );

    // Title
    expect(screen.getByText(/AeonStagery 遇到了意外错误/i)).toBeInTheDocument();

    // Guidance against sending screenshots
    expect(screen.getByText(/请勿直接只?发送本窗口截图/i)).toBeInTheDocument();
    expect(screen.getByText(/请使用下方的【复制错误报告】/i)).toBeInTheDocument();

    // Report ID
    expect(screen.getByText(new RegExp(sampleReport.reportId))).toBeInTheDocument();

    // Buttons
    expect(screen.getByRole('button', { name: /重启应用/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /复制错误报告/i })).toBeInTheDocument();

    // No stack trace in prod
    expect(screen.queryByText(/Stack Trace/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/查看开发者原始堆栈/i)).not.toBeInTheDocument();
  });

  it('renders expandable developer stack trace when isDev is true', () => {
    render(
      <CrashScreen
        report={sampleReport}
        isDev={true}
      />
    );

    expect(screen.getByText(/查看开发者原始堆栈/i)).toBeInTheDocument();
  });

  it('calls onRestart or window.aeonStageryAPI.app.restart when restart button clicked', () => {
    const onRestart = vi.fn();
    render(
      <CrashScreen
        report={sampleReport}
        onRestart={onRestart}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /重启应用/i }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('copies markdown report to clipboard when copy button clicked', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(
      <CrashScreen
        report={sampleReport}
      />
    );

    const copyBtn = screen.getByRole('button', { name: /复制错误报告/i });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(1);
      expect(writeTextMock.mock.calls[0][0]).toContain('# AeonStagery Crash Diagnostic Report');
      expect(screen.getByText(/已复制/i)).toBeInTheDocument();
    });
  });
});

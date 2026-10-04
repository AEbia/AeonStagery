/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { GlobalErrorBoundary } from '../ui/GlobalErrorBoundary';
import {
  registerManualCrashHandler,
  triggerManualCrash,
} from '../services/crash/manualCrash';

describe('manualCrash registry', () => {
  it('invokes the registered handler and no-ops after unregister', () => {
    const handler = vi.fn();
    const unregister = registerManualCrashHandler(handler);

    triggerManualCrash({ reason: 't' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ reason: 't' });

    unregister();
    triggerManualCrash({ reason: 'again' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('GlobalErrorBoundary manual crash', () => {
  it('shows CrashScreen when triggerManualCrash is fired', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <GlobalErrorBoundary surface="editor" isDev={false}>
        <div>editor content</div>
      </GlobalErrorBoundary>,
    );

    act(() => {
      triggerManualCrash({ reason: '手动崩溃（调试触发）' });
    });

    expect(screen.getByText(/AeonStagery 遇到了意外错误/i)).toBeInTheDocument();
    expect(screen.getByText(/请勿直接只?发送本窗口截图/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重启应用/i })).toBeInTheDocument();

    consoleSpy.mockRestore();
  });
});

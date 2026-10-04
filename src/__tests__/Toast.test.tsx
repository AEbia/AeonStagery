/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ToastContainer, showToast, localizeToastMessage } from '../ui/Toast';

describe('localizeToastMessage', () => {
  it('translates assertion and common runtime failure text', () => {
    expect(localizeToastMessage('Assertion failed: expected a scene')).toBe('断言失败：expected a scene');
    expect(localizeToastMessage('Failed to load image asset "bg.png": HTTP 404')).toBe(
      '加载失败 image asset "bg.png": HTTP 状态码 404',
    );
    expect(localizeToastMessage("Cannot read properties of null (reading 'baseTexture')")).toBe(
      '无法读取 null 的属性 "baseTexture"',
    );
    expect(localizeToastMessage('角色修改失败:Expected non-empty string at scene.meta.characters[0].name')).toBe(
      '角色修改失败：场景元数据.角色列表[0].名称：必须填写非空字符串',
    );
  });

  it('keeps already localized messages unchanged', () => {
    expect(localizeToastMessage('资源导入失败: 文件不存在')).toBe('资源导入失败: 文件不存在');
  });
});

describe('ToastContainer and showToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a toast notification when showToast is called', () => {
    render(<ToastContainer />);
    act(() => {
      showToast('剧本保存成功！', 'success');
    });

    expect(screen.getByText('剧本保存成功！')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('renders error toast with role="alert" and copy button', () => {
    render(<ToastContainer />);
    act(() => {
      showToast('无法读取配置', 'error');
    });

    const alert = screen.getByRole('alert');
    expect(alert).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制报错信息' })).toBeTruthy();
  });

  it('auto-dismisses after duration', async () => {
    render(<ToastContainer />);
    act(() => {
      showToast('普通提示', 'info', { duration: 3000 });
    });

    expect(screen.getByText('普通提示')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.queryByText('普通提示')).toBeNull();
  });

  it('pauses auto-dismiss when mouse hovers, and resumes when mouse leaves', async () => {
    render(<ToastContainer />);
    act(() => {
      showToast('悬停测试提示', 'info', { duration: 4000 });
    });

    const toastEl = screen.getByText('悬停测试提示').closest('.app-toast')!;
    expect(toastEl).toBeTruthy();

    // Advance 2 seconds
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('悬停测试提示')).toBeTruthy();

    // Mouse enters -> pause
    await act(async () => {
      fireEvent.mouseEnter(toastEl);
    });
    expect(toastEl.className).toContain('app-toast--paused');

    // Advance 10 seconds while hovered -> should NOT disappear
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText('悬停测试提示')).toBeTruthy();

    // Mouse leaves -> resume
    await act(async () => {
      fireEvent.mouseLeave(toastEl);
    });
    expect(toastEl.className).not.toContain('app-toast--paused');

    // Remaining time (2000ms, with minimum grace period + exit duration)
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText('悬停测试提示')).toBeNull();
  });

  it('dismisses toast immediately when clicking close button', async () => {
    render(<ToastContainer />);
    act(() => {
      showToast('可关闭提示', 'warning');
    });

    const closeBtn = screen.getByRole('button', { name: '关闭通知' });
    await act(async () => {
      fireEvent.click(closeBtn);
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.queryByText('可关闭提示')).toBeNull();
  });

  it('deduplicates identical consecutive toasts within window and shows count badge', () => {
    render(<ToastContainer />);
    act(() => {
      showToast('重复提示信息', 'warning');
    });
    expect(screen.queryByText('×2')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
      showToast('重复提示信息', 'warning');
    });

    expect(screen.getByText('×2')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(500);
      showToast('重复提示信息', 'warning');
    });

    expect(screen.getByText('×3')).toBeTruthy();
  });

  it('copies error text when copy button is clicked', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<ToastContainer />);
    act(() => {
      showToast('崩溃错误信息', 'error');
    });

    const copyBtn = screen.getByRole('button', { name: '复制报错信息' });
    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(writeTextMock).toHaveBeenCalledWith('崩溃错误信息');
    expect(screen.getByText('已复制')).toBeTruthy();
  });

  it('supports custom action button and click callback', () => {
    const actionSpy = vi.fn();
    render(<ToastContainer />);
    act(() => {
      showToast('文件已修改', 'info', {
        action: { label: '查看', onClick: actionSpy },
      });
    });

    const actionBtn = screen.getByRole('button', { name: '查看' });
    fireEvent.click(actionBtn);

    expect(actionSpy).toHaveBeenCalledTimes(1);
  });

  it('caps maximum simultaneous toasts to 5', async () => {
    render(<ToastContainer />);
    await act(async () => {
      showToast('Toast 1', 'info');
      showToast('Toast 2', 'info');
      showToast('Toast 3', 'info');
      showToast('Toast 4', 'info');
      showToast('Toast 5', 'info');
      showToast('Toast 6', 'info');
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    const toasts = screen.getAllByRole('status');
    expect(toasts.length).toBeLessThanOrEqual(5);
  });
});

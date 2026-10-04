/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tooltip, InfoTip, ShortcutBadge, parseShortcutKeys } from '../ui/Tooltip';

describe('Tooltip component', () => {
  it('parses single and multi-key shortcuts correctly', () => {
    expect(parseShortcutKeys()).toEqual([]);
    expect(parseShortcutKeys('Space')).toEqual(['Space']);
    expect(parseShortcutKeys('Ctrl+Z')).toEqual(['Ctrl', 'Z']);
    expect(parseShortcutKeys(['Ctrl', 'Shift', 'P'])).toEqual(['Ctrl', 'Shift', 'P']);
  });

  it('renders shortcut badges as accessible kbd elements', () => {
    render(<ShortcutBadge shortcut="Ctrl+S" />);
    expect(screen.getByText('Ctrl')).toBeTruthy();
    expect(screen.getByText('S')).toBeTruthy();
  });

  it('shows tooltip on mouse enter after delay and hides on mouse leave', async () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="这是测试提示" delay={150}>
        <button type="button">操作按钮</button>
      </Tooltip>,
    );

    const button = screen.getByRole('button', { name: '操作按钮' });
    expect(screen.queryByText('这是测试提示')).toBeNull();

    fireEvent.mouseEnter(button);
    expect(screen.queryByText('这是测试提示')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(screen.getByText('这是测试提示')).toBeTruthy();
    expect(screen.getByRole('tooltip')).toBeTruthy();

    fireEvent.mouseLeave(button);
    expect(screen.queryByText('这是测试提示')).toBeNull();
    vi.useRealTimers();
  });

  it('shows tooltip on focus and hides on blur', async () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="聚焦提示" title="提示标题" delay={100}>
        <input placeholder="输入框" />
      </Tooltip>,
    );

    const input = screen.getByPlaceholderText('输入框');
    fireEvent.focus(input);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(screen.getByText('提示标题')).toBeTruthy();
    expect(screen.getByText('聚焦提示')).toBeTruthy();

    fireEvent.blur(input);
    expect(screen.queryByText('聚焦提示')).toBeNull();
    vi.useRealTimers();
  });

  it('dismisses tooltip on Escape key press', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="可按ESC关闭" delay={0}>
        <button type="button">测试</button>
      </Tooltip>,
    );

    const button = screen.getByRole('button', { name: '测试' });
    fireEvent.mouseEnter(button);
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(screen.getByText('可按ESC关闭')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('可按ESC关闭')).toBeNull();
    vi.useRealTimers();
  });

  it('does not open when disabled', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="不可见" disabled delay={0}>
        <button type="button">禁用</button>
      </Tooltip>,
    );

    const button = screen.getByRole('button', { name: '禁用' });
    fireEvent.mouseEnter(button);
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(screen.queryByText('不可见')).toBeNull();
    vi.useRealTimers();
  });
});

describe('InfoTip component', () => {
  it('renders an info trigger button with accessible label and tooltip', () => {
    vi.useFakeTimers();
    render(<InfoTip content="详细说明文本" title="说明标题" ariaLabel="字段说明" />);

    const trigger = screen.getByRole('button', { name: '字段说明' });
    expect(trigger).toBeTruthy();

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(screen.getByText('说明标题')).toBeTruthy();
    expect(screen.getByText('详细说明文本')).toBeTruthy();
    vi.useRealTimers();
  });
});

/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpotlightOverlay } from '../ui/onboarding/SpotlightOverlay';

describe('SpotlightOverlay', () => {
  afterEach(() => {
    cleanup();
    document.querySelector('[data-test-target="spotlight"]')?.remove();
    document.querySelector('[data-test-viewport]')?.remove();
    document.querySelector('[data-testid="timeline-blank-insert-menu"]')?.remove();
  });

  it('clips a wide CTI ruler to the visible timeline viewport in list layout', () => {
    const viewport = document.createElement('div');
    viewport.dataset.testViewport = 'timeline';
    viewport.style.overflow = 'auto';
    // jsdom does not expand the overflow shorthand into its computed axes.
    viewport.style.overflowX = 'auto';
    viewport.style.overflowY = 'auto';
    viewport.getBoundingClientRect = () => new DOMRect(80, 400, 440, 180);
    const target = document.createElement('div');
    target.dataset.testTarget = 'spotlight';
    target.className = 'timeline-ruler';
    target.getBoundingClientRect = () => new DOMRect(-120, 400, 1800, 30);
    viewport.append(target);
    document.body.append(viewport);

    render(<SpotlightOverlay
      targetSelector=".timeline-ruler"
      title="把 CTI 移到动作之前"
      description="点击可见的时间标尺。"
      stepLabel="第 11 / 13 步"
      onClose={() => undefined}
      padding={2}
    />);
    const hole = document.querySelector<HTMLElement>('.fl-spotlight__hole');
    expect(hole?.style.left).toBe('80px');
    expect(hole?.style.width).toBe('440px');
    expect(hole?.style.top).toBe('400px');
    expect(hole?.style.height).toBe('32px');
  });

  it('updates the clipped region when its viewport changes and does not spotlight an invisible target', async () => {
    const viewport = document.createElement('div');
    viewport.dataset.testViewport = 'timeline';
    viewport.style.overflowX = 'hidden';
    viewport.style.overflowY = 'hidden';
    let viewportWidth = 440;
    viewport.getBoundingClientRect = () => new DOMRect(80, 400, viewportWidth, 180);
    const target = document.createElement('div');
    target.dataset.testTarget = 'spotlight';
    let targetTop = 400;
    target.getBoundingClientRect = () => new DOMRect(100, targetTop, 1800, 30);
    viewport.append(target);
    document.body.append(viewport);
    render(<SpotlightOverlay
      targetSelector="[data-test-target='spotlight']"
      title="移动 CTI"
      description="时间轴可见区域。"
      stepLabel="第 11 / 13 步"
      onClose={() => undefined}
      padding={2}
    />);
    expect(document.querySelector<HTMLElement>('.fl-spotlight__hole')?.style.width).toBe('422px');
    viewportWidth = 300;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(document.querySelector<HTMLElement>('.fl-spotlight__hole')?.style.width).toBe('282px'));
    targetTop = 300;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(document.querySelector('.fl-spotlight__hole')).toBeNull());
    expect(document.querySelector('.fl-spotlight__missing-target')).toBeTruthy();
  });

  it('keeps the insert menu spotlighted when its statement card scrolls out of view', async () => {
    const menu = document.createElement('div');
    menu.dataset.testid = 'timeline-blank-insert-menu';
    menu.getBoundingClientRect = () => new DOMRect(60, 350, 500, 300);
    const viewport = document.createElement('div');
    viewport.dataset.testViewport = 'insert-menu';
    viewport.style.overflowY = 'auto';
    viewport.getBoundingClientRect = () => new DOMRect(60, 400, 500, 120);
    const target = document.createElement('button');
    target.className = 'statement-card';
    let targetTop = 430;
    target.getBoundingClientRect = () => new DOMRect(80, targetTop, 160, 28);
    viewport.append(target);
    menu.append(viewport);
    document.body.append(menu);

    render(<SpotlightOverlay
      targetSelector=".statement-card"
      fallbackTargetSelector="[data-testid='timeline-blank-insert-menu']"
      title="选择语句"
      description="从浮窗菜单中选择目标语句。"
      stepLabel="第 4 步"
      onClose={() => undefined}
      padding={0}
    />);

    expect(document.querySelector<HTMLElement>('.fl-spotlight__hole')?.style.top).toBe('430px');
    targetTop = 620;
    fireEvent.scroll(viewport);

    await waitFor(() => {
      expect(document.querySelector<HTMLElement>('.fl-spotlight__hole')?.style.top).toBe('350px');
    });
    expect(screen.queryByText('正在定位下一步')).toBeNull();
    expect(screen.getByText('选择语句')).toBeTruthy();
  });

  it('opens a click-through hole and blocks the four surrounding regions', async () => {
    const target = document.createElement('button');
    target.dataset.testTarget = 'spotlight';
    target.textContent = '目标';
    target.getBoundingClientRect = () => ({
      top: 100,
      left: 160,
      right: 260,
      bottom: 140,
      width: 100,
      height: 40,
      x: 160,
      y: 100,
      toJSON: () => ({}),
    });
    document.body.appendChild(target);
    const onClose = vi.fn();

    const { container } = render(
      <SpotlightOverlay
        targetSelector="[data-test-target='spotlight']"
        title="点击目标"
        description="只有目标区域可以操作。"
        stepLabel="第 2 / 6 步"
        onClose={onClose}
        padding={0}
      />,
    );

    await waitFor(() => {
      const hole = document.querySelector<HTMLElement>('.fl-spotlight__hole');
      expect(hole?.style.top).toBe('100px');
      expect(hole?.style.left).toBe('160px');
    });
    expect(document.querySelectorAll('.fl-spotlight__blocker')).toHaveLength(4);
    expect(screen.getByText('点击目标')).toBeTruthy();
    expect(container).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '关闭教程' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('can leave the surrounding workspace interactive for blur-to-save fields', async () => {
    const target = document.createElement('input');
    target.dataset.testTarget = 'spotlight';
    target.getBoundingClientRect = () => ({
      top: 100, left: 160, right: 260, bottom: 140, width: 100, height: 40,
      x: 160, y: 100, toJSON: () => ({}),
    });
    document.body.appendChild(target);

    render(
      <SpotlightOverlay
        targetSelector="[data-test-target='spotlight']"
        title="编辑对白"
        description="点击外部保存。"
        stepLabel="第 5 / 7 步"
        onClose={() => undefined}
        allowWorkspaceInteraction
      />,
    );

    await waitFor(() => expect(document.querySelector('.fl-spotlight__hole')).toBeTruthy());
    expect(document.querySelectorAll('.fl-spotlight__blocker')).toHaveLength(0);
  });

  it('can show guidance without dimming or spotlighting the workspace', async () => {
    const target = document.createElement('button');
    target.dataset.testTarget = 'spotlight';
    target.getBoundingClientRect = () => ({
      top: 100, left: 160, right: 260, bottom: 140, width: 100, height: 40,
      x: 160, y: 100, toJSON: () => ({}),
    });
    document.body.appendChild(target);

    render(
      <SpotlightOverlay
        targetSelector="[data-test-target='spotlight']"
        title="播放场景"
        description="观察角色登场。"
        stepLabel="第 4 / 7 步"
        onClose={() => undefined}
        allowWorkspaceInteraction
        showSpotlight={false}
      />,
    );

    await waitFor(() => expect(screen.getByText('播放场景')).toBeTruthy());
    expect(document.querySelector('.fl-spotlight__hole')).toBeNull();
    expect(document.querySelector('.fl-spotlight__missing-target')).toBeNull();
    expect(document.querySelectorAll('.fl-spotlight__blocker')).toHaveLength(0);
  });
});

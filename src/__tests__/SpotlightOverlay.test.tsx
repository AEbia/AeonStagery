/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpotlightOverlay } from '../ui/onboarding/SpotlightOverlay';

describe('SpotlightOverlay', () => {
  afterEach(() => {
    document.querySelector('[data-test-target="spotlight"]')?.remove();
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

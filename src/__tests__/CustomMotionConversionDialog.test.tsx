// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CustomMotionConversionDialog } from '../ui/timeline/CustomMotionConversionDialog';
import { estimateCustomMotionKeyframes } from '../engine/live2d/customMotionConversion';

describe('CustomMotionConversionDialog', () => {
  it('renders convert mode with concise wording and correct frame estimates', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const durationSeconds = 2.0; // 120 frames at 60fps

    render(
      <CustomMotionConversionDialog
        open={{
          mode: 'convert',
          targetId: 'hero',
          motionKey: 'wave.mtn',
          durationSeconds,
        }}
        estimateKeyframes={(density) => estimateCustomMotionKeyframes(durationSeconds, density, 60)}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    // Title and duration info
    expect(screen.getByText('转为自定义动作')).toBeTruthy();
    expect(screen.getByText('hero')).toBeTruthy();
    expect(screen.getByText('2.00s')).toBeTruthy();

    // Verify descriptions do NOT contain verbose error percentages or technical jargon
    expect(screen.queryByText(/拟合误差/)).toBeNull();
    expect(screen.queryByText(/操作方式/)).toBeNull();
    expect(screen.queryByText(/非破坏性/)).toBeNull();
    expect(screen.queryByText(/拟合算法/)).toBeNull();

    // Verify clean descriptions
    expect(screen.getByText('最少关键帧，曲线平滑')).toBeTruthy();
    expect(screen.getByText('平衡精度与可编辑性（推荐）')).toBeTruthy();
    expect(screen.getByText('保留更多动作细节')).toBeTruthy();
    expect(screen.getByText('逐帧生成关键帧')).toBeTruthy();

    // Verify accurate frame estimates
    expect(screen.getByText('约 12 帧')).toBeTruthy(); // sparse: 120 * 0.1
    expect(screen.getByText('约 30 帧')).toBeTruthy(); // standard: 120 * 0.25
    expect(screen.getByText('约 72 帧')).toBeTruthy(); // fine: 120 * 0.6
    expect(screen.getByText('约 120 帧')).toBeTruthy(); // perFrame: 120

    // Confirm button default state
    const confirmBtn = screen.getByRole('button', { name: '开始转换' });
    expect(confirmBtn).toBeTruthy();
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledWith('standard');
  });

  it('renders regenerate mode with concise warning and regeneration button', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <CustomMotionConversionDialog
        open={{
          mode: 'regenerate',
          targetId: 'hero',
          motionKey: 'dance.mtn',
          durationSeconds: 3.0,
        }}
        estimateKeyframes={(density) => estimateCustomMotionKeyframes(3.0, density, 60)}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText('从源动作重新生成')).toBeTruthy();
    expect(screen.getByText('当前全部关键帧和手工调整都会被替换。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新生成' })).toBeTruthy();
    // No redundant secondary warning
    expect(screen.queryByText(/进入过渡会保留/)).toBeNull();
  });

  it('shows concise busy button text', () => {
    const { rerender } = render(
      <CustomMotionConversionDialog
        open={{
          mode: 'convert',
          targetId: 'hero',
          motionKey: 'wave.mtn',
          durationSeconds: 1.0,
        }}
        estimateKeyframes={() => 60}
        busy={true}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '转换中…' })).toBeTruthy();

    rerender(
      <CustomMotionConversionDialog
        open={{
          mode: 'regenerate',
          targetId: 'hero',
          motionKey: 'wave.mtn',
          durationSeconds: 1.0,
        }}
        estimateKeyframes={() => 60}
        busy={true}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '重新生成中…' })).toBeTruthy();
  });
});

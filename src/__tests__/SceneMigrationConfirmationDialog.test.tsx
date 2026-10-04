/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SceneMigrationConfirmationDialog } from '../ui/SceneMigrationConfirmationDialog';
import type { SceneMigrationConfirmationRequest } from '../services/semantic-scene/SceneMigrationExperience';

describe('SceneMigrationConfirmationDialog', () => {
  const baseRequest: SceneMigrationConfirmationRequest = {
    scenePath: '/project/scenes/intro.scene.json',
    backupPath: '/project/.aeonstagery/backups/2026-08-18T10-20-30-000Z/intro.scene.json',
    sourceEpoch: 4,
    targetEpoch: 5,
    stages: ['v4_to_v5'],
    warnings: [],
  };

  it('renders simplified dialog details correctly for v4 to v5 without warnings', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <SceneMigrationConfirmationDialog
        request={baseRequest}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText('升级场景文件')).toBeTruthy();
    expect(screen.getByText('检测到旧版本场景文件，需要升级后打开')).toBeTruthy();
    expect(screen.getByText('/project/scenes/intro.scene.json')).toBeTruthy();
    expect(screen.getByText('/project/.aeonstagery/backups/2026-08-18T10-20-30-000Z/intro.scene.json')).toBeTruthy();
    expect(screen.queryByText(/Schema v/)).toBeNull();
    expect(screen.queryByText('v4 -> v5')).toBeNull();
    expect(screen.queryByText(/注意事项/)).toBeNull();
  });

  it('renders warning messages when present', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    const requestWithWarnings: SceneMigrationConfirmationRequest = {
      scenePath: '/project/scenes/act1.scene.json',
      backupPath: '/project/.aeonstagery/backups/2026-08-18T10-20-30-000Z/act1.scene.json',
      sourceEpoch: 3,
      targetEpoch: 5,
      stages: ['v3_to_v4', 'v4_to_v5'],
      warnings: [
        'Removed live2dParameterClip statement "clip-1": no v4 equivalent',
        'Dropped characterPerformance loop=true on "hero-1"',
      ],
    };

    render(
      <SceneMigrationConfirmationDialog
        request={requestWithWarnings}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText('注意事项 (2 条):')).toBeTruthy();
    expect(screen.getByText('Removed live2dParameterClip statement "clip-1": no v4 equivalent')).toBeTruthy();
    expect(screen.getByText('Dropped characterPerformance loop=true on "hero-1"')).toBeTruthy();
    expect(screen.queryByText(/Schema v/)).toBeNull();
    expect(screen.queryByText(/v3 -> v4/)).toBeNull();
  });

  it('triggers onConfirm when user clicks confirm button', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <SceneMigrationConfirmationDialog
        request={baseRequest}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const confirmBtn = screen.getByRole('button', { name: '确认升级' });
    fireEvent.click(confirmBtn);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('triggers onCancel when user clicks cancel or close button', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <SceneMigrationConfirmationDialog
        request={baseRequest}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const cancelBtn = screen.getByRole('button', { name: '取消' });
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);

    const closeBtn = screen.getByRole('button', { name: '取消升级' });
    fireEvent.click(closeBtn);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

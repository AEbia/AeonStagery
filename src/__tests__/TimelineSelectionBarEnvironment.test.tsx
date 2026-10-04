/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LooseTimelineAction as SceneAction } from './fixtures/TimelineTestTypes';
import { TimelineSelectionBar } from '../ui/timeline/TimelineSelectionBar';

describe('TimelineSelectionBar environment summary', () => {
  it('does not expose the raw environment layer id for environment actions', () => {
    const action = {
      _id: 'env_1',
      action: 'transformEnvironmentLayer',
      time: 2,
      params: {
        layerId: 'fog-layer-internal',
        duration: 1.5,
      },
    } as SceneAction;

    render(
      <TimelineSelectionBar
        selectedCount={1}
        action={action}
        trackLabel="环境画面"
        issueCount={0}
        hasRepeatWarning={false}
        canSplit={false}
        onSeek={vi.fn()}
        onReveal={vi.fn()}
        onClear={vi.fn()}
        onCopy={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        onSplit={vi.fn()}
        onAlignToPlayhead={vi.fn()}
        onSelectAdjacent={vi.fn()}
        onChangeTrack={vi.fn()}
      />,
    );

    expect(screen.getByTestId('timeline-selection-bar').textContent).not.toContain('fog-layer-internal');
    expect(screen.getAllByText('环境画面').length).toBeGreaterThan(0);
  });
});

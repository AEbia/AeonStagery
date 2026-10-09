/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchableSelect } from '../ui/SearchableSelect';
import { resolveCharacterModelHints } from '../ui/timeline/inspector/paramControls/motionPickers';

function openDropdown() {
  fireEvent.click(screen.getByRole('combobox'));
}

describe('SearchableSelect hierarchical multi-column protocol', () => {
  afterEach(() => {
    cleanup();
  });

  const sampleOptions = [
    'avemujica/mutsumi/mtn_angry01_C_live_01',
    'avemujica/sakiko/mtn_smile01_C_live_01',
    'mygo/anon/mtn_angry01_C_casual_spring_01',
    'mygo/anon/mtn_angry01_C_live_01',
    'mygo/anon/mtn_angry01_L_live_01',
    'mygo/anon/mtn_bye01_C_live_01',
    'mygo/anon/exp_angry01',
    'mygo/soyo/mtn_smile01_C_live_01',
  ];

  it('renders a 3-column cascading layout when options contain 3-level slash keys', () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect
        value=""
        options={sampleOptions}
        onChange={onChange}
      />,
    );
    openDropdown();

    // Primary group column (Level 1, e.g. Band)
    const primaryList = screen.getByRole('listbox', { name: '一级分组' });
    expect(primaryList).toBeTruthy();
    expect(screen.getByRole('option', { name: 'avemujica' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'mygo' })).toBeTruthy();

    // Secondary group column (Level 2, e.g. Character)
    const secondaryList = screen.getByRole('listbox', { name: '二级分组' });
    expect(secondaryList).toBeTruthy();

    // Clicking 'mygo' updates Level 2 options to anon and soyo
    fireEvent.click(screen.getByRole('option', { name: 'mygo' }));
    expect(screen.getByRole('option', { name: 'anon' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'soyo' })).toBeTruthy();

    // Clicking 'anon' shows anon options in options list
    fireEvent.click(screen.getByRole('option', { name: 'anon' }));
    expect(screen.getByRole('option', { name: 'mtn_bye01_C_live_01' })).toBeTruthy();

    // Preserves original clean a/b -> b (or a/b/c -> c) leaf label
    const optionBtn = screen.getByRole('option', { name: 'mtn_bye01_C_live_01' });
    expect(optionBtn.textContent).toBe('mtn_bye01_C_live_01');

    // Selecting an option passes the full raw key
    fireEvent.click(optionBtn);
    expect(onChange).toHaveBeenCalledWith('mygo/anon/mtn_bye01_C_live_01');
  });

  it('preserves the standard 2-column layout and styling for regular a/b options without losing any motion', () => {
    const onChange = vi.fn();
    const dualPaneOptions = [
      'idle/idle_01',
      'idle/idle_02',
      'tap_body/tap_01',
      'special/dance',
    ];

    render(
      <SearchableSelect
        value=""
        options={dualPaneOptions}
        onChange={onChange}
      />,
    );
    openDropdown();

    // Should NOT have tri-pane secondary column
    expect(screen.queryByRole('listbox', { name: '二级分组' })).toBeNull();

    // Should have standard 2-column group list
    const groupList = screen.getByRole('listbox', { name: '选项分组' });
    expect(groupList).toBeTruthy();
    expect(screen.getByRole('option', { name: 'idle' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'tap_body' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'special' })).toBeTruthy();

    // Options for initial group ('idle') are visible
    expect(screen.getByRole('option', { name: 'idle_01' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'idle_02' })).toBeTruthy();

    // Switching group to 'tap_body' shows tap_01
    fireEvent.click(screen.getByRole('option', { name: 'tap_body' }));
    expect(screen.getByRole('option', { name: 'tap_01' })).toBeTruthy();

    // Switching group to 'special' shows dance
    fireEvent.click(screen.getByRole('option', { name: 'special' }));
    expect(screen.getByRole('option', { name: 'dance' })).toBeTruthy();

    // Clicking option emits full a/b key
    fireEvent.click(screen.getByRole('option', { name: 'dance' }));
    expect(onChange).toHaveBeenCalledWith('special/dance');
  });

  it('does NOT jump back to value group when user clicks a different group in a/b mode', () => {
    const onChange = vi.fn();
    const dualPaneOptions = [
      'idle/idle_01',
      'idle/idle_02',
      'tap_body/tap_01',
      'special/dance',
    ];

    render(
      <SearchableSelect
        value="idle/idle_01"
        options={dualPaneOptions}
        onChange={onChange}
      />,
    );
    openDropdown();

    // Initially idle is active because value="idle/idle_01"
    expect(screen.getByRole('option', { name: 'idle' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', { name: 'idle_01' })).toBeTruthy();

    // Click 'tap_body' to switch group
    fireEvent.click(screen.getByRole('option', { name: 'tap_body' }));

    // tap_body must remain selected! It must NOT jump back to idle!
    expect(screen.getByRole('option', { name: 'tap_body' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', { name: 'tap_01' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'idle_01' })).toBeNull();
  });

  it('seamlessly supports mixed a/b/c and a/b options in the same model without losing any motion', () => {
    const onChange = vi.fn();
    const mixedOptions = [
      'common/stand',
      'common/blink',
      'mygo/anon/mtn_angry01',
      'mygo/soyo/mtn_smile01',
      'avemujica/mutsumi/mtn_cry01',
    ];

    render(
      <SearchableSelect
        value=""
        options={mixedOptions}
        preferredGroup="mygo/anon"
        onChange={onChange}
      />,
    );
    openDropdown();

    // With preferredGroup="mygo/anon", mygo is active and secondary column has anon and soyo
    expect(screen.getByRole('listbox', { name: '一级分组' })).toBeTruthy();
    expect(screen.getByRole('listbox', { name: '二级分组' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'mtn_angry01' })).toBeTruthy();

    // Now click 'common' (which has 2-segment a/b options: common/stand, common/blink)
    fireEvent.click(screen.getByRole('option', { name: 'common' }));

    // Secondary column hides because 'common' has no sub-groups
    expect(screen.queryByRole('listbox', { name: '二级分组' })).toBeNull();

    // 'common' options (stand and blink) are completely visible and NOT lost!
    expect(screen.getByRole('option', { name: 'stand' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'blink' })).toBeTruthy();

    // Clicking 'stand' emits full 'common/stand' key
    fireEvent.click(screen.getByRole('option', { name: 'stand' }));
    expect(onChange).toHaveBeenCalledWith('common/stand');
  });

  it('auto-selects preferredGroup when value is empty in 3-column mode', () => {
    render(
      <SearchableSelect
        value=""
        options={sampleOptions}
        preferredGroup="mygo/anon"
        onChange={vi.fn()}
      />,
    );
    openDropdown();

    // With preferredGroup="mygo/anon", mygo and anon are auto-selected
    const mygoOpt = screen.getByRole('option', { name: 'mygo' });
    expect(mygoOpt.getAttribute('aria-selected')).toBe('true');

    const anonOpt = screen.getByRole('option', { name: 'anon' });
    expect(anonOpt.getAttribute('aria-selected')).toBe('true');

    // Anon options are immediately visible
    expect(screen.getByRole('option', { name: 'mtn_bye01_C_live_01' })).toBeTruthy();
  });

  it('supports multi-token search across bands, characters, and actions', () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect
        value=""
        options={sampleOptions}
        onChange={onChange}
      />,
    );
    openDropdown();

    const searchbox = screen.getByRole('searchbox', { name: '搜索选项' });
    fireEvent.change(searchbox, { target: { value: 'anon bye' } });

    // Should match mygo/anon/mtn_bye01_C_live_01
    expect(screen.getByRole('option', { name: /mtn_bye01_C_live_01/ })).toBeTruthy();
    // Non-matching options should not appear
    expect(screen.queryByRole('option', { name: /mtn_smile01_C_live_01/ })).toBeNull();

    // Group columns should be hidden when searching
    expect(screen.queryByRole('listbox', { name: '一级分组' })).toBeNull();
    expect(screen.queryByRole('listbox', { name: '二级分组' })).toBeNull();
  });

  it('caps search results to 100 items to avoid DOM lag', () => {
    // Generate 150 options
    const largeOptions = Array.from({ length: 150 }, (_, i) => `mygo/anon/mtn_motion_${String(i).padStart(3, '0')}`);
    render(
      <SearchableSelect
        value=""
        options={largeOptions}
        onChange={vi.fn()}
      />,
    );
    openDropdown();

    const searchbox = screen.getByRole('searchbox', { name: '搜索选项' });
    fireEvent.change(searchbox, { target: { value: 'motion' } });

    // Max 100 options rendered
    const renderedOptions = screen.getAllByRole('option');
    expect(renderedOptions.length).toBe(100);

    // Truncation note displayed
    expect(screen.getByText('已显示前 100 条匹配项，共 150 条')).toBeTruthy();
  });

  it('correctly resolves model hints from complex figure model paths', () => {
    const hints = resolveCharacterModelHints(
      'anon',
      { id: 'anon', name: '千早爱音' },
      'C:\\games\\figure\\mygo\\anon\\live_01\\model.model3.json',
    );

    expect(hints.preferredGroup).toBe('mygo/anon');
  });
});

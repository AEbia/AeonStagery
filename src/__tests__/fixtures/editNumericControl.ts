import { fireEvent } from '@testing-library/react';

/** Enter a precise value through the workbench scrubber's own edit mode. */
export function editNumericControl(control: HTMLElement, value: string) {
  const scrubber = control.matches('[role="spinbutton"]')
    ? control : control.querySelector<HTMLElement>('[role="spinbutton"]');
  if (!scrubber) throw new Error('Numeric scrubber not found');
  const parent = scrubber.parentElement!;
  fireEvent.keyDown(scrubber, { key: 'Enter' });
  const input = parent.querySelector<HTMLInputElement>('input.scrubbable-input-mode');
  if (!input) throw new Error('Numeric edit mode did not open');
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

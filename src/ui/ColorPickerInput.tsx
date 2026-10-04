import React, { useCallback, useEffect, useRef } from 'react';

export interface ColorPickerInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'defaultValue' | 'onChange'
> {
  value: string;
  onChange: (color: string) => void;
}

function normalizeColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : '#ffffff';
}

export const ColorPickerInput = React.memo(({
  value,
  onChange,
  ...inputProps
}: ColorPickerInputProps) => {
  const safeColor = normalizeColor(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  const latestColorRef = useRef(safeColor);
  const committedColorRef = useRef(safeColor);
  const previousPropColorRef = useRef(safeColor);
  onChangeRef.current = onChange;

  const commitColor = useCallback((color: string) => {
    const nextColor = normalizeColor(color);
    latestColorRef.current = nextColor;
    if (nextColor === committedColorRef.current) return;
    committedColorRef.current = nextColor;
    onChangeRef.current(nextColor);
  }, []);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    const commitNativeValue = () => commitColor(input.value);
    input.addEventListener('change', commitNativeValue);
    input.addEventListener('blur', commitNativeValue);
    return () => {
      input.removeEventListener('change', commitNativeValue);
      input.removeEventListener('blur', commitNativeValue);
    };
  }, [commitColor]);

  useEffect(() => {
    if (previousPropColorRef.current === safeColor) return;
    previousPropColorRef.current = safeColor;

    // Keep a newer local drag value visible while waiting for the picker to commit.
    if (latestColorRef.current !== committedColorRef.current) return;

    latestColorRef.current = safeColor;
    committedColorRef.current = safeColor;
    if (inputRef.current && inputRef.current.value !== safeColor) {
      inputRef.current.value = safeColor;
    }
  }, [safeColor]);

  // Keep the native value local during a drag; React only receives the final
  // committed value from the native change/blur listeners above.
  return (
    <input
      {...inputProps}
      ref={inputRef}
      type="color"
      defaultValue={safeColor}
      onChange={(event) => {
        latestColorRef.current = normalizeColor(event.currentTarget.value);
      }}
    />
  );
});

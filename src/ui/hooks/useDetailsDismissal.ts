import { useCallback, useEffect, useRef } from 'react';
import { useOutsidePointerDown } from './useOutsidePointerDown';

/** Closes a native details dropdown when interaction moves outside it or Escape is pressed. */
export function useDetailsDismissal() {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const dismiss = useCallback(() => {
    if (detailsRef.current) detailsRef.current.open = false;
  }, []);

  useOutsidePointerDown(detailsRef, dismiss);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const details = detailsRef.current;
      if (event.key !== 'Escape' || !details?.open) return;

      event.preventDefault();
      dismiss();
      details.querySelector('summary')?.focus();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [dismiss]);

  return detailsRef;
}

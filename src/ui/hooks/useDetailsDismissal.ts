import { useEffect, useRef } from 'react';
import { useOutsidePointerDown } from './useOutsidePointerDown';

/** Keep native details menus dismissible without taking focus on outside clicks. */
export function useDetailsDismissal() {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useOutsidePointerDown(detailsRef, () => {
    if (detailsRef.current?.open) detailsRef.current.open = false;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const details = detailsRef.current;
      if (event.key !== 'Escape' || event.defaultPrevented || !details?.open) return;
      event.preventDefault();
      details.open = false;
      details.querySelector('summary')?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return detailsRef;
}

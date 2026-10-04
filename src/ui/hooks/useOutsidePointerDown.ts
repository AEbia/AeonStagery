import { useEffect, useRef, type RefObject } from 'react';

interface OutsidePointerDownRegistration {
  containerRef: RefObject<HTMLElement | null>;
  additionalInsideRefsRef: RefObject<ReadonlyArray<RefObject<HTMLElement | null>>>;
  onOutsideRef: RefObject<() => void>;
}

const registrations = new Set<OutsidePointerDownRegistration>();

const handleDocumentPointerDown = (event: PointerEvent) => {
  for (const registration of registrations) {
    const target = event.target as Node;
    const containers = [registration.containerRef.current, ...(registration.additionalInsideRefsRef.current ?? []).map((ref) => ref.current)];
    if (containers.some((container) => container?.contains(target))) {
      continue;
    }

    if (registration.containerRef.current) {
      registration.onOutsideRef.current?.();
    }
  }
};

export function useOutsidePointerDown(
  containerRef: RefObject<HTMLElement | null>,
  onOutside: () => void,
  additionalInsideRefs: ReadonlyArray<RefObject<HTMLElement | null>> = [],
) {
  const onOutsideRef = useRef(onOutside);
  const additionalInsideRefsRef = useRef(additionalInsideRefs);
  onOutsideRef.current = onOutside;
  additionalInsideRefsRef.current = additionalInsideRefs;

  useEffect(() => {
    const registration = { containerRef, additionalInsideRefsRef, onOutsideRef };
    registrations.add(registration);
    if (registrations.size === 1) {
      document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    }

    return () => {
      registrations.delete(registration);
      if (registrations.size === 0) {
        document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      }
    };
  }, [containerRef]);
}

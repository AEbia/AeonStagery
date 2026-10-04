import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface ModalDialogRegistration {
  dialogRef: RefObject<HTMLDivElement | null>;
  onCloseRef: RefObject<() => void>;
  previouslyFocused: HTMLElement | null;
}

const registrations: ModalDialogRegistration[] = [];

const getFocusableElements = (dialog: HTMLElement) => (
  Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && !element.closest('[hidden], [aria-hidden="true"], [inert]'))
);

const handleDocumentKeyDown = (event: KeyboardEvent) => {
  if (event.defaultPrevented || event.isComposing) return;

  const registration = registrations[registrations.length - 1];
  const dialog = registration?.dialogRef.current;
  if (!registration || !dialog) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    registration.onCloseRef.current?.();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = getFocusableElements(dialog);
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeElement = document.activeElement;
  if (!dialog.contains(activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  } else if (event.shiftKey && activeElement === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
};

export function useModalDialog(
  onClose: () => void,
  active = true,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;

    const registration: ModalDialogRegistration = {
      dialogRef,
      onCloseRef,
      previouslyFocused: document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
    };
    registrations.push(registration);
    if (registrations.length === 1) {
      document.addEventListener('keydown', handleDocumentKeyDown);
    }

    const dialog = dialogRef.current;
    const initialFocus = initialFocusRef?.current
      ?? (dialog ? getFocusableElements(dialog)[0] ?? dialog : null);
    initialFocus?.focus({ preventScroll: true });

    return () => {
      const registrationIndex = registrations.indexOf(registration);
      const wasTopmost = registrationIndex === registrations.length - 1;
      if (registrationIndex >= 0) registrations.splice(registrationIndex, 1);
      if (!wasTopmost) {
        const nextRegistration = registrations[registrationIndex];
        if (nextRegistration && !nextRegistration.previouslyFocused?.isConnected) {
          nextRegistration.previouslyFocused = registration.previouslyFocused;
        }
      }
      if (registrations.length === 0) {
        document.removeEventListener('keydown', handleDocumentKeyDown);
      }
      if (wasTopmost && registration.previouslyFocused?.isConnected) {
        registration.previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [active, initialFocusRef]);

  return dialogRef;
}

/** Panels can keep their inactive content mounted, so skip hidden matches. */
export const findVisibleGuideTarget = (selector: string): HTMLElement | null => {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (element.closest('[hidden]')) continue;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
      return element;
    }
  }
  return null;
};

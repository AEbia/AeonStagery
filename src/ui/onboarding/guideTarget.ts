/** A portal spotlight must respect the target's clipping ancestors. */
export const getGuideTargetClipBounds = (element: HTMLElement) => {
  const bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow);
    const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow);
    if (!clipsX && !clipsY) continue;
    const rect = ancestor.getBoundingClientRect();
    const left = rect.left + ancestor.clientLeft;
    const top = rect.top + ancestor.clientTop;
    if (clipsX) {
      bounds.left = Math.max(bounds.left, left);
      bounds.right = Math.min(bounds.right, ancestor.clientWidth > 0
        ? left + ancestor.clientWidth
        : rect.right - (parseFloat(style.borderRightWidth) || 0));
    }
    if (clipsY) {
      bounds.top = Math.max(bounds.top, top);
      bounds.bottom = Math.min(bounds.bottom, ancestor.clientHeight > 0
        ? top + ancestor.clientHeight
        : rect.bottom - (parseFloat(style.borderBottomWidth) || 0));
    }
  }
  return bounds;
};

/** Panels can keep their inactive content mounted, so skip hidden matches. */
export const findVisibleGuideTarget = (selector: string): HTMLElement | null => {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (element.closest('[hidden]')) continue;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
      const bounds = getGuideTargetClipBounds(element);
      if (Math.min(rect.right, bounds.right) <= Math.max(rect.left, bounds.left)
        || Math.min(rect.bottom, bounds.bottom) <= Math.max(rect.top, bounds.top)) continue;
      return element;
    }
  }
  return null;
};

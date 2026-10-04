import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * 视口缩放统一边界。舞台渲染器(StageManager)始终把 canvas 以 CSS
 * 适配容器大小,因此 zoom=1 即"适配窗口",zoom 是其上的放大倍率。
 * 滚轮、HUD 按钮、重置动作共用同一组常量,避免不同入口钳制范围不一致
 * 导致按钮在越界后反向生效。
 */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 10;
const ZOOM_STEP = 1.2;

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function useViewport(stageRef: React.RefObject<HTMLDivElement>, enabled = true) {
  const [viewport, setViewport] = useState({ zoom: 1, x: 0, y: 0 });
  const lastMousePos = useRef({ x: 0, y: 0 });
  const isPanning = useRef(false);

  const handleStageWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const zoomSpeed = 0.001;
    const delta = -e.deltaY;
    setViewport(prev => {
      const newZoom = clampZoom(prev.zoom + delta * zoomSpeed * prev.zoom);
      return { ...prev, zoom: newZoom };
    });
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !enabled) return;

    // React 的 onWheel 使用 passive 监听，无法取消滚动；自定义缩放需显式禁用 passive。
    stage.addEventListener('wheel', handleStageWheel, { passive: false });
    return () => stage.removeEventListener('wheel', handleStageWheel);
  }, [stageRef, enabled, handleStageWheel]);

  const handleStageMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) {
      isPanning.current = true;
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    }
  }, []);

  /** 完整复位:回到适配窗口(100%)并回中。 */
  const handleStageReset = useCallback(() => {
    setViewport({ zoom: 1, x: 0, y: 0 });
  }, []);

  /** 仅重置缩放到 100%(适配窗口基准),保留当前平移。 */
  const handleResetZoom = useCallback(() => {
    setViewport(prev => ({ ...prev, zoom: 1 }));
  }, []);

  /** 仅回中(清零平移),保留当前缩放。 */
  const handleRecenter = useCallback(() => {
    setViewport(prev => ({ ...prev, x: 0, y: 0 }));
  }, []);

  const handleZoomIn = useCallback(() => {
    setViewport(prev => ({ ...prev, zoom: clampZoom(Number((prev.zoom * ZOOM_STEP).toFixed(2))) }));
  }, []);

  const handleZoomOut = useCallback(() => {
    setViewport(prev => ({ ...prev, zoom: clampZoom(Number((prev.zoom / ZOOM_STEP).toFixed(2))) }));
  }, []);

  useEffect(() => {
    const handleGlobalMove = (e: MouseEvent) => {
      if (!isPanning.current) return;
      const dx = e.clientX - lastMousePos.current.x;
      const dy = e.clientY - lastMousePos.current.y;
      setViewport(prev => ({
        ...prev,
        x: prev.x + dx,
        y: prev.y + dy,
      }));
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    };
    const handleGlobalUp = () => {
      isPanning.current = false;
      document.body.style.cursor = 'default';
    };
    window.addEventListener('mousemove', handleGlobalMove);
    window.addEventListener('mouseup', handleGlobalUp);
    return () => {
      window.removeEventListener('mousemove', handleGlobalMove);
      window.removeEventListener('mouseup', handleGlobalUp);
    };
  }, []);

  return {
    viewport,
    handleStageMouseDown,
    handleStageReset,
    handleResetZoom,
    handleRecenter,
    handleZoomIn,
    handleZoomOut,
    isPanning,
  };
}

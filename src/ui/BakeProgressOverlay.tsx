import { useState, useEffect } from 'react';
import { eventBus } from '../api/events';

export function BakeProgressOverlay() {
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const unsubStart = eventBus.on('bake:start', (data: any) => {
      setVisible(true);
      setProgress(0);
      setStatus(`正在预烘焙: ${data.title || '当前剧本'}`);
    });

    let lastUpdate = 0;
    const unsubProgress = eventBus.on('bake:progress', (data: any) => {
      const now = Date.now();
      // Throttle progress updates to ~10fps to save CPU for the engine
      if (now - lastUpdate > 100) {
        setProgress(data.progress * 100);
        lastUpdate = now;
      }
    });

    const unsubComplete = eventBus.on('bake:complete', () => {
      setStatus('烘焙完成');
      setProgress(100); // Final update is never swallowed
      setTimeout(() => setVisible(false), 1500);
    });

    const unsubCancel = eventBus.on('bake:cancel', () => {
      setVisible(false);
    });

    return () => {
      unsubStart();
      unsubProgress();
      unsubComplete();
      unsubCancel();
    };
  }, []);

  if (!visible) return null;

  return (
    <div className="bake-overlay" role="status" aria-live="polite" aria-atomic="true">
      <div className="bake-overlay__content">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 11, fontWeight: 600 }}>
          <span>{status}</span>
          <span className="tabular-nums">{Math.round(progress)}%</span>
        </div>
        <div
          className="bake-overlay__bar"
          role="progressbar"
          aria-label="预烘焙进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
          aria-valuetext={`${status}，${Math.round(progress)}%`}
        >
          <div className="bake-overlay__fill" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </div>
  );
}

export default BakeProgressOverlay;

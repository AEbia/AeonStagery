import { memo } from 'react';
import { createPortal } from 'react-dom';
import { useModalDialog } from '../hooks/useModalDialog';

interface MarkerPromptState {
  time: number;
}

interface MarkerPromptProps {
  prompt: MarkerPromptState | null;
  onComplete: (time: number, label: string) => void;
  onCancel: () => void;
}

export const MarkerPrompt = memo(({
  prompt,
  onComplete,
  onCancel,
}: MarkerPromptProps) => {
  const dialogRef = useModalDialog(onCancel, !!prompt);

  if (!prompt) return null;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 10000, // Top priority root-level Portal modal dialog backdrop
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="marker-prompt-title"
        style={{
          background: 'var(--bg-secondary)',
          padding: 20,
          borderRadius: 'var(--radius-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          minWidth: 300,
          border: '1px solid var(--border-default)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
        }}
      >
        <label id="marker-prompt-title" htmlFor="marker-input" style={{ fontSize: 14, fontWeight: 'bold', color: 'var(--text-primary)' }}>
          输入标记名称:
        </label>
        <input
          id="marker-input" 
          aria-labelledby="marker-prompt-title"
          style={{
            padding: '8px 12px',
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
            borderRadius: 'var(--radius-sm)',
            outline: 'none',
          }} 
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const label = (e.target as HTMLInputElement).value || 'Marker';
              onComplete(prompt.time, label);
            }
          }}
        />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 10 }}>
          <button 
            style={{
              padding: '6px 16px',
              background: 'var(--bg-hover)',
              color: 'var(--text-secondary)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
            onClick={onCancel}
          >
            取消
          </button>
          <button 
            style={{
              padding: '6px 16px',
              background: 'var(--accent-primary)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
            onClick={() => {
              const label = (document.getElementById('marker-input') as HTMLInputElement).value || 'Marker';
              onComplete(prompt.time, label);
            }}
          >
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
});

MarkerPrompt.displayName = 'MarkerPrompt';

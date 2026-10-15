import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useModalDialog } from './hooks/useModalDialog';
import './projectRenameDialog.css';

interface ProjectRenameDialogProps {
  name: string;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}

export function ProjectRenameDialog({ name, onSave, onClose }: ProjectRenameDialogProps) {
  const [draft, setDraft] = useState(name);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();
  const close = () => { if (!savingRef.current) onClose(); };
  const dialogRef = useModalDialog(close, true, inputRef);

  useEffect(() => { inputRef.current?.select(); }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = draft.trim();
    if (!trimmedName || savingRef.current) return;
    if (trimmedName === name) { onClose(); return; }
    savingRef.current = true;
    setIsSaving(true);
    setError(null);
    try {
      await onSave(trimmedName);
      onClose();
    } catch (cause: unknown) {
      setError(`重命名失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialogRef} className="modal project-rename-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <form
          onSubmit={(event) => { void handleSubmit(event); }}
          onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}
        >
          <div className="modal__header" id={titleId}>重命名项目</div>
          <div className="project-rename-dialog__body">
            <label htmlFor={inputId}>项目名称</label>
            <input
              ref={inputRef}
              id={inputId}
              className="form-input"
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setError(null); }}
              disabled={isSaving}
              required
              aria-invalid={!!error || !draft.trim()}
              aria-describedby={error ? errorId : undefined}
            />
            {error && <p id={errorId} className="project-rename-dialog__error" role="alert">{error}</p>}
          </div>
          <div className="modal__footer">
            <button type="button" className="btn" disabled={isSaving} onClick={close}>取消</button>
            <button type="submit" className="btn btn--primary" disabled={isSaving || !draft.trim()}>{isSaving ? '保存中…' : '保存'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

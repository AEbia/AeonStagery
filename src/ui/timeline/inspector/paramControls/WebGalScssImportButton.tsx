import { useCallback, useState } from 'react';
import type { WebGalScssImportInspection } from '../../../../api/types/template-package-import';
import { showToast } from '../../../Toast';
import { WebGalScssImportDialog, type WebGalScssImportChoice } from '../../../WebGalScssImportDialog';
import { IconFolder } from '../../../icons';
import type { WebGalStyleImportActions } from './context';

export interface WebGalScssImportButtonProps {
  /**
   * Import actions supplied by the host. Injected rather than read from a global
   * so this component stays testable and a host without the feature simply does
   * not render it.
   */
  readonly importer: WebGalStyleImportActions;
}

/**
 * Import a WebGAL `textbox.scss` template into the dialogue style list.
 *
 * Sits next to the style dropdown, which is where a user looks when they want a
 * different subtitle look. It only drives the flow; picking the directory,
 * converting and writing the package all happen behind {@link importer}.
 */
export function WebGalScssImportButton({ importer }: WebGalScssImportButtonProps) {
  const [inspection, setInspection] = useState<WebGalScssImportInspection | null>(null);
  const [busy, setBusy] = useState(false);

  const handleInspect = useCallback(async () => {
    setBusy(true);
    try {
      // A null result means cancelled or unreadable; the host has already
      // reported the reason.
      const next = await importer.inspect();
      if (next) setInspection(next);
    } finally {
      setBusy(false);
    }
  }, [importer]);

  const handleConfirm = useCallback(async (choice: WebGalScssImportChoice) => {
    if (!inspection) return;
    setBusy(true);
    try {
      const result = await importer.install({
        templateRoot: inspection.templateRoot,
        packageName: choice.packageName,
        ...(choice.replacePackageId ? { replacePackageId: choice.replacePackageId } : {}),
      });
      if (result.ok) setInspection(null);
      showToast(result.message, result.ok ? 'success' : 'error');
    } finally {
      setBusy(false);
    }
  }, [importer, inspection]);

  return (
    <>
      <button
        type="button"
        className="btn btn--icon"
        onClick={() => void handleInspect()}
        disabled={busy}
        title="从 WebGAL 模板导入对话框样式（选择模板目录）"
        aria-label="从 WebGAL 模板导入对话框样式"
      >
        <IconFolder width={14} height={14} />
      </button>
      {inspection && (
        <WebGalScssImportDialog
          inspection={inspection}
          busy={busy}
          onCancel={() => setInspection(null)}
          onConfirm={(choice) => void handleConfirm(choice)}
        />
      )}
    </>
  );
}

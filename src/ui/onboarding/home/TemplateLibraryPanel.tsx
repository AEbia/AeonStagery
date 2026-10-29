import { useState } from 'react';
import { IconPlus } from '../../icons';
import { TemplatePackageSelector } from '../../templates/TemplateCapabilityConfig';
import type { ProjectHomeProps } from '../ProjectHome';

type Props = Pick<ProjectHomeProps, 'templatePackages' | 'onImportTemplatePackage' | 'onDeleteTemplatePackage'>;

export function TemplateLibraryPanel({ templatePackages, onImportTemplatePackage, onDeleteTemplatePackage }: Props) {
  const [isImporting, setIsImporting] = useState(false);
  const handleImport = async () => {
    if (isImporting) return;
    setIsImporting(true);
    try { await onImportTemplatePackage(); }
    finally { setIsImporting(false); }
  };
  return <section className="ph-templates" aria-label="模板包">
    <TemplatePackageSelector compact packages={templatePackages ?? []} onDeletePackage={onDeleteTemplatePackage}
      headerActions={<button type="button" className="btn ph-btn-compact" disabled={isImporting}
        title="安装 ZIP 到应用专用模板库" onClick={() => { void handleImport(); }}>
        <IconPlus width={13} height={13} /> {isImporting ? '正在导入模板…' : '导入模板包'}
      </button>} />
  </section>;
}

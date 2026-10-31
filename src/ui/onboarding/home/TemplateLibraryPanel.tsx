import { useState } from 'react';
import { IconPlus } from '../../icons';
import { Tooltip } from '../../Tooltip';
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
      headerActions={<Tooltip content="将 ZIP 模板包安装到应用模板库。"><button type="button" className="btn ph-btn-compact" disabled={isImporting}
        onClick={() => { void handleImport(); }}>
        <IconPlus width={13} height={13} /> {isImporting ? '正在导入模板…' : '导入模板包'}
      </button></Tooltip>} />
  </section>;
}

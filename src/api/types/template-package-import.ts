export interface ImportedTemplatePackageSummary {
  id: string;
  name: string;
  version: string;
  installPath: string;
  replaced: boolean;
}

export type TemplatePackageImportResult =
  | { success: true; package: ImportedTemplatePackageSummary }
  | { success: false; canceled?: boolean; error?: string };


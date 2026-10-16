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

/**
 * A WebGAL dialogue template that appears to duplicate something installed.
 *
 * Independent signals are reported separately rather than collapsed into
 * one flag, so the dialog can say *why* it thinks the import is a duplicate:
 * `contentMatch` compares the normalised stylesheet, `paramsMatch` compares the
 * parameters it translates to (the only signal available for packages imported
 * before the source was recorded). `sourceMatch` identifies an update from
 * the same directory even when the stylesheet and resulting parameters changed.
 */
export interface WebGalScssImportConflict {
  packageId: string;
  packageName: string;
  contentMatch: boolean;
  paramsMatch: boolean;
  sourceMatch?: boolean;
  /**
   * Whether replacing this package is safe.
   *
   * An import writes exactly one dialogue style, so a package that publishes
   * several cannot be overwritten wholesale: the styles this PR does not
   * reproduce — and the assets only they reference — would be dropped, taking
   * every scene that uses them with it. Such a package is reported as a
   * duplicate, but only "keep as a separate package" is offered.
   */
  replaceable: boolean;
  importedAt?: string;
  sourcePath?: string;
}

/** Result of reading a template directory, before anything is written. */
export interface WebGalScssImportInspection {
  templateRoot: string;
  /** Name declared by the template's `template.json`, or its directory name. */
  templateName: string;
  /** Suggested package display name, already free of collisions. */
  packageName: string;
  /** Suggested package id, already free of collisions. */
  packageId: string;
  styleId: string;
  styleName: string;
  /** File name the stylesheet was read from. */
  sourceName: string;
  /** Fingerprint of the normalised stylesheet. */
  sourceHash: string;
  /** Fingerprint of the translated parameters. */
  paramsSignature: string;
  conflicts: WebGalScssImportConflict[];
  /**
   * Installed packages whose stylesheet could not be compared because the import
   * predates source recording. Surfaced so "no conflicts" is not read as "new".
   */
  unverifiableCount: number;
  /** Display names already taken, so the dialog can offer a free one. */
  takenPackageNames: string[];
  /** Human-readable record of the conversion decisions. */
  notes: string[];
}

export type WebGalScssImportInspectResult =
  | { success: true; inspection: WebGalScssImportInspection }
  | { success: false; canceled?: boolean; error?: string };

export interface WebGalScssImportInstallRequest {
  /** WebGAL template directory chosen in the inspection step. */
  templateRoot: string;
  /** Final display name; sanitised and de-duplicated again in the main process. */
  packageName?: string;
  /** Final package id; derived from the display name when omitted. */
  packageId?: string;
  styleName?: string;
  /**
   * Replace this installed package instead of adding another one. Keeps the
   * package id and dialogue style id, so scenes referencing the style keep
   * working.
   */
  replacePackageId?: string;
}

export type WebGalScssImportInstallResult =
  | { success: true; package: ImportedTemplatePackageSummary }
  | { success: false; canceled?: boolean; error?: string };

export interface TemplatePackageDeleteRequest {
  id: string;
  packageRoot: string;
}

export type TemplatePackageDeleteResult =
  | { success: true; id: string }
  | { success: false; canceled?: boolean; error?: string };

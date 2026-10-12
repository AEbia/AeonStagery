/**
 * Assemble a WebGAL dialogue template into an AeonStagery template package.
 *
 * This is the third and last layer of the SCSS importer: {@link WebGalScssSyntax}
 * parses, {@link WebGalTextboxScssTranslator} maps the stylesheet onto
 * `image-dialogue-v1` parameters, {@link WebGalTextboxScssAssets} draws the
 * panel artwork, and this module writes the manifest that ties them together.
 *
 * Everything here is a pure function of its input: the returned file list is
 * plain data, so the same builder backs both the `import:webgal-template`
 * command and an in-app import button, which only have to write the files out.
 */
import { SCENE_SCHEMA_VERSION } from '../../../api/types/semantic-scene';
import { parseTemplatePackageManifest, type TemplatePackageManifest } from '../../template-package/TemplatePackageManifest';
import {
  buildWebGalScssAssetTable,
  rewriteWebGalScssImageParams,
  type WebGalScssDecorationSources,
} from './WebGalTextboxScssAssets';
import {
  translateWebGalTextboxScss,
  type WebGalDialogueParams,
  type WebGalDialogueStyle,
} from './WebGalTextboxScssTranslator';

/** Directory holding every generated image, mirroring the built-in packages. */
export const WEBGAL_PACKAGE_ASSET_ROOT = 'assets';

/** A font shipped inside the WebGAL template, referenced from `template.json`. */
export interface WebGalTemplatePackageFont {
  /** Family as declared by the template; the SCSS itself rarely names one. */
  family: string;
  /** Absolute path of the font file inside the WebGAL template directory. */
  sourcePath: string;
}

export interface WebGalTemplatePackageInput {
  /** Raw `Stage/TextBox/textbox.scss` source. */
  scss: string;
  /**
   * Template package id, also used as the package directory name and as the
   * dialogue style id. Style ids are de-duplicated **across** packages, so it
   * must not be shared with another import — two templates both deriving
   * `webgal-textbox` from their stylesheet name would silently displace each
   * other in the style list.
   */
  templateId: string;
  /** Display name, shown in the dialogue style list. */
  templateName: string;
  version?: string;
  author?: string;
  description?: string;
  /** Stylesheet file name; only used by the translator for its diagnostics. */
  sourceName?: string;
  /** Dialogue style id; defaults to `templateId` so it stays unique. */
  styleId?: string;
  /** Dialogue style label; defaults to `templateName`. */
  styleName?: string;
  font?: WebGalTemplatePackageFont | null;
  /** Sources of the `::after` ornaments referenced by the theme. */
  decoSources?: WebGalScssDecorationSources | null;
  /** Force the text column to the canvas centre instead of honouring `left`/`right`. */
  strictCenter?: boolean;
}

export interface WebGalTemplatePackageFile {
  /** Path inside the package, always POSIX-separated. */
  relativePath: string;
  /** Text content. Mutually exclusive with {@link sourcePath}. */
  contents?: string;
  /**
   * Absolute path to copy verbatim. Fonts are binary and usually large, so the
   * builder points at them instead of reading them into memory — which also
   * keeps this module usable where the filesystem is not directly reachable.
   */
  sourcePath?: string;
}

export interface WebGalTemplatePackageBuild {
  manifest: TemplatePackageManifest;
  /** Every file of the package, manifest included. */
  files: WebGalTemplatePackageFile[];
  style: WebGalDialogueStyle;
  notes: string[];
}

/** POSIX basename. Avoids `node:path` so the module also runs in the renderer. */
function baseName(filePath: string): string {
  const parts = String(filePath ?? '').split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * Build the package for one WebGAL dialogue template.
 *
 * The manifest is re-parsed with the engine's own validator before it is
 * returned. That check is the point of this function: a single unrecognised key
 * anywhere under `dialogueStyles[].params` makes the engine discard the entire
 * package with only a console message, which is indistinguishable from "the
 * import did nothing". Failing here instead turns a silent drop into an error
 * at the call site.
 */
export function buildWebGalTextboxTemplatePackage(
  input: WebGalTemplatePackageInput,
): WebGalTemplatePackageBuild {
  const templateId = String(input.templateId ?? '').trim();
  if (!templateId) throw new Error('A WebGAL template package needs a non-empty templateId');
  const templateName = String(input.templateName ?? '').trim() || templateId;

  const fontSource = input.font?.sourcePath ? input.font : null;
  const fontFamily = fontSource ? String(fontSource.family ?? '').trim() || undefined : undefined;
  const fontFile = fontSource ? `fonts/${baseName(fontSource.sourcePath)}` : null;

  const translation = translateWebGalTextboxScss(input.scss, {
    sourceName: input.sourceName,
    strictCenter: input.strictCenter,
    fontFamily,
    fontFile,
  });

  const table = buildWebGalScssAssetTable(
    translation.theme,
    translation.assetGeom,
    input.decoSources ?? null,
  );
  const params = rewriteWebGalScssImageParams(
    translation.style.params as WebGalDialogueParams,
    table,
  ) as WebGalDialogueParams;

  const style: WebGalDialogueStyle = {
    id: String(input.styleId ?? '').trim() || templateId,
    name: String(input.styleName ?? '').trim() || templateName,
    renderer: 'image-dialogue-v1',
    params,
  };

  const manifest: TemplatePackageManifest = {
    manifestSchemaVersion: 2,
    template: {
      id: templateId,
      name: templateName,
      version: String(input.version ?? '').trim() || '1.0.0',
      ...(input.author ? { author: input.author } : {}),
      category: 'dialogue',
      description:
        input.description
        ?? `Imported from the WebGAL template "${templateName}" (Stage/TextBox/textbox.scss).`,
      compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
    },
    // `assets.index` is deliberately omitted: it is only consulted to resolve
    // voice-profile asset ids, and the built-in packages omit it too. Panel
    // artwork and fonts are reached through `params.*.image` / `fontFile`,
    // which are package-relative paths under this root.
    assets: { root: WEBGAL_PACKAGE_ASSET_ROOT },
    dialogueStyles: [style],
  };

  const files: WebGalTemplatePackageFile[] = [
    {
      relativePath: 'manifest.v2.json',
      contents: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    {
      relativePath: `${WEBGAL_PACKAGE_ASSET_ROOT}/${table['wg-textbox'].relPath}`,
      contents: table['wg-textbox'].svg,
    },
    {
      relativePath: `${WEBGAL_PACKAGE_ASSET_ROOT}/${table['wg-namebox'].relPath}`,
      contents: table['wg-namebox'].svg,
    },
  ];

  if (fontSource) {
    files.push({
      relativePath: `${WEBGAL_PACKAGE_ASSET_ROOT}/${fontFile}`,
      sourcePath: fontSource.sourcePath,
    });
  }

  // Throws if the package would be rejected by the engine.
  parseTemplatePackageManifest(manifest);

  return { manifest, files, style, notes: translation.notes };
}

/** Package-relative paths of the generated artwork, for logging and diagnostics. */
export function describeWebGalTemplatePackageFiles(build: WebGalTemplatePackageBuild): string[] {
  return build.files.map((file) => (file.sourcePath ? `${file.relativePath} (copied)` : file.relativePath));
}

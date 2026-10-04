export type Live2DModelEntryFormat =
  | 'wmdl'
  | 'cubism2-json'
  | 'cubism3-plus-json'
  | 'unknown-json'
  | 'not-live2d';

export type Live2DRuntimeFamily =
  | 'cubism2'
  | 'cubism3-plus'
  | 'wmdl'
  | 'unknown';

export interface Live2DModelEntryDescriptor {
  path: string;
  format: Live2DModelEntryFormat;
  runtimeFamily: Live2DRuntimeFamily;
  isBundleEntrypoint: boolean;
}

function normalizedPath(pathValue: string | undefined): string {
  return (pathValue ?? '').replace(/\\/g, '/').trim();
}

function basename(pathValue: string): string {
  const normalized = normalizedPath(pathValue).toLowerCase();
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function isKnownLive2DJsonEntrypoint(pathValue: string): boolean {
  const base = basename(pathValue);
  return base === 'model.json' ||
    base.endsWith('.model.json') ||
    base.endsWith('.model3.json');
}

function inferRuntimeFamilyFromJson(modelJson: any): Live2DRuntimeFamily {
  if (!modelJson || typeof modelJson !== 'object') return 'unknown';
  if (typeof modelJson.modelRelativePath === 'string') return 'wmdl';

  const fileReferences = modelJson.FileReferences;
  if (fileReferences && typeof fileReferences === 'object') {
    const moc = typeof fileReferences.Moc === 'string' ? fileReferences.Moc.toLowerCase() : '';
    return moc.endsWith('.moc3') ? 'cubism3-plus' : 'unknown';
  }

  if (
    typeof modelJson.model === 'string' ||
    modelJson.motions ||
    modelJson.expressions ||
    modelJson.textures
  ) {
    return 'cubism2';
  }

  return 'unknown';
}

export function describeLive2DModelEntrypoint(
  pathValue: string | undefined,
  parsedJson?: any,
): Live2DModelEntryDescriptor {
  const path = normalizedPath(pathValue);
  const lower = path.toLowerCase();

  if (!path) {
    return { path, format: 'not-live2d', runtimeFamily: 'unknown', isBundleEntrypoint: false };
  }

  if (lower.endsWith('.wmdl')) {
    return { path, format: 'wmdl', runtimeFamily: 'wmdl', isBundleEntrypoint: true };
  }

  if (!isKnownLive2DJsonEntrypoint(path)) {
    return { path, format: 'not-live2d', runtimeFamily: 'unknown', isBundleEntrypoint: false };
  }

  const inferredFamily = inferRuntimeFamilyFromJson(parsedJson);
  const pathImpliesCubism3Plus = basename(path).endsWith('.model3.json');
  const runtimeFamily = inferredFamily !== 'unknown'
    ? inferredFamily
    : pathImpliesCubism3Plus
      ? 'cubism3-plus'
      : 'unknown';
  const format: Live2DModelEntryFormat = runtimeFamily === 'cubism3-plus'
    ? 'cubism3-plus-json'
    : runtimeFamily === 'cubism2'
      ? 'cubism2-json'
      : 'unknown-json';

  return {
    path,
    format,
    runtimeFamily,
    isBundleEntrypoint: true,
  };
}

export function isLive2DModelEntryPath(pathValue: string | undefined): pathValue is string {
  return describeLive2DModelEntrypoint(pathValue).isBundleEntrypoint;
}

export function isLive2DAssetBundleEntrypoint(pathValue: string | undefined): pathValue is string {
  return isLive2DModelEntryPath(pathValue);
}

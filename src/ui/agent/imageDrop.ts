const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|bmp|avif|svg|ico)$/i;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_TOO_LARGE = '原图超过 32 MB，请缩小后重试。';

export type DroppedImage = File | URL;

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || (!file.type && IMAGE_EXTENSION.test(file.name));
}

export function hasImageDropData(data: DataTransfer): boolean {
  return Array.from(data.types).some((type) => (
    type === 'Files' || type === 'text/html' || type === 'text/uri-list'
  ));
}

function imageUrl(value: string, fromImageElement = false): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:') return /^data:image\//i.test(value) ? url : null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return fromImageElement || IMAGE_EXTENSION.test(url.pathname) ? url : null;
  } catch {
    return null;
  }
}

/** Read synchronously: browsers clear the drag data after the drop handler returns. */
export function readDroppedImage(data: DataTransfer): DroppedImage | null {
  const file = Array.from(data.files).find(isImageFile);
  if (file) return file;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = item.getAsFile();
    if (entry && isImageFile(entry)) return entry;
  }
  // A file drop must not fall through to its accompanying file:// URL or HTML.
  if (data.files.length || !data.getData) return null;
  const html = data.getData('text/html');
  if (html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const source = template.content.querySelector('img')?.getAttribute('src');
    const url = source ? imageUrl(source, true) : null;
    if (url) return url;
  }
  for (const line of data.getData('text/uri-list').split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const url = imageUrl(value);
    if (url) return url;
  }
  return null;
}

export async function loadDroppedImage(source: DroppedImage): Promise<File> {
  if (source instanceof File) return source;
  let response: Response;
  try {
    response = await fetch(source.href, { signal: AbortSignal.timeout(15_000), credentials: 'omit' });
  } catch {
    throw new Error('无法获取拖入的网络图片，请先保存到本地再拖入。');
  }
  if (!response.ok) throw new Error('无法获取拖入的网络图片，请先保存到本地再拖入。');
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(IMAGE_TOO_LARGE);
  }
  const chunks: BlobPart[] = [];
  if (response.body) {
    const reader = response.body.getReader();
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error(IMAGE_TOO_LARGE);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  let name = '拖入的图片';
  if (source.protocol !== 'data:') {
    const segment = source.pathname.split('/').pop();
    if (segment) {
      try { name = decodeURIComponent(segment); } catch { name = segment; }
    }
  }
  return new File(chunks, name, { type: response.headers.get('content-type') ?? '' });
}

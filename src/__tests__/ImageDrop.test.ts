import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDroppedImage } from '../ui/agent/imageDrop';

const MAX_BYTES = 32 * 1024 * 1024;
const TOO_LARGE = '原图超过 32 MB，请缩小后重试。';

afterEach(() => vi.unstubAllGlobals());

describe('loadDroppedImage', () => {
  it.each([null, '1'])('cancels an oversized stream with Content-Length %s before reading the remainder', async (length) => {
    const cancel = vi.fn();
    let chunksRead = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1;
        if (chunksRead <= 6) controller.enqueue(new Uint8Array(MAX_BYTES / 4));
        else controller.close();
      },
      cancel,
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers: {
      'content-type': 'image/png', ...(length === null ? {} : { 'content-length': length }),
    } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(loadDroppedImage(new URL('https://example.test/image.png'))).rejects.toThrow(TOO_LARGE);
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunksRead).toBe(5);
    expect(body.locked).toBe(false);
  });

  it('cancels a response rejected by its declared length without consuming it', async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
      headers: { 'content-length': String(MAX_BYTES + 1) },
    })));

    await expect(loadDroppedImage(new URL('https://example.test/image.png'))).rejects.toThrow(TOO_LARGE);
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
  });

  it('accepts exactly 32 MB without Content-Length and preserves the image metadata', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_BYTES / 2));
      controller.enqueue(new Uint8Array(MAX_BYTES / 2));
      controller.close();
    } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'image/png' } })));

    const file = await loadDroppedImage(new URL('https://example.test/my%20image.png'));
    expect(file.size).toBe(MAX_BYTES);
    expect(file.name).toBe('my image.png');
    expect(file.type).toBe('image/png');
    expect(body.locked).toBe(false);
  });

  it('preserves the bytes across streamed chunks', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'image/webp' } })));

    const file = await loadDroppedImage(new URL('https://example.test/image.webp'));
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(file.type).toBe('image/webp');
  });
});

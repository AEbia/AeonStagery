import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_PROJECT_ASSET_ROOTS, type ProjectState } from '../api/types/project';
import { ProjectAgentNodeProjectFs } from '../services/project-agent/ProjectAgentNodeProjectFs';
import {
  createProjectAgentImageReadPort,
  PROJECT_AGENT_IMAGE_OUTPUT_LONG_EDGE_HIGH,
  PROJECT_AGENT_IMAGE_OUTPUT_LONG_EDGE_LOW,
  PROJECT_AGENT_MAX_IMAGE_BYTES,
} from '../services/project-agent/ProjectAgentImageReadPort';
import { GIF_3000X2000, GIF_ANIMATED_2X2, GIF_STATIC_2X2 } from './fixtures/gifFixtures';

interface Sandbox {
  root: string;
  write(relative: string, content: string | Buffer): void;
  symlink(target: string, relative: string): void;
  cleanup(): void;
}

function readOrNull(result: unknown): Promise<{ code?: string; message?: string } | null> {
  return Promise.resolve(result as Promise<unknown>).then(() => null, (caught) => caught as { code?: string; message?: string });
}

function createSandbox(prefix: string): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    write(relative, content) {
      const absolute = path.join(root, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    },
    symlink(target, relative) {
      fs.symlinkSync(target, path.join(root, relative));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 1x1 PNG with an IHDR declaring the given dimensions (header-only fixture). */
function pngHeaderBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(29);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  header.write('IHDR', 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header.set([8, 6, 0, 0, 0], 24);
  return header;
}

/**
 * Header-only GIF whose FIRST FRAME declares the given dimensions while its
 * LZW stream is deliberately broken. The decode-pixel cap must be enforced
 * from the header BEFORE any LZW decode: an over-cap fixture must fail with
 * `image_decode_limit_exceeded`, not with a decode failure.
 */
function oversizedGifFirstFrameBytes(
  screenWidth: number,
  screenHeight: number,
  frameWidth: number,
  frameHeight: number,
): Buffer {
  const bytes = Buffer.alloc(28);
  bytes.write('GIF89a', 0, 'ascii');
  bytes.writeUInt16LE(screenWidth, 6);  // logical screen width
  bytes.writeUInt16LE(screenHeight, 8); // logical screen height
  bytes[10] = 0x00;                     // no global color table
  bytes[11] = 0x00;
  bytes[12] = 0x00;
  bytes[13] = 0x2c;                     // image separator
  bytes.writeUInt16LE(0, 14);           // left
  bytes.writeUInt16LE(0, 16);           // top
  bytes.writeUInt16LE(frameWidth, 18);  // frame width
  bytes.writeUInt16LE(frameHeight, 20); // frame height
  bytes[22] = 0x00;                     // no local color table
  bytes[23] = 0x02;                     // min code size
  bytes[24] = 0x01;                     // broken sub-block: one garbage byte
  bytes[25] = 0x00;
  bytes[26] = 0x00;                     // block terminator
  bytes[27] = 0x3b;                     // trailer
  return bytes;
}

function jpegBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(21);
  header.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  header.writeUInt16BE(height, 7);
  header.writeUInt16BE(width, 9);
  header.set([0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 11);
  return header;
}

function webpBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(30);
  header.write('RIFF', 0);
  header.writeUInt32LE(26, 4);
  header.write('WEBP', 8);
  header.write('VP8X', 12);
  header.writeUIntLE(width - 1, 24, 3);
  header.writeUIntLE(height - 1, 27, 3);
  return header;
}

function wavBytes(): Buffer {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(44100, 24);
  wav.writeUInt32LE(176400, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(0, 40);
  return wav;
}

function svgBytes(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
}

/** Simulates Electron's Windows realpath output while keeping the fixture on the host filesystem. */
class WindowsStyleProjectAgentFs extends ProjectAgentNodeProjectFs {
  override async realpath(entryPath: string): Promise<string> {
    return (await super.realpath(entryPath)).replace(/\//g, '\\');
  }
}

function makeProject(rootPath: string): ProjectState {
  return {
    rootPath,
    projectFilePath: path.join(rootPath, 'project.json'),
    metadata: {
      projectId: 'image-project',
      name: 'Image Project',
      projectVersion: 2,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      defaultSceneId: 'main',
      scenes: [{ id: 'main', name: 'Main', path: 'project/main.scene.json' }],
      assetRoots: DEFAULT_PROJECT_ASSET_ROOTS,
      templates: { enabledTemplateIds: [] },
    },
  };
}

describe('project agent image read port (sandbox)', () => {
  let sandbox: Sandbox;
  let project: ProjectState;

  beforeEach(() => {
    sandbox = createSandbox('pa-image-');
    project = makeProject(sandbox.root);
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  function createPort() {
    return createProjectAgentImageReadPort({
      fs: new ProjectAgentNodeProjectFs(),
      getProject: () => project,
      getExternalMounts: () => [],
    });
  }

  it('reads a bounded PNG with verified dimensions and a deterministic fingerprint', async () => {
    sandbox.write('images/bg.png', pngHeaderBytes(64, 32));
    const result = await createPort().readImage({ reference: 'images/bg.png', detail: 'auto' });
    expect(result.mimeType).toBe('image/png');
    expect(result.originalWidth).toBe(64);
    expect(result.originalHeight).toBe(32);
    expect(result.deliveredWidth).toBe(64);
    expect(result.deliveredHeight).toBe(32);
    expect(result.scaled).toBe(false);
    expect(result.contentFingerprint).toMatch(/^fnv1a64:/);
    expect(result.bytes).toHaveLength(29);
  });

  it('rejects images over the byte limit as image_too_large', async () => {
    sandbox.write('images/big.png', Buffer.alloc(PROJECT_AGENT_MAX_IMAGE_BYTES + 1, 0x89));
    const error = await readOrNull(createPort().readImage({ reference: 'images/big.png', detail: 'auto' }));
    expect(error?.code).toBe('image_too_large');
  });

  it('rejects a MIME mismatch between the declared extension and content magic', async () => {
    sandbox.write('images/fake.png', jpegBytes(16, 16));
    const error = await readOrNull(createPort().readImage({ reference: 'images/fake.png', detail: 'auto' }));
    expect(error?.code).toBe('image_mime_mismatch');
  });

  it('rejects audio content never as image content', async () => {
    sandbox.write('images/sound.png', wavBytes());
    const error = await readOrNull(createPort().readImage({ reference: 'images/sound.png', detail: 'auto' }));
    expect(error?.code).toBe('image_mime_mismatch');
  });

  it('rejects SVG because safe rasterization is unavailable', async () => {
    sandbox.write('images/vector.svg', svgBytes());
    const error = await readOrNull(createPort().readImage({ reference: 'images/vector.svg', detail: 'auto' }));
    expect(error?.code).toBe('unsupported_image_format');
    expect(error?.message).toMatch(/SVG/);
  });

  it('rejects payloads whose dimensions cannot be parsed', async () => {
    sandbox.write('images/odd.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    const error = await readOrNull(createPort().readImage({ reference: 'images/odd.png', detail: 'auto' }));
    expect(error?.code).toBe('unsupported_image_format');
  });

  it('rejects images whose pixel count exceeds the decode limit', async () => {
    sandbox.write('images/huge.png', pngHeaderBytes(5000, 5000));
    const error = await readOrNull(createPort().readImage({ reference: 'images/huge.png', detail: 'auto' }));
    expect(error?.code).toBe('image_decode_limit_exceeded');
  });

  it('rejects a GIF whose first-frame pixel count exceeds the decode limit from the header before decoding', async () => {
    // Logical screen stays under the cap; only the FIRST FRAME exceeds it, so
    // the rejection must come from the frame header before any LZW decode.
    sandbox.write('images/huge-frame.gif', oversizedGifFirstFrameBytes(100, 100, 5000, 5000));
    const error = await readOrNull(createPort().readImage({ reference: 'images/huge-frame.gif', detail: 'auto' }));
    expect(error?.code).toBe('image_decode_limit_exceeded');
  });

  it('scales the delivery spec to the output long-edge cap', async () => {
    sandbox.write('images/wide.png', pngHeaderBytes(8192, 1024));
    const result = await createPort().readImage({ reference: 'images/wide.png', detail: 'auto' });
    expect(result.originalWidth).toBe(8192);
    expect(result.originalHeight).toBe(1024);
    expect(result.scaled).toBe(true);
    expect(result.deliveredWidth).toBe(PROJECT_AGENT_IMAGE_OUTPUT_LONG_EDGE_HIGH);
    expect(result.deliveredHeight).toBe(256);
    // Pass-through raster bytes stay within the byte budget.
    expect(result.bytes).toHaveLength(29);
  });

  it('uses the low detail cap of 512 for detail=low', async () => {
    sandbox.write('images/wide.png', pngHeaderBytes(1024, 768));
    const result = await createPort().readImage({ reference: 'images/wide.png', detail: 'low' });
    expect(result.scaled).toBe(true);
    expect(result.deliveredWidth).toBe(PROJECT_AGENT_IMAGE_OUTPUT_LONG_EDGE_LOW);
    expect(result.deliveredHeight).toBe(384);
  });

  it('extracts the deterministic first frame of an animated GIF as PNG', async () => {
    sandbox.write('images/anim.gif', Buffer.from(GIF_ANIMATED_2X2));
    const result = await createPort().readImage({ reference: 'images/anim.gif', detail: 'auto' });
    expect(result.animated).toBe(true);
    expect(result.frame).toBe('first');
    expect(result.mimeType).toBe('image/png');
    expect(result.originalWidth).toBe(2);
    expect(result.originalHeight).toBe(2);
    expect(result.scaled).toBe(false);
    expect(result.bytes.length).toBeGreaterThan(0);
    // The delivered payload is a valid PNG with the first frame's dims.
    expect(result.bytes[0]).toBe(0x89);
    expect(result.bytes[1]).toBe(0x50);
  });

  it('extracts a single frame from a static GIF without marking it animated', async () => {
    sandbox.write('images/static.gif', Buffer.from(GIF_STATIC_2X2));
    const result = await createPort().readImage({ reference: 'images/static.gif', detail: 'auto' });
    expect(result.animated).toBe(false);
    expect(result.mimeType).toBe('image/png');
  });

  it('scales an oversized GIF first frame deterministically', async () => {
    sandbox.write('images/big.gif', Buffer.from(GIF_3000X2000));
    const result = await createPort().readImage({ reference: 'images/big.gif', detail: 'auto' });
    expect(result.originalWidth).toBe(3000);
    expect(result.originalHeight).toBe(2000);
    expect(result.scaled).toBe(true);
    expect(result.deliveredWidth).toBeLessThan(3000);
    expect(result.deliveredWidth).toBeGreaterThan(0);
    const again = await createPort().readImage({ reference: 'images/big.gif', detail: 'auto' });
    expect(again.deliveredWidth).toBe(result.deliveredWidth);
    expect(again.deliveredHeight).toBe(result.deliveredHeight);
    expect(Buffer.from(again.bytes).equals(Buffer.from(result.bytes))).toBe(true);
  });

  it('accepts JPEG and WebP with verified dimensions', async () => {
    sandbox.write('images/shot.jpg', jpegBytes(320, 240));
    const jpeg = await createPort().readImage({ reference: 'images/shot.jpg', detail: 'auto' });
    expect(jpeg.mimeType).toBe('image/jpeg');
    expect(jpeg.originalWidth).toBe(320);
    expect(jpeg.originalHeight).toBe(240);

    sandbox.write('images/shot.webp', webpBytes(128, 64));
    const webp = await createPort().readImage({ reference: 'images/shot.webp', detail: 'auto' });
    expect(webp.mimeType).toBe('image/webp');
    expect(webp.originalWidth).toBe(128);
    expect(webp.originalHeight).toBe(64);
  });

  it('rejects absolute paths, traversal and unregistered mounts', async () => {
    const port = createPort();
    for (const reference of ['/etc/passwd', 'C:/Windows/x.png', '../secret.png', 'images/../../x.png']) {
      const error = await readOrNull(port.readImage({ reference, detail: 'auto' }));
      expect(error?.code).toBe('forbidden_path');
    }
    const mount = await readOrNull(port.readImage({ reference: '@mount/nope/x.png', detail: 'auto' }));
    expect(mount?.code).toBe('not_found');
  });

  it('never follows symlinks out of the registered root', async () => {
    const outside = createSandbox('pa-image-outside-');
    try {
      outside.write('secret.png', pngHeaderBytes(4, 4));
      sandbox.write('images/real.png', pngHeaderBytes(4, 4));
      sandbox.symlink(outside.root, 'images/escape');
      const escaped = await readOrNull(createPort().readImage({ reference: 'images/escape/secret.png', detail: 'auto' }));
      expect(escaped?.code).toBe('forbidden_path');
    } finally {
      outside.cleanup();
    }
  });

  it('never follows symlinks even when the target stays inside the root', async () => {
    sandbox.write('images/real.png', pngHeaderBytes(4, 4));
    const linkTarget = path.join(sandbox.root, 'images', 'real.png');
    sandbox.symlink(linkTarget, 'images/linked.png');
    const linked = await readOrNull(createPort().readImage({ reference: 'images/linked.png', detail: 'auto' }));
    expect(linked?.code).toBe('not_found');
  });

  it('supports stable @mount references for registered mounts with Windows canonical paths', async () => {
    const mountSandbox = createSandbox('pa-image-mount-');
    try {
      mountSandbox.write('assets/pic.png', pngHeaderBytes(8, 8));
      const port = createProjectAgentImageReadPort({
        fs: new WindowsStyleProjectAgentFs(),
        getProject: () => project,
        getExternalMounts: () => [{ id: 'lib', path: mountSandbox.root }],
      });
      const result = await port.readImage({ reference: '@mount/lib/assets/pic.png', detail: 'auto' });
      expect(result.mimeType).toBe('image/png');
      expect(result.originalWidth).toBe(8);
      expect(result.originalHeight).toBe(8);
    } finally {
      mountSandbox.cleanup();
    }
  });

  it('produces a stable fingerprint for identical content and a different one for changes', async () => {
    sandbox.write('images/a.png', pngHeaderBytes(4, 4));
    const first = await createPort().readImage({ reference: 'images/a.png', detail: 'auto' });
    const second = await createPort().readImage({ reference: 'images/a.png', detail: 'auto' });
    expect(second.contentFingerprint).toBe(first.contentFingerprint);

    sandbox.write('images/a.png', pngHeaderBytes(4, 5));
    const changed = await createPort().readImage({ reference: 'images/a.png', detail: 'auto' });
    expect(changed.contentFingerprint).not.toBe(first.contentFingerprint);
  });
});

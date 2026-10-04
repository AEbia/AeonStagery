/**
 * Deterministic first-frame extraction for animated GIF images (ADR0023).
 *
 * The pipeline never plays back, seeks or shares runtime media state: it only
 * decodes the first image frame of the container and re-encodes it as a PNG
 * with stored (uncompressed) DEFLATE blocks, so the delivered payload is a
 * single deterministic frame with no codec dependency. Interlaced first
 * frames and corrupt streams are rejected by returning null.
 */

export interface GifFirstFrameResult {
  /** Logical screen (canvas) dimensions of the GIF container. */
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  /** RGBA pixels of the first frame (frameWidth * frameHeight * 4). */
  readonly rgba: Uint8Array;
  /** True when the container holds more than one image frame. */
  readonly animated: boolean;
  /** True when the first frame is interlaced and was therefore rejected. */
  readonly interlaced: boolean;
}

export type GifFirstFrameDecodeResult =
  | { readonly ok: true; readonly frame: GifFirstFrameResult }
  | {
      readonly ok: false;
      /** `frame_pixel_limit_exceeded` when the header already proves the
       *  first frame exceeds the decode-pixel budget (checked BEFORE any LZW
       *  decode so memory is bounded by the header dims). */
      readonly reason: 'decode_failed' | 'frame_pixel_limit_exceeded';
    };

export function extractGifFirstFrame(
  bytes: Uint8Array,
  maxFramePixels?: number,
): GifFirstFrameDecodeResult {
  if (bytes.length < 13) return { ok: false, reason: 'decode_failed' };
  if (!ascii(bytes, 0, 'GIF87a') && !ascii(bytes, 0, 'GIF89a')) return { ok: false, reason: 'decode_failed' };

  let pos = 6;
  const screenWidth = readUint16LE(bytes, pos);
  const screenHeight = readUint16LE(bytes, pos + 2);
  const screenPacked = bytes[pos + 4];
  pos += 7;
  const globalTableSize = (screenPacked & 0x80) !== 0 ? 3 * (2 << (screenPacked & 0x07)) : 0;
  let globalTable: Uint8Array | null = null;
  if (globalTableSize > 0) {
    if (pos + globalTableSize > bytes.length) return { ok: false, reason: 'decode_failed' };
    globalTable = bytes.subarray(pos, pos + globalTableSize);
    pos += globalTableSize;
  }

  let firstFrame: { frameWidth: number; frameHeight: number; rgba: Uint8Array } | null = null;
  let animated = false;
  let interlaced = false;

  while (pos < bytes.length) {
    const block = bytes[pos];
    if (block === 0x2c) {
      if (firstFrame) {
        animated = true;
        break;
      }
      if (pos + 10 > bytes.length) return { ok: false, reason: 'decode_failed' };
      const frameWidth = readUint16LE(bytes, pos + 5);
      const frameHeight = readUint16LE(bytes, pos + 7);
      const imagePacked = bytes[pos + 9];
      pos += 10;
      if (frameWidth === 0 || frameHeight === 0) return { ok: false, reason: 'decode_failed' };
      // The frame dimensions live in the image-descriptor header: enforce the
      // decode-pixel budget BEFORE the LZW stream is decoded so an oversized
      // frame can never allocate unbounded index/RGBA buffers.
      if (maxFramePixels !== undefined && frameWidth * frameHeight > maxFramePixels) {
        return { ok: false, reason: 'frame_pixel_limit_exceeded' };
      }
      const localTableSize = (imagePacked & 0x80) !== 0 ? 3 * (2 << (imagePacked & 0x07)) : 0;
      let table = globalTable;
      if (localTableSize > 0) {
        if (pos + localTableSize > bytes.length) return { ok: false, reason: 'decode_failed' };
        table = bytes.subarray(pos, pos + localTableSize);
        pos += localTableSize;
      }
      if (pos >= bytes.length) return { ok: false, reason: 'decode_failed' };
      const minCodeSize = bytes[pos];
      pos += 1;
      if (minCodeSize < 2 || minCodeSize > 8) return { ok: false, reason: 'decode_failed' };
      const data: number[] = [];
      while (pos < bytes.length) {
        const length = bytes[pos];
        pos += 1;
        if (length === 0) break;
        if (pos + length > bytes.length) return { ok: false, reason: 'decode_failed' };
        for (let i = 0; i < length; i += 1) data.push(bytes[pos + i]);
        pos += length;
      }
      const indices = lzwDecode(data, minCodeSize, frameWidth * frameHeight);
      if (!indices || !table) return { ok: false, reason: 'decode_failed' };
      const rgba = mapIndicesToRgba(indices, table);
      if ((imagePacked & 0x40) !== 0) interlaced = true;
      firstFrame = { frameWidth, frameHeight, rgba };
      continue;
    }
    if (block === 0x21) {
      pos += 2;
      while (pos < bytes.length) {
        const length = bytes[pos];
        pos += 1;
        if (length === 0) break;
        if (pos + length > bytes.length) return { ok: false, reason: 'decode_failed' };
        pos += length;
      }
      continue;
    }
    if (block === 0x3b) break;
    break;
  }

  if (!firstFrame) return { ok: false, reason: 'decode_failed' };
  return {
    ok: true,
    frame: {
      screenWidth,
      screenHeight,
      frameWidth: firstFrame.frameWidth,
      frameHeight: firstFrame.frameHeight,
      rgba: firstFrame.rgba,
      animated,
      interlaced,
    },
  };
}

/** Deterministic nearest-neighbour downscale with floor mapping. */
export function scaleRgbaNearest(
  rgba: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Uint8Array {
  if (srcWidth === dstWidth && srcHeight === dstHeight) return rgba;
  const out = new Uint8Array(dstWidth * dstHeight * 4);
  for (let y = 0; y < dstHeight; y += 1) {
    const sourceY = Math.floor((y * srcHeight) / dstHeight);
    for (let x = 0; x < dstWidth; x += 1) {
      const sourceX = Math.floor((x * srcWidth) / dstWidth);
      const source = (sourceY * srcWidth + sourceX) * 4;
      const target = (y * dstWidth + x) * 4;
      out[target] = rgba[source];
      out[target + 1] = rgba[source + 1];
      out[target + 2] = rgba[source + 2];
      out[target + 3] = rgba[source + 3];
    }
  }
  return out;
}

/**
 * Re-encodes RGBA pixels as a PNG using stored (uncompressed) DEFLATE blocks:
 * deterministic, dependency-free, valid for any PNG consumer.
 */
export function encodePngRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const expected = width * height * 4;
  if (rgba.length < expected) throw new Error('RGBA buffer is smaller than the declared dimensions');
  const rawLength = height * (1 + width * 4);
  const raw = new Uint8Array(rawLength);
  let out = 0;
  for (let y = 0; y < height; y += 1) {
    raw[out] = 0;
    out += 1;
    const rowStart = y * width * 4;
    raw.set(rgba.subarray(rowStart, rowStart + width * 4), out);
    out += width * 4;
  }
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const chunks = [
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibStored(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + signature.length;
  const result = new Uint8Array(total);
  result.set(signature, 0);
  let cursor = signature.length;
  for (const chunk of chunks) {
    result.set(chunk, cursor);
    cursor += chunk.length;
  }
  return result;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeUint32BE(out, 0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  writeUint32BE(out, 8 + data.length, crc);
  return out;
}

/** zlib wrapper: stored (uncompressed) DEFLATE blocks + Adler-32. */
function zlibStored(data: Uint8Array): Uint8Array {
  const maxBlock = 65535;
  const blockCount = Math.max(1, Math.ceil(data.length / maxBlock));
  const out = new Uint8Array(2 + blockCount * 5 + data.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let cursor = 2;
  for (let block = 0; block < blockCount; block += 1) {
    const length = Math.min(maxBlock, data.length - block * maxBlock);
    out[cursor] = block === blockCount - 1 ? 0x01 : 0x00;
    cursor += 1;
    out[cursor] = length & 0xff;
    out[cursor + 1] = (length >> 8) & 0xff;
    cursor += 2;
    const complement = (~length) & 0xffff;
    out[cursor] = complement & 0xff;
    out[cursor + 1] = (complement >> 8) & 0xff;
    cursor += 2;
    out.set(data.subarray(block * maxBlock, block * maxBlock + length), cursor);
    cursor += length;
  }
  const adler = adler32(data);
  out[cursor] = (adler >>> 24) & 0xff;
  out[cursor + 1] = (adler >>> 16) & 0xff;
  out[cursor + 2] = (adler >>> 8) & 0xff;
  out[cursor + 3] = adler & 0xff;
  return out;
}

function lzwDecode(data: readonly number[], minCodeSize: number, expected: number): Uint8Array | null {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dictionary: number[][] = [];
  const resetDictionary = () => {
    dictionary = [];
    for (let i = 0; i < clearCode; i += 1) dictionary[i] = [i];
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  };
  resetDictionary();

  const output: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let index = 0;
  let previousEntry: number[] | null = null;
  let firstCode = true;

  const readCode = (): number | null => {
    while (bitCount < codeSize && index < data.length) {
      bitBuffer |= data[index] << bitCount;
      index += 1;
      bitCount += 8;
    }
    if (bitCount < codeSize) return null;
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>>= codeSize;
    bitCount -= codeSize;
    return code;
  };

  while (true) {
    const code = readCode();
    if (code === null) break;
    if (code === clearCode) {
      resetDictionary();
      previousEntry = null;
      firstCode = true;
      continue;
    }
    if (code === eoiCode) break;
    let entry: number[];
    if (code < nextCode) {
      entry = dictionary[code] as number[];
    } else if (code === nextCode && previousEntry) {
      // The GIF decoder adds one entry per read (deferred from the previous
      // code), so the encoder's code-size increase is mirrored exactly.
      entry = [...previousEntry, previousEntry[0] as number];
    } else {
      return null;
    }
    output.push(...entry);
    if (!firstCode && previousEntry) {
      dictionary[nextCode] = [...previousEntry, entry[0] as number];
      nextCode += 1;
      // GIF LZW "early change": the decoder's dictionary lags the encoder by
      // one entry, so the code-size increase is detected one slot earlier.
      if (nextCode === (1 << codeSize) - 1 && codeSize < 12) codeSize += 1;
    }
    previousEntry = entry;
    firstCode = false;
    if (output.length >= expected) break;
  }
  if (output.length < expected) return null;
  return Uint8Array.from(output.slice(0, expected));
}

function mapIndicesToRgba(indices: Uint8Array, colorTable: Uint8Array): Uint8Array {
  const rgba = new Uint8Array(indices.length * 4);
  for (let i = 0; i < indices.length; i += 1) {
    const colorIndex = indices[i] as number;
    const source = colorIndex * 3;
    if (source + 2 < colorTable.length) {
      rgba[i * 4] = colorTable[source];
      rgba[i * 4 + 1] = colorTable[source + 1];
      rgba[i * 4 + 2] = colorTable[source + 2];
      rgba[i * 4 + 3] = 255;
    } else {
      rgba[i * 4 + 3] = 0;
    }
  }
  return rgba;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function ascii(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (offset + expected.length > bytes.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[offset + i] !== expected.charCodeAt(i)) return false;
  }
  return true;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

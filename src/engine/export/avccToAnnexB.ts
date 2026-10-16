/** Converts four-byte AVCC lengths to Annex B with a single payload allocation. */
export function avccToAnnexB(chunk: Uint8Array, description?: AllowSharedBufferSource): Uint8Array {
  const nals: Uint8Array[] = [];
  let totalSize = 0;
  const append = (bytes: Uint8Array, offset: number, length: number): void => {
    if (length <= 0 || offset + length > bytes.byteLength) throw new Error('Incomplete H.264 NAL unit');
    nals.push(bytes.subarray(offset, offset + length));
    totalSize += 4 + length;
  };

  if (description) {
    const desc = ArrayBuffer.isView(description)
      ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
      : new Uint8Array(description);
    if (desc.byteLength < 7) throw new Error('Incomplete AVC decoder configuration');
    let offset = 6;
    const appendParameters = (count: number): void => {
      for (let index = 0; index < count; index++) {
        if (offset + 2 > desc.byteLength) throw new Error('Incomplete AVC parameter length');
        const length = (desc[offset] << 8) | desc[offset + 1];
        offset += 2;
        append(desc, offset, length);
        offset += length;
      }
    };
    appendParameters(desc[5] & 0x1f);
    if (offset >= desc.byteLength) throw new Error('Missing AVC PPS count');
    const ppsCount = desc[offset++];
    appendParameters(ppsCount);
  }

  const lengths = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  for (let offset = 0; offset < chunk.byteLength;) {
    if (offset + 4 > chunk.byteLength) throw new Error('Incomplete AVCC NAL length');
    const length = lengths.getUint32(offset);
    offset += 4;
    append(chunk, offset, length);
    offset += length;
  }

  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const nal of nals) {
    result[offset + 3] = 1;
    result.set(nal, offset + 4);
    offset += 4 + nal.byteLength;
  }
  return result;
}

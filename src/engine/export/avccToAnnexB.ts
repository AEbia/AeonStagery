/** Converts length-prefixed AVC NALs to Annex B with a single payload allocation. */
export function avccToAnnexB(chunk: Uint8Array, description?: AllowSharedBufferSource, lengthSize = 4): Uint8Array {
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

  if (lengthSize < 1 || lengthSize > 4) throw new Error('Invalid AVCC NAL length size');
  for (let offset = 0; offset < chunk.byteLength;) {
    if (offset + lengthSize > chunk.byteLength) throw new Error('Incomplete AVCC NAL length');
    let length = 0;
    for (let index = 0; index < lengthSize; index++) length = length * 256 + chunk[offset++];
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

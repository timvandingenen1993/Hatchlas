/**
 * Minimal PNG encoder: chunks, CRC and streamed RGBA rows.
 */
export const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function asBlobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function crc32(type: string, data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < type.length; index++) {
    crc = CRC_TABLE[(crc ^ type.charCodeAt(index)) & 0xff] ^ (crc >>> 8);
  }
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function createPngChunk(type: string, data: Uint8Array): Uint8Array {
  if (type.length !== 4) throw new Error("PNG chunk types must be four characters");
  const chunk = new Uint8Array(data.length + 12);
  writeUint32BE(chunk, 0, data.length);
  for (let index = 0; index < 4; index++) chunk[4 + index] = type.charCodeAt(index);
  chunk.set(data, 8);
  writeUint32BE(chunk, data.length + 8, crc32(type, data));
  return chunk;
}

/**
 * Blob parts for one chunk that reference `data` instead of copying it into a
 * new chunk buffer. Large exports would otherwise hold several copies of the
 * compressed image at once while finalizing.
 */
function pngChunkBlobParts(type: string, data: Uint8Array): BlobPart[] {
  const header = new Uint8Array(8);
  writeUint32BE(header, 0, data.length);
  for (let index = 0; index < 4; index++) header[4 + index] = type.charCodeAt(index);
  const crc = new Uint8Array(4);
  writeUint32BE(crc, 0, crc32(type, data));
  return [header, data as Uint8Array<ArrayBuffer>, crc];
}

function createIhdr(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8] = 8; // RGBA samples
  ihdr[9] = 6; // truecolour with alpha
  return ihdr;
}

function adler32Update(state: [number, number], data: Uint8Array): void {
  let [sumA, sumB] = state;
  for (const byte of data) {
    sumA += byte;
    if (sumA >= 65521) sumA -= 65521;
    sumB += sumA;
    if (sumB >= 65521) sumB -= 65521;
  }
  state[0] = sumA;
  state[1] = sumB;
}

function appendStoredDeflateBlock(
  parts: Uint8Array[],
  data: Uint8Array,
  adlerState: [number, number],
): void {
  adler32Update(adlerState, data);
  for (let offset = 0; offset < data.length || offset === 0;) {
    const length = Math.min(65535, data.length - offset);
    const block = new Uint8Array(length + 5);
    block[0] = 0; // non-final stored block; a final empty block is appended later
    block[1] = length & 0xff;
    block[2] = (length >>> 8) & 0xff;
    const inverse = (~length) & 0xffff;
    block[3] = inverse & 0xff;
    block[4] = (inverse >>> 8) & 0xff;
    block.set(data.subarray(offset, offset + length), 5);
    parts.push(block);
    offset += length;
  }
}

export interface RgbaPngEncodingHooks {
  /** Called around compression work for one complete scanline band. */
  beginBand?: () => (() => void);
  /** Called around final PNG chunk assembly after all bands are consumed. */
  beginFinalize?: () => (() => void);
}

async function encodeStored(
  width: number,
  height: number,
  rows: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  hooks?: RgbaPngEncodingHooks,
): Promise<Blob> {
  const idatParts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  const adlerState: [number, number] = [1, 0];
  const rowBytes = width * 4 + 1;
  let total = 0;
  for await (const band of rows) {
    if (band.length === 0 || band.length % rowBytes !== 0) {
      throw new Error("PNG scanline bands must contain complete rows");
    }
    total += band.length;
    const stop = hooks?.beginBand?.();
    try {
      appendStoredDeflateBlock(idatParts, band, adlerState);
    } finally {
      stop?.();
    }
  }
  const expectedBytes = height * (width * 4 + 1);
  if (total !== expectedBytes) {
    throw new Error(`PNG export produced ${total} scanline bytes; expected ${expectedBytes}`);
  }
  // End the zlib stream without needing to know the final band in advance.
  idatParts.push(new Uint8Array([1, 0, 0, 0xff, 0xff]));
  const checksum = new Uint8Array(4);
  writeUint32BE(checksum, 0, ((adlerState[1] << 16) | adlerState[0]) >>> 0);
  idatParts.push(checksum);

  const stop = hooks?.beginFinalize?.();
  try {
    const chunks: BlobPart[] = [
      asBlobPart(PNG_SIGNATURE),
      asBlobPart(createPngChunk("IHDR", createIhdr(width, height))),
    ];
    for (const part of idatParts) chunks.push(asBlobPart(createPngChunk("IDAT", part)));
    chunks.push(asBlobPart(createPngChunk("IEND", new Uint8Array(0))));
    return new Blob(chunks, { type: "image/png" });
  } finally {
    stop?.();
  }
}

/**
 * Encodes ordered RGBA scanline bands without creating a full-size output
 * canvas or scanline buffer. Each band contains complete PNG scanlines,
 * including one filter byte per row.
 */
export async function encodeRgbaPngRows(
  width: number,
  height: number,
  rows: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  hooks?: RgbaPngEncodingHooks,
): Promise<Blob> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("PNG dimensions must be positive integers");
  }

  // CompressionStream keeps large exports compact while still allowing the
  // caller to supply one bounded scanline band at a time. The stored fallback
  // is deterministic and works in older worker implementations.
  if (typeof CompressionStream !== "undefined") {
    let compressor: CompressionStream;
    try {
      compressor = new CompressionStream("deflate");
    } catch {
      return encodeStored(width, height, rows, hooks);
    }
    const writer = compressor.writable.getWriter();
    const reader = compressor.readable.getReader();
    const compressedParts: Uint8Array[] = [];
    const readPromise = (async () => {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        compressedParts.push(result.value);
      }
    })();
    const rowBytes = width * 4 + 1;
    let total = 0;
    for await (const band of rows) {
      if (band.length === 0 || band.length % rowBytes !== 0) {
        throw new Error("PNG scanline bands must contain complete rows");
      }
      total += band.length;
      const stop = hooks?.beginBand?.();
      try {
        await writer.write(band as unknown as BufferSource);
      } finally {
        stop?.();
      }
    }
    const expectedBytes = height * (width * 4 + 1);
    if (total !== expectedBytes) {
      throw new Error(`PNG export produced ${total} scanline bytes; expected ${expectedBytes}`);
    }
    await writer.close();
    await readPromise;

    const stop = hooks?.beginFinalize?.();
    try {
      const chunks: BlobPart[] = [
        asBlobPart(PNG_SIGNATURE),
        asBlobPart(createPngChunk("IHDR", createIhdr(width, height))),
      ];
      for (const part of compressedParts) chunks.push(...pngChunkBlobParts("IDAT", part));
      chunks.push(asBlobPart(createPngChunk("IEND", new Uint8Array(0))));
      return new Blob(chunks, { type: "image/png" });
    } finally {
      stop?.();
    }
  }
  return encodeStored(width, height, rows, hooks);
}

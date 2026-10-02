/**
 * Encodes and downloads 16-bit grayscale PNG heightmaps.
 */
import {
  PNG_SIGNATURE,
  createPngChunk,
  writeUint32BE,
} from "./pngEncoding";

function adler32(data: Uint8Array): number {
  let sumA = 1;
  let sumB = 0;
  for (const byte of data) {
    sumA += byte;
    if (sumA >= 65521) sumA -= 65521;
    sumB += sumA;
    if (sumB >= 65521) sumB -= 65521;
  }
  return ((sumB << 16) | sumA) >>> 0;
}

/**
 * Wraps PNG scanline bytes in a valid zlib stream using stored DEFLATE
 * blocks. Stored blocks avoid an async browser compression dependency and
 * preserve deterministic, lossless export at any supported resolution.
 */
function createStoredZlibStream(data: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(data.length / 65535));
  const stream = new Uint8Array(2 + data.length + blockCount * 5 + 4);
  stream[0] = 0x78;
  stream[1] = 0x01;

  let outputOffset = 2;
  for (let inputOffset = 0; inputOffset < data.length || inputOffset === 0;) {
    const blockLength = Math.min(65535, data.length - inputOffset);
    const isFinal = inputOffset + blockLength >= data.length;
    stream[outputOffset++] = isFinal ? 1 : 0;
    stream[outputOffset++] = blockLength & 0xff;
    stream[outputOffset++] = (blockLength >>> 8) & 0xff;
    const inverseLength = (~blockLength) & 0xffff;
    stream[outputOffset++] = inverseLength & 0xff;
    stream[outputOffset++] = (inverseLength >>> 8) & 0xff;
    stream.set(data.subarray(inputOffset, inputOffset + blockLength), outputOffset);
    outputOffset += blockLength;
    inputOffset += blockLength;
  }

  writeUint32BE(stream, outputOffset, adler32(data));
  return stream;
}

/**
 * Encodes normalized elevation samples as a true grayscale 16-bit PNG.
 * PNG stores 16-bit samples big-endian, unlike the browser's 8-bit ImageData.
 */
export function encodeGrayscale16BitPng(
  normalizedElevation: Float32Array,
  width: number,
  height: number,
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Heightmap dimensions must be positive integers");
  }
  if (normalizedElevation.length !== width * height) {
    throw new Error("Heightmap sample count does not match dimensions");
  }

  const rowBytes = width * 2 + 1;
  const scanlines = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowBytes;
    scanlines[rowOffset] = 0; // PNG filter: None
    for (let x = 0; x < width; x++) {
      const normalized = Math.max(0, Math.min(1, normalizedElevation[y * width + x]));
      const sample = Math.round(normalized * 65535);
      const sampleOffset = rowOffset + 1 + x * 2;
      scanlines[sampleOffset] = (sample >>> 8) & 0xff;
      scanlines[sampleOffset + 1] = sample & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  const headerChunk = createPngChunk("IHDR", ihdr);
  const dataChunk = createPngChunk("IDAT", createStoredZlibStream(scanlines));
  const endChunk = createPngChunk("IEND", new Uint8Array(0));
  const png = new Uint8Array(
    PNG_SIGNATURE.length + headerChunk.length + dataChunk.length + endChunk.length,
  );
  let offset = 0;
  png.set(PNG_SIGNATURE, offset);
  offset += PNG_SIGNATURE.length;
  png.set(headerChunk, offset);
  offset += headerChunk.length;
  png.set(dataChunk, offset);
  offset += dataChunk.length;
  png.set(endChunk, offset);
  return png;
}

export function downloadGrayscale16BitPng(
  normalizedElevation: Float32Array,
  width: number,
  height: number,
  filename: string,
): void {
  const png = encodeGrayscale16BitPng(normalizedElevation, width, height);
  const blob = new Blob([png.buffer as ArrayBuffer], { type: "image/png" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeGrayscale16BitPng } from "../src/utils/heightmapExport";

describe("16-bit heightmap PNG export", () => {
  it("writes lossless grayscale 16-bit samples", () => {
    const png = encodeGrayscale16BitPng(
      new Float32Array([0, 0.5, 1, 0.123456]),
      2,
      2,
    );

    expect(Array.from(png.slice(0, 8))).toEqual([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    ]);

    const ihdrOffset = 8;
    expect(new DataView(png.buffer).getUint32(ihdrOffset, false)).toBe(13);
    expect(String.fromCharCode(...png.slice(ihdrOffset + 4, ihdrOffset + 8))).toBe("IHDR");
    expect(png[ihdrOffset + 8 + 8]).toBe(16);
    expect(png[ihdrOffset + 8 + 9]).toBe(0);

    const idatOffset = ihdrOffset + 12 + 13;
    const idatLength = new DataView(png.buffer).getUint32(idatOffset, false);
    expect(String.fromCharCode(...png.slice(idatOffset + 4, idatOffset + 8))).toBe("IDAT");
    const compressed = png.slice(idatOffset + 8, idatOffset + 8 + idatLength);
    const scanlines = new Uint8Array(inflateSync(compressed));

    // Each row is: filter byte, then two big-endian 16-bit grayscale samples.
    expect(Array.from(scanlines)).toEqual([
      0, 0, 0, 0x80, 0,
      0, 0xff, 0xff, 0x1f, 0x9b,
    ]);
  });
});

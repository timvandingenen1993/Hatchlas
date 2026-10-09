// Writes the lake test terrain as a 16-bit grayscale PNG the studio can load:
//   node scripts/generate-lake-test-heightmap.ts [size]
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { lakeTestTerrain } from '../tests/fixtures/lakeTestTerrain.ts';

const size = Number(process.argv[2] ?? 2048);
const terrain = lakeTestTerrain(size, size);

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 16; // bit depth
header[9] = 0; // grayscale
const rowBytes = size * 2;
const raw = Buffer.alloc(size * (rowBytes + 1));
for (let y = 0; y < size; y++) {
  const row = y * (rowBytes + 1);
  raw[row] = 0;
  for (let x = 0; x < size; x++) {
    raw.writeUInt16BE(Math.round(terrain[y * size + x] * 65535), row + 1 + x * 2);
  }
}

const path = new URL('../src/assets/lake-test-heightmap.png', import.meta.url);
writeFileSync(
  path,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
console.log(`wrote ${path.pathname} (${size} x ${size})`);

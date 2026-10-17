// Generates the app and tray icons (assets/icon.png, assets/tray.png) as dependency-free
// PNGs: a green disc with a light "V". Run with `npm run icons`.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

type Rgba = readonly [number, number, number, number];

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const RGBA_8_BIT = { bitDepth: 8, colorType: 6 };
const COLORS: Readonly<Record<'stroke' | 'disc' | 'transparent', Rgba>> = {
  stroke: [219, 241, 229, 255],
  disc: [43, 76, 62, 255],
  transparent: [0, 0, 0, 0]
};
const SIZES = { 'icon.png': 256, 'tray.png': 32 };

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

// Colour of the pixel at relative position (u, v) in [0, 1).
function pixel(u: number, v: number): Rgba {
  const inStroke = v > 0.25 && v < 0.73;
  const leftStroke = inStroke && Math.abs(u - (0.23 + (v - 0.25) * 0.52)) < 0.04;
  const rightStroke = inStroke && Math.abs(u - (0.73 - (v - 0.25) * 0.52)) < 0.04;
  if (leftStroke || rightStroke) return COLORS.stroke;
  return (u - 0.5) ** 2 + (v - 0.5) ** 2 < 0.24 ? COLORS.disc : COLORS.transparent;
}

function png(size: number): Buffer {
  const rowBytes = size * 4 + 1; // each row starts with filter type 0 (none)
  const pixels = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) Buffer.from(pixel(x / size, y / size)).copy(pixels, y * rowBytes + 1 + x * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = RGBA_8_BIT.bitDepth;
  header[9] = RGBA_8_BIT.colorType;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const destination = path.resolve(import.meta.dirname, '../assets');
fs.mkdirSync(destination, { recursive: true });
for (const [file, size] of Object.entries(SIZES)) fs.writeFileSync(path.join(destination, file), png(size));

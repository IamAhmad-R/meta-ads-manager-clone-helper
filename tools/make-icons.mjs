import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "D:/opencode/meta-ads-clone/extension/icons";
mkdirSync(OUT, { recursive: true });

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y, size);
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const INDIGO = [66, 62, 189];
const WHITE = [255, 255, 255];

function paint(x, y, size) {
  const u = (x + 0.5) / size;
  const v = (y + 0.5) / size;
  const radius = 0.22;

  // rounded square mask
  const cx = Math.min(Math.max(u, radius), 1 - radius);
  const cy = Math.min(Math.max(v, radius), 1 - radius);
  const dx = u - cx;
  const dy = v - cy;
  const inside = Math.hypot(dx, dy) <= radius;
  if (!inside) return [0, 0, 0, 0];

  // three "row" bars, like an ad table
  const bars = [
    { top: 0.3, left: 0.22, right: 0.78 },
    { top: 0.47, left: 0.22, right: 0.62 },
    { top: 0.64, left: 0.22, right: 0.7 },
  ];
  const height = 0.075;
  for (const bar of bars) {
    if (v >= bar.top && v <= bar.top + height && u >= bar.left && u <= bar.right) {
      return [...WHITE, 255];
    }
  }
  return [...INDIGO, 255];
}

for (const size of [16, 48, 128]) {
  const png = encodePng(size, paint);
  writeFileSync(join(OUT, `icon${size}.png`), png);
  console.log(`icon${size}.png ${png.length} bytes`);
}

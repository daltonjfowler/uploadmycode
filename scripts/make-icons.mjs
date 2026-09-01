// Rasterizes the uploadmycode icon (same geometry as web/public/icon.svg) to PNG.
// No dependencies: shapes are sampled per pixel with 4x4 supersampling, PNG written with zlib.
// Usage: node scripts/make-icons.mjs <outDir>
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

const OUT = process.argv[2] || ".";
const TEAL = [0x1f, 0x9f, 0xa5], WHITE = [0xff, 0xff, 0xff], DARK = [0x0f, 0x3d, 0x40];

// Geometry in the 64-unit SVG space. Each shape: (x, y) -> inside?
const rrect = (x, y, w, h, r) => (px, py) => {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r), cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};
const circle = (cx, cy, r) => (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
const tri = (ax, ay, bx, by, cx, cy) => (px, py) => {
  const s = (ax - cx) * (py - cy) - (ay - cy) * (px - cx), t = (bx - ax) * (py - ay) - (by - ay) * (px - ax), u = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  return (s >= 0 && t >= 0 && u >= 0) || (s <= 0 && t <= 0 && u <= 0);
};
// Smile: quadratic Bezier M24 41 Q32 48 40 41, stroke width 3 with round caps => distance to curve <= 1.5
const smilePts = Array.from({ length: 33 }, (_, i) => { const t = i / 32; return [(1 - t) ** 2 * 24 + 2 * (1 - t) * t * 32 + t * t * 40, (1 - t) ** 2 * 41 + 2 * (1 - t) * t * 48 + t * t * 41]; });
const smile = (px, py) => {
  for (let i = 0; i < smilePts.length - 1; i++) {
    const [x1, y1] = smilePts[i], [x2, y2] = smilePts[i + 1];
    const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    let t = ((px - x1) * dx + (py - y1) * dy) / l2; t = Math.max(0, Math.min(1, t));
    const qx = x1 + t * dx, qy = y1 + t * dy;
    if ((px - qx) ** 2 + (py - qy) ** 2 <= 1.5 * 1.5) return true;
  }
  return false;
};
const layers = [
  [rrect(0, 0, 64, 64, 14), TEAL],
  [tri(32, 5, 23, 15, 41, 15), WHITE], [rrect(29, 14, 6, 7, 0), WHITE],
  ...[27, 34, 41].flatMap(y => [[rrect(8, y, 6, 3, 1), WHITE], [rrect(50, y, 6, 3, 1), WHITE]]),
  [rrect(14, 20, 36, 31, 6), WHITE],
  [circle(25, 33, 3), DARK], [circle(39, 33, 3), DARK], [smile, DARK],
];

function render(size) {
  const px = new Uint8Array(size * size * 4), SS = 4, scale = 64 / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const ux = (x + (sx + 0.5) / SS) * scale, uy = (y + (sy + 0.5) / SS) * scale;
      let col = null;
      for (const [inside, c] of layers) if (inside(ux, uy)) col = c;
      if (col) { r += col[0]; g += col[1]; b += col[2]; a += 255; }
    }
    const n = SS * SS, i = (y * size + x) * 4, cov = a / n;
    if (cov > 0) { px[i] = Math.round(r / (a / 255)); px[i + 1] = Math.round(g / (a / 255)); px[i + 2] = Math.round(b / (a / 255)); px[i + 3] = Math.round(cov); }
  }
  return px;
}
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const px = render(size), raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
for (const [name, size] of [["icon-512.png", 512], ["icon-192.png", 192], ["apple-touch-icon.png", 180], ["favicon-32.png", 32]]) {
  const buf = png(size); writeFileSync(join(OUT, name), buf); console.log(`${name}  ${size}x${size}  ${buf.length} bytes`);
}

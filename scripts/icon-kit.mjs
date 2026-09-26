// The family icon kit, shared by uploadmycode, uploadmylaser, uploadmymodel and uploadmycut: keep the
// four copies of this file identical. Each site's scripts/make-icons.mjs only says what to draw.
//
// Look (Dalton, 2026-09-26): a sticker, drawn by hand. Every object has a dark ink outline in a deep
// shade of the site's colour, drawn right behind it, and every edge except the tile wobbles a little,
// so nothing is ruler-perfect. Writes icon.svg and the PNGs from the same shapes.
// No dependencies: shapes are sampled per pixel with 4x4 supersampling, PNG written with zlib.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

// Each shape: { svg, fill, inside(x, y), box: [x0, y0, x1, y1], crisp? } in the 64-unit space.
export const rrect = (x, y, w, h, r, fill) => ({
  svg: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`,
  fill,
  box: [x, y, x + w, y + h],
  inside: (px, py) => {
    if (px < x || py < y || px > x + w || py > y + h) return false;
    const cx = Math.min(Math.max(px, x + r), x + w - r), cy = Math.min(Math.max(py, y + r), y + h - r);
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  },
});

export const circle = (cx, cy, r, fill) => ({
  svg: `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`,
  fill,
  box: [cx - r, cy - r, cx + r, cy + r],
  inside: (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r,
});

export const poly = (pts, fill) => {
  const p = pts.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]);
  return {
    svg: `<polygon points="${p.map((q) => q.join(',')).join(' ')}" fill="${fill}"/>`,
    fill,
    box: [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))],
    inside: (px, py) => { // even-odd ray cast
      let c = false;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const [xi, yi] = p[i], [xj, yj] = p[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    },
  };
};

// A thick quadratic curve with round caps: smiles, bent arms, laser beams, spin marks.
export const curve = (x0, y0, qx, qy, x1, y1, width, stroke) => {
  const pts = Array.from({ length: 33 }, (_, i) => {
    const t = i / 32;
    return [(1 - t) ** 2 * x0 + 2 * (1 - t) * t * qx + t * t * x1, (1 - t) ** 2 * y0 + 2 * (1 - t) * t * qy + t * t * y1];
  });
  const r2 = (width / 2) ** 2, h = width / 2;
  return {
    svg: `<path d="M${x0} ${y0} Q${qx} ${qy} ${x1} ${y1}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`,
    fill: stroke,
    stroked: width,
    box: [Math.min(...pts.map((q) => q[0])) - h, Math.min(...pts.map((q) => q[1])) - h, Math.max(...pts.map((q) => q[0])) + h, Math.max(...pts.map((q) => q[1])) + h],
    inside: (px, py) => pts.some(([ax, ay], i) => {
      if (i === pts.length - 1) return false;
      const [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
      return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2 <= r2;
    }),
  };
};

/** The tile every family icon sits on. It stays crisp; everything on it wobbles. */
export const tile = (fill) => ({ ...rrect(0, 0, 64, 64, 14, fill), crisp: true });

/**
 * The inked outline for a group of parts: the parts grown by `w` in `inkColour`. Put it right
 * before the parts, so a later object's outline overlaps an earlier object like a sticker.
 */
export const ink = (parts, inkColour, w = 1.25) => ({
  svg: parts.map((p) => (p.stroked
    ? p.svg.replace(/stroke="[^"]*"/, `stroke="${inkColour}"`).replace(/stroke-width="[^"]*"/, `stroke-width="${+(p.stroked + 2 * w).toFixed(2)}"`)
    : p.svg.replace(/fill="[^"]*"/, `fill="${inkColour}" stroke="${inkColour}" stroke-width="${2 * w}" stroke-linejoin="round"`))).join('\n  '),
  fill: inkColour,
  box: [Math.min(...parts.map((p) => p.box[0])) - w, Math.min(...parts.map((p) => p.box[1])) - w, Math.max(...parts.map((p) => p.box[2])) + w, Math.max(...parts.map((p) => p.box[3])) + w],
  inside: (px, py) => {
    for (const p of parts) {
      const b = p.box;
      if (px < b[0] - w || px > b[2] + w || py < b[1] - w || py > b[3] + w) continue;
      if (p.inside(px, py)) return true;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * 2 * Math.PI;
        if (p.inside(px + w * Math.cos(a), py + w * Math.sin(a))) return true;
      }
    }
    return false;
  },
});

/** An object with its outline: [outline, ...parts]. */
export const inked = (parts, inkColour, w) => [ink(parts, inkColour, w), ...parts];

// The hand-drawn wobble: a smooth, fixed displacement of the drawing (never random between runs).
// SVG uses the same idea through feTurbulence, so the two are alike, not pixel-identical.
const WOBBLE = 0.3; // units of the 64-unit space: slow waves, like a steady hand, not a shaky one
const warp = (x, y) => [
  x + WOBBLE * (Math.sin(y * 0.29 + 1.7) + 0.35 * Math.sin(y * 0.61 + x * 0.17 + 0.4)),
  y + WOBBLE * (Math.sin(x * 0.27 + 0.3) + 0.35 * Math.sin(x * 0.57 - y * 0.13 + 2.2)),
];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function render(shapes, size) {
  const px = Buffer.alloc(size * size * 4), SS = 4, scale = 64 / size;
  const cols = shapes.map((s) => hex(s.fill));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const ux = (x + (sx + 0.5) / SS) * scale, uy = (y + (sy + 0.5) / SS) * scale;
      const [wx, wy] = warp(ux, uy);
      // Top shape first; the first hit wins.
      for (let i = shapes.length - 1; i >= 0; i--) {
        const s = shapes[i], qx = s.crisp ? ux : wx, qy = s.crisp ? uy : wy, bx = s.box;
        if (qx < bx[0] || qx > bx[2] || qy < bx[1] || qy > bx[3] || !s.inside(qx, qy)) continue;
        r += cols[i][0]; g += cols[i][1]; b += cols[i][2]; a += 255;
        break;
      }
    }
    const n = SS * SS, o = (y * size + x) * 4, cov = a / 255;
    px[o] = cov ? r / cov : 0; px[o + 1] = cov ? g / cov : 0; px[o + 2] = cov ? b / cov : 0; px[o + 3] = a / n;
  }
  return png(size, px);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Write icon.svg and the PNG sizes into `out`. `about` goes into the SVG comment. */
export function writeIcons(out, shapes, about) {
  const crisp = shapes.filter((s) => s.crisp).map((s) => s.svg);
  const drawn = shapes.filter((s) => !s.crisp).map((s) => s.svg);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <!-- ${about} Generated by scripts/make-icons.mjs with scripts/icon-kit.mjs, edit it there. -->
  <defs><filter id="wobble" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="1" seed="7"/><feDisplacementMap in="SourceGraphic" scale="0.9" xChannelSelector="R" yChannelSelector="G"/></filter></defs>
  ${crisp.join('\n  ')}
  <g filter="url(#wobble)">
  ${drawn.join('\n  ')}
  </g>
</svg>
`;
  writeFileSync(join(out, 'icon.svg'), svg);
  for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    writeFileSync(join(out, name), render(shapes, size));
  }
  console.log('icons written to', out);
}

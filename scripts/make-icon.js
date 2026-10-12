'use strict';
// Draws the app icon (dark tile, grey limit ring with a pace tick) and writes build/icon.ico + build/icon.png.
// No image libraries: rasterised with 4x4 supersampling, PNG via zlib, ICO with BMP frames + a 256px PNG frame.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'build');

function draw(size) {
  const ss = 4, px = new Float64Array(size * size * 4);
  const c = size / 2, R = size * 0.5, corner = size * 0.22;
  // A 270° gauge open at the bottom (like the overlay's bars, bent round): grey fill, dark track, amber pace tick.
  const ro = size * 0.36, ri = size * 0.25, cy = c + size * 0.03;
  const START = -135, SWEEP = 270, FILL = 0.62, PACE = 0.45;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const fx = x + (sx + 0.5) / ss, fy = y + (sy + 0.5) / ss;
      // rounded-square tile
      const qx = Math.max(Math.abs(fx - c) - (R - corner), 0), qy = Math.max(Math.abs(fy - c) - (R - corner), 0);
      if (Math.hypot(qx, qy) > corner) continue;
      let col = [24, 24, 27];
      const d = Math.hypot(fx - c, fy - cy);
      const deg = Math.atan2(fx - c, -(fy - cy)) * 180 / Math.PI;          // 0 = up, clockwise positive
      const t = (deg - START + 360) % 360 / SWEEP;                         // 0..1 along the gauge, >1 = the gap
      if (d >= ri && d <= ro && t <= 1) col = t <= FILL ? [222, 222, 222] : [58, 58, 64];
      // pace tick: thin radial mark across the ring at PACE
      const pa = (START + SWEEP * PACE) * Math.PI / 180, tx = Math.sin(pa), ty = -Math.cos(pa);
      const along = (fx - c) * tx + (fy - cy) * ty, across = Math.abs((fx - c) * ty - (fy - cy) * tx);
      if (along > ri - size * 0.02 && along < ro + size * 0.02 && across < Math.max(0.7, size * 0.022)) col = [212, 162, 70];
      acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255;
    }
    const n = ss * ss, i = (y * size + x) * 4, a = acc[3] / n;
    px[i] = a ? acc[0] / (acc[3] / 255) : 0; px[i + 1] = a ? acc[1] / (acc[3] / 255) : 0; px[i + 2] = a ? acc[2] / (acc[3] / 255) : 0; px[i + 3] = a;
  }
  return Uint8Array.from(px, v => Math.round(Math.min(255, Math.max(0, v))));
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function bmpFrame(size, rgba) {
  // 32-bit BGRA DIB, bottom-up, height doubled for the (empty) AND mask
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0); hdr.writeInt32LE(size, 4); hdr.writeInt32LE(size * 2, 8); hdr.writeUInt16LE(1, 12); hdr.writeUInt16LE(32, 14);
  const pix = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const s = (y * size + x) * 4, d = ((size - 1 - y) * size + x) * 4;
    pix[d] = rgba[s + 2]; pix[d + 1] = rgba[s + 1]; pix[d + 2] = rgba[s]; pix[d + 3] = rgba[s + 3];
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([hdr, pix, mask]);
}

fs.mkdirSync(OUT, { recursive: true });
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const frames = sizes.map(s => { const r = draw(s); return { s, data: s === 256 ? png(s, r) : bmpFrame(s, r) }; });
const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(frames.length, 4);
let offset = 6 + 16 * frames.length;
const dir = frames.map(f => {
  const e = Buffer.alloc(16);
  e[0] = f.s === 256 ? 0 : f.s; e[1] = f.s === 256 ? 0 : f.s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(f.data.length, 8); e.writeUInt32LE(offset, 12); offset += f.data.length;
  return e;
});
fs.writeFileSync(path.join(OUT, 'icon.ico'), Buffer.concat([head, ...dir, ...frames.map(f => f.data)]));
fs.writeFileSync(path.join(OUT, 'icon.png'), png(512, draw(512)));
console.log('wrote build/icon.ico (' + sizes.join(', ') + ') and build/icon.png (512)');

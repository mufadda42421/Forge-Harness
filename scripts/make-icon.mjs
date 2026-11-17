// Generate a flat, minimal Forge Harness icon: amber "F" on dark charcoal.
// Builds a real PNG encoder + PNG-in-ICO wrapper (no external deps).
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const SIZE = 256;
const BG = [11, 13, 16];          // #0b0d10
const AMBER = [232, 179, 75];     // #e8b34b
const AMBER_HI = [242, 197, 102]; // #f2c566

const px = new Uint8Array(SIZE * SIZE * 4);
const radius = 40;

function setPx(x, y, rgb, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = a;
}
function fillRoundRect(x0, y0, x1, y1, r, rgb) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let inside = true;
      const corners = [[x0 + r, y0 + r], [x1 - 1 - r, y0 + r], [x0 + r, y1 - 1 - r], [x1 - 1 - r, y1 - 1 - r]];
      const inCorner = (cx, cy) => {
        const dx = x - cx, dy = y - cy;
        return dx * dx + dy * dy > r * r;
      };
      if (x < x0 + r && y < y0 + r && inCorner(corners[0][0], corners[0][1])) inside = false;
      else if (x >= x1 - r && y < y0 + r && inCorner(corners[1][0], corners[1][1])) inside = false;
      else if (x < x0 + r && y >= y1 - r && inCorner(corners[2][0], corners[2][1])) inside = false;
      else if (x >= x1 - r && y >= y1 - r && inCorner(corners[3][0], corners[3][1])) inside = false;
      if (inside) setPx(x, y, rgb);
    }
  }
}
const lerp = (a, b, t) => Math.round(a + (b - a) * t);

// Background: rounded dark square, subtle vertical falloff
fillRoundRect(0, 0, SIZE, SIZE, radius, BG);
for (let y = 0; y < SIZE; y++) {
  const t = y / SIZE;
  if (t > 0.6) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      if (px[i + 3] === 255 && px[i] === BG[0]) {
        const k = (t - 0.6) * 0.5; // darken top..bottom? subtle lighten instead
        px[i] = Math.min(255, BG[0] + Math.round(30 * k));
        px[i + 1] = Math.min(255, BG[1] + Math.round(34 * k));
        px[i + 2] = Math.min(255, BG[2] + Math.round(40 * k));
      }
    }
  }
}

// Letter "F" — forged from two tones (amber body, hi-amber top edge)
const LX = 74, LW = 30;                 // vertical bar x, width
const TOP_Y = 64, TOP_H = 28;           // top bar
const MID_Y = 128, MID_H = 24;          // middle bar
const BAR_R = 6;
fillRoundRect(LX, TOP_Y, LX + 108, TOP_Y + TOP_H, BAR_R, AMBER);       // top bar
fillRoundRect(LX, MID_Y, LX + 84, MID_Y + MID_H, BAR_R, AMBER);        // middle bar
fillRoundRect(LX, TOP_Y, LX + LW, TOP_Y + 132, BAR_R, AMBER);          // vertical stem
// hi-amber top edges
fillRoundRect(LX, TOP_Y, LX + 108, TOP_Y + 6, BAR_R, AMBER_HI);
fillRoundRect(LX, MID_Y, LX + 84, MID_Y + 6, BAR_R, AMBER_HI);
fillRoundRect(LX, TOP_Y, LX + LW, TOP_Y + 6, BAR_R, AMBER_HI);

// ---------- minimal PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  raw[y * (1 + SIZE * 4)] = 0; // filter: none
  px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4);
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (1 + SIZE * 4) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
console.log(`PNG: ${png.length} bytes`);

// ---------- PNG-in-ICO wrapper ----------
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0); icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4);
const icoEntry = Buffer.alloc(16);
icoEntry.writeUInt8(0, 0);           // 256px
icoEntry.writeUInt8(0, 1);
icoEntry.writeUInt8(0, 2);
icoEntry.writeUInt8(0, 3);
icoEntry.writeUInt16LE(1, 4);        // planes
icoEntry.writeUInt16LE(32, 6);       // bit count
icoEntry.writeUInt32LE(png.length, 8);
icoEntry.writeUInt32LE(6 + 16, 12);  // offset
const ico = Buffer.concat([icoHeader, icoEntry, png]);

const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "../packages");
void outDir;
const assetsDir = path.resolve(process.cwd(), "installer", "assets");
fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, "icon.png"), png);
fs.writeFileSync(path.join(assetsDir, "icon.ico"), ico);
console.log(`wrote ${path.join(assetsDir, "icon.png")} (${png.length} B)`);
console.log(`wrote ${path.join(assetsDir, "icon.ico")} (${ico.length} B)`);

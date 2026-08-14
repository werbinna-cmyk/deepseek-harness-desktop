// Generate the app icon and emit resources/icon.icns for electron-builder.
//
// Usage:
//   node scripts/make-icon.mjs                     draw the built-in D-mark icon
//   node scripts/make-icon.mjs --from <image.webp> use the given image, placed
//                                                  inside a macOS-style squircle
//
// The rasterizer is pure Node (zlib + a small PNG encoder/decoder); sips and
// iconutil (both built into macOS) handle format conversion and the .icns.

import { execFileSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = join(ROOT, 'resources', 'icon-master.png');
const ICONSET = join(ROOT, 'resources', 'icon.iconset');
const ICNS = join(ROOT, 'resources', 'icon.icns');

const args = process.argv.slice(2);
const fromIdx = args.indexOf('--from');
const FROM = fromIdx >= 0 ? args[fromIdx + 1] : null;

// ── PNG encoding ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ── PNG decoding (8-bit, color types 0/2/3/6) ──────────────────────────────

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 3: 1, 6: 4 }[colorType];
  if (channels === undefined) throw new Error(`unsupported color type ${colorType}`);
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  const pal = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const recon = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? recon[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      recon[x] = v & 0xff;
    }
    prev = recon;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 6) {
        out[o] = recon[x * 4];
        out[o + 1] = recon[x * 4 + 1];
        out[o + 2] = recon[x * 4 + 2];
        out[o + 3] = recon[x * 4 + 3];
      } else if (colorType === 2) {
        out[o] = recon[x * 3];
        out[o + 1] = recon[x * 3 + 1];
        out[o + 2] = recon[x * 3 + 2];
        out[o + 3] = 255;
      } else if (colorType === 0) {
        out[o] = recon[x];
        out[o + 1] = recon[x];
        out[o + 2] = recon[x];
        out[o + 3] = 255;
      } else {
        // palette (PLTE must have been parsed; keep a deferred lookup)
        pal.push(recon[x]);
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 255;
      }
    }
  }
  if (colorType === 3) {
    // re-read PLTE properly
    let plte = null;
    pos = 8;
    while (pos < buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('ascii', pos + 4, pos + 8);
      const data = buf.subarray(pos + 8, pos + 8 + len);
      if (type === 'PLTE') {
        plte = data;
        break;
      }
      if (type === 'IEND') break;
      pos += 12 + len;
    }
    for (let i = 0; i < width * height; i++) {
      const idx = pal[i];
      out[i * 4] = plte[idx * 3];
      out[i * 4 + 1] = plte[idx * 3 + 1];
      out[i * 4 + 2] = plte[idx * 3 + 2];
      out[i * 4 + 3] = 255;
    }
  }
  return { width, height, rgba: out };
}

// ── drawing helpers ────────────────────────────────────────────────────────

const S = 1024;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function cov(d) {
  const t = 1 - Math.min(1, Math.max(0, d));
  return t * t * (3 - 2 * t);
}

// macOS-style squircle: content inset by ~9.5%, corner radius ~22.5% of size.
const MARGIN = Math.round(S * 0.095);
const RADIUS = Math.round(S * 0.225);
const CX = S / 2;
const CY = S / 2;
const HALF = S / 2 - MARGIN;

function squircleAlpha(x, y) {
  const qx = Math.max(Math.abs(x - CX) - (HALF - RADIUS), 0);
  const qy = Math.max(Math.abs(y - CY) - (HALF - RADIUS), 0);
  // SDF: dist < RADIUS is inside (opaque), dist > RADIUS outside.
  return cov(Math.sqrt(qx * qx + qy * qy) - RADIUS);
}

function makeCanvas() {
  return Buffer.alloc(S * S * 4);
}

function put(canvas, x, y, r, g, b, a) {
  const i = (y * S + x) * 4;
  canvas[i] = r;
  canvas[i + 1] = g;
  canvas[i + 2] = b;
  canvas[i + 3] = a;
}

/** Blend a source RGBA pixel over `dst` with given cover alpha. */
function blendOver(dst, dstIdx, sr, sg, sb, sa, cover) {
  const a = dst[dstIdx + 3] / 255;
  const na = a + sa * cover * (1 - a);
  if (na <= 0) return;
  const k = (sa * cover) / na;
  dst[dstIdx] = Math.round(lerp(dst[dstIdx], sr, k));
  dst[dstIdx + 1] = Math.round(lerp(dst[dstIdx + 1], sg, k));
  dst[dstIdx + 2] = Math.round(lerp(dst[dstIdx + 2], sb, k));
  dst[dstIdx + 3] = Math.round(na * 255);
}

function bilinear(src, sw, sh, u, v) {
  const x = Math.min(Math.max(u, 0), sw - 1.0001);
  const y = Math.min(Math.max(v, 0), sh - 1.0001);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, sw - 1);
  const y1 = Math.min(y0 + 1, sh - 1);
  const fx = x - x0;
  const fy = y - y0;
  const p00 = y0 * sw + x0;
  const p10 = y0 * sw + x1;
  const p01 = y1 * sw + x0;
  const p11 = y1 * sw + x1;
  const out = [];
  for (let c = 0; c < 4; c++) {
    const v00 = src[p00 * 4 + c];
    const v10 = src[p10 * 4 + c];
    const v01 = src[p01 * 4 + c];
    const v11 = src[p11 * 4 + c];
    out.push(lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy));
  }
  return out;
}

/**
 * Remove a near-white background by flood-filling from the image borders
 * (4-connected). Artwork photos usually ship with a solid white backdrop; the
 * icon looks far better with that backdrop cut out so the subject sits on the
 * dark squircle. Returns a new RGBA buffer.
 */
function removeWhiteBackground(src) {
  const { width: w, height: h, rgba } = src;
  const out = Buffer.from(rgba);
  const isWhite = (i) => {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    return r >= 235 && g >= 235 && b >= 235 && Math.max(r, g, b) - Math.min(r, g, b) <= 14;
  };
  const seen = new Uint8Array(w * h);
  const queue = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h || seen[y * w + x]) return;
    seen[y * w + x] = 1;
    queue.push(y * w + x);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (queue.length) {
    const i = queue.pop();
    const x = i % w;
    const y = (i / w) | 0;
    if (!isWhite(i * 4)) continue;
    out[i * 4 + 3] = 0;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  return { width: w, height: h, rgba: out };
}

/** Compose the (white-stripped) artwork inside the squircle on a dark gradient. */
function composeFromImage(src) {
  const canvas = makeCanvas();
  const bgTop = [13, 17, 23];
  const bgBot = [26, 34, 48];
  const src2 = removeWhiteBackground(src);
  const inner = HALF * 2; // content box (squircle inner square)
  const scale = inner / src2.width;
  const ox = (S - src2.width * scale) / 2;
  const oy = (S - src2.height * scale) / 2;
  for (let y = 0; y < S; y++) {
    const t = y / S;
    const bgR = lerp(bgTop[0], bgBot[0], t);
    const bgG = lerp(bgTop[1], bgBot[1], t);
    const bgB = lerp(bgTop[2], bgBot[2], t);
    for (let x = 0; x < S; x++) {
      const alpha = squircleAlpha(x, y);
      if (alpha <= 0.001) continue;
      const idx = (y * S + x) * 4;
      canvas[idx] = bgR;
      canvas[idx + 1] = bgG;
      canvas[idx + 2] = bgB;
      canvas[idx + 3] = Math.round(alpha * 255);
      const [sr, sg, sb, sa] = bilinear(src2.rgba, src2.width, src2.height, (x - ox) / scale, (y - oy) / scale);
      blendOver(canvas, idx, Math.round(sr), Math.round(sg), Math.round(sb), sa / 255, alpha);
    }
  }
  return canvas;
}

/** The built-in fallback mark: a "D" ring open on the right + bar. */
function composeFallback() {
  const canvas = makeCanvas();
  const BG_TOP = [13, 17, 23];
  const BG_BOT = [22, 29, 41];
  const R = 292;
  const W = 108;
  const OPEN_HALF = 1.05;
  const BAR_X0 = CX + R - W / 2 - 6;
  const BAR_X1 = CX + R + W / 2 + 46;
  const C_TOP = [64, 156, 255];
  const C_BOT = [96, 165, 250];
  const paint = (edge, y, r, g, b, a) => {
    const ca = cov(edge); // edge<0 inside the stroke → opaque
    const ct = Math.min(1, Math.max(0, (y - 250) / 550));
    const cr = lerp(C_TOP[0], C_BOT[0], ct);
    const cg = lerp(C_TOP[1], C_BOT[1], ct);
    const cb = lerp(C_TOP[2], C_BOT[2], ct);
    const na = a + ca * (1 - a);
    return [
      (r * a + cr * ca * (1 - a)) / na,
      (g * a + cg * ca * (1 - a)) / na,
      (b * a + cb * ca * (1 - a)) / na,
      na,
    ];
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const alpha = squircleAlpha(x, y);
      if (alpha <= 0.001) continue;
      const t = y / S;
      let r = lerp(BG_TOP[0], BG_BOT[0], t);
      let g = lerp(BG_TOP[1], BG_BOT[1], t);
      let b = lerp(BG_TOP[2], BG_BOT[2], t);
      let a = alpha;
      const dx = x - CX;
      const dy = y - CY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ringEdge = Math.abs(dist - R) - W / 2;
      if (Math.abs(Math.atan2(dy, dx)) >= OPEN_HALF && ringEdge < 1) {
        [r, g, b, a] = paint(ringEdge, y, r, g, b, a);
      }
      if (x >= BAR_X0 && x <= BAR_X1) {
        const edge = Math.max(BAR_X0 - x, x - BAR_X1, Math.abs(y - CY) - (R - W / 2));
        if (edge < 1) [r, g, b, a] = paint(edge, y, r, g, b, a);
      }
      const idx = (y * S + x) * 4;
      canvas[idx] = Math.round(r);
      canvas[idx + 1] = Math.round(g);
      canvas[idx + 2] = Math.round(b);
      canvas[idx + 3] = Math.round(a * 255);
    }
  }
  return canvas;
}

// ── main ───────────────────────────────────────────────────────────────────

mkdirSync(dirname(MASTER), { recursive: true });
let canvas;
if (FROM) {
  console.log(`compositing icon from ${FROM} …`);
  const tmp = join(ROOT, 'resources', '.icon-source.png');
  execFileSync('sips', ['-s', 'format', 'png', FROM, '--out', tmp], { stdio: 'ignore' });
  const decoded = decodePng(readFileSync(tmp));
  rmSync(tmp, { force: true });
  canvas = composeFromImage(decoded);
  console.log(`source ${decoded.width}x${decoded.height} composited`);
} else {
  console.log('drawing built-in mark …');
  canvas = composeFallback();
}
writeFileSync(MASTER, encodePng(S, S, canvas));
console.log(`master: ${MASTER}`);

rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });
const sizes = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];
for (const [name, size] of sizes) {
  execFileSync('sips', ['-z', String(size), String(size), MASTER, '--out', join(ICONSET, name)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', ICNS], { stdio: 'ignore' });
console.log(`icns: ${ICNS}`);

// ── Windows .ico (multi-size, PNG-compressed entries) ───────────────────────

const ICO = join(ROOT, 'resources', 'icon.ico');
const icoSizes = [16, 32, 48, 64, 128, 256];
const icoPngs = [];
const tmpIcoDir = join(ROOT, 'resources', '.icon-ico');
mkdirSync(tmpIcoDir, { recursive: true });
for (const size of icoSizes) {
  const file = join(tmpIcoDir, `${size}.png`);
  execFileSync('sips', ['-z', String(size), String(size), MASTER, '--out', file], { stdio: 'ignore' });
  icoPngs.push({ size, data: readFileSync(file) });
}
rmSync(tmpIcoDir, { recursive: true, force: true });
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(icoPngs.length, 4);
const entries = [];
let offset = 6 + 16 * icoPngs.length;
for (const { size, data } of icoPngs) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += data.length;
}
writeFileSync(ICO, Buffer.concat([header, ...entries, ...icoPngs.map((p) => p.data)]));
console.log(`ico: ${ICO}`);

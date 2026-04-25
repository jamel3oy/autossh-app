'use strict';

/**
 * trayIcon.js — Generates tray icon PNG buffers using only Node.js built-ins.
 *
 * Design: a right-pointing arrow (→) representing SSH port forwarding.
 *
 * Two states:
 *   stopped — broken arrow (gap in shaft) — marked as macOS template image
 *             so the OS auto-tints it white/black for light/dark menu bar
 *   running — solid green arrow (keeps color to show active state)
 *
 * Output: 36×36 RGBA PNG rendered at 18 pt on Retina (scaleFactor 2.0).
 * No external dependencies — pure Node.js (zlib, manual CRC32).
 */

const zlib = require('zlib');

// ─── CRC32 (required by PNG spec) ─────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ─── PNG Chunk Builder ─────────────────────────────────────────────────────────

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, crcBuf]);
}

// ─── Anti-aliased Shape Helpers ───────────────────────────────────────────────

/**
 * Coverage of pixel (px,py) inside an axis-aligned rectangle, with 1px feather.
 */
function rectCov(px, py, left, right, top, bottom) {
  const dx = Math.min(px - left + 0.5, right - px + 0.5);
  const dy = Math.min(py - top + 0.5, bottom - py + 0.5);
  return Math.max(0, Math.min(1, dx, dy));
}

/**
 * Coverage of pixel (px,py) inside a right-pointing triangle:
 *   base at x=baseX, tip at x=tipX, midpoint at y=midY, half-height=halfH at base.
 */
function triCov(px, py, baseX, tipX, midY, halfH) {
  if (px < baseX - 0.5 || px > tipX + 0.5) return 0;
  const t       = (tipX - px) / (tipX - baseX); // 0 at tip, 1 at base
  const halfRow = t * halfH;
  const vDist   = halfRow + 0.5 - Math.abs(py - midY);
  const xLeft   = px - baseX + 0.5;
  const xRight  = tipX - px + 0.5;
  return Math.max(0, Math.min(1, vDist, xLeft, xRight));
}

// ─── Icon Renderer ─────────────────────────────────────────────────────────────

/**
 * Build a PNG buffer for the tray icon.
 *
 * Arrow at 36×36 (all measurements in pixels, scaled proportionally):
 *   Shaft:     x ∈ [3, 22],  y ∈ [15, 21]
 *   Gap:       x ∈ [10, 14]  (stopped only — shows a break in the connection)
 *   Arrowhead: base at x=18, tip at x=33, half-height 9px at base
 *
 * @param {boolean} running   true → solid green arrow  |  false → broken black arrow
 * @param {number}  [size=36] Canvas size in pixels
 * @returns {Buffer} Raw PNG bytes
 */
function makeTrayPNG(running, size = 36) {
  // Running: macOS system green. Stopped: pure black (template image — OS handles tinting).
  const [R, G, B] = running ? [52, 199, 89] : [0, 0, 0];

  const s  = size / 36;
  const cy = size / 2;

  // Shaft
  const shL = 3 * s,  shR = 22 * s;
  const shT = 15 * s, shB = 21 * s;
  // Gap (stopped only)
  const gapL = 10 * s, gapR = 14 * s;
  // Arrowhead
  const ahBase = 18 * s, ahTip = 33 * s, ahHalf = 9 * s;

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // PNG filter type: None
    for (let x = 0; x < size; x++) {
      let shaft;
      if (running) {
        shaft = rectCov(x, y, shL, shR, shT, shB);
      } else {
        // Two segments around the gap
        shaft = Math.max(
          rectCov(x, y, shL,  gapL, shT, shB),
          rectCov(x, y, gapR, shR,  shT, shB),
        );
      }
      const head     = triCov(x, y, ahBase, ahTip, cy, ahHalf);
      const coverage = Math.min(1, Math.max(shaft, head));

      const o = 1 + x * 4;
      row[o]     = R;
      row[o + 1] = G;
      row[o + 2] = B;
      row[o + 3] = Math.round(coverage * 255);
    }
    rows.push(row);
  }

  const compressed = zlib.deflateSync(Buffer.concat(rows), { level: 6 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bits per channel
  ihdr.writeUInt8(6, 9); // color type 6 = RGBA

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { makeTrayPNG };

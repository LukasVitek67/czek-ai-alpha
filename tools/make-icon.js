// Vygeneruje ikonu (PNG 256×256): zaoblený čtverec, ve kterém je „Z“ složené ze závorek kódu.
const zlib = require('zlib'), fs = require('fs'), path = require('path');
const N = 256, SS = 4;
const px = Buffer.alloc(N * N * 4);
function crc32(b) { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
const inRound = (x, y, r, m) => { const a = m, b = N - m; const cx = Math.min(Math.max(x, a + r), b - r), cy = Math.min(Math.max(y, a + r), b - r); return x >= a && x <= b && y >= a && y <= b && (x - cx) ** 2 + (y - cy) ** 2 <= r * r; };
// Č (C s háčkem pro czek-ai: Czech AI / čekaj)
function distSeg(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / l2));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}
function inCzek(x, y) {
  // C oblouk
  const cx = 132, cy = 142, rOut = 56, rIn = 32;
  const dx = x - cx, dy = y - cy;
  const r = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx); // -PI..PI, 0 je vpravo
  if (r >= rIn && r <= rOut && Math.abs(ang) >= 0.58) return true;
  // zaoblené konce C
  const rm = (rOut + rIn) / 2, rw = (rOut - rIn) / 2;
  for (const a of [-0.58, 0.58]) {
    if (Math.hypot(x - (cx + rm * Math.cos(a)), y - (cy + rm * Math.sin(a))) <= rw) return true;
  }
  // háček nad C
  if (distSeg(x, y, 108, 52, 130, 74) <= 10.5) return true;
  if (distSeg(x, y, 152, 52, 130, 74) <= 10.5) return true;
  return false;
}
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  let bg = 0, fg = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const X = x + (sx + 0.5) / SS, Y = y + (sy + 0.5) / SS;
    if (inRound(X, Y, 48, 8)) { bg++; if (inCzek(X, Y)) fg++; }
  }
  const a = bg / (SS * SS), f = fg / Math.max(1, bg);
  const bgc = [47, 111, 79], fgc = [244, 241, 232];
  const i = (y * N + x) * 4;
  for (let k = 0; k < 3; k++) px[i + k] = Math.round(bgc[k] * (1 - f) + fgc[k] * f);
  px[i + 3] = Math.round(a * 255);
}
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
for (const p of ['build/icon.png', 'src/renderer/icon.png']) fs.writeFileSync(path.join(__dirname, '..', p), png);
console.log('ikona', png.length, 'B');

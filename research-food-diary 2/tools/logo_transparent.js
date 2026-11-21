// Make the grey background of the GepnerLab wordmark transparent (no dependencies).
// Alpha comes from each pixel's distance to the background grey, so edges stay smooth.
const fs = require('fs'), zlib = require('zlib');
const [src, dst] = process.argv.slice(2);
const data = fs.readFileSync(src);
let pos = 8, idat = [], w, h, depth, ctype, interlace;
while (pos < data.length) {
  const n = data.readUInt32BE(pos), t = data.toString('latin1', pos + 4, pos + 8), c = data.subarray(pos + 8, pos + 8 + n);
  if (t === 'IHDR') { w = c.readUInt32BE(0); h = c.readUInt32BE(4); depth = c[8]; ctype = c[9]; interlace = c[12]; }
  if (t === 'IDAT') idat.push(c);
  pos += 12 + n;
}
if (depth !== 8 || interlace !== 0 || ![2, 6].includes(ctype)) throw new Error('unsupported PNG');
const bpp = ctype === 2 ? 3 : 4, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
const rows = []; let prev = Buffer.alloc(stride);
for (let y = 0, i = 0; y < h; y++, i += 1 + stride) {
  const f = raw[i], line = Buffer.from(raw.subarray(i + 1, i + 1 + stride));
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
    if (f === 1) line[x] = (line[x] + a) & 255;
    else if (f === 2) line[x] = (line[x] + b) & 255;
    else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
    else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
  }
  rows.push(line); prev = line;
}
const bg = [rows[2][0], rows[2][1], rows[2][2]];
const out = Buffer.alloc(h * (1 + w * 4));
rows.forEach((r, y) => {
  const o = y * (1 + w * 4); out[o] = 0;
  for (let x = 0; x < w; x++) {
    const px = [r[x * bpp], r[x * bpp + 1], r[x * bpp + 2]];
    const d = Math.max(...px.map((v, k) => Math.abs(v - bg[k])));
    const a = Math.min(255, Math.round(d * 255 / 70));
    const q = o + 1 + x * 4;
    if (!a) continue;
    const al = a / 255;
    for (let k = 0; k < 3; k++) out[q + k] = Math.max(0, Math.min(255, Math.round((px[k] - bg[k] * (1 - al)) / al)));
    out[q + 3] = a;
  }
});
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, 'latin1'), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(dst, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
console.log('background', bg, '->', dst, w + 'x' + h);

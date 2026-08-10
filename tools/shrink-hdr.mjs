import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2];
const dst = process.argv[3];
const targetW = Number(process.argv[4] ?? 512);

const buf = readFileSync(src);

let p = 0;
function readLine() {
  const start = p;
  while (buf[p] !== 0x0a) p += 1;
  const line = buf.toString('ascii', start, p);
  p += 1;
  return line;
}

if (!readLine().startsWith('#?')) throw new Error('not a radiance file');
let line = readLine();
while (line !== '') {
  if (/^FORMAT=/.test(line) && !/32-bit_rle_rgbe/.test(line)) {
    throw new Error(`unsupported format: ${line}`);
  }
  line = readLine();
}
const res = readLine().match(/^-Y (\d+) \+X (\d+)$/);
if (!res) throw new Error('unsupported resolution line');
const h = Number(res[1]);
const w = Number(res[2]);

const rgbe = new Uint8Array(w * h * 4);
let out = 0;
const rle = buf[p] === 2 && buf[p + 1] === 2 && ((buf[p + 2] << 8) | buf[p + 3]) === w;
if (!rle) {
  if (buf.length - p < w * h * 4) throw new Error('truncated flat scanline data');
  rgbe.set(buf.subarray(p, p + w * h * 4));
} else {
  for (let y = 0; y < h; y += 1) {
    p += 4;
    const row = new Uint8Array(w * 4);
    for (let c = 0; c < 4; c += 1) {
      let x = 0;
      while (x < w) {
        const count = buf[p];
        p += 1;
        if (count > 128) {
          const value = buf[p];
          p += 1;
          for (let i = 0; i < count - 128; i += 1, x += 1) row[x * 4 + c] = value;
        } else {
          for (let i = 0; i < count; i += 1, x += 1, p += 1) row[x * 4 + c] = buf[p];
        }
      }
    }
    rgbe.set(row, out);
    out += w * 4;
  }
}

function toFloat(i, o) {
  const e = rgbe[i * 4 + 3];
  const f = e === 0 ? 0 : 2 ** (e - 136);
  o[0] = rgbe[i * 4] * f;
  o[1] = rgbe[i * 4 + 1] * f;
  o[2] = rgbe[i * 4 + 2] * f;
}

const factor = Math.round(w / targetW);
const nw = Math.floor(w / factor);
const nh = Math.floor(h / factor);
const px = new Float32Array(nw * nh * 3);
const acc = new Float32Array(3);
for (let y = 0; y < nh; y += 1) {
  for (let x = 0; x < nw; x += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let dy = 0; dy < factor; dy += 1) {
      for (let dx = 0; dx < factor; dx += 1) {
        toFloat((y * factor + dy) * w + (x * factor + dx), acc);
        r += acc[0];
        g += acc[1];
        b += acc[2];
      }
    }
    const n = factor * factor;
    const o = (y * nw + x) * 3;
    px[o] = r / n;
    px[o + 1] = g / n;
    px[o + 2] = b / n;
  }
}

const header = Buffer.from(
  `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${nh} +X ${nw}\n`,
  'ascii',
);
const body = Buffer.alloc(nw * nh * 4);
let bo = 0;
for (let i = 0; i < nw * nh; i += 1) {
  const r = px[i * 3];
  const g = px[i * 3 + 1];
  const b = px[i * 3 + 2];
  const max = Math.max(r, g, b);
  if (max < 1e-32) {
    body[bo] = 0;
    body[bo + 1] = 0;
    body[bo + 2] = 0;
    body[bo + 3] = 0;
  } else {
    const e = Math.ceil(Math.log2(max));
    const s = 2 ** (128 - e - 8) * 256;
    body[bo] = Math.min(255, Math.floor(r * s));
    body[bo + 1] = Math.min(255, Math.floor(g * s));
    body[bo + 2] = Math.min(255, Math.floor(b * s));
    body[bo + 3] = e + 128;
  }
  bo += 4;
}
writeFileSync(dst, Buffer.concat([header, body]));
process.stdout.write(`${w}x${h} -> ${nw}x${nh}  ${buf.length} -> ${header.length + body.length} bytes\n`);

/**
 * 生成 public/favicon.png —— 与 public/favicon.svg 完全同一套几何，纯手工光栅化，
 * 不依赖任何第三方库（zlib 用 Node 内置）。SVG 图标在现代浏览器可用，
 * 但少数旧版浏览器 / 部分场景（书签、RSS、老 Safari）只认 PNG，故两者都要有。
 *
 * 用法：node tools/gen-favicon.mjs [尺寸]   默认 64
 * 改配色 / 改图形后重新执行即可；SVG 请同步手改。
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = Number(process.argv[2] || 64);
const SS = 4;                      // 每像素 4×4 超采样，边缘更平滑

/* ---------------- 设计参数（64 单位坐标系，输出时等比缩放） ---------------- */
const U = SIZE / 64;
const TILE_TOP = [0x2a, 0x51, 0x83];   // 深蓝（与 --nav-bg 同色系，略提亮）
const TILE_BOT = [0x16, 0x30, 0x4f];
const CHECK_COL = [0xd8, 0xb8, 0x77];  // 品牌金（--accent-2）
const RADIUS = 15 * U;                 // 圆角
const PTS = [[20, 33.5], [28, 41.5], [44, 24]].map(([x, y]) => [x * U, y * U]);
const STROKE = 6.5 * U;                // 对勾描边粗细（圆头圆角连接）

/* ---------------- 光栅化 ---------------- */
function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** 圆角矩形内：到「内缩矩形」的距离 <= 半径 */
function inTile(x, y) {
  const cx = Math.min(Math.max(x, RADIUS), SIZE - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), SIZE - RADIUS);
  return Math.hypot(x - cx, y - cy) <= RADIUS;
}

/** 采样一个亚像素：透明返回 null */
function sample(x, y) {
  if (!inTile(x, y)) return null;
  const k = y / SIZE;
  let col = [
    TILE_TOP[0] + (TILE_BOT[0] - TILE_TOP[0]) * k,
    TILE_TOP[1] + (TILE_BOT[1] - TILE_TOP[1]) * k,
    TILE_TOP[2] + (TILE_BOT[2] - TILE_TOP[2]) * k
  ];
  const d = Math.min(
    distToSeg(x, y, PTS[0][0], PTS[0][1], PTS[1][0], PTS[1][1]),
    distToSeg(x, y, PTS[1][0], PTS[1][1], PTS[2][0], PTS[2][1])
  );
  if (d <= STROKE / 2) col = CHECK_COL;
  return col;
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample((x + (sx + 0.5) / SS) , (y + (sy + 0.5) / SS));
        if (!c) continue;
        r += c[0]; g += c[1]; b += c[2]; n++;
      }
    }
    const i = (y * SIZE + x) * 4;
    if (!n) { rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0; continue; }
    // 每个亚采样要么完全不透明、要么完全透明，故颜色取被覆盖样本的均值、透明度取覆盖率
    rgba[i] = Math.round(r / n);
    rgba[i + 1] = Math.round(g / n);
    rgba[i + 2] = Math.round(b / n);
    rgba[i + 3] = Math.round((n / (SS * SS)) * 255);
  }
}

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, px) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型 RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 4 + 1);
    raw[off] = 0;                                  // 过滤方式：None
    px.copy(raw, off + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const out = path.join(ROOT, 'public', 'favicon.png');
fs.writeFileSync(out, encodePng(SIZE, SIZE, rgba));
console.log('已生成', out, `${SIZE}x${SIZE}`, fs.statSync(out).size + ' bytes');

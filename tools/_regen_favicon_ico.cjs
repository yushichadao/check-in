'use strict';
/* 由 public/favicon.svg 生成多尺寸、带透明通道的 public/favicon.ico（16/32/48/64/128/256）。
 * ICO 帧为 32bpp BGRA、自下而上、biHeight=2*尺寸，AND 掩码全 0（用 alpha 通道表达透明）。
 * 用法：node tools/_regen_favicon_ico.cjs */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(ROOT, 'public', 'favicon.svg'), 'utf8');

function bgraBottomUp(rgba, s) {
  const out = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) {
    const srcRow = (s - 1 - y) * s * 4;
    const dstRow = y * s * 4;
    for (let x = 0; x < s; x++) {
      const si = srcRow + x * 4, di = dstRow + x * 4;
      out[di] = rgba[si + 2]; out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si]; out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

function buildICO(frames) {
  const count = frames.length;
  const dirSize = 6 + count * 16;
  let off = dirSize;
  const entries = [], imageDatas = [];
  for (const f of frames) {
    const h = Buffer.alloc(40);
    h.writeUInt32LE(40, 0);
    h.writeInt32LE(f.size, 4);
    h.writeInt32LE(f.size * 2, 8);
    h.writeUInt16LE(1, 12);
    h.writeUInt16LE(32, 14);
    h.writeUInt32LE(0, 16);
    h.writeUInt32LE(f.xor.length + f.and.length, 20);
    const img = Buffer.concat([h, f.xor, f.and]);
    entries.push({ size: f.size, bytesInRes: img.length, imageOffset: off });
    imageDatas.push(img);
    off += img.length;
  }
  const dir = Buffer.alloc(dirSize);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(count, 4);
  let p = 6;
  for (const e of entries) {
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, p);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1);
    dir.writeUInt8(0, p + 2); dir.writeUInt8(0, p + 3);
    dir.writeUInt16LE(1, p + 4); dir.writeUInt16LE(32, p + 6);
    dir.writeUInt32LE(e.bytesInRes, p + 8);
    dir.writeUInt32LE(e.imageOffset, p + 12);
    p += 16;
  }
  return Buffer.concat([dir, ...imageDatas]);
}

(async () => {
  const svgData = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const sizes = [16, 32, 48, 64, 128, 256];
  const frames = [];
  for (const s of sizes) {
    await page.setContent(
      `<body style="margin:0;padding:0;line-height:0"><canvas id="c" width="${s}" height="${s}"></canvas>` +
      `<script>var img=new Image();img.onload=function(){var x=document.getElementById('c').getContext('2d');` +
      `x.drawImage(img,0,0,${s},${s});window.__d=x.getImageData(0,0,${s},${s}).data;window.__done=true;};` +
      `img.src='${svgData}';</script></body>`, { waitUntil: 'load' });
    await page.waitForFunction('window.__done===true', { timeout: 8000 });
    const rgba = await page.evaluate(() => Array.from(window.__d));
    const andBytes = Math.ceil(s / 32) * 4 * s;
    frames.push({ size: s, xor: bgraBottomUp(rgba, s), and: Buffer.alloc(andBytes, 0) });
    console.log('已栅格化', s + 'x' + s);
  }
  await browser.close();
  const ico = buildICO(frames);
  fs.writeFileSync(path.join(ROOT, 'public', 'favicon.ico'), ico);
  console.log('已生成 favicon.ico，大小', ico.length, '字节');
})().catch((e) => { console.error(e); process.exit(1); });

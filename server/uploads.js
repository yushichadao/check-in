'use strict';
/* 申诉附件（图片）存储
 * - 文件落在 data/uploads/YYYYMM/ 下（随数据库一起处于受保护的数据目录）
 * - 只接受图片；文件名随机，不信任客户端文件名，避免路径穿越
 * - 读取一律走鉴权路由，不对外静态暴露
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const UPLOAD_DIR = path.join(cfg.DATA_DIR, 'uploads');

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

/** 单张图片上限（base64 解码后字节） */
const MAX_BYTES = 6 * 1024 * 1024;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 保存一张图片（base64）。
 * @returns {{file:string, abs:string, mime:string, size:number}}
 */
function saveImage(base64, mime) {
  const type = String(mime || '').toLowerCase();
  const ext = MIME_EXT[type];
  if (!ext) {
    const e = new Error('仅支持 JPG / PNG / WebP / GIF 图片');
    e.status = 400;
    throw e;
  }
  const m = String(base64 || '').match(/^data:image\/[a-z+]+;base64,(.*)$/i);
  const raw = m ? m[1] : String(base64 || '');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) {
    const e = new Error('图片内容为空');
    e.status = 400;
    throw e;
  }
  if (buf.length > MAX_BYTES) {
    const e = new Error('单张图片不能超过 6MB');
    e.status = 413;
    throw e;
  }
  // 校验图片魔数，避免把任意二进制当图片存进来
  if (!looksLikeImage(buf)) {
    const e = new Error('文件内容不是有效图片');
    e.status = 400;
    throw e;
  }

  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const sub = `${now.getFullYear()}${p2(now.getMonth() + 1)}`;
  const dir = path.join(UPLOAD_DIR, sub);
  ensureDir(dir);
  // 服务器重命名并打上「时间戳戳记」：IMG-YYYYMMDD-HHMMSS-<随机>.<ext>
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  const name = `IMG-${stamp}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, buf);
  return {
    file: path.join(sub, name).replace(/\\/g, '/'),
    abs,
    mime: type,
    size: buf.length
  };
}

function looksLikeImage(buf) {
  if (buf.length < 4) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;                 // jpg
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true; // png
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return true;
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return true;
  return false;
}

/** 解析出绝对路径（防穿越：只允许 data/uploads 内） */
function resolve(file) {
  const rel = String(file || '').replace(/^[/\\]+/, '').replace(/\.\./g, '');
  const abs = path.resolve(UPLOAD_DIR, rel);
  if (!abs.startsWith(path.resolve(UPLOAD_DIR))) return null;
  return abs;
}

function readFile(file) {
  const abs = resolve(file);
  if (!abs || !fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}

function removeFile(file) {
  const abs = resolve(file);
  if (!abs) return;
  try { fs.unlinkSync(abs); } catch (e) { /* 忽略 */ }
}

/**
 * 清空全部已上传图片（清库用）。
 * 上传目录按「年月」分子目录存放，这里逐目录删除其中的文件，保留目录结构。
 * @returns {number} 已删除的文件数
 */
function clearAll() {
  let n = 0;
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return 0;
    for (const sub of fs.readdirSync(UPLOAD_DIR)) {
      const dir = path.join(UPLOAD_DIR, sub);
      let st;
      try { st = fs.statSync(dir); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, f)); n++; } catch (e) { /* 忽略单个文件失败 */ }
      }
    }
  } catch (e) { /* 忽略 */ }
  return n;
}

module.exports = { UPLOAD_DIR, saveImage, readFile, removeFile, resolve, clearAll, MAX_BYTES };

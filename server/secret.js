'use strict';
/* 敏感配置的加密存储：授权码在终端/界面上以明文显示（便于核对），
 * 但写入 .env 时加密保存，避免凭据以明文落在服务器磁盘上。
 *
 * 设计：
 *   · 算法 AES-256-GCM（Node 内置 crypto，无额外依赖），密文前缀 enc:v1:
 *   · 密钥默认放在 data/.secret-key（自动生成，权限 0600）；也可用环境变量 SECRET_KEY 指定
 *   · 读取时若不是 enc:v1: 前缀，按**明文原样返回**——兼容历史明文值与手工填写
 *   · 密钥文件丢失 = 密文无法解开，迁移服务器时必须连 data/.secret-key 一起复制
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DB_DIR ? path.resolve(process.env.DB_DIR) : path.join(ROOT, 'data');
const KEY_FILE = path.join(DATA_DIR, '.secret-key');
const PREFIX = 'enc:v1:';

/** 需要加密存储的键（目前只有发信授权码） */
const SECRET_KEYS = new Set(['SMTP_PASS']);
function isSecretKey(key) { return SECRET_KEYS.has(String(key || '').toUpperCase()); }

function loadKey() {
  if (process.env.SECRET_KEY) return crypto.createHash('sha256').update(String(process.env.SECRET_KEY)).digest();
  try {
    if (fs.existsSync(KEY_FILE)) {
      const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (hex.length === 64) return Buffer.from(hex, 'hex');
    }
  } catch (e) { /* 读不到就重新生成 */ }
  const k = crypto.randomBytes(32);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, k.toString('hex'), { mode: 0o600 });   // 仅属主可读写
  } catch (e) { /* 只读环境：密钥只存在于本次进程，解密会失败但不应崩溃 */ }
  return k;
}

function encrypt(plain) {
  const s = String(plain == null ? '' : plain);
  if (!s) return '';
  try {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
    const enc = Buffer.concat([c.update(s, 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
  } catch (e) {
    return s;                                  // 加密失败也不丢值（退回明文）
  }
}

function decrypt(stored) {
  const s = String(stored == null ? '' : stored).trim();
  if (!s) return '';
  if (!s.startsWith(PREFIX)) return s;          // 历史明文 / 手工填写：原样返回
  try {
    const buf = Buffer.from(s.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch (e) {
    return '';                                  // 密钥不匹配 / 数据损坏
  }
}

function isEncrypted(stored) { return String(stored || '').trim().startsWith(PREFIX); }
function keyFilePath() { return KEY_FILE; }

module.exports = { encrypt, decrypt, isEncrypted, isSecretKey, keyFilePath, PREFIX };

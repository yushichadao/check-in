'use strict';
/* .env 读写工具：保留注释、按 key 更新；首跑若无 .env 则以 .env.example 为模板复制。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const EXAMPLE = path.join(ROOT, '.env.example');

/**
 * 保证 .env 存在。
 * 注意：**不再复制 .env.example** —— 模板里 PORT=3000、BASE_PATH=/check-in 等只是示例，
 * 一旦复制就会变成"用户配置"，让「这个值来自 .env 还是内置默认」无法区分（TUI 状态面板会标错来源）。
 * 这里只建一个带说明的空文件：写了什么才有什么，其余一律走 server/config.js 的内置默认值。
 */
function ensureEnv() {
  if (!fs.existsSync(ENV)) {
    fs.writeFileSync(ENV,
      '# 由配置向导（npm run config）生成：只记录你改过的项，未写的项全部使用内置默认值。\n'
      + '# 全部可配项与说明见 .env.example（需要整份模板时可自行复制它）。\n', 'utf8');
  }
  return ENV;
}

function readRaw() {
  ensureEnv();
  return fs.readFileSync(ENV, 'utf8');
}

function parse() {
  const out = {};
  readRaw().split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
}

function getKey(key) {
  const v = parse()[key];
  return v === undefined ? '' : v;
}

function setKey(key, value) {
  ensureEnv();
  const lines = readRaw().split(/\r?\n/);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) continue;
    const m = lines[i].match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] === key) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV, lines.join('\n'));
  return ENV;
}

module.exports = { ENV, EXAMPLE, ensureEnv, readRaw, parse, getKey, setKey };

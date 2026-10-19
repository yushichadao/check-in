'use strict';
// Suppress console output during module loading (dotenv etc.)
const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;
console.log = () => {};
console.warn = () => {};
console.error = () => {};
/* 服务器终端配置向导（TUI）：纯 readline + ANSI，零额外依赖。入口：npm run config。
 *
 * 【交互目标】运维者在服务器终端打开后「傻瓜式」完成配置：
 *   ① 每屏先给状态，并直接说「下一步该做什么」；
 *   ② 填值处可直接回车＝不填；要作出选择的地方必须明确输入（首次部署走「1) 快速配置」）；
 *   ③ 邮件先选服务商预设，不用手填 host/port；
 *   ④ 输入即时校验，错了当场重问；
 *   ⑤ 授权码掩码输入不回显；
 *   ⑥ 配完可立刻「测试发一封邮件」验证；
 *   ⑦ 改动先入草稿，确认后才写入 .env，可反悔。
 *
 * 【设计语言】所有输出必须走本文件下半部的「呈现层」，禁止各自拼字符串：
 *   · 装饰一律 ASCII（- = [ ] >），避免 ①✔✘⚠→╔═║ 这类「宽度有歧义」的字符——
 *     它们在 Windows 终端常被按全角渲染，会让整列错位（中文内容仍按 2 列精确计算）；
 *   · 内容宽度统一 W=60 列，缩进统一 2 空格；
 *   · 分区标题 sec()：== 标题 ==== ；分隔线 hr()；状态行 kv()；提示 ok/fail/warn/tip；
 *   · 标记固定：[ok] 正常、[!!] 缺失/失败、[!] 警示、--> 引导、> 输入提示；
 *   · 颜色由 USE_COLOR 总开关控制（非 TTY 或 NO_COLOR=1 自动关闭）。
 *
 * 所有 .env 改动均保留注释（tools/env-util.js）；数据库相关操作前会提示先停止服务。 */
// readline removed: rawMode only
const fs = require('fs');
const net = require('net');
const http = require('http');
const env = require('./env-util');
const cfg = require('../server/config');
const secret = require('../server/secret');
const db = require('../server/db');
const init = require('./init');
const path = require('path');
const { spawn, execSync } = require('child_process');

// rl removed

/* ═══ 全局单例 rawMode 输入管理器：避免 data 监听器累积 ═══ */
const _rawInput = {
  active: false,
  handler: null,
  ensureInit() {
    if (this.active) return;
    this.active = true;
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(true);
    // 禁用 Ctrl+C 退出，TUI 自行处理退出逻辑
    try { process.removeAllListeners('SIGINT'); process.on('SIGINT', () => {}); } catch(e) {}
    process.stdin.resume();
    process.stdin.on('data', (chunk) => {
      if (this.handler) this.handler(chunk);
    });
  },
  setHandler(fn) { this.handler = fn; },
  clearHandler() { this.handler = null; },
};

function ask(q, prefix) {
  process.stdout.write(q);
  if (!process.stdin.isTTY) {
    return new Promise((res) => {
      let buf = '';
      const onReadable = () => {
        let chunk;
        while ((chunk = process.stdin.read()) !== null) {
          for (let i = 0; i < chunk.length; i++) {
            if (chunk[i] === 10 || chunk[i] === 13) {
              process.stdin.removeListener('readable', onReadable);
              process.stdin.removeListener('end', onEnd);
              res(buf); return;
            }
            if (chunk[i] >= 32) buf += String.fromCharCode(chunk[i]);
          }
        }
      };
      const onEnd = () => { process.stdin.removeListener('readable', onReadable); res(buf); };
      process.stdin.on('readable', onReadable);
      process.stdin.on('end', onEnd);
    });
  }
  return new Promise((resolve) => {
    let buf = '';
    let utf8Buf = Buffer.alloc(0);
    let escSeq = '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      _rawInput.clearHandler();
      process.stdout.write('\n');
      resolve(val);
    };
    const pfx = prefix || q || '';
    const redraw = () => {
      // \r 回到行首，\x1b[K 先清除整行（含 CloudShell 回显残留），再写回前缀+缓冲
      process.stdout.write('\r\x1b[2K' + pfx + buf);
    };
    const onData = (chunk) => {
      if (settled) return;
      // 粘贴内容中的换行符剥离（避免自动提交），但保留可打印字符
      const hasNewline = chunk.includes(13) || chunk.includes(10);
      const isPaste = chunk.length > 4 && hasNewline;
      if (isPaste) {
        const filtered = Buffer.from([...chunk].filter(b => b !== 13 && b !== 10));
        utf8Buf = Buffer.concat([utf8Buf, filtered]);
      } else {
        utf8Buf = Buffer.concat([utf8Buf, chunk]);
      }
      while (utf8Buf.length > 0) {
        if (escSeq !== '') {
          const b = utf8Buf[0];
          utf8Buf = utf8Buf.slice(1);
          if ((b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 126) { escSeq = ''; }
          else if (b >= 0x30 && b <= 0x3F) { escSeq += String.fromCharCode(b); }
          else { escSeq = ''; }
          continue;
        }
        const b = utf8Buf[0];
        if (b === 3) { utf8Buf = utf8Buf.slice(1); continue; }
        if (b === 13 || b === 10) { finish(buf); return; }
        if (b === 127 || b === 8) {
          utf8Buf = utf8Buf.slice(1);
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
          }
          redraw();
          continue;
        }
        if (b === 27) {
          utf8Buf = utf8Buf.slice(1);
          if (utf8Buf.length === 0) { escSeq = '\x1b'; break; }
          const next = utf8Buf[0];
          if (next === 91) { utf8Buf = utf8Buf.slice(1); escSeq = '\x1b['; }
          else if (next === 79) { utf8Buf = utf8Buf.slice(1); escSeq = '\x1bO'; }
          else { escSeq = ''; }
          continue;
        }
        if (b < 32) { utf8Buf = utf8Buf.slice(1); continue; }
        let charLen = 1;
        if (b >= 0xC0 && b < 0xE0) charLen = 2;
        else if (b >= 0xE0 && b < 0xF0) charLen = 3;
        else if (b >= 0xF0 && b < 0xF8) charLen = 4;
        if (utf8Buf.length < charLen) break;
        const charBytes = utf8Buf.slice(0, charLen);
        utf8Buf = utf8Buf.slice(charLen);
        const ch = charBytes.toString('utf8');
        if (/[;&|<>\\`]/.test(ch)) { continue; }
        buf += ch;
        redraw();
      }

    };
    _rawInput.ensureInit();
    _rawInput.setHandler(onData);
    // 首次进入立即重绘，确保 > 提示符可见（CloudShell 不会主动触发 redraw）
    redraw();
  });


}
function pressEnter(q) {
  // 仅接受回车，忽略所有其他按键（不缓冲、不回显、不重绘）
  process.stdout.write(q || '');
  if (!process.stdin.isTTY) {
    return new Promise((res) => {
      let buf = '';
      const onReadable = () => {
        let chunk;
        while ((chunk = process.stdin.read()) !== null) {
          for (let i = 0; i < chunk.length; i++) {
            if (chunk[i] === 10 || chunk[i] === 13) {
              process.stdin.removeListener('readable', onReadable);
              process.stdin.removeListener('end', onEnd);
              res(''); return;
            }
          }
        }
      };
      const onEnd = () => { process.stdin.removeListener('readable', onReadable); res(''); };
      process.stdin.on('readable', onReadable);
      process.stdin.on('end', onEnd);
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const pfx = q || '';
    const redraw = () => {
      // \r 回到行首，\x1b[K 清除当前行所有字符（包括 CloudShell 回显的残留），再写回提示
      process.stdout.write('\r\x1b[2K' + pfx);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      _rawInput.clearHandler();
      process.stdout.write('\n');
      resolve('');
    };
    const onData = (chunk) => {
      if (settled) return;
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i];
        if (b === 13 || b === 10) { finish(); return; }
        // 退格或其他按键都重绘提示，防止 CloudShell 擦除提示文本
        redraw();
      }

    };
    _rawInput.ensureInit();
    _rawInput.setHandler(onData);
  });
}
function pause() { return pressEnter('\n' + PAD + C.dim + '按回车返回菜单…' + C.reset + ' '); }

/* ══════════════════════════ 呈现层（统一设计语言） ══════════════════════════ */

const W = 60;              // 统一内容宽度（列）
const PAD = '  ';          // 统一缩进
const USE_COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const C = USE_COLOR
  ? { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', title: '\x1b[36;1m', ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', key: '\x1b[36m' }
  : { reset: '', dim: '', bold: '', title: '', ok: '', bad: '', warn: '', key: '' };

const MARK = {
  ok: C.ok + '[ok]' + C.reset,
  bad: C.bad + '[!!]' + C.reset,
  warn: C.warn + '[!]' + C.reset,
  arrow: C.dim + '-->' + C.reset
};

/** 显示宽度：中文等全角按 2 列计（装饰字符已全部 ASCII，不会误判） */
const WIDE_RE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function dw(s) {
  let w = 0;
  for (const ch of String(s)) w += WIDE_RE.test(ch) ? 2 : 1;
  return w;
}
/** 去 ANSI 后按显示宽度右补空格 */
function pad(s, width) {
  const d = width - dw(String(s).replace(/\x1b\[[0-9;]*m/g, ''));
  return d > 0 ? String(s) + ' '.repeat(d) : String(s);
}

/** 分区标题：== 标题 ============================ */
function sec(title) {
  const t = `== ${title} `;
  return C.title + t + '='.repeat(Math.max(2, W - dw(t))) + C.reset;
}
/** 分隔线（与 sec 同宽，保证整屏左右齐平） */
function hr() { return C.dim + '-'.repeat(W) + C.reset; }
/** 缩进分隔线（用于缩进区域内部） */
function ihr() { return PAD + C.dim + '-'.repeat(W - 2) + C.reset; }

/**
 * 清屏式刷新：进入新一屏时擦掉上一屏，界面固定在一屏内，不无限下坠。
 * 用 TUI_CLEAR 控制：auto（默认，仅 TTY 清屏）/ off（从不清屏，便于 tmux、CI、日志留存）/ force（强制清屏）。
 */
function newScreen() {
  const mode = String(process.env.TUI_CLEAR || 'auto').toLowerCase();
  if (mode === 'off') return;
  if (mode === 'force' || process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

function say(msg) { console.log(PAD + msg); }
function ok(msg) { console.log(PAD + MARK.ok + ' ' + msg); }
function fail(msg) { console.log(PAD + MARK.bad + ' ' + msg); }
function warn(msg) { console.log(PAD + MARK.warn + ' ' + msg); }
function tip(msg) { console.log(PAD + C.dim + msg + C.reset); }

/** 状态行：左列标签对齐（20 列），右列取值，值前可带标记 */
function kv(label, value, mark) {
  const v = (value === undefined || value === '') ? C.dim + '-' + C.reset : value;
  console.log(PAD + pad(label, 20) + (mark ? mark + ' ' : '') + v);
}
/** 菜单 / 摘要条目：编号 + 名称（16 列）+ 说明 */
function item(no, name, desc) {
  console.log(PAD + C.key + no + ')' + C.reset + ' ' + pad(name, 16) + (desc ? C.dim + desc + C.reset : ''));
}

/* ══════════════════════════ 交互原语 ══════════════════════════ */

/** 当前所处的步骤（如「第 1 / 4 步 · 给系统起名字」），会带在每一条提示前，避免刷屏后不知道在哪 */
let STEP = '';
function setStep(s) { STEP = s || ''; }
function stepHead() { return STEP ? C.dim + '[' + STEP + '] ' + C.reset : ''; }

/** 输入提示统一三行式：标题（带步骤）/ 说明与默认值 / > 光标 */
function promptLine(label, sub, defText) {
  console.log('');
  console.log(PAD + stepHead() + C.bold + label + C.reset);
  if (sub) console.log(PAD + C.dim + sub + C.reset);
  if (defText) console.log(PAD + C.dim + defText + C.reset);
  process.stdout.write(PAD + C.key + '> ' + C.reset);
}

/** 掩码输入（授权码）：TTY 下屏蔽回显，非 TTY 退化为明文 */
async function askSecret(prompt) {
  if (!process.stdin.isTTY) return (await ask(prompt)).trim();
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      _rawInput.clearHandler();
      process.stdout.write('\n');
      resolve(val);
    };
      let utf8Buf = Buffer.alloc(0);
      const onData = (chunk) => {
        if (settled) return;
        utf8Buf = Buffer.concat([utf8Buf, chunk]);
        while (utf8Buf.length > 0) {
          const b = utf8Buf[0];
          if (b === 3) { utf8Buf = utf8Buf.slice(1); continue; }
          if (b === 13 || b === 10) { finish(buf.trim()); return; }
          if (b === 127 || b === 8) { utf8Buf = utf8Buf.slice(1); if (buf.length > 0) buf = buf.slice(0, -1); continue; }
          if (b < 32) { utf8Buf = utf8Buf.slice(1); continue; }
          let charLen = 1;
          if (b >= 0xC0 && b < 0xE0) charLen = 2;
          else if (b >= 0xE0 && b < 0xF0) charLen = 3;
          else if (b >= 0xF0 && b < 0xF8) charLen = 4;
          if (utf8Buf.length < charLen) break;
          buf += utf8Buf.slice(0, charLen).toString('utf8');
          utf8Buf = utf8Buf.slice(charLen);
        }
      };
    _rawInput.ensureInit();
    _rawInput.setHandler(onData);
  });
}

/** 菜单选择：必须输入 1-N（空回车无效）；选完回一句"已选"，避免不确定有没有生效 */
async function askChoice(title, options, defIdx, tries) {
  const tt = tries || 0;                                   // 重试上限：避免输错时无限重问
  console.log('');
  if (tt === 0) {                                          // 标题与选项只在首次打印，重问不重复整块
    console.log(PAD + stepHead() + C.bold + title + C.reset);
    options.forEach((o, i) => say(`${C.key}${i + 1})${C.reset} ${o.label}`));
    tip(`请输入 1-${options.length} 作出选择（空回车无效，输入 0 放弃返回菜单）`);
  } else {
    console.log(PAD + C.dim + `${title}：请输入 1-${options.length}，或 0 放弃` + C.reset);
  }
  const a = (await ask('', PAD + C.key + '> ' + C.reset)).trim();
  abortIf(a);
  if (a === '') {
    if (tt >= 2) { fail('连续未作出选择，已取消本步。'); return null; }
    fail(`空回车无效：请输入 1-${options.length}，或输入 0 放弃返回菜单。`);
    return askChoice(title, options, defIdx, tt + 1);
  }
  const g = guardInput(a);                       // 命令 / AI 指令 / 自然语言：直接拒绝并重问
  if (!g.ok) {
    if (tt >= 2) { fail('连续输入无效，已取消本步。'); return null; }
    fail(g.reason);
    return askChoice(title, options, defIdx, tt + 1);
  }
  const n = Number.parseInt(g.value, 10);
  if (!Number.isInteger(n) || n < 1 || n > options.length) {
    if (tt >= 2) { fail('连续输入无效，已取消本步。'); return null; }
    fail(`只能输入 1-${options.length}，请重试。`);
    return askChoice(title, options, defIdx, tt + 1);
  }
  ok(`已选：${options[n - 1].label}`);
  return options[n - 1];
}

/**
 * 布尔选择：只接受 Y / N，空回车无效（必须明确选择）。
 * @param {boolean} [numeric] true=取值为 1/0（如 TRUST_PROXY），false=取值为 true/false（如 COOKIE_SECURE）
 */
async function askBool(label, cur, def, numeric, tries) {
  const tt = tries || 0;                                   // 重试上限：避免输错时无限重问
  const truthy = (v) => v === 'true' || v === '1' || v === 'yes';
  const curBool = truthy(String(cur === '' || cur === undefined || cur === null ? def : cur));
  const toStr = (b) => (numeric ? (b ? '1' : '0') : String(b));
  // 只认 Y / N：空回车是非法操作（必须明确作出选择），因此不接受"回车保持"
  if (tt === 0) {
    promptLine(label, null, `当前：${curBool ? '是' : '否'}   请输入 Y = 是，N = 否（输入 0 放弃返回菜单）`);
  } else {
    console.log(PAD + C.dim + `${label}：请输入 Y 或 N，或 0 放弃` + C.reset);
    // prompt handled by ask redraw
  }
  const a = (await ask('', PAD + C.key + '> ' + C.reset)).trim().toLowerCase();
  abortIf(a);
  if (a === '') {
    if (tt >= 2) { fail('连续未作出选择，此项保持原值。'); return toStr(curBool); }
    fail('空回车无效：请明确输入 Y 或 N，或输入 0 放弃返回菜单。');
    return askBool(label, String(curBool), def, numeric, tt + 1);
  }
  if (a === 'y' || a === 'yes') { ok('已选：是'); return toStr(true); }
  if (a === 'n' || a === 'no') { ok('已选：否'); return toStr(false); }
  const g = guardInput(a);
  if (!g.ok) {
    if (tt >= 2) { fail('连续输入无效，此项保持原值。'); return toStr(curBool); }
    fail(g.reason);
    return askBool(label, String(curBool), def, numeric, tt + 1);
  }
  if (tt >= 2) { fail('连续输入无效，此项保持原值。'); return toStr(curBool); }
  fail('只能输入 Y 或 N（Y = 是，N = 否）。');
  return askBool(label, String(curBool), def, numeric, tt + 1);
}

/* ---------------------- 端口占用检测 ----------------------
 * 「确认保持 3000」不代表 3000 真的能用：本机可能已有别的程序占着，服务一启动就 EADDRINUSE。
 * 因此端口一旦确定（新填的或回车确认的），都实测一次；
 * 若被占用还要区分是不是本系统自己占着（改端口后旧进程仍占旧端口，提示不同）。
 */
function bindProbe(host, port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', (e) => res({ ok: false, code: e && e.code }));
    srv.once('listening', () => srv.close(() => res({ ok: true })));
    srv.listen(port, host);
  });
}
/** IPv4 与 IPv6 都探一遍（很多程序只监听 ::，只探 0.0.0.0 会漏判）；只有真占用才算占用 */
async function portInUse(port) {
  for (const host of ['0.0.0.0', '::']) {
    const r = await bindProbe(host, port);
    if (!r.ok && (r.code === 'EADDRINUSE' || r.code === 'EACCES')) return true;
  }
  return false;
}
/** 该端口上运行的是不是本系统（查一次无需登录的公开接口） */
function isSelfService(port, basePath) {
  return new Promise((res) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: (basePath || '') + '/api/settings/public', method: 'GET', timeout: 1200 },
      (r) => {
        let body = '';
        r.on('data', (c) => { body += c; });
        r.on('end', () => {
          let self = false;
          try { const j = JSON.parse(body); self = !!(j && j.ok && j.product_name); } catch (e) { self = false; }
          res(self);
        });
      });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
    req.end();
  });
}
async function checkPort(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return;
  if (!(await portInUse(p))) { ok(`端口 ${p} 当前空闲，可以正常使用`); return; }
  if (await isSelfService(p, draftGet('BASE_PATH'))) {
    warn(`端口 ${p} 上正运行着本系统：改端口后要重启服务才生效，旧进程仍占着 ${p}。`);
    return;
  }
  warn(`端口 ${p} 已被本机其他程序占用，服务启动会失败（EADDRINUSE）。`);
  let recommended = null;
      for (let c = p + 1; c <= p + 50; c++) { if (!(await portInUse(c))) { recommended = c; break; } }
      if (!recommended) { for (let c = 3000; c <= 4000; c++) { if (c !== p && !(await portInUse(c))) { recommended = c; break; } } }
      if (recommended) tip(`建议改用端口 ${recommended}（已验证空闲）。`);
      else tip('常见端口均被占用，请手动指定一个空闲端口（2000-65000）。');
  tip(`查占用者：Windows 用 netstat -ano | findstr :${p}；Linux 用 ss -lptn 'sport = :${p}'。`);
}

/** 检测目标网址可用性：Nginx location 冲突 + 路径 HTTP 可达 + 端口健康 */
async function checkBaseUrl(basePath, port) {
  const bp = basePath || '';
  const p = Number(port) || 3000;

  // ── ① 端口健康检查 ──
  if (!(await portInUse(p))) {
    warn(`端口 ${p} 当前无服务监听，部署后需先启动服务才能访问。`);
  } else {
    const self = await isSelfService(p, bp);
    if (self) ok(`端口 ${p} 上本系统运行正常，路径 ${bp || '/'} 可达。`);
    else warn(`端口 ${p} 被其他程序占用，非本系统。`);
  }

  // ── ② Web 服务器反代检测 + 配置 ──
  try {
    const { execSync } = require('child_process');
    const fs = require('fs');

    // 2a. 确认 nginx 是否存在
    let nginxBin = '';
    try { nginxBin = execSync('which nginx 2>/dev/null || command -v nginx 2>/dev/null', { encoding: 'utf8', timeout: 2000 }).trim(); } catch(e) {}

    if (!nginxBin) {
      // 非 Nginx 环境：给出通用指引
      tip('未检测到 Nginx。如使用 Caddy / Apache / 宝塔 / 1Panel 等，请手动配置反向代理。');
      tip(`核心要求：将 ${bp || '/'} 的请求代理到 http://127.0.0.1:${p}`);
      tip(`并确保该路径的匹配优先级高于静态文件规则（Nginx 用 location ^~）。`);
    } else {
      // 2b. 收集配置文件（grep + nginx -T 双保险）
      let confFiles = [];
      try {
        const raw = execSync(
          'grep -rl "location " /www/server/panel/vhost/nginx/ /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ /etc/nginx/sites-available/ /usr/local/etc/nginx/ /opt/homebrew/etc/nginx/ /usr/local/nginx/conf/ 2>/dev/null || true',
          { encoding: 'utf8', timeout: 3000 }
        ).trim().split('\n').filter(Boolean);
        confFiles = raw.filter(f => f.indexOf('.bak') === -1);
      } catch(e) {}

      let fullConf = '';
      try { fullConf = execSync('nginx -T 2>/dev/null', { encoding: 'utf8', timeout: 5000 }); } catch(e) {}

      // 从 nginx -T 补充文件列表
      if (fullConf) {
        const pathMatches = fullConf.match(/# configuration file\s+(\S+)/g);
        if (pathMatches) {
          for (const m of pathMatches) {
            const fp = m.replace('# configuration file ', '');
            if (fp.indexOf('.bak') === -1 && confFiles.indexOf(fp) === -1) confFiles.push(fp);
          }
        }
      }

      // 2c. 检测目标路径是否已有 location
      const escapedBp = (bp || '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const locRe = new RegExp('location\\s+(?:\\^~\\s+)?' + escapedBp + '(?:\\s|{|$)', 'm');
      const blockRe = new RegExp('location\\s+(?:\\^~\\s+)?' + escapedBp + '[\\s\\S]*?proxy_pass\\s+http://[^:]+:(\\d+)', 'm');

      let conflictFile = '';
      let conflictPort = '';
      let hasCaretTilde = false;

      // 先在文件中查找
      for (const conf of confFiles) {
        try {
          const ctext = fs.readFileSync(conf, 'utf8');
          if (locRe.test(ctext)) {
            conflictFile = conf;
            const m = ctext.match(blockRe);
            conflictPort = m ? m[1] : '?';
            hasCaretTilde = new RegExp('location\\s+\\^~\\s+' + escapedBp, 'm').test(ctext);
            break;
          }
        } catch(e) {}
      }

      // fallback: nginx -T 输出
      if (!conflictFile && fullConf && locRe.test(fullConf)) {
        const m = fullConf.match(blockRe);
        conflictPort = m ? m[1] : '?';
        hasCaretTilde = new RegExp('location\\s+\\^~\\s+' + escapedBp, 'm').test(fullConf);
        const lines = fullConf.split('\n');
        let curFile = '';
        for (const line of lines) {
          const fm = line.match(/^# configuration file\s+(\S+)/);
          if (fm) curFile = fm[1];
          if (curFile && locRe.test(line)) { conflictFile = curFile; break; }
        }
        if (!conflictFile) conflictFile = '(nginx 内置配置)';
      }

      // 生成标准 location 块（供自动写入或手动复制）
      const locBlock = `location ^~ ${bp || '/'} {\n    proxy_pass http://127.0.0.1:${p};\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;\n}`;

      if (conflictFile) {
        // ── 已有 location ──
        if (String(conflictPort) === String(p)) {
          if (hasCaretTilde) {
            ok(`Nginx 已正确配置 ${bp || '/'} → 端口 ${p}（含 ^~ 前缀），反向代理就绪。`);
          } else {
            warn(`Nginx 已配置 ${bp || '/'} → 端口 ${p}，但缺少 ^~ 前缀。`);
            tip('缺少 ^~ 时，正则 location（如静态文件缓存）可能优先匹配，导致页面无法加载。');
            // 尝试自动修复
            let fixed = false;
            try {
              const ctext = fs.readFileSync(conflictFile, 'utf8');
              const fixRe = new RegExp('(location\\s+)' + escapedBp + '(\\s*\\{)', 'm');
              if (fixRe.test(ctext)) {
                const newCtext = ctext.replace(fixRe, '$1^~ ' + (bp || '/') + '$2');
                fs.writeFileSync(conflictFile, newCtext, 'utf8');
                execSync('nginx -t 2>&1', { timeout: 5000 });
                execSync('nginx -s reload 2>&1', { timeout: 5000 });
                ok('已自动添加 ^~ 前缀并重载 Nginx。');
                fixed = true;
              }
            } catch(e) {}
            if (!fixed) {
              tip(`请手动在 ${conflictFile} 中将 location ${bp || '/'} 改为 location ^~ ${bp || '/'}`);
              tip(`然后执行：nginx -t && nginx -s reload`);
            }
          }
        } else {
          warn(`Nginx 中 ${bp || '/'} 已被占用，指向端口 ${conflictPort}（非当前端口 ${p}）。`);
          tip(`冲突文件：${conflictFile}`);
          const fix = await askBool('是否将该 location 改指向当前端口 ' + p, null, 'Y');
          if (fix === 'true' || fix === true || fix === 'Y') {
            let fixed = false;
            try {
              const ctext = fs.readFileSync(conflictFile, 'utf8');
              const fixedCtext = ctext.replace(
                new RegExp('(location\\s+(?:\\^~\\s+)?' + escapedBp + '[\\s\\S]*?proxy_pass\\s+http://)[^:]+:(\\d+)', 'm'),
                `$1127.0.0.1:${p}`
              );
              fs.writeFileSync(conflictFile, fixedCtext, 'utf8');
              execSync('nginx -t 2>&1', { timeout: 5000 });
              execSync('nginx -s reload 2>&1', { timeout: 5000 });
              ok(`已自动修改 ${bp || '/'} → 端口 ${p} 并重载 Nginx。`);
              fixed = true;
            } catch(e) {}
            if (!fixed) {
              fail('自动修改失败（可能权限不足或配置格式特殊）。');
              tip(`请手动编辑 ${conflictFile}，将 proxy_pass 端口改为 ${p}`);
              tip(`然后执行：nginx -t && nginx -s reload`);
            }
          } else {
            tip('建议改用未被占用的路径（如 /checkin）。');
          }
        }
      } else {
        // ── 未找到 location，需要新增 ──
        tip(`Nginx 中未找到 ${bp || '/'} 的反向代理配置。`);

        // 选择最佳写入文件
        let mainConf = '';
        let httpConf = '';
        for (const conf of confFiles) {
          try {
            const ctext = fs.readFileSync(conf, 'utf8');
            if (ctext.indexOf('server_name') === -1) continue;
            if (/listen\s+443/.test(ctext)) { mainConf = conf; break; }
            else if (!httpConf) httpConf = conf;
          } catch(e) {}
        }
        if (!mainConf && httpConf) mainConf = httpConf;

        const add = await askBool('是否自动添加 Nginx 反向代理配置', null, 'Y');
        if (add === 'true' || add === true || add === 'Y') {
          if (mainConf) {
            let autoOk = false;
            try {
              const confContent = fs.readFileSync(mainConf, 'utf8');
              // 找最后一个含 server_name 的 server 块结束位置
              let insertPos = -1;
              const clines = confContent.split('\n');
              let inServer = false, braceDepth = 0, hasServerName = false;
              for (let li = 0; li < clines.length; li++) {
                const rawLine = clines[li];
                const noComment = rawLine.replace(/#.*/, '');
                if (/^\s*server\s*\{/.test(rawLine)) {
                  inServer = true; braceDepth = 1; hasServerName = false;
                  continue;
                }
                if (inServer) {
                  if (/server_name\b/.test(rawLine)) hasServerName = true;
                  for (const ch of noComment) {
                    if (ch === '{') braceDepth++;
                    else if (ch === '}') {
                      braceDepth--;
                      if (braceDepth === 0) {
                        if (hasServerName) {
                          let pos = 0;
                          for (let k = 0; k <= li; k++) pos += clines[k].length + 1;
                          insertPos = pos - 1;
                        }
                        inServer = false;
                        break;
                      }
                    }
                  }
                }
              }
              if (insertPos === -1) insertPos = confContent.lastIndexOf('}');
              if (insertPos === -1) throw new Error('无法定位 server 块');

              const newContent = confContent.slice(0, insertPos) + '\n    ' + locBlock.replace(/\n/g, '\n    ') + '\n' + confContent.slice(insertPos);
              fs.writeFileSync(mainConf, newContent, 'utf8');
              execSync('nginx -t 2>&1', { timeout: 5000 });
              execSync('nginx -s reload 2>&1', { timeout: 5000 });
              ok(`已自动添加反向代理到 ${mainConf} 并重载 Nginx。`);
              autoOk = true;
            } catch(e) {
              // 自动写入失败，降级为手动指引
            }
            if (!autoOk) {
              warn('自动写入失败（可能权限不足或配置格式特殊）。');
              tip('请手动将以下内容添加到 Nginx 的 server 块内：');
              say('');
              locBlock.split('\n').forEach(l => say('    ' + l));
              say('');
              tip(`推荐配置文件：${mainConf}`);
              tip('添加后执行：nginx -t && nginx -s reload');
            }
          } else {
            warn('未找到可写入的 Nginx 配置文件。');
            tip('请手动将以下内容添加到 Nginx 的 server 块内：');
            say('');
            locBlock.split('\n').forEach(l => say('    ' + l));
            say('');
            tip('添加后执行：nginx -t && nginx -s reload');
          }
        } else {
          tip('请手动将以下内容添加到 Nginx 的 server 块内：');
          say('');
          locBlock.split('\n').forEach(l => say('    ' + l));
          say('');
          tip('添加后执行：nginx -t && nginx -s reload');
        }
      }
    }
  } catch (e) {
    tip('无法检测 Web 服务器配置（权限不足或非标准环境）。');
    tip(`请手动配置：将 ${bp || '/'} 代理到 http://127.0.0.1:${p}`);
    tip('Nginx 示例：');
    say(`    location ^~ ${bp || '/'} {`);
    say(`        proxy_pass http://127.0.0.1:${p};`);
    say('        proxy_set_header Host $host;');
    say('        proxy_set_header X-Forwarded-Proto $scheme;');
    say('    }');
    tip('添加后执行：nginx -t && nginx -s reload');
  }

  // ── ③ HTTP 可达性探测 ──
  const testPath = (bp || '') + '/api/settings/public';
  const reachable = await isSelfService(p, bp);
  if (reachable) ok(`HTTP 探测通过：http://127.0.0.1:${p}${testPath} 返回有效响应。`);
  else tip(`HTTP 探测未通过：http://127.0.0.1:${p}${testPath} 无响应（服务未启动或路径不匹配）。`);
}
class AbortFlow extends Error {}
const ABORT_KEY = '0';
function abortIf(v) {
  if (String(v == null ? '' : v).trim() === ABORT_KEY) throw new AbortFlow();
}

/**
 * 显式确认：先把「即将做什么」说清楚，再问 Y / N。
 * 不用"回车即确认"这种隐式方式——每一步都由运维者明确表态。
 * @returns {'yes'|'no'}
 */
async function confirmAction(desc, tries) {
  const tt = tries || 0;                                   // 重试上限，避免输错时无限重问
  // 「即将…」只在首次打印；重问时不再重复整块，只留一行提示 + 光标
  if (tt === 0) {
    console.log('');
    say(MARK.arrow + ' 即将：' + desc);
    tip('Y = 确认并执行，N = 取消并重新填写（输入 0 放弃返回菜单）');
  }
  const a = (await ask('', PAD + C.key + '> ' + C.reset)).trim().toLowerCase();
  abortIf(a);
  if (a === 'y' || a === 'yes') return 'yes';
  if (a === 'n' || a === 'no') return 'no';
  const g = guardInput(a);
  if (!g.ok) {
    if (tt >= 2) { fail('连续未作出选择，按「取消」处理。'); return 'no'; }
    fail(g.reason);
    return confirmAction(desc, tt + 1);
  }
  if (tt >= 2) { fail('连续未作出选择，按「取消」处理。'); return 'no'; }
  fail('只能输入 Y 或 N（Y = 确认，N = 取消）。');
  return confirmAction(desc, tt + 1);
}

/* ===================== 输入守卫 =====================
 * 本向导读到的每一行都只当作「菜单编号 / 配置值 / Y / N」处理：
 *   · 绝不交给 shell 执行（不会 spawn / exec 任何用户输入）；
 *   · 绝不转发给任何 AI Agent（本程序不联网、不接入模型）；
 *   · 服务器命令、shell 元字符、@ / slash 指令、自然语言一律拒绝，且不写入 .env。
 * 同时挡住「值里带换行 / 元字符」——env-util 按行解析，混入特殊字符会破坏 .env 结构。
 */
const RE_SHELL_META = /[;&|<>\\`\r\n]/;
const RE_SHELL_CMD = /^(sudo|su|rm|mv|cp|ls|ll|cd|cat|vim|vi|nano|npm|node|npx|yarn|pnpm|git|curl|wget|ssh|scp|systemctl|service|docker|apt|apt-get|yum|dnf|chmod|chown|kill|killall|ps|top|tail|head|grep|find|tar|zip|unzip|python|python3|pip|pm2|nginx|bash|sh|zsh|powershell|pwsh|exit|reboot|shutdown)\b/i;
const RE_AI_CALL = /^[@/]/;                                  // @某人、/命令
const RE_AI_WORD = /^(ai|agent|claude|copilot|codex|gpt|chatgpt|kimi|deepseek|gemini|通义|文心|豆包|讯飞|小艺|小爱|siri|hey|ok)\b/i;
/* 指令性语言的三个特征：动词、字段名、句子标点 / 语气词结尾。
 * 关键是**不依赖"帮我/请问"这类礼貌词**——「班级名改成三年二班」「三年二班就可以了」
 * 这种没有礼貌词的句子同样会被识别，避免被当成 GROUP_NAME 静默写进 .env。 */
const RE_VERB = /(改成?|改为|修改为|设置成?|设成|弄成|调成|换成|换为|更新为|变更|填[写上入]?|写[上成]?|输入|添加|新增|删除|删掉|去掉|移除|取消|命名|取名|我要|我想|给我|帮我|把它|将它|使用|选用|选择|设置为|弄一下|搞一下)/;
const RE_FIELD_WORD = /(班级名|班级名称|系统名|系统全称|系统名称|端口|端口号|邮箱|授权码|发件|密码|账号|服务器|域名|版本|运维者|SMTP)/i;
const RE_TONE = /[。！？!?，,；;：:]|(吧|呢|啊|哦|呀|嘛|啦|了|吗|的话|就行|就可以|好了)$/;

function guardInput(v) {
  const s = String(v == null ? '' : v).trim();
  if (RE_SHELL_META.test(s)) {
    return { ok: false, reason: '含有 shell 特殊字符（; & | < > ` \\ 或换行）。本向导只接受配置值，不执行任何命令，也不会写入 .env。' };
  }
  if (RE_SHELL_CMD.test(s)) {
    return { ok: false, reason: '这看起来是服务器命令。本向导不是命令行——不会执行它，也不会写进 .env。' };
  }
  if (RE_AI_CALL.test(s) || RE_AI_WORD.test(s)) {
    return { ok: false, reason: '本向导不接入任何 AI Agent：@ 与 / 开头的指令一律不处理，也不会把你说的话发给任何模型。' };
  }
  // 字段名 / 语气词只在「含中文」时才作为句子特征判定：
  // 否则 smtp.qq.com、465 这类纯 ASCII 的正常值会被 SMTP / 端口 等词误伤
  const hasCJK = /[一-龥]/.test(s);
  if (RE_VERB.test(s) || (hasCJK && (RE_FIELD_WORD.test(s) || RE_TONE.test(s)))) {
    return {
      ok: false,
      reason: '这像是一句话，不是一个值（含动词 / 字段名 / 标点语气词）。本向导不理解自然语言，也不会把它写进 .env；请直接填值，例：通信工程2607班'
    };
  }
  // 可疑但可能是合法值（含空格、或异常长）：不直接拒绝，交给调用方二次确认。
  // 阈值要宽松——邮箱（21 列）、域名、授权码都是正常值，不能动不动就问一次。
  if (/\s/.test(s) || dw(s) > 40) return { ok: true, value: s, confirm: `将这一项设为「${s}」` };
  return { ok: true, value: s };
}

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const isPort = (v) => /^\d+$/.test(String(v || '').trim()) && Number(v) >= 1 && Number(v) <= 65535;

/**
 * 单值输入。回车＝确认（确认保持默认值 / 确认不填）；validate 返回错误串则重问。
 * sub 只写背景说明，opt.effect 写"不填会发生什么"（合成同一行，避免两行互相矛盾）。
 * @param {{key,label,sub?,def?,validate?,secret?,allowEmpty?}} opt
 */
async function askVal(opt) {
  const { key, label, sub = '', def = '', validate = null, secret = false, allowEmpty = true, effect = '' } = opt;
  const tries = opt._try || 0;                     // 连续输错计数：必填项不会无限重问
  const cur = env.getKey(key);
  const base = DRAFT.has(key) ? DRAFT.get(key) : (cur || def);
  // 阶段一：取值。这里不谈"确认"，只说当前有什么值、可以怎么填
  // 输入一律明文回显（要能看见自己打的字）；secret 只表示"这项写入 .env 时加密"
  const defText = base
    ? `当前值：「${base}」，直接回车就是用这个值`
    : (allowEmpty ? '可以直接回车（不填），也可以输入一个值' : C.bad + '此项必填：请输入值' + C.reset);
  // 完整提示只在首次打印；重问时只给一行，避免整段重复刷屏
  if (tries === 0) {
    promptLine(label, sub, defText);
  } else {
    console.log(PAD + C.dim + `${label}：请重新输入（或输入 0 放弃返回菜单）` + C.reset);
    // prompt handled by ask redraw
  }
  const v = (await ask('', PAD + C.key + '> ' + C.reset)).trim();                     // 明文回显，便于核对
  abortIf(v);                                           // 0 = 放弃并返回菜单

  let val;                                              // 待确认的取值
  if (v === '') {
    if (base) val = base;
    else if (allowEmpty) val = '';
    else {
      if (tries >= 2) { fail('连续未填写，已取消本步。'); return null; }
      fail('此项必填，不能留空（请直接填值）。');
      return askVal(Object.assign({}, opt, { _try: tries + 1 }));
    }
  } else {
    // 守卫：命令 / shell 元字符 / AI 召唤 / 自然语言一律拒绝，且不写入 .env
    const g = guardInput(v);
    if (!g.ok) {
      if (tries >= 2) { fail('连续输入无效，已取消本步。'); return null; }
      fail(g.reason);
      return askVal(Object.assign({}, opt, { _try: tries + 1 }));
    }
    val = g.value;
    if (validate) {
      const err = validate(val);
      if (err) {
        if (tries >= 2) { fail('连续输入无效，已取消本步。'); return null; }
        fail(err);
        return askVal(Object.assign({}, opt, { _try: tries + 1 }));
      }
    }
  }

  // 阶段二：显式确认 —— 把"即将做什么"说清楚，再问 Y / N（不再用回车隐式确认）
  // 值一律明文：不这样就无法核对填得对不对（输入过程本身已不回显）
  const desc = val
    ? `把「${label}」设为「${val}」`
    : `把「${label}」留空${effect ? '，' + effect : '（保持未设置）'}`;
  const ans = await confirmAction(desc);
  if (ans === 'no') { tip('已取消，请重新填写。'); return askVal(opt); }
  ok(val ? `已设置：${val}` : '已留空');
  return val;
}

/* ══════════════════════════ 草稿与写入 ══════════════════════════ */
const DRAFT = new Map();
const changed = [];

/** 入草稿；若与 .env 当前值相同则不记录（含"改回原值"时从草稿移除），保证保存清单只有真实变化 */
function draftSet(key, value) {
  const v = value === undefined ? '' : String(value);
  if (env.getKey(key) === v) { DRAFT.delete(key); return; }
  DRAFT.set(key, v);
}
/** 读取：草稿优先；.env 里的密文在此解密，界面上始终看到明文 */
function draftGet(key) {
  const raw = DRAFT.has(key) ? DRAFT.get(key) : env.getKey(key);
  return secret.decrypt(raw);
}
function hasDraft() { return DRAFT.size > 0; }

function applyDraft() {
  try { if (fs.existsSync(env.ENV)) fs.copyFileSync(env.ENV, env.ENV + '.bak'); } catch (e) {}
  const keys = Array.from(DRAFT.keys());
  for (const k of keys) {
    const v = DRAFT.get(k);
    // 授权码等敏感项：界面上是明文，写入 .env 时加密
    const stored = secret.isSecretKey(k) ? secret.encrypt(v) : v;
    env.setKey(k, stored);
    if (v === '') delete process.env[k]; else process.env[k] = v;   // 进程内仍用明文，供本次会话显示
  }
  DRAFT.clear();
  return keys;
}
/**
 * 值不再打码：运维者必须能看到自己填了什么，否则无法核对授权码对错。
 * 只有「输入过程」不回显（防肩窥）；确认语与配置清单一律明文。
 */
function maskVal(key, v) { return v || ''; }

/* ══════════════════════════ 状态总览 ══════════════════════════ */

function liveMailConfigured() {
  return !!(draftGet('SMTP_HOST') && draftGet('SMTP_USER') && draftGet('SMTP_PASS'));
}
/** 用草稿实时推导系统全称（未落盘也能预览） */
function liveSystemName() {
  return cfg.composeSystemName(draftGet('GROUP_NAME'), draftGet('SYSTEM_NAME'));
}
/** 取值来源标注：.env 里写了就说「.env」，否则说「内置默认」 */
function srcTag(key) {
  return C.dim + (env.getKey(key) ? '（.env）' : '（内置默认）') + C.reset;
}

function printStatus() {
  const cls = draftGet('GROUP_NAME');
  const mail = liveMailConfigured();
  console.log('\n' + sec('当前状态'));
  // 状态面板只说人话：不暴露 GROUP_NAME 这类变量名，并标出取值来源（.env 已设置 / 内置默认）
  kv('商品名（品牌）', C.dim + cfg.PRODUCT_NAME + '（固定，不可改）' + C.reset);
  kv('班级名', cls || C.bad + '未设置' + C.reset, cls ? MARK.ok : MARK.bad);
  kv('系统全称', liveSystemName() + C.dim + (draftGet('SYSTEM_NAME') ? '（SYSTEM_NAME 指定）' : '（自动拼接）') + C.reset);
  kv('邮件服务', mail ? C.ok + '已配置' + C.reset : C.bad + '未配置' + C.reset, mail ? MARK.ok : MARK.bad);
  // 有内置默认的项标出「这个数是 .env 写的，还是系统自带的」，避免不知道 3000 从哪来
  const portEnv = draftGet('PORT');
  kv('监听端口', (portEnv || String(cfg.PORT)) + srcTag('PORT'));
  const bpEnv = draftGet('BASE_PATH');
  kv('网址子路径', (bpEnv || cfg.BASE_PATH || C.dim + '（域名根目录）' + C.reset) + srcTag('BASE_PATH'));
  console.log(hr());
  if (!cls) say(MARK.arrow + ' 下一步：选 ' + C.key + '1)' + C.reset + ' 快速配置，先填「班级名称」——未配置时运维者无法登录。');
  else if (!mail) say(MARK.arrow + ' 下一步：选 ' + C.key + '3)' + C.reset + ' 邮件服务，配置后验证码与提醒邮件才能发出。');
  else if (changed.length) say(MARK.arrow + ' 下一步：重启服务（' + C.key + 'npm start' + C.reset + '）让本次改动生效。');
  else say(C.dim + '配置完整，无需操作。' + C.reset);
  if (hasDraft()) warn('有未保存的改动：' + Array.from(DRAFT.keys()).join('、'));
}

/* ══════════════════════════ 邮件服务商预设 ══════════════════════════ */
const SMTP_PRESETS = [
  { label: 'QQ 邮箱（smtp.qq.com:465）', host: 'smtp.qq.com', port: '465', secure: 'true', domains: ['qq.com', 'foxmail.com', 'vip.qq.com'] },
  { label: '163 邮箱（smtp.163.com:465）', host: 'smtp.163.com', port: '465', secure: 'true', domains: ['163.com', '126.com', 'yeah.net'] },
  { label: '腾讯企业邮（smtp.exmail.qq.com:465）', host: 'smtp.exmail.qq.com', port: '465', secure: 'true', domains: ['exmail.qq.com'] },
  { label: '阿里云邮箱（smtp.aliyun.com:465）', host: 'smtp.aliyun.com', port: '465', secure: 'true', domains: ['aliyun.com'] },
  { label: '新浪邮箱（smtp.sina.com:465）', host: 'smtp.sina.com', port: '465', secure: 'true', domains: ['sina.com', 'sina.cn'] },
  { label: '搜狐邮箱（smtp.sohu.com:465）', host: 'smtp.sohu.com', port: '465', secure: 'true', domains: ['sohu.com'] },
  { label: '移动 139 邮箱（smtp.139.com:465）', host: 'smtp.139.com', port: '465', secure: 'true', domains: ['139.com'] },
  { label: '电信 189 邮箱（smtp.189.cn:465）', host: 'smtp.189.cn', port: '465', secure: 'true', domains: ['189.cn'] },
  { label: 'Gmail（smtp.gmail.com:465）', host: 'smtp.gmail.com', port: '465', secure: 'true', domains: ['gmail.com'] },
  { label: 'Outlook / Hotmail（smtp.office365.com:587）', host: 'smtp.office365.com', port: '587', secure: 'false', domains: ['outlook.com', 'hotmail.com', 'live.com', 'office365.com'] },
  { label: 'Yahoo 邮箱（smtp.mail.yahoo.com:465）', host: 'smtp.mail.yahoo.com', port: '465', secure: 'true', domains: ['yahoo.com', 'yahoo.com.cn'] },
  { label: 'iCloud 邮箱（smtp.mail.me.com:587）', host: 'smtp.mail.me.com', port: '587', secure: 'false', domains: ['icloud.com', 'me.com'] },
  { label: '其他 / 自建（手动填主机与端口）', host: '', port: '465', secure: 'true', domains: [] }
];
/** 按发信邮箱域名识别服务商；命中则返回对应 PRESET，未命中返回 null */
function emailDomainOf(v) {
  const m = String(v || '').toLowerCase().match(/^[^\s@]+@([^\s@]+)$/);
  return m ? m[1].replace(/\.+$/, '') : '';
}
function detectProvider(email) {
  const d = emailDomainOf(email);
  if (!d) return null;
  return SMTP_PRESETS.find((p) => p.domains && p.domains.some((x) => d === x || d.endsWith('.' + x))) || null;
}

/* ══════════════════════════ 各功能流程 ══════════════════════════ */

async function smtpFlow() {
  newScreen();
  setStep('邮件服务');
  console.log('\n' + sec('邮件服务 SMTP'));
  tip('用于发送注册激活 / 找回密码的验证码，以及签到、请假、工单等提醒。');
  warn('这里填的是「专用发信邮箱」，不要填成运维者 / 管理员 / 学生自己的登录邮箱。');

  const preset = await askChoice('先选发信邮箱服务商', SMTP_PRESETS, 0);
  if (!preset) return false;
  if (preset.host) {
    draftSet('SMTP_HOST', preset.host);
    draftSet('SMTP_PORT', preset.port);
    draftSet('SMTP_SECURE', preset.secure);
    ok(`已填入 ${preset.host}（端口 ${preset.port}）`);
  } else {
    const host = await askVal({ key: 'SMTP_HOST', label: 'SMTP 服务器地址', allowEmpty: false });
    if (host === null) return false;
    draftSet('SMTP_HOST', host);
    const port = await askVal({
      key: 'SMTP_PORT', label: 'SMTP 端口', sub: '465 走 SSL；587 走 STARTTLS', def: preset.port,
      validate: (v) => (isPort(v) ? null : '端口必须是 1-65535 的数字')
    });
    if (port === null) return false;
    draftSet('SMTP_PORT', port);
    draftSet('SMTP_SECURE', await askBool('该端口是否直接 SSL', draftGet('SMTP_SECURE'), preset.secure));
  }

  const user = await askVal({
    key: 'SMTP_USER', label: 'SMTP 认证账号（发信邮箱地址）',
    sub: '用于登录 SMTP 服务器，收件人不可见；例：no-reply@你的域名',
    allowEmpty: false,
    validate: (v) => (isEmail(v) ? null : '邮箱格式不正确')
  });
  if (user === null) return false;
  draftSet('SMTP_USER', user);
  // 邮箱服务商校验：按发信邮箱域名识别服务商，与所选不一致则自动切换
  const hit = detectProvider(user);
  if (hit && hit.host && (!preset || hit.host !== preset.host)) {
    draftSet('SMTP_HOST', hit.host); draftSet('SMTP_PORT', hit.port); draftSet('SMTP_SECURE', hit.secure);
    ok(`发信邮箱属于「${hit.label.split('（')[0]}」，已自动切换 SMTP 为 ${hit.host}（端口 ${hit.port}）`);
  } else if (!hit) {
    tip('该邮箱域名未匹配到常见服务商，已归为「其他 / 自建」，请手动确认 SMTP 主机与端口。');
  }

  const curPass = draftGet('SMTP_PASS');
  const pass = await askSecret(
    PAD + C.bold + '邮箱授权码' + C.reset + '\n' +
    PAD + C.dim + '**不是登录密码**，需在邮箱服务商处生成' + C.reset + '\n' +
    PAD + C.dim + (curPass ? '直接回车 = 确认保持当前授权码' : '此项必填：请输入授权码') + C.reset + '\n' +
    PAD + C.key + '> ' + C.reset);
  if (pass !== '') draftSet('SMTP_PASS', pass);
  else if (!curPass) { fail('授权码必填，已取消本次邮件配置。'); return false; }

  // SMTP 连通性预检
  try {
    const nodemailer = require('nodemailer');
    const testTransport = nodemailer.createTransport({
      host: draftGet('SMTP_HOST'), port: Number(draftGet('SMTP_PORT') || 465),
      secure: String(draftGet('SMTP_SECURE') || 'true') === 'true',
      auth: { user: draftGet('SMTP_USER'), pass: draftGet('SMTP_PASS') },
      connectionTimeout: 8000, greetingTimeout: 8000
    });
    tip('正在验证 SMTP 连通性…');
    await testTransport.verify();
    ok('SMTP 连通性验证通过。');
  } catch (e) {
    warn('SMTP 连通性验证失败：' + String(e.message || e));
    tip('仍可保存配置，但发信可能失败。请检查主机/端口/授权码/安全设置。');
  }
  const from = await askVal({
    key: 'MAIL_FROM', label: '发件地址（From 头，收件人可见）',
    sub: `通常与 SMTP_USER 相同（${user}）；要用别的地址发信时再改`,
    def: user,
    validate: (v) => (isEmail(v) ? null : '邮箱格式不正确')
  });
  if (from === null) return false;
  draftSet('MAIL_FROM', from);

  const mailName = await askVal({
    key: 'MAIL_SYSTEM_NAME', label: '邮件主题 / 正文中的系统名', sub: '邮件标题与正文里显示的系统名字',
    effect: `邮件里就用系统全称「${liveSystemName()}」`, allowEmpty: true
  });
  if (mailName !== null && mailName !== '') draftSet('MAIL_SYSTEM_NAME', mailName);

  console.log('');
  tip('本系统不提供「发件显示名」配置项。如需收件端显示别的名称，');
  tip('请到发件邮箱服务商修改该邮箱的账户名称 / 昵称；是否生效取决于服务商。');
  return true;
}

/** 测试发信：用 .env 最新配置现场发一封 */
async function testMailFlow() {
  newScreen();
  setStep('测试发信');
  console.log('\n' + sec('测试发信'));
  const host = draftGet('SMTP_HOST'), user = draftGet('SMTP_USER'), pass = draftGet('SMTP_PASS');
  const port = Number(draftGet('SMTP_PORT') || 465);
  const secure = String(draftGet('SMTP_SECURE') || 'true') === 'true';
  if (!(host && user && pass)) {
    fail('SMTP 尚未配齐（主机 / 发信邮箱 / 授权码），请先完成邮件配置。');
    return;
  }
  const to = await askVal({
    key: '__TEST_TO__', label: '收件邮箱', sub: '用来接收这封测试邮件，可填你自己的',
    validate: (v) => (isEmail(v) ? null : '邮箱格式不正确'), allowEmpty: false
  });
  if (to === null) return;
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (e) { fail('未安装 nodemailer，请在项目目录执行 npm ci 后重试。'); return; }
  tip(`正在通过 ${host}:${port} 发送…`);
  try {
    const t = nodemailer.createTransport({ host, port, secure, auth: { user, pass }, connectionTimeout: 15000, greetingTimeout: 15000 });
    const info = await t.sendMail({
      from: `"${cfg.PRODUCT_NAME}" <${String(draftGet('MAIL_FROM') || user).trim()}>`,
      to,
      subject: `【${liveSystemName()}】配置测试邮件`,
      text: `这是一封配置测试邮件。收到它说明 SMTP 配置正确。\n发信时间：${new Date().toLocaleString('zh-CN')}`
    });
    ok('发送成功' + (info && info.messageId ? '（messageId=' + info.messageId + '）' : ''));
    tip('请到收件箱确认；未收到先看垃圾箱。');
  } catch (e) {
    const msg = String((e && e.message) || e);
    fail('发送失败：' + msg);
    if (/535|认证|authentication|login/i.test(msg)) say(MARK.arrow + ' 多半是「授权码」填成了登录密码，或未在邮箱服务商开启 SMTP 服务。');
    else if (/ETIMEDOUT|timeout|ECONN/i.test(msg)) say(MARK.arrow + ' 连不上服务器：检查端口（465/587）、服务器是否放行出站、SMTP_SECURE 是否填反。');
    else if (/self signed|certificate/i.test(msg)) say(MARK.arrow + ' 证书问题：可尝试把 SMTP_SECURE 改反（465 与 587 对调）。');
  }
}

/** 基础设置 */
async function basicFlow() {
  newScreen();
  setStep('基础设置');
  console.log('\n' + sec('基础设置'));
  tip('三层命名：商品名（品牌）= 班级签到系统，代码固定不可改；');
  tip('班级名 = GROUP_NAME（必填）；系统全称 = SYSTEM_NAME，留空自动拼接「班级名 + 商品名」。');

  const cls = await askVal({ key: 'GROUP_NAME', label: '班级名称', sub: '例：通信工程2607班', allowEmpty: false });
  if (cls === null) return;
  draftSet('GROUP_NAME', cls);

  const sys = await askVal({
    key: 'SYSTEM_NAME', label: '系统全称', sub: '留空则由「班级名 + 商品名」自动拼接',
    effect: `当前会得到「${liveSystemName()}」`, allowEmpty: true
  });
  if (sys !== null) draftSet('SYSTEM_NAME', sys);

  const port = await askVal({
    key: 'PORT', label: '服务监听端口', def: String(cfg.PORT || 3000),
    validate: (v) => (isPort(v) ? null : '端口必须是 1-65535 的数字')
  });
  if (port !== null) { draftSet('PORT', port); await checkPort(port); }   // 实测端口是否可用

  const bp = await askChoice('网站部署位置', [
    { label: '域名根目录（https://你的域名/）', v: '' },
    { label: '子路径 /check-in（https://你的域名/check-in/）', v: '/check-in' },
    { label: '子路径 /checkin（https://你的域名/checkin/）', v: '/checkin' },
    { label: '自定义子路径…', v: '__custom__' }
  ], String(draftGet('BASE_PATH') || '') === '/check-in' ? 1 : 0);
  if (bp) {
    if (bp.v === '__custom__') {
      const customPath = await askVal({ key: 'BASE_PATH', label: '自定义子路径', sub: '以 / 开头，如 /office/sign；仅允许字母、数字、下划线、连字符', allowEmpty: false, validate: (v) => {
        if (!/^\/[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/.test(v)) return '路径必须以 / 开头，仅允许字母、数字、下划线、连字符';
        return null;
      }});
      if (customPath === null) return;
      draftSet('BASE_PATH', customPath);
      // 显示完整访问链接预览
      {
        const proto = String(draftGet('COOKIE_SECURE') || 'false') === 'true' ? 'https' : 'http';
        try {
          const { execSync: exs } = require('child_process');
          const sn = exs("grep -m1 'server_name' /www/server/panel/vhost/nginx/*.conf /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* /usr/local/etc/nginx/nginx.conf 2>/dev/null | head -1", { encoding: 'utf8', timeout: 2000 }).trim();
          const m = sn.match(/server_name\s+(.+?)\s*;/);
          const hosts = m ? m[1].split(/\s+/).filter(h => h !== '_' && !/^\d+\.\d+\.\d+\.\d+$/.test(h)) : [];
          const domain = hosts[0] || '';
          const ip = (sn.match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1] || '';
          if (domain) ok(`访问地址：${proto}://${domain}${customPath}`);
          if (ip) tip(`IP 访问：${proto}://${ip}${customPath}`);
        } catch (e) { tip(`访问路径：${customPath}`); }
      }
      await checkBaseUrl(customPath, draftGet('PORT') || cfg.PORT || 3000);
    } else {
      draftSet('BASE_PATH', bp.v);
      // 显示完整访问链接预览
      {
        const proto = String(draftGet('COOKIE_SECURE') || 'false') === 'true' ? 'https' : 'http';
        try {
          const { execSync: exs } = require('child_process');
          const sn = exs("grep -m1 'server_name' /www/server/panel/vhost/nginx/*.conf /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* /usr/local/etc/nginx/nginx.conf 2>/dev/null | head -1", { encoding: 'utf8', timeout: 2000 }).trim();
          const m = sn.match(/server_name\s+(.+?)\s*;/);
          const hosts = m ? m[1].split(/\s+/).filter(h => h !== '_' && !/^\d+\.\d+\.\d+\.\d+$/.test(h)) : [];
          const domain = hosts[0] || '';
          const ip = (sn.match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1] || '';
          if (domain) ok(`访问地址：${proto}://${domain}${bp.v || '/'}`);
          if (ip) tip(`IP 访问：${proto}://${ip}${bp.v || '/'}`);
        } catch (e) { tip(`访问路径：${bp.v || '/'}`); }
      }
      await checkBaseUrl(bp.v, draftGet('PORT') || cfg.PORT || 3000);
    }
  }
  tip('启用后 Cookie 仅走 HTTPS；纯 http 访问必须选否，否则登录失效。');
  tip(MARK.warn + '不启用 HTTPS（http 访问）会让浏览器直接禁用定位 / 上传定位，学生手机端将无法签到定位——正式使用请务必部署 HTTPS。');
    // HTTPS 证书状态检测
  try {
    const { execSync: exs } = require('child_process');
    const sslCerts = exs('find /etc/ssl /etc/pki /www/server/panel/vhost/cert /usr/local/etc/nginx -name "*.pem" -o -name "*.crt" 2>/dev/null || true', { encoding: 'utf8', timeout: 3000 }).trim().split('\n').filter(Boolean);
    if (sslCerts.length) {
      ok('检测到 SSL 证书文件：' + sslCerts.slice(0, 3).join(', ') + (sslCerts.length > 3 ? ' ...' : ''));
      try {
        const expiry = exs('openssl x509 -enddate -noout -in ' + JSON.stringify(sslCerts[0]) + ' 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
        const dateMatch = expiry.match(/notAfter=(.+)/);
        if (dateMatch) {
          const expDate = new Date(dateMatch[1].trim());
          const daysLeft = Math.ceil((expDate - new Date()) / 86400000);
          if (daysLeft < 0) warn('SSL 证书已过期！');
          else if (daysLeft < 30) warn('SSL 证书将在 ' + daysLeft + ' 天后过期。');
          else ok('SSL 证书有效，剩余 ' + daysLeft + ' 天。');
        }
      } catch (e) {}
    } else {
      tip('未检测到 SSL 证书文件。如需 HTTPS，请先申请证书（certbot / 宝塔面板）。');
    }
  } catch (e) {
    tip('无法检测 SSL 证书状态。');
  }
draftSet('COOKIE_SECURE', await askBool('是否启用 HTTPS', draftGet('COOKIE_SECURE'), 'true'));
  tip('是则填 1（位于反向代理之后）；直连公网填 0，否则可伪造 X-Forwarded-For 绕过限流。');
  draftSet('TRUST_PROXY', await askBool('是否部署在反向代理之后', draftGet('TRUST_PROXY'), '1', true));
}

/** 快速配置：首次部署引导 */
async function quickFlow() {
  newScreen();
  console.log('\n' + sec('快速配置（首次部署选这个）'));
  tip('填值处有默认值，直接回车＝确认它；要你选择的（菜单 / Y、N）没有默认项，必须明确输入。');

  newScreen();
  console.log('\n' + sec('第 1 / 4 步 · 给系统起名字'));
  setStep('第 1 / 4 步');
  const cls = await askVal({ key: 'GROUP_NAME', label: '班级名称', sub: '例：通信工程2607班', allowEmpty: false });
  if (cls === null) return;
  draftSet('GROUP_NAME', cls);
  const sys = await askVal({
    key: 'SYSTEM_NAME', label: '系统全称', sub: '留空则由「班级名 + 商品名」自动拼接',
    effect: `系统会自动拼成「${liveSystemName()}」`, allowEmpty: true
  });
  if (sys === null) return;
  draftSet('SYSTEM_NAME', sys);
  ok('系统全称：' + liveSystemName());

  newScreen();
  console.log('\n' + sec('第 2 / 4 步 · 访问方式'));
  setStep('第 2 / 4 步');
  tip('默认不启用 HTTPS（即 http 访问）。注意：http 下浏览器会直接禁用定位 / 上传定位，学生手机端将无法签到定位——正式上线请部署 HTTPS，再到「2) 基础设置」开启。');
  const bp = await askChoice('网站部署位置', [
    { label: '域名根目录（https://你的域名/）', v: '' },
    { label: '子路径 /check-in（https://你的域名/check-in/）', v: '/check-in' },
    { label: '子路径 /checkin（https://你的域名/checkin/）', v: '/checkin' },
    { label: '自定义子路径…', v: '__custom__' }
  ], 1);
  if (!bp) return;
  draftSet('BASE_PATH', bp.v);
  // 显示完整访问链接预览
  {
    const proto = String(draftGet('COOKIE_SECURE') || 'false') === 'true' ? 'https' : 'http';
    try {
      const { execSync: exs } = require('child_process');
      const sn = exs("grep -m1 'server_name' /www/server/panel/vhost/nginx/*.conf /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* /usr/local/etc/nginx/nginx.conf 2>/dev/null | head -1", { encoding: 'utf8', timeout: 2000 }).trim();
      const m = sn.match(/server_name\s+(.+?)\s*;/);
      const hosts = m ? m[1].split(/\s+/).filter(h => h !== '_' && !/^\d+\.\d+\.\d+\.\d+$/.test(h)) : [];
      const domain = hosts[0] || '';
      const ip = (sn.match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1] || '';
      const path = bp.v || '/';
      if (domain) ok(`访问地址：${proto}://${domain}${path}`);
      if (ip) tip(`IP 访问：${proto}://${ip}${path}`);
      if (!domain && !ip) tip(`访问路径：${path}（请确认域名或 IP）`);
    } catch (e) {
      tip(`访问路径：${bp.v || '/'}（无法自动检测域名，请手动确认）`);
    }
  }
  await checkBaseUrl(bp.v, draftGet('PORT') || '3000');
  const port = await askVal({ key: 'PORT', label: '监听端口', def: '3000', validate: (v) => (isPort(v) ? null : '端口必须是 1-65535 的数字') });
  if (port === null) return;
  draftSet('PORT', port);
  await checkPort(port);                                                  // 实测端口是否可用

  newScreen();
  console.log('\n' + sec('第 3 / 4 步 · 邮件服务（可跳过）'));
  setStep('第 3 / 4 步');
  tip('首次部署必须配置：不配则注册验证码与提醒邮件都发不出，账号无法激活，系统将无法使用。');
  const wantMail = await askBool('现在配置邮件服务吗', liveMailConfigured() ? 'true' : 'false', 'true');
  if (String(wantMail) === 'true' && !(await smtpFlow())) return;
  setStep('第 3 / 4 步');

  newScreen();
  console.log('\n' + sec('第 4 / 4 步 · 确认'));
  setStep('第 4 / 4 步');
  const saved = await confirmDraft();
  if (saved) {
    const test = await askBool('要立刻发一封测试邮件验证吗', 'false', 'false');
    if (String(test) === 'true') await testMailFlow();
  }
}

/* ===================== 保存后自动重启服务 =====================
 * 配置写入 .env 后，运行中服务的内存配置不会自动刷新，需重启才生效。
 * 保存成功后：检测服务是否在跑；在跑则询问是否由向导代为重启
 * （终止旧进程并以脱离方式重新拉起，日志写入 .server-restart.log），
 * 不在跑则提示下次启动生效。参照 run_server.js 的 detached 启动方式，
 * 使新服务不被正退出的向导进程带走。 */

/** 端口上是否有进程在监听（TCP 连接试探） */
function isPortOpen(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { s.destroy(); } catch {} res(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

/** 找出监听某端口的进程 PID（跨平台） */
function findPidsOnPort(port) {
  const pids = new Set();
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { windowsHide: true }).toString();
      out.split('\n').forEach((line) => {
        const m = line.trim().split(/\s+/);
        if (m.length >= 5 && /LISTENING/i.test(m[3]) && new RegExp(':' + port + '$').test(m[1]) && /^\d+$/.test(m[4])) pids.add(m[4]);
      });
    } else {
      const out = execSync(`lsof -ti tcp:${port}`, { windowsHide: true }).toString().trim();
      out.split('\n').forEach((s) => s.trim() && /^\d+$/.test(s.trim()) && pids.add(s.trim()));
    }
  } catch {}
  return [...pids];
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** Unix 下取某 PID 的父 PID / 命令行（用于判断进程被谁托管） */
function unixParentOf(pid) {
  try {
    const out = execSync(`ps -o ppid= -p ${pid}`, { windowsHide: true }).toString().trim();
    const m = out.match(/\d+/);
    return m ? m[0] : null;
  } catch { return null; }
}
function unixCmdOf(pid) {
  try { return execSync(`ps -o args= -p ${pid}`, { windowsHide: true }).toString().toLowerCase(); } catch { return ''; }
}

/** 探测端口上进程由谁托管：pm2 / systemd / docker / supervisor / bare / unknown
 *  关键：被托管（pm2/systemd/docker/supervisor）时坚决不能由向导 kill 再 spawn——
 *  托管方会自动拉起，手动杀会造成双实例抢端口、且新进程脱离托管（丢守护/日志/开机自启）。 */
function detectSupervisor(port) {
  const pids = findPidsOnPort(port);
  if (!pids.length) return { kind: 'unknown', name: '' };
  const pid = pids[0];

  // === Windows ===
  if (process.platform === 'win32') {
    try {
      const pp = execSync(`wmic process where "ProcessId=${pid}" get ParentProcessId`, { windowsHide: true }).toString().match(/\d+/g);
      if (pp && pp.length) {
        const pname = execSync(`wmic process where "ProcessId=${pp[pp.length - 1]}" get Name`, { windowsHide: true }).toString().toLowerCase();
        if (/pm2/.test(pname)) return { kind: 'pm2', name: '' };
        if (/nssm|winser|winsvc/.test(pname)) return { kind: 'windows-service', name: pname };
      }
    } catch {}
    return { kind: 'unknown', name: '' };
  }

  // === Unix: 沿祖先链检测 ===
  let cur = pid, guard = 0;
  while (cur && guard++ < 15) {
    const cmd = unixCmdOf(cur);
    if (/pm2/.test(cmd)) return { kind: 'pm2', name: '' };
    if (/supervisord/.test(cmd)) return { kind: 'supervisor', name: '' };
    if (/forever/.test(cmd)) return { kind: 'forever', name: '' };
    if (/nodemon/.test(cmd)) return { kind: 'nodemon', name: '' };
    if (/ts-node-dev|tsnd/.test(cmd)) return { kind: 'nodemon', name: '' };
    if (/bt\b|btpanel|baota/.test(cmd)) return { kind: 'baota', name: '' };
    if (/1panel/.test(cmd)) return { kind: '1panel', name: '' };
    if (/screen/.test(cmd)) return { kind: 'screen', name: '' };
    if (/tmux/.test(cmd)) return { kind: 'tmux', name: '' };
    const p = unixParentOf(cur);
    if (!p || p === cur) break;
    cur = p;
  }

  // === cgroup 检测（Linux） ===
  const cg = readFileSafe(`/proc/${pid}/cgroup`);
  const mountinfo = readFileSafe(`/proc/${pid}/mountinfo`);
  // Docker / Podman / containerd / Kubernetes
  if (fs.existsSync('/.dockerenv') || /docker|kubepods|containerd|podman|lxc|lxd/.test(cg)) {
    // 尝试获取容器名/ID
    let cname = '';
    try {
      const hostname = readFileSafe('/etc/hostname').trim();
      if (hostname && /^[a-f0-9]{12}$/.test(hostname)) cname = hostname;
      else if (hostname) cname = hostname;
    } catch {}
    // 从 cgroup 提取容器 ID
    if (!cname) {
      const m = cg.match(/docker[-/]([a-f0-9]{12,64})/);
      if (m) cname = m[1].substring(0, 12);
    }
    return { kind: 'docker', name: cname };
  }
  // systemd
  if (/\.service/.test(cg)) {
    // 提取 service 名
    const m = cg.match(/\/([^/]+\.service)/);
    return { kind: 'systemd', name: m ? m[1] : '' };
  }
  // OpenRC (Alpine/Gentoo)
  if (fs.existsSync('/run/openrc') || /openrc/.test(cg)) return { kind: 'openrc', name: '' };
  return { kind: 'bare', name: '' };
}

function killPids(pids) {
  pids.forEach((pid) => {
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /F /T`, { windowsHide: true });
      else process.kill(Number(pid), 'SIGTERM');
    } catch {}
  });
}

/** 以脱离方式后台启动服务（参照 run_server.js），日志落盘 */
function startServerDetached() {
  const logPath = path.join(__dirname, '..', '.server-restart.log');
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true
  });
  child.unref();
  return child.pid;
}

async function waitUntilUp(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function doRestart(port) {
  const pids = findPidsOnPort(port);
  if (pids.length) { tip(`正在停止旧服务（PID ${pids.join('、')}）…`); killPids(pids); }
  for (let i = 0; i < 30; i++) { if (!(await isPortOpen(port))) break; await new Promise((r) => setTimeout(r, 300)); }
  const pid = startServerDetached();
  ok(`已后台重启服务（新 PID ${pid}），日志：.server-restart.log`);
  tip('正在等待服务就绪…');
  const up = await waitUntilUp(port);
  if (up) ok(`服务已在端口 ${port} 重新就绪，新配置已生效。`);
  else warn(`重启后服务未在预期时间内响应，请查看 .server-restart.log，或手动 npm start。`);
}

/** 保存成功后调用：先判断进程托管方式，绝不能盲目 kill 被托管进程 */
async function maybeRestart() {
  const port = Number(draftGet('PORT') || cfg.PORT || 3000);
  if (!(await isPortOpen(port))) {
    tip(`服务当前未在运行（端口 ${port} 无响应）。`);
    const start = await askBool('是否现在启动服务', null, 'Y');
    if (start === 'true' || start === true || start === 'Y') {
      // 检查是否有托管工具可用
      let hasPm2 = false;
      try { execSync('pm2 --version 2>/dev/null', { stdio: 'pipe' }); hasPm2 = true; } catch(e) {}
      if (hasPm2) {
        try {
          const cwd = path.join(__dirname, '..');
          // 检测是否已有同端口的 PM2 进程，有则复用其名
          let appName = 'checkin';
          try {
            const pm2List = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
            const apps = JSON.parse(pm2List);
            const portPids = findPidsOnPort(port);
            const match = apps.find(a => portPids.includes(String(a.pid)));
            if (match && match.name) appName = match.name;
          } catch(e) {}
          execSync('pm2 start server/index.js --name ' + JSON.stringify(appName) + ' --cwd ' + JSON.stringify(cwd), { timeout: 10000, stdio: 'pipe' });
          execSync('pm2 save 2>/dev/null', { timeout: 3000, stdio: 'pipe' });
          ok('已通过 PM2 启动服务（应用名: ' + appName + '）。');
          tip('正在等待服务就绪…');
          const up = await waitUntilUp(port);
          if (up) ok(`服务已在端口 ${port} 就绪，配置已生效。`);
          else warn('服务启动后未在预期时间内响应，请查看：pm2 logs checkin');
        } catch(e) {
          fail('PM2 启动失败：' + String(e.message || e));
          tip('请手动执行：pm2 start server/index.js --name <应用名>');
        }
      } else {
        // 无 PM2，用 detached spawn
        const pid = startServerDetached();
        ok(`已后台启动服务（PID ${pid}），日志：.server-restart.log`);
        tip('正在等待服务就绪…');
        const up = await waitUntilUp(port);
        if (up) ok(`服务已在端口 ${port} 就绪，配置已生效。`);
        else warn('服务启动后未在预期时间内响应，请查看 .server-restart.log，或手动 npm start。');
        tip('建议安装 PM2 以获得进程守护：npm install -g pm2');
      }
    } else {
      tip('已跳过启动。请稍后手动执行 npm start 或 pm2 start server/index.js --name <应用名>');
    }
    return;
  }
  const info = await detectSupervisor(port);
  const kind = info.kind;
  const name = info.name;

  // --- pm2 ---
  if (kind === 'pm2') {
    tip('检测到服务由 pm2 托管。');
    try {
      const pm2List = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      const apps = JSON.parse(pm2List);
      const portPids = findPidsOnPort(port);
      const match = apps.find(a => portPids.includes(String(a.pid)));
      const appName = match ? match.name : 'all';
      execSync('pm2 restart ' + JSON.stringify(appName), { timeout: 10000, stdio: 'pipe' });
      ok('已自动执行 pm2 restart ' + appName + '，新配置已生效。');
    } catch (e) {
      ok('请手动执行：pm2 restart <应用名>');
    }
    return;
  }
  // --- systemd ---
  if (kind === 'systemd') {
    tip('检测到服务由 systemd 托管。');
    try {
      let svcName = name;
      if (!svcName) {
        const svcOut = execSync('systemctl list-units --type=service --state=running --no-pager 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
        const svcMatch = svcOut.split('\n').find(l => /check.?in|class.?check/i.test(l));
        if (svcMatch) svcName = svcMatch.trim().split(/\s+/)[0];
      }
      if (svcName) {
        execSync('systemctl restart ' + svcName, { timeout: 10000, stdio: 'pipe' });
        ok('已自动执行 systemctl restart ' + svcName + '，新配置已生效。');
      } else {
        ok('请手动执行：sudo systemctl restart <服务名>');
      }
    } catch (e) {
      ok('请手动执行：sudo systemctl restart <服务名>');
    }
    return;
  }
  // --- supervisor ---
  if (kind === 'supervisor') {
    tip('检测到服务由 supervisor 托管。');
    try {
      const progs = execSync('supervisorctl status 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      const match = progs.split('\n').find(l => /check.?in|RUNNING/i.test(l));
      const progName = match ? match.trim().split(/\s+/)[0] : '';
      if (progName) {
        execSync('supervisorctl restart ' + progName, { timeout: 10000, stdio: 'pipe' });
        ok('已自动执行 supervisorctl restart ' + progName + '，新配置已生效。');
      } else {
        ok('请手动执行：supervisorctl restart <程序名>');
      }
    } catch (e) {
      ok('请手动执行：supervisorctl restart <程序名>');
    }
    return;
  }
  // --- docker / podman / containerd ---
  if (kind === 'docker') {
    tip('检测到服务运行在容器内（Docker/Podman/containerd）。');
    const runtime = (() => {
      try { execSync('podman --version 2>/dev/null', { stdio: 'pipe' }); return 'podman'; } catch {}
      return 'docker';
    })();
    if (name) {
      try {
        execSync(runtime + ' restart ' + name, { timeout: 15000, stdio: 'pipe' });
        ok('已自动执行 ' + runtime + ' restart ' + name + '，新配置已生效。');
      } catch (e) {
        ok('请在容器外执行：' + runtime + ' restart ' + name);
      }
    } else {
      ok('请在容器外执行：' + runtime + ' restart <容器名/ID>');
    }
    return;
  }
  // --- forever ---
  if (kind === 'forever') {
    tip('检测到服务由 forever 托管。');
    try {
      const list = execSync('forever list 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      const match = list.split('\n').find(l => /check.?in|server/i.test(l));
      if (match) {
        const uid = match.trim().split(/\s+/)[0];
        execSync('forever restart ' + uid, { timeout: 10000, stdio: 'pipe' });
        ok('已自动执行 forever restart，新配置已生效。');
      } else {
        ok('请手动执行：forever restart <uid>');
      }
    } catch (e) {
      ok('请手动执行：forever restart <uid>');
    }
    return;
  }
  // --- nodemon / ts-node-dev ---
  if (kind === 'nodemon') {
    tip('检测到服务由 nodemon/ts-node-dev 托管（开发模式）。修改 .env 后通常会自动重载。');
    ok('如未自动重载，请手动重启 nodemon 进程。');
    return;
  }
  // --- 宝塔面板 ---
  if (kind === 'baota') {
    tip('检测到服务由宝塔面板托管。');
    ok('请到宝塔面板 > Node 项目中重启对应项目，或执行：pm2 restart <应用名>');
    return;
  }
  // --- 1Panel ---
  if (kind === '1panel') {
    tip('检测到服务由 1Panel 托管。');
    ok('请到 1Panel 面板中重启对应应用。');
    return;
  }
  // --- screen / tmux ---
  if (kind === 'screen' || kind === 'tmux') {
    tip('检测到服务在 ' + kind + ' 会话中运行。');
    ok('请进入对应 ' + kind + ' 会话手动重启服务。');
    return;
  }
  // --- OpenRC ---
  if (kind === 'openrc') {
    tip('检测到服务由 OpenRC 托管。');
    try {
      const svcs = execSync('rc-status default 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      const match = svcs.split('\n').find(l => /check.?in/i.test(l));
      if (match) {
        const svcName = match.trim().split(/\s+/)[0];
        execSync('rc-service ' + svcName + ' restart', { timeout: 10000, stdio: 'pipe' });
        ok('已自动执行 rc-service ' + svcName + ' restart，新配置已生效。');
      } else {
        ok('请手动执行：rc-service <服务名> restart');
      }
    } catch (e) {
      ok('请手动执行：rc-service <服务名> restart');
    }
    return;
  }
  // --- Windows Service ---
  if (kind === 'windows-service') {
    tip('检测到服务作为 Windows 服务运行。');
    ok('请在服务管理器中重启对应服务，或使用 nssm restart <服务名>。');
    return;
  }
  // --- unknown ---
  if (kind === 'unknown') {
    tip('无法判定服务由谁托管，为安全起见向导不会自行 kill。');
    warn('请自行重启服务（npm start / 对应的托管命令）后新配置才生效。');
    return;
  }
  // --- bare：独立裸进程 ---
  tip(`检测到服务正在运行（端口 ${port}），且为独立进程（未被任何托管工具管理）。`);
  const go = await askBool('由向导帮你重启服务（终止旧进程并以后台方式重新拉起）', 'true', 'true');
  if (String(go) === 'true') await doRestart(port);
  else warn('未重启：请自行重启服务（npm start / start.bat）后新配置才生效。');
}

/** 列出草稿并确认写入 */
async function confirmDraft(tries) {
  if (!hasDraft()) { tip('（没有待保存的改动）'); return false; }
  if ((tries || 0) >= 3) { fail('连续输入无效，已取消保存（改动仍在草稿里，可回菜单重新操作）。'); return false; }
  console.log('');
  tip('即将写入 ' + env.ENV + '：');
  console.log(ihr());
  Array.from(DRAFT).forEach(([k, v]) => {
      const oldVal = env.getKey(k);
      const oldDecrypted = oldVal ? secret.decrypt(oldVal) : '';
      const display = maskVal(k, v) || C.dim + '-' + C.reset;
      if (oldDecrypted && oldDecrypted !== v) {
        console.log(PAD + pad(k, 18) + C.dim + oldDecrypted.substring(0, 20) + C.reset + ' -> ' + display);
      } else {
        console.log(PAD + pad(k, 18) + display);
      }
    });
  console.log(ihr());
  process.stdout.write(PAD + C.key + '> ' + C.reset + C.dim + '确认？Y = 保存，N = 取消' + C.reset + ' ');
  const raw = (await ask('', PAD + C.key + '> ' + C.reset + C.dim + '确认？Y = 保存，N = 取消' + C.reset + ' ')).trim();
  if (raw === '') {                                          // 空回车不生效：必须明确选择
    if ((tries || 0) >= 2) { tip('连续未作出选择，已取消保存（改动仍在草稿里）。'); return false; }
    fail('空回车无效：请输入 Y = 保存，N = 取消。');
    return confirmDraft((tries || 0) + 1);
  }
  const g = guardInput(raw);
  if (!g.ok) { fail(g.reason); return confirmDraft((tries || 0) + 1); }   // 误输入不丢弃草稿，重新确认
  if (g.value.toLowerCase() !== 'y' && g.value.toLowerCase() !== 'yes') {
    DRAFT.clear();
    tip('已取消，未写入任何改动。');
    return false;
  }
  const done = applyDraft();
  changed.push(...done);
  ok(`已保存 ${done.length} 项：${done.join('、')}`);
  if (done.some((k) => secret.isSecretKey(k))) {
    ok(`授权码已加密写入 .env（终端里显示的是明文）`);
    warn(`密钥文件：${secret.keyFilePath()} —— 迁移服务器时请一并复制，丢失则需重新填写授权码。`);
  }
  await maybeRestart();
  return true;
}

/**
 * 查看当前配置（只读）。这里才列出变量名（GROUP_NAME 等），并在右侧给出中文含义，
 * 空值不显示「-」而写明其实际含义（未设置＝走自动拼接 / 内置默认），避免看不懂。
 */
/** 变量名 + 中文含义 + 取值单位。面向运维者：变量名照列，便于对照文档与手工改 .env */
const CONFIG_ROWS = [
  ['GROUP_NAME', '② 班级名（必填）'],
  ['SYSTEM_NAME', '③ 系统全称'],
  ['APP_VERSION', '版本号'],
  ['PORT', '监听端口'],
  ['BASE_PATH', '部署子路径'],
  ['COOKIE_SECURE', '仅 HTTPS 传输 Cookie'],
  ['TRUST_PROXY', '反向代理跳数'],
  ['OPS_NAME', '运维者姓名'],
  ['SMTP_HOST', 'SMTP 服务器'],
  ['SMTP_PORT', 'SMTP 端口'],
  ['SMTP_SECURE', 'SMTP 直连 SSL'],
  ['SMTP_USER', 'SMTP 认证账号'],
  ['SMTP_PASS', 'SMTP 授权码'],
  ['MAIL_FROM', '发件地址（From 头）'],
  ['MAIL_SYSTEM_NAME', '邮件系统名']
];
/**
 * 未设置时的实际生效规则（写成函数：SYSTEM_NAME / MAIL_FROM 的兜底依赖当前其它配置）。
 * 只讲规则与结果，不做口语化解释。
 */
function emptyHint(k) {
  switch (k) {
    case 'GROUP_NAME':
      return '未设置：运维者登录返回 403、注册发码返回 503（必填）';
    case 'SYSTEM_NAME':
      // 拼接依赖班级名：班级名还没填时不能套用公式，否则给出的结果自相矛盾
      return draftGet('GROUP_NAME')
        ? `未设置：自动拼接为「${liveSystemName()}」（班级名 + 商品名）`
        : '未设置：需先填班级名（GROUP_NAME），拼接后才是完整系统全称';
    case 'MAIL_SYSTEM_NAME':
      return `未设置：取系统全称「${liveSystemName()}」`;
    case 'MAIL_FROM':
      return `未设置：取 SMTP_USER${env.getKey('SMTP_USER') ? '（' + env.getKey('SMTP_USER') + '）' : ''}`;
    case 'BASE_PATH':
      return '未设置：部署在域名根目录（BASE_PATH 为空）';
    case 'APP_VERSION':
      return `未设置：取内置默认 ${cfg.APP_VERSION}`;
    case 'PORT':
      return `未设置：取内置默认 ${cfg.PORT}`;
    case 'OPS_NAME':
      return `未设置：取内置默认「${cfg.OPS_INIT.real_name}」`;
    case 'SMTP_PORT':
      return `未设置：取内置默认 ${cfg.MAIL.port}（465=SSL，587=STARTTLS）`;
    case 'SMTP_SECURE':
      return `未设置：取内置默认 ${cfg.MAIL.secure}（465 用 true，587 用 false）`;
    case 'COOKIE_SECURE':
      return '未设置：取内置默认 true（仅 HTTPS 传输 Cookie；以 https 访问时生效，纯 http 直连不影响登录）';
    case 'TRUST_PROXY':
      return '未设置：取内置默认 1（反向代理之后）';
    default:
      return '未设置：取内置默认值';
  }
}
function showConfig() {
  newScreen();
  console.log('\n' + sec('当前配置（.env）'));
  CONFIG_ROWS.forEach(([k, meaning]) => {
    const raw = env.getKey(k);
    const shown = raw ? secret.decrypt(raw) : '';         // .env 里的密文在此还原为明文
    const val = shown || C.dim + '未设置' + C.reset;
    console.log(PAD + pad(k, 18) + pad(val, 24) + C.dim + meaning + C.reset);
    if (!raw) console.log(PAD + ' '.repeat(18) + C.dim + '└ ' + emptyHint(k) + C.reset);
  });
  console.log(hr());
  tip(`① 商品名（品牌）= ${cfg.PRODUCT_NAME}（代码固定）　③ 系统全称 = ${liveSystemName()}`);
  tip('注意：GROUP_NAME 存的是「班级名」，不是应用名（应用名＝商品名，代码固定为「班级签到系统」）。');
  warn(`授权码在此明文显示（便于核对）；写入 .env 时已加密，密钥在 ${secret.keyFilePath()}，迁移服务器请一并复制。`);
}

/** 运维者账号 */
async function opsAccount() {
  newScreen();
  console.log('\n' + sec('运维者账号'));
  const ops = db.prepare("SELECT id, real_name, email, password_hash, disabled FROM users WHERE role='ops' ORDER BY id").get();
  if (!ops) tip('当前无运维者账号（首次启动会自动创建 id 000000 的未激活账号）。');
  else kv('运维者', `${ops.real_name}（id=${ops.id}）　邮箱：${ops.email || '未登记'}　${ops.password_hash ? '已设密码' : '未激活'}${ops.disabled ? '　已注销' : ''}`);

  const sub = await askChoice('要做什么', [
    { label: '修改预置姓名 OPS_NAME（默认「运维者」）', v: 'name' },
    { label: '应急重置运维者密码（清空密码，需重新激活）', v: 'reset' },
    { label: '返回菜单', v: 'back' }
  ], 2);
  if (!sub || sub.v === 'back') return;

  if (sub.v === 'name') {
    const name = await askVal({ key: 'OPS_NAME', label: '预置姓名', sub: '仅首次建库时生效', def: '运维者', allowEmpty: false });
    if (name === null) return;
    env.setKey('OPS_NAME', name);
    process.env.OPS_NAME = name;
    changed.push('OPS_NAME');
    if (ops) {
      db.prepare("UPDATE users SET real_name=?, session_id=NULL WHERE role='ops'").run(name);
      ok('已同步数据库运维者姓名，重启服务后生效。');
    } else ok('已写入 .env，启动后将用于创建运维者账号。');
    return;
  }
  if (sub.v === 'reset') {
    if (!ops) { tip('无运维者账号，无需重置。'); return; }
    warn('这会清空该账号密码并强制重新设密，且会踢掉其全部登录会话。');
    process.stdout.write(PAD + C.key + '> ' + C.reset + C.dim + '输入 yes 确认，其它任意键取消：' + C.reset + ' ');
    const c = (await ask('', PAD + C.key + '> ' + C.reset + C.dim + '输入 yes 确认，其它任意键取消：' + C.reset + ' ')).trim();
    if (c !== 'yes') { tip('已取消。'); return; }
    db.prepare("UPDATE users SET password_hash=NULL, must_change_pwd=1, session_id=NULL WHERE role='ops'").run();
    ok('已清空运维者密码。请在注册页用「姓名 + 身份=运维者」重新完成邮箱验证并设置密码。');
  }
}

/* ══════════════════════════ 菜单 ══════════════════════════ */

const MENU = [
  ['1', '快速配置', '首次部署走这里，按提示走 4 步'],
  ['2', '基础设置', '班级名 / 系统全称 / 端口 / 子路径'],
  ['3', '邮件服务', '选服务商 -> 填发信邮箱与授权码'],
  ['4', '测试发信', '发一封测试邮件，验证能否收到'],
  ['5', '查看配置', '只读，含授权码明文'],
  ['6', '运维者账号', '改名 / 重置密码'],
  ['7', '查看日志', '查看最近的服务日志'],
  ['8', '一键初始化', '清空数据重建（危险）'],
  ['0', '退出', '']
];
function printMenu() {
  console.log('\n' + sec('菜单'));
  MENU.forEach(([no, name, desc]) => item(no, name, desc));
  console.log(hr());
  tip('只接受：菜单编号 / 配置值 / Y / N；选择处空回车无效。');
  tip('任何输入处输入 0 = 放弃当前设置并返回菜单（不写入 .env）。');
  tip('本向导不会执行命令，也不会把你输入交给 AI Agent。');
}

/** 首页：TUI 名称、版本、作者联系方式、使用说明；菜单在按回车后的下一屏 */
/** 首页：分区标题明确应用起点，下接元信息、说明、版权，按回车后再进菜单 */
function printBoundary() {
  console.log('\n' + sec(`${cfg.PRODUCT_NAME} · 配置向导`));
  console.log('');
  say(`作者：${cfg.AUTHOR_NAME}（Yushichadao）`);
  say(`联系：${cfg.AUTHOR_EMAIL}`);
  say(C.dim + 'Copyright © 2026 Yushichadao. All Rights Reserved.' + C.reset);
  console.log(hr());
  say(C.bold + '说明' + C.reset);
  tip('· 这里只接受：菜单编号 / 配置值 / Y / N；选择处空回车无效。');
  tip('· 任何输入处输入 0 = 放弃当前设置并返回菜单（不写入 .env）。');
  tip('· 本向导不会执行命令，也不会把你输入交给 AI Agent。');
  console.log(hr());
  console.log('');
}

async function main() {
  // Restore console for TUI output
  console.log = _origLog;
  console.warn = _origWarn;
  console.error = _origError;
  printBoundary();
  if (!fs.existsSync(env.ENV)) {
    env.ensureEnv();
    console.log(PAD + MARK.warn + ' 未发现 .env，已新建：只记录改动项，其余使用内置默认值。');
  }
  await pressEnter('\n' + PAD + C.dim + '按回车进入菜单' + C.reset + ' ');
  let pending = '';                              // 「返回菜单」处直接输入的下一个菜单编号
  let notice = '';                               // 上一屏留下的提示（清屏后要重显，否则看不见）
  while (true) {
    let ch;
    if (pending) { ch = pending; pending = ''; }  // 用户在上一步末尾已经选好，不再重复打印菜单
    else {
      newScreen();                               // 清屏式刷新：每屏重绘，不往下堆
      if (notice) { fail(notice); notice = ''; }
      printStatus();
      printMenu();
      process.stdout.write(PAD + C.key + '> ' + C.reset + C.dim + '请选择（0-8）' + C.reset + ' ');
      ch = (await ask('', PAD + C.key + '> ' + C.reset + C.dim + '请选择（0-8）' + C.reset + ' ')).trim();
    }
    if (ch === '') continue;                     // 菜单空回车＝不作选择，重新显示菜单
    try {
      if (ch === '1') { await quickFlow(); setStep(''); }
      else if (ch === '2') { await basicFlow(); await confirmDraft(); setStep(''); }
      else if (ch === '3') { if (await smtpFlow()) await confirmDraft(); setStep(''); }
      else if (ch === '4') { await testMailFlow(); setStep(''); }
      else if (ch === '5') { showConfig(); }
      else if (ch === '6') { await opsAccount(); setStep(''); }
      else if (ch === '7') {
        newScreen();
        console.log('\n' + sec('查看日志'));
        try {
          const { execSync: exs } = require('child_process');
          let logContent = '';
          // 仅查看本应用日志，避免泄露其他 pm2 托管服务的日志
          let pm2AppName = '';
          try {
            const pm2List = exs('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
            const apps = JSON.parse(pm2List);
            const port = Number(draftGet('PORT') || cfg.PORT || 3000);
            const pids = findPidsOnPort(port);
            const match = apps.find(a => pids.includes(String(a.pid)));
            if (match) pm2AppName = match.name;
          } catch (e) {}
          if (pm2AppName) {
            try { logContent = exs('pm2 logs ' + JSON.stringify(pm2AppName) + ' --nostream --lines 30 2>/dev/null', { encoding: 'utf8', timeout: 5000 }); } catch (e) {}
          }
          if (!logContent) {
            const logPath = path.join(__dirname, '..', '.server-restart.log');
            if (fs.existsSync(logPath)) logContent = exs('tail -30 ' + JSON.stringify(logPath), { encoding: 'utf8', timeout: 3000 });
          }
          if (logContent) { say('最近 30 行日志：'); console.log(logContent); }
          else tip('未找到日志文件。');
        } catch (e) { fail('读取日志失败：' + String(e.message || e)); }
      }
      else if (ch === '8') {
        newScreen();
        console.log('\n' + sec('一键初始化'));
        warn('这会清空全部业务数据与账号（有自动备份），并退出本向导。');
        try {
          const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
          const activities = db.prepare('SELECT COUNT(*) AS c FROM activities').get().c;
          const records = db.prepare('SELECT COUNT(*) AS c FROM checkins').get().c;
          say('当前数据量：用户 ' + users + ' / 活动 ' + activities + ' / 签到记录 ' + records);
        } catch (e) {
          tip('无法统计数据量（数据库可能未初始化）。');
        }
        process.stdout.write(PAD + C.key + '> ' + C.reset + C.dim + '输入 yes 继续，其它任意键取消：' + C.reset + ' ');
        const c = (await ask('', PAD + C.key + '> ' + C.reset + C.dim + '输入 yes 继续，其它任意键取消：' + C.reset + ' ')).trim();
        if (c === 'yes') { await init.run(); try { process.stdin.setRawMode(false); } catch(e) {} process.stdin.pause(); return; }
        tip('已取消。');
      }
      else if (ch === '0') {
        if (hasDraft()) {
          process.stdout.write(PAD + C.warn + '> ' + C.reset + '还有未保存的改动，现在保存？Y/N：');
          const a = (await ask('', PAD + C.warn + '> ' + C.reset + '还有未保存的改动，现在保存？Y/N：')).trim().toLowerCase();
          if (a === 'y' || a === 'yes') await confirmDraft();
          else tip('改动已丢弃。');
        }
        console.log('');
        if (changed.length) { ok('本次已保存：' + changed.join('、')); }
        say('已退出配置向导，回到终端提示符。');
        try { process.stdin.setRawMode(false); } catch(e) {} process.stdin.pause();
        return;
      }
      else {
        const g = guardInput(ch);                      // 命令 / AI 召唤 / 自然语言：明确拒绝，不执行
        notice = g.ok ? '无效选择，请输入 0-8（0 = 退出）。' : g.reason;
        continue;                                      // 带回提示重绘本屏，不再要求回车
      }
      // 统一收尾：这里可以直接输下一个菜单编号，不会被丢弃
      process.stdout.write(PAD + C.dim + '按回车返回菜单（返回后会列出全部编号）' + C.reset + ' ');
      const after = (await ask('', PAD + C.key + '> ' + C.reset)).trim();
      if (/^[0-8]$/.test(after)) pending = after;
    } catch (e) {
      if (!(e instanceof AbortFlow)) throw e;          // 流程中输 0：放弃本次设置
      setStep('');
      tip('已放弃本次设置，返回菜单（未写入 .env）。');
      if (hasDraft()) {
        process.stdout.write(PAD + C.warn + '> ' + C.reset + '还有未保存的改动，是否保存？Y/N：');
        const a = (await ask('', PAD + C.warn + '> ' + C.reset + '还有未保存的改动，是否保存？Y/N：')).trim().toLowerCase();
        if (a === 'y' || a === 'yes') await confirmDraft();
        else { DRAFT.clear(); tip('未保存的改动已丢弃。'); }
      }
      continue;
    }
  }
}

main().catch((e) => {
  console.error('\n' + MARK.bad + ' 配置向导异常：' + ((e && e.message) || e));
  try { process.stdin.setRawMode(false); } catch(e) {} process.stdin.pause();
  process.exitCode = 1;
});

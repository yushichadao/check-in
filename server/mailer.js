'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const datalog = require('./datalog');
const mt = require('./mailtypes');
const mask = require('./mask');
const St = require('./settings');

/** 邮件发送留痕：无论由谁触发，所有邮件均写入数据流 */
function logSend(to, kind, subject, actor, subjectId) {
  const type = mt.mailType(kind);
  if (!type && kind && String(kind).startsWith('MAIL_')) {
    // 未登记的 MAIL_* 码：说明漏在 server/mailtypes.js 里登记，留痕时用兜底中文名
    console.warn('[mail] 未登记的邮件类型码：' + kind);
  }
  datalog.record({
    category: 'mail',
    action: type ? type.code : String(kind || 'mail'),
    actor: actor || null,
    subject_id: subjectId || null,
    // 隐私：收件邮箱在数据流中只落打码值，不落明文（数据流是长期留存面）
    target: mask.maskEmail(String(to || '')),
    detail: String(subject || ''),
    channel: 'email'
  });
}

/**
 * 邮件发送（SMTP）。未配置 SMTP_HOST / SMTP_USER / SMTP_PASS 时自动禁用，
 * 此时所有邮件会被写入「测试文件」（data/mail-outbox/*.html）而不是真正发出，
 * 便于查看每种邮件长什么样；设置 MAIL_OUTBOX=1 可在已配置 SMTP 时也强制落盘。
 *
 * 邮件主题与验证码正文可用环境变量自定义：
 *   MAIL_SUBJECT  验证码邮件主题（占位符 {app}）
 *   MAIL_TEXT     验证码邮件纯文本模板（{code} {minutes} {app}）
 *   MAIL_FROM     发件人显示（如：班级签到系统 <xxx@qq.com>）
 */
let transporter = null;
let nodemailer = null;

function isConfigured() {
  return !!(cfg.MAIL.host && cfg.MAIL.user && cfg.MAIL.pass);
}

function getTransporter() {
  if (!isConfigured()) return null;
  if (transporter) return transporter;
  try {
    nodemailer = nodemailer || require('nodemailer');
  } catch (e) {
    return null;   // 依赖缺失（未执行 npm install nodemailer）
  }
  transporter = nodemailer.createTransport({
    host: cfg.MAIL.host,
    port: cfg.MAIL.port,
    secure: cfg.MAIL.secure,           // 465 端口用 true，587 用 false（STARTTLS）
    auth: { user: cfg.MAIL.user, pass: cfg.MAIL.pass }
  });
  return transporter;
}

/* ===================== 发信队列：节流 + 限流自动重试 =====================
 * 问题：QQ 免费邮 SMTP 有硬限流（单连接约 15 封、短时突发会 535 封禁，还有日配额）。
 *   活动发布等「批量群发」若瞬时投递会触发 535，导致后续邮件丢失。
 * 方案：所有「非即时」邮件（通知 / 批量预览）进入持久化队列，由单 worker 节流发送：
 *   - 每封之间间隔 MAIL_INTERVAL_MS，避免突发；
 *   - 每发 MAIL_MAX_PER_CONN 封重建一次连接，规避单连接上限；
 *   - 遇 535（限流）自动退避 MAIL_COOLDOWN_MS 后重试，邮件不丢；
 *   - 队列落盘 data/mail-queue.json，进程重启后可继续发送。
 * 验证码走 sendCode，保持即时直发（验证码有时效，不进队列）。
 */
const QUEUE_ENABLED = String(process.env.MAIL_QUEUE || '1') !== '0';
const MAIL_INTERVAL_MS = Math.max(200, Number(process.env.MAIL_INTERVAL_MS || '800'));
const MAIL_MAX_PER_CONN = Math.max(1, Number(process.env.MAIL_MAX_PER_CONN || '10'));
const MAIL_COOLDOWN_MS = Math.max(1000, Number(process.env.MAIL_COOLDOWN_MS || String(30 * 1000)));
const MAIL_COOLDOWN_MAX_MS = Math.max(1000, Number(process.env.MAIL_COOLDOWN_MAX_MS || String(5 * 60 * 1000)));
const MAIL_MAX_ATTEMPTS = Math.max(1, Number(process.env.MAIL_MAX_ATTEMPTS || '8'));

let queueTransport = null, sentOnQueueConn = 0, queueRunning = false, queueTimer = null;
let sendQueue = [];
const QUEUE_FILE = path.join(cfg.DATA_DIR, 'mail-queue.json');

function loadQueue() {
  try {
    const a = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (Array.isArray(a)) sendQueue = a;
  } catch (e) { sendQueue = []; }
}
function saveQueue() {
  try {
    fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(sendQueue));
  } catch (e) { /* 忽略 */ }
}
/** 队列专用 transport：每发 MAIL_MAX_PER_CONN 封重建一次连接，规避单连接上限 */
function getQueueTransport() {
  if (!nodemailer) { try { nodemailer = require('nodemailer'); } catch (e) { return null; } }
  if (!isConfigured()) return null;
  if (!queueTransport || sentOnQueueConn >= MAIL_MAX_PER_CONN) {
    if (queueTransport) { try { queueTransport.close(); } catch (_) {} }
    queueTransport = nodemailer.createTransport({
      host: cfg.MAIL.host, port: cfg.MAIL.port, secure: cfg.MAIL.secure,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
      auth: { user: cfg.MAIL.user, pass: cfg.MAIL.pass }
    });
    sentOnQueueConn = 0;
  }
  return queueTransport;
}
function removeItem(id) { sendQueue = sendQueue.filter(x => x.id !== id); }
function queueSize() { return sendQueue.length; }

/** 入队（返回 true 表示已入队，false 表示队列关闭需调用方自行直发） */
function enqueue(to, mail, meta) {
  if (!QUEUE_ENABLED) return false;
  sendQueue.push({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    to, mail,
    kind: (meta && meta.kind) || 'notice',
    actor: (meta && meta.actor) || null,
    subjectId: (meta && meta.subjectId) || null,
    attempts: 0,
    nextTry: Date.now(),
    createdAt: Date.now()
  });
  saveQueue();
  ensureQueueWorker();
  return true;
}
function ensureQueueWorker() {
  if (queueRunning) return;
  queueRunning = true;
  setImmediate(runQueueOnce);
}
function scheduleQueue(ms) {
  if (queueTimer) clearTimeout(queueTimer);
  queueTimer = setTimeout(runQueueOnce, Math.max(200, ms));
}
async function runQueueOnce() {
  try {
    if (!sendQueue.length) { queueRunning = false; return; }
    const now = Date.now();
    sendQueue.sort((a, b) => a.nextTry - b.nextTry);
    const idx = sendQueue.findIndex(x => x.nextTry <= now);
    if (idx < 0) {                  // 最近的也还没到发送时间（退避中）
      scheduleQueue(sendQueue[0].nextTry - now);
      return;
    }
    const item = sendQueue[idx];
    const t = getQueueTransport();
    if (!t) {                       // 未配置 SMTP：退回落盘测试文件
      const file = saveToOutbox(kindOf(item.kind), item.to, item.mail);
      removeItem(item.id);
      saveQueue();
      scheduleQueue(MAIL_INTERVAL_MS);
      return;
    }
    try {
      await t.sendMail({
        from: systemFrom(), to: item.to,
        subject: item.mail.subject, text: item.mail.text, html: item.mail.html
      });
      sentOnQueueConn++;
      logSend(item.to, kindOf(item.kind), item.mail.subject, item.actor, item.subjectId);
      removeItem(item.id);
      saveQueue();
    } catch (e) {
      item.attempts++;
      const msg = String((e && e.message) || '');
      const rateLimited = /535|limit|频繁|login fail|too many|service not open/i.test(msg);
      if (rateLimited && item.attempts < MAIL_MAX_ATTEMPTS) {
        const wait = item.backoff || MAIL_COOLDOWN_MS;          // 首次用基准，之后指数翻倍
        item.backoff = Math.min(wait * 2, MAIL_COOLDOWN_MAX_MS); // 封顶，避免间隔无限放大
        item.nextTry = Date.now() + wait;                       // 退避后重试，邮件不丢
      } else if (item.attempts >= MAIL_MAX_ATTEMPTS) {
        removeItem(item.id);                            // 超过最大重试，丢弃并留痕
        logSend(item.to, kindOf(item.kind), item.mail.subject + ' [投递失败-超限丢弃]', item.actor, item.subjectId);
      } else {
        item.nextTry = Date.now() + MAIL_INTERVAL_MS;   // 其它瞬时错误稍后重试
      }
      saveQueue();
    }
    scheduleQueue(MAIL_INTERVAL_MS);
  } catch (e) {
    queueRunning = false;            // 异常后允许下次入队重新拉起 worker
    scheduleQueue(MAIL_INTERVAL_MS);
  }
}
loadQueue();

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------- 落盘（测试文件） ------------------------------- */

/**
 * 是否允许把邮件落盘为测试文件。
 *  - MAIL_OUTBOX=1：显式打开（联调 / 本地预览；落盘内容可能含验证码，仅限受控环境）；
 *  - MAIL_OUTBOX=0：显式关闭；
 *  - 未设置：非生产环境（本地开发）默认落盘；**生产环境禁止落盘** ——
 *    等价于「生产必须配置 SMTP」，避免未配置 SMTP 时把含验证码 / 邮箱的邮件静默写到磁盘。
 */
function outboxEnabled() {
  const v = String(process.env.MAIL_OUTBOX || '');
  if (v === '1') return true;
  if (v === '0') return false;
  return cfg.NODE_ENV !== 'production';
}

function outboxDir() {
  return path.join(cfg.DATA_DIR, 'mail-outbox');
}

/** 落盘文件保留时长：验证码类最短（仅服务于联调取码），普通通知较长 */
const OUTBOX_CODE_TTL_MS = 15 * 60 * 1000;
const OUTBOX_TTL_MS = 7 * 24 * 3600 * 1000;
let lastSweepAt = 0;

/**
 * 定时清理落盘邮件（最多每分钟执行一次）：
 *  - 验证码类文件超过 15 分钟即删除（避免验证码长期留在磁盘上）；
 *  - 普通通知文件超过 7 天删除。
 */
function sweepOutbox() {
  const now = Date.now();
  if (now - lastSweepAt < 60 * 1000) return;
  lastSweepAt = now;
  try {
    const dir = outboxDir();
    const codeTags = [String(mt.MAIL.REGISTER), String(mt.MAIL.PW_RESET)].map(k => k.replace(/[^\w-]/g, '_'));
    fs.readdirSync(dir).forEach(name => {
      const full = path.join(dir, name);
      let st = null;
      try { st = fs.statSync(full); } catch (e) { return; }
      if (!st.isFile()) return;
      const isCode = codeTags.some(tag => tag && name.indexOf(tag) >= 0);
      if (now - st.mtimeMs > (isCode ? OUTBOX_CODE_TTL_MS : OUTBOX_TTL_MS)) {
        try { fs.unlinkSync(full); } catch (e) { /* 忽略 */ }
      }
    });
  } catch (e) { /* 忽略 */ }
}

/**
 * 把渲染好的邮件写入测试文件。
 * 说明：文件以 0o600（仅属主可读写）落盘，并顺带触发过期清理。
 *       生产环境必须配置 SMTP：未显式 MAIL_OUTBOX=1 时 outboxEnabled() 为 false，
 *       任何邮件（含含验证码的验证码邮件）都不会被写到磁盘。
 * @returns {string|null} 写入的 .html 路径
 */
function saveToOutbox(kind, to, mail) {
  if (!outboxEnabled()) return null;
  try {
    const dir = outboxDir();
    fs.mkdirSync(dir, { recursive: true });
    sweepOutbox();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeKind = String(kind || 'mail').replace(/[^\w-]/g, '_');
    const base = path.join(dir, `${stamp}_${safeKind}`);
    // 0o600：仅属主可读写，避免同机其它用户读取落盘邮件（含验证码 / 邮箱）
    const opts = { encoding: 'utf8', mode: 0o600 };
    fs.writeFileSync(base + '.html', mail.html || '', opts);
    fs.writeFileSync(base + '.txt',
      `To: ${to}\nSubject: ${mail.subject}\n\n${mail.text || ''}`, opts);
    return base + '.html';
  } catch (e) {
    return null;
  }
}

/* ------------------------------- 维护期邮件守卫 ------------------------------- */
/**
 * 维护模式：除「维护预告 / 维护结束」两类系统通知外，禁止一切外发邮件（含落盘测试文件）。
 * 维护中非运维者账号已被服务端挂起、无法处理业务，此时群发注册验证码 / 签到提醒 / 缺勤提醒 /
 * 工单催办等邮件既无人接收也无意义；维护预告与结束通知由维护控制器专门下发，必须放行。
 */
const MAINT_ALLOW_MAIL = new Set([mt.MAIL.MAINTENANCE_PRE, mt.MAIL.MAINTENANCE_POST]);
function mailSuppressed(kind) {
  if (!St.maintenanceEnabled()) return false;
  return !MAINT_ALLOW_MAIL.has(kind);
}

/* --------------------------------- 模板 --------------------------------- */

/** 系统发件显示名固定为品牌（班级签到系统）；地址沿用 MAIL_FROM / SMTP_USER 中的邮箱地址 */
function systemFrom() {
  const raw = String(cfg.MAIL.from || cfg.MAIL.user || '');
  const m = raw.match(/<([^>]+)>/);
  const addr = m ? m[1].trim() : raw.trim();
  if (!addr) return raw;
  return `"${cfg.PRODUCT_NAME}" <${addr}>`;
}

/** 邮件底栏 HTML（含自动发送声明与版权） */
function mailFooter(app) {
  const a = escapeHtml(cfg.PRODUCT_NAME);
  return `        <tr>
          <td style="background-color:#f6f8fc;border-top:1px solid rgba(30,58,95,.10);padding:14px 28px;">
            <div style="color:#8a94a6;font-size:11px;">本邮件由「${a}」自动发送，请勿直接回复。</div>
          </td>
        </tr>
        <tr>
          <td style="background-color:#fbfcfe;border-top:1px solid rgba(30,58,95,.08);padding:14px 28px;text-align:center;">
            <div style="color:#9aa4b6;font-size:11px;line-height:1.7;">Copyright © 2026 Yushichadao. All Rights Reserved.<br>余子晨 版权所有</div>
          </td>
        </tr>`;
}

/**
 * 邮件 <head>：关闭客户端「数据检测器」，避免日期 / 时间被自动识别成链接加下划线。
 *  - meta[format-detection]：iOS / Apple Mail 会把「2026-09-21」「08:00」识别为可点日期；
 *  - a[x-apple-data-detectors]：Apple Mail 注入的日期 / 地址链接；
 *  - .x-gmail-data-detectors / .aBn：Gmail 注入的日期 / 数字链接；
 *  - [if mso]：Outlook（Word 内核）自动生成的超链接下划线。
 * 兜底：值单元格同时内联 text-decoration:none，纯文本正文不受影响。
 */
const MAIL_HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<!--[if mso]>
<style>a,u,.aBn{text-decoration:none !important;border-bottom:0 none !important;}</style>
<![endif]-->
<style>
  a,a:link,a:visited{color:#1666b8;}
  /* 自动发送声明链接：保持蓝色可点 */
  a.keep-link{color:#1666b8;text-decoration:underline;}
  /* 客户端（QQ / Apple Mail / Gmail / Outlook）自动识别注入的日期 / 时间 / 地址 / 电话链接，
     没有 keep-link 类；一律去链接化——看起来像普通文本、且不可点击，避免邮件里的日期时间变成链接 */
  a:not(.keep-link),
  a[x-apple-data-detectors]:not(.keep-link),
  .x-gmail-data-detectors:not(.keep-link),
  .x-gmail-data-detectors *:not(.keep-link),
  .aBn:not(.keep-link),
  .aBn span:not(.keep-link),.aQJ:not(.keep-link),u+.aBn:not(.keep-link){
    color:inherit !important;
    text-decoration:none !important;
    border-bottom:0 none !important;
    font-size:inherit !important;
    font-weight:inherit !important;
    pointer-events:none !important;
    cursor:text !important;
  }
</style>`;

/** 邮件外框（含 head）：所有模板共用，保证日期 / 时间等普通文本无下划线 */
function mailDoc(body) {
  return `<!doctype html><html lang="zh-CN"><head>${MAIL_HEAD}</head><body style="margin:0;padding:0;background:#eef1f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f7;">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="width:520px;max-width:100%;background:#ffffff;border:1px solid rgba(30,58,95,.14);border-radius:22px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
${body}
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const DEFAULT_SUBJECT = {
  register: '【{app}】账号激活验证码',
  reset: '【{app}】密码重置验证码'
};
const DEFAULT_TEXT = {
  register: '{app} 账号激活验证码：{code}\n有效期 {minutes} 分钟。如非本人操作，请忽略本邮件。',
  reset: '{app} 密码重置验证码：{code}\n有效期 {minutes} 分钟。如非本人操作，请忽略本邮件。'
};

function render(tpl, vars) {
  return String(tpl)
    .replace(/\{code\}/g, vars.code)
    .replace(/\{minutes\}/g, String(vars.minutes))
    .replace(/\{app\}/g, vars.app);
}

/** 与网页 UI 风格一致的验证码邮件（深蓝金渐变 + 衬线标题 + 等宽验证码卡片） */
function buildHtml(code, ttlMinutes, app, purpose) {
  const c = escapeHtml(code);
  const a = escapeHtml(cfg.PRODUCT_NAME);
  const isRegister = purpose === 'register';
  const title = isRegister ? '账号激活验证码' : '密码重置验证码';
  const intro = isRegister
    ? '你正在注册激活账号并设置登录密码。请在页面对应的输入框中填写以下 6 位验证码：'
    : '你正在通过邮箱验证码找回密码。请在页面对应的输入框中填写以下 6 位验证码：';
  return mailDoc(`        <tr>
          <td style="background-color:#1e3a5f;background-image:linear-gradient(135deg,#1e3a5f 0%,#16304f 100%);padding:22px 28px;">
            <div style="font-family:Georgia,'Songti SC','SimSun',serif;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.5px;">
              ${a}<span style="color:#c8a45c;"> · </span>安全验证
            </div>
            <div style="height:3px;width:56px;margin-top:10px;border-radius:2px;background-color:#c8a45c;background-image:linear-gradient(90deg,#c8a45c,#22d3ee);"></div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px;">
            <div style="font-family:Georgia,'Songti SC','SimSun',serif;color:#17202c;font-size:17px;font-weight:700;margin:0 0 10px;">${title}</div>
            <div style="color:#5f6b7d;font-size:14px;line-height:1.7;margin:0 0 20px;">
              ${intro}
            </div>
            <div style="text-align:center;margin:4px 0 20px;">
              <div style="display:inline-block;background-color:#1e3a5f;border-radius:14px;padding:16px 26px;">
                <span style="font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#ffffff;">${c}</span>
              </div>
            </div>
            <div style="text-align:center;color:#5f6b7d;font-size:13px;">
              验证码 <b style="color:#1e3a5f;">${escapeHtml(String(ttlMinutes))} 分钟</b> 内有效，过期请重新获取。
            </div>
            <div style="height:1px;background:rgba(30,58,95,.14);margin:18px 0;"></div>
            <div style="color:#5f6b7d;font-size:12px;line-height:1.7;">
              如非本人操作，请忽略本邮件，你的密码不会被修改。<br>
              为保障账号安全，请勿将验证码转发或告知他人。
            </div>
          </td>
        </tr>
        ${mailFooter(app)}`);
}

/** 通知邮件 HTML（与验证码邮件同一套视觉） */
function buildNoticeHtml(title, intro, rows, footer, app) {
  const a = escapeHtml(cfg.PRODUCT_NAME);
  const arr = rows || [];
  const trs = arr.map((r, i) => {
    const last = i === arr.length - 1;
    const sep = last ? '' : 'border-bottom:1px solid rgba(30,58,95,.08);';
    return `
              <tr>
                <td width="80" style="width:80px;padding:10px 8px ${last ? '2px' : '10px'} 0;color:#8a94a6;font-size:13px;white-space:nowrap;vertical-align:top;${sep}">${escapeHtml(r.label)}</td>
                <td style="padding:10px 0 ${last ? '2px' : '10px'} 0;color:#17202c;font-size:14px;font-weight:500;vertical-align:top;${sep}word-break:break-all;">${escapeHtml(r.value)}</td>
              </tr>`;
  }).join('');
  return mailDoc(`        <tr>
          <td style="background-color:#1e3a5f;background-image:linear-gradient(135deg,#1e3a5f 0%,#16304f 100%);padding:22px 28px;">
            <div style="font-family:Georgia,'Songti SC','SimSun',serif;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.5px;">
              ${a}<span style="color:#c8a45c;"> · </span>通知
            </div>
            <div style="height:3px;width:56px;margin-top:10px;border-radius:2px;background-color:#c8a45c;background-image:linear-gradient(90deg,#c8a45c,#22d3ee);"></div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px;">
            <div style="font-family:Georgia,'Songti SC','SimSun',serif;color:#17202c;font-size:17px;font-weight:700;margin:0 0 10px;">${escapeHtml(title)}</div>
            ${intro ? `<div style="color:#5f6b7d;font-size:14px;line-height:1.7;margin:0 0 8px;">${escapeHtml(intro)}</div>` : ''}
            ${trs ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;border-top:1px solid rgba(30,58,95,.10);border-collapse:collapse;">${trs}</table>` : ''}
            <div style="height:1px;background:rgba(30,58,95,.14);margin:18px 0;"></div>
            <div style="color:#5f6b7d;font-size:12px;line-height:1.7;">${escapeHtml(footer || '')}</div>
          </td>
        </tr>
        ${mailFooter(app)}`);
}

/** 渲染验证码邮件（不发信），返回 { subject, text, html }。
 * @param {string} [purpose] 'register'=注册激活验证码，'reset'=密码重置验证码（默认） */
function renderCodeEmail(code, ttlMinutes, purpose) {
  const app = cfg.MAIL.systemName || '班级签到系统';
  const usePurpose = purpose === 'register' ? 'register' : 'reset';
  const vars = { code, minutes: ttlMinutes, app };
  const subject = render(cfg.MAIL.subject || DEFAULT_SUBJECT[usePurpose], vars);
  const text = render(cfg.MAIL.text || DEFAULT_TEXT[usePurpose], vars);
  // 自定义纯文本模板时也套同一外框（含 head），保证日期 / 时间等文本不被客户端加下划线
  const html = cfg.MAIL.text
    ? mailDoc(`        <tr><td style="padding:28px;">
            <div style="white-space:pre-wrap;font-size:14px;line-height:1.7;color:#17202c;">${escapeHtml(text)}</div>
          </td></tr>${mailFooter(app)}`)
    : buildHtml(code, ttlMinutes, app, usePurpose);
  return { subject, text, html };
}

/** 渲染通知邮件（不发信），返回 { subject, text, html } */
function renderNoticeEmail(opts) {
  const app = cfg.MAIL.systemName || '班级签到系统';
  const title = String((opts && opts.title) || '通知');
  const intro = String((opts && opts.intro) || '');
  const rows = (opts && Array.isArray(opts.rows)) ? opts.rows.filter(r => r && r.value) : [];
  const customFooter = String((opts && opts.footer) || '');
  // 纯文本版需要一句兜底结束语；HTML 版由 mailFooter 统一显示“自动发送/请勿直接回复”，避免与自定义 footer 重复
  const textFooter = customFooter || `本邮件由「${app}」自动发送，请勿直接回复。`;
  const subject = `【${app}】${title}`;
  const text = [title, intro].filter(Boolean).join('\n') +
    (rows.length ? '\n\n' + rows.map(r => `${r.label}：${r.value}`).join('\n') : '') +
    (textFooter ? '\n\n' + textFooter : '');
  return { subject, text, html: buildNoticeHtml(title, intro, rows, customFooter, app) };
}

/* --------------------------------- 发送 --------------------------------- */

/**
 * 邮件类型码（发件人统一显示「系统」，SMTP 仅服务端 env 可见）。
 * 类型总表见 server/mailtypes.js（唯一登记处，新增邮件类型请在那里加）。
 * MAIL_PW_RESET 走验证码模板（sendCode），其余走通知模板（sendNotice）。
 */
const MAIL_TYPES = mt.mailTypeNames();

/** 类型码 → 落盘文件名 / 留痕用（未登记的类型原样保留，便于发现漏登记） */
function kindOf(code) {
  const t = mt.mailType(code);
  return t ? t.code : String(code || 'notice').replace(/[^\w-]/g, '_');
}

/**
 * 发送通知邮件。SMTP 未配置时写入测试文件，不抛错。
 * @param {string} to 收件邮箱
 * @param {{title,intro,rows,footer}} opts
 * @param {string} [kind] 邮件类型码（MAIL_*），用于数据流留痕与落盘文件命名
 */
async function sendNotice(to, opts, kind) {
  if (mailSuppressed(kind)) return { skipped: true, reason: 'maintenance' };
  const mail = renderNoticeEmail(opts);
  const safeKind = kindOf(kind);
  const actor = (opts && opts.actor) || null;
  const subjectId = (opts && opts.subject_id) || null;
  // 未配置 SMTP / 强制落盘：保持原行为（不入队，直接落盘）
  const t = getTransporter();
  if (!t || String(process.env.MAIL_OUTBOX || '') === '1') {
    const file = saveToOutbox(safeKind, to, mail);
    if (file) logSend(to, safeKind, mail.subject, actor, subjectId);
    return file ? { outbox: file, subject: mail.subject } : { skipped: true, reason: '邮件服务未配置' };
  }
  // 进入节流队列发送（规避 QQ 等免费邮的突发限流）
  if (enqueue(to, mail, { kind: safeKind, actor, subjectId })) {
    return { queued: true, subject: mail.subject, queueSize: queueSize() };
  }
  // 队列关闭时回退为即时直发
  return t.sendMail({ from: systemFrom(), to, subject: mail.subject, text: mail.text, html: mail.html });
}

/**
 * 发送验证码邮件。
 * @param {string} to 收件邮箱
 * @param {string} code 6 位验证码
 * @param {number} ttlMinutes 有效期（分钟）
 * @param {string} [actor] 触发者（数据流留痕）
 * @param {number} [subjectId] 关联主体 id（数据流留痕）
 * @param {string} [purpose] 'register'=注册激活，'reset'=密码重置（默认）
 */
async function sendCode(to, code, ttlMinutes, actor, subjectId, purpose) {
  if (mailSuppressed(purpose === 'register' ? mt.MAIL.REGISTER : mt.MAIL.PW_RESET)) {
    return { skipped: true, reason: 'maintenance' };
  }
  const mail = renderCodeEmail(code, ttlMinutes, purpose);
  const t = getTransporter();
  const safeKind = purpose === 'register' ? mt.MAIL.REGISTER : mt.MAIL.PW_RESET;
  logSend(to, safeKind, mail.subject, actor || null, subjectId || null);
  if (!t) {
    if (String(process.env.MAIL_OUTBOX || '') === '1' || !isConfigured()) {
      const file = saveToOutbox(safeKind, to, mail);
      if (file) return { outbox: file, subject: mail.subject };
    }
    throw new Error('邮件服务未配置');
  }
  if (String(process.env.MAIL_OUTBOX || '') === '1') {
    const file = saveToOutbox(safeKind, to, mail);
    return { outbox: file, subject: mail.subject };
  }
  return t.sendMail({ from: systemFrom(), to, subject: mail.subject, text: mail.text, html: mail.html });
}

/**
 * 按已渲染好的内容直接发信（用于测试发送 / 批量发送所有类型邮件）。
 * SMTP 未配置或 MAIL_OUTBOX=1 时改为写入测试文件。
 * @returns {Promise<{messageId?:string, outbox?:string}>}
 */
/**
 * 按已渲染好的内容直接发信（用于测试发送 / 批量发送所有类型邮件）。
 * SMTP 未配置或 MAIL_OUTBOX=1 时改为写入测试文件。
 * @param {string} [kind] 邮件类型码（MAIL_*），缺省按「邮件预览」留痕
 * @returns {Promise<{messageId?:string, outbox?:string}>}
 */
async function sendRendered(to, mail, actor, kind) {
  if (mailSuppressed(kind)) return { skipped: true, reason: 'maintenance' };
  const forceOutbox = String(process.env.MAIL_OUTBOX || '') === '1';
  const safeKind = kindOf(kind || 'preview');
  const t = getTransporter();
  if (!t || forceOutbox) {
    const file = saveToOutbox(safeKind, to, mail);
    if (file) { logSend(to, safeKind, mail && mail.subject, actor || null); return { outbox: file }; }
    throw new Error('邮件服务未配置');
  }
  // 批量 / 预览发送同样走节流队列，避免一次性群发触发 535
  if (enqueue(to, mail, { kind: safeKind, actor })) {
    return { queued: true, subject: mail.subject, queueSize: queueSize() };
  }
  const info = await t.sendMail({
    from: systemFrom(),
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html
  });
  return { messageId: info && info.messageId };
}

module.exports = {
  isConfigured,
  outboxEnabled,
  outboxDir,
  sendCode,
  sendNotice,
  sendRendered,
  queueSize,
  renderCodeEmail,
  renderNoticeEmail,
  MAIL_TYPES,
  MAIL_TYPED: mt.TYPES,
  MAIL_GROUPS: mt.GROUPS,
  mailTypesByGroup: mt.mailTypesByGroup,
  mailTypeName: mt.mailTypeName,
  escapeHtml
};

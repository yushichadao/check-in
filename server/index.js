'use strict';

// 启动前置校验 + 自动修复：better-sqlite3 是原生模块，必须与当前 Node 的 ABI 匹配。
// 注意：不能用 try { require('better-sqlite3') } 兜底——ABI 不匹配时进程会**段错误直接崩溃**，
// try/catch 来不及执行（曾多次表现为 PM2 errored + 502）。这里先在子进程里冒烟加载，
// 加载失败（或版本漂移 / 未安装）时自动执行 npm install <锁定版本> / npm rebuild 修复后复验；
// 只在「确实加载不了」时才终止启动，并给出可直接照做的修复命令。详见 server/deps-check.js。
require('./deps-check').run();

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const cfg = require('./config');
const seed = require('./seed');
const { log, recordEvent } = require('./logger');
const St = require('./settings');
const A = require('./auth');

// 启动时确保初始数据就绪（首次运行会创建运维者账号与默认围栏）
seed.ensure();

// 启动时同步一次「自动代管」：缺小班主任/辅导员则让班委补位，已到岗则收回。
// 失败不阻塞启动（由定时巡检兜底）。
try { require('./autocover').safeSync('startup'); } catch (e) { /* 忽略 */ }

// 校验数据目录（可指向加密卷 / 加密文件夹）具备读写与创建删除能力
(function checkDataDir() {
  const probe = path.join(cfg.DATA_DIR, '.write-probe');
  try {
    fs.writeFileSync(probe, 'ok');
    const back = fs.readFileSync(probe, 'utf8');
    fs.unlinkSync(probe);
    log('info', 'data dir read/write ok', { dir: cfg.DATA_DIR, verified: back === 'ok' });
  } catch (e) {
    log('error', 'data dir not writable: ' + e.message, { dir: cfg.DATA_DIR });
  }
})();

const app = express();
app.set('trust proxy', cfg.TRUST_PROXY);
app.disable('x-powered-by');

// 部署子路径前缀（如 /check-in），为空则部署在根目录
// 必须在使用 P(...) 之前定义（避免 const 暂时性死区，否则 /api/appeal/upload 等启动即报错）
const BASE = cfg.BASE_PATH;
const P = (suffix) => BASE + suffix;

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
// 申诉图片上传：单独的更大体积上限（base64 图片），必须排在全局 json 解析之前
app.use(P('/api/appeal/upload'), express.json({ limit: '8mb' }));
// 活动发布可携带配图（base64），单独的更大体积上限；必须排在全局 json 解析之前
app.use(P('/api/activities'), express.json({ limit: '8mb' }));
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));
app.use(cookieParser());

// 页面与本站静态资源禁用缓存：避免前端改动 / 重新部署后浏览器或反向代理仍命中旧版
// （此前「菜单栏顺序异常 / 下拉没变」即旧 HTML 被缓存所致）。
// 注意：必须用 cacheControl:false 关闭 express.static 自带的 `Cache-Control: public, max-age=0`，
// 否则它会把本处的 no-store 覆盖掉，旧版依旧被缓存。且不能只按 req.path 后缀判断——
// 干净路径（如 /manager，由 extensions:['html'] 兜底成 manager.html）不带 .html 后缀，
// 此前因此漏设 no-store，导致线上菜单顺序停留在旧版本。故对所有非 API 响应统一 no-store。
app.use(P('/'), (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const ext = req.path.split('.').pop().toLowerCase();
  const isAsset = ['js','css','png','jpg','jpeg','gif','svg','ico','woff','woff2','ttf','eot'].includes(ext);
  res.setHeader('Cache-Control', isAsset ? 'public, max-age=3600' : 'no-store');
  next();
});

// 静态资源（前端页面）；cacheControl:false 以保留上方 no-store，避免被 public 缓存命中旧版
app.use(P('/'), express.static(path.join(cfg.ROOT, 'public'), { extensions: ['html'], cacheControl: false }));

/* ===================== 防攻击加固 ===================== */

/** 统一限流器：超限返回 429 JSON（而不是默认 HTML） */
function limiter(windowMs, limit, message) {
  return rateLimit({
    windowMs, limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message || '请求过于频繁，请稍后再试' })
  });
}

// 跨站写操作防护：非 GET 请求校验 Origin/Referer 与本站一致（在 SameSite=Lax 之外再加一层，抵御 CSRF）
app.use(P('/api'), (req, res, next) => {
  const m = (req.method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return next();                 // 非浏览器客户端（curl 等）无 Origin，交由 Cookie 鉴权约束
  try {
    if (new URL(origin).host !== (req.headers.host || '')) {
      return res.status(403).json({ error: '跨站请求已被拒绝' });
    }
  } catch (e) {
    return res.status(403).json({ error: '非法请求来源' });
  }
  next();
});

// /api 响应一律禁用浏览器缓存：会话（/api/auth/me）与维护状态一旦被缓存，前端会把
// 「刚登出」误判成「仍已登录」，进而把维护遮罩重新盖回登录页（前端另有 cache:'no-store' 兜底）
app.use(P('/api'), (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});
// 全局 /api 限流
app.use(P('/api'), limiter(60 * 1000, 300));
// 认证类：防爆破 / 防枚举 / 防邮件轰炸
app.use(P('/api/auth/login'), limiter(15 * 60 * 1000, 60, '登录尝试过于频繁，请稍后再试'));
app.use(P('/api/auth/set-password'), limiter(15 * 60 * 1000, 30, '操作过于频繁，请稍后再试'));
app.use(P('/api/auth/pwd-reset-request'), limiter(15 * 60 * 1000, 15, '提交过于频繁，请稍后再试'));
app.use(P('/api/auth/email-code'), limiter(10 * 60 * 1000, 10, '验证码请求过于频繁，请稍后再试'));
app.use(P('/api/auth/email-reset'), limiter(15 * 60 * 1000, 30, '操作过于频繁，请稍后再试'));
// 上传等重操作
app.use(P('/api/appeal/upload'), limiter(10 * 60 * 1000, 60, '上传过于频繁，请稍后再试'));
// 反馈网站问题：防止刷屏 / 邮件轰炸
app.use(P('/api/feedback'), limiter(10 * 60 * 1000, 20, '反馈提交过于频繁，请稍后再试'));

// —— 维护模式拦截：维护中，除运维端外，一切 /api 请求一律 503 ——
// 服务端强制拦截：即便用 F12 删除前端遮罩也无法继续操作；非法操作一律无效并留痕记录。
const MAINT_ALLOW = [
  P('/api/auth/me'),
  P('/api/auth/login'),
  P('/api/auth/logout'),
  P('/api/auth/privacy'),
  P('/api/settings/public')
];
// 维护期间被拦截的非法操作留痕（同一来源相同操作 30s 内只记一次，避免刷屏）
const _maintBlockLog = new Map();
function logMaintBlock(req, u, p) {
  const ip = String(req.headers['x-forwarded-for'] || req.connection.remoteAddress || '')
    .split(',')[0].trim() || 'unknown';
  const key = ip + '|' + req.method + '|' + p;
  const now = Date.now();
  const last = _maintBlockLog.get(key) || 0;
  if (now - last < 30000) return;
  _maintBlockLog.set(key, now);
  try {
    recordEvent('maintenance_block', u ? u.id : null, null,
      `${req.method} ${p} 被拦截（${u ? (u.role + ' ' + (u.name || '')) : '匿名'} @ ${ip}）`);
  } catch (e) { /* 忽略记录异常，不影响拦截 */ }
  if (_maintBlockLog.size > 200) for (const [k, v] of _maintBlockLog) if (now - v > 60000) _maintBlockLog.delete(k);
}
app.use(P('/api'), (req, res, next) => {
  if (!St.maintenanceEnabled()) return next();
  const u = A.currentUser(req);
  if (u && u.role === 'ops') return next();            // 运维端照常使用
  const p = (req.originalUrl || '').split('?')[0];
  if (MAINT_ALLOW.includes(p)) return next();                // 维护页/登录所需的最小接口
  logMaintBlock(req, u, p);                                  // 非法操作：无效 + 留痕
  return res.status(503).json({ error: '系统维护中，请稍后再试', maintenance: St.maintenanceInfo() });
});

// —— 首次设置强制完成：新注册账号（must_setup=1）在「完成设置」前，一切业务 API 一律 403 ——
// 即便直接输入其它页面地址也会被拦回设置页；白名单放行「完成设置」所需的接口。
const SETUP_ALLOW = new Set([
  P('/api/auth/me'),
  P('/api/auth/logout'),
  P('/api/auth/ping'),
  P('/api/auth/me/complete-setup'),
  P('/api/auth/me/loc-consent'),   // 学生首次设置页的「定位上传授权」需在完成设置前保存
  P('/api/settings/public'),  // 设置页需读取维护态 / 应用信息，属公开状态接口
  P('/api/settings'),         // 运维端首次设置页读取运维开关现状（数据流打码 / 自动代管）
  P('/api/dataflow/mask'),    // 运维端首次设置页保存「数据流隐私打码」开关
  P('/api/settings/auto-cover') // 运维端首次设置页保存「自动代管」开关
]);
app.use(P('/api'), (req, res, next) => {
  const u = A.currentUser(req);
  if (!u) return next();                       // 未登录：交给各路由的 authRequired
  if (!u.must_setup) return next();            // 已完成设置
  const p = (req.originalUrl || '').split('?')[0];
  if (SETUP_ALLOW.has(p) || p.indexOf(P('/api/settings/me/notify')) === 0) return next();
  return res.status(403).json({ error: '请先完成首次设置（通知偏好等）', need_setup: true });
});

// 路由挂载
app.use(P('/api/auth'), require('./routes/auth'));
app.use(P('/api/sessions'), require('./routes/sessions'));
app.use(P('/api/admin'), require('./routes/users'));
// 设置路由必须排在下面两个「宽挂载」之前：activity / checkin 挂载在 /api 且自带
// router.use(authRequired)，会先拦下所有 /api/* 请求——未登录页（登录 / 注册 / 设置）
// 读取公开状态接口 /api/settings/public 会被它判成 401。
app.use(P('/api/settings'), require('./routes/settings'));
app.use(P('/api'), require('./routes/activity'));
app.use(P('/api/fences'), require('./routes/fence'));
app.use(P('/api'), require('./routes/checkin'));
app.use(P('/api/calendar'), require('./routes/calendar'));
app.use(P('/api/stream'), require('./routes/stream'));
app.use(P('/api/permissions'), require('./routes/permissions'));
app.use(P('/api/workorders'), require('./routes/workorder'));
app.use(P('/api/scope'), require('./routes/scope'));
app.use(P('/api/appeal'), require('./routes/appeal'));
app.use(P('/api/notifications'), require('./routes/notifications'));
app.use(P('/api/dataflow'), require('./routes/dataflow'));
app.use(P('/api/feedback'), require('./routes/feedback'));

// 根路径与子路径入口
if (BASE) app.get('/', (req, res) => res.redirect(P('/')));
app.get(P('/'), (req, res) => res.redirect(P('/login.html')));

// 未匹配到的 API：返回可读的 404，并带上方法与完整路径，
// 便于直接定位「接口不存在」究竟是哪一个请求（而不是只看到一句「接口不存在」）
app.use(P('/api'), (req, res) => res.status(404).json({
  error: `接口不存在：${req.method} ${req.originalUrl || req.path}`,
  method: req.method,
  path: req.originalUrl || req.path
}));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log('error', err && err.message ? err.message : 'unknown', { path: req.originalUrl });
  res.status(500).json({ error: '服务器内部错误' });
});

/** 列出本机所有非回环 IPv4 地址（供手机在局域网内访问） */
function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(name => {
    (nets[name] || []).forEach(n => {
      if (n.family === 'IPv4' && !n.internal) out.push({ name, address: n.address });
    });
  });
  return out;
}

/* ===================== HTTPS（可选，根治手机端定位等需安全上下文的功能） =====================
 * 配置 SSL_CERT + SSL_KEY 且文件存在即自动启用 HTTPS 监听（HTTPS_PORT，默认 3443）。
 * 零配置（不配置证书）仍纯 HTTP 运行，与旧行为完全兼容。
 *  - HTTPS_ONLY=true                ：仅 HTTPS，关闭 HTTP 监听，并强制 Cookie Secure
 *  - REDIRECT_HTTP_TO_HTTPS=true    ：保留 HTTP，但 301 跳转到 HTTPS，并强制 Cookie Secure
 * 本地自签证书用 `npm run ssl:gen` 生成（含本机局域网 IP），再把 cert.pem 安装为手机信任的根证书即可。 */
const sslCert = cfg.SSL_CERT, sslKey = cfg.SSL_KEY, sslCa = cfg.SSL_CA;
let httpsOptions = null;
if (sslCert && sslKey && fs.existsSync(sslCert) && fs.existsSync(sslKey)) {
  try {
    httpsOptions = { key: fs.readFileSync(sslKey), cert: fs.readFileSync(sslCert) };
    if (sslCa && fs.existsSync(sslCa)) httpsOptions.ca = fs.readFileSync(sslCa);
    log('info', 'HTTPS 证书已加载', { cert: sslCert });
  } catch (e) {
    log('error', 'SSL 证书读取失败，回退纯 HTTP：' + (e && e.message), {});
    httpsOptions = null;
  }
}
const httpsEnabled = !!httpsOptions;

// 启用 HTTPS 且要求「仅 HTTPS」或「HTTP 跳转 HTTPS」时，正式环境 Cookie 必须 Secure：
// 否则 HTTPS 下的登录会话无法写入，定位签到仍会因「未登录」而失败。
const forceSecureCookie = httpsEnabled && (cfg.HTTPS_ONLY || cfg.REDIRECT_HTTP_TO_HTTPS);
if (forceSecureCookie) cfg.COOKIE_SECURE = true;

function applyTimeouts(server) {
  // 防慢速攻击（Slowloris）：限制请求头/请求体/长连接的等待时间
  server.headersTimeout = 65 * 1000;
  server.keepAliveTimeout = 65 * 1000;
  server.requestTimeout = 5 * 60 * 1000;   // 需容下大体积数据库导入
  server.maxHeadersCount = 100;
  server.on('error', (e) => log('error', 'server error: ' + (e && e.message), {}));
}

function printAccess(proto) {
  const base = cfg.BASE_PATH || '';
  const port = proto === 'https' ? cfg.HTTPS_PORT : cfg.PORT;
  console.log(`  本机：        ${proto}://localhost:${port}${base}/`);
  const lan = lanAddresses();
  if (lan.length) lan.forEach(a => console.log(`  局域网(手机)：${proto}://${a.address}:${port}${base}/   [${a.name}]`));
  else console.log('  （未检测到局域网地址）');
}

// HTTP 监听（可携带「跳转 HTTPS」逻辑）
const startHttpNeeded = !(cfg.HTTPS_ONLY && httpsEnabled);
let httpServer = null;
if (startHttpNeeded) {
  const handler = (req, res) => {
    if (cfg.REDIRECT_HTTP_TO_HTTPS && !(req.headers['x-forwarded-proto'] === 'https')) {
      const host = req.headers.host || ('localhost:' + cfg.PORT);
      res.writeHead(301, { Location: `https://${host}${req.url || '/'}` });
      return res.end();
    }
    return app(req, res);
  };
  httpServer = http.createServer(handler);
  httpServer.listen(cfg.PORT, '0.0.0.0', () => {
    log('info', 'HTTP server started', { port: cfg.PORT, env: cfg.NODE_ENV });
    console.log('签到系统已启动（HTTP），可访问：');
    printAccess('http');
  });
  applyTimeouts(httpServer);
}

// HTTPS 监听
if (httpsEnabled) {
  const httpsServer = https.createServer(httpsOptions, app);
  httpsServer.listen(cfg.HTTPS_PORT, '0.0.0.0', () => {
    log('info', 'HTTPS server started', { port: cfg.HTTPS_PORT });
    console.log('（HTTPS）手机端定位等安全上下文功能已可用，可访问：');
    printAccess('https');
  });
  applyTimeouts(httpsServer);
}

// 邮件提醒任务（开始前 5 分钟 / 结束后缺勤），未配置 SMTP 时自动跳过
require('./scheduler').start();

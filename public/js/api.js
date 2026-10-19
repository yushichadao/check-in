/* 通用请求与工具函数 */

/* 部署子路径自适应：/check-in/login.html -> 基础路径 /check-in/ */
const APP_BASE = (function () {
  const p = location.pathname;
  return p.slice(0, p.lastIndexOf('/') + 1);
})();

function url(path) {
  return (/^https?:\/\//.test(path) || path.charAt(0) === '/') ? path : APP_BASE + path;
}

function goto(path) { window.location.href = url(path); }
/** 同 goto，但用 replace 而非压栈：用于「保存/删除后跳转」，使来源页从历史中移除，
 *  用户点「返回」不会再回到刚编辑/删除的页面（阻止后退到过期编辑态）。 */
function gotoReplace(path) { window.location.replace(url(path)); }

/* 等级 → 身份展示名（前端统一事实源；与 server/config.js IDENTITY_LEVEL 保持一致） */
const IDENTITY_LEVEL_TITLES = { 0: '普通学生', 1: '班委', 2: '小班主任', 3: '辅导员', 9: '运维者' };
function identityOfLevel(level) { return IDENTITY_LEVEL_TITLES[Number(level) || 0] || '普通学生'; }

/* ------------------------- 坐标转换（浏览器定位 WGS-84 → 高德底图 GCJ-02） ------------------------- */
function _gcjOutOfChina(lng, lat) {
  return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271);
}
function _gcjTLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return r;
}
function _gcjTLng(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return r;
}
/** WGS-84 → GCJ-02，返回 [lng, lat] */
function wgs84ToGcj02(lng, lat) {
  lng = Number(lng); lat = Number(lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || _gcjOutOfChina(lng, lat)) return [lng, lat];
  const a = 6378245.0, ee = 0.00669342162296594323, PI = Math.PI;
  const dLat = _gcjTLat(lng - 105.0, lat - 35.0);
  const dLng = _gcjTLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const outLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * PI);
  const outLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * PI);
  return [lng + outLng, lat + outLat];
}

function isAuthPage() {
  return /login\.html|register\.html/.test(location.pathname);
}

async function request(path, options) {
  const opts = Object.assign({
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    noAutoLogout: false
  }, options || {});

  let res;
  try {
    res = await fetch(url(path), opts);
  } catch (e) {
    throw new Error('网络异常，请检查连接');
  }

  // 单端登录：会话失效（被踢下线 / 已登出）时回到登录页
  // noAutoLogout：自服务写操作（如保存个人资料）传 true，避免误把校验失败当登出跳转
  if (res.status === 401 && !isAuthPage() && !opts.noAutoLogout) {
    // 会话失效等同登出：必须先标记「本次是登出」，否则登录页的「自动登录」会立刻把账号顶回登录态，
    // 表现为「点了退出登录，又自动登录进去了」（维护中退出时并发请求返回 401 尤其容易触发）
    markLoggedOut();
    goto('login.html');
    throw new Error('登录已失效，请重新登录');
  }

  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }

  // 维护中：服务端返回 503 + maintenance → 立刻上遮罩（删掉遮罩也无用，请求本来就被拒）
  if (res.status === 503 && data && data.maintenance) {
    try { window.MaintenanceGuard && window.MaintenanceGuard.show(data.maintenance); } catch (e) { /* 忽略 */ }
  }

  // 首次设置未完成：服务端强制拦截，跳到设置页（即便直接输入其它页面地址也会在此被拦回）
  if (res.status === 403 && data && data.need_setup && !/\/setup\.html/.test(location.pathname)) {
    goto('setup.html');
    throw new Error('请先完成首次设置');
  }

  if (!res.ok) {
    const msg = (data && data.error) ? data.error : ('请求失败（' + res.status + '）');
    const err = new Error(msg);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data || {};
}

const api = {
  get: (p) => request(p),
  post: (p, body, extra) => request(p, Object.assign({ method: 'POST', body: JSON.stringify(body || {}) }, extra || {})),
  put: (p, body) => request(p, { method: 'PUT', body: JSON.stringify(body || {}) }),
  // DELETE 也允许携带请求体（高危删除需要 password + confirm_text）
  del: (p, body) => request(p, { method: 'DELETE', body: JSON.stringify(body || {}) })
};

/* ---------------- 记住密码（仅存本机浏览器，退出登录即清除） ---------------- */
const REMEMBER_KEY = 'checkin_remember';

function loadRemembered() {
  try { return JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null'); } catch (e) { return null; }
}
function saveRemembered(obj) {
  try { localStorage.setItem(REMEMBER_KEY, JSON.stringify(obj)); } catch (e) { /* 忽略 */ }
}
function clearRemembered() {
  try { localStorage.removeItem(REMEMBER_KEY); } catch (e) { /* 忽略 */ }
}

/** 隐私政策内容指纹：用于「读完才可打勾」的版本校验（内容变化需重新阅读） */
function privacyHash(text) {
  const s = String(text || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'ph' + s.length + '-' + (h >>> 0).toString(16);
}

function el(id) { return document.getElementById(id); }
function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

/* ---------------- 设备标识 / 设备类型（多设备会话用） ---------------- */
const DEVICE_KEY_STORAGE = 'checkin_device_id';
/* 设备识别码由「服务器签发」：各端不再自行用 Math.random 生成（不可审计、前缀混乱）。
 * 首次访问：先用本地临时码兜底（保证同步读取不报错），再异步向服务器换取正式 DV- 码写入缓存；
 * 用户产生交互（登录 / 签到）时已多为服务器签发的码。之后所有同步读取都拿到服务器签发的码。 */
function deviceKey() {
  try { return localStorage.getItem(DEVICE_KEY_STORAGE) || ''; } catch (e) { return ''; }
}
function _ensureDeviceKey() {
  let id = null;
  try { id = localStorage.getItem(DEVICE_KEY_STORAGE); } catch (e) { id = null; }
  if (id) {
    // 已有缓存：若是旧版本地生成的 OPS- 前缀码，仍向服务器换取正式 DV- 码替换（走服务器）
    if (id.indexOf('DV-') !== 0) _refreshDeviceKey();
    return;
  }
  const rand = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()
    : Math.random().toString(36).slice(2, 14).toUpperCase();
  id = 'TMP-' + rand;
  try { localStorage.setItem(DEVICE_KEY_STORAGE, id); } catch (e) { /* 忽略 */ }
  _refreshDeviceKey();
}
function _refreshDeviceKey() {
  try {
    fetch(url('api/auth/device-key'), { credentials: 'same-origin' })
      .then(r => r.json())
      .then(j => {
        if (j && j.ok && j.device_key) {
          try { localStorage.setItem(DEVICE_KEY_STORAGE, j.device_key); } catch (e) { /* 忽略 */ }
        }
      })
      .catch(() => { /* 网络失败保留当前值，下次再换 */ });
  } catch (e) { /* 忽略 */ }
}
_ensureDeviceKey();

function deviceType() {
  return /Mobi|Android|iPhone|iPod|iPad|Windows Phone|HarmonyOS/i.test(navigator.userAgent)
    ? 'mobile' : 'desktop';
}

function deviceInfo() {
  return { device_key: deviceKey(), device_type: deviceType() };
}

/* ---------------- 本机记住的账号（同姓名多身份快速切换） ---------------- */
const ACCOUNTS_KEY = 'checkin_accounts';

function loadAccounts() {
  try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]'); } catch (e) { return []; }
}
function saveAccount(acc) {
  // 按「姓名 + 身份」去重：避免同名同身份（仅学号不同）的账号被重复记住，导致快速切换列表出现重复项
  const same = (a, b) => a.real_name === b.real_name && a.identity === b.identity;
  const list = loadAccounts().filter(a => !same(a, acc));
  list.unshift(acc);
  try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list.slice(0, 8))); } catch (e) { /* 忽略 */ }
}
function removeAccount(acc) {
  const same = (a, b) => a.real_name === b.real_name && a.identity === b.identity &&
    String(a.student_id || '') === String(b.student_id || '');
  try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(loadAccounts().filter(a => !same(a, acc)))); } catch (e) { /* 忽略 */ }
}
function clearAccountHistory() {
  try { localStorage.removeItem(ACCOUNTS_KEY); } catch (e) { /* 忽略 */ }
}

/** 本机「同名多层级」账号（用于登录页快速切换）：同名且身份不同、至少两个 */
function sameNameAccounts() {
  const byName = {};
  loadAccounts().forEach(a => {
    (byName[a.real_name] = byName[a.real_name] || []).push(a);
  });
  const out = [];
  Object.keys(byName).forEach(name => {
    const list = byName[name];
    // 同一身份只保留一个（去除同名同身份的重复项，如「张三 · 班委」出现两次）
    const seen = new Set();
    const uniq = list.filter(a => { if (seen.has(a.identity)) return false; seen.add(a.identity); return true; });
    if (uniq.length >= 2) out.push(...uniq);
  });
  return out;
}

/** 是否存在可用于快速切换的「同名多层级」账号 */
function hasSwitchableAccounts() { return sameNameAccounts().length > 0; }

/**
 * 标记「本次进入登录页属于登出 / 会话失效」（仅当前标签页有效，关掉标签即失效）。
 * 登录页据此跳过一次自动登录 —— 否则「自动登录」会在登出瞬间把账号顶回登录态；
 * 用 sessionStorage 而非删除用户偏好，下次打开浏览器仍可正常自动登录。
 * 同时立即撤掉维护遮罩：避免维护中遮罩盖住登录入口导致无法操作。
 */
function markLoggedOut() {
  try { sessionStorage.setItem('ci_skip_auto_login', '1'); } catch (e) { /* 忽略 */ }
  try { window.MaintenanceGuard && window.MaintenanceGuard.hide(); } catch (e) { /* 忽略 */ }
}

/** 退出登录：清掉「自动登录」标记，避免退出后被自动登录瞬间顶回登录态 */
async function logout() {
  try { await request('api/auth/logout', { method: 'POST', body: '{}' }); } catch (e) { /* 忽略 */ }
  try { localStorage.removeItem('ci_auto_login'); localStorage.removeItem('ci_saved_creds'); } catch (e) { /* 忽略 */ }
  markLoggedOut();
  gotoReplace('login.html');
}

/** 切换账号：结束当前会话并回到登录页（登录页展示本机记住的账号，可一键切换） */
async function switchAccount() {
  try { await request('api/auth/logout', { method: 'POST', body: '{}' }); } catch (e) { /* 忽略 */ }
  try { localStorage.removeItem('ci_auto_login'); localStorage.removeItem('ci_saved_creds'); } catch (e) { /* 忽略 */ }
  markLoggedOut();
  gotoReplace('login.html');
}

/* ---------------- 会话心跳：保持「在线」状态，被踢/被管理员操作可及时回到登录页 ---------------- */
if (!isAuthPage()) {
  setInterval(() => {
    request('api/auth/ping').catch(() => { /* 401 时 request 会自动跳转登录页 */ });
  }, 2 * 60 * 1000);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** 地点展示净化：界面内绝不出现原始坐标（经纬度）。
 *  仅保留人类可读的地点名；空值、纯坐标串（如 "120.156,30.2745"、"30.2745 120.156"）一律返回 ''，
 *  由调用方回落为「—」。用于所有可能承载 location 的展示位（申诉 / 签到 / 活动等）。 */
function safePlace(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^-?\d{1,3}(?:\.\d+)?\s*[,，、;；/|\s]\s*-?\d{1,3}(?:\.\d+)?$/.test(s)) return '';
  return s;
}

/** 活动详情弹窗（运维端 / 管理端 / 学生端三端共用，结构与口径完全一致）：
 *  基本信息 + 子活动列表 + 签到名单。
 *  统计口径与班级签到视图 / 今日活动卡片相同（活动结束后「在途中」「待签到」折算为「缺勤」）；
 *  名单可见范围由服务端 roster_view 决定：all = 管理员/运维者看全部，self = 普通学生仅看本人，
 *  none = 长期活动（本身不产生签到记录，只有各子活动列表）。 */
const ACT_STATES = [
  { key: 'signed', label: '已签到' },
  { key: 'ontheway', label: '在途中' },
  { key: 'leave', label: '请假' },
  { key: 'absent', label: '缺勤' },
  { key: 'cancelled', label: '退签' },
  { key: 'pending', label: '待签到' }
];
async function openActivityDetail(id) {
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  // wide：详情含信息表 + 名单表，用加宽浮窗（与申诉详情等其它详情浮窗一致）
  modal.innerHTML = `<div class="modal wide">
      <div class="modal-head">
        <h3>活动详情</h3>
        <button class="modal-close" data-close type="button" aria-label="关闭">&times;</button>
      </div>
      <div class="modal-body"><div class="loading">加载中…</div></div>
    </div>`;
  document.body.appendChild(modal);
  const m = modal.querySelector('.modal');
  const close = () => modal.remove();
  // 内容滚动后给标题栏加背景（.is-scrolled），静止时标题栏透明、与浮窗融为一体
  m.addEventListener('scroll', () => m.classList.toggle('is-scrolled', m.scrollTop > 4), { passive: true });
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  const body = modal.querySelector('.modal-body');
  const fill = (html) => { body.innerHTML = html; };
  try {
    const d = await api.get('api/activities/' + id);
    const a = d.activity || {};
    const s = a.summary || {};
    const isGroup = !!a.is_group;
    // 与列表标签同一口径：长期活动 / 长期 · 子活动（活动）/ 临时活动
    const type = isGroup ? '长期活动' : (a.parent_id ? '长期活动 · 子活动' : '临时活动');
    // 活动结束后：「在途中」「待签到」已由 effectiveStatus 折算为「缺勤」，统计不再展示这两个标签
    // （长期活动含进行中 / 已结束混合子活动，故仅对单场已结束活动隐藏）
    // 统计单位：长期活动统计的是各子活动人次（服务端 summary_scope=children），单场则是人数
    // 配图支持多张：按 image_count 逐张读取（/image/0 即第一张）
    // 必须走 url() 拼基础路径，否则子路径部署（/check-in/）与 Electron 下会 404 → 图片静默消失
    const imgCount = Number(a.image_count) || (a.has_image ? 1 : 0);
    const imgHtml = imgCount
      ? `<div class="act-thumbs">${Array.from({ length: imgCount }, (_, i) => {
          const src = url(`api/activities/${a.id}/image/${i}`);
          return `<img class="act-thumb" src="${src}" data-full="${src}" alt="活动配图 ${i + 1}" title="点击放大查看" loading="lazy" onerror="this.style.display='none'">`;
        }).join('')}</div>`
      : '';
    // 长期活动只是分组容器：展示活动概况与各子活动人次合计；
    // 活动与临时活动都是「一场」，共用同一套详情（时间 / 窗口 / 规则 / 范围 / 地点 / 备注）。
    const kids = isGroup ? (a.children || []) : [];
    const firstKid = kids[0];
    const lastKid = kids[kids.length - 1];
    const destRow = (!isGroup && a.dest_lng != null && a.dest_lat != null)
      ? '<tr><td class="muted">终点标记</td><td>已设置 📍</td></tr>' : '';
    const infoTable = isGroup
      ? `<table class="table">
          <tr><td class="muted" style="width:96px;white-space:nowrap">活动名称</td><td>${escapeHtml(a.title || '未命名活动')}</td></tr>
          <tr><td class="muted">类型</td><td>${escapeHtml(type)}</td></tr>
          <tr><td class="muted">子活动</td><td>${kids.length} 场</td></tr>
          <tr><td class="muted">时间跨度</td><td>${firstKid ? `${fmtDateTime(firstKid.start_time)} ~ ${fmtDateTime(lastKid.end_time)}` : '—'}</td></tr>
          <tr><td class="muted">活动范围</td><td>${escapeHtml(a.fence_name || '未启用')}</td></tr>
          <tr><td class="muted">备注</td><td style="word-break:break-word">${escapeHtml(a.remark || '—')}</td></tr>
        </table>`
      : `<table class="table">
          <tr><td class="muted" style="width:96px;white-space:nowrap">活动名称</td><td>${escapeHtml(a.title || '未命名活动')}</td></tr>
          <tr><td class="muted">类型</td><td>${escapeHtml(type)}</td></tr>
          <tr><td class="muted">时间</td><td>${fmtDateTime(a.start_time)} ~ ${fmtDateTime(a.end_time)}</td></tr>
          <tr><td class="muted">签到窗口</td><td>${escapeHtml(a.window_text || '—')}</td></tr>
          <tr><td class="muted">规则</td><td>${escapeHtml(a.policy_text || '—')}</td></tr>
          <tr><td class="muted">活动范围</td><td>${escapeHtml(a.fence_name || '未启用')}</td></tr>
          <tr><td class="muted">地点</td><td>${escapeHtml(safePlace(a.location) || '—')}</td></tr>
          ${destRow}
          <tr><td class="muted">备注</td><td style="word-break:break-word">${escapeHtml(a.remark || '—')}</td></tr>
        </table>`;

    const kidsHtml = isGroup
      ? (kids.length
        ? `<div style="margin:14px 0 6px;font-weight:600">子活动（${kids.length} 场）</div>
        <div class="table-wrap" style="max-height:280px">
          <table class="table">
            <thead><tr><th>子活动</th><th>时间</th><th>已签到</th></tr></thead>
            <tbody>
              ${kids.map(k => `<tr>
                <td>${escapeHtml(k.title || '未命名')}</td>
                <td>${fmtDateTime(k.start_time)} ~ ${fmtTime(k.end_time)}</td>
                <td>${(k.counts && k.counts.signed) || 0} / ${(k.counts && k.counts.total) || 0}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`
        : '<div class="empty" style="margin-top:8px">该长期活动暂无活动</div>')
      : '';
    // 签到名单：三端同一张表，可见范围完全由服务端 roster_view 决定，前端不做额外裁剪
    const roster = Array.isArray(a.roster) ? a.roster : [];
    const rosterHtml = roster.length
      ? `<div style="margin:14px 0 6px;font-weight:600">${a.roster_view === 'self' ? '我的记录' : '签到名单'}（${roster.length} 人）</div>
        <div class="table-wrap" style="max-height:280px">
          <table class="table">
            <thead><tr><th>姓名</th><th>学号</th><th>邮箱</th><th>状态</th><th>签到时间</th><th>定位核验</th></tr></thead>
            <tbody>
              ${roster.map(r => `<tr>
                <td>${escapeHtml(r.real_name || '-')}${r.manual ? ' <span class="badge manual">补签</span>' : ''}</td>
                <td>${escapeHtml(r.student_id || '-')}</td>
                <td>${escapeHtml(r.email || '-')}</td>
                <td>${checkinBadge(r.status)}</td>
                <td>${r.time ? fmtDateTime(r.time) : '—'}</td>
                <td>${inFenceText(r)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`
      : '';

    fill(`${infoTable}
      ${imgHtml}

      ${kidsHtml}
      ${rosterHtml}`);
  } catch (err) {
    fill(`<div class="alert error">${escapeHtml(err.message)}</div>`);
  }
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function fmtDateTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 人工添加对象（活动范围 / 活动等）的「创建信息」统一渲染：
 * 统一格式 = 时间在前（主色），创建人（身份）在后（次要色），两行堆叠。
 * 三端共用同一个函数，保证格式与内容一致（避免各处各写一套）。
 * @param {number|string} createdAt 创建时间戳
 * @param {string} name 创建人姓名
 * @param {string} role 创建人身份（role_title）
 */
function objMetaHtml(createdAt, name, role) {
  const when = fmtDateTime(createdAt);
  const who = (name || '未知') + (role ? `（${role}）` : '');
  return `<div class="obj-meta"><span class="obj-time">${escapeHtml(when)}</span>` +
         `<span class="obj-who">${escapeHtml(who)}</span></div>`;
}

/** 带毫秒（.000）的时间戳，用于数据流等需要更高精度的场景 */
function fmtDateTimeMs(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 活动时间段显示：跨天（不同日期）时显示「月-日 HH:mm」，同日只显示「HH:mm」，
 *  避免 3 天长活动被误读成「00:13 ~ 00:13」这类 0 分钟假象 */
function fmtSpan(start, end) {
  if (!start) return '-';
  const d1 = new Date(start);
  if (!end) return `${pad(d1.getHours())}:${pad(d1.getMinutes())}`;
  const d2 = new Date(end);
  const sameDay = d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
  if (sameDay) return `${pad(d1.getHours())}:${pad(d1.getMinutes())} ~ ${pad(d2.getHours())}:${pad(d2.getMinutes())}`;
  const md = d => `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${md(d1)} ~ ${md(d2)}`;
}

/** 时间区间：未设置的端点不显示「-」，整体为空时给友好占位（避免「- ~ -」这类丑文字） */
function fmtRange(start, end) {
  const s = start ? fmtDateTime(start) : '';
  const e = end ? fmtTime(end) : '';
  if (s && e) return `${s} ~ ${e}`;
  if (!s && !e) return '未设置时间';
  return s || ('至 ' + e);
}

const STATUS_TEXT = {
  signed: '已签到',
  ontheway: '在途中',
  leave: '请假',
  absent: '缺勤',
  cancelled: '已退签',
  pending: '待处理',
  approved: '已通过',
  rejected: '未通过',
  none: '待签到'
};

function statusText(s) { return STATUS_TEXT[s] || s || '-'; }

function badge(s) {
  return `<span class="badge ${s}">${statusText(s)}</span>`;
}

/**
 * 签到状态专用中文与徽章（与通用 badge() 解耦）：
 *  · 通用 badge() 仍用于「离线 / 已驳回 / 未授权」等任意红灰语义，不可改动；
 *  · 此处仅用于「签到状态」展示，且把「退签(cancelled)」归入「待签到」，不回退英文 key。
 *  后端 effectiveStatus 已在活动结束后把途中/退签/无记录统一折算为 缺勤/待签到。
 *  注：「待签到」表示活动尚未结束、学生暂未签到（中性、非过失）；活动一结束仍无有效记录即折算为「缺勤」。
 *  因此「在途中」「待签到」只在活动开始前/进行中作为标签展示；活动一旦结束，effectiveStatus 不会再返回
 *  这两个状态，前端也就不会再显示这两个标签（统一归并为「缺勤」）。
 */
const CHECKIN_STATUS = {
  signed: { label: '已签到', cls: 'signed' },
  ontheway: { label: '在途中', cls: 'ontheway' },
  leave: { label: '请假', cls: 'leave' },
  absent: { label: '缺勤', cls: 'absent' },
  pending: { label: '待签到', cls: 'pending' },
  none: { label: '待签到', cls: 'pending' },
  cancelled: { label: '待签到', cls: 'pending' }
};

function checkinStatusText(s) {
  const v = CHECKIN_STATUS[s];
  return v ? v.label : (s ? String(s) : '待签到');
}

function checkinBadge(s) {
  const v = CHECKIN_STATUS[s] || { label: String(s || '待签到'), cls: 'pending' };
  return `<span class="badge ${v.cls}">${v.label}</span>`;
}

/**
 * 活动范围文案：未发布定位（in_fence 为 null）且确有签到记录时显示「未采集定位」，
 * 避免「没发布定位却显示范围外」的误判；完全无记录才显示占位「—」。
 */
function inFenceText(r) {
  if (r.in_fence === null || r.in_fence === undefined) return r.status ? '未采集定位' : '—';
  return r.in_fence ? '范围内' : '范围外';
}

/**
 * 个人通知渠道偏好（自服务组件，三端通用）。
 *  · 与「系统级通知配置 / 邮件发布哪些功能」完全解耦：此处只改「你自己」收不收、怎么收；
 *  · 任何已登录用户均可随时调整，无需也不要求管理员权限；
 *  · 新注册用户由服务端下发默认偏好，此处仅用于查看与修改。
 * 数据接口：GET/PUT api/settings/me/notify（仅本人），后端按用户维度存储。
 */
const NotifyPrefs = {
  NP_CHAN: { both: '站内 + 邮件', inbox: '仅站内消息', off: '关闭' },
  NP_DESC: {
    '活动与签到提醒': '活动与签到提醒最容易被邮件打扰，可改为「仅站内消息」或「关闭」。',
    '退回 / 回执': '裁决退回、核验 / 补签完成的回执提醒，按需选择是否要邮件。',
    '工单与系统消息': '工单与系统消息为必提醒，系统强制发送，不可更改。'
  },
  mount(boxId, saveId) {
    const box = document.getElementById(boxId);
    if (!box) return;
    const saveBtn = document.getElementById(saveId);
    if (saveBtn) saveBtn.addEventListener('click', () => this.save(boxId, saveId));
    this.render(boxId);
  },
  async render(boxId) {
    const box = document.getElementById(boxId);
    if (!box) return;
    try {
      const d = await api.get('api/settings/me/notify');
      const prefs = d.prefs || [];
      const groups = {};
      prefs.forEach(p => { (groups[p.cat_name] = groups[p.cat_name] || []).push(p); });
      box.innerHTML = Object.keys(groups).map(g => `
        <div class="np-group">
          <div class="np-gtitle">${escapeHtml(g)}${this.NP_DESC[g] ? `<small data-clean-hide>${escapeHtml(this.NP_DESC[g])}</small>` : ''}</div>
          ${groups[g].map(p => `
            <div class="np-row">
              <div class="np-name">${escapeHtml(p.name)}${p.locked ? ' <span class="badge locked">必保留</span>' : ''}</div>
              <select class="np-sel" data-np="${escapeHtml(p.key)}" ${p.locked ? 'disabled title="系统必提醒，不可关闭"' : ''}>
                <option value="both"${p.channel === 'both' ? ' selected' : ''}>${this.NP_CHAN.both}</option>
                <option value="inbox"${p.channel === 'inbox' ? ' selected' : ''}>${this.NP_CHAN.inbox}</option>
                <option value="off"${p.channel === 'off' ? ' selected' : ''}>${this.NP_CHAN.off}</option>
              </select>
            </div>`).join('')}
        </div>`).join('') || '<div class="empty">暂无可配置项</div>';
    } catch (e) {
      box.innerHTML = '<div class="empty">加载失败</div>';
    }
  },
  async save(boxId, saveId) {
    const box = document.getElementById(boxId);
    if (!box) return;
    const prefs = {};
    qsa('#' + boxId + ' select[data-np]').forEach(s => { prefs[s.getAttribute('data-np')] = s.value; });
    try {
      const r = await api.put('api/settings/me/notify', { prefs });
      (r.prefs || []).forEach(p => {
        const sel = box.querySelector('select[data-np="' + p.key + '"]');
        if (sel && !sel.disabled) sel.value = p.channel;
      });
      toast(r.message || '已保存');
    } catch (e) { toastErr(e.message); }
  }
};
window.NotifyPrefs = NotifyPrefs;

let toastTimer = null;
/** kind 可传 'error'：错误提示渲染为红色圆角框 */
function toast(msg, ms, kind) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const div = document.createElement('div');
  div.className = 'toast' + (kind ? ' ' + kind : '');
  div.textContent = msg;
  document.body.appendChild(div);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => div.remove(), ms || 2600);
}

/** 错误提示：红色圆角框，停留更久便于阅读 */
function toastErr(msg, ms) { toast(msg, ms || 4200, 'error'); }

/** 定位不可用理由（可定位返回 null）：HTTP 直连属非安全上下文，手机浏览器会直接禁用
 *  Geolocation（电脑 localhost 调试不受影响，故表现为「电脑正常、手机无法定位」）；
 *  微信内置浏览器也不向普通网页开放定位。统一给出可操作的指引。 */
function geoUnavailableReason() {
  if (window.isSecureContext === false) {
    return '定位需要 HTTPS：当前页面是 HTTP 直连，浏览器已禁用定位。请改用 https:// 地址访问后再签到';
  }
  if (!navigator.geolocation) {
    if (/MicroMessenger/i.test(navigator.userAgent)) {
      return '微信内置浏览器不开放定位：请点右上角「…」选择「在浏览器打开」后重试';
    }
    return '当前浏览器不支持定位';
  }
  return null;
}

/** 分区切换（侧边导航 / 底部菜单共用）：记住上次所在分区，操作/刷新后回到原页面 */
function initSections(defaultSection) {
  const REMEMBER_KEY = 'ci_section:' + location.pathname;

  function activate(target) {
    qsa('.nav-item').forEach(b => b.classList.toggle('active', b.getAttribute('data-section') === target));
    qsa('.section').forEach(s => s.classList.toggle('active', s.id === 'sec-' + target));
    const activeBtn = document.querySelector('.nav-item[data-section="' + target + '"]');
    // 移动端底部菜单：让选中项滚动到可见区域
    try {
      if (activeBtn && window.matchMedia && window.matchMedia('(max-width: 880px)').matches) {
        activeBtn.scrollIntoView({ inline: 'center', block: 'nearest' });
      }
    } catch (e) { /* 忽略 */ }
    try { localStorage.setItem(REMEMBER_KEY, target); } catch (e) { /* 忽略 */ }
    if (window.onSectionChange) window.onSectionChange(target);
  }

  qsa('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-section');
      if (target) activate(target);
    });
  });

  // 恢复上次分区（若仍存在），否则用默认分区
  let remembered = null;
  try { remembered = localStorage.getItem(REMEMBER_KEY); } catch (e) { /* 忽略 */ }
  const start = (remembered && document.querySelector('.nav-item[data-section="' + remembered + '"]'))
    ? remembered : defaultSection;
  const first = document.querySelector('.nav-item[data-section="' + start + '"]') || document.querySelector('.nav-item');
  if (first) first.click();

  // 供操作完成后程序化切回指定分区（如「返回我的提交」）
  window.gotoSection = activate;
}

/** 确认弹窗：改用自绘弹窗（iframe 预览等环境会屏蔽 window.confirm，导致“无弹窗反馈”） */
function confirmBox(msg, danger) { return confirmDialog('请确认', msg, '确定', danger); }

/** 点按钮展开/收起对应面板：把具体内容收进按钮后，减少「摊大饼」感。
 *  同一 data-group 内互斥：一次只显示一个业务内容（如账号安全页）。 */
function initToggles(root) {
  (root || document).querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = document.getElementById(btn.getAttribute('data-toggle'));
      if (!panel) return;
      const group = btn.getAttribute('data-group') || (panel.getAttribute('data-group')) || '';
      const willOpen = panel.classList.contains('hidden');
      if (willOpen && group) {
        (root || document).querySelectorAll('[data-toggle][data-group="' + group + '"]').forEach(other => {
          if (other === btn) return;
          const op = document.getElementById(other.getAttribute('data-toggle'));
          if (op) op.classList.add('hidden');
          other.classList.remove('active');
        });
      }
      panel.classList.toggle('hidden', !willOpen);
      btn.classList.toggle('active', willOpen);
    });
  });
}

/** 自定义确认弹窗（比 window.confirm 更清晰，移动端同样适配）
 *  danger=true 时确认按钮用危险色，并给正文加危象提示，用于不可逆操作。 */
function confirmDialog(title, message, okText, danger) {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal">
      <h3>${escapeHtml(title)}</h3>
      ${danger ? '<div class="alert danger" style="margin-bottom:10px">该操作不可撤销，请谨慎确认。</div>' : ''}
      <p>${escapeHtml(message)}</p>
      <div class="row end">
        <button class="btn ${danger ? 'danger' : 'primary'}" data-yes type="button">${escapeHtml(okText || '确定')}</button>
        <button class="btn" data-no type="button">取消</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    const done = (v) => { mask.remove(); resolve(v); };
    mask.querySelector('[data-no]').addEventListener('click', () => done(false));
    mask.querySelector('[data-yes]').addEventListener('click', () => done(true));
    mask.addEventListener('click', e => { if (e.target === mask) done(false); });
  });
}

/** 输入型确认弹窗（严重消极操作的「二次输入形确认」模板）：登录密码 + 逐字输入固定确认文字（禁止粘贴）。
 *  流程为三段式：① 输入密码与确认文字并点「确认」→ ② 再弹「最终确认」浮窗（不可恢复，确定执行 / 取消）。
 *  返回 Promise<{password, confirm_text}|null>：任一步取消 / 文字不符时 resolve(null)。
 *  仅做前端格式校验与一致性校验，密码是否正确、确认文字是否与场景一致由服务端校验（server/highrisk.js）。 */
function typedConfirm(opts) {
  opts = opts || {};
  const title = opts.title || '请确认';
  const message = opts.message || '';
  const confirmText = opts.confirmText || '';
  const okText = opts.okText || '确认';
  const danger = !!opts.danger;
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal">
      <h3>${escapeHtml(title)}</h3>
      ${message ? `<div class="alert ${danger ? 'danger' : 'warn'}" style="font-size:12px">${escapeHtml(message)}</div>` : ''}
      <div class="field"><label>你的登录密码</label><input type="password" data-pwd autocomplete="off" name="__off_hr"></div>
      <div class="field"><label>请输入下列文字（禁止粘贴）</label>
        <div class="tag" style="margin-bottom:6px" data-text>${escapeHtml(confirmText)}</div>
        <input data-txt autocomplete="off" placeholder="逐字输入上方文字">
      </div>
      <div class="row end" style="gap:8px">
        <button class="btn ${danger ? 'danger' : 'primary'}" data-yes type="button">${escapeHtml(okText)}</button>
        <button class="btn" data-no type="button">取消</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    const pwd = mask.querySelector('[data-pwd]');
    const input = mask.querySelector('[data-txt]');
    input.addEventListener('paste', e => e.preventDefault());
    const close = () => mask.remove();
    const cancel = () => { close(); resolve(null); };
    mask.querySelector('[data-no]').addEventListener('click', cancel);
    mask.addEventListener('click', e => { if (e.target === mask) cancel(); });
    mask.querySelector('[data-yes]').addEventListener('click', () => {
      if (!pwd.value) { toast('请输入你的登录密码'); return; }
      if (input.value.trim() !== confirmText) { toast('确认文字不一致（且不可粘贴）'); return; }
      const result = { password: pwd.value, confirm_text: input.value.trim() };
      mask.remove();
      // 最终确认：在「密码 + 逐字确认文字」之后再加一道关卡，避免误触高危操作
      const fm = document.createElement('div');
      fm.className = 'modal-mask';
      fm.innerHTML = `<div class="modal">
        <h3>最终确认</h3>
        <div class="alert danger" style="font-size:12px">此操作不可恢复。请再次确认是否执行「${escapeHtml(okText)}」。</div>
        <div class="row end" style="gap:8px;margin-top:14px">
          <button class="btn danger" data-ok2 type="button">确定执行</button>
          <button class="btn" data-no2 type="button">取消</button>
        </div>
      </div>`;
      document.body.appendChild(fm);
      const fmNo = () => { fm.remove(); resolve(null); };
      fm.querySelector('[data-no2]').addEventListener('click', fmNo);
      fm.addEventListener('click', e => { if (e.target === fm) fmNo(); });
      fm.querySelector('[data-ok2]').addEventListener('click', () => { fm.remove(); resolve(result); });
      if (fm.querySelector('[data-no2]')) fm.querySelector('[data-no2]').focus();
    });
    if (pwd) pwd.focus();
  });
}

/** 严重消极操作二次确认（二次输入形确认）：本人登录密码 + 服务端下发的场景固定确认文字（禁止粘贴）。
 *  与 server/highrisk.js 的场景文案完全一致：调用方须传入 cfg.text（如「确认清除账号数据。」），不可前端硬编码。
 *  cfg: { title, danger(警告文案), text(确认文字), label(确认按钮文案) }
 *  返回 Promise<{password, confirm_text}|null>：用户取消 / 文字不符时 resolve(null)。
 *  服务端校验见 server/highrisk.js 的 verify() 与 server/routes/users.js 的 verifyHighRisk()。 */
function highRiskConfirm(cfg) {
  cfg = cfg || {};
  return typedConfirm({
    title: cfg.title,
    message: cfg.danger,
    confirmText: cfg.text,
    okText: cfg.label,
    danger: true
  });
}

/** 统一的加载态占位（旋转指示器 + 文案），避免各处「加载中…」样式不一 */
function loadingHtml(text) {
  return `<div class="loading"><span class="spin" aria-hidden="true"></span>${escapeHtml(text || '正在加载…')}</div>`;
}

/** 需要输入密码的弹窗（用于“修改已登记邮箱”等需确认身份的场景），返回 Promise<string|null> */
function promptPassword(title, message) {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(message)}</p>
      <div class="field"><label>当前登录密码</label><input type="password" data-pwd autocomplete="off"></div>
      <div class="row end">
        <button class="btn primary" data-yes type="button">确认</button>
        <button class="btn" data-no type="button">取消</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    const input = mask.querySelector('[data-pwd]');
    if (input) input.focus();
    const done = (v) => { mask.remove(); resolve(v); };
    mask.querySelector('[data-no]').addEventListener('click', () => done(null));
    mask.querySelector('[data-yes]').addEventListener('click', () => {
      const v = input ? input.value : '';
      if (!v) { toast('请输入当前登录密码'); return; }
      done(v);
    });
    mask.addEventListener('click', e => { if (e.target === mask) done(null); });
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') mask.querySelector('[data-yes]').click(); });
  });
}

/**
 * 多字段表单弹窗，返回 Promise<Object|null>
 * fields: [{ name, label, placeholder, value, type, multiline, rows }]
 *   multiline: true 时渲染 textarea（长文本如公告正文、隐私文案）
 */
function formDialog(title, message, fields, okText) {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const body = (fields || []).map(f => {
      const attrs = [];
      if (f.disabled) attrs.push('disabled');
      if (f.readonly) attrs.push('readonly');
      const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
      const val = escapeHtml(f.value == null ? '' : String(f.value));
      const ph = escapeHtml(f.placeholder || '');
      const ctrl = f.multiline
        ? `<textarea data-f="${escapeHtml(f.name)}" rows="${Number(f.rows) || 6}" placeholder="${ph}"${attrStr}>${val}</textarea>`
        : `<input data-f="${escapeHtml(f.name)}" type="${escapeHtml(f.type || 'text')}" value="${val}" placeholder="${ph}"${attrStr}>`;
      return `<div class="field"><label>${escapeHtml(f.label || f.name)}</label>
        ${ctrl}
      </div>`;
    }).join('');
    mask.innerHTML = `<div class="modal">
      <h3>${escapeHtml(title)}</h3>
      ${message ? `<p>${escapeHtml(message)}</p>` : ''}
      ${body}
      <div class="row end">
        <button class="btn primary" data-yes type="button">${escapeHtml(okText || '确定')}</button>
        <button class="btn" data-no type="button">取消</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    const done = (v) => { mask.remove(); resolve(v); };
    mask.querySelector('[data-no]').addEventListener('click', () => done(null));
    mask.querySelector('[data-yes]').addEventListener('click', () => {
      const out = {};
      mask.querySelectorAll('[data-f]').forEach(i => { out[i.getAttribute('data-f')] = String(i.value || '').trim(); });
      done(out);
    });
    mask.addEventListener('click', e => { if (e.target === mask) done(null); });
    const first = mask.querySelector('[data-f]');
    if (first) first.focus();
  });
}

/** 需要输入文本的弹窗（如补签理由 / 审核留言），返回 Promise<string|null>；optional=true 时允许留空 */
function promptText(title, message, placeholder, multiline, optional) {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const field = multiline
      ? `<textarea data-val rows="3" placeholder="${escapeHtml(placeholder || '')}"></textarea>`
      : `<input data-val autocomplete="off" placeholder="${escapeHtml(placeholder || '')}">`;
    mask.innerHTML = `<div class="modal">
      <h3>${escapeHtml(title)}</h3>
      ${message ? `<p>${escapeHtml(message)}</p>` : ''}
      <div class="field"><label>请填写</label>${field}</div>
      <div class="row end">
        <button class="btn primary" data-yes type="button">提交</button>
        <button class="btn" data-no type="button">取消</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    const input = mask.querySelector('[data-val]');
    if (input) input.focus();
    const done = (v) => { mask.remove(); resolve(v); };
    mask.querySelector('[data-no]').addEventListener('click', () => done(null));
    mask.querySelector('[data-yes]').addEventListener('click', () => {
      const v = input ? String(input.value || '').trim() : '';
      if (!v && !optional) { toast('请填写内容'); return; }
      done(v);
    });
    mask.addEventListener('click', e => { if (e.target === mask) done(null); });
    if (input && !multiline) {
      input.addEventListener('keydown', e => { if (e.key === 'Enter') mask.querySelector('[data-yes]').click(); });
    }
  });
}

/** 当天详情区的未选中提示文案（内联块与独立卡片共用） */
const CAL_DETAIL_HINT = '点击日历中的日期，查看当天详情';

/** 把「当天详情」恢复为未选中提示态（切换月份 / 无数据时避免残留旧内容） */
function resetCalendarDetail(box) {
  if (!box) return;
  box.classList.add('muted');
  box.innerHTML = `<div class="empty">${CAL_DETAIL_HINT}</div>`;
}

/**
 * 自绘月历（多端多设备自适应）：days = { 'YYYY-MM-DD': [ {title,status,...} | {title,counts} ] }
 * 点击任意日期，在下方显示当天详细信息。
 * detailBox 可选：传入一个日历外部的容器（通常是日历卡片下方的独立「当天详情」卡片），
 * 详情会渲染到该容器；不传则退化为日历下方的内联块（旧行为）。
 */
function renderCalendar(container, monthStr, days, detailBox) {
  const parts = String(monthStr || '').split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  // 周一排在最左，周日排在最右（日期范围限定 1900–2099，无需处理格里高利历改革缺口）
  const startDow = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const total = new Date(y, m, 0).getDate();
  const store = days || {};

  let html = '';
  html += '<div class="calendar">';
  ['一', '二', '三', '四', '五', '六', '日'].forEach(w => {
    html += `<div class="cal-head">${w}</div>`;
  });
  for (let i = 0; i < startDow; i++) html += '<div class="cal-cell empty"></div>';

  for (let d = 1; d <= total; d++) {
    const key = `${y}-${pad(m)}-${pad(d)}`;
    const items = store[key] || [];
    html += `<div class="cal-cell" data-key="${key}" title="点击查看当天详情"><div class="d">${d}</div>`;
    items.forEach(it => {
      if (it.counts) {
        // 班级 / 汇总视图：显示的是「已签到 / 总人数」，没有个人状态可言，
        // 因此不按状态着色（否则颜色无意义且误导），统一用中性圆点。
        html += `<div class="ev" title="${escapeHtml(it.title)}">` +
          `<span class="dot plain"></span>${escapeHtml(it.title)} ${it.counts.signed}/${it.counts.total}</div>`;
      } else {
        html += `<div class="ev" title="${escapeHtml(it.title)}">` +
          `<span class="dot ${it.status}"></span>${fmtTime(it.start_time)} ${checkinStatusText(it.status)}</div>`;
      }
    });
    html += '</div>';
  }
  html += '</div>';
  // 传了独立详情容器时不再内联，详情渲染到日历下方的独立卡片
  if (!detailBox) html += `<div class="cal-detail muted">${CAL_DETAIL_HINT}</div>`;
  // 用可横向滚动的容器包裹：移动端窄屏也能看到完整活动标题，避免被裁成「…」
  container.innerHTML = '<div class="cal-scroll">' + html + '</div>';
  // 每次重绘（切换月份 / 切换对象）都把独立详情卡片重置为提示态，避免显示与当前日历不符的旧内容
  if (detailBox) resetCalendarDetail(detailBox);

  const detailTarget = () => detailBox || container.querySelector('.cal-detail');
  qsa('#' + container.id + ' .cal-cell[data-key]').forEach(cell => {
    const show = () => {
      // 高亮当前选中的日期，便于对照下方详情卡片
      qsa('#' + container.id + ' .cal-cell.sel').forEach(c => c.classList.remove('sel'));
      cell.classList.add('sel');
      renderDayDetail(
        detailTarget(),
        cell.getAttribute('data-key'),
        store[cell.getAttribute('data-key')] || []
      );
      // 详情在日历下方的独立卡片里，若不在可视区内则滚动过去，避免点了日期看不到变化
      if (detailBox) {
        const card = detailBox.closest('.card') || detailBox;
        const r = card.getBoundingClientRect();
        if (r.height && (r.top < 0 || r.bottom > window.innerHeight)) {
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    };
    cell.addEventListener('click', show);
    cell.addEventListener('keydown', e => { if (e.key === 'Enter') show(); });
  });
}

/** 当天详情：个人模式显示状态/活动范围/操作者；班级模式显示各项统计 */
function renderDayDetail(box, key, items) {
  if (!box) return;
  box.classList.remove('muted'); // 提示态的置灰样式不应用于真实内容
  if (!items.length) {
    box.innerHTML = '<div class="empty">当天无活动记录</div>';
    return;
  }
  const d = new Date(key + 'T00:00:00');
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  let html = `<div class="row between" style="margin-bottom:8px">
    <b>${key} 星期${week}</b><span class="tag">${items.length} 项</span></div>`;

  items.forEach(it => {
    if (it.counts) {
      // 活动结束后：「在途中」「待签到」已折算为「缺勤」，不再展示这两个标签
      const ended = it.end_time && Date.now() > it.end_time;
      const tw = ended ? '' : `<span class="badge ontheway">途中 ${it.counts.ontheway}</span>`;
      const pd = ended ? '' : `<span class="badge pending">待签 ${it.counts.pending || 0}</span>`;
      html += `<div class="item">
        <b>${escapeHtml(it.title)}</b>
        <span class="tag">${fmtTime(it.start_time)} ~ ${fmtTime(it.end_time)}</span>
        <div class="row roster-summary" style="flex-basis:100%;margin-top:6px">
          <span class="tag">共 ${it.counts.total} 人</span>
          <span class="badge signed">签 ${it.counts.signed}</span>
          ${tw}
          <span class="badge leave">假 ${it.counts.leave}</span>
          <span class="badge absent">缺 ${it.counts.absent}</span>
          ${pd}
        </div>
      </div>`;
    } else {
      html += `<div class="item">
        <b>${escapeHtml(it.title)}</b>
        <span class="tag">${fmtTime(it.start_time)} ~ ${fmtTime(it.end_time)}</span>
        ${checkinBadge(it.status)}
        ${it.in_fence === 1 ? '<span class="badge signed">活动范围内</span>'
          : (it.in_fence === 0 ? '<span class="badge cancelled">活动范围外</span>' : '')}
        ${it.manual ? '<span class="badge manual">管理员操作</span>' : ''}
        ${it.created_at ? `<span class="tag">提交于 ${fmtDateTime(it.created_at)}</span>` : ''}
      </div>`;
    }
  });
  box.innerHTML = html;
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** 填充「年份」下拉，便于快速跳年（默认范围 1900–2099，与日期跳转弹窗、月份输入框保持一致；默认选中当前年） */
function fillYearOptions(sel, minYear, maxYear) {
  if (!sel) return;
  const now = new Date().getFullYear();
  const lo = Math.max(1900, minYear != null ? minYear : 1900);
  const hi = Math.min(2099, maxYear != null ? maxYear : 2099);
  const years = [];
  for (let yy = hi; yy >= lo; yy--) years.push(yy);
  sel.innerHTML = years.map(yy => `<option value="${yy}">${yy} 年</option>`).join('');
  sel.value = String(now);
}

/** 把「年份」下拉与月份输入框联动：选年份即改 month 输入框的年份部分并刷新；改月份也回写年份下拉 */
function bindYearSelect(yearSel, monthInput) {
  if (!yearSel || !monthInput) return;
  fillYearOptions(yearSel);
  const syncYear = () => {
    const y = (monthInput.value || currentMonth()).split('-')[0];
    if (y) yearSel.value = y;
  };
  syncYear();
  yearSel.addEventListener('change', () => {
    const mm = (monthInput.value || currentMonth()).split('-')[1] || '01';
    monthInput.value = `${yearSel.value}-${mm}`;
    monthInput.dispatchEvent(new Event('change'));
  });
  monthInput.addEventListener('change', syncYear);
}


/**
 * 全局日期范围约束：把所有原生 date / datetime-local 选择器收束到 1900–2099，
 * 与系统统一日期范围保持一致（避免选到历法改革前的 1582 缺口或更早/更晚的非法日期）。
 * 仅在没有显式 min/max 时补充默认值，不覆盖页面已有的特定约束。
 */
function applyDateRangeLimits() {
  const minD = '1900-01-01', maxD = '2099-12-31';
  document.querySelectorAll('input[type="date"]').forEach(i => {
    if (!i.min) i.min = minD;
    if (!i.max) i.max = maxD;
  });
  document.querySelectorAll('input[type="datetime-local"]').forEach(i => {
    if (!i.min) i.min = minD + 'T00:00';
    if (!i.max) i.max = maxD + 'T23:59';
  });
}

/**
 * 为活动/活动/周期日期时间字段在为空时填入合理默认值：开始=当前时刻，结束=+1 小时，周期日期=今天。
 * 这样原生 datetime-local / date 控件在打开表单时就不会显示难看的本地化空态占位符（「年/月/日 --:--」），
 * 同时仍保留原生选择器。维护字段由 loadMaint 管理，不在此默认填入。
 */
function applyDateTimeDefaults() {
  const now = new Date();
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const end = new Date(now.getTime() + 3600 * 1000);
  const setIfEmpty = (id, val) => {
    const e = document.getElementById(id);
    if (e && !e.value) e.value = val;
  };
  setIfEmpty('aStart', fmt(now));
  setIfEmpty('aEnd', fmt(end));
  setIfEmpty('sStart', fmt(now));
  setIfEmpty('sEnd', fmt(end));
  setIfEmpty('rStart', today);
  setIfEmpty('rEnd', today);
}
/* datetime-local/date/time 原生不支持 placeholder：将带 data-ph 的日期时间输入框
   包裹一层 .dt-wrap 并追加占位 span，空值（required:invalid）时显示占位文字，与文本输入框风格统一 */
function enhanceDateTimePlaceholders(root) {
  const ctx = root || document;
  ctx.querySelectorAll('input[type="datetime-local"], input[type="date"], input[type="time"]')
    .forEach(function (inp) {
      if (inp.closest('.dt-wrap')) return;
      const wrap = document.createElement('div');
      wrap.className = 'dt-wrap';
      inp.parentNode.insertBefore(wrap, inp);
      wrap.appendChild(inp);
      const ph = document.createElement('span');
      ph.className = 'dt-ph';
      ph.textContent = inp.getAttribute('data-ph') || '';
      wrap.appendChild(ph);
    });
}
function initDateHelpers() {
  applyDateRangeLimits();
  applyDateTimeDefaults();
  enhanceDateTimePlaceholders();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDateHelpers);
else initDateHelpers();

/* ---------------- 操作日志（数据流）翻译与格式化 ---------------- */
const EVENT_TEXT = {
  sign: '签到', checkin: '签到', supplement: '补签到', unsign: '取消签到',
  leave: '申请请假', leave_by_admin: '管理代请假', leave_approve: '准假', leave_reject: '驳回请假',
  makeup_request: '申请补签', makeup_approve: '通过补签', makeup_reject: '驳回补签',
  settings_update: '修改系统设置',
  activity_create: '发布活动', activity_delete: '删除活动', activity_bulk_delete: '批量删除活动',
  user_create: '新增用户', user_delete: '删除用户', user_bulk_delete: '批量删除用户',
  user_restore: '恢复用户', clear_password: '清除密码',
  login: '登录', logout: '登出', login_fail: '登录失败',
  login_remote: '异地登录', session_replace: '登录替换下线', session_kick: '下线设备',
  set_password: '设置密码', change_password: '修改密码', pwd_reset_request: '申请找回密码',
  email_code: '发送邮箱验证码', email_reset: '邮箱重置密码',
  device_mismatch: '设备不匹配', device_change: '更换设备',
  fence_create: '新建活动范围', fence_update: '修改活动范围', fence_delete: '删除活动范围',
  fence_bulk_update: '批量修改活动范围', fence_bulk_delete: '批量删除活动范围',
  activity_update: '修改活动',
  work_order_submit: '提交工单', work_order_approve: '批准工单', work_order_reject: '驳回工单',
  work_order_timeout: '工单超时', account_cancel: '注销账号', reactivate_request: '申请重启用账号',
  user_restore: '恢复账号', withdraw: '撤回操作', maintenance_switch: '维护模式切换',
  grant_perm: '授予权限', revoke_perm: '收回权限', privacy_update: '更新隐私告知',
  export_dataflow: '导出操作记录',
  // 其余动作补齐（此前数据流里显示为英文 key）
  scope_update: '修改管理范围', user_role_change: '变更账号身份',
  notify_pref_update: '修改提醒偏好', location_verify_switch: '切换定位核验',
  auto_cover_grant: '自动代管开通', auto_cover_revoke: '自动代管收回',
  auto_cover_switch: '切换自动代管开关', auto_cover_skipped: '自动代管未执行',
  auto_delegate: '自动委托管理权限', auto_delegate_revoke: '收回自动委托',
  appeal_auto_final: '申诉自动结案',
  register_code: '发送注册验证码',
  feedback_submit: '向运维者提交反馈', feedback_handle: '处理运维者反馈',
  maintenance_schedule_expired: '清理过期维护排期',
  // 历史遗留动作（旧库记录，当前版本已不写入审计）
  notify_pref_self: '修改本人提醒偏好', setup_done: '完成首次设置',
  announcement_update: '发布公告',
  dataflow_mask: '切换数据流隐私打码', manager_location_view_switch: '切换查看学生定位开关',
  maintenance_block: '维护期间非法操作（已拦截并留痕）',
  maintenance_enter: '进入维护模式', maintenance_exit: '结束维护模式',
  perm_grant: '授予权限', perm_revoke: '收回权限',
  leave_request: '提交请假申请', appeal_retry: '重新提交申诉',
  backup_create: '创建内部备份', backup_restore: '还原备份',
  backup_delete: '删除备份', backup_settings: '备份设置',
  system_reset: '清空并恢复默认', email_update: '更新找回邮箱',
  activity_destination: '设置活动目的地',
  user_update: '修改账号信息', activity_update: '修改活动',
  perm_grant_batch: '批量授予权限',
  // 通知类型（站内消息 / 系统消息）
  NT_REMINDER_60: '签到倒计时（60 分钟）', NT_REMINDER_30: '签到倒计时（30 分钟）',
  NT_REMINDER_10: '签到倒计时（10 分钟）', NT_REMINDER_5: '签到倒计时（5 分钟）',
  NT_CHECKIN_START: '签到开始提醒', NT_ACT_START: '活动开始提醒',
  NT_ACT_CREATE: '新活动提醒', NT_NOT_CHECKED: '缺勤提醒',
  NT_WO_REPLY: '工单 / 审核回复', NT_SYS_MSG: '系统消息', NT_RECEIPT: '审核回执',
  /* 邮件类型：中文名与服务端邮件类型总表 server/mailtypes.js 保持一致
     （新增邮件类型时，服务端登记后同步在这里补一行） */
  mail: '邮件',
  MAIL_PW_RESET: '密码重置验证码', MAIL_PW_CHANGED: '密码变更安全提醒', MAIL_LOGIN_REMOTE: '异地登录提醒',
  MAIL_ACT_CREATE: '新活动发布', MAIL_REMINDER: '签到倒计时提醒', MAIL_CHECKIN_START: '签到开放提醒',
  MAIL_ACT_START: '活动开始提醒', MAIL_NOT_CHECKED: '缺勤提醒',
  MAIL_LEAVE_RESULT: '请假审核结果', MAIL_MAKEUP_RESULT: '补签审核结果',
  MAIL_APPEAL_SUBMITTED: '申诉待审核', MAIL_APPEAL_REPLY: '申诉沟通回复',
  MAIL_WO_SUBMITTED: '新工单待审批', MAIL_WO_APPROVED: '工单已批准', MAIL_WO_REJECTED: '工单已驳回',
  MAIL_WO_TIMEOUT: '工单超时驳回', MAIL_WO_REMINDER: '工单待办催办', MAIL_GRANT_NOTICE: '权限授予通知',
  MAIL_MAINTENANCE_PRE: '维护预告', MAIL_MAINTENANCE_POST: '维护结束',
  MAIL_SESSION_KILLED: '会话被强制结束', MAIL_PRIVACY_UPDATE: '隐私告知变更',
  MAIL_ANNOUNCEMENT: '系统公告', MAIL_ACCOUNT_NOTICE: '账号 / 角色变更',
  MAIL_OPS_ALERT: '运维告警', MAIL_FEEDBACK: '网站问题反馈',
  MAIL_RECEIPT: '操作回执'
};
const EVENT_CAT = {
  sign: 'ok', checkin: 'ok', supplement: 'ok', unsign: 'warn',
  leave: 'info', leave_by_admin: 'info', leave_approve: 'ok', leave_reject: 'warn',
  makeup_request: 'info', makeup_approve: 'ok', makeup_reject: 'warn', settings_update: 'auth',
  activity_create: 'act', activity_delete: 'act', activity_bulk_delete: 'act',
  user_create: 'usr', user_delete: 'usr', user_bulk_delete: 'usr', user_restore: 'usr', clear_password: 'usr',
  login: 'auth', logout: 'auth', login_fail: 'warn', login_remote: 'warn',
  session_replace: 'auth', session_kick: 'auth',
  set_password: 'auth', change_password: 'auth', pwd_reset_request: 'auth',
  email_code: 'auth', email_reset: 'usr', device_mismatch: 'warn', device_change: 'auth',
  // 自动代管 / 自动委托 / 反馈 / 首次设置等（此前未分类，统一给「信息 / 警示」配色）
  auto_cover_grant: 'info', auto_cover_revoke: 'warn', auto_cover_switch: 'auth', auto_cover_skipped: 'warn',
  auto_delegate: 'info', auto_delegate_revoke: 'warn',
  appeal_auto_final: 'info', register_code: 'auth',
  notify_pref_update: 'auth', notify_pref_self: 'auth', setup_done: 'auth',
  feedback_submit: 'info', feedback_handle: 'ok', maintenance_schedule_expired: 'auth',
  maintenance_block: 'warn', dataflow_mask: 'auth', withdraw: 'warn'
};
function eventTypeText(t) {
  const s = String(t == null ? '' : t);
  if (EVENT_TEXT[s]) return EVENT_TEXT[s];
  // 未列举的类型：按前缀给出可读中文，绝不回退英文 key（避免数据流出现 NT_RECEIPT 等原始码）
  if (s.startsWith('NT_REMINDER_')) return '活动开始前提醒';
  if (s.startsWith('NT_')) return '站内通知';
  if (s.startsWith('MAIL_')) return '系统邮件';
  return '其他操作';
}
function eventCat(t) { return EVENT_CAT[t] || 'def'; }

/**
 * 「类型」标签安全取值：服务端若回退成英文原始码（旧版本服务进程 / 未登记的动作，
 * 如 auto_delegate、NT_WO_REPLY），一律按类型码重新翻成中文，避免页面上出现英文标签。
 * 中文文本（含空格、括号、箭头等）原样返回。
 */
function safeTypeText(text, type) {
  const t = String(text == null ? '' : text);
  const pick = (code) => {
    const v = eventTypeText(code);
    return (v === '其他操作' && code !== type) ? eventTypeText(type) : v;
  };
  if (!t) return pick(type);
  if (/^[A-Za-z][A-Za-z0-9_.-]*$/.test(t)) return pick(t);
  return t;
}

/**
 * 数据流「操作记录详情」表格：用户端 / 管理端 / 运维端 / 数据流页共用同一份实现，
 * 保证四处的字段、顺序与样式完全一致（键名列 96px、内容自动换行、底色随主题）。
 * 传入的 it 可以是 dataflow 详情（字段全），也可以是 /api/stream 的事件（无分类 / 渠道 / 打码），
 * 缺字段的行自动省略，避免出现「分类：—」这类空行。
 */
function streamDetailHtml(it) {
  it = it || {};
  const CH = { inbox: '仅站内', email: '仅邮件', both: '站内 + 邮件', none: '—' };
  const row = (k, v) => `<tr><td class="muted" style="width:96px;white-space:nowrap">${k}</td><td style="word-break:break-word">${v}</td></tr>`;
  const cat = it.category_text || it.category || '';
  const act = safeTypeText(it.action_text != null ? it.action_text : it.type_text, it.action != null ? it.action : it.type);
  const ch = it.channel != null && it.channel !== '' ? (CH[it.channel] || '—') : '';
  const rows = [row('时间', fmtDateTimeMs(it.created_at))];
  if (cat) rows.push(row('分类', escapeHtml(cat)));
  rows.push(row('动作', escapeHtml(act)));
  rows.push(row('操作者', escapeHtml(it.actor_name || '系统')));
  rows.push(row('目标', escapeHtml(it.target || it.target_name || '—')));
  rows.push(row('内容', escapeHtml(it.text || it.detail || '—')));
  if (ch) rows.push(row('投递渠道', ch));
  if (it.masked != null) rows.push(row('是否打码', it.masked ? '是（中间部分已打 *）' : '否'));
  if (it.withdrawn) rows.push(row('状态', '已撤回'));
  return `<table class="table" style="width:100%;margin-top:6px;background:var(--surface-2)">${rows.join('')}</table>`;
}

function eventContent(e) {
  let d = e.detail || '';
  if (d) {
    d = String(d)
      .replace(/\bsigned\b/g, '已签到').replace(/\bontheway\b/g, '在途中')
      .replace(/\babsent\b/g, '缺勤').replace(/\bleave\b/g, '请假')
      .replace(/\bcancelled\b/g, '已退签').replace(/\bpending\b/g, '待处理');
  }
  return d || eventTypeText(e.type);
}

function eventIdentity(e) {
  if (!e.actor_kind) return { text: '系统', cls: 'sys' };
  if (e.actor_kind === 'ops') return { text: '运维者', cls: 'ops' };
  if (e.actor_kind === 'manager') return { text: e.actor_role || '管理端', cls: 'mgr' };
  if (e.actor_kind === 'normal') return { text: '普通学生', cls: 'stu' };
  return { text: e.actor_role || '用户', cls: 'def' };
}

/* ===================== 维护模式守卫 =====================
 * 维护中：除运维者外全站显示不可操作的遮罩，并展示起止时间；
 * 关闭前：已排期且临近开始时弹出预告；
 * 结束后：自动隐藏遮罩（会话未被销毁，原在线账号自动恢复）。
 * 注意：服务端同样拦截非运维者的接口，故 F12 删除遮罩也无法继续操作。
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  let overlay = null;
  let isOps = false;
  let authed = false;
  let info = { enabled: false, start_at: null, end_at: null, notice: '' };
  let preNoticed = false;
  const subs = [];

  function fmt(ts) { return ts ? new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false }) : '待定'; }

  /** 登录页：维护中也要放行（否则登出后会被遮罩重新盖住，永远退不出去） */
  function isLoginPage() { return /login\.html$/.test(location.pathname); }

  /**
   * 「是否应显示维护遮罩」的唯一判定（check / show / 防删除重建 三处共用）：
   *  - 注册 / 找回密码页（window.__maintLockPage）：维护期一律锁页（含运维者，避免误入）；
   *  - 登录页：始终放行。维护中必须能登录（运维者才能进来关闭维护）、登出后必须能回到登录页；
   *  - 其余页面：仅「已登录的非运维者」才显示（运维者可结束维护；未登录访客交回登录页）。
   */
  function shouldShowOverlay() {
    if (!info || !info.enabled) return false;
    if (window.__maintLockPage) return true;
    if (isLoginPage()) return false;
    return authed && !isOps;
  }

  function ensureOverlay() {
    if (overlay && document.body.contains(overlay)) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'maintenanceOverlay';
    overlay.className = 'maintenance-overlay';
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';
    return overlay;
  }

  function showOverlay(i, force) {
    if (isOps && !force) return;
    const o = ensureOverlay();
    const startTxt = (i && i.start_at) ? fmt(i.start_at) : '立即开启（进行中）';
    const endTxt = (i && i.end_at) ? fmt(i.end_at) : '待定';
    const notice = (i && i.notice) ? escapeHtml(i.notice) : '';
    o.innerHTML =
      '<div class="maintenance-card">'
      + '<div class="maintenance-spin" aria-hidden="true"></div>'
      + '<h2 class="maintenance-title">系统维护中</h2>'
      + '<p class="maintenance-sub">系统正在更新维护。维护期间仅运维者可操作，其他用户将暂时无法使用；维护结束后自动恢复。</p>'
      + '<div class="maintenance-meta">'
      +   '<div class="m-item"><span class="m-label">开始时间</span><span class="m-value">' + escapeHtml(String(startTxt)) + '</span></div>'
      +   '<div class="m-item"><span class="m-label">预计结束</span><span class="m-value">' + escapeHtml(String(endTxt)) + '</span></div>'
      + '</div>'
      + (notice ? '<p class="maintenance-note">维护说明：' + notice + '</p>' : '')
      + '<button id="maintLogoutBtn" class="btn primary maintenance-logout" type="button">退出登录</button>'
      + '<p class="maintenance-foot">维护结束后会自动恢复，无需重新登录。</p>'
      + '</div>';
    const btn = o.querySelector('#maintLogoutBtn');
    if (btn) btn.addEventListener('click', async () => {
      // api.logout() 内部已完成：清本地登录标记 → 撤下遮罩 → 跳转登录页。
      // 此处不可再 location.reload()：它会覆盖上面的跳转、把「当前页（锁页 / 业务页）」重新加载，
      // 表现为点了退出登录仍在维护遮罩里、退不出去。
      try { await api.logout(); } catch (e) { location.replace(url('login.html')); }
    });
  }

  function hideOverlay() {
    if (overlay) { overlay.remove(); overlay = null; }
    document.documentElement.style.overflow = '';
  }

  /** 通知订阅者维护状态变化（供注册页禁用注册按钮等） */
  function notifySubs() { subs.forEach(cb => { try { cb(info); } catch (e) { /* 忽略 */ } }); }

  // 防止通过 F12 删除遮罩：监听 body 子节点，遮罩被移除则立即重建（后端仍会拦截一切非法操作）
  let _maintObs = null;
  function ensureOverlayPresent() {
    // 与 check / show 共用同一个判定，避免出现「该没有的地方被重建出遮罩」（如登出后的登录页）
    if (!shouldShowOverlay()) return;
    if (!overlay || !document.body.contains(overlay)) showOverlay(info, !!window.__maintLockPage);
  }
  function watchOverlay() {
    if (_maintObs || !document.body) return;
    _maintObs = new MutationObserver(ensureOverlayPresent);
    _maintObs.observe(document.body, { childList: true });
  }

  function preNotice(i) {
    if (isOps || preNoticed) return;
    const lead = Number(i.start_at) - Date.now();
    if (!i.start_at || lead <= 0 || lead > 10 * 60 * 1000) return;   // 仅开始前 10 分钟内预告
    preNoticed = true;
    const mins = Math.max(1, Math.round(lead / 60000));
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.setAttribute('data-modal-kind', 'cancel');
    mask.innerHTML = '<div class="modal"><h3>系统维护预告</h3>'
      + '<p>系统将于约 ' + mins + ' 分钟后（' + fmt(i.start_at) + '）进入维护，'
      + '届时除运维端外的在线账号将暂时下线，预计 ' + fmt(i.end_at) + ' 结束。</p>'
      + '<div class="row end"><button class="btn primary" data-ok type="button">知道了</button></div></div>';
    document.body.appendChild(mask);
    mask.querySelector('[data-ok]').addEventListener('click', () => mask.remove());
  }

  async function check() {
    let authedNow = false, dev = false;
    try {
      // no-store：会话状态必须实时读取，绝不能命中浏览器缓存
      // （否则刚登出仍被判为「已登录」，遮罩会重新盖回来）
      const me = await fetch(url('api/auth/me'), { credentials: 'same-origin', cache: 'no-store' });
      if (me.ok) { const d = await me.json(); authedNow = !!(d.user); dev = !!(d.user && d.user.role === 'ops'); }
    } catch (e) { /* 忽略 */ }
    isOps = dev;
    authed = authedNow;
    try {
      const r = await fetch(url('api/settings/public'), { credentials: 'same-origin', cache: 'no-store' });
      const d = await r.json();
      info = d.maintenance || { enabled: !!d.maintenance_enabled, start_at: null, end_at: null, notice: '' };
      if (!info.enabled) { hideOverlay(); preNotice(info); notifySubs(); return; }
      notifySubs();
      if (shouldShowOverlay()) showOverlay(info, !!window.__maintLockPage);
      else hideOverlay();
    } catch (e) { /* 忽略 */ }
  }

  window.MaintenanceGuard = {
    check,
    show(i) {
      info = Object.assign({}, info, i || {});
      notifySubs();
      if (shouldShowOverlay()) showOverlay(info, !!window.__maintLockPage);
      else hideOverlay();
    },
    // 主动登出 / 切换账号：立即视为「未登录」，避免遮罩被上面的「防 F12 删除」监听重建
    hide() { authed = false; hideOverlay(); },
    state() { return info; },
    subscribe(cb) { if (typeof cb === 'function') { subs.push(cb); try { cb(info); } catch (e) { /* 忽略 */ } } }
  };

  /** 是否处于维护中（供各页面按钮做「置灰但点击仍提示」的兜底判断） */
  window.maintOn = function () {
    const g = window.MaintenanceGuard && window.MaintenanceGuard.state();
    return !!(g && g.enabled);
  };

  setTimeout(check, 800);
  setInterval(check, 30000);
  watchOverlay();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
})();






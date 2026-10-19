'use strict';
const crypto = require('crypto');
const db = require('./db');

/* 会话在线判定窗口：超过该时长没有任何请求即视为「离线」（页面每隔一段时间会心跳续期） */
const STALE_MS = 30 * 60 * 1000;
/* 「实时在线」窗口：最近 2 分钟内有活动才算「在线」，否则为「离线」（已登录但闲置） */
const ONLINE_MS = 120 * 1000;

function newSid() { return crypto.randomBytes(24).toString('hex'); }

/** 由 UA 粗略判定设备类型：手机/平板 -> mobile，其余 -> desktop */
function deviceTypeFromUA(ua) {
  const s = String(ua || '');
  if (/iPad|Tablet|PlayBook|Silk|Android|Mobile|iPhone|iPod|Windows Phone/i.test(s)) return 'mobile';
  return 'desktop';
}

/** 生成设备友好名，如「Windows · Chrome」「Android · 浏览器」 */
function deviceLabel(ua) {
  const s = String(ua || '');
  const os =
    /Windows/i.test(s) ? 'Windows' :
    /iPhone/i.test(s) ? 'iPhone' :
    /iPad/i.test(s) ? 'iPad' :
    /Macintosh|Mac OS X/i.test(s) ? 'macOS' :
    /Android/i.test(s) ? 'Android' :
    /Linux/i.test(s) ? 'Linux' : '未知系统';
  const br =
    /Edg\//i.test(s) ? 'Edge' :
    /Chrome\//i.test(s) ? 'Chrome' :
    /Firefox\//i.test(s) ? 'Firefox' :
    /Safari\//i.test(s) ? 'Safari' : '浏览器';
  return `${os} · ${br}`;
}

/** 从请求中解析设备信息（优先使用前端上报，缺失时按 UA 兜底） */
function normalizeDevice(req) {
  const b = req.body || {};
  const ua = req.headers['user-agent'] || '';
  let type = String(b.device_type || '').toLowerCase();
  if (type !== 'mobile' && type !== 'desktop') type = deviceTypeFromUA(ua);
  const key = String(b.device_key || '').trim() ||
    ('UA-' + crypto.createHash('md5').update(ua).digest('hex').slice(0, 12));
  const name = String(b.device_name || '').trim() || deviceLabel(ua);
  return { device_type: type, device_key: key, device_name: name, ip: req.ip || '' };
}

function isOnline(row, now) {
  if (!row) return false;
  if (!row.online || row.ended_at) return false;
  if (row.suspended) return false;          // 维护中被挂起：视为不在线
  return (now - Number(row.last_seen || 0)) < STALE_MS;
}

/** 维护开始：挂起所有「非运维者」在线会话（不销毁会话，维护结束后可自动恢复上线） */
function suspendNonOps() {
  const info = db.prepare(`
    UPDATE sessions SET suspended = 1
    WHERE online = 1 AND suspended = 0 AND user_id NOT IN (
      SELECT id FROM users WHERE role = 'ops'
    )
  `).run();
  return info.changes;
}

/** 维护结束：恢复全部挂起会话（原在线账号自动重新上线） */
function resumeSuspended() {
  const info = db.prepare('UPDATE sessions SET suspended = 0 WHERE suspended = 1').run();
  return info.changes;
}

function suspendedCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE online = 1 AND suspended = 1').get().n;
}

function endSession(sid, reason) {
  db.prepare('UPDATE sessions SET online = 0, ended_at = ?, end_reason = ? WHERE id = ? AND online = 1')
    .run(Date.now(), reason || null, sid);
}

/** 结束某账号的所有在线会话（管理员操作账号 / 注销 / 强制下线时使用） */
function endUserSessions(userId, reason, exceptSid) {
  const now = Date.now();
  if (exceptSid) {
    db.prepare('UPDATE sessions SET online = 0, ended_at = ?, end_reason = ? WHERE user_id = ? AND online = 1 AND id <> ?')
      .run(now, reason || null, userId, exceptSid);
  } else {
    db.prepare('UPDATE sessions SET online = 0, ended_at = ?, end_reason = ? WHERE user_id = ? AND online = 1')
      .run(now, reason || null, userId);
  }
}

/**
 * 建立会话。约束：
 *  1) 同一账号同类设备（手机 / 电脑）只能在线一个，新登录会立即把旧的同类设备会话踹下线；
 *  2) 同一设备（同一浏览器）同一角色层级只能在线一个，新登录会踹掉该设备上同层级的旧会话。
 * 返回 { sid, replaced:[{id,reason}], device }，由调用方负责写 Cookie。
 */
function createSession(user, req) {
  const d = normalizeDevice(req);
  const now = Date.now();
  const replaced = [];
  const toEnd = new Map();

  // 规则 1：同账号同类设备
  db.prepare('SELECT id, last_seen, online, ended_at FROM sessions WHERE user_id = ? AND device_type = ?')
    .all(user.id, d.device_type)
    .forEach(r => {
      if (isOnline(r, now) && r.id) toEnd.set(r.id, '同一账号在其他同类设备登录');
    });

  // 规则 2：同设备同层级
  db.prepare('SELECT id, last_seen, online, ended_at FROM sessions WHERE device_key = ? AND role = ?')
    .all(d.device_key, user.role)
    .forEach(r => {
      if (isOnline(r, now) && r.id && !toEnd.has(r.id)) toEnd.set(r.id, '同一设备同层级账号切换');
    });

  toEnd.forEach((reason, sid) => {
    endSession(sid, reason);
    replaced.push({ id: sid, reason });
  });

  const sid = newSid();
  db.prepare(`INSERT INTO sessions
      (id, user_id, role, device_type, device_name, device_key, ip, online, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(sid, user.id, user.role, d.device_type, d.device_name, d.device_key, d.ip, now, now);

  return { sid, replaced, device: d };
}

function touch(sid) {
  db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ? AND online = 1').run(Date.now(), sid);
}

function getSession(sid) {
  if (!sid) return null;
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
}

/**
 * 当前用户的「登录设备」列表：按设备去重，每台设备只保留最新一次记录（当前 + 历史设备），
 * 而不是逐条登录记录。current 标记当前设备，online 表示该设备当前是否在线。
 */
function listUserSessions(userId, currentSid, currentDeviceKey) {
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen DESC LIMIT 300').all(userId);
  const byDevice = new Map();
  for (const r of rows) {
    const key = r.device_key || r.id;
    if (!byDevice.has(key)) byDevice.set(key, r);   // 已按 last_seen 倒序，每台设备只留最新
  }
  return Array.from(byDevice.values()).map(r => ({
    id: r.id,
    device_key: r.device_key || r.id,
    device_type: r.device_type,
    device_name: r.device_name,
    online: isOnline(r, now),
    current: (r.id === currentSid) || (!!currentDeviceKey && r.device_key === currentDeviceKey),
    created_at: r.created_at,
    last_seen: r.last_seen,
    ended_at: r.ended_at,
    end_reason: r.end_reason
  }));
}

/** 结束某台设备上的全部在线会话（下线该设备；可排除当前会话） */
function endDeviceSessions(userId, deviceKey, reason, exceptSid) {
  const now = Date.now();
  if (exceptSid) {
    db.prepare('UPDATE sessions SET online = 0, ended_at = ?, end_reason = ? WHERE user_id = ? AND device_key = ? AND online = 1 AND id <> ?')
      .run(now, reason || null, userId, deviceKey, exceptSid);
  } else {
    db.prepare('UPDATE sessions SET online = 0, ended_at = ?, end_reason = ? WHERE user_id = ? AND device_key = ? AND online = 1')
      .run(now, reason || null, userId, deviceKey);
  }
}

/** 某账号的在线状态（三态）：online 在线（2 分钟内活跃）/ offline 离线（已登录但 >2 分钟无操作）/ loggedout 下线（无有效会话） */
function onlineState(userId) {
  const rows = db.prepare('SELECT online, ended_at, suspended, last_seen FROM sessions WHERE user_id = ?').all(userId);
  const now = Date.now();
  let best = 'loggedout';
  for (const r of rows) {
    if (r.online && !r.ended_at && !r.suspended) {
      if (now - Number(r.last_seen || 0) < ONLINE_MS) return 'online';
      best = 'offline';
    }
  }
  return best;
}

module.exports = {
  STALE_MS, ONLINE_MS, newSid, normalizeDevice,
  createSession, endSession, endUserSessions, endDeviceSessions,
  touch, getSession, listUserSessions, isOnline, onlineState,
  suspendNonOps, resumeSuspended, suspendedCount
};

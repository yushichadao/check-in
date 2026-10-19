'use strict';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');
const S = require('./sessions');
const St = require('./settings');
const config = require('./config');
const { JWT_SECRET, TOKEN_TTL, IDENTITY_LEVEL, ROLE_LEVEL, ALL_PERMS, roleOfLevel, roleLevelFromTitle } = config;
const mask = require('./mask');

/**
 * 身份下拉 -> 角色等级（班委合并：原「班长 / 学委」统一为「班委」）
 *   普通学生 0 < 班委 1 < 小班主任 2 < 辅导员 3 < 运维者 9
 */
const IDENTITY_MAP = IDENTITY_LEVEL;
const IDENTITIES = Object.keys(IDENTITY_MAP);

/** 身份 -> 等级 */
function levelOf(identity) {
  const lv = IDENTITY_MAP[identity];
  return (lv === undefined || lv === null) ? null : lv;
}

/** 身份 -> 粗粒度 role（ops / manager / normal），保持与既有代码兼容 */
function roleOf(identity) {
  const lv = levelOf(identity);
  if (lv === null) return null;
  return roleOfLevel(lv);
}

function isStudentIdentity(identity) { return levelOf(identity) === ROLE_LEVEL.student; }

/** 用户对象 -> 是否普通学生（role_level === 0）。管理端权限只面向管理岗账号，禁止下放给普通学生 */
function isStudentUser(u) { return !!u && userLevel(u) === ROLE_LEVEL.student; }

/** 用户对象 -> 有效等级（历史账号无 role_level 时按 role 兜底） */
function userLevel(u) {
  if (!u) return 0;
  if (u.role_level !== null && u.role_level !== undefined) return Number(u.role_level) || 0;
  return config.roleLevelFromTitle(u.role, u.role_title);
}

/** bcrypt 代价因子：10 轮（约 60~100ms）。同步/异步实现共用，保证历史哈希可继续校验 */
const BCRYPT_ROUNDS = 10;

/**
 * 同步哈希：**仅用于极少触发的运维脚本 / 启动期**（如 tools/reset-ops-password.js）。
 * 登录、设密、改密等热路径必须使用 hashPasswordAsync，避免同步 CPU 计算阻塞事件循环。
 */
function hashPassword(plain) { return bcrypt.hashSync(plain, BCRYPT_ROUNDS); }

/**
 * 异步哈希：bcryptjs 的异步实现按 setImmediate 分片计算，不会长时间独占主线程，
 * 因此高并发设密 / 改密不会把同一进程内的其它请求拖慢（原 hashSync 是并发登录延迟的主因）。
 */
function hashPasswordAsync(plain) { return bcrypt.hash(String(plain), BCRYPT_ROUNDS); }

/**
 * 校验用户设置的密码强度。
 * 规则：至少 6 位，且必须同时包含字母和数字。
 * 返回 null 表示通过；否则返回错误提示字符串。
 */
function validatePassword(plain) {
  if (!plain) return '请设置密码';
  const s = String(plain);
  if (s.length < 6) return '密码至少 6 位';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return '密码必须同时包含字母和数字';
  return null;
}

function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  try { return bcrypt.compareSync(plain, hash); } catch (e) { return false; }
}

/**
 * 异步校验：登录热路径使用。bcryptjs 异步实现按 setImmediate 分片，
 * 120 并发登录时不再串行阻塞事件循环；任何异常一律降级为 false（不抛错）。
 */
function verifyPasswordAsync(plain, hash) {
  if (!plain || !hash) return Promise.resolve(false);
  return Promise.resolve(bcrypt.compare(String(plain), String(hash))).then(v => !!v, () => false);
}

function signToken(user, sid) {
  return jwt.sign({ uid: user.id, role: user.role, sid },
    JWT_SECRET, { expiresIn: TOKEN_TTL });
}

/**
 * 建立会话：
 *  - 同一账号最多同时在线两台设备（一台手机 + 一台电脑），新的同类设备登录会立即踹掉旧的；
 *  - 同一设备（同一浏览器）同一角色层级只保留一个在线会话，切换同层级账号会踹掉旧的。
 * 同一姓名但不同身份是不同账号，可各自独立登录、互不影响。
 * 返回 { sid, replaced:[{id,reason}], device }。
 */
function establishSession(res, user, req) {
  const result = S.createSession(user, req);
  setAuthCookie(res, signToken(user, result.sid), req);
  return result;
}

/** 从请求 Cookie 中取出当前会话 ID（不做有效性校验） */
function sidFromReq(req) {
  try {
    const token = req.cookies && req.cookies.token;
    if (!token) return null;
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.sid || null;
  } catch (e) { return null; }
}

function setAuthCookie(res, token, req) {
  const maxAge = 2 * 60 * 60 * 1000;
  // Secure 仅在「连接本身是 TLS」时设置：本地 http://localhost 调试时不加 Secure，
  // 否则浏览器会丢弃该 cookie（Secure 标记禁止在非 https 下发送），导致每次请求都无会话、反复登出。
  const secure = config.COOKIE_SECURE && !!(req && req.secure);
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge
  });
}

function clearAuthCookie(res) { res.clearCookie('token'); }

function currentUser(req) {
  try {
    const token = req.cookies && req.cookies.token;
    if (!token) return null;
    const payload = jwt.verify(token, JWT_SECRET);
    const sess = S.getSession(payload.sid);
    // 会话不存在 / 已下线 / 被替换 / 被管理员强制下线
    if (!sess || !sess.online || sess.ended_at) return null;
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!u || u.disabled) return null;
    if (sess.user_id !== u.id) return null;
    S.touch(payload.sid);       // 心跳续期：更新最近活动时间
    req.session = sess;
    req.sid = payload.sid;
    return u;
  } catch (e) {
    return null;
  }
}

function authRequired(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = user;
  req.userLevel = userLevel(user);
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录或登录已过期' });
    // 运维者为超级管理号：可满足任何角色门槛（普通学生专属接口也由其兜底，属预期内的超管能力）
    if (req.user.role === 'ops') return next();
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: '当前身份无此权限' });
    next();
  };
}

/** 要求最低角色等级 */
function requireMinLevel(level) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录或登录已过期' });
    if (userLevel(req.user) < level) {
      return res.status(403).json({ error: '当前身份层级不足，无此权限' });
    }
    next();
  };
}

/* ===================== 权限判定（双轨：角色基线 + 额外授予） ===================== */

/** 是否存在一条有效的额外授予（未撤回、未过期） */
function hasGrant(userId, code) {
  return !!db.prepare(`
    SELECT 1 FROM permission_grants
    WHERE user_id = ? AND perm_code = ? AND revoked = 0
      AND (expires_at IS NULL OR expires_at > ?)
    LIMIT 1
  `).get(userId, code, Date.now());
}

/**
 * 是否持有某权限：
 *  - denied 类型一律拒绝（如 VIEW_COORD 永不暴露原始坐标）；
 *  - 角色基线（role_level >= min）天然持有，不可撤回；
 *  - 其余靠 permission_grants（AUTH_GRANT 下放 / 工单审批）。
 */
function hasPerm(user, code) {
  if (!user || !code) return false;
  const p = ALL_PERMS[code];
  if (!p) return false;
  if (p.type === 'denied') return false;
  const lv = userLevel(user);
  if (typeof p.min === 'number' && lv >= p.min) return true;
  return hasGrant(user.id, code);
}

/** 权限中间件：未持有即 403（前端据此灰度/拦截） */
function requirePerm(code) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录或登录已过期' });
    if (!hasPerm(req.user, code)) {
      const p = ALL_PERMS[code] || {};
      return res.status(403).json({
        error: `无「${p.name || code}」权限；如需使用请提交权限工单，由上级审批后开通`,
        perm: code,
        need_order: true
      });
    }
    next();
  };
}

/* ===================== 账号管理范围 Scope ===================== */

/** 运维者为通配全局 */
function isWildcard(user) { return !!user && user.role === 'ops'; }

/**
 * 账号管理范围：**系统按层级自动授权**（不再手工绑定）。
 *  - 运维者：通配全局（全部非运维者账号）；
 *  - 其他管理员：可管理「层级严格低于自己」的非运维者账号。
 */
function scopeIds(adminId) {
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId);
  if (!admin) return [];
  if (isWildcard(admin)) {
    return db.prepare("SELECT id FROM users WHERE role <> 'ops'").all().map(r => r.id);
  }
  return db.prepare("SELECT id FROM users WHERE role <> 'ops' AND role_level < ?")
    .all(userLevel(admin)).map(r => r.id);
}

function inScope(adminId, userId) {
  if (!adminId || !userId) return false;
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!admin || !target) return false;
  if (userLevel(target) >= ROLE_LEVEL.ops) return false;   // 运维者账号不在任何人的范围内
  if (isWildcard(admin)) return true;
  return userLevel(admin) > userLevel(target);
}

/** 绑定 / 解绑 scope（运维端「管理范围」编辑器用） */
function setScope(adminId, userIds) {
  const ids = (userIds || []).filter(Boolean);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM account_scopes WHERE admin_id = ?').run(adminId);
    const ins = db.prepare('INSERT OR IGNORE INTO account_scopes (admin_id, user_id, created_at) VALUES (?, ?, ?)');
    ids.forEach(uid => ins.run(adminId, uid, Date.now()));
  });
  tx();
}

/**
 * 统一判定：operator 是否能管理 target。
 * 条件：非本人 + target 非运维者 + operator 层级严格高于 target + target 在 operator 的 scope 内（运维者免检）。
 */
function canManage(operator, target) {
  if (!operator || !target) return false;
  if (target.id === operator.id) return false;
  if (userLevel(target) >= ROLE_LEVEL.ops) return false;
  if (userLevel(operator) <= userLevel(target)) return false;
  if (isWildcard(operator)) return true;
  return inScope(operator.id, target.id);
}

/** 列出某管理号可管理的账号（运维者为全部非运维者账号） */
function managedUsers(operator, extraWhere, params) {
  const w = extraWhere ? ` AND ${extraWhere}` : '';
  if (isWildcard(operator)) {
    return db.prepare(`SELECT * FROM users WHERE role <> 'ops'${w} ORDER BY role_level DESC, real_name`)
      .all(...(params || []));
  }
  // 非运维者：可管理「层级严格低于自己」的账号（系统自动授权）
  return db.prepare(`SELECT * FROM users WHERE role <> 'ops' AND role_level < ?${w} ORDER BY role_level DESC, real_name`)
    .all(userLevel(operator), ...(params || []));
}

/** 目标账号是否可被 operator 操作（用于路由内快速校验） */
function requireManage(getTargetId) {
  return (req, res, next) => {
    const targetId = typeof getTargetId === 'function' ? getTargetId(req) : getTargetId;
    if (!targetId) return res.status(400).json({ error: '缺少目标账号' });
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: '账号不存在' });
    if (!canManage(req.user, target)) {
      return res.status(403).json({ error: '该账号不在你的管理范围内，或你的层级不足' });
    }
    req.target = target;
    next();
  };
}

/* ===================== 定位核验门控 ===================== */

/** 定位核验是否可用：需同时持有 FENCE_VERIFY 权限 + location_verify_enabled 开关开启 */
function locationVerifyAllowed(user) {
  return hasPerm(user, 'FENCE_VERIFY') && St.getBool('location_verify_enabled');
}

/** 定位核验中间件（同时也用于「位置上传」接口的门控） */
function requireLocationVerify() {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录或登录已过期' });
    if (!hasPerm(req.user, 'FENCE_VERIFY')) {
      return res.status(403).json({
        error: '无「启动活动范围核验」权限；如需使用请提交权限工单',
        perm: 'FENCE_VERIFY', need_order: true
      });
    }
    if (!St.getBool('location_verify_enabled')) {
      return res.status(403).json({
        error: '定位核验总开关当前为关闭状态（需持有「启动活动范围核验」权限方可开启，缺辅导员时可由自动代管下放），位置上传与活动范围核验均已禁用',
        perm: 'FENCE_VERIFY', switch_off: true
      });
    }
    next();
  };
}

/** 前端权限态：一次性把当前用户持有的权限码列表算出，供页面做门禁 */
function permState(user) {
  const lv = userLevel(user);
  const held = {};
  Object.keys(ALL_PERMS).forEach(code => {
    held[code] = hasPerm(user, code);
  });
  // 自动代管摘要（懒加载避免与 autocover.js 形成循环依赖）：前端据此显示「自动代管中」徽标
  let autoCover = { covered: false };
  try { autoCover = require('./autocover').stateOf(user.id); } catch (e) { /* 忽略 */ }
  return {
    level: lv,
    identity: user.role_title,
    perms: held,
    location_verify_enabled: St.getBool('location_verify_enabled'),
    location_verify_allowed: locationVerifyAllowed(user),
    wildcard: isWildcard(user),
    auto_cover: autoCover
  };
}

/**
 * 前端可见的用户摘要。
 * 注意：不返回 id。账号标识（users.id）是不可见、不重复的锚点，
 * 仅运维者在运维者控制台可见，普通用户 / 管理端均不可见。
 * @param {object} u 用户行
 * @param {string} [viewerId] 查看者账号 id：给出且与本人不一致时，邮箱一律中间打码
 */
function publicUser(u, viewerId) {
  const email = u.email || '';
  const isOther = !!viewerId && String(viewerId) !== String(u.id);
  return {
    real_name: u.real_name,
    student_id: u.student_id,
    role: u.role,
    role_title: u.role_title,
    role_level: userLevel(u),
    must_change_pwd: !!u.must_change_pwd,
    must_setup: !!u.must_setup,
    // 清爽模式：默认开启；除显式 0（关闭）外一律视为开启
    clean_mode: u.clean_mode === 0 ? false : true,
    has_password: !!u.password_hash,
    device_bound: !!u.device_id,
    // 邮箱：只有本人能看到自己的完整地址，任何端看他人一律中间打码
    email: isOther ? mask.maskEmail(email) : email
  };
}

/** 返回相对页面名，前端会结合部署子路径跳转 */
function homeFor(user) {
  if (user.role === 'ops') return 'ops.html';
  if (user.role === 'manager') return 'manager.html';
  return 'user.html';
}

/* ---------------- 登录失败节流（内存态，防暴力破解） ---------------- */
const failMap = new Map();
const MAX_FAIL = 5;
const LOCK_MS = 30 * 1000;

function throttleKey(realName, identity) { return `${identity}::${realName}`; }

function throttleRemaining(key) {
  const rec = failMap.get(key);
  if (!rec || !rec.until) return 0;
  const left = rec.until - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function noteFailure(key) {
  const rec = failMap.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAIL) { rec.until = Date.now() + LOCK_MS; rec.count = 0; }
  failMap.set(key, rec);
}

function clearFailures(key) { failMap.delete(key); }

module.exports = {
  IDENTITY_MAP, IDENTITIES, roleOf, levelOf, isStudentIdentity, isStudentUser, userLevel,
  hashPassword, verifyPassword, validatePassword,
  hashPasswordAsync, verifyPasswordAsync, BCRYPT_ROUNDS,
  signToken, setAuthCookie, clearAuthCookie,
  establishSession, sidFromReq,
  currentUser, authRequired, requireRole, requireMinLevel,
  hasPerm, requirePerm, hasGrant,
  isWildcard, scopeIds, inScope, setScope, canManage, managedUsers, requireManage,
  locationVerifyAllowed, requireLocationVerify, permState,
  publicUser, homeFor,
  throttleKey, throttleRemaining, noteFailure, clearFailures
};

'use strict';
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const A = require('../auth');
const S = require('../sessions');
const St = require('../settings');
const mailer = require('../mailer');
const mask = require('../mask');
const { WO_TIMEOUT_HOURS, ROLE_LEVEL, isGroupNameConfigured } = require('../config');
const notify2 = require('../notify');
const { MAIL } = require('../mailtypes');
const { recordEvent } = require('../logger');

const router = express.Router();

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
// 异地登录提醒限频：同一 user_id + device_key 在 24 小时内只提醒一次，避免双设备切换频繁骚扰
const _remoteAlertCache = new Map();
const REMOTE_ALERT_COOLDOWN = 24 * 60 * 60 * 1000;
function shouldAlertRemote(userId, deviceKey) {
  const key = userId + ':' + (deviceKey || '');
  const last = _remoteAlertCache.get(key) || 0;
  if (Date.now() - last < REMOTE_ALERT_COOLDOWN) return false;
  _remoteAlertCache.set(key, Date.now());
  return true;
}
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 10 * 60 * 1000;   // 邮箱验证码有效期
const CODE_RESEND_MS = 60 * 1000;     // 重发间隔
const CODE_MAX_ATTEMPTS = 5;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const genCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/** 邮箱归一化（去空白 + 小写）：用于哈希比对，避免大小写 / 空格差异 */
const normEmail = (e) => String(e == null ? '' : e).trim().toLowerCase();
/** 归一化邮箱的哈希：email_codes 不再落明文邮箱，仅存哈希用于「填写的邮箱是否与下发一致」校验 */
const emailHash = (e) => sha256(normEmail(e));

/**
 * 校验「本次填写的邮箱」是否与验证码下发时的邮箱一致。
 * 新库：只存打码邮箱 + email_hash，用哈希比对；
 * 旧库（迁移前遗留、hash 为空）：回退到明文比较，保证平滑兼容。
 */
function emailMatchesRecord(rec, email) {
  if (!rec) return false;
  if (rec.email_hash) return rec.email_hash === emailHash(email);
  return normEmail(rec.email) === normEmail(email);
}

function findUser(name, identity, sid) {
  if (sid) {
    return db.prepare('SELECT * FROM users WHERE real_name = ? AND role_title = ? AND student_id = ?')
      .get(name, identity, sid);
  }
  return db.prepare('SELECT * FROM users WHERE real_name = ? AND role_title = ?').get(name, identity);
}

/**
 * 查找「已被预置但尚未激活（从未设置过密码）」的账号，供注册激活使用。
 * 注册不是自建账号：必须先在服务端被管理员 / 运维者预置，或由 seed 预置运维者账号。
 *
 * 学号判定与登录保持一致：只有「普通学生」按学号精确匹配，管理端 / 运维者账号一律忽略学号。
 * （此前非学生身份还额外要求 student_id 为空，导致历史库里被写入过学号的运维者 / 管理账号
 *   出现「能登录、却注册激活 404」的不一致，故去掉该条件。）
 */
function findUnactivated(name, identity, sid) {
  if (sid) {
    return db.prepare(
      'SELECT * FROM users WHERE real_name = ? AND role_title = ? AND student_id = ? AND password_hash IS NULL'
    ).get(name, identity, sid);
  }
  return db.prepare(
    'SELECT * FROM users WHERE real_name = ? AND role_title = ? AND password_hash IS NULL'
  ).get(name, identity);
}

/**
 * 注册激活失败的理由诊断：把笼统的 404 换成「可执行的下一步」。
 * 仅当「姓名 + 身份」确实命中账号时才给出明确理由——本人注册时本就知道自己的账号；
 * 未命中时一律保持模糊提示，避免向任意访客暴露账号是否存在（防枚举）。
 */
function explainUnactivated(name, identity, sid) {
  const u = findUser(name, identity, sid);
  if (!u || !u.password_hash) {
    return '未找到可激活的账号：请确认姓名 / 学号 / 身份与服务端预置的信息完全一致';
  }
  if (u.disabled || u.status === 'cancelled') {
    return '该账号已注销（隐藏），不能注册激活；请联系上一级管理员恢复账号后再设置密码';
  }
  return identity === '运维者'
    ? '该运维者账号已激活（已设置过密码），请直接登录；忘记密码请在服务器终端执行 npm run reset-ops'
    : '该账号已激活（已设置过密码），请直接登录；忘记密码请联系管理员「清除密码」后重新设置';
}

/* ------------------------------ 设备识别码（服务器签发） ------------------------------ */
/* 浏览器无法取 IMEI，但设备码必须可追溯、由各端统一从服务器获取，
 * 而不是各端各自用 Math.random / crypto.randomUUID 在本地生成（不可审计、前缀混乱）。
 * 客户端首次访问时调用本接口换取正式设备码并本地缓存，之后登录 / 签到载荷都带此服务器签发码。 */
router.get('/device-key', (req, res) => {
  const key = 'DV-' + crypto.randomBytes(12).toString('hex').toUpperCase();
  return ok(res, { device_key: key });
});

/* ------------------------------ 登录 ------------------------------ */
router.post('/login', async (req, res) => {
  const body = req.body || {};
  const name = String(body.real_name || '').trim();
  const sid = String(body.student_id || '').trim();
  const identity = body.identity;
  const password = body.password;

  if (!name) return bad(res, '请输入姓名');
  if (!A.IDENTITIES.includes(identity)) return bad(res, '请选择身份');
  if (!password) return bad(res, '请输入密码');
  if (A.isStudentIdentity(identity) && !sid) return bad(res, '普通学生请填写学号');

  const key = A.throttleKey(name, identity);
  const left = A.throttleRemaining(key);
  if (left > 0) return bad(res, `尝试过于频繁，请 ${left} 秒后再试`, 429);

  // 管理端 / 运维端账号忽略学号：填或不填都能登录（便于快速切换）
  const user = findUser(name, identity, A.isStudentIdentity(identity) ? sid : '');

  if (!user) {
    A.noteFailure(key);
    return bad(res, '姓名、学号、身份或密码不正确', 401);
  }
  // 系统「班级名称（GROUP_NAME）」未配置时，限制运维者登录（需先通过 npm run config 配置班级名称）
  if (user.role === 'ops' && !isGroupNameConfigured()) {
    return res.status(403).json({ error: '系统「班级名称（GROUP_NAME）」尚未设置，请运维者先通过 `npm run config` 配置后再登录', need_group_name: true });
  }
  if (user.disabled) {
    return res.status(403).json({
      error: '该账号已注销。如需恢复使用，请提交「重启用」工单，由上一级管理员审批后重新启用。',
      cancelled: true,
      real_name: user.real_name,
      identity: user.role_title,
      student_id: user.student_id
    });
  }
  if (!user.password_hash) {
    // 区分「新建账号尚未设密」与「密码已被管理员清除」（后者 must_change_pwd=1）
    const cleared = !!user.must_change_pwd;
    return res.status(409).json({
      error: cleared
        ? '该账号的密码已被管理员清除，请重新设置密码后登录'
        : '该账号尚未激活（还没有设置过密码），请先设置密码',
      need_set_password: true,
      cleared,
      identity: user.role_title,
      real_name: user.real_name,
      student_id: user.student_id
    });
  }
  // 异步校验：热路径不阻塞事件循环（bcryptjs 同步实现会让 120 并发登录排队串行，P95 达数秒）
  if (!(await A.verifyPasswordAsync(password, user.password_hash))) {
    A.noteFailure(key);
    recordEvent('login_fail', user.id, null, identity);
    return bad(res, '姓名、学号、身份或密码不正确', 401);
  }
  // 数据兜底：账号标识为空时建会话必然失败（曾表现为注册后 500 并被前端静默跳回登录页），
  // 这里给出明确可读的错误，而不是抛 500。
  if (!user.id) {
    return res.status(409).json({ error: '该账号的标识缺失（数据异常），请联系运维者修复后再登录' });
  }
  // 注册必须完成邮箱验证：未经验证的邮箱一律禁止登录
  if (!user.email_verified) {
    return res.status(403).json({
      error: '邮箱未验证，请先完成验证',
      need_verify: true,
      identity: user.role_title,
      real_name: user.real_name,
      student_id: user.student_id
    });
  }

  A.clearFailures(key);
  // 补齐 RBAC 等级（历史账号迁移）
  if (user.role_level === null || user.role_level === undefined) {
    const lv = A.userLevel(user);
    db.prepare('UPDATE users SET role_level = ? WHERE id = ?').run(lv, user.id);
    user.role_level = lv;
  }
  const ip = req.ip || '';
  const prev = db.prepare('SELECT id, device_key, ip, online FROM sessions WHERE user_id = ? AND online = 1 ORDER BY last_seen DESC LIMIT 1').get(user.id);
  const { replaced, device } = A.establishSession(res, user, req);
  // 「异地登录」以设备指纹为主、IP 为辅判定：
  // 同一设备（device_key 一致）即便更换网络（WiFi / 流量切换、反代多出口导致 IP 变化）也不算异地；
  // 只有设备指纹不同（或旧会话无指纹时 IP 不同）才判定为异地，避免同一设备被反复误报「异常登录」。
  // 补充：若当前设备曾登录过该账号（不限在线状态），视为已知设备，不算异地。
  // 这解决了同一人切换不同身份账号时，因目标账号在此设备无在线会话而被误判的问题。
  let remote = !!(prev && (
    (prev.device_key && device.device_key && prev.device_key !== device.device_key) ||
    (!prev.device_key && prev.ip && prev.ip !== ip)
  ));
  if (remote && device.device_key) {
    const knownDevice = db.prepare('SELECT 1 FROM sessions WHERE user_id = ? AND device_key = ? LIMIT 1').get(user.id, device.device_key);
    if (knownDevice) remote = false;
  }
  recordEvent('login', user.id, null, identity);
  if (remote) {
    recordEvent('login_remote', user.id, null, `${device.device_name}（异地登录）`);
    // 限频：同一用户+设备 24 小时内只发一次站内+邮件提醒
    if (shouldAlertRemote(user.id, device.device_key)) {
      notify2.notifyLoginRemote(user, { device: device.device_name, ip }).catch(() => {});
    }
  }




  if (replaced.length) {
    recordEvent('session_replace', user.id, null, device.device_name);
  }
  return res.json({
    ok: true,
    user: A.publicUser(user),
    redirect: A.homeFor(user),
    perm: A.permState(user)
  });
});

/* ---------------- 校验本机记住的账号是否仍存在（登录页自动剪枝用，公开） ----------------
 * 登录页的「同名多层级账号」快速切换列表来自浏览器 localStorage(checkin_accounts)，与服务端
 * 独立。库被清空 / 账号被删除后，这些本地记录不会自动消失。此接口接收本地记住的账号清单，
 * 仅按「姓名 + 身份」回传仍存在的账号，前端据此剔除已失效的本地记录（任何设备都会自愈）。
 * 仅确认本机已知的确切 (real_name, role_title) 对是否存在，不返回任何额外账号信息。 */
router.post('/check-accounts', (req, res) => {
  const list = Array.isArray(req.body && req.body.accounts) ? req.body.accounts : [];
  const existing = [];
  for (const a of list) {
    const name = String((a && a.real_name) || '').trim();
    const identity = a && a.identity;
    if (!name || !A.IDENTITIES.includes(identity)) continue;
    const u = db.prepare('SELECT real_name, role_title FROM users WHERE real_name = ? AND role_title = ?')
      .get(name, identity);
    if (u) existing.push({ real_name: u.real_name, identity: u.role_title });
  }
  return ok(res, { existing });
});

/* ------------------------------ 登出 ------------------------------ */
router.post('/logout', (req, res) => {
  const sid = A.sidFromReq(req);
  const user = A.currentUser(req);
  A.clearAuthCookie(res);
  if (sid) S.endSession(sid, '主动登出');
  if (user) recordEvent('logout', user.id, null, null);
  return ok(res);
});

/* --------------------------- 会话心跳（保持在线状态） --------------------------- */
router.get('/ping', A.authRequired, (req, res) => ok(res));

/* ---------------- 隐私政策（公开：注册页阅读后才能注册） ---------------- */
router.get('/privacy', (req, res) => ok(res, {
  text: St.privacyTextOrDefault(),
  updated_at: St.get('privacy_updated_at') || null
}));

/* --------------------------- 账号注销（仅隐藏，服务器保留信息） --------------------------- */
router.post('/account/cancel', A.authRequired, async (req, res) => {
  const user = req.user;
  if (user.role === 'ops') {
    return bad(res, '运维者账号不可注销，以防止系统无法进入', 403);
  }
  const { password } = req.body || {};
  if (!password) return bad(res, '请输入登录密码以确认注销', 400);
  if (!(await A.verifyPasswordAsync(password, user.password_hash))) return bad(res, '密码不正确', 403);
  db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(user.id);
  S.endUserSessions(user.id, '账号已注销');
  A.clearAuthCookie(res);
  recordEvent('account_cancel', user.id, null, null);
  // 本人注销后该账号不再「在岗」→ 可能重新出现层级缺口，重算自动代管
  require('../autocover').safeSync('account_change');
  return ok(res, { message: '账号已注销（隐藏处理），服务器仍保留你的信息。如需恢复，请联系上一级管理员' });
});

/* --------------------------- 当前登录者（含权限态） --------------------------- */
router.get('/me', (req, res) => {
  const user = A.currentUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  return res.json({
    ok: true,
    user: A.publicUser(user),
    redirect: A.homeFor(user),
    perm: A.permState(user),
    identities: A.IDENTITIES,
    // 定位上传授权：本人自愿（null=未选择 / 0=不授权 / 1=授权）
    loc_consent: user.loc_consent === 1 ? 1 : (user.loc_consent === 0 ? 0 : null),
    // 清爽模式：默认开启（1）；前端据此切 body.clean-mode 类
    clean_mode: user.clean_mode === 0 ? 0 : 1
  });
});

/* ---------------- 定位上传授权：本人自愿开启 / 取消 ----------------
 * 该授权状态属用户个人隐私：仅落库，【不写数据流】、不做任何事件留痕。
 * 不授权同样可以正常签到，只是不采集 / 不上传位置。
 */
router.post('/me/loc-consent', A.authRequired, (req, res) => {
  const v = (req.body || {}).consent;
  const val = (v === true || v === 1 || v === '1') ? 1 : 0;
  db.prepare('UPDATE users SET loc_consent = ? WHERE id = ?').run(val, req.user.id);
  return ok(res, { consent: val });
});

/* ---------------- 清爽模式：本人自愿开启 / 关闭 ----------------
 * 仅影响用户端 UI 信息密度（隐藏非必要说明 / 冗余按钮 / 被禁用功能入口），
 * 属个人偏好：仅落库，不写数据流审计。
 */
router.post('/me/clean-mode', A.authRequired, (req, res) => {
  const v = (req.body || {}).clean_mode;
  const val = (v === false || v === 0 || v === '0') ? 0 : 1;
  db.prepare('UPDATE users SET clean_mode = ? WHERE id = ?').run(val, req.user.id);
  return ok(res, { clean_mode: val });
});

/* ---------------- 首次设置完成（注册后必须完成才能进入系统） ----------------
 * 账号一旦完成注册设密（含清密重设、重启用重设）即带 must_setup=1，业务接口全部被服务端拦成
 * 403 need_setup，直到这里被清除；管理员「恢复/重启用」等不涉及重新注册的路径不强制。
 * 可附带保存通知偏好（与「个人信息 → 通知偏好」同一套接口）；无论是否带 prefs，都会清除 must_setup。
 */
router.post('/me/complete-setup', A.authRequired, (req, res) => {
  const body = req.body || {};
  if (body.prefs && typeof body.prefs === 'object') {
    Object.keys(body.prefs).forEach(k => { St.setUserNotifyPref(req.user.id, k, body.prefs[k]); });
  }
  // 清爽模式：首次设置页的默认勾选项，随首次设置一并落库（默认开启）
  if (body.clean_mode !== undefined && body.clean_mode !== null) {
    const cm = (body.clean_mode === true || body.clean_mode === 1 || body.clean_mode === '1') ? 1 : 0;
    db.prepare('UPDATE users SET clean_mode = ? WHERE id = ?').run(cm, req.user.id);
  }
  db.prepare('UPDATE users SET must_setup = 0 WHERE id = ?').run(req.user.id);
  // 注：完成首次设置是用户自身行为，不写入数据流审计（与 notify_pref_self 同属隐私）
  return ok(res, { message: '首次设置已完成', redirect: A.homeFor(req.user), user: A.publicUser(req.user) });
});

/* ---------------- 本人资料：姓名 / 学号 / 身份 均为只读，仅由上级在管理端修改 ---------------- */
router.post('/me', A.authRequired, (req, res) => {
  const user = req.user;
  // 本人不可修改核心资料；如需变更（如身份调整），请联系上一级管理员
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  return ok(res, { user: A.publicUser(updated), message: '个人资料（姓名 / 学号 / 身份）不可自行修改' });
});

/* ---------------- 注册激活：向填写的邮箱下发验证码 ----------------
 * 注册必须先完成邮箱验证（未验证禁止登录）。验证码复用 email_codes 表与找回密码同一套
 * 生成 / 校验规则（10 分钟有效、最多 5 次尝试、60 秒重发限制），只存哈希不存明文。
 */
router.post('/register-code', async (req, res) => {
  const body = req.body || {};
  const name = String(body.real_name || '').trim();
  const sid = String(body.student_id || '').trim();
  const identity = body.identity;
  const email = String(body.email || '').trim();

  if (!name) return bad(res, '请输入姓名');
  if (!A.IDENTITIES.includes(identity)) return bad(res, '请选择身份');
  if (A.isStudentIdentity(identity) && !sid) return bad(res, '普通学生请填写学号');
  if (!email) return bad(res, '请输入邮箱');
  if (!EMAIL_RE.test(email)) return bad(res, '邮箱格式不正确');

  // 只给「已预置但未激活」的账号发码；已激活账号修改邮箱走 /api/auth/email
  const user = findUnactivated(name, identity, A.isStudentIdentity(identity) ? sid : '');
  if (!user) {
    return bad(res, explainUnactivated(name, identity, A.isStudentIdentity(identity) ? sid : ''), 404);
  }
  if (!mailer.isConfigured() || !isGroupNameConfigured()) {
    return bad(res, '邮件服务未配置，或系统「班级名称（GROUP_NAME）」尚未设置（请运维者通过 npm run config 配置），暂时无法完成邮箱验证', 503);
  }

  const now = Date.now();
  const last = db.prepare('SELECT * FROM email_codes WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id);
  if (last && now - last.created_at < CODE_RESEND_MS) {
    const wait = Math.ceil((CODE_RESEND_MS - (now - last.created_at)) / 1000);
    return bad(res, `验证码发送过于频繁，请 ${wait} 秒后再试`, 429);
  }

  const code = genCode();
  db.prepare('UPDATE email_codes SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);
  // 隐私：邮箱只存打码值 + 归一化哈希，不落明文（明文仅存在于本次请求与邮件投递中）
  db.prepare(`INSERT INTO email_codes (user_id, email, email_hash, code_hash, attempts, used, created_at, expires_at)
              VALUES (?, ?, ?, ?, 0, 0, ?, ?)`)
    .run(user.id, mask.maskEmail(email), emailHash(email), sha256(code), now, now + CODE_TTL_MS);

  try {
    await mailer.sendCode(email, code, Math.round(CODE_TTL_MS / 60000), null, user.id, 'register');
  } catch (e) {
    return bad(res, '验证码发送失败：' + (e.message || '请稍后重试'), 500);
  }
  recordEvent('register_code', user.id, null, identity);
  return ok(res, { message: '验证码已发送至该邮箱，请查收（10 分钟内有效）' });
});

/* --------- 设置密码（首次注册激活 / 管理员清除密码后重设，共用） --------- */
router.post('/set-password', async (req, res) => {
  const body = req.body || {};
  const name = String(body.real_name || '').trim();
  const sid = String(body.student_id || '').trim();
  const identity = body.identity;
  const email = String(body.email || '').trim();
  const password = body.password;
  const confirm = body.confirm;

  if (!name) return bad(res, '请输入姓名');
  if (!A.IDENTITIES.includes(identity)) return bad(res, '请选择身份');
  if (A.isStudentIdentity(identity) && !sid) return bad(res, '普通学生请填写学号');
  if (!email) return bad(res, '请填写邮箱（用于找回密码与重要通知）');
  if (!EMAIL_RE.test(email)) return bad(res, '邮箱格式不正确');
  if (!password) return bad(res, '请设置密码');
  if (password !== confirm) return bad(res, '两次输入的密码不一致');
  const pwErr = A.validatePassword(password);
  if (pwErr) return bad(res, pwErr);

  const user = findUnactivated(name, identity, A.isStudentIdentity(identity) ? sid : '');
  if (!user) {
    return bad(res, explainUnactivated(name, identity, A.isStudentIdentity(identity) ? sid : ''), 404);
  }

  // 注册激活必须完成邮箱验证：校验「获取验证码」时下发到该邮箱的验证码
  const code = String(body.code || '').trim();
  if (!code) return bad(res, '请输入邮箱验证码（请先点击「获取验证码」）');
  const rec = db.prepare('SELECT * FROM email_codes WHERE user_id = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(user.id);
  if (!rec) return bad(res, '请先点击「获取验证码」并查收邮件', 400);
  if (Date.now() > rec.expires_at) return bad(res, '验证码已过期，请重新获取', 400);
  if (rec.attempts >= CODE_MAX_ATTEMPTS) return bad(res, '验证码尝试次数过多，请重新获取', 429);
  if (!emailMatchesRecord(rec, email)) {
    return bad(res, '邮箱与获取验证码时填写的不一致，请重新获取验证码', 400);
  }
  if (rec.code_hash !== sha256(code)) {
    db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(rec.id);
    return bad(res, '验证码不正确', 400);
  }
  db.prepare('UPDATE email_codes SET used = 1 WHERE id = ?').run(rec.id);

  const pwdHash = await A.hashPasswordAsync(password);
  // 注册完成 = 必须做首次设置：含管理员「清除密码」后重设、重启用后重设等一切设密路径，
  // 一律标记 must_setup=1，登录后先到 /setup.html 完成设置才能进入业务页面
  //（由 server/index.js 的 must_setup 网关对所有业务接口兜底拦截）。
  db.prepare('UPDATE users SET password_hash = ?, must_change_pwd = 0, must_setup = 1, email = ?, email_verified = 1 WHERE id = ?')
    .run(pwdHash, email || null, user.id);
  recordEvent('set_password', user.id, null, identity);
  // 辅导员设置密码（激活）后，自动收回其此前未激活期间的自动委托
  if (A.userLevel(user) === ROLE_LEVEL.counselor) {
    require('../delegate').revokeAutoDelegate(user.id);
  }
  // 上级「到岗」（本人设密激活）→ 立即重算自动代管：缺口消除则收回，并通知被收回者。
  // 用 safeSync 包裹，确保代管/通知异常不会把注册激活链路打成 500。
  require('../autocover').safeSync('activation');
  // 若班级级设置是代管期间（或由前任）留下的，提醒到岗的管理员确认沿用 / 恢复默认
  try {
    if (A.userLevel(user) >= ROLE_LEVEL.cadre) {
      const se = require('../settings').sysEditor(user);
      if (se.need_confirm) require('../notify').notifyAutoCoverArrived(user, { editor: se }).catch(() => {});
    }
  } catch (e) { /* 通知失败不影响激活 */ }
  return ok(res, { message: '邮箱验证通过，密码设置成功，请登录', redirect: 'login.html' });
});

/* --------------------------- 修改密码 --------------------------- */
router.post('/change-password', A.authRequired, async (req, res) => {
  const { old_password, new_password, confirm } = req.body || {};
  if (!old_password) return bad(res, '请输入原密码');
  if (!(await A.verifyPasswordAsync(old_password, req.user.password_hash))) return bad(res, '原密码不正确', 403);
  if (!new_password) return bad(res, '请输入新密码');
  const pwErr = A.validatePassword(new_password);
  if (pwErr) return bad(res, pwErr);
  if (new_password !== confirm) return bad(res, '两次输入的新密码不一致');

  const pwdHash = await A.hashPasswordAsync(new_password);
  db.prepare('UPDATE users SET password_hash = ?, must_change_pwd = 0 WHERE id = ?')
    .run(pwdHash, req.user.id);
  recordEvent('change_password', req.user.id, null, null);
  notify2.notifyPwChanged(req.user, { method: '修改登录密码', ip: req.ip || '' }).catch(() => {});
  return ok(res, { message: '密码已修改' });
});

/* --------------------- 设置 / 更新本人邮箱（找回密码用） --------------------- */
router.post('/email', A.authRequired, async (req, res) => {
  const body = req.body || {};
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  if (!email) return bad(res, '请输入邮箱');
  if (!EMAIL_RE.test(email)) return bad(res, '邮箱格式不正确');

  // 首次登记邮箱无需密码（忘记密码时正是靠它才能自助重置）；
  // 仅“修改”已登记的邮箱才需要当前密码确认，防止会话被盗后改走找回邮箱。
  const current = String(req.user.email || '').trim();
  const changing = current && current.toLowerCase() !== email.toLowerCase();
  if (changing) {
    if (!password) {
      return bad(res, '修改已登记的邮箱需输入当前登录密码确认；若已忘记密码，请先用原邮箱走「忘记密码 → 邮箱验证码」重置密码', 403);
    }
    if (!(await A.verifyPasswordAsync(password, req.user.password_hash))) return bad(res, '密码不正确', 403);
  }

  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
  recordEvent('email_update', req.user.id, null, null);
  notify2.notifyPwChanged(req.user, { method: '更新找回邮箱', ip: req.ip || '' }).catch(() => {});
  return ok(res, { message: current ? '邮箱已更新' : '邮箱已保存', email });
});

/* --------------------- 用户提交找回密码申请 --------------------- */
router.post('/pwd-reset-request', (req, res) => {
  const body = req.body || {};
  const name = String(body.real_name || '').trim();
  const sid = String(body.student_id || '').trim();
  const identity = body.identity;

  if (!name) return bad(res, '请输入姓名');
  if (!A.IDENTITIES.includes(identity)) return bad(res, '请选择身份');
  if (A.isStudentIdentity(identity) && !sid) return bad(res, '普通学生请填写学号');

  const user = findUser(name, identity, A.isStudentIdentity(identity) ? sid : '');
  if (!user) return bad(res, '未找到匹配的账号，请确认姓名/学号/身份与服务端登记一致', 404);

  const pending = db.prepare('SELECT * FROM pwd_resets WHERE user_id = ? AND status = \'pending\'').get(user.id);
  if (pending) return ok(res, { message: '已存在待处理的申请，请联系管理员处理' });

  db.prepare('INSERT INTO pwd_resets (user_id, requester_name, status, created_at) VALUES (?, ?, \'pending\', ?)')
    .run(user.id, name, Date.now());
  recordEvent('pwd_reset_request', null, user.id, identity);
  return ok(res, { message: '申请已提交，请等待管理员清除密码后重新设置' });
});

/* --------------------- 找回密码：发送邮箱验证码 --------------------- */
router.post('/email-code', async (req, res) => {
  const body = req.body || {};
  const name = String(body.real_name || '').trim();
  const sid = String(body.student_id || '').trim();
  const identity = body.identity;
  const email = String(body.email || '').trim();

  if (!name) return bad(res, '请输入姓名');
  if (!A.IDENTITIES.includes(identity)) return bad(res, '请选择身份');
  if (A.isStudentIdentity(identity) && !sid) return bad(res, '普通学生请填写学号');
  if (!email) return bad(res, '请输入邮箱');
  if (!EMAIL_RE.test(email)) return bad(res, '邮箱格式不正确');

  const user = findUser(name, identity, A.isStudentIdentity(identity) ? sid : '');
  if (!user) return bad(res, '未找到匹配的账号，请确认姓名 / 身份 / 学号与服务端登记一致', 404);
  if (!user.email) return bad(res, '该账号未登记邮箱，请改用「请求管理员 / 运维者清除密码」', 400);
  if (user.email.toLowerCase() !== email.toLowerCase()) return bad(res, '邮箱与登记的邮箱不一致', 400);
  if (!mailer.isConfigured()) {
    return bad(res, '邮件服务未配置（请管理员配置 SMTP），可改用「请求管理员 / 运维者清除密码」', 503);
  }

  const now = Date.now();
  const last = db.prepare('SELECT * FROM email_codes WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id);
  if (last && now - last.created_at < CODE_RESEND_MS) {
    const wait = Math.ceil((CODE_RESEND_MS - (now - last.created_at)) / 1000);
    return bad(res, `验证码发送过于频繁，请 ${wait} 秒后再试`, 429);
  }

  const code = genCode();
  db.prepare('UPDATE email_codes SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);
  // 隐私：邮箱只存打码值 + 归一化哈希，不落明文
  db.prepare(`INSERT INTO email_codes (user_id, email, email_hash, code_hash, attempts, used, created_at, expires_at)
              VALUES (?, ?, ?, ?, 0, 0, ?, ?)`)
    .run(user.id, mask.maskEmail(user.email), emailHash(user.email), sha256(code), now, now + CODE_TTL_MS);

  try {
    await mailer.sendCode(user.email, code, Math.round(CODE_TTL_MS / 60000), null, user.id, 'reset');
  } catch (e) {
    return bad(res, '验证码发送失败：' + (e.message || '请稍后重试'), 500);
  }
  recordEvent('email_code', user.id, null, null);
  return ok(res, { message: '验证码已发送至登记邮箱，请查收（10 分钟内有效）' });
});

/* --------------------- 找回密码：校验验证码并重置密码 --------------------- */
router.post('/email-reset', async (req, res) => {
  const body = req.body || {};
  const name = String(body.real_name || '').trim();
  const sid = String(body.student_id || '').trim();
  const identity = body.identity;
  const email = String(body.email || '').trim();
  const code = String(body.code || '').trim();
  const password = body.password;
  const confirm = body.confirm;

  if (!name) return bad(res, '请输入姓名');
  if (!A.IDENTITIES.includes(identity)) return bad(res, '请选择身份');
  if (A.isStudentIdentity(identity) && !sid) return bad(res, '普通学生请填写学号');
  if (!EMAIL_RE.test(email)) return bad(res, '邮箱格式不正确');
  if (!/^\d{6}$/.test(code)) return bad(res, '请输入 6 位数字验证码');
  if (!password) return bad(res, '请设置新密码');
  const pwErr = A.validatePassword(password);
  if (pwErr) return bad(res, pwErr);
  if (password !== confirm) return bad(res, '两次输入的密码不一致');

  const user = findUser(name, identity, A.isStudentIdentity(identity) ? sid : '');
  if (!user) return bad(res, '未找到匹配的账号', 404);
  if (!user.email || user.email.toLowerCase() !== email.toLowerCase()) return bad(res, '邮箱与登记的邮箱不一致', 400);

  const rec = db.prepare('SELECT * FROM email_codes WHERE user_id = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(user.id);
  if (!rec) return bad(res, '请先获取邮箱验证码', 400);
  if (Date.now() > rec.expires_at) return bad(res, '验证码已过期，请重新获取', 400);
  if (rec.attempts >= CODE_MAX_ATTEMPTS) return bad(res, '验证码尝试次数过多，请重新获取', 429);
  if (rec.code_hash !== sha256(code)) {
    db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(rec.id);
    return bad(res, '验证码不正确', 400);
  }

  db.prepare('UPDATE email_codes SET used = 1 WHERE id = ?').run(rec.id);
  const pwdHash = await A.hashPasswordAsync(password);
  // 找回密码已通过「向登记邮箱下发并校验验证码」完成邮箱验证，故与注册激活一致地置 email_verified=1；
  // 否则 factory-reset 等将 email_verified 清零后，用户经此流程重设密码仍会被「未验证禁止登录」锁死。
  db.prepare('UPDATE users SET password_hash = ?, must_change_pwd = 0, email_verified = 1 WHERE id = ?')
    .run(pwdHash, user.id);
  S.endUserSessions(user.id, '邮箱验证码重置密码');   // 重置后原登录全部下线
  recordEvent('email_reset', user.id, null, null);
  // 该账号重新「到岗」→ 重算自动代管（若其为上级则收回代管权限并通知）
  require('../autocover').safeSync('activation');
  notify2.notifyPwChanged(user, { method: '邮箱验证码重置密码', ip: req.ip || '' }).catch(() => {});
  return ok(res, { message: '密码已重置，请用新密码登录', redirect: 'login.html' });
});

/* --------------------------- 已注销账号：提交「重启用」工单申请 --------------------------- */
router.post('/reactivate-request', (req, res) => {
  const body = req.body || {};
  const name = String(body.real_name || '').trim();
  const sid = String(body.student_id || '').trim();
  const identity = body.identity;
  const reason = String(body.reason || '').trim().slice(0, 300);

  if (!name) return bad(res, '请输入姓名');
  if (!A.IDENTITIES.includes(identity)) return bad(res, '请选择身份');
  if (A.isStudentIdentity(identity) && !sid) return bad(res, '普通学生请填写学号');
  if (!reason) return bad(res, '请填写申请理由');

  const user = findUser(name, identity, A.isStudentIdentity(identity) ? sid : '');
  if (!user) return bad(res, '未找到匹配的账号', 404);
  if (user.status !== 'cancelled' && user.disabled !== 1) return bad(res, '该账号并未注销，无需重启', 400);
  if (user.role === 'ops') return bad(res, '运维者账号不可被注销，无需重启', 403);

  // 审批人：层级更高、且能管理该账号的上级（运维者通配）
  const lv = A.userLevel(user);
  // 审批人须「在岗」：预置但未激活（无密码）的上级无法登录处理工单，写进审批人只会让工单石沉大海
  const approvers = db.prepare(`
    SELECT id, real_name, role_title, role FROM users
    WHERE disabled = 0 AND password_hash IS NOT NULL AND role_level > ? AND (role = 'ops' OR role = 'manager')
  `).all(lv).filter(u => u.role === 'ops' || A.canManage(u, user));
  if (!approvers.length) return bad(res, '未找到可审批的上级管理员，请联系运维者', 400);

  const dup = db.prepare("SELECT id FROM work_orders WHERE applicant_id = ? AND perm_code = 'REACTIVATE' AND status = 'pending'")
    .get(user.id);
  if (dup) return bad(res, '你已有一条待审批的重启用工单，请等待审批结果');

  const info = db.prepare(`
    INSERT INTO work_orders (applicant_id, perm_code, reason, approver_ids, status, created_at)
    VALUES (?, 'REACTIVATE', ?, ?, 'pending', ?)
  `).run(user.id, reason, approvers.map(a => a.id).join(','), Date.now());
  recordEvent('reactivate_request', user.id, Number(info.lastInsertRowid), reason);

  approvers.forEach(a => {
    notify2.deliver(a, 'NT_WO_REPLY', {
      level: 'urgent', actor: user,
      title: '账号重启用工单待审批',
      body: `${user.real_name}（${user.role_title}）申请重启用已注销账号`,
      ref_type: 'workorder', ref_id: Number(info.lastInsertRowid),
      mail: { kind: MAIL.WO_SUBMITTED, opts: { applicant: user, perm_code: 'REACTIVATE', reason } }
    }).catch(() => {});
  });
  // 申请人回执：系统自动发邮件 + 站内消息（题头「系统」），确保申请人确认已提交
  notify2.notifyReceipt(user, {
    title: '系统：重启用工单已提交',
    body: '你的「重启用」申请已提交，等待上一级管理员审批（超时未处理将自动通知你）',
    intro: '你的「重启用」申请已提交，等待上一级管理员审批。',
    rows: [
      { label: '申请人', value: notify2.whoLine(user) },
      { label: '申请内容', value: '账号重启用' },
      reason ? { label: '申请理由', value: reason } : null
    ].filter(Boolean),
    actor: user, ref_type: 'workorder', ref_id: Number(info.lastInsertRowid),
    forceMail: true, notifyKind: 'NT_SYS_MSG'
  }).catch(() => {});
  return ok(res, { message: '重启用工单已提交，等待审批', id: info.lastInsertRowid, timeout_hours: WO_TIMEOUT_HOURS });
});

module.exports = router;

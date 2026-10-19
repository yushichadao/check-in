'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const S = require('../sessions');
const { recordEvent } = require('../logger');
const { ROLE_LEVEL } = require('../config');
const delegate = require('../delegate');
const mask = require('../mask');
const autocover = require('../autocover');
const highrisk = require('../highrisk');

/**
 * 自动代管重算（账号可用性变化后调用）。
 * 统一安全包装：代管重算失败绝不影响账号操作本身的返回结果。
 */
function coverSync(reason) {
  try { return autocover.safeSync(reason || 'account_change'); } catch (e) { return null; }
}

const router = express.Router();
router.use(A.authRequired);

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

// 高危操作二次确认文案按场景区分（定义集中在 server/highrisk.js，禁止在此重复硬编码，
// 避免与服务端 highrisk.js 双源漂移）。场景映射：
//   清除账号数据 → delete_user（确认清除账号数据。）
//   批量清除账号 → bulk_delete_user（确认批量清除账号。）
//   恢复已注销账号 → restore_user（确认恢复该账号。）

/**
 * 是否有权操作目标账号（统一走 RBAC 的 canManage）：
 * - 运维者账号不可被任何人操作（防止系统无法进入）；
 * - 不能操作自己；
 * - 操作者层级必须严格高于目标；
 * - 目标必须在操作者的账号管理范围（Scope）内（运维者为通配全局）。
 */
function canClear(operator, target) { return A.canManage(operator, target); }

/** 账号摘要（重复预置时回给调用方，便于「已存在则复用 / 提示跳过」而不中断批量流程） */
function accountSummary(u) {
  if (!u) return null;
  return {
    id: u.id,
    real_name: u.real_name,
    student_id: u.student_id,
    role: u.role,
    role_title: u.role_title,
    role_level: u.role_level,
    disabled: !!u.disabled,
    status: u.status,
    has_password: !!u.password_hash,
    account_state: u.status === 'cancelled' ? 'cancelled' : (u.password_hash ? 'active' : 'unactivated')
  };
}

/** 校验高危操作：本人密码 + 场景固定确认文案，二者一致方可通过
 * @param {string} scene 场景标识（delete_user / bulk_delete_user / restore_user） */
function verifyHighRisk(req, res, scene) {
  const body = req.body || {};
  const pwd = String(body.password || '');
  const text = String(body.confirm_text || '');
  if (!req.user.password_hash) return bad(res, '当前账号尚未设置密码，无法执行高危操作', 403);
  if (!A.verifyPassword(pwd, req.user.password_hash)) return bad(res, '操作者密码不正确', 403);
  const expect = highrisk.textFor(scene);
  if (text !== expect) return bad(res, `高危确认文字不一致，请输入「${expect}」`, 400);
  return null;
}

const listSql = (where, params) =>
  db.prepare(`SELECT id, real_name, student_id, role, role_title, role_level, must_change_pwd, disabled, status, email,
                    (password_hash IS NOT NULL) AS has_password, device_id, created_at,
                    CASE WHEN status = 'cancelled' THEN 'cancelled'
                         WHEN password_hash IS NULL THEN 'unactivated'
                         ELSE 'active' END AS account_state,
                    EXISTS(SELECT 1 FROM sessions s
                           WHERE s.user_id = users.id AND s.online = 1 AND s.ended_at IS NULL
                             AND s.suspended = 0 AND s.last_seen > ?) AS online,
                    (SELECT CASE
                              WHEN MAX(CASE WHEN s.online=1 AND s.ended_at IS NULL AND s.suspended=0 THEN 1 ELSE 0 END)=1
                                   AND MAX(CASE WHEN s.online=1 AND s.ended_at IS NULL AND s.suspended=0 THEN s.last_seen ELSE 0 END) > ?
                                   THEN 'online'
                              WHEN MAX(CASE WHEN s.online=1 AND s.ended_at IS NULL AND s.suspended=0 THEN 1 ELSE 0 END)=1
                                   THEN 'offline'
                              ELSE 'loggedout' END
                       FROM sessions s WHERE s.user_id = users.id) AS online_state
             FROM users ${where} ORDER BY role_level DESC, real_name`).all(Date.now() - S.ONLINE_MS, Date.now() - S.ONLINE_MS, ...params);

/**
 * 邮箱出口统一打码：除本人外，任何端看到的他人邮箱一律中间打码（首尾各留 1 位）。
 * 在接口层就打码，避免「前端忘了打码」导致明文邮箱泄漏到某个页面。
 */
function maskOtherEmails(rows, viewerId) {
  return (rows || []).map(r =>
    (String(r.id) === String(viewerId)) ? r : Object.assign({}, r, { email: mask.maskEmail(r.email) }));
}

/* ------------------------- 账号列表（按 Scope 收窄） ------------------------- */
router.get('/users', (req, res) => {
  const role = req.query.role;
  const out = (rows) => ok(res, { users: maskOtherEmails(rows, req.user.id) });
  if (A.isWildcard(req.user)) {
    if (role === 'ops') return out(listSql("WHERE role = 'ops'", []));
    if (role === 'manager') return out(listSql("WHERE role = 'manager'", []));
    if (role === 'normal') return out(listSql("WHERE role = 'normal'", []));
    return out(listSql('', []));
  }
  // 管理号：仅返回「自己管理范围内」的账号
  const ids = A.scopeIds(req.user.id);
  if (!ids.length) return ok(res, { users: [], hint: '你的层级下暂无可管理的账号（管理范围已按层级自动授权）' });
  const ph = ids.map(() => '?').join(',');
  const w = role === 'normal' ? `WHERE id IN (${ph}) AND role = 'normal'` : `WHERE id IN (${ph})`;
  return out(listSql(w, ids));
});

/* ------------------------- 新增账号 ------------------------- */
router.post('/users', (req, res) => {
  const body = req.body || {};
  const name = String(body.real_name || '').trim();
  const sid = String(body.student_id || '').trim();
  const identity = body.identity;
  const role = A.roleOf(identity);
  const level = A.levelOf(identity);

  if (!name) return bad(res, '请输入姓名');
  if (level === null) return bad(res, '请选择身份');

  // 层级校验：只能创建比自己层级低的账号（运维者可创建除运维者外的一切）
  const myLevel = A.userLevel(req.user);
  if (req.user.role !== 'ops' && level >= myLevel) {
    return bad(res, '只能创建比自己层级低的账号', 403);
  }
  if (role === 'ops') {
    return bad(res, '运维者账号由系统预置，不可在此创建', 403);
  }
  // 账号管理属高危能力：管理号需持有 AUTH_ACCOUNT，运维者走隔离的 OPS_ACCOUNT
  if (req.user.role !== 'ops' && !A.hasPerm(req.user, 'AUTH_ACCOUNT')) {
    return res.status(403).json({ error: '无「账号管理」权限；如需使用请提交权限工单', perm: 'AUTH_ACCOUNT', need_order: true });
  }
  if (role === 'normal' && !sid) return bad(res, '普通用户必须填写学号');

  const finalSid = role === 'normal' ? sid : null;

  // 幂等语义：重复预置不再直接报错中断（批量造数 / 重跑脚本的常见诉求）——
  // 默认返回 409 + 已存在账号摘要；请求体带 reuse=true 时直接复用现有账号（200）。
  const dupSid = finalSid ? db.prepare('SELECT * FROM users WHERE student_id = ?').get(finalSid) : null;
  const dupName = db.prepare('SELECT * FROM users WHERE real_name = ? AND role_title = ?').get(name, identity);
  const dup = dupSid || dupName;
  if (dup) {
    const reason = dupSid ? '该学号已存在' : '同名同身份的账号已存在';
    const canReuse = req.user.role === 'ops' || A.canManage(req.user, dup);
    const wantReuse = body.reuse === true || body.reuse === 1 || body.reuse === '1';
    if (wantReuse && canReuse) {
      // 注：复用已有账号是账号预置幂等的内部便捷行为，不是独立业务操作，不写入数据流审计
      return ok(res, {
        id: dup.id,
        reused: true,
        message: `账号已存在，已复用「${dup.real_name}（${dup.role_title}）」`,
        account: accountSummary(dup)
      });
    }
    return res.status(409).json({
      error: `${reason}${canReuse ? '；如需复用现有账号，请在请求中带上 reuse=true' : '；该账号不在你的管理范围内，无法复用'}`,
      existing: accountSummary(dup),
      reused: false,
      can_reuse: canReuse
    });
  }

  const id = db.newUserId();
  if (!id) return bad(res, '账号标识生成失败，请重试');
  db.prepare(
    `INSERT INTO users (id, real_name, student_id, role_title, role, role_level, password_hash, must_change_pwd, must_setup, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 1, ?)`
  ).run(id, name, finalSid, identity, role, level, Date.now());

  // 新建账号自动纳入创建者的管理范围；运维者创建时同时纳入全部管理号（等价于初始 scope 种子）
  db.transaction(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO account_scopes (admin_id, user_id, created_at) VALUES (?, ?, ?)');
    if (req.user.role === 'ops') {
      db.prepare("SELECT id FROM users WHERE role = 'manager'").all()
        .forEach(m => ins.run(m.id, id, Date.now()));
    } else {
      ins.run(req.user.id, id, Date.now());
    }
  })();

  recordEvent('user_create', req.user.id, id, `${identity}/${finalSid || '-'}`, { id });

  // 新建辅导员且未设密码（未激活）→ 自动委托其管理权限给合适下级
  if (level === ROLE_LEVEL.counselor) delegate.autoDelegate(id);
  coverSync('account_change');   // 预置未激活的上级不算「在岗」→ 不消除缺口，仍按实际在岗情况重算

  return ok(res, { id, message: '账号已预置，需本人注册设置密码后可用' });
});

/* ------------------------- 编辑账号基本信息（姓名 / 学号 / 身份） ------------------------- */
router.put('/users/:id', (req, res) => {
  const id = req.params.id;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return bad(res, '账号不存在', 404);
  const selfEdit = req.user.id === target.id;
  // 仅运维者可编辑自己的账号；其他角色自编辑一律禁止，需提交工单
  if (selfEdit && req.user.role !== 'ops') {
    return res.status(403).json({ error: '不可自行修改账号信息，请提交权限工单申请修改', need_order: true });
  }
  if (target.role === 'ops' && !selfEdit) {
    return bad(res, '仅运维者本人可编辑自己的账号', 403);
  }
  if (!selfEdit) {
    if (!A.canManage(req.user, target)) {
      return bad(res, '该账号不在你的管理范围内，或你的层级不足', 403);
    }
    if (req.user.role !== 'ops' && !A.hasPerm(req.user, 'AUTH_ACCOUNT')) {
      return res.status(403).json({ error: '无「账号管理」权限；如需使用请提交权限工单', perm: 'AUTH_ACCOUNT', need_order: true });
    }
  }

  const b = req.body || {};
  const name = b.real_name !== undefined ? String(b.real_name).trim() : target.real_name;
  const sid = b.student_id !== undefined ? String(b.student_id).trim() : (target.student_id || '');
  // 账号编辑不允许变更身份；身份调整统一走专用接口 PUT /users/:id/role（仅运维者）
  const identity = target.role_title;
  const level = A.levelOf(identity);
  const role = A.roleOf(identity);

  if (!name) return bad(res, '请输入姓名');
  if (level === null) return bad(res, '账号当前身份无效，请联系运维者处理');
  const finalSid = role === 'normal' ? sid : null;
  if (role === 'normal' && !finalSid) return bad(res, '普通用户必须填写学号');
  if (finalSid && db.prepare('SELECT id FROM users WHERE student_id = ? AND id <> ?').get(finalSid, id)) {
    return bad(res, '该学号已被其他账号使用');
  }
  if (db.prepare('SELECT id FROM users WHERE real_name = ? AND role_title = ? AND id <> ?').get(name, identity, id)) {
    return bad(res, '同名同身份的账号已存在');
  }

  db.prepare('UPDATE users SET real_name = ?, student_id = ?, role_title = ?, role = ?, role_level = ? WHERE id = ?')
    .run(name, finalSid, identity, role, level, id);
  recordEvent('user_update', req.user.id, id, `${name}/${identity}/${finalSid || '-'}`);
  coverSync('account_change');   // 身份 / 层级可能变化 → 重新计算代管
  return ok(res, { message: `已更新「${name}」的账号信息` });
});

/* ------------------------- 修改账号身份 / 层级（仅运维者） ------------------------- */
router.put('/users/:id/role', (req, res) => {
  if (req.user.role !== 'ops') return bad(res, '仅运维者可调整账号身份', 403);
  const id = req.params.id;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return bad(res, '账号不存在', 404);
  if (target.role === 'ops') return bad(res, '运维者账号不可被调整', 403);

  const identity = String((req.body || {}).identity || '');
  const level = A.levelOf(identity);
  if (level === null) return bad(res, '请选择有效的身份');
  if (A.roleOf(identity) === 'ops') return bad(res, '不可改为运维者身份', 403);

  db.prepare('UPDATE users SET role_title = ?, role = ?, role_level = ? WHERE id = ?')
    .run(identity, A.roleOf(identity), level, id);
  recordEvent('user_role_change', req.user.id, id, identity);
  const notify = require('../notify');
  notify.notifyAccountNotice(target, {
    items: [{ label: '变更内容', value: `身份调整为「${identity}」` }, { label: '操作者', value: '运维者' }]
  }).catch(() => {});
  coverSync('account_change');   // 身份调整会改变层级在岗情况 → 重新计算代管
  return ok(res, { message: `已将「${target.real_name}」的身份调整为「${identity}」` });
});

/* ------------------------- 清除账号数据（永久删除，需二次验证） ------------------------- */
router.delete('/users/:id', (req, res) => {
  const err = verifyHighRisk(req, res, 'delete_user');
  if (err) return err;

  const id = req.params.id;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return bad(res, '账号不存在', 404);
  if (!canClear(req.user, target)) {
    return bad(res, target.role === 'ops'
      ? '运维者账号不可被清除，以防止系统无法进入'
      : '仅高一级管理员有权清除该账号', 403);
  }
  // 仅「已注销」账号可清除数据（硬删）；未注销账号不允许直接删除
  if (target.status !== 'cancelled') {
    return bad(res, '账号须先「注销」后方可清除其数据；未注销账号不可直接删除', 403);
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM checkins WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM leave_requests WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM pwd_resets WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
  tx();

  recordEvent('user_delete', req.user.id, id, target.real_name);
  coverSync('account_change');   // 可能删掉了唯一的上级 → 重新计算代管
  return ok(res, { message: `已永久清除「${target.real_name}」的账号数据` });
});

/* ------------------------- 批量清除账号数据（同样需二次验证） ------------------------- */
router.post('/users/bulk-delete', (req, res) => {
  const err = verifyHighRisk(req, res, 'bulk_delete_user');
  if (err) return err;

  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return bad(res, '请选择要清除的账号');

  const denied = [];
  const cleared = [];
  const tx = db.transaction(() => {
    for (const id of ids) {
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!target) continue;
      if (!canClear(req.user, target)) { denied.push(target.real_name + '（越权）'); continue; }
      if (target.status !== 'cancelled') { denied.push(target.real_name + '（未注销）'); continue; }
      db.prepare('DELETE FROM checkins WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM leave_requests WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM pwd_resets WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      cleared.push(target.real_name);
    }
  });
  tx();

  recordEvent('user_bulk_delete', req.user.id, null, `批量清除 ${cleared.length} 个账号`);
  coverSync('account_change');
  let msg = `已永久清除 ${cleared.length} 个账号`;
  if (denied.length) msg += `；${denied.length} 个无权限（运维者或越级），已跳过：${denied.join('、')}`;
  return ok(res, { message: msg, cleared: cleared.length, denied });
});

/* ------------------------- 恢复已注销（隐藏）的账号 ------------------------- */
router.post('/users/:id/restore', (req, res) => {
  // 恢复会把目标账号密码清空并结束其全部会话，属高危操作：必须与「清除数据」一致地做二次确认
  // （本人密码 + 场景固定确认文字 restore_user）。原实现缺少该校验，会导致一次误点即清空他人密码。
  const err = verifyHighRisk(req, res, 'restore_user');
  if (err) return err;

  const id = req.params.id;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return bad(res, '账号不存在', 404);
  if (!canClear(req.user, target)) {
    return bad(res, target.role === 'ops'
      ? '运维者账号不可被操作'
      : '仅高一级管理员有权恢复该账号', 403);
  }
  // 重启用：清空密码 → 回到「未激活」状态，本人需重新注册设置密码
  db.prepare("UPDATE users SET disabled = 0, status = 'active', password_hash = NULL, must_change_pwd = 1, must_setup = 0 WHERE id = ?").run(id);
  S.endUserSessions(id, '管理员恢复账号');
  recordEvent('user_restore', req.user.id, id, target.real_name);
  // 重启用后密码清空（未激活）→ 自动委托其管理权限
  if (A.userLevel(target) === ROLE_LEVEL.counselor) delegate.autoDelegate(id);
  coverSync('account_change');
  return ok(res, { message: `已恢复「${target.real_name}」的账号（密码已清空，需本人重新设置密码）` });
});

/* --------------------- 注销账号（隐藏处理，可由管理端 / 运维者执行） --------------------- */
router.post('/users/:id/cancel', (req, res) => {
  const id = req.params.id;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return bad(res, '账号不存在', 404);
  if (!canClear(req.user, target)) {
    return bad(res, target.role === 'ops'
      ? '运维者账号不可被注销'
      : '仅高一级管理员有权注销该账号', 403);
  }
  db.prepare("UPDATE users SET disabled = 1, status = 'cancelled' WHERE id = ?").run(id);
  S.endUserSessions(id, '管理员注销账号');
  recordEvent('account_cancel', req.user.id, id, target.real_name);
  // 注销后收回其自动委托（若仍有未激活辅导员委托残留）
  if (A.userLevel(target) === ROLE_LEVEL.counselor) delegate.revokeAutoDelegate(id);
  coverSync('account_change');   // 上级注销后可能重新出现缺口 → 触发代管
  return ok(res, { message: `已注销「${target.real_name}」的账号（数据已归档，重新启用需联系管理员）` });
});

/* --------------------- 清除密码（仅 Scope 内账号；清零不删数据） --------------------- */
router.post('/users/:id/clear-password', (req, res) => {
  const id = req.params.id;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return bad(res, '账号不存在', 404);

  // 管理号需 AUTH_ACCOUNT；运维者走隔离的 OPS_ACCOUNT
  if (req.user.role !== 'ops' && !A.hasPerm(req.user, 'AUTH_ACCOUNT')) {
    return res.status(403).json({ error: '无「账号管理」权限；如需使用请提交权限工单', perm: 'AUTH_ACCOUNT', need_order: true });
  }
  if (!A.canManage(req.user, target)) {
    return bad(res, '该账号不在你的管理范围内，或你的层级不足', 403);
  }

  db.prepare('UPDATE users SET password_hash = NULL, must_change_pwd = 1 WHERE id = ?').run(id);
  S.endUserSessions(id, '管理员清除密码');
  db.prepare("UPDATE pwd_resets SET status = 'done', handled_by = ? WHERE user_id = ? AND status = 'pending'")
    .run(req.user.id, id);
  recordEvent('clear_password', req.user.id, id, null);

  const notify = require('../notify');
  notify.notifyAccountNotice(target, {
    items: [
      { label: '变更内容', value: '登录密码已被管理员清除，原密码失效' },
      { label: '下一步', value: '下次登录需重新设置密码' },
      { label: '操作者', value: `${req.user.real_name}（${req.user.role_title}）` }
    ]
  }).catch(() => {});

  // 清除密码 → 未激活 → 若目标为辅导员，自动委托其管理权限给合适下级
  if (A.userLevel(target) === ROLE_LEVEL.counselor) delegate.autoDelegate(id);
  coverSync('account_change');   // 清除密码后该账号不再「在岗」→ 可能重新出现缺口

  return ok(res, { message: `已清除「${target.real_name}」的密码，原密码失效，需本人重新设置` });
});

/* --------------------- 待处理的找回密码申请（按 Scope 收窄） --------------------- */
router.get('/pwd-resets', (req, res) => {
  const rows = db.prepare(
    `SELECT r.*, u.real_name, u.student_id, u.role_title, u.role, u.role_level
     FROM pwd_resets r JOIN users u ON u.id = r.user_id
     ORDER BY r.status, r.created_at DESC LIMIT 200`
  ).all();
  const visible = A.isWildcard(req.user)
    ? rows
    : rows.filter(r => A.inScope(req.user.id, r.user_id));
  return ok(res, { resets: visible });
});

module.exports = router;

'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const { ALL_PERMS, identityOfLevel } = require('../config');
const { recordEvent } = require('../logger');
const zh = require('../zh');
const notify = require('../notify');

const router = express.Router();
router.use(A.authRequired);

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

/** 可被下放的权限（排除 denied / 普通学生固有 / 运维者隔离） */
const GRANTABLE = Object.keys(ALL_PERMS).filter(code => {
  const p = ALL_PERMS[code];
  return p.type === 'high_risk' || p.type === 'regular';
});

/* ---------------- 权限码表（前端门禁 UI 用） ---------------- */
router.get('/codes', (req, res) => {
  const lv = A.userLevel(req.user);
  const codes = {};
  Object.keys(ALL_PERMS).forEach(code => {
    const p = ALL_PERMS[code];
    codes[code] = {
      code,
      name: p.name,
      min: (p.min === null || p.min === undefined) ? null : p.min,
      type: p.type,
      held: A.hasPerm(req.user, code),
      baseline: (typeof p.min === 'number' && lv >= p.min)
    };
  });
  return ok(res, { codes, level: lv, grantable: GRANTABLE });
});

/* ---------------- 我的权限 ---------------- */
router.get('/mine', (req, res) => ok(res, { state: A.permState(req.user) }));

/* ---------------- 指定账号的有效下放权限（仅运维者，用于「管理权力」页） ---------------- */
router.get('/grants', A.requireRole('ops'), (req, res) => {
  const uid = req.query.user_id;
  if (!uid) return bad(res, '缺少账号');
  const rows = db.prepare(`
    SELECT g.*, h.real_name AS granter_name
    FROM permission_grants g LEFT JOIN users h ON h.id = g.granted_by
    WHERE g.user_id = ? AND g.revoked = 0
    ORDER BY g.created_at DESC LIMIT 200
  `).all(uid);
  return ok(res, { grants: rows });
});

/* ---------------- 我授予出去的权限（可撤回） ---------------- */
router.get('/granted', A.requirePerm('AUTH_GRANT'), (req, res) => {
  const rows = db.prepare(`
    SELECT g.*, u.real_name, u.role_title, u.role_level
    FROM permission_grants g JOIN users u ON u.id = g.user_id
    WHERE g.granted_by = ? AND g.revoked = 0
    ORDER BY g.created_at DESC LIMIT 200
  `).all(req.user.id);
  return ok(res, { grants: rows });
});

/**
 * 下放权限（AUTH_GRANT）：
 *  - 只能下放「自己持有」的权限；
 *  - 只能授给层级更低、且在本人 scope 内的账号；
 *  - 运维者为通配全局。
 */
router.post('/grant', A.requirePerm('AUTH_GRANT'), (req, res) => {
  const b = req.body || {};
  const targetId = b.user_id;
  const code = String(b.perm_code || '');
  const days = Number(b.days) || 0;

  if (!targetId) return bad(res, '请选择目标账号');
  if (!GRANTABLE.includes(code)) return bad(res, '该权限不可下放');
  if (!A.hasPerm(req.user, code)) return bad(res, '你不能下放自己都不持有的权限', 403);
  // 自动代管所得权限不可再向下授权：否则「缺上级」期间管理权会被继续扩散，
  // 且上级到岗后收回链路会变得难以推理。班委自身基线持有的权限不受此限。
  if (require('../autocover').heldOnlyByAutoCover(req.user, code)) {
    return bad(res, '该权限来自「自动代管」，不可再向下授权；请等上级到岗后由上级授予', 403);
  }
  // 细粒度层级限制：该权限要求更高层级方可授予（如「查看学生定位」仅辅导员及以上可授予）
  const gp = ALL_PERMS[code];
  if (typeof gp.grant_min_level === 'number' && A.userLevel(req.user) < gp.grant_min_level) {
    return bad(res, `该权限仅「${identityOfLevel(gp.grant_min_level)}」及以上层级可授予`, 403);
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return bad(res, '目标账号不存在', 404);
  // 管理端权限只面向管理岗账号：普通学生使用的「用户端」没有对应控件，授予后既无法使用也无人可操作，故禁止下放。
  if (A.isStudentUser(target)) {
    return bad(res, '管理端权限不可下放到普通学生：普通学生端（用户端）无对应控件，授予后无法使用', 403);
  }
  if (!A.canManage(req.user, target)) {
    return bad(res, '只能授予层级更低、且在你的管理范围内的账号', 403);
  }

  const until = days > 0 ? Date.now() + days * 24 * 3600 * 1000 : null;
  db.prepare(`
    INSERT INTO permission_grants (user_id, perm_code, granted_by, source, expires_at, revoked, created_at)
    VALUES (?, ?, ?, 'grant', ?, 0, ?)
  `).run(targetId, code, req.user.id, until, Date.now());

  recordEvent('perm_grant', req.user.id, targetId, zh.permText(code));
  notify.notifyGrantNotice(target, {
    perm_code: code,
    granter: req.user,
    until
  }).catch(() => {});
  return ok(res, { message: `已向「${target.real_name}」授予「${ALL_PERMS[code].name}」` });
});

/**
 * 批量下放权限：多个账号 × 多个权限码。
 * 限制与单个授予一致：只能下放「自己持有」的权限，且只能授给「层级更低、且在管理范围内」的账号。
 */
router.post('/grant-batch', A.requirePerm('AUTH_GRANT'), (req, res) => {
  const b = req.body || {};
  const userIds = Array.isArray(b.user_ids) ? b.user_ids.filter(Boolean) : [];
  const codes = (Array.isArray(b.perm_codes) ? b.perm_codes : [b.perm_code]).map(String).filter(Boolean);
  const days = Number(b.days) || 0;
  if (!userIds.length) return bad(res, '请选择要授权的账号');
  if (!codes.length) return bad(res, '请选择要授予的权限');
  for (const code of codes) {
    if (!GRANTABLE.includes(code)) return bad(res, `权限不可下放：${code}`);
    if (!A.hasPerm(req.user, code)) return bad(res, `你不能下放自己都不持有的权限：${code}`, 403);
    if (require('../autocover').heldOnlyByAutoCover(req.user, code)) {
      return bad(res, `权限「${ALL_PERMS[code] ? ALL_PERMS[code].name : code}」来自「自动代管」，不可再向下授权`, 403);
    }
    const gp = ALL_PERMS[code];
    if (typeof gp.grant_min_level === 'number' && A.userLevel(req.user) < gp.grant_min_level) {
      return bad(res, `权限「${gp.name}」仅「${identityOfLevel(gp.grant_min_level)}」及以上层级可授予`, 403);
    }
  }

  const until = days > 0 ? Date.now() + days * 24 * 3600 * 1000 : null;
  const ins = db.prepare(`
    INSERT INTO permission_grants (user_id, perm_code, granted_by, source, expires_at, revoked, created_at)
    VALUES (?, ?, ?, 'grant', ?, 0, ?)
  `);
  let granted = 0;
  let skipped = 0;
  let skippedStudents = 0;
  const targets = [];
  db.transaction(() => {
    userIds.forEach(uid => {
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      // 普通学生端无对应控件：管理端权限禁止下放给普通学生，直接跳过（不授予）
      if (!target || A.isStudentUser(target)) { skipped += 1; if (target && A.isStudentUser(target)) skippedStudents += 1; return; }
      if (!A.canManage(req.user, target)) { skipped += 1; return; }
      targets.push(target);
      codes.forEach(code => { ins.run(uid, code, req.user.id, until, Date.now()); granted += 1; });
    });
  })();

  recordEvent('perm_grant_batch', req.user.id, null, `${granted} 项 · ${targets.length} 个账号`);
  // 通知每位被授权账号（合并为一条）
  const notify = require('../notify');
  targets.forEach(t => {
    notify.notifyGrantNotice(t, {
      perm_code: codes.join('、'),
      granter: req.user,
      until
    }).catch(() => {});
  });
  const skipMsg = skipped
    ? `，跳过 ${skipped} 个账号（含 ${skippedStudents} 个普通学生：用户端无对应控件，禁止下放）`
    : '';
  return ok(res, {
    message: `已授予 ${granted} 项权限（${targets.length} 个账号${skipMsg}）`,
    granted, skipped, skipped_students: skippedStudents
  });
});

/* ---------------- 收回已下放的权限 ---------------- */
router.post('/revoke', A.requirePerm('AUTH_GRANT'), (req, res) => {
  const id = Number((req.body || {}).grant_id);
  if (!id) return bad(res, '请选择要收回的授权');
  const g = db.prepare('SELECT * FROM permission_grants WHERE id = ?').get(id);
  if (!g) return bad(res, '授权记录不存在', 404);
  if (g.granted_by !== req.user.id && req.user.role !== 'ops') {
    return bad(res, '只能收回自己下放的授权', 403);
  }
  db.prepare('UPDATE permission_grants SET revoked = 1, revoked_at = ? WHERE id = ?').run(Date.now(), id);
  recordEvent('perm_revoke', req.user.id, g.user_id, zh.permText(g.perm_code));
  return ok(res, { message: '已收回该授权' });
});

module.exports = router;

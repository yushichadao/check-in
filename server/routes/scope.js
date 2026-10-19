'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const { recordEvent } = require('../logger');

const router = express.Router();
router.use(A.authRequired);

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

/** 仅运维者可编辑各管理号的「管理范围」 */
function devOnly(req, res, next) {
  if (req.user.role !== 'ops') {
    return res.status(403).json({ error: '仅运维者可配置账号管理范围（运维者身份独立隔离）' });
  }
  next();
}

/**
 * 列出各管理号及其可管理账号（运维端「管理范围」编辑器）。
 * 运维者为通配全局，不参与勾选。
 */
router.get('/', devOnly, (req, res) => {
  const admins = db.prepare(`
    SELECT id, real_name, role_title, role_level, disabled
    FROM users WHERE role IN ('manager') ORDER BY role_level DESC, real_name
  `).all();
  const targets = db.prepare(`
    SELECT id, real_name, student_id, role_title, role_level
    FROM users WHERE role <> 'ops' ORDER BY role_level DESC, real_name
  `).all();
  const all = db.prepare('SELECT admin_id, user_id FROM account_scopes').all();
  const map = {};
  all.forEach(r => { (map[r.admin_id] = map[r.admin_id] || []).push(r.user_id); });
  return ok(res, {
    admins: admins.map(a => Object.assign({}, a, { scope: map[a.id] || [] })),
    targets
  });
});

/** 设置某管理号的管理范围 */
router.put('/:adminId', devOnly, (req, res) => {
  const adminId = req.params.adminId;
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId);
  if (!admin) return bad(res, '管理号不存在', 404);
  if (admin.role === 'ops') return bad(res, '运维者为全局通配，无需配置范围');

  const ids = Array.isArray((req.body || {}).user_ids)
    ? req.body.user_ids.filter(Boolean) : [];
  // 只允许纳入层级更低的非运维者账号
  const valid = ids.filter(id => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return u && A.userLevel(u) < A.userLevel(admin);
  });
  A.setScope(adminId, valid);
  recordEvent('scope_update', req.user.id, adminId, `${valid.length} 个账号`);
  return ok(res, { message: `已更新「${admin.real_name}」的管理范围（${valid.length} 个账号）` });
});

/** 当前登录者自己的管理范围（管理端用于知道自己能管谁） */
router.get('/mine', (req, res) => {
  if (A.isWildcard(req.user)) {
    return ok(res, {
      wildcard: true,
      ids: db.prepare("SELECT id FROM users WHERE role <> 'ops'").all().map(r => r.id)
    });
  }
  return ok(res, { wildcard: false, ids: A.scopeIds(req.user.id) });
});

module.exports = router;

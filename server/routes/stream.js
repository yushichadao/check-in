'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const St = require('../settings');
const highrisk = require('../highrisk');
const { maskName } = require('../mask');
const { describe, typeText } = require('../eventtext');

const router = express.Router();
router.use(A.authRequired);

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

const SELECT = `
  SELECT e.id, e.action AS type, e.detail, e.created_at,
         a.id AS actor_id, a.real_name AS actor_name, a.role_title AS actor_role, a.role AS actor_kind,
         t.id AS target_id, t.real_name AS target_name, t.role_title AS target_role
  FROM data_flow e
  LEFT JOIN users a ON a.id = e.actor_id
  LEFT JOIN users t ON t.id = e.target_id`;

/**
 * 数据流按角色分级：
 * - 运维者：全部人的数据流（姓名脱敏，不含学号/设备/IP/邮箱）
 * - 管理员：管理员 + 普通使用者的数据流（不含运维者）
 * - 普通使用者：仅自己的数据流
 * 每行返回「人话」描述 text，含被操作对象，便于理解、避免误操作。
 */
router.get('/', (req, res) => {
  const limit = Math.min(500, Math.max(20, Number(req.query.limit) || 120));
  const role = req.user.role;

  let rows;
  if (role === 'ops') {
    rows = db.prepare(`${SELECT} ORDER BY e.created_at DESC LIMIT ?`).all(limit);
  } else if (role === 'manager') {
    rows = db.prepare(
      `${SELECT} WHERE a.id IS NULL OR a.role IN ('manager','normal') ORDER BY e.created_at DESC LIMIT ?`
    ).all(limit);
  } else {
    // 普通使用者：自己的操作 + 管理员对自己账号的操作（加入管理员操作数据流）
    rows = db.prepare(
      `${SELECT} WHERE e.actor_id = ? OR e.target_id = ? ORDER BY e.created_at DESC LIMIT ?`
    ).all(req.user.id, req.user.id, limit);
  }

  // 脱敏受「系统安全 → 中间部分加密」开关控制（dataflow_mask）：
  // 开启才对运维端数据流列表打码，关闭则显示全名（与操作记录详情页、CSV 导出保持一致）
  const masked = role === 'ops' && St.getBool('dataflow_mask');
  const mask = (n) => (masked && n ? maskName(n) : n);
  const actMap = new Map(db.prepare('SELECT id, title FROM activities').all().map(r => [r.id, r.title]));

  const events = rows.map(r => {
    let target = r.target_id ? { name: mask(r.target_name), role_title: r.target_role } : null;
    // 账号删除后已查不到用户，回退用 detail 里保存的姓名，避免「删除了某账号」看不到是谁
    if (!target && (r.type === 'user_delete' || r.type === 'user_restore') && r.detail) {
      target = { name: mask(r.detail), role_title: null };
    }
    return {
      id: r.id,
      type: r.type,
      type_text: typeText(r.type),
      text: describe(r.type, r.detail, target, actMap),
      created_at: r.created_at,
      actor_name: r.actor_id ? mask(r.actor_name) : null,
      actor_role: r.actor_role,
      actor_kind: r.actor_kind,
      target_name: target ? target.name : null
    };
  });

  res.json({
    ok: true,
    events,
    masked,
    scope: role === 'ops' ? 'all' : (role === 'manager' ? 'manager+normal' : 'self')
  });
});

/** 统计审计：仅管理员与运维者可见 */
router.get('/stats', A.requireRole('manager', 'ops'), (req, res) => {
  const counts = {
    users: db.prepare("SELECT COUNT(*) c FROM users WHERE disabled=0").get().c,
    normal_users: db.prepare("SELECT COUNT(*) c FROM users WHERE role='normal' AND disabled=0").get().c,
    // 已注销账号（注销 = disabled=1 + status='cancelled'）：normal_users 口径保持不变，此处单独统计用于新增卡片
    cancelled_users: db.prepare("SELECT COUNT(*) c FROM users WHERE status='cancelled'").get().c,
    // 未激活账号（已建账号但尚未设置密码，且未注销）：与账号管理列表 account_state='unactivated' 口径一致
    unactivated_users: db.prepare("SELECT COUNT(*) c FROM users WHERE status!='cancelled' AND password_hash IS NULL").get().c,
    managers: db.prepare("SELECT COUNT(*) c FROM users WHERE role='manager' AND disabled=0").get().c,
    // 运维端账号（运维者，独立角色，与 manager 不重叠）：用于运维端概览职位卡拆解，使 普通+管理+运维者=账号总数
    ops_users: db.prepare("SELECT COUNT(*) c FROM users WHERE role='ops' AND disabled=0").get().c,
    activities: db.prepare('SELECT COUNT(*) c FROM activities').get().c,
    parent_activities: db.prepare("SELECT COUNT(*) c FROM activities WHERE parent_id IS NULL").get().c,
    checkins: db.prepare('SELECT COUNT(*) c FROM checkins').get().c,
    signed: db.prepare("SELECT COUNT(*) c FROM checkins WHERE status='signed'").get().c,
    leave: db.prepare("SELECT COUNT(*) c FROM checkins WHERE status='leave'").get().c,
    manual: db.prepare('SELECT COUNT(*) c FROM checkins WHERE manual=1').get().c,
    pending_resets: db.prepare("SELECT COUNT(*) c FROM pwd_resets WHERE status='pending'").get().c,
    pending_leaves: db.prepare("SELECT COUNT(*) c FROM leave_requests WHERE status='pending'").get().c
  };
  res.json({ ok: true, counts });
});

/** 删除单条数据流记录：仅运维者可操作（管理员不可删除）；需高危双重验证 */
router.delete('/:id', A.requireRole('ops'), (req, res) => {
  const err = highrisk.verify(req, 'delete_dataflow');
  if (err) return res.status(400).json({ error: err });
  const id = Number(req.params.id);
  const ev = db.prepare('SELECT * FROM data_flow WHERE id = ?').get(id);
  if (!ev) return bad(res, '记录不存在', 404);
  db.prepare('DELETE FROM data_flow WHERE id = ?').run(id);
  return ok(res, { message: '记录已删除' });
});

/** 批量删除数据流记录：仅运维者可操作；需高危双重验证 */
router.delete('/', A.requireRole('ops'), (req, res) => {
  const err = highrisk.verify(req, 'bulk_delete_dataflow');
  if (err) return res.status(400).json({ error: err });
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return bad(res, '请选择要删除的记录');
  const info = db.prepare(`DELETE FROM data_flow WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  return ok(res, { message: `已删除 ${info.changes} 条记录`, deleted: info.changes });
});

module.exports = router;

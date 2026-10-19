'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const St = require('../settings');
const highrisk = require('../highrisk');
const { describe, typeText } = require('../eventtext');
const { maskName } = require('../mask');
const router = express.Router();
router.use(A.authRequired);

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

/** GET /meta - 数据流分类与动作类型元数据 */
router.get('/meta', (req, res) => {
  const categories = [
    { key: 'checkin', label: '签到' },
    { key: 'appeal', label: '申诉/请假' },
    { key: 'account', label: '账号管理' },
    { key: 'activity', label: '活动管理' },
    { key: 'fence', label: '围栏管理' },
    { key: 'auth', label: '登录/会话' },
    { key: 'workorder', label: '工单' },
    { key: 'system', label: '系统' }
  ];
  const actions = db.prepare('SELECT DISTINCT action FROM data_flow ORDER BY action').all().map(r => r.action);
  res.json({ ok: true, categories, actions });
});

/** GET /highrisk-texts - 返回数据流相关高危操作的确认文字 */
router.get('/highrisk-texts', A.requireRole('ops'), (req, res) => {
  res.json({
    ok: true,
    texts: {
      delete_dataflow: highrisk.textFor('delete_dataflow'),
      bulk_delete_dataflow: highrisk.textFor('bulk_delete_dataflow')
    }
  });
});

/** GET /:id - 单条数据流记录详情 */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return bad(res, '无效的记录ID');
  const row = db.prepare(
    `SELECT e.*, a.real_name AS actor_name, a.role_title AS actor_role, a.role AS actor_kind,
            t.real_name AS target_name, t.role_title AS target_role
     FROM data_flow e
     LEFT JOIN users a ON a.id = e.actor_id
     LEFT JOIN users t ON t.id = e.target_id
     WHERE e.id = ?`
  ).get(id);
  if (!row) return bad(res, '记录不存在', 404);

  // 权限检查：普通用户只能查看自己的记录
  const role = req.user.role;
  if (role === 'normal' && row.actor_id !== req.user.id && row.subject_id !== req.user.id) {
    return bad(res, '无权查看该记录', 403);
  }
  if (role === 'manager' && row.actor_kind === 'ops') {
    return bad(res, '无权查看运维者记录', 403);
  }

  const masked = role === 'ops' && St.getBool('dataflow_mask');
  const mask = (n) => (masked && n ? maskName(n) : n);
  const actMap = new Map(db.prepare('SELECT id, title FROM activities').all().map(r => [r.id, r.title]));

  let target = row.target_id ? { name: mask(row.target_name), role_title: row.target_role } : null;
  if (!target && (row.action === 'user_delete' || row.action === 'user_restore') && row.detail) {
    target = { name: mask(row.detail), role_title: null };
  }

  let payload = null;
  if (row.payload) {
    try { payload = JSON.parse(row.payload); } catch (_) { payload = row.payload; }
  }

  res.json({
    ok: true,
    event: {
      id: row.id,
      type: row.action,
      type_text: typeText(row.action),
      text: describe(row.action, row.detail, target, actMap),
      detail: row.detail,
      category: row.category,
      channel: row.channel,
      created_at: row.created_at,
      actor_name: row.actor_id ? mask(row.actor_name) : null,
      actor_role: row.actor_role,
      actor_kind: row.actor_kind,
      target_name: target ? target.name : null,
      target_role: target ? target.role_title : null,
      payload,
      withdrawn_by: row.withdrawn_by,
      withdrawn_at: row.withdrawn_at,
      reversed: row.reversed
    }
  });
});

/** POST /mask - 切换数据流隐私打码开关（仅运维者） */
router.post('/mask', A.requireRole('ops'), (req, res) => {
  const mask = !!(req.body && req.body.mask);
  St.set('dataflow_mask', mask ? '1' : '0');
  res.json({ ok: true, mask });
});

module.exports = router;

'use strict';
/* 站内消息中心：在线用户由前端轮询拉取并弹 toast；离线时由 notify.deliver 自动改发邮件 */
const express = require('express');
const db = require('../db');
const A = require('../auth');

const router = express.Router();
router.use(A.authRequired);

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));

const LEVEL_TEXT = { urgent: '紧急', notice: '重要', info: '普通' };

function shape(r) {
  return Object.assign({}, r, {
    level_text: LEVEL_TEXT[r.level] || '普通',
    read: !!r.read_at
  });
}

/** 未读消息（前端轮询用）：同时返回未读数量，便于角标显示 */
router.get('/pending', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM notifications
    WHERE user_id = ? AND read_at IS NULL
    ORDER BY id DESC LIMIT 30
  `).all(req.user.id).map(shape);
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(req.user.id).n;
  return ok(res, { items: rows, unread });
});

/** 全部消息（消息中心列表，分层展示，分页） */
router.get('/', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
  const total = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(req.user.id).n;
  const rows = db.prepare(`
    SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(req.user.id, pageSize, (page - 1) * pageSize).map(shape);
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(req.user.id).n;
  return ok(res, { items: rows, total, page, page_size: pageSize, unread });
});

/** 标记已读：body.ids 为空数组表示「全部已读」 */
router.post('/read', (req, res) => {
  const ids = (req.body || {}).ids;
  const now = Date.now();
  if (Array.isArray(ids) && ids.length) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${ph})`)
      .run(now, req.user.id, ...ids.map(Number).filter(Boolean));
  } else {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, req.user.id);
  }
  return ok(res, { message: '已标记为已读' });
});

/** 删除消息：单条或批量（body.ids 为消息 id 数组）。仅删除本人消息（按 user_id 隔离），
 *  属个人站内信管理操作，不写数据流留痕、无需二次验证。 */
router.delete('/', (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids) || !ids.length) return ok(res, { message: '无删除项' });
  const nums = ids.map(Number).filter(Boolean);
  if (!nums.length) return ok(res, { message: '无删除项' });
  const ph = nums.map(() => '?').join(',');
  const info = db.prepare(`DELETE FROM notifications WHERE user_id = ? AND id IN (${ph})`)
    .run(req.user.id, ...nums);
  return ok(res, { message: '已删除', deleted: info.changes || nums.length });
});

module.exports = router;

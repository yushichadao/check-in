'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const S = require('../sessions');
const { recordEvent } = require('../logger');

const router = express.Router();
router.use(A.authRequired);

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

/* --------- 我的登录设备：按设备去重（当前 + 历史设备，每台只留最新） --------- */
router.get('/', (req, res) => {
  const cur = req.session || {};
  const sessions = S.listUserSessions(req.user.id, cur.id, cur.device_key);
  return ok(res, { sessions });
});

/* ---------------- 下线某台设备（不能下线当前设备） ---------------- */
router.post('/kick', (req, res) => {
  const deviceKey = String((req.body && req.body.device_key) || '').trim();
  if (!deviceKey) return bad(res, '缺少设备标识');

  const cur = req.session || {};
  if (cur.device_key && deviceKey === cur.device_key) {
    return bad(res, '不能下线当前正在使用的设备，请直接「登出」', 400);
  }

  const owned = db.prepare('SELECT id FROM sessions WHERE user_id = ? AND device_key = ? LIMIT 1')
    .get(req.user.id, deviceKey);
  if (!owned) return bad(res, '设备不存在', 404);

  const last = db.prepare('SELECT device_name FROM sessions WHERE user_id = ? AND device_key = ? ORDER BY last_seen DESC LIMIT 1')
    .get(req.user.id, deviceKey);
  S.endDeviceSessions(req.user.id, deviceKey, '用户手动下线');
  recordEvent('session_kick', req.user.id, null, (last && last.device_name) || '未知设备');
  return ok(res, { message: '已将该设备下线' });
});

/**
 * 按 session_id 精确结束某一台设备的会话（多设备场景：一手机 + 一电脑，互不串号）。
 * 管理员 / 运维者可强制结束 Scope 内账号的指定会话（维护模式等场景）。
 */
router.post('/:sid/end', (req, res) => {
  const sid = String(req.params.sid || '').trim();
  if (!sid) return bad(res, '缺少会话标识');
  const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  if (!sess) return bad(res, '会话不存在', 404);

  const mine = sess.user_id === req.user.id;
  if (!mine) {
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
    if (!owner || !A.canManage(req.user, owner)) {
      return bad(res, '该会话不在你的管理范围内', 403);
    }
  }
  if (mine && req.sid === sid) {
    return bad(res, '不能结束当前正在使用的会话，请直接「登出」', 400);
  }

  const reason = String((req.body || {}).reason || (mine ? '用户手动下线' : '管理员强制结束会话'));
  S.endSession(sid, reason);
  recordEvent('session_kick', req.user.id, sess.user_id, `${sess.device_name || sid}｜${reason}`);

  // 被强制结束时邮件告知当事人（草稿已保存）
  if (!mine) {
    const notify = require('../notify');
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
    if (owner) {
      notify.notifySessionKilled(owner, { reason, device: sess.device_name || '未知设备' }).catch(() => {});
    }
  }
  return ok(res, { message: '已结束该会话' });
});

module.exports = router;

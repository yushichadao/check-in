'use strict';
/* 申诉系统（请假 / 补签）
 * ------------------------------------------------------------------
 * 两审制：
 *   初审 ADJ_INITIAL（班委 R1）→ 裁决后 locked=1，本级不可再改；
 *   普通学生对裁决结果有异议时可「提起申诉（复议）」→ appealed=1，才进入终审队列；
 *   终审 ADJ_FINAL（小班主任 R2 / 辅导员 R3）→ 覆盖初审结果。
 *   没有申诉 → 终审不做（终审列表为空）。
 *
 * 附件：申诉可附图片，服务器存 data/uploads，读取需鉴权（本人 / 可管理该普通学生的上级）。
 * 沟通：管理端与普通学生可在申诉详情里互相回复（appeal_messages），回复按在线状态走站内 / 邮件。
 */
const express = require('express');
const db = require('../db');
const A = require('../auth');
const St = require('../settings');
const upl = require('../uploads');
const notify = require('../notify');
const { recordEvent } = require('../logger');
const { checkinWindow } = require('../geo');

const router = express.Router();

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

const TYPES = {
  leave: { table: 'leave_requests', label: '请假' },
  makeup: { table: 'makeup_requests', label: '补签' }
};
const isType = (t) => !!TYPES[t];

function getReq(type, id) {
  if (!isType(type)) return null;
  return db.prepare(`SELECT * FROM ${TYPES[type].table} WHERE id = ?`).get(id);
}

function attachmentsOf(type, id) {
  return db.prepare('SELECT * FROM appeal_attachments WHERE req_type = ? AND request_id = ? ORDER BY id')
    .all(type, id);
}
function messagesOf(type, id) {
  return db.prepare(`
    SELECT m.*, u.real_name, u.role_title
    FROM appeal_messages m JOIN users u ON u.id = m.sender_id
    WHERE m.req_type = ? AND m.request_id = ? ORDER BY m.id
  `).all(type, id);
}

/** 绑定已上传但未归属的图片：只认本人上传、且未绑定的 */
function bindAttachments(type, reqId, uploaderId, ids) {
  const list = (ids || []).map(Number).filter(Boolean);
  if (!list.length) return;
  const ph = list.map(() => '?').join(',');
  // 注意占位符顺序：SET req_type=?, request_id=? 之后才是 WHERE id IN (...), uploader_id=?
  db.prepare(`
    UPDATE appeal_attachments SET req_type = ?, request_id = ?
    WHERE id IN (${ph}) AND uploader_id = ? AND request_id IS NULL
  `).run(type, reqId, ...list, uploaderId);
}

/* ===================== 普通学生端接口 ===================== */
router.use(A.authRequired);

/* ---------------- 上传申诉图片 ---------------- */
router.post('/upload', (req, res) => {
  if (!A.hasPerm(req.user, 'STU_APPEAL') && req.user.role !== 'normal') {
    return res.status(403).json({ error: '仅普通学生账号可上传申诉材料' });
  }
  const b = req.body || {};
  try {
    const saved = upl.saveImage(b.data, b.mime);
    const info = db.prepare(`
      INSERT INTO appeal_attachments (req_type, request_id, uploader_id, file, mime, size, created_at)
      VALUES (NULL, NULL, ?, ?, ?, ?, ?)
    `).run(req.user.id, saved.file, saved.mime, saved.size, Date.now());
    return ok(res, { id: Number(info.lastInsertRowid), size: saved.size, mime: saved.mime });
  } catch (e) {
    return bad(res, e.message, e.status || 400);
  }
});

/* ---------------- 提交请假申诉 ---------------- */
router.post('/leave', A.requireRole('normal'), (req, res) => {
  if (!A.hasPerm(req.user, 'STU_APPEAL')) {
    return res.status(403).json({ error: '无申诉权限' });
  }
  const b = req.body || {};
  const activityId = Number(b.activity_id);
  const reason = String(b.reason || '').trim();
  // 申诉不再采集地点（申诉无需上传定位）：location 一律不写入，仅保留历史列兼容旧数据。
  if (!activityId) return bad(res, '请选择活动');
  if (!reason) return bad(res, '请填写请假理由');

  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
  if (!act) return bad(res, '活动不存在', 404);
  const now = Date.now();
  const win = checkinWindow(act);
  if (now < win.open || now > win.close) {
    return bad(res, '当前不在该活动的可请假时间窗口内', 403);
  }

  db.prepare('DELETE FROM leave_requests WHERE activity_id = ? AND user_id = ?').run(activityId, req.user.id);
  const info = db.prepare(`
    INSERT INTO leave_requests (activity_id, user_id, reason, by_admin, is_appeal, status, created_at)
    VALUES (?, ?, ?, 0, 1, 'pending', ?)
  `).run(activityId, req.user.id, reason, now);
  const rid = Number(info.lastInsertRowid);
  bindAttachments('leave', rid, req.user.id, b.attachment_ids);

  // 注意：事后请假属于「申诉」，提交时不再预置 checkins.status='leave'（避免“提交即请假”）。
  // 未回应 / 驳回 一律按缺勤展示，唯有管理员批准后（leave_approve）才落「请假」记录。

  recordEvent('leave_request', req.user.id, activityId, null);
  notifyAppealAdmins(req.user, 'leave', rid, act);
  return ok(res, { message: '请假申诉已提交，等待审核', id: rid });
});

/* ---------------- 提交补签申诉 ---------------- */
router.post('/makeup', A.requireRole('normal'), (req, res) => {
  if (!A.hasPerm(req.user, 'STU_APPEAL')) {
    return res.status(403).json({ error: '无申诉权限' });
  }
  if (!St.getBool('allow_makeup')) return bad(res, '当前未开放补签申请，请联系管理员', 403);

  const b = req.body || {};
  const activityId = Number(b.activity_id);
  const reason = String(b.reason || '').trim();
  // 申诉不再采集地点（申诉无需上传定位）
  if (!activityId) return bad(res, '请选择活动');
  if (!reason) return bad(res, '请填写补签理由');

  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
  if (!act) return bad(res, '活动不存在', 404);
  const now = Date.now();
  if (now <= act.end_time) return bad(res, '活动尚未结束，请在活动结束后提交补签');

  const mine = db.prepare('SELECT * FROM checkins WHERE activity_id = ? AND user_id = ?').get(activityId, req.user.id);
  if (mine && (mine.status === 'signed' || mine.status === 'leave')) {
    return bad(res, '你已有有效记录，无需补签');
  }

  db.prepare(`
    INSERT INTO makeup_requests (activity_id, user_id, reason, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
    ON CONFLICT(activity_id, user_id) DO UPDATE SET
      reason = excluded.reason, status = 'pending',
      reply = NULL, handler_id = NULL, handled_at = NULL,
      locked = 0, appealed = 0, appeal_reason = NULL, appealed_at = NULL,
      final_status = NULL, final_handler_id = NULL, final_reply = NULL, final_at = NULL,
      created_at = excluded.created_at
  `).run(activityId, req.user.id, reason, now);
  const row = db.prepare('SELECT id FROM makeup_requests WHERE activity_id = ? AND user_id = ?')
    .get(activityId, req.user.id);
  const rid = row ? row.id : 0;
  bindAttachments('makeup', rid, req.user.id, b.attachment_ids);

  recordEvent('makeup_request', req.user.id, activityId, null);
  notifyAppealAdmins(req.user, 'makeup', rid, act);
  return ok(res, { message: '补签申诉已提交，等待审核', id: rid });
});

/** 新申诉 → 通知其管理范围内有「初步裁决」权限的上级（在线站内 / 离线邮件） */
function notifyAppealAdmins(student, type, reqId, act) {
  const label = TYPES[type].label;
  const admins = db.prepare(`
    SELECT * FROM users WHERE disabled = 0 AND role = 'manager'
  `).all().filter(u => {
    if (!A.hasPerm(u, 'ADJ_INITIAL')) return false;
    if (A.isWildcard(u)) return true;
    return A.inScope(u.id, student.id) && A.canManage(u, student);
  });
  admins.forEach(u => {
    notify.notifyAppealSubmitted(u, {
      title: `新的${label}申诉待审核`,
      body: `${student.real_name} 提交了${label}申诉${act ? '：' + act.title : ''}`,
      applicant: student, activity: act, label, id: reqId
    }).catch(() => {});
  });
}

/* ---------------- 我的申诉（请假 + 补签合并） ---------------- */
router.get('/my', (req, res) => {
  const uid = req.user.id;
  const lr = db.prepare(`
    SELECT lr.*, a.title, a.start_time, a.end_time, a.location AS act_location
    FROM leave_requests lr JOIN activities a ON a.id = lr.activity_id
    WHERE lr.user_id = ? ORDER BY lr.created_at DESC LIMIT 100
  `).all(uid).map(r => Object.assign({ _type: 'leave' }, r));
  const mk = db.prepare(`
    SELECT m.*, a.title, a.start_time, a.end_time, a.location AS act_location
    FROM makeup_requests m JOIN activities a ON a.id = m.activity_id
    WHERE m.user_id = ? ORDER BY m.created_at DESC LIMIT 100
  `).all(uid).map(r => Object.assign({ _type: 'makeup' }, r));

  const rows = lr.concat(mk)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .map(r => Object.assign({}, r, { attachments: attachmentsOf(r._type, r.id).length }));
  return ok(res, { requests: rows });
});

/* ---------------- 申诉详情（普通学生本人 / 可管理的上级） ---------------- */
router.get('/:type/:id', (req, res) => {
  const type = req.params.type;
  const id = Number(req.params.id);
  const r = getReq(type, id);
  if (!r) return bad(res, '申诉不存在', 404);

  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id);
  const mine = owner && owner.id === req.user.id;
  const canManage = owner && (A.isWildcard(req.user) || A.canManage(req.user, owner));
  if (!mine && !canManage) return bad(res, '无权查看该申诉', 403);

  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(r.activity_id);
  const handler = r.handler_id ? db.prepare('SELECT id, real_name, role_title FROM users WHERE id = ?').get(r.handler_id) : null;
  const finalHandler = r.final_handler_id
    ? db.prepare('SELECT id, real_name, role_title FROM users WHERE id = ?').get(r.final_handler_id) : null;

  return ok(res, {
    request: Object.assign({}, r, { _type: type }),
    activity: act,
    owner: owner ? { id: owner.id, real_name: owner.real_name, student_id: owner.student_id } : null,
    handler, final_handler: finalHandler,
    attachments: attachmentsOf(type, id).map(a => ({ id: a.id, mime: a.mime, size: a.size, created_at: a.created_at })),
    messages: messagesOf(type, id),
    mine, can_manage: !!canManage,
    // 当前用户能做什么：初审 / 终审 / 回复 / 提起申诉
    can: {
      initial: !!canManage && r.status === 'pending' && A.hasPerm(req.user, 'ADJ_INITIAL'),
      final: !!canManage && r.appealed === 1 && !r.final_status && A.hasPerm(req.user, 'ADJ_FINAL'),
      reply: !!canManage || mine,
      appeal: mine && r.status !== 'pending' && r.appealed === 0 && !r.final_status
    }
  });
});

/* ---------------- 申诉内沟通（普通学生与管理员互相回复） ---------------- */
router.post('/:type/:id/message', (req, res) => {
  const type = req.params.type;
  const id = Number(req.params.id);
  const r = getReq(type, id);
  if (!r) return bad(res, '申诉不存在', 404);

  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id);
  const mine = owner && owner.id === req.user.id;
  const canManage = owner && (A.isWildcard(req.user) || A.canManage(req.user, owner));
  if (!mine && !canManage) return bad(res, '无权参与该申诉', 403);

  const body = String((req.body || {}).body || '').trim().slice(0, 1000);
  if (!body) return bad(res, '请填写内容');

  db.prepare(`
    INSERT INTO appeal_messages (req_type, request_id, sender_id, sender_kind, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(type, id, req.user.id, req.user.role, body, Date.now());

  // 回复给对方：必达消息（在线站内 toast / 离线邮件）
  const to = mine
    ? (r.handler_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(r.handler_id) : null)
    : owner;
  if (to) {
    notify.notifyAppealReply(to, {
      title: `你的${TYPES[type].label}申诉有新回复`,
      label: TYPES[type].label,
      replier: req.user, body, id
    }).catch(() => {});
  }
  return ok(res, { message: '已发送', messages: messagesOf(type, id) });
});

/* ---------------- 普通学生对裁决结果提起申诉（复议）→ 才进入终审 ---------------- */
router.post('/:type/:id/appeal', A.requireRole('normal'), (req, res) => {
  const type = req.params.type;
  const id = Number(req.params.id);
  const r = getReq(type, id);
  if (!r) return bad(res, '申诉不存在', 404);
  if (r.user_id !== req.user.id) return bad(res, '只能对自己的申诉提起复议', 403);
  if (r.status === 'pending') return bad(res, '该申诉尚未裁决，无需复议');
  if (r.appealed === 1) return bad(res, '你已提起过申诉，请等待终审');
  if (r.final_status) return bad(res, '该申诉已终审，结果不可再变更');

  const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
  if (!reason) return bad(res, '请填写申诉理由');

  db.prepare(`UPDATE ${TYPES[type].table} SET appealed = 1, appeal_reason = ?, appealed_at = ? WHERE id = ?`)
    .run(reason, Date.now(), id);
  recordEvent('appeal_retry', req.user.id, r.activity_id, `${(type === 'leave' ? '请假' : '补签')}#${id}`);

  // 通知有终审权限的上级（运维者不参与复核，故仅 manager）
  const finals = db.prepare(`
    SELECT * FROM users WHERE disabled = 0 AND role = 'manager'
  `).all().filter(u => {
    if (!A.hasPerm(u, 'ADJ_FINAL')) return false;
    if (A.isWildcard(u)) return true;
    return A.inScope(u.id, req.user.id) && A.canManage(u, req.user);
  });
  finals.forEach(u => {
    notify.notifyAppealSubmitted(u, {
      title: `普通学生提出申诉，需终审（${TYPES[type].label}）`,
      body: `${req.user.real_name}：${reason.slice(0, 80)}`,
      intro: '普通学生对初审结果提出了申诉，请在管理端「终审」中处理。',
      applicant: req.user, label: TYPES[type].label,
      firstResult: r.status === 'approved' ? '已通过' : '已驳回',
      reason, id, footer: '终审为最终结果。'
    }).catch(() => {});
  });
  return ok(res, { message: '已提起申诉，等待终审' });
});

/* ---------------- 附件读取（鉴权，不对外静态暴露） ---------------- */
router.get('/attachment/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM appeal_attachments WHERE id = ?').get(Number(req.params.id));
  if (!a) return bad(res, '附件不存在', 404);

  const uploader = db.prepare('SELECT * FROM users WHERE id = ?').get(a.uploader_id);
  const mine = uploader && uploader.id === req.user.id;
  const canManage = uploader && (A.isWildcard(req.user) || A.canManage(req.user, uploader));
  if (!mine && !canManage) return bad(res, '无权查看该附件', 403);

  const buf = upl.readFile(a.file);
  if (!buf) return bad(res, '附件文件已丢失', 404);
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.send(buf);
});

module.exports = router;
module.exports.getReq = getReq;
module.exports.TYPES = TYPES;
module.exports.attachmentsOf = attachmentsOf;
module.exports.messagesOf = messagesOf;

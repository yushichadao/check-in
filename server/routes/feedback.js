'use strict';
const express = require('express');
const db = require('../db');
const A = require('../auth');
const cfg = require('../config');
const notify = require('../notify');
const datalog = require('../datalog');
const upl = require('../uploads');
const mailer = require('../mailer');

const router = express.Router();
router.use(A.authRequired);

const ok = (res, data) => res.json(Object.assign({ ok: true }, data || {}));
const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

/** 反馈类型「中文名」映射（英文 key 仍落库，便于筛选） */
const TYPE_NAME = { bug: '功能异常', suggest: '功能建议', other: '其他' };

/** 解析收件邮箱：环境变量优先，其次运维者账号登记的邮箱 */
function resolveFeedbackEmail() {
  if (cfg.FEEDBACK_EMAIL) return cfg.FEEDBACK_EMAIL;
  const dev = db.prepare("SELECT email FROM users WHERE role = 'ops' AND disabled = 0 LIMIT 1").get();
  return dev && dev.email ? dev.email : '';
}

/* ---------------- 提交反馈（工单 + 邮件两种渠道） ---------------- */
router.post('/', async (req, res) => {
  // 反馈是「下级 → 运维者」的受理通道：运维者是最终受理方，不产生「自己提交给自己」的工单。
  // 服务端强制拦截（与运维端不提供提交入口一致），避免绕过前端直接提交。
  if (req.user.role === 'ops') {
    return bad(res, '运维者是反馈工单的受理方，无需提交反馈；请在「关于系统 → 反馈工单」中查看与处理下级提交的反馈', 403);
  }

  const b = req.body || {};
  const type = TYPE_NAME[b.type] ? b.type : 'other';
  const subject = String(b.subject || '').trim().slice(0, 80);
  const content = String(b.content || '').trim().slice(0, 1000);
  const contact = String(b.contact || '').trim().slice(0, 120);
  const asTicket = b.as_ticket !== false;          // 默认记录为工单
  const asEmail = !!b.as_email;

  if (!subject) return bad(res, '请填写反馈标题');
  if (!content) return bad(res, '请填写反馈内容');
  if (!asTicket && !asEmail) return bad(res, '请至少选择一种反馈方式（工单 / 邮件）');

  const feedbackEmail = resolveFeedbackEmail();
  const emailAvailable = mailer.isConfigured() && !!feedbackEmail;
  if (asEmail && !emailAvailable) {
    return bad(res, '邮件功能未配置，无法发送邮件，请改用工单方式', 400);
  }

  const u = req.user;
  const info = db.prepare(`
    INSERT INTO feedbacks
      (reporter_id, reporter_name, reporter_role, type, subject, content, contact, channel_ticket, channel_email, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(u.id, u.real_name, u.role_title, type, subject, content, contact || null,
        asTicket ? 1 : 0, asEmail ? 1 : 0, Date.now());

  const id = Number(info.lastInsertRowid);

  // 绑定图片附件（仅本人上传、且尚未绑定者，最多 9 张）
  const attachmentIds = Array.isArray(b.attachment_ids) ? b.attachment_ids.map(Number).filter(Boolean).slice(0, 9) : [];
  if (attachmentIds.length) {
    const ph = attachmentIds.map(() => '?').join(',');
    db.prepare(`UPDATE appeal_attachments SET req_type = 'feedback', request_id = ? WHERE id IN (${ph}) AND uploader_id = ? AND (req_type IS NULL OR req_type = 'feedback') AND request_id IS NULL`)
      .run(id, ...attachmentIds, req.user.id);
  }

  const channelText = (asTicket ? '工单' : '') + (asTicket && asEmail ? '+' : '') + (asEmail ? '邮件' : '');
  datalog.record({
    category: 'feedback',
    action: 'feedback_submit',
    actor: u,
    subject_id: u.id,
    target: asEmail && feedbackEmail ? feedbackEmail : `${u.real_name}（${u.role_title}）`,
    detail: `类型=${TYPE_NAME[type]}；标题=${subject}；渠道=${channelText}`,
    channel: asEmail ? (asTicket ? 'both' : 'email') : 'inbox'
  });

  let emailed = false;
  if (asEmail) {
    try {
      await notify.notifyFeedback(feedbackEmail, {
        id, type, subject, content, contact,
        reporter_name: u.real_name, reporter_role: u.role_title
      }, u);
      emailed = true;
    } catch (e) { /* 邮件失败不阻断工单提交 */ }
  }

  let message;
  if (asTicket && asEmail) message = emailed ? '工单已提交，并已发送邮件给运维者' : '工单已提交（邮件发送失败，已记录工单）';
  else if (asTicket) message = '工单已提交，运维者将尽快处理';
  else message = emailed ? '邮件已发送给运维者' : '提交成功';

  return ok(res, { message, id, ticket: asTicket, emailed });
});

/* ---------------- 上传反馈图片（任何已登录用户均可；存入通用附件表，归属稍后在提交时绑定） ---------------- */
router.post('/upload', (req, res) => {
  const b = req.body || {};
  try {
    const saved = upl.saveImage(b.data, b.mime);
    const info = db.prepare(`
      INSERT INTO appeal_attachments (req_type, request_id, uploader_id, file, mime, size, created_at)
      VALUES ('feedback', NULL, ?, ?, ?, ?, ?)
    `).run(req.user.id, saved.file, saved.mime, saved.size, Date.now());
    return ok(res, { id: Number(info.lastInsertRowid), size: saved.size, mime: saved.mime });
  } catch (e) {
    return bad(res, e.message, e.status || 400);
  }
});

/* ---------------- 反馈列表：运维者看全部，其余只看自己提交的 ---------------- */
router.get('/', (req, res) => {
  const isOps = req.user.role === 'ops';
  const rows = (isOps
    ? db.prepare('SELECT * FROM feedbacks ORDER BY created_at DESC LIMIT 500').all()
    : db.prepare('SELECT * FROM feedbacks WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 200').all(req.user.id))
    .map(f => Object.assign({}, f, {
      attachments: db.prepare("SELECT id, mime FROM appeal_attachments WHERE req_type='feedback' AND request_id=? ORDER BY id")
        .all(f.id)
    }));
  return ok(res, { is_ops: isOps, feedbacks: rows });
});

/* ---------------- 反馈图片读取（仅本人或运维者可见，不对外静态暴露） ---------------- */
router.get('/:id/attachment/:aid', (req, res) => {
  const f = db.prepare('SELECT * FROM feedbacks WHERE id = ?').get(Number(req.params.id));
  if (!f) return bad(res, '反馈不存在', 404);
  const a = db.prepare('SELECT * FROM appeal_attachments WHERE id = ?').get(Number(req.params.aid));
  if (!a || a.req_type !== 'feedback' || Number(a.request_id) !== Number(f.id)) return bad(res, '附件不存在', 404);
  const uploader = db.prepare('SELECT * FROM users WHERE id = ?').get(a.uploader_id);
  const mine = uploader && uploader.id === req.user.id;
  const isOps = req.user.role === 'ops';
  if (!mine && !isOps) return bad(res, '无权查看该附件', 403);
  const buf = upl.readFile(a.file);
  if (!buf) return bad(res, '附件文件已丢失', 404);
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.send(buf);
});

/* ---------------- 运维者处理 / 回复 ---------------- */
router.post('/:id/handle', A.requireRole('ops'), (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const f = db.prepare('SELECT * FROM feedbacks WHERE id = ?').get(id);
  if (!f) return bad(res, '反馈不存在', 404);

  const status = b.status === 'pending' ? 'pending' : (b.status === 'closed' ? 'closed' : 'handled');
  const reply = String(b.reply || '').trim().slice(0, 500);
  db.prepare(`
    UPDATE feedbacks SET status = ?, reply = ?, handled_by = ?, handled_at = ? WHERE id = ?
  `).run(status, reply || null, req.user.id, Date.now(), id);

  datalog.record({
    category: 'feedback', action: 'feedback_handle', actor: req.user,
    subject_id: f.reporter_id, target: f.reporter_name || '', detail: `反馈#${id} → ${status}`
  });
  return ok(res, { message: '已更新反馈状态' });
});

module.exports = router;
